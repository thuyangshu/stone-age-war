// 定点探针：把疑似问题单独钉死
//   1) 暂停 →「重开一局」→ 新一局卡死：触发窗口有多宽（人手够不够得着）
//   2) 开局第一回合，相机有没有把"当前射手"取进画面（F10）
// 用法：node tests/indep-probe.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9400 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'stone-probe-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', ...MUTE,
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
async function waitFor(e, t = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await ev(`!!(${e})`)) return true; await sleep(80); }
  throw new Error('等待超时: ' + e);
}
async function clickId(id) {
  const p = await ev(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const RAF = `(() => { window.__frames=0; const loop=()=>{ window.__frames++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`;
const PLAYABLE = (s) => ['aim', 'think', 'fly', 'impact', 'handoff'].includes(s);
async function boot(url = SRC) {
  await send('Page.navigate', { url });
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
  await ev(RAF);
}

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
  await boot();

  // ══════════════════════════════════════════════════════════
  console.log('\n══ 探针 1：暂停→重开 卡死的触发窗口 ══');
  console.log('  两次点击间隔   重开 2.5s 后相位   sysPaused  判定');
  for (const gap of [0, 16, 33, 50, 100, 200]) {
    await boot();
    await clickId('btn-duo');
    await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 8000);
    await ev(`(()=>{const sc=__debug.game.scene.getScene('battle'); sc.fire(0.9,1); return true;})()`);
    await sleep(350);
    await clickId('btn-pause');
    if (gap > 0) await sleep(gap);
    await clickId('btn-restart');
    await sleep(2600);
    const info = await ev(`(() => { const sc=__debug.game.scene.getScene('battle');
      return { phase: sc.s && sc.s.phase, sysPaused: sc.sys.isPaused(), status: sc.sys.settings.status,
               turn: sc.s && sc.s.turn, frames: window.__frames }; })()`);
    const stuck = !PLAYABLE(info.phase);
    console.log(`  ${String(gap + 'ms').padEnd(13)} ${String(info.phase).padEnd(18)} ${String(info.sysPaused).padEnd(11)}`
      + ` ${stuck ? '★卡死（相位不进 aim/think）' : '✅ 正常'}  status=${info.status}`);
  }
  // 同一条路径上「继续」按钮做对照：暂停后手快点继续，会不会也卡
  console.log('\n  【对照】暂停 → 手快点「继续」（间隔 0ms）');
  await boot();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 8000);
  await ev(`(()=>{const sc=__debug.game.scene.getScene('battle'); sc.fire(0.9,1); return true;})()`);
  await sleep(350);
  await ev(`document.getElementById('btn-pause').click(); document.getElementById('btn-resume').click(); true`);
  await sleep(2600);
  const info2 = await ev(`(() => { const sc=__debug.game.scene.getScene('battle');
    return { phase: sc.s && sc.s.phase, sysPaused: sc.sys.isPaused() }; })()`);
  console.log(`  重开 2.5s 后相位=${info2.phase} sysPaused=${info2.sysPaused} ${PLAYABLE(info2.phase) ? '✅ 正常' : '★卡死'}`);

  // ══════════════════════════════════════════════════════════
  console.log('\n══ 探针 2：开局第一回合，当前射手在不在画面里（F10）══');
  for (const vp of [{ w: 390, h: 844, t: '390×844 竖屏' }, { w: 844, h: 390, t: '844×390 横屏' },
                    { w: 1280, h: 800, t: '1280×800 桌面' }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 900 });
    let offscreen = 0, behindBar = 0, offcenter = 0;
    const samples = [];
    for (let k = 0; k < 20; k++) {
      const seed = 1000 + k * 137;
      await boot();
      await clickId('btn-duo');
      await waitFor('window.__debug.ready()', 8000);
      await ev(`(()=>{const sc=__debug.game.scene.getScene('battle'); sc.startBattle('duo','medium',${seed}); return true;})()`);
      await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 8000);
      await sleep(420);
      const r = await ev(`(() => {
        const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
        const spr=sc.heroes[s.turn], box=spr.getBounds();
        const v=cam.worldView, z=cam.zoom;
        const bar=document.getElementById('weapons').getBoundingClientRect();
        return { seed:${seed}, l:Math.round((box.left-v.x)*z), r:Math.round((box.right-v.x)*z),
                 t:Math.round((box.top-v.y)*z), b:Math.round((box.bottom-v.y)*z),
                 barTop:Math.round(bar.top), vw:innerWidth, vh:innerHeight,
                 meX:Math.round(s.players[s.turn].x), viewL:Math.round(v.x), viewR:Math.round(v.right) };
      })()`);
      const fullyVisible = r.l >= 0 && r.r <= r.vw && r.t >= 0 && r.b <= r.vh;
      if (!fullyVisible) offscreen++;
      if (r.b > r.barTop) behindBar++;
      if (Math.abs((r.l + r.r) / 2 - r.vw / 2) > 0.25 * r.vw) offcenter++;
      samples.push({ ...r, fullyVisible });
    }
    console.log(`\n  【${vp.t}】20 个种子`);
    console.log(`    射手精灵没完整进画面：${offscreen}/20　被武器栏盖住：${behindBar}/20　偏离中线>1/4屏宽：${offcenter}/20`);
    for (const r of samples.filter((x) => !x.fullyVisible).slice(0, 5)) {
      console.log(`      种子${r.seed}：精灵屏幕 x[${r.l},${r.r}] y[${r.t},${r.b}] 视口 ${r.vw}×${r.vh}`
        + `（射手世界x=${r.meX}，视野世界x[${r.viewL},${r.viewR}]）${r.l < 0 ? ' ← 在屏幕左侧之外' : ''}${r.r > r.vw ? ' → 在屏幕右侧之外' : ''}`);
    }
  }
}

let code = 0;
try { await main(); } catch (e) { console.log('❌ 探针中断: ' + e.message); code = 1; }
finally { try { ws && ws.close(); } catch {} await sleep(200); reapOne(inst); }
process.exit(code);
