// 独立测试员探针 7：复现「长循环 + 导航 + 交互」下的 CDP 挂死，并在挂死当场回答一个问题——
// 页面的主线程还活着吗（新开一条 ws 问 1+1）。这一个事实决定挂死算谁头上：
//   页面答得上 → 卡的是我这条 CDP 会话，产品无责，我的用例得改成断线重连
//   页面答不上 → 渲染进程真卡住，按产品缺陷报（这是阻断级的）
// 探针 5 已在「C 组循环」下复现过一次（第 11 个种子卡在 boot 的 evaluate 上，300 秒无回包）。
// 本探针复刻同一条循环，并加超时诊断；可关掉某些动作做二分。
// 用法：node tests/indep-probe7.mjs [--pre] [--nomouse] [--nobattle] [--rounds=36]
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const val = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
const PRE = flag('pre'), MOUSE = !flag('nomouse'), BATTLE = !flag('nobattle');
const ROUNDS = val('rounds', 36);
const t0 = Date.now();
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

const profile = mkdtempSync(join(tmpdir(), 'stone-probe7-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
  '--autoplay-policy=no-user-gesture-required', ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank'], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});

let ws, seq = 0, lastOp = '(未开始)';
const pending = new Map();
function send(method, params = {}, ms = 20000) {
  const id = ++seq; lastOp = method; ws.send(JSON.stringify({ id, method, params }));
  return Promise.race([new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    sleep(ms).then(() => { throw Object.assign(new Error(`CDP 超时: ${method}`), { cdpTimeout: true }); })]);
}
const evaluate = async (expr, ms = 20000) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms)).result?.value;
async function waitFor(expr, timeout = 8000) {
  const t = Date.now();
  while (Date.now() - t < timeout) { if (await evaluate(`!!(${expr})`)) return true; await sleep(80); }
  throw new Error(`等待超时: ${expr}`);
}
async function clickId(id) {
  const p = await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)}); if(!e) return null;
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!p) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return true;
}
async function freshProbe(label) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) { log(`  [${label}] /json/list 没有 page 目标（页面进程没了）`); return; }
    const s = new WebSocket(page.webSocketDebuggerUrl);
    await Promise.race([new Promise((r, j) => { s.onopen = r; s.onerror = j; }), sleep(8000).then(() => { throw new Error('新连接连不上'); })]);
    const id1 = ++seq;
    const p1 = new Promise((res) => { s.onmessage = (m) => { const g = JSON.parse(m.data); if (g.id === id1) res(g); }; });
    s.send(JSON.stringify({ id: id1, method: 'Runtime.evaluate', params: { expression: '"ready=" + document.readyState + " debug=" + (window.__debug ? 1 : 0) + " phase=" + (window.__debug && __debug.state ? __debug.state().phase : "-")', returnByValue: true } }));
    const r = await Promise.race([p1, sleep(10000).then(() => 'TIMEOUT')]);
    log(`  [${label}] 新 ws 问页面:`, r === 'TIMEOUT' ? '10 秒无回包 —— 渲染进程主线程卡住' : JSON.stringify(r.result?.result?.value));
    try { s.close(); } catch {}
  } catch (e) { log(`  [${label}] 取证失败:`, e.message); }
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
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (g.id && pending.has(g.id)) { const p = pending.get(g.id); pending.delete(g.id); g.error ? p.reject(new Error(g.error.message)) : p.resolve(g.result); } };
  await send('Runtime.enable'); await send('Page.enable');
  log(`配置：pre=${PRE} mouse=${MOUSE} battle=${BATTLE} rounds=${ROUNDS}`);

  if (PRE) {
    for (const vp of [{ w: 390, h: 844, dsf: 3 }, { w: 844, h: 390, dsf: 2 }, { w: 320, h: 568, dsf: 2 }, { w: 2560, h: 1080, dsf: 1 }, { w: 1280, h: 800, dsf: 1 }]) {
      await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 });
      await send('Page.navigate', { url: SRC });
      await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
      if (MOUSE) await clickId('btn-duo');
      await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 8000);
      for (let k = 0; k < 8; k++) await evaluate(`document.getElementById('weapons').getBoundingClientRect().height`);
    }
    log('pre 组完成');
  }
  const VPS = [{ w: 390, h: 844, dsf: 3, tag: '竖屏' }, { w: 844, h: 390, dsf: 2, tag: '横屏' }, { w: 1280, h: 800, dsf: 1, tag: '桌面' }];
  let n = 0;
  for (let vi = 0; vi < VPS.length && n < ROUNDS; vi++) {
    const vp = VPS[vi];
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 });
    log(`C[${vp.tag}] 起`);
    for (let k = 0; k < 12 && n < ROUNDS; k++, n++) {
      const seed = 1000 + k * 137;
      await send('Page.navigate', { url: SRC });
      await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
      if (MOUSE) await clickId('btn-duo');
      if (BATTLE) {
        await evaluate(`(() => { __debug.game.scene.getScene('battle').startBattle('duo','medium',${seed}); return true; })()`);
        await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 8000);
        await sleep(420);
        await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
          const b=sc.heroes[s.turn].getBounds(), v=cam.worldView, z=cam.zoom;
          return [Math.round((b.left-v.x)*z), Math.round((b.right-v.x)*z), Math.round((b.top-v.y)*z), Math.round((b.bottom-v.y)*z)].join(','); })()`);
      }
      if (n % 6 === 5) log(`  第 ${n + 1}/${ROUNDS} 轮 OK`);
    }
  }
  log(`跑完 ${n} 轮，没挂，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try { ws.close(); } catch {}
  await sleep(300); reapOne(inst);
  process.exit(0);
}
main().catch(async (e) => {
  log(`\n===== 卡死在：${lastOp}（${e.message}） =====`);
  await freshProbe('现场');
  await sleep(1500);
  await freshProbe('1.5 秒后');
  try { reapOne(inst); } catch {}
  process.exit(e.cdpTimeout ? 9 : 1);
});
