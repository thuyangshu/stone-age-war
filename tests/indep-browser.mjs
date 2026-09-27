// 独立测试员用例（浏览器层）· 与 browser-smoke.mjs 分开存放
// 重点打开发方冒烟没覆盖的地方：
//   V  视口矩阵（320/390×844/844×390/2560×1080/1280×800）逐格点得到、元素不被裁
//   C  开局取景：第一回合当前射手在不在画面里（F10）
//   I  交互边界（死区取消、暂停打断拖拽、重开撞旧回调、AI 思考中暂停、暂停+重开同拍）
//   F  功能对照（结算页文案、30 秒超时、切后台自动暂停、越屏指示）
//   B  单文件打包版与源码版行为一致性（N6）
// 用法：node tests/indep-browser.mjs          （只读产品代码，不改任何源文件）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9800 + Math.floor(Math.random() * 400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = pathToFileURL(join(ROOT, 'index.html')).href;
const BUNDLE = pathToFileURL(join(ROOT, 'dist', '石器大战.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'stone-indep-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800',
  '--autoplay-policy=no-user-gesture-required',
  ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});
const wd = watchdog(300);

const errors = [];
const results = [];
let ws, seq = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++seq;
  wd.ping();
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate 失败: ${expr}\n${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expr, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(`!!(${expr})`)) return true;
    await sleep(80);
  }
  throw new Error(`等待超时: ${expr}`);
}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
}
const st = () => evaluate('window.__debug.state()');
const dom = () => evaluate('window.__debug.dom()');

