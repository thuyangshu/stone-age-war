// 独立测试员探针 6：把「CDP 挂死」拆成可判定的三选一。
// 探针 5 复现了挂死（第 11 次「导航 + 轮询 evaluate」时不回包），但那次的浏览器端点诊断有 bug
// （新开的浏览器 socket 没接 onmessage，等于永远收不到回包），结论作废，重做。
//
// 三个模式跑同样的 CDP 调用序列，只换一个变量：
//   A 产品页 + 我的轮询写法（Page.navigate 后立刻反复 Runtime.evaluate 直到 ready）
//   B 桩页   + 同样的轮询写法（data: URL，页面上只有一个 __debug 标记，与产品无关）
//   C 产品页 + 事件驱动写法（Page.navigate 后等 Page.loadEventFired，再 evaluate 一次）
// 判定：
//   A 挂 & B 不挂 & C 不挂  → 挂在「导航后立刻 evaluate」这个 CDP 竞态上，属我这边的用例写法，不是产品缺陷
//   A 挂 & B 也挂           → 与产品无关，是 Chrome 无头实例在长循环下的问题
//   C 也挂                  → 才可能是产品页（渲染进程真卡住），需按产品缺陷追
// 挂死现场额外取证：新开一条 ws 连同一页面目标，问一句 1+1；答不上来才算渲染进程真卡住。
// 用法：node tests/indep-probe6.mjs [A|B|C] [轮数]   （默认 A 40）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const STUB = 'data:text/html,' + encodeURIComponent('<script>window.__debug={game:{isBooted:true}};</script><body>stub');
const MODE = (process.argv[2] || 'A').toUpperCase();
const N = Number(process.argv[3] || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const profile = mkdtempSync(join(tmpdir(), 'stone-probe6-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=390,844',
  '--autoplay-policy=no-user-gesture-required', ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});

let ws, seq = 0;
const pending = new Map();
const events = new Map();          // method → [resolve...]
const onEvent = (method, ms = 15000) => new Promise((res) => {
  const arr = events.get(method) || []; arr.push(res); events.set(method, arr);
  setTimeout(() => { const a = events.get(method) || []; const i = a.indexOf(res); if (i >= 0) a.splice(i, 1); res(false); }, ms);
});
function bind(sock) {
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
    if (msg.method && events.has(msg.method)) { const a = events.get(msg.method); events.delete(msg.method); a.forEach((r) => r(true)); }
  };
}
function send(method, params = {}, ms = 20000) {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
  return Promise.race([new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    sleep(ms).then(() => { throw Object.assign(new Error(`CDP 超时: ${method}`), { cdpTimeout: true }); })]);
}
const evaluate = async (expr, ms = 20000) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms)).result?.value;

// 现场取证：新开一条 ws 连同一个页面目标，问一句 1+1；只有它也答不上来，才说明渲染进程真卡住
async function freshProbe(label) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) { log(`  [${label}] /json/list 里没有 page 目标`); return; }
    const s = new WebSocket(page.webSocketDebuggerUrl);
    await Promise.race([new Promise((r, j) => { s.onopen = r; s.onerror = j; }), sleep(8000).then(() => { throw new Error('新连接连不上'); })]);
    const id1 = ++seq;
    const p1 = new Promise((res) => { s.onmessage = (m) => { const g = JSON.parse(m.data); if (g.id === id1) res(g); }; });
    s.send(JSON.stringify({ id: id1, method: 'Runtime.evaluate', params: { expression: 'document.title + "|" + (window.__debug ? "debug" : "nodebug") + "|" + (1+1)', returnByValue: true } }));
    const r = await Promise.race([p1, sleep(10000).then(() => 'TIMEOUT')]);
    log(`  [${label}] 新 ws 问页面:`, r === 'TIMEOUT' ? '10 秒无回包（渲染进程主线程确实卡住）' : JSON.stringify(r.result?.result?.value));
    try { s.close(); } catch {}
  } catch (e) { log(`  [${label}] 现场取证失败:`, e.message); }
}

async function main() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); }
    catch { await sleep(100); }
  }
  if (!target) throw new Error('Chrome 启动失败');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  bind(ws);
  await send('Runtime.enable'); await send('Page.enable');
  const url = MODE === 'B' ? STUB : SRC;
  log(`模式 ${MODE}：${MODE === 'B' ? '桩页' : '产品页'} × ${N} 轮`);
  const t0 = Date.now();
  for (let k = 0; k < N; k++) {
    if (MODE === 'C') {
      const loaded = onEvent('Page.loadEventFired');
      await send('Page.navigate', { url });
      if (!(await loaded)) { log(`第 ${k} 轮：等 loadEventFired 超时`); }
      await evaluate('document.readyState');
      if (MODE === 'C' && k === 0) log('  （C 模式：等 loadEventFired 后再 evaluate）');
    } else {
      await send('Page.navigate', { url });
      // 与 indep-browser 的 boot() 同构：立刻反复 evaluate 直到 ready
      const t = Date.now(); let ok = false;
      while (Date.now() - t < 8000) {
        if (await evaluate(`!!(window.__debug && window.__debug.game.isBooted)`)) { ok = true; break; }
        await sleep(80);
      }
      if (!ok) log(`第 ${k} 轮：等 ready 超时（不是挂死，是没起来）`);
    }
    await evaluate(MODE === 'B' ? 'document.body.getBoundingClientRect().height' : 'innerWidth');
    if (k % 10 === 9) log(`  ${k + 1}/${N} 轮 OK  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  log(`模式 ${MODE} 跑完 ${N} 轮，没挂，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try { ws.close(); } catch {}
  await sleep(300); reapOne(inst);
  process.exit(0);
}
main().catch(async (e) => {
  log(`\n===== 模式 ${MODE} 卡死在：${e.message} =====`);
  await freshProbe('现场');
  await sleep(1500);
  await freshProbe('1.5 秒后再问一次');
  try { reapOne(inst); } catch {}
  process.exit(e.cdpTimeout ? 9 : 1);
});
