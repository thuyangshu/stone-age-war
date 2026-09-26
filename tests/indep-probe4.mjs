// 定点探针 4：复核本轮两处「仅样式 / 小守卫」改动
//   A 次要按钮（button.big.ghost，底色 浅灰#9AA0A6 → 深棕#6B4530）：
//     五个视口量尺寸、算 WCAG 对比度、真点一下看是否进得了对局
//   B 人机模式越屏指示（ui.js:196 新增 !sc.isHuman() 守卫）：
//     玩家回合该指对手 → 要显示；AI 回合 1-turn 指向玩家本人 → 必须收起
//   C 本地双人回归：仍是"当前射手看对手"，行为不该变
// 用法：node tests/indep-probe4.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9200 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'stone-probe4-'));
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
async function waitFor(e, t = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await ev(`!!(${e})`)) return true; await sleep(60); }
  throw new Error('等待超时: ' + e);
}
async function clickId(id) {
  const p = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+r.height/2, w:Math.round(r.width), h:Math.round(r.height), hidden:e.hidden };})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return p;
}
// WCAG 2.1 相对亮度与对比度，在页面里算（用浏览器给出的计算样式，不是我手填的色值）
const CONTRAST = `(() => {
  const lum = (rgb) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
    return 0.2126*f(rgb[0]) + 0.7152*f(rgb[1]) + 0.0722*f(rgb[2]); };
  const parse = (s) => (s.match(/[\\d.]+/g) || []).slice(0,3).map(Number);
  return (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const cs = getComputedStyle(e), r = e.getBoundingClientRect();
    const bg = parse(cs.backgroundColor), fg = parse(cs.color);
    const L1 = lum(bg), L2 = lum(fg);
    return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, fg: cs.color,
             fontSize: cs.fontSize, ratio: (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05),
             area: Math.round(r.width*r.height) }; };
})()`;
const HINT = `(() => { const el = document.getElementById('foe'); const sc = __debug.game.scene.getScene('battle'), s = sc.s;
  const cam = sc.cameras.main, v = cam.worldView, p = s.players[1 - s.turn], me = s.players[s.turn];
  const sx = (p.x - v.x) * cam.zoom, sy = (p.y - 70 - v.y) * cam.zoom;
  return { on: !el.hidden, txt: el.textContent, turn: s.turn, phase: s.phase, mode: s.mode,
           foeOnScreen: sx > 0 && sx < innerWidth && sy > 0 && sy < innerHeight,
           shooterOnScreen: (me.x - v.x) * cam.zoom > 0 && (me.x - v.x) * cam.zoom < innerWidth,
           oneMinusTurnIs: (1 - s.turn) === 0 ? '玩家一' : '玩家二' }; })()`;