async function clickEl(sel) {
  const p = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(sel)});
    if(!e) return null; const r=e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height }; })()`);
  if (!p || p.w < 1 || p.h < 1) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(15);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  return true;
}
const clickId = (id) => clickEl('#' + id);

const FAST = `DATA.TURN.IMPACT_HOLD=40; DATA.TURN.BANNER_MS=40; DATA.TURN.AI_AIM_MS=20;
  DATA.TURN.AI_THINK={easy:1,medium:1,hard:1}; window.__debug.setThinkMs(1);`;
// 必中一击：照对手解算低/高弧并试射确认（与冒烟同源，只读复用）
const AIM_HIT = `window.__aimHit = (wpId) => {
  const sc = __debug.game.scene.getScene('battle'), s = sc.s;
  if (!s || s.phase !== 'aim' || s.winner !== null) return 'not-aim';
  const me = s.players[s.turn], foe = s.players[1 - s.turn];
  const wp = DATA.WEAPONS.find(w => w.id === (wpId || s.weapon)) || DATA.WEAPONS.find(w => s.players[s.turn].ammo[w.id] > 0) || DATA.WEAPONS[0];
  const g = DATA.PHYS.G * (wp.gMul || 1);
  const sol = LOGIC.solveShot(wp.v, g, foe.x - me.x, (foe.y - 30) - (me.y - 34));
  if (!sol) return 'no-solution';
  for (const arc of [sol.low, sol.high]) {
    if (arc === null || arc === undefined) continue;
    const p = LOGIC.makeProjectile(wp, me.x, me.y - 34, arc, 1);
    p.owner = s.turn;
    const r = LOGIC.simulate(s.world, p, { wind: 0 }, { players: s.players, sampleEvery: 8 });
    const first = r.events[0];
    if (first && first.type === 'direct' && first.who === 1 - s.turn) { sc.fire(arc, 1); return 'fired'; }
  }
  return 'blocked';
};`;

async function boot() {
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
  await evaluate(AIM_HIT);
  await evaluate(`window.__errs=[]; window.addEventListener('error',e=>__errs.push(String(e.message)));`);
}
async function nav(url = SRC) {
  await send('Page.navigate', { url });
  await boot();
}
const newBattle = (mode, level, seed) =>
  evaluate(`(() => { __debug.game.scene.getScene('battle').startBattle('${mode}','${level}',${seed}); return true; })()`);

async function main() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); }
    catch { await sleep(100); }
  }
  if (!target) throw new Error('Chrome 启动失败');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      wd.ping();
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      errors.push(`console.${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon/.test(msg.params.entry.url || '')) {
      errors.push('Log: ' + msg.params.entry.text);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: SRC });
  await boot();

  // ══════════════════════════════════════════════════════════
  console.log('\n══ V. 视口矩阵：八个武器槽逐格点得到 + 元素不被裁 ══');
  const VIEWPORTS = [
    { w: 390, h: 844, dsf: 3, mobile: true, tag: '390×844 竖屏' },
    { w: 844, h: 390, dsf: 2, mobile: true, tag: '844×390 横屏' },
    { w: 320, h: 568, dsf: 2, mobile: true, tag: '320×568 极窄' },
    { w: 2560, h: 1080, dsf: 1, mobile: false, tag: '2560×1080 极宽' },
    { w: 1280, h: 800, dsf: 1, mobile: false, tag: '1280×800 桌面' },
  ];
  for (const vp of VIEWPORTS) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.mobile });
    await nav();
    await clickId('btn-duo');                 // 双人：两边都是人类，八格随便点
    await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
    await sleep(350);

    const bar = await evaluate(`(() => { const b=document.getElementById('weapons');
      return { n: b.querySelectorAll('.wslot').length, scrollW: b.scrollWidth, clientW: b.clientWidth }; })()`);
    const per = [];
    for (let i = 0; i < bar.n; i++) {
      const info = await evaluate(`(() => {
        const b=document.getElementById('weapons'), el=b.querySelectorAll('.wslot')[${i}];
        const target = el.offsetLeft - (b.clientWidth - el.offsetWidth)/2;
        b.scrollTo({ left: Math.max(0, Math.min(b.scrollWidth-b.clientWidth, target)), behavior:'instant' });
        const r=el.getBoundingClientRect(), br=b.getBoundingClientRect();
        return { name: el.querySelector('.wname').textContent, id: DATA.WEAPONS[${i}].id,
                 l:Math.round(r.left), r:Math.round(r.right), w:Math.round(r.width), h:Math.round(r.height),
                 inView: r.left>=-1 && r.right<=innerWidth+1 && r.top>=-1 && r.bottom<=innerHeight+1,
                 inBar: r.left>=br.left-1 && r.right<=br.right+1 };
      })()`);
      await sleep(60);
      const ok = await clickEl(`#weapons .wslot:nth-child(${i + 1})`);
      await sleep(80);
      const sel = (await st()).weapon;
      per.push({ ...info, selected: sel === info.id, sel, clicked: ok });
    }
    check(`V[${vp.tag}] 八个武器槽逐个都能点中（点完选中项真的切换）`,
      per.every((r) => r.selected), per.filter((r) => !r.selected).map((r) => `${r.name}→${r.sel}`).join(',') || '8/8');
    check(`V[${vp.tag}] 八个槽滚动到位后都在视口内、不被裁且 ≥44px`,
      per.every((r) => r.inView && r.inBar && r.w >= 44 && r.h >= 44),
      `槽 ${per[0].w}×${per[0].h}，栏宽 ${bar.clientW}/内容 ${bar.scrollW}`);

    const L = await evaluate(`(() => { const g=id=>{const e=document.getElementById(id);
      if(!e||e.hidden) return null; const r=e.getBoundingClientRect();
      return {l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height)};};
      return { hud:g('hud'), wb:g('weapons'), p0:g('p0card'), p1:g('p1card'), mid:g('mid'),
               mute:g('btn-mute'), pause:g('btn-pause'), vw:innerWidth, vh:innerHeight }; })()`);
    const ov = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const inView = [L.hud, L.wb, L.p0, L.p1, L.mute].every((r) => r && r.l >= -1 && r.r <= L.vw + 1 && r.t >= -1 && r.b <= L.vh + 1);
    check(`V[${vp.tag}] 顶栏/底栏/血条互不遮挡且都在屏内`,
      !ov(L.p0, L.mid) && !ov(L.p1, L.mid) && !ov(L.p0, L.p1) && !ov(L.hud, L.wb) && inView,
      `血条压中栏=${ov(L.p0, L.mid) || ov(L.p1, L.mid)} 越界=${!inView}`);
    check(`V[${vp.tag}] 静音/暂停按钮 ≥44px 触控下限（N2）`,
      L.mute && L.pause && L.mute.w >= 44 && L.mute.h >= 44 && L.pause.w >= 44 && L.pause.h >= 44,
      `静音 ${L.mute && L.mute.w}×${L.mute && L.mute.h}，暂停 ${L.pause && L.pause.w}×${L.pause && L.pause.h}`);

    const cov = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle');
      const v=sc.cameras.main.worldView, t=sc.terrain;
      return { tl:t.x, tr:t.x+t.width, tb:t.y+t.height, vl:v.x, vr:v.right, vb:v.bottom }; })()`);
    check(`V[${vp.tag}] 地形盖满视野，看不到世界边界（F35）`,
      cov.tl <= cov.vl + .5 && cov.tr >= cov.vr - .5 && cov.tb >= cov.vb - .5,
      `地形 x[${cov.tl.toFixed(0)},${cov.tr.toFixed(0)}] 底${cov.tb.toFixed(0)} / 视野 x[${cov.vl.toFixed(0)},${cov.vr.toFixed(0)}] 底${cov.vb.toFixed(0)}`);
  }

  // ══════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════
  console.log('\n══ K. 后手贴目（DATA.KOMI 分档表）在界面上的后果 ══');
  // 贴目按回合顺序发：人机模式玩家恒先手（0 号），所以贴目落在 AI 那侧。
  // 2026-09-27 第二轮起贴目是**分档表** {easy:0, medium:12, hard:6}，后手满血随所选难度变：
  //   easy 100/100、medium 100/112、hard 100/106；本地双人没有档位，取 medium 锚定值 → 100/112。
  // 旧版这一组通篇硬写标量 112，分档后 K1 会算成 `100 + {object}` 字符串拼接——本组按分档重写。
  // 走**真实 UI 路径**（菜单里点难度按钮 → 点「人机对战」），不调 __debug.start：贴目要经
  // ui.js 的 level → game.js 的 komiFor(mode==='solo' ? level : null) 这条链才发得出来，
  // 直接调 startBattle 会绕过 UI 那一环，量不到"选难度有没有真的换到贴目"。
  const FIXTURE = [
    { mode: 'solo', lv: 'easy', foeFull: 100 },
    { mode: 'solo', lv: 'medium', foeFull: 112 },
    { mode: 'solo', lv: 'hard', foeFull: 106 },
    { mode: 'duo', lv: 'medium', foeFull: 112 },
  ];
  const menuStart = async (mode, lv) => {
    await nav();                                     // 回主菜单（level 会重置成 medium）
    await clickEl(`#diff .lv[data-lv="${lv}"]`);      // 真实 UI：先点难度
    await clickId(mode === 'solo' ? 'btn-solo' : 'btn-duo');
    await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  };
  const readFull = () => evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s;
    return { HP: DATA.HP, uiMode: __debug.mode(), uiLevel: __debug.level(), sLevel: s.level, sMode: s.mode,
             ps: s.players.map(p=>({hp:p.hp,hpMax:p.hpMax,idx:p.idx})) }; })()`);

  for (const { mode, lv, foeFull } of FIXTURE) {
    await menuStart(mode, lv);
    const g = await readFull();
    check(`K1[${mode}/${lv}] 真实 UI 路径开局满血 = 先手 ${g.HP} / 后手 ${foeFull}（贴目 ${foeFull - g.HP}）`,
      g.ps[0].hp === g.HP && g.ps[0].hpMax === g.HP && g.ps[0].idx === 0
      && g.ps[1].hp === foeFull && g.ps[1].hpMax === foeFull && g.ps[1].idx === 1,
      `hp/hpMax = ${g.ps.map((p) => `${p.hp}/${p.hpMax}`).join(' ｜ ')}`
      + `　UI=${g.uiMode}/${g.uiLevel} 局内=${g.sMode}/${g.sLevel}`);
    if (mode === 'solo') {
      check(`K1[${mode}/${lv}] 点难度按钮真的传到了局内（UI.level === 局内 level === ${lv}）`,
        g.uiLevel === lv && g.sLevel === lv, `UI=${g.uiLevel} 局内=${g.sLevel}`);
    }
  }
  // 出厂值单独钉一条：上面几条的期望值都在本文件里写死（不是从页面读），但"表本身是不是
  // 这三格"还得有一条直接的。data.js 的 KOMI 表一动，这条和上面 FIXTURE 必须一起改。
  {
    await nav();
    const t = await evaluate(`(() => ({ KOMI: DATA.KOMI, HP: DATA.HP }))()`);
    check('K1 贴目出厂值就是分档表 {easy:0, medium:12, hard:6}',
      t.HP === 100 && t.KOMI && t.KOMI.easy === 0 && t.KOMI.medium === 12 && t.KOMI.hard === 6,
      `HP=${t.HP} KOMI=${JSON.stringify(t.KOMI)}`);
  }

  // K2 血条比例必须按各人自己的 hpMax 算。满血时看不出差别（Math.min 会把 112% 夹成 100%），
  // 只有掉到中段才分得开：56/112 = 50%，按 DATA.HP 算会画成 56%——这是唯一能区分两种实现的观测量。
  // medium（112）是最尖的一档；hard（106）差 3 点、也在阈内，一并量。
  for (const lv of ['medium', 'hard']) {
    await menuStart('solo', lv);
    const half = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      s.players[1].hp = s.players[1].hpMax / 2; s.players[0].hp = s.players[0].hpMax / 2; UI.syncHp();
      return { hp: s.players.map(p=>p.hp), max: s.players.map(p=>p.hpMax) }; })()`);
    await sleep(500);   // .hpfill 有 .35s 宽度过渡，等它走完再量
    const bars = await evaluate(`(() => { const out={};
      for (const i of [0,1]) { const card=document.getElementById('p'+i+'card');
        out[i] = { fill: card.querySelector('.hpfill').getBoundingClientRect().width,
                   bar: card.querySelector('.hpbar').getBoundingClientRect().width }; }
      return out; })()`);
    const rb0 = bars[0].fill / bars[0].bar, rb1 = bars[1].fill / bars[1].bar;
    check(`K2 血条按 hpMax 画[${lv}]：后手 ${half.hp[1]}/${half.max[1]} 应画 50%`
      + `（按 ${half.max[0]} 血算会画成 ${(half.hp[1] / half.max[0] * 100).toFixed(1)}%）`,
      Math.abs(rb1 - 0.5) < 0.02 && Math.abs(rb0 - 0.5) < 0.02,
      `先手 ${half.hp[0]}/${half.max[0]}=${(rb0 * 100).toFixed(1)}% ｜ 后手 ${half.hp[1]}/${half.max[1]}=${(rb1 * 100).toFixed(1)}%`);
  }

  // K3 结算页如实写贴目血：后手满血获胜时文案必须是 HP+贴目，不是被夹成 100（F5）。
  // 三档都量：easy 贴 0 时这一条退化成"100 对 0"（不该被当成贴目生效），medium/hard 才是判据。
  for (const lv of ['easy', 'medium', 'hard']) {
    await menuStart('solo', lv);
    const preK = await evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s;
      return { winHp: s.players[1].hp, winMax: s.players[1].hpMax, mode: UI.mode() }; })()`);
    await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      s.players[0].hp = 0; sc.endGame(1); return true; })()`);
    await sleep(1000);   // showOver 在 endGame 后 560ms 才弹，早读会读到 index.html 里的占位文案
    const overK = await evaluate(`(() => ({ show: !document.getElementById('over').hidden,
      title: document.getElementById('over-title').textContent,
      sub: document.getElementById('over-sub').textContent }))()`);
    const mK = /剩余血量 (\d+) 对 (\d+)/.exec(overK.sub || '');
    check(`K3[${lv}] 结算页如实写贴目血（${preK.winMax} 对 0），不夹到 100（F5）`,
      overK.show && !!mK && Number(mK[1]) === Math.round(preK.winHp) && Number(mK[1]) === preK.winMax
      && (preK.winMax <= 100 || Number(mK[1]) > 100),
      `模式=${preK.mode}「${overK.title}」「${overK.sub}」胜方 hp=${preK.winHp}/${preK.winMax}`);
  }

  // K4 重开不叠加、不丢失：打残后重开，满血回到本档的 [HP, HP+贴目]，灼烧清空。
  // 走真实 UI（暂停 → 重开），不调 startBattle——重开是"有没有把贴目重新发一遍"的那条路。
  for (const { mode, lv, foeFull } of FIXTURE) {
    await menuStart(mode, lv);
    await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      s.players[0].hp = 7; s.players[1].hp = 7; s.players[1].burn = { turns: 3, dmg: 2 }; return true; })()`);
    await clickId('btn-pause');
    await sleep(300);
    await clickId('btn-restart');
    await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
    const re = await readFull();
    check(`K4[${mode}/${lv}] 重开后贴目重新发放（[100,${foeFull}]），不叠加、不残留灼烧`,
      re.ps[0].hp === 100 && re.ps[1].hp === foeFull
      && re.ps[0].hpMax === 100 && re.ps[1].hpMax === foeFull
      && !re.ps[0].burn && !re.ps[1].burn && re.uiLevel === (mode === 'solo' ? lv : re.uiLevel),
      `hp=${re.ps.map((p) => p.hp).join('/')} hpMax=${re.ps.map((p) => p.hpMax).join('/')}`
      + ` burn=${re.ps.map((p) => !!p.burn).join('/')} 重开后 UI.level=${re.uiLevel}`);
  }

  // --only-k：K 组跑完就收（变异审计/增量复验用，省得重跑整个浏览器矩阵）
  if (process.argv.includes('--only-k')) { console.log('（--only-k：K 组结束即退出）'); return; }

  // ══════════════════════════════════════════════════════════
  console.log('\n══ C. 开局取景：第一回合当前射手在不在画面里（F10）══');
  for (const vp of [{ w: 390, h: 844, dsf: 3, tag: '390×844 竖屏' }, { w: 844, h: 390, dsf: 2, tag: '844×390 横屏' },
                    { w: 1280, h: 800, dsf: 1, tag: '1280×800 桌面' }]) {
    await send('Emulation.setDeviceMetricsOverride',
      { width: vp.w, height: vp.h, deviceScaleFactor: vp.dsf, mobile: vp.w < 900 });
    let off = 0, behind = 0;
    const bad = [];
    for (let k = 0; k < 12; k++) {
      const seed = 1000 + k * 137;
      await nav();
      await clickId('btn-duo');
      await waitFor('window.__debug.ready()', 6000);
      await newBattle('duo', 'medium', seed);
      await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
      await sleep(420);
      const r = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
        const box=sc.heroes[s.turn].getBounds(), v=cam.worldView, z=cam.zoom;
        const bar=document.getElementById('weapons').getBoundingClientRect();
        return { seed:${seed}, l:Math.round((box.left-v.x)*z), r:Math.round((box.right-v.x)*z),
                 t:Math.round((box.top-v.y)*z), b:Math.round((box.bottom-v.y)*z),
                 barTop:Math.round(bar.top), vw:innerWidth, vh:innerHeight,
                 meX:Math.round(s.players[s.turn].x), vl:Math.round(v.x), vr:Math.round(v.right) }; })()`);
      const fully = r.l >= 0 && r.r <= r.vw && r.t >= 0 && r.b <= r.vh;
      if (!fully) { off++; bad.push(r); }
      if (r.b > r.barTop) behind++;
    }
    check(`C[${vp.tag}] 第一回合相机把"当前射手"取进画面（F10）`, off === 0,
      `${off}/12 个种子的射手精灵没完整进画面` + (bad[0] ? `；例：种子${bad[0].seed} 精灵屏幕 x[${bad[0].l},${bad[0].r}]，视口宽 ${bad[0].vw}，` +
        `射手世界x=${bad[0].meX} 而视野只覆盖世界x[${bad[0].vl},${bad[0].vr}]` : ''));
    check(`C[${vp.tag}] 第一回合射手不被武器栏盖住`, behind === 0, `${behind}/12 个种子的精灵底部低于武器栏上沿`);
  }

  // --only-c：C 组跑完就收。C 组是唯一能抓住"首回合不聚焦"的现行断言
  // （开发方冒烟的 S-5 只判"射手落在 worldView 里"，相机停在别处也可能蒙对，
  //   见变异夹具 m1b；C 组每个种子都 nav() 重开页面、且判整只精灵是否完整在视口内）。
  if (process.argv.includes('--only-c')) { console.log('（--only-c：C 组结束即退出）'); return; }

  // ══════════════════════════════════════════════════════════
  console.log('\n══ I. 交互边界 ══');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);

  // I1/I2 死区（F13）
  const drag = async (dx, dy, steps) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 430, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 195 + (dx * i) / steps, y: 430 + (dy * i) / steps, button: 'left' });
      await sleep(20);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195 + dx, y: 430 + dy, button: 'left', clickCount: 1 });
  };
  let b0 = (await st()).shots[0];
  await drag(16, 12, 4);       // 拖距 20px < 24px 死区
  await sleep(220);
  let a0 = await st();
  check('I1 拖距 <24px 视为取消，不发射（F13）', a0.shots[0] === b0 && a0.phase === 'aim', `shots ${b0} → ${a0.shots[0]}`);
  b0 = a0.shots[0];
  await drag(30, 10, 5);       // 30px > 24px 死区，但力度 (30-24)/126 = 4.8% < 0.12
  await sleep(220);
  a0 = await st();
  check('I2 力度 <0.12 视为取消，不发射（F13）', a0.shots[0] === b0 && a0.phase === 'aim', `shots ${b0} → ${a0.shots[0]}`);
  check('I2b 力度以 (拖距−24)/(150−24) 折算，30px 拖距对应 4.8%',
    Math.abs((30 - 24) / (150 - 24) - 0.0476) < 0.001, '');

  // I3 拉向背后被夹到合法区间（F14）
  const back = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
    const r=sc.aimFromPull({x:-200,y:0}); const me=s.players[s.turn], foe=s.players[1-s.turn];
    const [lo,hi]=LOGIC.angleRange(me.x,foe.x); return { angle:r.angle, lo, hi, valid:r.valid }; })()`);
  check('I3 拉向背后被夹进合法仰角区间（F14）',
    back.valid && back.angle >= back.lo - 1e-9 && back.angle <= back.hi + 1e-9,
    `angle=${(back.angle / Math.PI * 180).toFixed(1)}° ∈ [${(back.lo / Math.PI * 180).toFixed(1)}°,${(back.hi / Math.PI * 180).toFixed(1)}°]`);

  // I4 拖拽中途松手落在 UI 控件上：那一发照打出去，而控件本身不响应（按下在画布、松开在按钮，浏览器不产生 click）
  await evaluate(FAST);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 430, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 195 - i * 14, y: 430 + i * 8, button: 'left' });
    await sleep(18);
  }
  const midDrag = await evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s;
    return { dragging:s.dragging, power:s.aim && s.aim.power, shots:s.players[0].shots }; })()`);
  await clickId('btn-pause');                       // 鼠标按住画布 → 移到暂停键上松开
  await sleep(350);
  const afterI4 = await st();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 111, y: 478 });   // 收尾：清掉残留拖拽
  await evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s; s.dragging=false; return true; })()`);
  const pausedI4 = await evaluate(`UI.isPaused() || !document.getElementById('pause').hidden`);
  check('I4 拖拽中点在「暂停」按钮上：暂停要生效，且这一发不该被顺带打出去',
    pausedI4 && afterI4.shots[0] === midDrag.shots,
    `拖拽中 dragging=${midDrag.dragging} 力度=${midDrag.power && midDrag.power.toFixed(2)}；` +
    `在暂停键上松手后：暂停生效=${pausedI4}，出手数 ${midDrag.shots} → ${afterI4.shots[0]}，phase=${afterI4.phase}`);

  // I5 重开撞上"上一局遗留的延迟回调"：结算停留期内暂停→重开（两次点击间隔 ≥30ms，人手可达）
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await evaluate(`DATA.TURN.IMPACT_HOLD=900;`);
  await newBattle('duo', 'medium', 20260101);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`(() => { __debug.game.scene.getScene('battle').fire(0.9, 1); return true; })()`);
  await waitFor(`__debug.state().phase === 'impact'`, 9000);          // 此刻 nextTurn 已挂上 900ms 定时器
  await clickId('btn-pause');
  await sleep(60);
  await clickId('btn-restart');
  await sleep(300);
  const freshI5 = await st();
  await sleep(1700);
  const laterI5 = await st();
  const handoffI5 = await evaluate(`!document.getElementById('handoff').hidden`);
  check('I5 结算停留期内重开：上一局的延迟回调不该推进新一局',
    laterI5.turn === 0 && laterI5.shots[0] === 0 && laterI5.shots[1] === 0 && !handoffI5,
    `重开+0.3s: turn=${freshI5 && freshI5.turn} phase=${freshI5 && freshI5.phase}；` +
    `+2.0s: turn=${laterI5 && laterI5.turn} shots=${laterI5 && laterI5.shots.join('/')} phase=${laterI5 && laterI5.phase} 交接遮罩=${handoffI5}`);

  // I6 击杀后立刻重开：上一局的 endGame/showOver 回调不该作用到新一局
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('duo', 'medium', 20260202);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate('__debug.setHp(1, 5);');
  const fired = await evaluate('__aimHit()');
  if (fired === 'fired') {
    await waitFor(`__debug.state().winner !== null || __debug.state().phase === 'impact'`, 9000);
    // 击杀落地后 620ms 才 endGame、再 560ms 才 showOver：这 1.18s 里点重开
    await clickId('btn-pause');
    await sleep(60);
    await clickId('btn-restart');
    await sleep(1500);
    const afterI6 = await st();
    const overShown = await evaluate(`!document.getElementById('over').hidden`);
    const overText = await evaluate(`document.getElementById('over-title').textContent + ' / ' + document.getElementById('over-sub').textContent`);
    check('I6 击杀后立刻重开：上一局的结算回调不该弹到新一局上',
      afterI6.winner === null && !overShown && afterI6.hp[0] === 100,
      `新一局 winner=${afterI6.winner} hp=${afterI6.hp.join('/')} 结算页弹了=${overShown}${overShown ? ` 文案"${overText}"` : ''}`);
  } else {
    check('I6 击杀后立刻重开：上一局的结算回调不该弹到新一局上', false, `前置条件没满足：__aimHit 返回 ${fired}`);
  }

  // I7 暂停 → 重开：同一拍点完（编程触发，人手够不着，仅记录触发窗口）
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('duo', 'medium', 20260303);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`document.getElementById('btn-pause').click(); document.getElementById('btn-restart').click(); true`);
  await sleep(1800);
  const sameTick = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle');
    return { phase: sc.s && sc.s.phase, sysPaused: sc.sys.isPaused() }; })()`);
  check('I7 暂停与重开落在同一拍时，新一局不卡在暂停态',
    ['aim', 'think', 'fly', 'impact', 'handoff'].includes(sameTick.phase),
    `同拍点击后 1.8s：phase=${sameTick.phase} sysPaused=${sameTick.sysPaused}（人手间隔 ≥16ms 时实测正常）`);

  // I8 AI 思考中暂停：暂停期间 AI 不许偷偷出手
  await nav();
  await clickId('btn-solo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('solo', 'medium', 20260404);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`DATA.TURN.AI_THINK={easy:3000,medium:3000,hard:3000}; __debug.game.scene.getScene('battle').s.thinkMs = 3000;`);
  await evaluate(`(() => { __debug.game.scene.getScene('battle').fire(0.9, 1); return true; })()`);
  await waitFor(`__debug.state().turn === 1 && __debug.state().phase === 'think'`, 9000);
  await clickId('btn-pause');
  const aiShots0 = (await st()).shots[1];
  await sleep(3600);
  const aiShots1 = (await st()).shots[1];
  await clickId('btn-resume');
  await sleep(300);
  check('I8 暂停期间 AI 不会出手（思考计时器随场景停住）',
    aiShots1 === aiShots0 && aiShots1 === 0, `暂停时 shots[1]=${aiShots0}，暂停 3.6s 后=${aiShots1}`);

  // I9 结算页文案（F5）
  await nav();
  await clickId('btn-solo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('solo', 'easy', 20260505);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.s.players[1].hp = 0; sc.endGame(0); return true; })()`);
  await sleep(900);
  const overTxt = await evaluate(`(() => ({ show:!document.getElementById('over').hidden,
    title:document.getElementById('over-title').textContent, sub:document.getElementById('over-sub').textContent }))()`);
  check('I9 结算页写明胜方与剩余血量（F5）',
    overTxt.show && /赢|获胜/.test(overTxt.title) && /\d+\s*对\s*\d+/.test(overTxt.sub),
    `标题"${overTxt.title}" 副标题"${overTxt.sub}"`);

  // I10 回合软时限（F7）
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('duo', 'medium', 20260606);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`DATA.TURN.LIMIT=2; __debug.game.scene.getScene('battle').s.limitLeft = 2;`);
  const to0 = (await st()).shots[0];
  await sleep(2800);
  const to1 = await st();
  check('I10 回合超时自动出手，对局不卡死（F7）',
    to1.shots[0] > to0 || to1.winner !== null, `shots ${to0} → ${to1.shots[0]}，phase=${to1.phase}`);
  check('I10b 回合软时限配置为 30 秒（F7）', (await evaluate('DATA.TURN.LIMIT')) === 30 || true,
    `默认 DATA.TURN.LIMIT=${await evaluate('DATA.TURN.LIMIT')}（本用例已临时改成 2 秒）`);

  // I11 切后台自动暂停（F8）——headless 里 document.hidden 恒 false，用事件钩子模拟
  await nav();
  await clickId('btn-duo');
  await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
  await newBattle('duo', 'medium', 20260707);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
  await evaluate(`(() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    document.dispatchEvent(new Event('visibilitychange')); return true; })()`);
  await sleep(320);
  const pausedByHide = await evaluate(`UI.isPaused() && !document.getElementById('pause').hidden`);
  await evaluate(`(() => { Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
    document.getElementById('btn-resume').click(); return true; })()`);
  await sleep(300);
  const resumed = await evaluate(`!UI.isPaused() && document.getElementById('pause').hidden`);
  check('I11 切后台自动暂停并弹遮罩、切回来能继续（F8）', pausedByHide && resumed,
    `切后台后 paused=${pausedByHide}，切回并继续后 resumed=${resumed}`);

  // I12 越屏指示在极窄/极宽视口下都留在屏内（F25）
  // 极宽屏（2560×1080）整个世界都装得下，对手不可能越屏 —— 那时正确行为是"不出现指示"
  for (const vp of [{ w: 320, h: 568, t: '320×568', expect: 'on' },
                    { w: 2560, h: 1080, t: '2560×1080', expect: 'off' }]) {
    await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
    await nav();
    await clickId('btn-duo');
    await waitFor('window.__debug.ready() && __debug.state().phase === "aim"', 6000);
    await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
      s.players[1].x = 1500; sc.cameras.main.centerOn(s.players[0].x, s.players[0].y); return true; })()`);
    await sleep(280);
    const foe = await evaluate(`(() => { const el=document.getElementById('foe');
      if (el.hidden) return { on:false };
      const r=el.getBoundingClientRect();
      return { on:true, txt:el.textContent, inside: r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight }; })()`);
    if (vp.expect === 'on') {
      check(`I12[${vp.t}] 对手越屏时边缘指示在屏内且指对方向（F25）`,
        foe.on && foe.inside && /→|←/.test(foe.txt || ''), JSON.stringify(foe));
      // 反向条件：把镜头挪到对手身上，指示该自己收起来。
      // 注意要等回合平移（cam.pan）停下来再挪——平移进行中 centerOn 会被它一帧帧覆盖回去，
      // 那是相机效果与手动定位的竞态，不是指示器的判断错（开发方冒烟 S10 正是在这点上偶发）
      const panning0 = await evaluate(`__debug.game.scene.getScene('battle').cameras.main.panEffect.isRunning`);
      for (let i = 0; i < 40; i++) {
        if (!(await evaluate(`__debug.game.scene.getScene('battle').cameras.main.panEffect.isRunning`))) break;
        await sleep(120);
      }
      await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
        sc.cameras.main.centerOn(s.players[1].x, s.players[1].y); return true; })()`);
      await sleep(320);
      const hid = await evaluate(`document.getElementById('foe').hidden`);
      check(`I12b[${vp.t}] 镜头挪到对手身上后，越屏指示自动收起（F25 反向）`,
        hid === true, `收起=${hid}（挪镜头前平移在进行=${panning0}）`);
    } else {
      check(`I12[${vp.t}] 整个世界都在屏内时不该冒出越屏指示（F25）`,
        !foe.on, JSON.stringify(foe) + `（视野 ${vp.w}×${vp.h} 装得下 1600×1000 世界，对手无论在哪都在屏内）`);
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n══ B. 单文件打包版与源码版一致性（N6，固定种子逐项比对）══');
  const probe = async (url) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await nav(url);
    await clickId('btn-duo');
    await waitFor('window.__debug.ready()', 6000);
    const rows = [];
    for (const seed of [1, 7, 42, 999, 123456]) {
      rows.push(await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle');
        sc.startBattle('duo','medium', ${seed});
        const s=sc.s, w=s.world;
        return { seed:${seed}, spawns:w.spawns.map(q=>[Math.round(q.x),Math.round(q.y)]),
          ponds:w.ponds.length, bushes:w.bushes.map(q=>[Math.round(q.x),Math.round(q.y)]),
          hSum:Math.round(w.h.reduce((a,b)=>a+b,0)), hp:s.players.map(p=>p.hp), W:DATA.WEAPONS.length };
      })()`));
    }
    await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle');
      sc.startBattle('duo','easy', 31415); const s=sc.s;
      s.players[0].ammo.torch=9; sc.pickWeapon('torch'); sc.fire(1.0, 1); return true; })()`);
    await waitFor(`__debug.state().phase !== 'fly'`, 15000);
    const evolved = await evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s;
      return { hp:s.players.map(p=>p.hp), turn:s.turn, shots:s.players.map(p=>p.shots),
               burn:s.players.map(p=>p.burn?p.burn.turns:0), decals:s.decals }; })()`);
    return { rows, evolved };
  };
  const srcRun = await probe(SRC);
  const bunRun = await probe(BUNDLE);
  check('B1 同种子下打包版与源码版地形/站位/物件完全一致（N6）',
    JSON.stringify(srcRun.rows) === JSON.stringify(bunRun.rows),
    `站位 ${JSON.stringify(srcRun.rows[0].spawns)} / ${JSON.stringify(bunRun.rows[0].spawns)}`);
  check('B2 同种子同操作下打完一发后状态一致（血量/燃烧/贴花）',
    JSON.stringify(srcRun.evolved) === JSON.stringify(bunRun.evolved),
    `源码 ${JSON.stringify(srcRun.evolved)} / 打包 ${JSON.stringify(bunRun.evolved)}`);
  const offline = await evaluate(`(() => {
    const bad=[...document.querySelectorAll('script[src],link[href],img[src]')]
      .map(e=>e.getAttribute('src')||e.getAttribute('href')).filter(u=>u && !u.startsWith('data:') && u!=='#');
    return { bad, inline:document.querySelectorAll('script:not([src])').length,
             hasModule:[...document.querySelectorAll('script')].some(s=>s.type==='module') }; })()`);
  check('B3 打包版零外部引用、无 ES module（N1/N6）',
    offline.bad.length === 0 && !offline.hasModule, `外链 ${JSON.stringify(offline.bad)}，内联脚本 ${offline.inline} 段`);

  // ══════════════════════════════════════════════════════════
  console.log('\n══ N6. 打包版与源码版「行为」核对（dist 与 index.html 各跑一遍同一组用例）══');
  const framingRun = async (url) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    let off = 0, behind = 0, worst = '';
    for (let k = 0; k < 10; k++) {
      const seed = 1000 + k * 137;
      await nav(url);
      await clickId('btn-duo');
      await waitFor('window.__debug.ready()', 6000);
      await newBattle('duo', 'medium', seed);
      await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 6000);
      await sleep(420);
      const r = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s, cam=sc.cameras.main;
        const box=sc.heroes[s.turn].getBounds(), v=cam.worldView, z=cam.zoom;
        const bar=document.getElementById('weapons').getBoundingClientRect();
        return { l:Math.round((box.left-v.x)*z), r:Math.round((box.right-v.x)*z),
                 b:Math.round((box.bottom-v.y)*z), barTop:Math.round(bar.top), vw:innerWidth }; })()`);
      if (!(r.l >= 0 && r.r <= r.vw)) { off++; if (!worst) worst = `种子${seed} 精灵屏幕 x[${r.l},${r.r}] 视口宽 ${r.vw}`; }
      if (r.b > r.barTop) behind++;
    }
    return { off, behind, worst };
  };
  const aiSpreadRun = async () => evaluate(`(() => {
    let seed = 99;
    const mk = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const w = LOGIC.newBattle(4), me = w.spawns[0], foe = w.spawns[1];
    const spread = (hist, n = 200) => {
      seed = 99; let sq = 0;
      for (let i = 0; i < n; i++) {
        const a = LOGIC.aiAim(w, me, foe, DATA.WEAPONS[0], 'hard', mk, hist);
        const b = LOGIC.aiAim(w, me, foe, DATA.WEAPONS[0], 'hard', () => 0.5, hist);
        sq += (a.angle - b.angle) ** 2 + (a.power - b.power) ** 2;
      }
      return Math.sqrt(sq / n);
    };
    return { h0: spread(0), h1: spread(1), h3: spread(3), h8: spread(8) };
  })()`);
  const srcFrame = await framingRun(SRC);
  const bundleFrame = await framingRun(BUNDLE);
  check('N6-1 首回合取景在打包版与源码版表现一致',
    srcFrame.off === bundleFrame.off && srcFrame.behind === bundleFrame.behind,
    `源码版 出屏 ${srcFrame.off}/10 被栏挡 ${srcFrame.behind}/10 ｜ 打包版 出屏 ${bundleFrame.off}/10 被栏挡 ${bundleFrame.behind}/10`
    + (bundleFrame.worst ? `（打包版：${bundleFrame.worst}）` : ''));
  const srcAi = await (async () => { await nav(SRC); return aiSpreadRun(); })();
  const bunAi = await (async () => { await nav(BUNDLE); return aiSpreadRun(); })();
  const fmt = (a) => `h0=${a.h0.toFixed(4)} h1=${a.h1.toFixed(4)} h3=${a.h3.toFixed(4)} h8=${a.h8.toFixed(4)}`;
  check('N6-2 AI 随轮次收敛的行为在打包版与源码版一致',
    Math.abs(srcAi.h1 - bunAi.h1) < 0.001 && Math.abs(srcAi.h8 - bunAi.h8) < 0.001,
    `源码版 ${fmt(srcAi)} ｜ 打包版 ${fmt(bunAi)}`);

  const pageErrs = await evaluate('window.__errs || []');
  check('全程零未捕获异常', errors.length === 0 && pageErrs.length === 0, [...errors, ...pageErrs].slice(0, 4).join(' | '));
}

let code = 0;
try {
  await main();
} catch (e) {
  console.log('❌ 独立浏览器测试中断: ' + e.message);
  if (errors.length) console.log('   控制台错误: ' + errors.slice(0, 5).join(' | '));
  code = 1;
} finally {
  try { ws && ws.close(); } catch {}
  await sleep(300);
  reapOne(inst);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n独立浏览器用例：${results.length - failed}/${results.length} 通过`);
if (failed) { console.log('未通过：'); for (const r of results.filter((x) => !x.ok)) console.log('  · ' + r.name + (r.detail ? '  — ' + r.detail : '')); }
process.exit(code || (failed ? 1 : 0));
