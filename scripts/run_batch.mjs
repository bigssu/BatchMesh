#!/usr/bin/env node
// Meshy 캐릭터 시트 배치 러너 — meshy-batch-handoff-for-claude.md 스펙 구현.
// 의존성 없음 (Node 20.6+ 내장 fetch / loadEnvFile).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// --- CLI 플래그 ---
const args = process.argv.slice(2);
const flagVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const CONFIG_PATH = flagVal('--config') ?? 'config.json';
const INPUT_DIR = flagVal('--input') ?? 'input';
const OUTPUT_DIR = flagVal('--output') ?? 'output';
const ONLY = flagVal('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');

try { process.loadEnvFile(path.resolve('.env')); } catch {}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const { meshy, input: inputCfg, runner } = config;

const BASE = 'https://api.meshy.ai';
const API_KEY = process.env.MESHY_API_KEY;
if (!API_KEY && !DRY_RUN) {
  console.error('Meshy API 키가 없습니다 — 화면 상단 "API 키 설정"에서 입력하세요.');
  process.exit(1);
}

const IMG_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const VIEW_ORDER = ['front', 'left', 'back', 'right'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FatalError extends Error {}

// --- 파일 매칭 (규약 5절 + 4.3절) ---
function matchFiles(dir) {
  const files = fs.readdirSync(dir).filter((f) => IMG_EXTS[path.extname(f).toLowerCase()]).sort();
  const base = (f) => path.basename(f, path.extname(f)).toLowerCase();
  const views = {};
  const used = new Set();
  for (const [view, hints] of Object.entries(inputCfg.view_filenames)) {
    const hit = files.find((f) => hints.includes(base(f)));
    if (hit) { views[view] = hit; used.add(hit); }
  }
  const faces = files.filter((f) => !used.has(f) && inputCfg.face_filenames.includes(base(f)));
  faces.forEach((f) => used.add(f));
  let sheet = files.find((f) => base(f) === 'sheet');
  if (!sheet && Object.keys(views).length === 0) {
    const rest = files.filter((f) => !used.has(f));
    if (rest.length === 1) sheet = rest[0]; // 이미지가 딱 1장이면 시트 원본으로 간주
  }
  return { views, faces, sheet };
}

// --- 엔드포인트 결정 ---
function plan(dir) {
  const { views, faces, sheet } = matchFiles(dir);
  const ordered = VIEW_ORDER.filter((v) => views[v]).map((v) => views[v]);
  if (ordered.length >= 2) {
    if (!views.front) return { fail: 'multi-view인데 front(primary) 뷰가 없음', views, faces, sheet };
    return { endpoint: 'multi-image-to-3d', geometry: ordered, views, faces, sheet };
  }
  if (ordered.length === 1) return { endpoint: 'image-to-3d', geometry: ordered, views, faces, sheet };
  if (sheet && inputCfg.sheet_mode === 'whole_sheet') {
    return { endpoint: 'image-to-3d', geometry: [sheet], views, faces, sheet, wholeSheet: true };
  }
  return {
    fail: sheet
      ? `sheet_mode=${inputCfg.sheet_mode}: 분리 뷰 없음 (시트만 존재) — front/left/back/right로 크롭 필요`
      : '뷰/시트 이미지 없음',
    views, faces, sheet,
  };
}

// --- 요청 바디 조립 (7절) ---
const MAX_IMG = 18 * 1024 * 1024; // Meshy 이미지 20MB 제한 대비 여유

async function prepareImage(file) {
  let buf = fs.readFileSync(file);
  let mime = IMG_EXTS[path.extname(file).toLowerCase()];
  if (buf.length > MAX_IMG) {
    // 단일 이미지가 한도 초과: JPG 변환, 그래도 크면 4096px 리사이즈
    buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    if (buf.length > MAX_IMG) buf = await sharp(buf).resize({ width: 4096, height: 4096, fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
    mime = 'image/jpeg';
  }
  return { buf, mime };
}

async function buildBody(p, dir) {
  const body = {};
  for (const [k, v] of Object.entries(meshy)) if (v !== null) body[k] = v;
  if (!body.ultra_mode) delete body.ultra_mode; // Meshy가 파라미터를 비활성화한 기간엔 false여도 400 거부
  if (runner.geometry_first) {
    // 기하 먼저 검수 모드: 텍스처 없이 생성, 승인 후 UI의 "텍스처 입히기"(Retexture)로 진행
    body.should_texture = false;
    delete body.enable_pbr;
    delete body.texture_resolution;
  }
  const useFace = inputCfg.use_face_as_texture_guide && p.faces.length && body.should_texture &&
    ['latest', 'meshy-7'].includes(body.ai_model);
  const geo = await Promise.all(p.geometry.map((f) => prepareImage(path.join(dir, f))));
  const faces = useFace ? await Promise.all(p.faces.map((f) => prepareImage(path.join(dir, f)))) : [];
  // 전체 페이로드가 20MB 넘으면 PNG 전부 JPG로 전환 (Meshy 업로드 한도 대비)
  const all = [...geo, ...faces];
  if (all.reduce((a, i) => a + i.buf.length, 0) > 20 * 1024 * 1024) {
    for (const i of all) {
      if (i.mime !== 'image/png') continue;
      i.buf = await sharp(i.buf).jpeg({ quality: 90 }).toBuffer();
      i.mime = 'image/jpeg';
    }
  }
  const toUri = (i) => `data:${i.mime};base64,${i.buf.toString('base64')}`;
  if (p.endpoint === 'multi-image-to-3d') body.image_urls = geo.map(toUri);
  else body.image_url = toUri(geo[0]);
  if (faces.length) {
    if (p.endpoint === 'multi-image-to-3d') body.texture_image_urls = faces.map(toUri);
    else body.texture_image_url = toUri(faces[0]);
  }
  return body;
}

// --- API 호출: 429/5xx 지수 백오프 최대 8회, 401/402는 배치 중단 ---
async function api(method, url, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401) throw new FatalError(`401 API 키 오류: ${text}`);
    if (res.status === 402) throw new FatalError(`402 크레딧 부족: ${text}`);
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      await sleep(Math.min(60_000, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

async function pollTask(endpoint, taskId) {
  const deadline = Date.now() + runner.poll_timeout_sec * 1000;
  while (Date.now() < deadline) {
    const task = await api('GET', `${BASE}/openapi/v1/${endpoint}/${taskId}`);
    if (task.status === 'SUCCEEDED') return task;
    if (task.status === 'FAILED' || task.status === 'CANCELED') {
      throw new Error(`task ${task.status}: ${task.task_error?.message ?? ''}`);
    }
    await sleep(runner.poll_interval_sec * 1000);
  }
  throw new Error(`폴링 타임아웃 ${runner.poll_timeout_sec}s (task ${taskId})`);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`다운로드 실패 HTTP ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// --- 로그 ---
fs.mkdirSync('logs', { recursive: true });
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const runLog = path.join('logs', `run-${stamp()}.jsonl`);
const log = (rec) => fs.appendFileSync(runLog, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');
const fail = (id, reason) => {
  log({ id, status: 'failed', reason });
  fs.appendFileSync(path.join('logs', 'failures.jsonl'), JSON.stringify({ ts: new Date().toISOString(), id, reason }) + '\n');
  console.error(`FAIL ${id}: ${reason}`);
};

// --- resume: 성공한 생성(gen-*)이 하나라도 있으면 스킵 (5절) ---
function isDone(id) {
  const dir = path.join(OUTPUT_DIR, id);
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some((g) => {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, g, 'task.json'), 'utf8'));
      return task.status === 'SUCCEEDED' &&
        runner.download_formats.every((f) => fs.existsSync(path.join(dir, g, `model.${f}`)));
    } catch { return false; }
  });
}

// --- 캐릭터 1건 처리 ---
let aborted = null;
async function processChar(id) {
  const t0 = Date.now();
  const dir = path.join(INPUT_DIR, id);
  if (!FORCE && runner.skip_existing && isDone(id)) {
    console.log(`skip ${id} (SUCCEEDED 결과 존재)`);
    return;
  }
  const p = plan(dir);
  if (p.fail) { fail(id, p.fail); return; }
  try {
    const body = await buildBody(p, dir);
    const { result: taskId } = await api('POST', `${BASE}/openapi/v1/${p.endpoint}`, body);
    console.log(`start ${id} → ${p.endpoint} task=${taskId} (${p.geometry.length}장)`);
    const task = await pollTask(p.endpoint, taskId);
    // 생성마다 새 버전 폴더 — 이전 결과를 덮어쓰지 않음
    const outDir = path.join(OUTPUT_DIR, id, `gen-${stamp()}`);
    fs.mkdirSync(outDir, { recursive: true });
    for (const fmt of runner.download_formats) {
      const url = task.model_urls?.[fmt];
      if (!url) throw new Error(`결과에 ${fmt} URL 없음`);
      await download(url, path.join(outDir, `model.${fmt}`));
    }
    if (runner.save_preview && task.thumbnail_url) {
      await download(task.thumbnail_url, path.join(outDir, 'preview.png'));
    }
    fs.writeFileSync(path.join(outDir, 'task.json'), JSON.stringify(task, null, 2));
    const elapsed_sec = Math.round((Date.now() - t0) / 1000);
    log({ id, status: 'succeeded', task_id: taskId, credits: task.consumed_credits ?? null, elapsed_sec, path: outDir });
    console.log(`done ${id} task=${taskId} credits=${task.consumed_credits ?? '?'} ${elapsed_sec}s → ${outDir}`);
  } catch (e) {
    if (e instanceof FatalError) aborted = e;
    fail(id, e.message);
  }
}

// --- 메인 ---
const ids = fs.readdirSync(INPUT_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
  .map((e) => e.name).sort()
  .filter((id) => !ONLY || ONLY.includes(id));

if (ids.length === 0) {
  console.log(`${INPUT_DIR}/ 아래에 캐릭터 폴더가 없습니다.`);
  process.exit(0);
}

if (DRY_RUN) {
  for (const id of ids) {
    const skip = !FORCE && runner.skip_existing && isDone(id);
    const p = plan(path.join(INPUT_DIR, id));
    if (skip) { console.log(`${id}: SKIP (이미 SUCCEEDED)`); continue; }
    if (p.fail) { console.log(`${id}: FAIL — ${p.fail}`); continue; }
    const viewList = VIEW_ORDER.filter((v) => p.views[v]).map((v) => `${v}=${p.views[v]}`).join(', ');
    const face = p.faces.length ? ` | texture_guide: ${p.faces.join(', ')}` : '';
    console.log(`${id}: ${p.endpoint} (${p.geometry.length}장) ${p.wholeSheet ? `sheet=${p.sheet}` : viewList}${face}`);
  }
  process.exit(0);
}

const queue = [...ids];
const worker = async () => { while (queue.length && !aborted) await processChar(queue.shift()); };
await Promise.all(Array.from({ length: Math.min(runner.concurrency, ids.length) }, worker));

if (aborted) {
  console.error(`\n배치 중단: ${aborted.message}`);
  process.exit(1);
}
console.log(`\n완료. 로그: ${runLog}`);
