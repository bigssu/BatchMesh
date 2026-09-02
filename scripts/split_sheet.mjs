// 캐릭터 시트 1장 → Gemini 비전으로 뷰 감지 → 픽셀 성분으로 박스 정밀화 → sharp 크롭 → 조각 제거.
// GOOGLE_API_KEY(User 환경변수) 사용. 키는 x-goog-api-key 헤더로만 전송.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const GEMINI_MODEL = 'gemini-2.5-flash';
const LABELS = ['front', 'left', 'back', 'right', 'face'];
const FG_THRESH = 60 * 60; // 배경색과의 RGB 거리 제곱

const PROMPT = (hint) => `This image is a character reference sheet (turnaround) of ONE character.
Detect each depiction of the character and classify it with exactly one label:
- "front": full-body front view
- "right": full-body side view where the character's face/body points toward the viewer's LEFT edge
- "back": full-body back view
- "left": full-body side view where the character's face/body points toward the viewer's RIGHT edge
- "face": face/head close-up or facial detail cut
- "other": ANY remaining depiction of the character (alternate pose, extra angle, detail cut, partial render). Label every one of them; "other" may appear multiple times.

Rules:
- Labels front/left/back/right/face at most once each. Only include labels actually present.
- If the sheet has two side views facing the SAME direction (duplicates), label only the clearer ONE with its correct side and label the rest "other". Never swap the two side labels.
- Every visible depiction of the character must get a box (use "other" for extras). Missing boxes cause cropping artifacts.
- Boxes must contain the ENTIRE depiction including snouts, jaws, claws, pincers, tails, wings and any protruding parts. When unsure, make the box larger.
- Ignore text, color swatches, small item/prop callouts.
- If the sheet shows multiple DIFFERENT characters, return exactly: {"error":"multiple_characters"}
${hint ? `- User hint: ${hint}` : ''}
Return strict JSON array: [{"label":"front","box_2d":[ymin,xmin,ymax,xmax]}] with coordinates normalized to 0-1000.`;

// --- 픽셀 유틸 ---

function foregroundMask(raw, bg) {
  const n = raw.length / 3;
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const dr = raw[i * 3] - bg.r, dg = raw[i * 3 + 1] - bg.g, db = raw[i * 3 + 2] - bg.b;
    if (dr * dr + dg * dg + db * db > FG_THRESH) fg[i] = 1;
  }
  return fg;
}

// 4-이웃 연결 성분 라벨링 (명시적 스택 BFS)
function labelComponents(fg, sw, sh) {
  const n = sw * sh;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < n; s++) {
    if (!fg[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(s); comp[s] = id;
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % sw;
      if (x > 0 && fg[p - 1] && comp[p - 1] < 0) { comp[p - 1] = id; stack.push(p - 1); }
      if (x < sw - 1 && fg[p + 1] && comp[p + 1] < 0) { comp[p + 1] = id; stack.push(p + 1); }
      if (p >= sw && fg[p - sw] && comp[p - sw] < 0) { comp[p - sw] = id; stack.push(p - sw); }
      if (p < n - sw && fg[p + sw] && comp[p + sw] < 0) { comp[p + sw] = id; stack.push(p + sw); }
    }
    sizes.push(size);
  }
  return { comp, sizes };
}

