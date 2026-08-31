// 시트 검수용 로컬 웹 서버: 업로드 → 자동 분해 → 확인/재생성/삭제 → 승인 → Meshy 배치.
// 실행: node server.mjs  →  http://localhost:3838
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { splitSheet } from './scripts/split_sheet.mjs';

try { process.loadEnvFile(path.resolve('.env')); } catch {}

const PORT = 3838;
const ROOT = process.cwd();
const STAGING = path.join(ROOT, 'staging');
const INPUT = path.join(ROOT, 'input');
const OUTPUT = path.join(ROOT, 'output');
const HISTORY = path.join(ROOT, 'history');
const LABELS = ['front', 'left', 'back', 'right', 'face'];
fs.mkdirSync(STAGING, { recursive: true });
fs.mkdirSync(HISTORY, { recursive: true });
const stamp = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

// 생성 결과 버전(gen-*) 목록
function listGens(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('gen-'))
    .map((e) => {
      const gd = path.join(dir, e.name);
      const formats = ['glb', 'fbx'].filter((f) => fs.existsSync(path.join(gd, `model.${f}`)));
      let finished = null, derived = null, polycount = null, retextured = null, geomOnly = false, elapsed = null;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(gd, 'task.json'), 'utf8'));
        finished = t.finished_at ?? null;
        derived = t.derived_from ?? null;
        polycount = t.target_polycount ?? null;
        retextured = t.retextured_from ?? null;
        geomOnly = !derived && !retextured && !(t.texture_urls?.length);
        if (t.started_at && t.finished_at) elapsed = Math.round((t.finished_at - t.started_at) / 1000);
      } catch {}
      return { name: e.name, formats, finished, derived, polycount, retextured, geomOnly, elapsed, preview: fs.existsSync(path.join(gd, 'preview.png')) };
    })
    .filter((g) => g.formats.length)
    .sort((a, b) => a.name.localeCompare(b.name)); // 이름 = 일시 → 생성 순서
}

// --- 시트 상태 ---
const metaPath = (id) => path.join(STAGING, id, 'meta.json');
const readMeta = (id) => JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
const writeMeta = (id, m) => fs.writeFileSync(metaPath(id), JSON.stringify(m, null, 2));
// meta.json mtime = 클라이언트 캐시버스트 rev — 시트 내용이 바뀌면 touch
const touch = (id) => { try { const now = new Date(); fs.utimesSync(metaPath(id), now, now); } catch {} };
const readConfig = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const viewsIn = (dir) => LABELS.filter((l) => fs.existsSync(path.join(dir, `${l}.png`)));
// /files·reveal 공용 경로 검증: 허용 루트 밖이거나 없으면 null
const resolveUnder = (rel) => {
  const abs = path.normalize(path.join(ROOT, rel));
  const ok = [STAGING, OUTPUT, HISTORY].some((b) => abs.startsWith(b + path.sep));
  return ok && fs.existsSync(abs) ? abs : null;
};

function listSheets() {
  if (!fs.existsSync(STAGING)) return [];
  return fs.readdirSync(STAGING, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const id = e.name;
      let m; try { m = readMeta(id); } catch { m = { status: 'error', error: 'meta 손상' }; }
      const views = viewsIn(path.join(STAGING, id));
      const gens = listGens(path.join(OUTPUT, id));
      let rev = 0; try { rev = Math.round(fs.statSync(metaPath(id)).mtimeMs); } catch {}
      const jobs = remeshJobs.filter((j) => j.id === id).map(({ src, polycount, kind, started, progress }) => ({ src, polycount, kind, started, progress }));
      let created = 0; try { created = fs.statSync(path.join(STAGING, id)).birthtimeMs; } catch {}
      return {
        id, ...m, views, done: gens.length > 0, gens, rev, jobs, created,
        generating: run.running && run.ids.includes(id),
        runStarted: run.started ?? null,
        lastError: lastErrors[id] ?? null,
      };
    })
    .sort((a, b) => b.created - a.created); // 최신 시트가 위로
}

