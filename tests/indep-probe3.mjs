// 定点探针 3：开发方冒烟 S-5「首回合射手就在手机屏幕内」为什么挂
//   把「进入 aim 那一刻」到「镜头停稳」之间的时间线逐帧打出来，
//   判定这是"产品首回合真的没取景"还是"用例在镜头平移途中就断言了"。
// 用法：node tests/indep-probe3.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9500 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'stone-probe3-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=390,844', ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});
const wd = watchdog(240);
let ws, seq = 0; const pending = new Map();
function send(method, params = {}) {
  const id = ++seq; wd.ping();
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(expr + ' → ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(e, t = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await ev(`!!(${e})`)) return true; await sleep(40); }
  throw new Error('等待超时: ' + e);
}
async function clickId(id) {
  const p = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+r.height/2, hidden:e.hidden };})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
// 观测点：射手精灵是否完整落在视口里 + 镜头是否还在平移
const FRAME = `(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
  const box=sc.heroes[s.turn].getBounds(), v=cam.worldView, z=cam.zoom;
  const l=(box.left-v.x)*z, r=(box.right-v.x)*z, t=(box.top-v.y)*z, b=(box.bottom-v.y)*z;
  return { on: l>=0 && r<=innerWidth && t>=0 && b<=innerHeight,
           l:Math.round(l), r:Math.round(r), vw:innerWidth, vh:innerHeight,
           pan: cam.panEffect.isRunning, vx: Math.round(v.x), meX: Math.round(s.players[s.turn].x),
           phase: s.phase, turn: s.turn }; })()`;

async function main() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); }
    catch { await sleep(100); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { wd.ping(); const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

  console.log('手机竖屏 390×844 · 每次都是「人机对战/双人」开局，逐帧看首回合射手在不在画面里');
  let firstOffCount = 0, settledOffCount = 0;
  for (let k = 0; k < 8; k++) {
    await send('Page.navigate', { url: SRC });
    await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
    await clickId(k % 2 ? 'btn-duo' : 'btn-solo');
    await waitFor('window.__debug.ready()', 9000);
    // 一进 aim 就立刻进入取样循环（尽量贴近开发方 S-5 的时机）
    await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 9000);
    const t0 = Date.now();
    const line = [];
    let firstOn = null, settleAt = null, firstSample = null;
    for (let i = 0; i < 22; i++) {
      const f = await ev(FRAME);
      if (i === 0) firstSample = f;
      if (f.on && firstOn === null) firstOn = Date.now() - t0;
      if (!f.on && firstOn !== null && settleAt === null) settleAt = Date.now() - t0;
      line.push(`${Date.now() - t0}ms:${f.on ? '在' : '★不在'}/pan=${f.pan ? '动' : '停'}/vx=${f.vx}/me=${f.meX}`);
      if (!f.pan && i > 1 && f.on) break;      // 镜头停稳且在画面里就收工
      await sleep(50);
    }
    const last = await ev(FRAME);
    const immediately = !!firstSample.on;
    if (!immediately) firstOffCount++;
    if (!last.on) settledOffCount++;
    console.log(`\n第 ${k + 1} 局（${k % 2 ? '双人' : '人机'}）`);
    console.log(`  进 aim 那一刻：${immediately ? '✅ 射手已在画面内' : `★ 射手不在画面内（精灵屏幕 x[${firstSample.l},${firstSample.r}]，视口宽 ${firstSample.vw}）`}`);
    console.log(`  首次进画面：${firstOn === null ? '★ 直到本局采样结束都没进过画面' : firstOn + 'ms'}；` +
      `此后又出画面：${settleAt === null ? '没有' : settleAt + 'ms'}`);
    console.log(`  最终：${last.on ? '✅ 在画面内' : '★ 仍不在画面内'}（pan=${last.pan ? '还在动' : '已停'}，射手世界x=${last.meX} 视野左缘x=${last.vx}）`);
    console.log('  时间线：' + line.slice(0, 10).join(' | '));
  }
  console.log(`\n小结：进 aim 那一刻射手不在画面内的 ${firstOffCount}/8 局；到镜头停稳still不在的 ${settledOffCount}/8 局`);
  console.log(firstOffCount > 0 && settledOffCount === 0
    ? '→ 结论：镜头是"边平移边交还操作权"，玩家能看见自己人，但存在一小段镜头还在走的过渡期；开发方 S-5 是在过渡期内断言的（用例竞态）'
    : settledOffCount > 0 ? '→ 结论：镜头停稳后射手仍不在画面内，属产品缺陷' : '→ 结论：两种时机都正常，S-5 属偶发');
}
let code = 0;
try { await main(); } catch (e) { console.log('❌ 探针中断: ' + e.message); code = 1; }
finally { try { ws && ws.close(); } catch {} await sleep(200); reapOne(inst); }
process.exit(code);
