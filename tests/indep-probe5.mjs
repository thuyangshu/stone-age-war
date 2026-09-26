// 独立测试员探针 5：定位「indep-browser.mjs 两次跑都挂死在 CDP 上」的真因。
// 现象：跑完一批 setDeviceMetricsOverride + Page.navigate 之后，某条 CDP 请求永远不回，
//       看门狗按「300 秒无推进」收尸退出 124。两次分别挂在 V→C 交界、C 组第二个视口之后。
// 本探针要回答的唯一问题：**卡住的是页面（产品 JS）还是浏览器/我这边的 ws**。
// 做法：给每条 CDP 请求加自己的超时；超时那一刻分别探（a）浏览器进程还答不答话
//       （browser 端点 Target.getTargets），（b）页面渲染进程还答不答话（attach 后 Runtime.evaluate），
//       （c）该实例各进程的 RSS 与 CPU。
// 用法：node tests/indep-probe5.mjs [--no-v]   （只读产品代码，不改任何源文件）
import { spawn, execSync } from 'node:child_process';
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
const WITH_V = !process.argv.includes('--no-v');

const profile = mkdtempSync(join(tmpdir(), 'stone-probe5-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
  '--autoplay-policy=no-user-gesture-required', ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});
// 本探针不用 reaper 的看门狗：自己按请求计时，超时即刻出诊断后退出。
let ws, seq = 0, lastOp = '(未开始)';
const pending = new Map();
const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(el(), ...a);

function rawSend(sock, method, params = {}) {
  const id = ++seq;
  sock.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function send(method, params = {}, ms = 20000) {
  return Promise.race([
    rawSend(ws, method, params),
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('CDP 超时'), { cdpTimeout: true })), ms)),
  ]);
}
async function evaluate(expr, ms = 20000) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms);
  return r.result && r.result.value;
}
async function waitFor(expr, timeout = 8000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await evaluate(`!!(${expr})`)) return true;
    await sleep(80);
  }
  throw new Error(`等待超时: ${expr}`);
}

// —— 挂死现场诊断：浏览器进程 / 渲染进程 / 内存 ——
async function diagnose() {
  console.error(`\n===== 卡死在：${lastOp} =====`);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    console.error('浏览器 /json/list 还答话，页面目标:', list.filter((t) => t.type === 'page').map((t) => `${t.url} (${t.id})`).join(', ') || '(无)');
  } catch (e) { console.error('浏览器 /json/list 不答话:', e.message); }
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    await Promise.race([new Promise((r, j) => { bws.onopen = r; bws.onerror = j; }), sleep(8000).then(() => { throw new Error('浏览器端点连不上'); })]);
    const bsock = { send: (s) => bws.send(s) };
    const bid = ++seq;
    const bp = new Promise((res, rej) => pending.set(bid, { resolve: res, reject: rej }));
    bsock.send(JSON.stringify({ id: bid, method: 'Target.getTargets' }));
    const bt = await Promise.race([bp, sleep(8000).then(() => '超时')]);
    console.error('浏览器端点 Target.getTargets:', bt === '超时' ? '8 秒无回包（浏览器进程也卡了）' : JSON.stringify(bt).slice(0, 200));
    // 挂到页面上直接问一句，看渲染进程主线程是否被占死
    const b2 = ++seq;
    const p2 = new Promise((res) => pending.set(b2, { resolve: res, reject: () => {} }));
    bsock.send(JSON.stringify({ id: b2, method: 'Target.getTargets' }));
    const targets = await Promise.race([p2, sleep(8000).then(() => null)]);
    const page = targets && targets.targetInfos && targets.targetInfos.find((t) => t.type === 'page');
    try { bws.close(); } catch {}
    if (page) {
      const t = await Promise.race([
        fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()),
        sleep(5000).then(() => null),
      ]);
      console.error('页面目标仍在列表里:', !!t);
    }
  } catch (e) { console.error('浏览器端点诊断失败:', e.message); }
  try {
    const ps = execSync(`ps -eo pid,ppid,rss,pcpu,stat,command | grep -F '${profile}' | grep -v grep`).toString().trim();
    const lines = ps.split('\n').map((l) => l.replace(/\s+/g, ' ').slice(0, 150));
    console.error(`本实例进程（${lines.length} 个，RSS 单位 KB）:\n  ` + lines.join('\n  '));
  } catch { console.error('ps 取不到该实例进程'); }
  try { reapOne(inst); } catch {}
  process.exit(9);
}