async function createSheet(name, dataUrl) {
  let id = path.basename(name, path.extname(name)).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet';
  let n = 2;
  while (fs.existsSync(path.join(STAGING, id))) id = `${id.replace(/-\d+$/, '')}-${n++}`;
  const dir = path.join(STAGING, id);
  fs.mkdirSync(dir, { recursive: true });
  const b64 = dataUrl.replace(/^data:[^,]+,/, '');
  // 포맷 통일: 무엇이 오든 png로 저장
  await sharp(Buffer.from(b64, 'base64')).png().toFile(path.join(dir, 'sheet.png'));
  writeMeta(id, { status: 'splitting', started: Date.now() });
  await resplit(id, '');
  return id;
}

async function resplit(id, hint) {
  const dir = path.join(STAGING, id);
  writeMeta(id, { status: 'splitting', started: Date.now() });
  try {
    const views = await splitSheet(path.join(dir, 'sheet.png'), dir, hint);
    writeMeta(id, { status: 'review', hint: hint || undefined });
    return views;
  } catch (e) {
    writeMeta(id, { status: 'error', error: e.message });
    throw e;
  }
}

function approve(id) {
  const src = path.join(STAGING, id);
  const views = viewsIn(src);
  const geo = views.filter((v) => v !== 'face');
  // 뷰 1장이면 싱글 이미지 모드(image-to-3d) — 방향 무관. 2장 이상이면 front가 primary라 필수.
  if (geo.length !== 1 && !views.includes('front')) {
    throw new Error('front 뷰가 없어 승인 불가 (재생성 힌트로 지정하거나, 불필요한 뷰를 지워 1장만 남기면 싱글 이미지 모드로 생성됩니다)');
  }
  const dst = path.join(INPUT, id);
  fs.mkdirSync(dst, { recursive: true });
  for (const l of views) fs.copyFileSync(path.join(src, `${l}.png`), path.join(dst, `${l}.png`));
  const m = readMeta(id);
  writeMeta(id, { ...m, status: 'approved' });
}

// --- 배치 실행 ---
const run = { running: false, lines: [], ids: [] };
const lastErrors = {}; // 시트별 마지막 작업 실패 (카드에 오류 카드로 표시, 확인 시 해제)
const pushLine = (s) => {
  run.lines.push(s);
  if (run.lines.length > 500) run.lines = run.lines.slice(-500);
  const m = s.match(/^FAIL ([a-z0-9_-]+): (.*)$/);
  if (m) lastErrors[m[1]] = { message: m[2], ts: Date.now() };
};

// --- 로우폴리 추출: 하이폴리 버전의 task id로 Meshy Remesh — 항상 원본 하이폴리에서 깎음 ---
const MESHY = 'https://api.meshy.ai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function meshyApi(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${process.env.MESHY_API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      await sleep(Math.min(60_000, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`Meshy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// --- 크롭 2K 업스케일: Gemini 이미지 모델로 충실 복원 업스케일 (Imagen 업스케일은 2026-06 은퇴) ---
// 긴 변을 2048px로: 세로형 → 세로 2048, 가로형 → 가로 2048. 원본 비율 유지.
async function upscale2k(file) {
  const buf = fs.readFileSync(file);
  const meta = await sharp(buf).metadata();
  const long = Math.max(meta.width, meta.height);
  if (long >= 2048) throw new Error(`이미 2K 이상입니다 (${meta.width}×${meta.height})`);
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY 환경변수 없음');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/png', data: buf.toString('base64') } },
          { text: 'Upscale this image to high resolution. Reproduce the EXACT same image with sharper, more refined detail — identical character design, pose, proportions, colors, framing and background. Do not add, remove, crop, or restyle anything.' },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '2K' } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const parts = (await res.json()).candidates?.[0]?.content?.parts ?? [];
  const img = parts.map((p) => p.inlineData ?? p.inline_data).find(Boolean);
  if (!img) throw new Error('업스케일 응답에 이미지 없음');
  const outBuf = Buffer.from(img.data, 'base64');
  const om = await sharp(outBuf).metadata();
  const drift = Math.abs(om.width / om.height - meta.width / meta.height) / (meta.width / meta.height);
  if (drift > 0.1) throw new Error('업스케일 결과의 비율이 원본과 달라 폐기했습니다 — 다시 시도하세요');
  const scale = 2048 / long;
  const tw = Math.round(meta.width * scale), th = Math.round(meta.height * scale);
  const resized = await sharp(outBuf).resize(tw, th, { fit: 'fill' }).png().toBuffer();
  fs.writeFileSync(file, resized);
  return { width: tw, height: th };
}

