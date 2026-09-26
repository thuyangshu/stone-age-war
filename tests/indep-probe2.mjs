// 定点探针 2：把三个疑似问题逐步打印，钉死到具体行
//   P1 结算停留期内「暂停→重开」，上一局的 nextTurn 定时器会不会作用到新一局（game.js:411）
//   P2 击杀后立刻「暂停→重开」，上一局的 endGame/showOver 会不会作用到新一局（game.js:410/521）
//   P3 拖拽瞄准中途松手落在 DOM 按钮上，会不会照样把这发打出去（game.js:14 pointerupoutside）
// 用法：node tests/indep-probe2.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9700 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'stone-probe2-'));
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
  while (Date.now() - t0 < t) { if (await ev(`!!(${e})`)) return true; await sleep(80); }
  throw new Error('等待超时: ' + e);
}
async function clickId(id) {
  const p = await ev(`(()=>{const e=document.getElementById('${id}');const r=e.getBoundingClientRect();
    return { x:r.x+r.width/2, y:r.y+r.height/2, hidden:e.hidden, w:Math.round(r.width), h:Math.round(r.height) };})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return p;
}
const SNAP = `(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
  return { turn:s&&s.turn, phase:s&&s.phase, hp:s?s.players.map(p=>p.hp):null, shots:s?s.players.map(p=>p.shots):null,
           winner:s&&s.winner, sysPaused:sc.sys.isPaused(), uiPaused:UI.isPaused(),
           pausePanel:!document.getElementById('pause').hidden, over:!document.getElementById('over').hidden,
           handoff:!document.getElementById('handoff').hidden, timers:sc.time.getActiveEvents ? sc.time.getActiveEvents().length : -1 }; })()`;
const AIM_HIT = `window.__aimHit = (wpId) => {
  const sc = __debug.game.scene.getScene('battle'), s = sc.s;
  if (!s || s.phase !== 'aim' || s.winner !== null) return 'not-aim';
  const me = s.players[s.turn], foe = s.players[1 - s.turn];
  const wp = DATA.WEAPONS.find(w => w.id === (wpId || s.weapon)) || DATA.WEAPONS[0];
  const g = DATA.PHYS.G * (wp.gMul || 1);
  const sol = LOGIC.solveShot(wp.v, g, foe.x - me.x, (foe.y - 30) - (me.y - 34));
  if (!sol) return 'no-solution';
  for (const arc of [sol.low, sol.high]) {
    if (arc == null) continue;
    const p = LOGIC.makeProjectile(wp, me.x, me.y - 34, arc, 1);
    p.owner = s.turn;
    const r = LOGIC.simulate(s.world, p, { wind: 0 }, { players: s.players, sampleEvery: 8 });
    const first = r.events[0];
    if (first && first.type === 'direct' && first.who === 1 - s.turn) { sc.fire(arc, 1); return 'fired'; }
  }
  return 'blocked';
};`;

async function boot() {
  await send('Page.navigate', { url: SRC });
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
  await ev(`window.__errs=[]; window.addEventListener('error',e=>__errs.push(String(e.message)));
    window.addEventListener('unhandledrejection',e=>__errs.push('rej:'+e.reason));`);
  await ev(AIM_HIT);
}
async function enterDuo(seed) {
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 9000);
  await ev(`__debug.game.scene.getScene('battle').startBattle('duo','medium',${seed})`);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 9000);
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
  console.log('（本次探针不改任何时长参数，全部用游戏默认值：IMPACT_HOLD=900ms，击杀后 620ms 结算、再 560ms 弹窗）');

  // ── P1 结算停留期内重开 ──
  console.log('\n══ P1 结算停留期内「暂停 → 重开一局」（两次点击间隔约 60ms，人手可达）══');
  for (let k = 0; k < 2; k++) {
    await boot(); await enterDuo(30300 + k);
    await ev(`(()=>{const sc=__debug.game.scene.getScene('battle'); sc.fire(0.9,1); return true;})()`);
    await waitFor(`__debug.state().phase === 'impact'`, 9000);
    console.log(`  第${k + 1}轮 · 命中落地时：${JSON.stringify(await ev(SNAP))}`);
    const pb = await clickId('btn-pause'); await sleep(60);
    const rb = await clickId('btn-restart');
    console.log(`  暂停按钮 ${pb.w}×${pb.h} hidden=${pb.hidden} / 重开按钮 ${rb.w}×${rb.h} hidden=${rb.hidden}`);
    console.log(`  重开瞬间：${JSON.stringify(await ev(SNAP))}`);
    await sleep(700);
    console.log(`  +0.7s ：${JSON.stringify(await ev(SNAP))}`);
    await sleep(1200);
    const end = await ev(SNAP);
    console.log(`  +1.9s ：${JSON.stringify(end)}  ${end.turn === 0 && end.shots[0] === 0 && !end.handoff ? '✅ 新一局未被推进' : '★ 新一局被上一局的定时器推进了'}`);
  }

  // ── P2 击杀后立刻重开 ──
  console.log('\n══ P2 击杀后立刻「暂停 → 重开一局」（死亡结算窗口内）══');
  for (let k = 0; k < 2; k++) {
    await boot(); await enterDuo(40400 + k);
    await ev('__debug.setHp(1, 5);');
    const f = await ev('__aimHit()');
    console.log(`  第${k + 1}轮 · 必中一击：${f}`);
    await waitFor(`__debug.state().phase === 'impact'`, 9000);
    console.log(`  命中落地时：${JSON.stringify(await ev(SNAP))}`);
    await clickId('btn-pause'); await sleep(60);
    await clickId('btn-restart');
    console.log(`  重开瞬间：${JSON.stringify(await ev(SNAP))}`);
    await sleep(800);
    console.log(`  +0.8s ：${JSON.stringify(await ev(SNAP))}`);
    await sleep(900);
    const end = await ev(SNAP);
    console.log(`  +1.7s ：${JSON.stringify(end)}`);
    // 满血值从页面读，不写死 100：后手有贴目（KOMI），双方满血不再相等
    const full = await ev('[DATA.HP, DATA.HP + DATA.KOMI].join("/")');
    console.log(`  ${end.winner === null && !end.over && end.hp.join('/') === full
      ? `✅ 新一局干净（满血 ${full}）`
      : `★ 新一局被上一局的结算回调污染（hp=${end.hp.join('/')} 期望 ${full}）`}`);
  }

  // ── P3 拖拽中松手落在按钮上 ──
  console.log('\n══ P3 拖拽瞄准中途松手落在 DOM 按钮上（pointerupoutside）══');
  for (const [tag, target] of [['落在画布内（对照）', null], ['落在「暂停」按钮上', '#btn-pause'],
                              ['落在顶部血条上', '#p0card'], ['落在底部武器栏第 4 格上', '#weapons .wslot:nth-child(4)']]) {
    await boot(); await enterDuo(50500);
    if (target && target.includes('wslot')) {
      await ev(`(()=>{const b=document.getElementById('weapons'); const el=b.querySelectorAll('.wslot')[3];
        b.scrollTo({left: Math.max(0, el.offsetLeft-(b.clientWidth-el.offsetWidth)/2), behavior:'instant'}); return true;})()`);
      await sleep(120);
    }
    const before = (await ev(SNAP)).shots[0];
    const wpBefore = (await ev(SNAP)).turn === null ? null : await ev(`__debug.state().weapon`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 500, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300 - i * 14, y: 500 + i * 8, button: 'left' });
      await sleep(18);
    }
    const dragging = await ev(`(()=>{const s=__debug.game.scene.getScene('battle').s; return { dragging:s.dragging, power:s.aim&&s.aim.power };})()`);
    let rel;
    if (target) { rel = await ev(`(()=>{const r=document.querySelector(${JSON.stringify(target)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); }
    else { rel = { x: 216, y: 548 }; }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rel.x, y: rel.y, button: 'left', clickCount: 1 });
    await sleep(400);
    const after = await ev(SNAP);
    // 打出去的到底是不是当时选中的那件武器
    const flew = await ev(`(()=>{const s=__debug.game.scene.getScene('battle').s;
      return { ammo: s.players[0].ammo, now: s.weapon && s.weapon.id };})()`);
    console.log(`  ${tag}：松手前 dragging=${dragging.dragging} 力度=${dragging.power && dragging.power.toFixed(2)}`
      + ` → 出手数 ${before} → ${after.shots[0]}，phase=${after.phase}`
      + `　${after.shots[0] > before ? '★ 照样打出去了' : '✅ 没出手'}`
      + `　松手时选中武器=${wpBefore} → 之后=${flew.now}，暂停面板=${after.pausePanel} uiPaused=${after.uiPaused}`);
  }

  // ── P4 拖拽中按 Esc 暂停（鼠标仍按着）→ 松开 → 恢复，这一发会不会自己跑出去 ──
  console.log('\n══ P4 拖拽中按 Esc 暂停，松手后再恢复 ══');
  {
    await boot(); await enterDuo(60600);
    const before = (await ev(SNAP)).shots[0];
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 500, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300 - i * 14, y: 500 + i * 8, button: 'left' });
      await sleep(18);
    }
    const d0 = await ev(`(()=>{const s=__debug.game.scene.getScene('battle').s; return {dragging:s.dragging,power:s.aim&&s.aim.power};})()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(200);
    const pausedSnap = await ev(SNAP);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 216, y: 548, button: 'left', clickCount: 1 });
    await sleep(250);
    const afterRelease = await ev(SNAP);
    await ev(`document.getElementById('btn-resume').click()`);
    await sleep(600);
    const afterResume = await ev(SNAP);
    console.log(`  拖拽中 dragging=${d0.dragging} 力度=${d0.power && d0.power.toFixed(2)}；Esc 后 uiPaused=${pausedSnap.uiPaused}`);
    console.log(`  松手后 shots ${before} → ${afterRelease.shots[0]}（phase=${afterRelease.phase}）→ 恢复后 shots=${afterResume.shots[0]} phase=${afterResume.phase}`
      + `　${afterRelease.shots[0] > before || afterResume.shots[0] > before ? '★ 暂停没能取消这一发' : '✅ 暂停取消了这一发，恢复后不会自己飞出去'}`);
  }

  // ── P5 「对手在视野内时越屏指示该收起」：开发方冒烟 S10 挂了，查是产品问题还是用例竞态 ──
  console.log('\n══ P5 对手在视野内时越屏指示是否收起 ══');
  {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    const FOE = `(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      const el=document.getElementById('foe');
      return { on: !el.hidden, txt: el.textContent, phase: s.phase, turn: s.turn,
               pan: sc.cameras.main.panEffect.isRunning,
               camX: Math.round(sc.cameras.main.worldView.x) }; })()`;
    // 甲：等镜头平移停下再 centerOn（慢操作）
    await boot();
    for (let i = 0; i < 3; i++) {
      const r = await clickId('btn-duo');
      try { await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000); break; }
      catch (e) {
        console.log(`  进入双人模式第 ${i + 1} 次没成：按钮 ${r.w}×${r.h} hidden=${r.hidden}，`
          + `当前 ready=${await ev('window.__debug.ready()')} phase=${await ev('window.__debug.state() && __debug.state().phase')}`
          + ` 场景暂停=${await ev(`__debug.game.scene.getScene('battle').sys.isPaused()`)}`
          + ` 页面异常=${JSON.stringify(await ev('window.__errs||[]'))}`);
        if (i === 2) throw e;
        await sleep(500);
      }
    }
    await ev(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.s.players[1].x = 1500; return true; })()`);
    await sleep(300);
    console.log(`  对手放到 x=1500（越屏）：${JSON.stringify(await ev(FOE))}`);
    for (let i = 0; i < 40; i++) { if (!(await ev(`__debug.game.scene.getScene('battle').cameras.main.panEffect.isRunning`))) break; await sleep(120); }
    await ev(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      sc.cameras.main.centerOn(s.players[1].x, s.players[1].y); return true; })()`);
    await sleep(320);
    const slow = await ev(FOE);
    console.log(`  甲·等平移停下再 centerOn：${JSON.stringify(slow)}　${slow.on ? '★ 指示没收起（产品问题）' : '✅ 指示收起'}`);
    // 乙：贴着一次回合平移马上 centerOn（模拟冒烟 S10 的时机）
    await boot(); await enterDuo(70701);
    await ev(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.s.players[1].x = 1500; return true; })()`);
    await sleep(60);
    const midPan = await ev(FOE);
    await ev(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      sc.cameras.main.centerOn(s.players[1].x, s.players[1].y); return true; })()`);
    await sleep(180);
    const fast = await ev(FOE);
    console.log(`  乙·平移进行中就 centerOn（pan=${midPan.pan}）：${JSON.stringify(fast)}　${fast.on ? '★ 指示没收起（产品问题）' : '✅ 指示收起'}`);
    console.log(`  → ${slow.on && !fast.on ? '结论：慢操作正常、快操作被平移吃掉 —— 是用例竞态，不是产品缺陷' : slow.on ? '结论：产品确实不收指示' : '结论：两种时机都正常，冒烟那条是偶发'}`);
  }
}

let code = 0;
try { await main(); } catch (e) { console.log('❌ 探针中断: ' + e.message); code = 1; }
finally { try { ws && ws.close(); } catch {} await sleep(200); reapOne(inst); }
process.exit(code);