// 축소 래스터 전처리: 리사이즈 → 전경 마스크 → 연결 성분 (refineRects/cleanCrop 공용)
async function maskComponents(input, small, bg) {
  const meta = await sharp(input).metadata();
  const scale = Math.min(1, small / meta.width);
  const sw = Math.max(1, Math.round(meta.width * scale));
  const sh = Math.max(1, Math.round(meta.height * scale));
  const raw = await sharp(input).resize(sw, sh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const fg = foregroundMask(raw, bg);
  return { ...labelComponents(fg, sw, sh), fg, sw, sh, scale, meta };
}

// Gemini 박스를 실제 픽셀 성분 bbox로 정밀화: 박스에 대부분 들어있는 성분들의
// union bbox를 크롭 경계로 사용 → 박스 밖으로 삐져나온 집게/입/꼬리도 포함.
async function refineRects(buf, meta, dets, bg) {
  const { comp, sizes, fg, sw, sh, scale } = await maskComponents(buf, 800, bg);
  const k = sizes.length;
  if (!k) return;

  const boxes = Array.from({ length: k }, () => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const c = comp[y * sw + x];
    if (c < 0) continue;
    const b = boxes[c];
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }

  // 픽셀로 인물 덩어리를 먼저 찾는다: bbox가 겹치는 성분끼리 묶으면 한 인물이 된다.
  // (Gemini 좌표는 시트에 따라 통째로 어긋나기도 해서 기하는 픽셀로, 라벨만 Gemini로 쓴다.)
  const clusters = [];
  for (let c = 0; c < k; c++) {
    if (sizes[c] < sw * sh * 0.0005) continue;
    const b = { ...boxes[c], area: sizes[c] };
    const hit = clusters.filter((u) => !(b.x1 < u.x0 || b.x0 > u.x1 || b.y1 < u.y0 || b.y0 > u.y1));
    for (const u of hit) {
      b.x0 = Math.min(b.x0, u.x0); b.y0 = Math.min(b.y0, u.y0);
      b.x1 = Math.max(b.x1, u.x1); b.y1 = Math.max(b.y1, u.y1);
      b.area += u.area;
      clusters.splice(clusters.indexOf(u), 1);
    }
    clusters.push(b);
  }
  // 인물이 서로 닿아 한 덩어리로 묶였으면(배경 간격 없음) 세로 밀도가 가장 낮은
  // 지점에서 쪼갠다. 라벨 수만큼 덩어리가 생길 때까지 넓은 것부터 반복.
  const tight = (x0, x1, y0, y1) => {
    let a = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, area: 0 };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!fg[y * sw + x]) continue;
      a.area++;
      if (x < a.x0) a.x0 = x; if (x > a.x1) a.x1 = x;
      if (y < a.y0) a.y0 = y; if (y > a.y1) a.y1 = y;
    }
    return a.area > 0 ? a : null;
  };
  while (clusters.length < dets.length) {
    const c = clusters.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
    const w = c.x1 - c.x0 + 1;
    if (w < 20) break;
    const prof = [];
    for (let x = c.x0; x <= c.x1; x++) {
      let n = 0;
      for (let y = c.y0; y <= c.y1; y++) if (fg[y * sw + x]) n++;
      prof.push(n);
    }
    const mean = prof.reduce((a, b) => a + b, 0) / w;
    let cut = -1, low = Infinity;
    for (let i = Math.floor(w * 0.2); i < Math.ceil(w * 0.8); i++) if (prof[i] < low) { low = prof[i]; cut = i; }
    if (cut < 0 || low > mean * 0.35) break; // 뚜렷한 경계 없음 → 더 못 쪼갬
    const parts = [tight(c.x0, c.x0 + cut - 1, c.y0, c.y1), tight(c.x0 + cut + 1, c.x1, c.y0, c.y1)].filter(Boolean);
    if (parts.length !== 2) break;
    clusters.splice(clusters.indexOf(c), 1, ...parts);
    if (process.env.SPLIT_DEBUG) console.error(`[dbg] 붙은 인물 분리: x=${Math.round((c.x0 + cut) / scale)} (밀도 ${low}/${Math.round(mean)})`);
  }

  const toRect = (u) => {
    const pad = 0.03;
    const uw = (u.x1 - u.x0 + 1) / scale, uh = (u.y1 - u.y0 + 1) / scale;
    const left = Math.max(0, Math.round(u.x0 / scale - uw * pad));
    const top = Math.max(0, Math.round(u.y0 / scale - uh * pad));
    return {
      left, top,
      width: Math.min(meta.width - left, Math.round(uw * (1 + 2 * pad))),
      height: Math.min(meta.height - top, Math.round(uh * (1 + 2 * pad))),
    };
  };

  // 감지된 그림 수만큼 큰 덩어리를 골라 좌→우 순서로 라벨과 짝짓는다.
  // (스케일 참고표 같은 작은 덩어리는 자동으로 탈락)
  if (clusters.length >= dets.length) {
    const picked = clusters.slice().sort((a, b) => b.area - a.area).slice(0, dets.length)
      .sort((a, b) => (a.x0 + a.x1) - (b.x0 + b.x1));
    const byX = dets.slice().sort((a, b) => (a.rect.left + a.rect.width / 2) - (b.rect.left + b.rect.width / 2));
    byX.forEach((d, i) => { d.rect = toRect(picked[i]); });
    if (process.env.SPLIT_DEBUG) console.error(`[dbg] 클러스터 매칭: ${clusters.length}개 중 ${dets.length}개 사용`);
    return;
  }

  // 덩어리가 라벨보다 적으면(겹쳐 그린 시트 등) 박스별 최대 겹침 성분으로 보정
  for (const d of dets) {
    if (d.label === 'other') continue;
    const rx0 = Math.max(0, Math.floor(d.rect.left * scale));
    const ry0 = Math.max(0, Math.floor(d.rect.top * scale));
    const rx1 = Math.min(sw, Math.ceil((d.rect.left + d.rect.width) * scale));
    const ry1 = Math.min(sh, Math.ceil((d.rect.top + d.rect.height) * scale));
    const inside = new Float64Array(k);
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) {
      const c = comp[y * sw + x];
      if (c >= 0) inside[c]++;
    }
    // 박스와 가장 많이 겹치는 성분 = 이 뷰의 본체. (박스가 인물과 어긋나 있어도
    // 본체를 고르므로, "박스에 N% 들어있나"로 거르던 방식과 달리 반쪽 크롭이 안 나온다.)
    let primary = -1;
    for (let c = 0; c < k; c++) {
      if (sizes[c] < sw * sh * 0.0005) continue; // 노이즈 성분 제외
      if (primary < 0 || inside[c] > inside[primary]) primary = c;
    }
    if (primary < 0 || inside[primary] === 0) continue; // 매칭 실패 → Gemini 박스 유지
    // 본체 bbox와 겹치는 성분(끊긴 몸통 조각·모자·머리카락)까지 합친다.
    let u = { ...boxes[primary] };
    for (let c = 0; c < k; c++) {
      if (c === primary || sizes[c] < sw * sh * 0.0005) continue;
      const b = boxes[c];
      if (b.x1 < u.x0 || b.x0 > u.x1 || b.y1 < u.y0 || b.y0 > u.y1) continue; // 겹치지 않음 = 이웃 인물
      u = { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) };
    }
    const pad = 0.03;
    const uw = (u.x1 - u.x0 + 1) / scale, uh = (u.y1 - u.y0 + 1) / scale;
    const left = Math.max(0, Math.round(u.x0 / scale - uw * pad));
    const top = Math.max(0, Math.round(u.y0 / scale - uh * pad));
    const width = Math.min(meta.width - left, Math.round(uw * (1 + 2 * pad)));
    const height = Math.min(meta.height - top, Math.round(uh * (1 + 2 * pad)));
    // 폭주 가드: 이웃까지 삼킬 만큼 커지면 원래 박스 유지
    if (width > d.rect.width * 2.5 || height > d.rect.height * 2.5) continue;
    d.rect = { left, top, width, height };
  }
}