const remeshJobs = []; // 진행 중인 파생 작업 (추출/텍스처 — UI 표시용)

// 추출/텍스처 공통 흐름: POST → 진행률 폴링 → gen-* 저장 → 로그/오류 기록
async function meshyDerivedJob(id, gname, { kind, endpoint, buildBody, extra, startMsg, doneMsg, failMsg }) {
  const t0 = Date.now();
  const job = { id, src: gname, polycount: extra.target_polycount ?? null, kind, started: t0, progress: 0 };
  remeshJobs.push(job);
  try {
    const src = JSON.parse(fs.readFileSync(path.join(OUTPUT, id, gname, 'task.json'), 'utf8'));
    const cfg = readConfig();
    const { result: taskId } = await meshyApi('POST', `${MESHY}/openapi/v1/${endpoint}`, await buildBody(cfg, src));
    pushLine(`${startMsg} task=${taskId}`);
    let task;
    const deadline = Date.now() + (cfg.runner.poll_timeout_sec ?? 900) * 1000;
    for (;;) {
      task = await meshyApi('GET', `${MESHY}/openapi/v1/${endpoint}/${taskId}`);
      job.progress = task.progress ?? 0;
      if (task.status === 'SUCCEEDED') break;
      if (task.status === 'FAILED' || task.status === 'CANCELED') throw new Error(`${task.status}: ${task.task_error?.message ?? ''}`);
      if (Date.now() > deadline) throw new Error('타임아웃');
      await sleep((cfg.runner.poll_interval_sec ?? 4) * 1000);
    }
    const dst = path.join(OUTPUT, id, `gen-${stamp()}`);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of cfg.runner.download_formats) {
      const u = task.model_urls?.[f];
      if (!u) continue;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`다운로드 HTTP ${r.status}`);
      fs.writeFileSync(path.join(dst, `model.${f}`), Buffer.from(await r.arrayBuffer()));
    }
    if (task.thumbnail_url) {
      try { const r = await fetch(task.thumbnail_url); fs.writeFileSync(path.join(dst, 'preview.png'), Buffer.from(await r.arrayBuffer())); } catch {}
    }
    fs.writeFileSync(path.join(dst, 'task.json'), JSON.stringify({ ...task, ...extra }, null, 2));
    touch(id);
    pushLine(`${doneMsg} ${Math.round((Date.now() - t0) / 1000)}s → ${path.basename(dst)}`);
  } catch (e) {
    pushLine(`${failMsg} ${id}/${gname}: ${e.message}`);
    lastErrors[id] = { message: `${failMsg}: ${e.message}`, ts: Date.now() };
  } finally {
    remeshJobs.splice(remeshJobs.indexOf(job), 1);
  }
}

// 로우폴리 추출: 원본(하이폴리) task id 기준이라 항상 원본에서 깎음
const remeshJob = (id, gname, polycount) => meshyDerivedJob(id, gname, {
  kind: 'remesh',
  endpoint: 'remesh',
  extra: { derived_from: gname, target_polycount: polycount },
  buildBody: async (cfg, src) => ({
    input_task_id: src.id,
    target_polycount: polycount,
    topology: cfg.meshy.topology ?? 'quad',
    target_formats: cfg.runner.download_formats,
  }),
  startMsg: `추출 시작 ${id} (${gname} → ${polycount.toLocaleString()}면)`,
  doneMsg: `추출 완료 ${id} ${polycount.toLocaleString()}면`,
  failMsg: '로우폴리 추출 실패',
});

