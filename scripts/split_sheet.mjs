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
- "left": full-body side view where the character faces the viewer's LEFT
- "back": full-body back view
- "right": full-body side view where the character faces the viewer's RIGHT
- "face": face/head close-up or facial detail cut
- "other": ANY remaining depiction of the character (alternate pose, extra angle, detail cut, partial render). Label every one of them; "other" may appear multiple times.

Rules:
- Labels front/left/back/right/face at most once each. Only include labels actually present.
- If the sheet has two side views facing the SAME direction (duplicates), label only the clearer ONE with its correct side and label the rest "other". NEVER assign "left" to a right-facing view or vice versa.
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
  const { comp, sizes, sw, sh, scale } = await maskComponents(buf, 800, bg);
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
    let u = null;
    for (let c = 0; c < k; c++) {
      if (sizes[c] < sw * sh * 0.0005) continue;     // 노이즈 성분 제외
      if (inside[c] / sizes[c] < 0.6) continue;       // 박스에 60% 이상 들어있는 성분만
      u = u
        ? { x0: Math.min(u.x0, boxes[c].x0), y0: Math.min(u.y0, boxes[c].y0), x1: Math.max(u.x1, boxes[c].x1), y1: Math.max(u.y1, boxes[c].y1) }
        : { ...boxes[c] };
    }
    if (!u) continue; // 성분 매칭 실패 → Gemini 박스 유지
    const pad = 0.03;
    const uw = (u.x1 - u.x0 + 1) / scale, uh = (u.y1 - u.y0 + 1) / scale;
    const left = Math.max(0, Math.round(u.x0 / scale - uw * pad));
    const top = Math.max(0, Math.round(u.y0 / scale - uh * pad));
    const width = Math.min(meta.width - left, Math.round(uw * (1 + 2 * pad)));
    const height = Math.min(meta.height - top, Math.round(uh * (1 + 2 * pad)));
    // 폭주 가드: 이웃과 붙은 성분이면 원래 박스 유지
    if (width > d.rect.width * 1.8 || height > d.rect.height * 1.8) continue;
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

  // 지울 영역 + 1px 팽창(안티앨리어싱 헤일로 제거)
  const erase = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== keep) erase[i] = 1;
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
  await refineRects(buf, meta, dets, bg); // 뷰 박스를 픽셀 성분 bbox로 확장/보정

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