// Meshy 입력 이미지 비율 제한: 2:5 ~ 5:2. 벗어나면 배경색 여백을 좌우/상하에 채워 맞춘다.
const MIN_RATIO = 0.4, MAX_RATIO = 2.5;
export async function padToRatio(file, bg) {
  const m = await sharp(file).metadata();
  const r = m.width / m.height;
  if (r >= MIN_RATIO && r <= MAX_RATIO) return null;
  let x = 0, y = 0;
  if (r < MIN_RATIO) x = Math.ceil((m.height * (MIN_RATIO + 0.02) - m.width) / 2); // 세로로 김 → 좌우 여백
  else y = Math.ceil((m.width / (MAX_RATIO - 0.1) - m.height) / 2);                 // 가로로 김 → 상하 여백
  const out = await sharp(file)
    .extend({ top: y, bottom: y, left: x, right: x, background: { ...bg, alpha: 1 } })
    .png().toBuffer();
  fs.writeFileSync(file, out);
  const after = await sharp(out).metadata();
  return { width: after.width, height: after.height };
}

// 크롭 정리: 배경과 분리된 성분 중 가장 큰 것(본체)만 남기고 나머지(이웃 그림 조각,
// 텍스트, 그림자)를 배경색으로 지운다.
export async function cleanCrop(file, bg) {
  const { comp, sizes, sw, sh, meta } = await maskComponents(file, 320, bg);
  const { width, height } = meta;
  const n = sw * sh;
  if (sizes.length <= 1) return;
  const largest = Math.max(...sizes);
  if (largest < n * 0.03) return; // 본체 판별 실패 시 건드리지 않음
  const keep = sizes.indexOf(largest);

  // 성분별 bbox — 캐릭터는 창백한 피부/옷 때문에 여러 성분으로 끊길 수 있으므로
  // "가장 큰 것만 남기기"는 위험하다. 본체 bbox와 겹치는 성분은 캐릭터의 일부
  // (몸통 조각, 코·입 같은 내부 디테일)로 보고 남기고, 겹치지 않는 것만 지운다.
  const bb = Array.from({ length: sizes.length }, () => ({ x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const c = comp[y * sw + x];
    if (c < 0) continue;
    const b = bb[c];
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  const main = bb[keep];
  const outside = (b) => b.x1 < main.x0 || b.x0 > main.x1 || b.y1 < main.y0 || b.y0 > main.y1;
  if (process.env.SPLIT_DEBUG) {
    const drop = sizes.map((s, i) => [i, s]).filter(([i]) => i !== keep && outside(bb[i]));
    console.error(`[dbg] cleanCrop ${path.basename(file)}: 성분 ${sizes.length}개, 본체=${largest}px, 삭제=${drop.length}개(${drop.reduce((a, [, s]) => a + s, 0)}px)`);
  }

  // 지울 영역 + 1px 팽창(안티앨리어싱 헤일로 제거)
  const erase = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== keep && outside(bb[comp[i]])) erase[i] = 1;
  const dil = new Uint8Array(n);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x;
    dil[i] = erase[i] ||
      (x > 0 && erase[i - 1]) || (x < sw - 1 && erase[i + 1]) ||
      (y > 0 && erase[i - sw]) || (y < sh - 1 && erase[i + sw]) ? 1 : 0;
  }

  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = bg.r; rgba[i * 4 + 1] = bg.g; rgba[i * 4 + 2] = bg.b;
    rgba[i * 4 + 3] = dil[i] ? 255 : 0;
  }
  const overlay = await sharp(rgba, { raw: { width: sw, height: sh, channels: 4 } })
    .resize(width, height, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  const out = await sharp(file).composite([{ input: overlay }]).png().toBuffer();
  fs.writeFileSync(file, out);
}

export async function splitSheet(sheetPath, outDir, hint = '') {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY 환경변수가 없습니다.');
  const buf = fs.readFileSync(sheetPath);
  const meta = await sharp(buf).metadata();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/png', data: buf.toString('base64') } },
            { text: PROMPT(hint) },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 응답에 내용 없음');
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(`분해 불가: ${parsed.error}`);
  if (!Array.isArray(parsed)) throw new Error('Gemini 응답 형식 오류');

  fs.mkdirSync(outDir, { recursive: true });
  for (const l of LABELS) {
    const f = path.join(outDir, `${l}.png`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // Gemini 박스 → 픽셀 rect
  const dets = [];
  for (const det of parsed) {
    const isView = LABELS.includes(det.label);
    if (!isView && det.label !== 'other') continue;
    if (isView && dets.some((d) => d.label === det.label)) continue;
    const [ymin, xmin, ymax, xmax] = det.box_2d.map((v) => Math.max(0, Math.min(1000, v)) / 1000);
    const left = Math.round(xmin * meta.width);
    const top = Math.round(ymin * meta.height);
    const width = Math.min(meta.width - left, Math.round((xmax - xmin) * meta.width));
    const height = Math.min(meta.height - top, Math.round((ymax - ymin) * meta.height));
    if (width < 8 || height < 8) continue;
    dets.push({ label: det.label, rect: { left, top, width, height } });
  }

  const { dominant: bg } = await sharp(buf).stats();
  if (process.env.SPLIT_DEBUG) console.error('[dbg] bg=', bg, 'before:', dets.map((d) => `${d.label} x=${d.rect.left}..${d.rect.left + d.rect.width}`).join(' | '));
  await refineRects(buf, meta, dets, bg); // 뷰 박스를 픽셀 성분 bbox로 확장/보정
  if (process.env.SPLIT_DEBUG) console.error('[dbg] after: ', dets.map((d) => `${d.label} x=${d.rect.left}..${d.rect.left + d.rect.width}`).join(' | '));

  const views = [];
  // 뷰별 크롭은 독립적이라 병렬 처리 (libvips는 워커 스레드에서 돎)
  await Promise.all(dets.filter((d) => d.label !== 'other').map(async (d) => {
    const R = d.rect;
    // 크롭 가장자리에 걸친 이웃 뷰 박스를 배경색으로 마스킹
    const overlays = [];
    for (const o of dets) {
      if (o === d) continue;
      const L = Math.max(R.left, o.rect.left);
      const T = Math.max(R.top, o.rect.top);
      const Rt = Math.min(R.left + R.width, o.rect.left + o.rect.width);
      const B = Math.min(R.top + R.height, o.rect.top + o.rect.height);
      const iw = Rt - L, ih = B - T;
      if (iw <= 0 || ih <= 0) continue;
      // 포함 관계(예: face 박스가 front 안)는 마스킹하면 본체가 지워지므로 제외
      const minArea = Math.min(R.width * R.height, o.rect.width * o.rect.height);
      if ((iw * ih) / minArea > 0.5) continue;
      overlays.push({
        input: { create: { width: iw, height: ih, channels: 3, background: bg } },
        left: L - R.left,
        top: T - R.top,
      });
    }
    const file = path.join(outDir, `${d.label}.png`);
    await sharp(buf).extract(R).composite(overlays).png().toFile(file);
    await cleanCrop(file, bg); // 남은 이웃 그림 조각 제거
    await padToRatio(file, bg); // Meshy 비율 제한(2:5~5:2) 맞추기
    views.push(d.label);
  }));

  // 단일 이미지 업로드: 감지된 전신 뷰가 1장뿐이면 방향 라벨은 의미가 없다.
  // primary(front)로 통일해 싱글 이미지 모드임을 명확히 한다.
  const geo = views.filter((v) => v !== 'face');
  if (geo.length === 1 && geo[0] !== 'front') {
    fs.renameSync(path.join(outDir, `${geo[0]}.png`), path.join(outDir, 'front.png'));
    views[views.indexOf(geo[0])] = 'front';
    return views;
  }

  // left/right가 사실상 같은 이미지면(같은 그림을 두 라벨로 오인) left를 버림
  if (views.includes('left') && views.includes('right')) {
    const S = 48;
    const [ra, rb] = await Promise.all(['left', 'right'].map((v) =>
      sharp(path.join(outDir, `${v}.png`)).resize(S, S, { fit: 'fill' }).removeAlpha().raw().toBuffer()));
    let diff = 0;
    for (let i = 0; i < ra.length; i++) diff += Math.abs(ra[i] - rb[i]);
    if (diff / ra.length < 8) {
      fs.unlinkSync(path.join(outDir, 'left.png'));
      views.splice(views.indexOf('left'), 1);
    }
  }
  return views;
}

// CLI: node scripts/split_sheet.mjs <sheet.png> <outDir> [hint]
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const [sheet, out, hint] = process.argv.slice(2);
  if (!sheet || !out) { console.error('usage: node scripts/split_sheet.mjs <sheet> <outDir> [hint]'); process.exit(1); }
  splitSheet(sheet, out, hint ?? '').then(
    (views) => console.log(`분해 완료: ${views.join(', ') || '(감지된 뷰 없음)'}`),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