// 기하-먼저 모드: 승인된 기하 버전에 시트 뷰를 가이드로 텍스처 입히기 (Retexture)
const retextureJob = (id, gname) => meshyDerivedJob(id, gname, {
  kind: 'retexture',
  endpoint: 'retexture',
  extra: { retextured_from: gname },
  buildBody: async (cfg, src) => {
    const dir = path.join(STAGING, id);
    const names = viewsIn(dir);
    if (!names.length) throw new Error('시트 크롭이 없어 스타일 가이드를 만들 수 없음');
    return {
      input_task_id: src.id,
      multiview_image_urls: await cropUris(dir, names),
      ai_model: 'meshy-7', // multiview_image_urls는 meshy-7 필수 (latest 불가)
      enable_original_uv: true,
      enable_pbr: cfg.meshy.enable_pbr,
      texture_resolution: cfg.meshy.texture_resolution,
      remove_lighting: cfg.meshy.remove_lighting,
      target_formats: cfg.runner.download_formats,
    };
  },
  startMsg: `텍스처 시작 ${id} (${gname})`,
  doneMsg: `텍스처 완료 ${id}`,
  failMsg: '텍스처 생성 실패',
});
function startRun(ids, force = false) {
  if (run.running) throw new Error('이미 배치가 실행 중입니다');
  if (!ids.length) throw new Error('새로 생성할 승인 시트가 없습니다. 이미 생성된 시트는 카드의 "3D 재생성" 버튼을 사용하세요.');
  run.running = true; run.lines = []; run.ids = ids; run.started = Date.now();
  for (const id of ids) delete lastErrors[id];
  const args = ['scripts/run_batch.mjs', '--only', ids.join(',')];
  if (force) args.push('--force');
  const child = spawn(process.execPath, args, { cwd: ROOT });
  const push = (buf) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) pushLine(line.trim());
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('exit', (code) => { run.running = false; pushLine(`--- 배치 종료 (exit ${code}) ---`); });
}