async function boot() {
  await send('Page.navigate', { url: SRC });
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
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

  // ── A. 次要按钮（.big.ghost）与主按钮的尺寸/对比度/可点性 ──
  console.log('══ A. 次要按钮「本地双人」(.big.ghost) 与主按钮「人机对战」(.big) ══');
  console.log('   开发方注释声称：浅灰底 2.4:1 → 深棕底 7.5:1，WCAG AA 门槛 4.5:1');
  for (const vp of [{ w: 390, h: 844, dsf: 3, tag: '390×844 竖屏' }, { w: 844, h: 390, dsf: 2, tag: '844×390 横屏' },
                    { w: 320, h: 568, dsf: 2, tag: '320×568 极窄' }, { w: 2560, h: 1080, dsf: 1, tag: '2560×1080 极宽' },
                    { w: 1280, h: 800, dsf: 1, tag: '1280×800 桌面' }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 });
    await boot();
    const ghost = await ev(`${CONTRAST}('#btn-duo')`);
    const main = await ev(`${CONTRAST}('#btn-solo')`);
    console.log(`  ${vp.tag}  次要 ${ghost.w}×${ghost.h} 底${ghost.bg} 字${ghost.fg} 对比度 ${ghost.ratio.toFixed(2)}:1`
      + ` ｜ 主 ${main.w}×${main.h} 底${main.bg} 对比度 ${main.ratio.toFixed(2)}:1`);
    console.log(`     触控下限 44px：次要 ${ghost.h >= 44 ? '✅' : '❌'} ｜ 主 ${main.h >= 44 ? '✅' : '❌'}`
      + ` ｜ AA 4.5:1：次要 ${ghost.ratio >= 4.5 ? '✅' : '❌'} ｜ 主 ${main.ratio >= 4.5 ? '✅' : '❌'}`);
  }
  // 真点一下：次要按钮点得动、进得了对局
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await boot();
  const clicked = await clickId('btn-duo');
  let ok = false;
  try { await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000); ok = true; } catch {}
  console.log(`  点击「本地双人」${clicked.w}×${clicked.h} → ${ok ? '✅ 进入对局（phase=aim）' : '❌ 没进对局'}`);

  // ── B. 人机模式越屏指示：玩家回合要指对手，AI 回合必须收起 ──
  console.log('\n══ B. 人机模式越屏指示（ui.js 新增 !sc.isHuman() 守卫）══');
  await boot();
  await clickId('btn-solo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await ev(`__debug.setThinkMs(6000);`);          // 把 AI 的思考时间拉长，好观察它那一回合的画面
  await sleep(500);
  const humanTurn = await ev(HINT);
  console.log(`  玩家回合：turn=${humanTurn.turn} phase=${humanTurn.phase} 指示 ${humanTurn.on ? '显示' : '收起'}`
    + ` 文案"${humanTurn.txt}"　对手在屏内=${humanTurn.foeOnScreen}`
    + `　${humanTurn.on ? '✅ 该显示时显示' : '★ 该显示时收起（玩家看不到对手在哪）'}`);
  // 换到 AI 回合：真打一发，等回合交出去（把过程打出来，卡住时能看出卡在哪一步）
  await ev(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.fire(0.9, 1); return true; })()`);
  const trail = [];
  for (let i = 0; i < 40; i++) {
    const st = await ev(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      return { turn:s.turn, phase:s.phase, shots:s.players.map(p=>p.shots), proj: s.proj ? '在飞' : '无',
               thinkMs: s.thinkMs, paused: sc.sys.isPaused() }; })()`);
    trail.push(`${i * 250}ms:${st.phase}/turn=${st.turn}/shots=${st.shots.join(',')}/${st.proj}/think=${st.thinkMs}`);
    if (st.turn === 1 && (st.phase === 'think' || st.phase === 'aim')) break;
    await sleep(250);
  }
  console.log('  出手后时间线：' + trail.slice(0, 14).join(' | '));
  // AI 回合的状态机走的是 'think'（不是 'aim'），等它进入思考即可
  await waitFor(`__debug.state().turn === 1 && ["think","aim"].includes(__debug.state().phase)`, 6000);
  const aiTurn = await ev(HINT);
  console.log(`  AI 回合：turn=${aiTurn.turn} phase=${aiTurn.phase} 指示 ${aiTurn.on ? '显示' : '收起'}`
    + ` 文案"${aiTurn.txt}"　对手在屏内=${aiTurn.foeOnScreen}　`
    + `（此时 1-turn=${aiTurn.oneMinusTurnIs}＝玩家自己，旧逻辑会指向玩家本人）`);
  console.log(`  ${!aiTurn.on ? '✅ AI 回合指示收起（新守卫生效）' : '★ AI 回合仍在显示指示'}` +
    `；此刻玩家角色在屏内=${aiTurn.shooterOnScreen}`);
  await ev(`__debug.setThinkMs(1);`);
  await waitFor(`__debug.state().turn === 0 && __debug.state().phase === 'aim'`, 20000);
  await sleep(300);
  const back = await ev(HINT);
  console.log(`  轮回玩家回合：指示 ${back.on ? '显示' : '收起'} 文案"${back.txt}" 对手在屏内=${back.foeOnScreen}`
    + `　${back.foeOnScreen ? '（对手本来就在屏内，收起是对的）' : back.on ? '✅ 恢复显示' : '★ 该显示却收起了'}`);

  // ── C. 本地双人回归：仍是"当前射手看对手" ──
  console.log('\n══ C. 本地双人模式回归（isHuman() 恒 true，行为不该变）══');
  await boot();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready()', 6000);
  await ev(`(() => { const sc=__debug.game.scene.getScene('battle');
    sc.startBattle('duo','medium',50500);
    return true; })()`);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await ev(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
    s.players[1].x = 1500; sc.cameras.main.centerOn(s.players[0].x, s.players[0].y); return true; })()`);
  await sleep(420);
  const duo = await ev(HINT);
  console.log(`  玩家一回合：指示 ${duo.on ? '显示' : '收起'} 文案"${duo.txt}" 对手在屏内=${duo.foeOnScreen}`
    + `　${duo.on && /玩家二/.test(duo.txt) ? '✅ 正常指向玩家二' : '★ 与改动前不一致'}`);
}
let code = 0;
try { await main(); } catch (e) { console.log('❌ 探针中断: ' + e.message); code = 1; }
finally { try { ws && ws.close(); } catch {} await sleep(200); reapOne(inst); }
process.exit(code);