async function step(name, fn) { lastOp = name; log('→', name); return fn(); }
async function guard(p) { try { return await p; } catch (e) { if (e.cdpTimeout) await diagnose(); throw e; } }

async function clickId(id) {
  const p = await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)});
    if(!e) return null; const r=e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
  if (!p) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return true;
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
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
  await guard(send('Runtime.enable'));
  await guard(send('Page.enable'));

  const VPS = [{ w: 390, h: 844, dsf: 3 }, { w: 844, h: 390, dsf: 2 }, { w: 320, h: 568, dsf: 2 },
               { w: 2560, h: 1080, dsf: 1 }, { w: 1280, h: 800, dsf: 1 }];
  if (WITH_V) {
    log('V 组（只做同样的 CDP 动作，不做断言）');
    for (let i = 0; i < VPS.length; i++) {
      const vp = VPS[i];
      await guard(send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 }));
      await guard(step(`V#${i} nav`, () => send('Page.navigate', { url: SRC })));
      await guard(step(`V#${i} boot`, () => waitFor('window.__debug && window.__debug.game.isBooted', 9000)));
      await guard(step(`V#${i} 开双人局`, () => clickId('btn-duo')));
      await guard(step(`V#${i} 等 aim`, () => waitFor('window.__debug.state() && __debug.state().phase === "aim"', 8000)));
      for (let k = 0; k < 8; k++) await guard(step(`V#${i} 点第${k + 1}格`, () => evaluate(`document.getElementById('weapons').getBoundingClientRect().height`)));
    }
  }
  log('C 组（3 个视口 × 12 个种子，与 indep-browser 的 C 组同构）');
  for (const vp of [{ w: 390, h: 844, dsf: 3, tag: '竖屏' }, { w: 844, h: 390, dsf: 2, tag: '横屏' }, { w: 1280, h: 800, dsf: 1, tag: '桌面' }]) {
    await guard(send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 }));
    log(`C[${vp.tag}] 起`);
    for (let k = 0; k < 12; k++) {
      const seed = 1000 + k * 137;
      await guard(step(`C[${vp.tag}] 种子${seed} nav`, () => send('Page.navigate', { url: SRC })));
      await guard(step(`C[${vp.tag}] 种子${seed} boot`, () => waitFor('window.__debug && window.__debug.game.isBooted', 9000)));
      await guard(step(`C[${vp.tag}] 种子${seed} 开双人局`, () => clickId('btn-duo')));
      await guard(step(`C[${vp.tag}] 种子${seed} 起局`, () => evaluate(`(() => { __debug.game.scene.getScene('battle').startBattle('duo','medium',${seed}); return true; })()`)));
      await guard(step(`C[${vp.tag}] 种子${seed} 等 aim`, () => waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 8000)));
      await sleep(420);
      const r = await guard(step(`C[${vp.tag}] 种子${seed} 取景读数`, () => evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
        const box=sc.heroes[s.turn].getBounds(), v=cam.worldView, z=cam.zoom;
        return { l:Math.round((box.left-v.x)*z), r:Math.round((box.right-v.x)*z), t:Math.round((box.top-v.y)*z), b:Math.round((box.bottom-v.y)*z), vw:innerWidth, vh:innerHeight }; })()`)));
      log(`C[${vp.tag}] 种子${seed}`, JSON.stringify(r));
    }
  }
  log('跑完，没挂。');
  try { ws.close(); } catch {}
  await sleep(300); reapOne(inst);
  process.exit(0);
}
main().catch(async (e) => { console.error('探针异常:', e.message); try { reapOne(inst); } catch {} process.exit(1); });