// 크롭들을 data URI로 (총합 20MB 초과 시 JPG 전환, 그래도 크면 4096px 리사이즈)
async function cropUris(dir, names) {
  const imgs = names.map((n) => ({ buf: fs.readFileSync(path.join(dir, `${n}.png`)), mime: 'image/png' }));
  const over = imgs.reduce((a, i) => a + i.buf.length, 0) > 20 * 1024 * 1024;
  for (const i of imgs) {
    if (over || i.buf.length > 18 * 1024 * 1024) {
      i.buf = await sharp(i.buf).jpeg({ quality: 90 }).toBuffer();
      if (i.buf.length > 18 * 1024 * 1024) i.buf = await sharp(i.buf).resize({ width: 4096, height: 4096, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
      i.mime = 'image/jpeg';
    }
  }
  return imgs.map((i) => `data:${i.mime};base64,${i.buf.toString('base64')}`);
}

// --- HTTP ---
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 80e6) reject(new Error('본문 80MB 초과')); else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.glb': 'model/gltf-binary', '.json': 'application/json', '.js': 'text/javascript' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ROOT, 'web', 'index.html')));
    }
    if (p === '/viewer' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ROOT, 'web', 'viewer.html')));
    }
    // three.js 모듈 서빙 (node_modules/three 한정)
    if (p.startsWith('/vendor/three/') && req.method === 'GET') {
      const abs = path.normalize(path.join(ROOT, 'node_modules', 'three', decodeURIComponent(p.slice('/vendor/three/'.length))));
      if (!abs.startsWith(path.join(ROOT, 'node_modules', 'three') + path.sep) || !fs.existsSync(abs)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(abs).pipe(res);
    }
    // 정적 파일: /files/staging/... , /files/output/... (HEAD는 크기 조회용)
    if (p.startsWith('/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const abs = resolveUnder(decodeURIComponent(p.slice('/files/'.length)));
      if (!abs) return json(res, 404, { error: 'not found' });
      // no-cache + Last-Modified 재검증: 재생성으로 파일이 바뀌면 즉시 반영, 안 바뀌면 304
      const st = fs.statSync(abs);
      const lm = st.mtime.toUTCString();
      if (req.headers['if-modified-since'] === lm) { res.writeHead(304); return res.end(); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
        'Last-Modified': lm,
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(abs).pipe(res);
    }
    if (p === '/api/root' && req.method === 'GET') return json(res, 200, { root: ROOT });
    // 탐색기에서 해당 파일 위치 열기
    if (p === '/api/reveal' && req.method === 'POST') {
      const { rel } = JSON.parse(await readBody(req));
      const abs = resolveUnder(rel);
      if (!abs) return json(res, 404, { error: 'not found' });
      spawn('explorer.exe', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    // 히스토리 목록
    if (p === '/api/history' && req.method === 'GET') {
      const entries = fs.readdirSync(HISTORY, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dir = path.join(HISTORY, e.name);
          return {
            name: e.name,
            id: e.name.replace(/^\d{8}-\d{6}_/, ''),
            gens: listGens(dir),
            views: viewsIn(dir),
          };
        })
        .sort((a, b) => b.name.localeCompare(a.name));
      return json(res, 200, entries);
    }
    // 생성 옵션 (config.json의 meshy 블록) 조회/수정 — 다음 배치부터 적용
    if (p === '/api/config' && req.method === 'GET') {
      const cfg = readConfig();
      return json(res, 200, { ...cfg.meshy, geometry_first: cfg.runner.geometry_first ?? false });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const upd = JSON.parse(await readBody(req));
      const cfg = readConfig();
      if ('geometry_first' in upd) cfg.runner.geometry_first = !!upd.geometry_first;
      const ALLOWED = ['ai_model', 'should_texture', 'enable_pbr', 'texture_resolution', 'should_remesh',
        'pose_mode', 'image_enhancement', 'remove_lighting', 'ultra_mode', 'target_polycount',
        'auto_size', 'topology', 'symmetry_mode', 'target_formats'];
      for (const k of ALLOWED) if (k in upd) cfg.meshy[k] = upd[k];
      // 다운로드 포맷은 생성 포맷과 동기화
      if (Array.isArray(upd.target_formats) && upd.target_formats.length) cfg.runner.download_formats = upd.target_formats;
      fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
      return json(res, 200, cfg.meshy);
    }
    if (p === '/api/sheets' && req.method === 'GET') return json(res, 200, listSheets());
    if (p === '/api/sheets' && req.method === 'POST') {
      const { name, dataUrl } = JSON.parse(await readBody(req));
      const id = await createSheet(name, dataUrl);
      return json(res, 200, { id });
    }
    // 로우폴리 추출 (원본 하이폴리 버전에서)
    const mr = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/gen\/(gen-[0-9-]+)\/remesh$/);
    if (mr && req.method === 'POST') {
      const { polycount } = JSON.parse(await readBody(req));
      const pc = Math.round(Number(polycount));
      if (!pc || pc < 100 || pc > 300000) return json(res, 400, { error: 'polycount는 100~300,000' });
      if (!fs.existsSync(path.join(OUTPUT, mr[1], mr[2], 'task.json'))) return json(res, 404, { error: '해당 버전 없음' });
      remeshJob(mr[1], mr[2], pc); // 백그라운드 실행 — 진행/완료는 로그와 카드 갱신으로 표시
      return json(res, 200, { ok: true });
    }
    // 기하 버전에 텍스처 입히기 (Retexture)
    const mt = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/gen\/(gen-[0-9-]+)\/texture$/);
    if (mt && req.method === 'POST') {
      if (!fs.existsSync(path.join(OUTPUT, mt[1], mt[2], 'task.json'))) return json(res, 404, { error: '해당 버전 없음' });
      retextureJob(mt[1], mt[2]); // 백그라운드 실행
      return json(res, 200, { ok: true });
    }
    // 생성 결과 1건 영구 삭제
    const mg = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/gen\/(gen-[0-9-]+)$/);
    if (mg && req.method === 'DELETE') {
      fs.rmSync(path.join(OUTPUT, mg[1], mg[2]), { recursive: true, force: true });
      touch(mg[1]);
      return json(res, 200, { ok: true });
    }
    // 크롭 1장 GCP 업스케일 → 2K
    const mus = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/upscale\/([a-z]+)$/);
    if (mus && req.method === 'POST') {
      const [, id, view] = mus;
      if (!LABELS.includes(view) && view !== 'sheet') return json(res, 400, { error: 'bad view' });
      const file = path.join(STAGING, id, `${view}.png`);
      if (!fs.existsSync(file)) return json(res, 404, { error: '크롭 없음' });
      const dims = await upscale2k(file);
      // 이미 승인된 시트면 input/ 사본도 갱신
      try { if (fs.existsSync(path.join(INPUT, id, `${view}.png`))) fs.copyFileSync(file, path.join(INPUT, id, `${view}.png`)); } catch {}
      touch(id); // rev 갱신 → 이미지 새로고침
      return json(res, 200, { ok: true, ...dims });
    }
    // 크롭 1장만 삭제 (검수 중 불필요한 뷰 제외용)
    const mv = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/view\/([a-z]+)$/);
    if (mv && req.method === 'DELETE') {
      const [, id, label] = mv;
      if (!LABELS.includes(label)) return json(res, 400, { error: 'bad label' });
      fs.rmSync(path.join(STAGING, id, `${label}.png`), { force: true });
      fs.rmSync(path.join(INPUT, id, `${label}.png`), { force: true });
      touch(id);
      return json(res, 200, { ok: true });
    }
    // 실패 표시 해제
    const me = p.match(/^\/api\/sheets\/([a-z0-9_-]+)\/error$/);
    if (me && req.method === 'DELETE') {
      delete lastErrors[me[1]];
      return json(res, 200, { ok: true });
    }
    const m = p.match(/^\/api\/sheets\/([a-z0-9_-]+)(?:\/(\w+))?$/);
    if (m) {
      const [, id, action] = m;
      if (req.method === 'DELETE') {
        fs.rmSync(path.join(STAGING, id), { recursive: true, force: true });
        fs.rmSync(path.join(INPUT, id), { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      // 완료 시트를 삭제 없이 history/로 이동 (크롭+모델+로그 전부 보존)
      if (action === 'archive' && req.method === 'POST') {
        const dst = path.join(HISTORY, `${stamp()}_${id}`);
        fs.mkdirSync(dst, { recursive: true });
        for (const srcDir of [path.join(STAGING, id), path.join(OUTPUT, id)]) {
          if (!fs.existsSync(srcDir)) continue;
          for (const f of fs.readdirSync(srcDir)) fs.renameSync(path.join(srcDir, f), path.join(dst, f));
          fs.rmSync(srcDir, { recursive: true, force: true });
        }
        fs.rmSync(path.join(INPUT, id), { recursive: true, force: true });
        return json(res, 200, { ok: true, entry: path.basename(dst) });
      }
      if (action === 'resplit' && req.method === 'POST') {
        const { hint } = JSON.parse(await readBody(req));
        const views = await resplit(id, hint ?? '');
        return json(res, 200, { views });
      }
      if (action === 'approve' && req.method === 'POST') { approve(id); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/run' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch {}
      const all = listSheets();
      const force = !!body.force;
      const ids = Array.isArray(body.ids) && body.ids.length
        ? body.ids.filter((id) => all.some((s) => s.id === id && s.status === 'approved'))
        : all.filter((s) => s.status === 'approved' && !s.done).map((s) => s.id);
      startRun(ids, force);
      return json(res, 200, { ids, force });
    }
    if (p === '/api/run' && req.method === 'GET') return json(res, 200, run);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`시트 검수 UI: http://localhost:${PORT}`));
