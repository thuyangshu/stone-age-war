// 无头 Chrome 冒烟：标题 → 开局 → 拖拽瞄准 → 完整对局 → 双人交接 → 池塘/灌木
//   → 砸痕像素 → 弹药灰显 → 火把点燃 → 手机视口（越屏指示/武器栏两端可达/竖屏提示）→ 暂停/重开 → 静音
// 全程收集控制台错误与未捕获异常，任何一条即失败。用法：node tests/browser-smoke.mjs
// SMOKE_PAGE=某 html 路径 可改测打包出的单文件版
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTE, SPAWN_OPTS, register, reapOne, watchdog } from './reaper.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 端口不能靠随机数挑。旧写法 9300+rand(500) 只有 500 个候选，而开发/测试/审计
// 三方可能同时在跑无头 Chrome（实测撞过一次）。撞上的后果比"起不来"更糟：
// 自己的实例绑不上调试端口，下面的 /json/list 却会**连上别人那台浏览器**，
// 然后一路驱动别人家的页面，报出来的错跟本仓库毫无关系。
// 改成向内核要一个空闲端口：绑 0 号端口拿到分配值再关掉，冲突概率从 1/500 降到可忽略。
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = pathToFileURL(process.env.SMOKE_PAGE || join(ROOT, 'index.html')).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'stone-smoke-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required',
  ...MUTE,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], SPAWN_OPTS);
const inst = register(chrome, profile);
chrome.on('error', () => {});
const wd = watchdog(240);   // S4 打完整一局最长给 75s，整条冒烟留 240s 上限

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

// 等相机自己说"我不动了"。镜头聚焦是 420ms 的补间动画，而 headless 里页面时钟比
// 墙上时钟慢好几倍（实测跑完整个 S10 段，页内 performance.now 只走了 700ms），
// 固定 sleep(180) 那点时间连几帧都推不动——补间还在跑，随手 centerOn 会被它盖回去，
// 于是断言读到的是"补间走到一半"的位置，冤枉代码。改成等相机状态，不猜时长
async function waitCamIdle(timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (!(await evaluate(`__debug.game.scene.getScene('battle').cameras.main.panEffect.isRunning`))) return true;
    await sleep(80);
  }
  return false;
}

// 等真实渲染帧。DOM 侧的变化（贴边指示）由每帧的 updateFoeHint 写，headless 里
// sleep 多少毫秒都保证不了"至少过了一帧"，只有 rAF 自己数得准
const frames = (n = 3) => Promise.race([
  evaluate(`new Promise((res) => { let k = ${n};
    const t = () => { if (--k <= 0) return res(true); requestAnimationFrame(t); };
    requestAnimationFrame(t); })`),
  sleep(8000),
]);

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
}

const st = () => evaluate('window.__debug.state()');
const dom = () => evaluate('window.__debug.dom()');
// 贴目（KOMI）自 2026-09-27 起是分档表 {easy,medium,hard}，满血值随场上的 mode/level 变，
// 所以不能在开头读一次缓存起来用——换难度后它会停在旧值上，断言就成了自己跟自己比。
// 这里按**跟游戏同一条规则**现算：LOGIC.komiFor(mode/level)。它只依赖 DATA.KOMI 表
// 与场上的 mode/level，不依赖 newPlayer 的接线，所以仍能查出"接线漏了/发错人"。
const komiNow = () => evaluate(`(() => {
  const s = __debug.game.scene.getScene('battle').s;
  return LOGIC.komiFor(s.mode === 'solo' ? s.level : null);
})()`);
const modeLevel = () => evaluate(`(() => {
  const s = __debug.game.scene.getScene('battle').s;
  return s.mode + (s.mode === 'solo' ? ' · ' + s.level : '');
})()`);
const click = async (id) => {
  const p = await evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
};
// 触屏点按：手机上点按钮走的就是这条路，不能拿鼠标事件代跑
async function tap(id) {
  const p = await evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
  // 元素隐藏（display:none）时 getBoundingClientRect 全是 0，事件会打到 (0,0)，
  // 点击静默丢失、后面几条断言跟着一起红——先喊一声，省得回头猜是谁没点到
  if (p.w < 1 || p.h < 1) console.log(`   ⚠ tap(${id}) 目标不可见（${p.w}×${p.h}），这一下打空了`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
  await sleep(30);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
// 真·拖拽（走游戏的真实输入路径，不调 fire 后门）
async function drag(x0, y0, dx, dy, steps = 7) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, button: 'left' });
    await sleep(22);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'left', clickCount: 1 });
}
// 把回合节奏压到最短，好在冒烟里打完一整局
const FAST = `DATA.TURN.IMPACT_HOLD=40; DATA.TURN.BANNER_MS=40; DATA.TURN.AI_AIM_MS=20;
  DATA.TURN.AI_THINK={easy:1,medium:1,hard:1}; DATA.TURN.HANDOFF=false; window.__debug.setThinkMs(1);`;

// 必中一击：照着对手解算，低弧被挡就换高弧，弧线先试射一遍再真打。
// 直接拿 solveShot 的低弧打，会撞上随机的灌木丛——冒烟就成了看脸的测试
// （实测同一发连着两次撞灌木，掉血、留痕、点燃全都没发生）。
// 这段判据与 AI 选弧共用同一套 simulate，不是给测试开的后门。
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
    // owner 必须和 fire() 里一样设上：直击判定会跳过 owner，不设的话模拟里
    // 高抛落回自己头上会被记成"命中"，于是助手以为这条弧能中、真打时却从自身穿过去
    // 落在灌木/水里——模拟与实机由此分家
    p.owner = s.turn;
    const r = LOGIC.simulate(s.world, p, { wind: 0 }, { players: s.players, sampleEvery: 8 });
    const first = r.events[0];
    if (first && first.type === 'direct' && first.who === 1 - s.turn) { sc.fire(arc, 1); return 'fired'; }
  }
  return 'blocked';
};`;

async function main() {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(100); }
  }
  // 起不来要立刻说清是哪一步、哪个端口，别只丢一句"启动失败"让人去猜
  if (!target) throw new Error(`Chrome 启动失败：端口 ${PORT} 上没等到可调试页面（等了 5s）`);
  // 兜底防串台：自己的实例刚起时只有 about:blank 一个页面。若这里拿到的不是它，
  // 说明 127.0.0.1:PORT 是别人的浏览器（端口抢占），继续跑就是驱动别人家的页面
  if (target.url && target.url !== 'about:blank') {
    throw new Error(`端口 ${PORT} 上挂的不是本进程启动的 Chrome（页面是 ${target.url}），疑似端口被占`);
  }
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
  await send('Page.navigate', { url: PAGE });
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
  // 常量真的从页面取：此前这里注释写着"避免和 data.js 各写一份"，
  // 值却是手写的 8 和 0.55——改了 data.js 这两条断言也不会跟着动，注释在说谎。
  // DATA 是 data.js 里的顶层 const（全局词法绑定，不是 window 属性），evaluate 取得到。
  // 每次重新加载页面都要重取一遍（换设备重载后是新的一份 DATA）
  DATA_WEAPON_COUNT = await evaluate('DATA.WEAPONS.length');
  DATA_CAM_MIN = await evaluate('DATA.CAM.minZoom');
  DATA_HP = await evaluate('DATA.HP');
  // 后手贴目（player 1 开局多这么多血）不在这里读缓存：出厂值是**分档表**，
  // 满血随场上的 mode/level 变，各断言按需现算——见 komiNow()
  await evaluate(AIM_HIT);
  // 记下每次命中类型：失败时能一眼看出是打偏、撞灌木还是落水，不用回头猜
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); window.__impacts=[];
    const oi=sc.onImpact.bind(sc);
    sc.onImpact=(e)=>{ window.__impacts.push(e.type); return oi(e); }; return true; })()`);

  // S1 标题页
  let d = await dom();
  check('S1 标题页显示、HUD 隐藏', d.title && !d.hud && !d.weapons);

  // F1 三档难度按钮：此前冒烟从没点过它们，"选了难度真的生效"这条一直没人验
  const lvOk = [];
  for (const lv of ['easy', 'medium', 'hard']) {
    await evaluate(`document.querySelector('#diff .lv[data-lv="${lv}"]').click()`);
    lvOk.push((await evaluate('__debug.level()')) === lv);
  }
  await evaluate(`document.querySelector('#diff .lv[data-lv="medium"]').click()`);   // 复位回普通档
  check('F1 三档难度按钮都能选中且真的生效', lvOk.every(Boolean), `逐档结果 ${JSON.stringify(lvOk)}`);

  // S2 开局：点"人机对战"
  await click('btn-solo');
  await waitFor('window.__debug.ready()', 5000);
  await sleep(400);
  let s = await st();
  d = await dom();
  check('S2 开局：HUD/武器栏出现、8 个武器槽', d.hud && d.weapons && d.slots === DATA_WEAPON_COUNT, `slots=${d.slots}`);
  // 满血的准确值从页面读，不写死 100：后手有贴目（DATA.KOMI 分档），写死会让改数值时
  // 这条断言悄悄变成"错的"却仍写着"满血"
  let K = await komiNow();
  check('S2 双方满血、有站位',
    s.hp[0] === DATA_HP && s.hp[1] === DATA_HP + K && s.spawns.length === 2,
    `hp=${s.hp.join('/')}（满血 ${DATA_HP}/${DATA_HP + K}，本局 ${await modeLevel()}）`);
  // 上面那条两侧都从页面读：把 KOMI 改成 0 它照样绿（测试方 T-6 建议 6）。那条量的是
  // "页面内部自洽"，这条量的是"发出去的确实是这几个数"。数值本身由镜像线
  // （bot-playtest）钉平衡，这里钉出厂值——改了 data.js 的 HP/KOMI 就得同步改这一行。
  // S2 走的是「人机 · medium」，medium 档贴目 12 → 100/112；分档表一动这条必须一起动
  check('S2 贴目出厂值就是 100 / 112（人机 medium）',
    s.hp[0] === 100 && s.hp[1] === 112,
    `hp=${s.hp.join('/')}（出厂值 100/112；data.js 的 HP 与 KOMI 表一改，这条必须一起改）`);

  // S2c 受击体必须盖住画出来的身体——作者最初报的那个 bug 的回归闸门。
  // 起因：「左边的人物投掷武器，路线经过右边的对手，但穿模而过，没有任何伤害。」
  // 根因是"看得见的身体"和"打得中的身体"各说各话：判定体当时是 (x, y−30) 处半径 33 的圆，
  // 只盖住身体中段，头部一大截打得中才怪。修完换成胶囊 HIT={BOT,TOP,R}，
  // 但**此前没有任何一条测试量过"画出来的"与"打得到的"对不对得上**——
  // 逻辑层的胶囊单测只验形状，验不了它跟贴图的摆位（origin/HERO_BOX）配不配。
  // 这条直接量：关掉呼吸补间、把贴图钉回逻辑位置，扫 alpha 包围盒求真实身体上下沿，
  // 再按 HIT 算胶囊上下沿，两边比。旧配置在这里差 78px，当场红。
  const align = await evaluate(`(() => {
    const sc = __debug.game.scene.getScene('battle'), s = sc.s, H = DATA.HIT;
    return sc.heroes.map((spr, i) => {
      sc.tweens.killTweensOf(spr); spr.y = s.players[i].y;   // 呼吸补间会让读数飘 ±3px
      const src = spr.texture.getSourceImage(), W = src.width, Hh = src.height;
      const d = src.getContext('2d').getImageData(0, 0, W, Hh).data;
      let top = 1e9, bot = -1;
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 8) { if (y < top) top = y; if (y > bot) bot = y; }
      }
      const wy0 = spr.y - spr.originY * Hh;
      const py = s.players[i].y;
      return { i, drawnTop: wy0 + top, drawnBot: wy0 + bot,
               capTop: py - H.TOP - H.R, capBot: py - H.BOT + H.R };
    });
  })()`);
  // 正数＝胶囊那一端没够到画出来的身体。容差 8px：留贴图抗锯齿与分节肢体的边缘余量；
  // 两侧都卡，负太多是另一种错（打得中的地方比看得见的大，等于白送命中）。
  const gapTop = align.map((a) => a.capTop - a.drawnTop);
  const gapBot = align.map((a) => a.drawnBot - a.capBot);
  check('S2c 受击体盖住画出来的身体（穿模 bug 回归闸门）',
    gapTop.every((g) => g <= 8 && g > -8) && gapBot.every((g) => g <= 8 && g > -8),
    `胶囊顶−身体顶=${gapTop.map((g) => g.toFixed(1)).join('/')}，身体底−胶囊底=${gapBot.map((g) => g.toFixed(1)).join('/')}（容差 ±8px）`);

  // S2b 地形要盖满视野。宽屏下适配缩放被高度卡住，视野比世界那 1600px 宽，
  // 地形只画世界尺寸的话左右会露出两条直角切口——地形看着像浮在背景上的方块
  const cov = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle');
    const v=sc.cameras.main.worldView, t=sc.terrain;
    return { tl:t.x, tr:t.x+t.width, tb:t.y+t.height, vl:v.x, vr:v.right, vb:v.bottom }; })()`);
  check('S2 地形盖满视野，看不到世界边界',
    cov.tl <= cov.vl + .5 && cov.tr >= cov.vr - .5 && cov.tb >= cov.vb - .5,
    `terrain x[${cov.tl},${cov.tr}] 底${cov.tb} / 视野 x[${cov.vl},${cov.vr}] 底${cov.vb}`);

  // S3 拖拽瞄准 → 力度条 → 发射
  await evaluate(FAST);
  await waitFor(`__debug.state().phase === 'aim' && __debug.state().turn === 0`, 4000);
  const shooter = await evaluate(`(() => { const s=__debug.game.scene.getScene('battle'); const p=s.s.players[0];
    const v=s.cameras.main.worldView; return { x:(p.x-v.x)*s.cameras.main.zoom, y:(p.y-v.y)*s.cameras.main.zoom }; })()`);
  const tx = Math.max(60, Math.min(1200, shooter.x)), ty = Math.max(120, Math.min(700, shooter.y));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 7; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tx - i * 16, y: ty + i * 10, button: 'left' });
    await sleep(20);
  }
  const midPower = (await dom()).power;
  // F9 预测线 + 落点圈：拖拽中必须两样都画出来（读数来自 game.js showAimLine 的观测点）
  const ap = await evaluate('__debug.aimPreview()');
  check('F9 拖拽时预测线与落点圈都在', ap && ap.dots >= 10 && ap.ring === true, JSON.stringify(ap));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx - 112, y: ty + 70, button: 'left', clickCount: 1 });
  await sleep(120);
  s = await st();
  check('S3 拖拽时力度条出现', midPower);
  // 出手后预测线要收掉，不能留在屏幕上
  const apGone = await evaluate(`__debug.game.scene.getScene('battle').aimGfx.commandBuffer.length`);
  check('F9 出手后预测线收起', apGone === 0, `commandBuffer=${apGone}`);
  check('S3 松手后真的打出去了', s.phase === 'fly' || s.phase === 'impact' || s.shots[0] === 1, `phase=${s.phase} shots=${s.shots[0]}`);

  // S4 打完整一局（两边轮流开火直到分出胜负）
  await waitFor(`['aim','think','handoff'].includes(__debug.state().phase)`, 6000);
  // 一发跨屏抛物线真实飞行约 2 秒（v=1200/G=900 的 45° 弹道），这是玩法本身的时间，
  // 不是可以压掉的等待——满血 100 打完要 16 发上下、40 秒，冒烟就得给够预算。
  // 压到 60 血既能让对局真实跑完（同一套瞄准→飞行→结算→换边循环），又不至于拖垮整条闸门。
  await evaluate('__debug.setHp(0, 60); __debug.setHp(1, 60);');
  // 预算按**游戏进度**给，不按墙钟（2026-09-27 改，审计一般#3）。
  // 上一版按墙钟给 120 秒，方向对（比按轮询次数强：一次轮询一个 CDP 往返，机器一忙
  // 往返就慢），但没治根——CPU 被压满时页面时钟跟着被拖慢，同样长的墙钟里推进的游戏
  // 时间只剩零头，墙钟给多少都可能不够；反过来真卡死时墙钟给多少都是失败，只是线索不同。
  // 现在判据换成"这局还在不在推进"：sig() 把 phase/turn/shots/hp 串成一个语义指纹，
  // 指纹一变就重置停滞计时，连续 STALL_MS 不动才判失败。外侧留一个宽松的墙钟上限兜底，
  // 防"永远缓慢推进"把闸门吊死。失败时一并打印 fps 与页面时钟，好区分
  // "页面根本没在渲染"还是"渲染着但游戏不推进"。
  // 注：state().clock 是 Phaser 的帧时间戳（rAF 给的，等价墙钟），只回答"页面还在不在渲染"，
  // 不能当进度用——进度只认 sig() 里那几个语义量。
  const STALL_MS = 20000, HARD_MS = 300000;
  const sig = (c) => [c.phase, c.turn, c.winner, ...(c.shots || []), ...(c.hp || [])].join('|');
  const hardDl = Date.now() + HARD_MS;
  let winner = null, blocked = 0, lastPhase = '', lastSig = '', lastMove = Date.now(), stop = '';
  for (;;) {
    const cur = await st();
    lastPhase = cur.phase;
    const fp = sig(cur);
    if (fp !== lastSig) { lastSig = fp; lastMove = Date.now(); }
    if (cur.winner !== null) { winner = cur.winner; break; }
    if (cur.phase === 'hidden' || cur.phase === 'over') break;
    if (Date.now() - lastMove > STALL_MS) {
      stop = `停滞 ${Math.round((Date.now() - lastMove) / 1000)}s：phase/发数/血量一个都不动`;
      break;
    }
    if (Date.now() > hardDl) { stop = `触到 ${HARD_MS / 1000}s 墙钟上限（还在推进，只是太慢）`; break; }
    // 用解算出的真实角度出手，保证能打中，别让冒烟靠运气
    const r = await evaluate(`(() => {
      if (__debug.game.scene.getScene('battle').s.phase === 'handoff') { document.getElementById('btn-handoff').click(); return 'handoff'; }
      return __aimHit(); })()`);
    if (r === 'blocked' || r === 'no-solution') blocked++;
    // 飞行中就把轮询压到最短：整局的时间几乎全花在等弹丸落地
    await sleep(r === 'fired' ? 30 : 8);
  }
  s = await st();
  check('S4 完整对局分出胜负', s.winner === 0 || s.winner === 1,
    `winner=${s.winner} 打了 ${Math.max(...s.shots)} 发，收尾 phase=${lastPhase}，助手判 blocked ${blocked} 次`
    + `，fps=${s.fps} 页面时钟=${s.clock}ms${stop ? '，' + stop : ''}`);
  await waitFor(`!document.getElementById('over').hidden`, 4000);
  const over = await dom();
  check('S4 结算页弹出且写明胜方', over.over);
  // F5 结算文案：胜方 + 双方剩余血量。只验"结算页弹出来了"是不够的——
  // 文案串了就没人看得出来（"你赢了"配 0 对 0 也是弹出来了）
  const hpNum = /剩余血量 (\d+) 对 (\d+)/.exec(over.overSub || '');
  const winHp = hpNum ? Number(hpNum[1]) : -1, loseHp = hpNum ? Number(hpNum[2]) : -1;
  check('F5 结算写明胜方与剩余血量',
    /(你赢了|你输了|玩家[一二] 获胜)/.test(over.overText || '') && hpNum
      && winHp === s.hp[s.winner] && loseHp === 0,
    `「${over.overText}」「${over.overSub}」胜方 HP=${s.hp[s.winner]}`);

  // S5 双人模式交接遮罩
  await click('btn-again');
  await waitFor('window.__debug.ready()', 4000);
  await evaluate(FAST);
  await evaluate(`__debug.game.scene.getScene('battle').startBattle('duo','medium', 7)`);
  await waitFor(`__debug.state() && __debug.state().mode === 'duo'`, 4000);
  await sleep(300);
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.fire(1.2, 0.9); return true; })()`);
  await waitFor(`__debug.state().phase === 'handoff'`, 9000);
  d = await dom();
  check('S5 双人模式出手后弹交接遮罩', d.handoff);
  await click('btn-handoff');
  await sleep(400);
  s = await st();
  check('S5 交接后轮到玩家二', s.turn === 1, `turn=${s.turn}`);

  // S6 池塘与灌木：找一张有水的图，验证水面颜色确实是水
  let hasWater = false;
  for (let seed = 1; seed <= 40 && !hasWater; seed++) {
    hasWater = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.startBattle('solo','medium',${seed});
      return sc.s.world.ponds.length > 0; })()`);
  }
  if (hasWater) {
    // 沿池塘正中的一列竖直采样：从水面往下采到碗底，整段都该是水。
    // 早先沿横向采、纵向取中线，两端读到草色——塘是碗形，边缘那一行还没入水，
    // 不是没画水，是采样点落在岸上了
    const wpix = await evaluate(`(async () => { const s=__debug.game.scene.getScene('battle').s, p=s.world.ponds[0];
      const x = Math.round((p.x0 + p.x1) / 2);
      let n = 0, water = 0, sample = null;
      for (let y = Math.round(p.y) + 3; y <= Math.round(p.bottom) - 3; y += 2) {
        const c = await __debug.terrainPixel(x, y); n++;
        if (c.b > c.r && c.b > 120) { water++; if (!sample) sample = c; }
      }
      return { n, water, sample, x, yTop: Math.round(p.y), yBot: Math.round(p.bottom),
               pondAt: !!WORLD.pondAt(s.world, x) }; })()`);
    check('S6 池塘画出来的确实是水色', wpix.n > 0 && wpix.water >= wpix.n * 0.7 && wpix.pondAt,
      `${wpix.water}/${wpix.n} 个采样点是水色${wpix.sample ? `（rgb(${wpix.sample.r},${wpix.sample.g},${wpix.sample.b})）` : ''}`);
    // 水面反光条只能画在有水的那一段。碗形塘两端的池底高过水面线，水在那里厚度为零，
    // 照 x0+6..x1-6 整条画过去，白线就横在岸上（实测白线 279px、水只有 147px 宽）。
    // 岸边取水线高度的那一点，本该是泥土（红>蓝），是反光就是浅蓝白（蓝>红）
    const bank = await evaluate(`(async () => { const p=__debug.game.scene.getScene('battle').s.world.ponds[0];
      return { c: await __debug.terrainPixel(Math.round(p.x0) + 8, Math.round(p.y)), x0: Math.round(p.x0), y: Math.round(p.y) }; })()`);
    check('S6 水面反光条不越界到岸上', bank.c && bank.c.r > bank.c.b,
      `岸边(${bank.x0 + 8},${bank.y}) rgb(${bank.c ? bank.c.r + ',' + bank.c.g + ',' + bank.c.b : '读不到'})`);
  } else {
    check('S6 池塘画出来的确实是水色', false, '40 个种子里一个池塘都没有');
  }
  const bushInfo = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); const s=sc.s;
    return { n:s.world.bushes.length, b: s.world.bushes[0] ? { x:s.world.bushes[0].x+31, y:s.world.bushes[0].y+20 } : null }; })()`);
  if (bushInfo.b) {
    const px = await evaluate(`__debug.terrainPixel(${bushInfo.b.x}, ${bushInfo.b.y})`);
    check('S6 灌木画出来是绿色', px && px.g > px.r + 20, px ? `rgb(${px.r},${px.g},${px.b})` : '读不到像素');
  } else {
    check('S6 灌木画出来是绿色', false, '这张图没有灌木');
  }

  // S7 砸痕贴花：照着对手打一发（直击和落地都会烙痕），然后采样贴图像素
  //   ——落水与穿灌木是明确不留痕的，所以不能随手朝天上扔一发碰运气：
  //   早先那版朝空地一发正好掉进池塘（type:'water'），decals 当然是 0，白等 9 秒
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.startBattle('duo','medium',3); return true; })()`);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 4000);
  const before = (await st()).decals;
  for (let k = 0; k < 3; k++) {
    const fired = (await evaluate(`__aimHit()`)) === 'fired';
    if (!fired) { await sleep(120); continue; }
    try { await waitFor(`__debug.state().decals > ${before}`, 8000); break; } catch { /* 打偏了就再来一发 */ }
    finally { await waitFor(`__debug.state().phase === 'aim'`, 6000).catch(() => {}); }
  }
  s = await st();
  check('S7 弹丸落地留下砸痕', s.decals > before,
    `decals ${before} → ${s.decals}，命中序列 ${await evaluate('JSON.stringify(window.__impacts)')}`);

  // S8 弹药灰显：把限量武器打光
  await evaluate(`(() => { const s=__debug.game.scene.getScene('battle').s;
    s.turn=0; s.phase='aim'; s.players[0].ammo.boulder=0; s.players[0].ammo.axe=0; UI.syncWeapon(); return true; })()`);
  await sleep(200);
  d = await dom();
  check('S8 没弹药的武器槽灰显', d.dimmed >= 2, `灰显 ${d.dimmed} 个`);

  // S9 火把点燃：解算真实角度打过去，验证 3 回合燃烧
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.startBattle('duo','medium',5); return true; })()`);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 4000);
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); const s=sc.s;
    s.players[0].ammo.torch = 5; s.turn = 0; s.phase='aim'; sc.pickWeapon('torch'); return true; })()`);
  await sleep(200);
  const lit = await evaluate(`__aimHit('torch')`);
  if (lit === 'fired') {
    await waitFor(`__debug.state().burn[1] > 0 || __debug.state().winner !== null`, 9000);
    s = await st();
    check('S9 火把命中后对手进入燃烧', s.burn[1] === 3 || s.winner !== null, `burn=${s.burn[1]}`);
  } else {
    check('S9 火把命中后对手进入燃烧', false, lit);
  }

  // S10 手机竖屏 + 触屏拖拽
  // 开触摸模拟必须重新加载页面：Phaser 在启动那一刻就按当时的设备能力决定接不接管触摸，
  // 事后打开模拟，它已经不认了——上一版就是这么白测的，触屏拖拽一发没出。
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: PAGE });
  await waitFor('window.__debug && window.__debug.game.isBooted', 9000);
  // 常量真的从页面取：此前这里注释写着"避免和 data.js 各写一份"，
  // 值却是手写的 8 和 0.55——改了 data.js 这两条断言也不会跟着动，注释在说谎。
  // DATA 是 data.js 里的顶层 const（全局词法绑定，不是 window 属性），evaluate 取得到。
  // 每次重新加载页面都要重取一遍（换设备重载后是新的一份 DATA）
  DATA_WEAPON_COUNT = await evaluate('DATA.WEAPONS.length');
  DATA_CAM_MIN = await evaluate('DATA.CAM.minZoom');
  DATA_HP = await evaluate('DATA.HP');
  // 后手贴目（player 1 开局多这么多血）不在这里读缓存：出厂值是**分档表**，
  // 满血随场上的 mode/level 变，各断言按需现算——见 komiNow()
  await evaluate(AIM_HIT);
  await tap('btn-duo');                       // 触屏点按钮开局（重载后还没对局，state() 是 null）
  await waitFor('window.__debug.ready() && __debug.state().mode === "duo"', 5000);
  await evaluate(FAST);
  await waitFor(`__debug.state() && __debug.state().phase === 'aim'`, 4000);
  s = await st();
  check('S10 手机竖屏相机缩放不低于下限', s.zoom >= DATA_CAM_MIN - 1e-6, `zoom=${s.zoom.toFixed(2)}`);

  // S-5 手机竖屏装不下整张地图（1600px 宽按 0.55 下限缩放也要 709px 视野），
  // 所以开局必须把镜头挪到当前射手身上。此前只有 nextTurn 挪镜头，**第一回合**没人管，
  // 玩家一上来就看不见自己人，第二回合起才自愈（390×844 实测 8 局里 6 局射手不完整）。
  // 聚焦是 420ms 的补间动画（不是瞬移），所以要等它落定再判——立刻读只会读到起步状态
  const focusOf = () => evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), cam=sc.cameras.main;
    const s=sc.s, p=s.players[s.turn], v=cam.worldView, pe=cam.panEffect;
    return { on: p.x>=v.x && p.x<=v.right && p.y>=v.y && p.y<=v.bottom,
             px:Math.round(p.x), py:Math.round(p.y),
             vx:Math.round(v.x), vr:Math.round(v.right), vy:Math.round(v.y), vb:Math.round(v.bottom),
             // 排障用：镜头自己怎么想。失败时只报四个边界，看不出"是没挪、还是挪了又回来"
             sx:Math.round(cam.scrollX), phase:s.phase, running:!!pe.isRunning,
             fps:Math.round(__debug.game.loop.actualFps), scenePaused:!sc.scene.isActive() }; })()`);
  // 先等补间落定，再判"射手在不在屏幕里"。不这么写的话，补间走到一半（镜头正路过
  // 射手附近）也会读到 on:true——那是蒙对的，不是镜头真的对上了
  const settled = await waitCamIdle();
  const focus = await focusOf();
  check('S-5 首回合镜头把射手带进手机屏幕', settled && focus.on,
    `${JSON.stringify(focus)} 补间落定=${settled}`);

  // 回合开始会自动预选投石（第一件，最左边那格）。手机屏窄，它正好在屏外——
  // 不主动滚进视野，玩家有力度条有准星，却看不到自己手里拿的是什么
  const onSlot = await evaluate(`(() => { const b=document.getElementById('weapons'), on=b.querySelector('.wslot.on');
    if (!on) return { ok:false, why:'no-on' };
    const r=on.getBoundingClientRect(), br=b.getBoundingClientRect();
    return { ok: r.left>=br.left-1 && r.right<=br.right+1, name: on.querySelector('.wname').textContent,
             l:Math.round(r.left), r:Math.round(r.right), bl:Math.round(br.left), brr:Math.round(br.right) }; })()`);
  check('S10 选中的武器槽滚进了视野', onSlot.ok, JSON.stringify(onSlot));

  // 八个槽按 58px 排要 522px，390px 的手机一屏放不下，武器栏得能横向滚到两头。
  // 早先用 justify-content:center + overflow-x:auto：内容比容器宽时两头等量溢出，
  // 而滚动区只向右延伸，最左边那格（投石，唯一无限弹药的兜底武器）看得见摸不着
  const wb = await evaluate(`(() => { const b=document.getElementById('weapons'), sl=b.querySelectorAll('.wslot');
    const bl = b.getBoundingClientRect().left, brr = b.getBoundingClientRect().right;
    b.scrollTo({ left: 0, behavior: 'instant' });
    const firstOk = sl[0].getBoundingClientRect().left >= bl - 1;
    b.scrollTo({ left: b.scrollWidth, behavior: 'instant' });
    const lastOk = sl[sl.length-1].getBoundingClientRect().right <= brr + 1;
    const z = sl[0].getBoundingClientRect();
    return { firstOk, lastOk, w:Math.round(z.width), h:Math.round(z.height), sw:b.scrollWidth, cw:b.clientWidth }; })()`);
  check('S10 武器栏两端都滚得到', wb.firstOk && wb.lastOk, JSON.stringify(wb));
  check('S10 缩窄后仍不低于 44px 触控下限', wb.w >= 44 && wb.h >= 44, `${wb.w}×${wb.h}`);

  // 竖屏提示原先挂 top:12px，正好压在两条血条上把血量挡住
  const rot = await evaluate(`(() => { const r=document.getElementById('rotate');
    if (r.hidden) return { on:false };
    const rr=r.getBoundingClientRect(), hb=document.getElementById('p0card').getBoundingClientRect();
    return { on:true, gap:Math.round(rr.top-hb.bottom), bottom:Math.round(rr.bottom), vh:innerHeight }; })()`);
  check('S10 竖屏提示不压血条且在屏内', !rot.on || (rot.gap >= 0 && rot.bottom <= rot.vh), JSON.stringify(rot));

  // 对手越屏指示：竖屏一屏只装得下世界宽度的四成，相机又跟着射手走，
  // 不贴边指个方向就是对着看不见的目标盲投。把对手挪到天边逼出指示再还原。
  // 这里的 centerOn 必须先等首回合聚焦补间跑完再调：补间每帧都在写 scrollX，
  // 半路插进去的 centerOn 下一帧就被它盖掉，位置又回到射手身上（实测就是栽在这）
  await waitCamIdle();
  const keepX = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), s=sc.s;
    const k = s.players[1].x; s.players[1].x = 5000;
    sc.cameras.main.centerOn(s.players[s.turn].x, s.players[s.turn].y); return k; })()`);
  await frames(3);
  const foe = await evaluate(`(() => { const el=document.getElementById('foe');
    if (el.hidden) return { on:false };
    const r=el.getBoundingClientRect();
    return { on:true, txt:el.textContent, l:Math.round(r.left), r:Math.round(r.right), iw:innerWidth,
             inside: r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight }; })()`);
  check('S10 对手越屏时贴边指示方向', foe.on && foe.inside && /→/.test(foe.txt || ''), JSON.stringify(foe));
  await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'); sc.s.players[1].x = ${keepX}; return true; })()`);
  // 把镜头挪到对手身上，指示该自己收起来。
  // 注意不能靠"还原对手坐标"来验收起：竖屏视野只有 709 世界像素宽，
  // 而两人间距最小 500，镜头跟着射手时对手本来就常年在外——那正是这条指示存在的理由
  const centered = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), cam=sc.cameras.main, s=sc.s;
    const want = s.players[1].x; cam.centerOn(want, s.players[1].y);
    return { want: Math.round(want), after: Math.round(cam.scrollX), panning: !!cam.panEffect.isRunning }; })()`);
  await frames(3);
  const foeCam = await evaluate(`(() => { const sc=__debug.game.scene.getScene('battle'), cam=sc.cameras.main, s=sc.s;
    const v=cam.worldView;
    return { hidden:document.getElementById('foe').hidden, sx:Math.round(cam.scrollX),
             running:!!cam.panEffect.isRunning, fx:Math.round(s.players[1].x),
             inView: s.players[1].x>=v.x && s.players[1].x<=v.right }; })()`);
  check('S10 对手在视野内时指示自动收起', foeCam.hidden === true && centered.panning === false,
    `${JSON.stringify(foeCam)} 聚焦时 ${JSON.stringify(centered)}`);

  const shotsBefore = (await st()).shots[0];
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 430 }] });
  for (let i = 1; i <= 7; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200 - i * 15, y: 430 + i * 9 }] }); await sleep(24); }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(260);
  s = await st();
  check('S10 触屏拖拽也能出手', s.shots[0] > shotsBefore, `shots ${shotsBefore} → ${s.shots[0]}`);
  // 收尾：这一发落地后双人模式会弹交接遮罩，而遮罩 z-index 40 压着 HUD(z-index 20)，
  // 不关掉它，下面 S12 的"暂停""重开""回主菜单"三个点击全被它吃掉
  // （症状是重开无效、血条还留着上一局的伤）。点击本身是玩家的正常操作，属于测试收尾。
  // 要等到交接遮罩真弹出来（impact 只有 40ms，等"不是 fly"会撞进 impact 就返回，
  // 遮罩晚一步才出现，关了个寂寞）
  await waitFor(`window.__debug.state() && (() => { const s = __debug.state();
    return s.phase === 'handoff' || s.phase === 'aim' || s.winner !== null; })()`, 9000);
  const closed = await evaluate(`(() => { const h = document.getElementById('handoff');
    if (!h || h.hidden) return 'none';
    document.getElementById('btn-handoff').click(); return 'closed'; })()`);
  if (closed === 'closed') console.log('   · S10 收尾：关掉交接遮罩');
  await sleep(200);

  // S11 横屏（转屏后画面要重新贴合）
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await evaluate(`__debug.game.scene.getScene('battle').layout()`);
  await sleep(300);
  s = await st();
  check('S11 转横屏后相机重新贴合', s.zoom > 0.1, `zoom=${s.zoom.toFixed(2)}`);

  // S12 暂停 / 重开（全程用触屏点，顺带验证遮罩上的按钮在手机上点得到）
  await tap('btn-pause');
  await sleep(240);
  d = await dom();
  check('S12 暂停遮罩弹出', d.pause);
  await tap('btn-resume');
  await sleep(240);
  check('S12 继续后遮罩收起', !(await dom()).pause);
  const beforeRestart = (await st()).shots[0];
  await tap('btn-pause'); await sleep(200);
  await tap('btn-restart'); await sleep(900);
  s = await st();
  K = await komiNow();
  check('S12 重开是一局新的满血对局',
    s && s.hp[0] === DATA_HP && s.hp[1] === DATA_HP + K && s.winner === null && s.shots[0] < beforeRestart,
    `hp=${s && s.hp.join('/')}（满血 ${DATA_HP}/${DATA_HP + K}） shots=${s && s.shots[0]}`);

  // S12b 重开竞态回归（测试方 T-4/T-5 报、审计 A-9 严重#1 独立复现，此前冒烟测不到）
  // 根因：场景时钟上的 delayedCall 不随重开作废，上一局的 nextTurn / endGame 会在新局里醒来。
  // 为什么老冒烟漏了：S12 重开时"没有弹丸在飞"，上一局没排下任何回调，是这条路径的盲点。
  // 两个可复现窗口，这里各打一遍，都走真实 UI 路径（暂停 → 重开）：
  //   ① 非致命命中刚判定、还没交接时重开 → 旧局的 nextTurn 推进新局，玩家一的回合被跳过
  //   ② 致命命中刚判定、还没结算时重开（对手压到 1 血）→ 新局被判出胜负，结算页写"100 对 112"
  // 触发点都是"命中已判定、旧局还没交接"那段（IMPACT_HOLD 800ms / 击杀 620ms）——
  // 旧局正是在那一刻往时钟上排回调。**飞行中**重开排不到任何回调，不构成窗口：
  // 最初把窗口①写成"飞行中"，在未修复的代码上照样绿，是个假窗口，已改。
  // 两个窗口都验过有牙：在修复前的代码上跑，②稳定报红（结算页弹出、winner=0）。
  // 断言不只看重开那一瞬，而是接着观察 5 秒（旧回调本该在这段时间里醒来）：
  // 新局必须始终满血、turn 停在 0、发数 0/0、结算页不弹。
  // 5 秒足够：回合软时限是 30 游戏秒，而 headless 里页面时钟比墙钟慢，正常不会误触发。
  async function restartRace(waitExpr, lethal) {
    // lethal：对手压到 1 血、这一发必杀 → 旧局排下的回调是 endGame；不 lethal → 是 nextTurn。
    // 两个窗口要的正是这两种回调各一条，所以不能都用 lethal
    // 每个窗口都先回到一局干净的新局。未修复时上一个窗口会把局面搞脏（turn 跳到 1、
    // 停在 handoff），不重置的话第二个窗口会连锁失败在一个无关的原因上——
    // 实测报的是 "这一发没打出去（not-aim）"，那线索会把人带偏
    let clean = false;
    for (let i = 0; i < 25; i++) {
      const c = await st();
      if (c && c.phase === 'aim' && c.turn === 0 && c.winner === null && c.shots[0] === 0) { clean = true; break; }
      await tap('btn-pause'); await sleep(100);
      await tap('btn-restart'); await sleep(400);
    }
    if (!clean) {
      // 复位用的是"重开"，而未修复时重开这条路本身就是坏的（正是被测量的缺陷），
      // 于是复位可能也失败。这时报"复位失败"，别把它伪装成"跳过"——那是同一个病的症状
      return { skip: '复位失败：连重开都回不到干净的新局（这本身就是重开竞态的症状）' };
    }
    await evaluate(lethal ? '__debug.setHp(1, 1);' : '__debug.setHp(1, DATA.HP);');
    // 触发必须发生在**页面里**：窗口只有 IMPACT_HOLD = 900ms 游戏时间，而 CDP 一个往返
    // 就是几十毫秒，外部"轮询发现 impact → 再点暂停"整条路会**整个错过窗口**——实测
    // 点下去时旧局已经交接完了（phase=handoff、turn=1），看起来像"重开没生效"，
    // 其实是根本没点进窗口，测的根本不是那个竞态。
    // 改成在页面里用 rAF 盯同一个条件，一命中立刻走真实 UI 按钮，不赔往返。
    // 顺带点一下暂停：它把场景时钟冻住，这 900ms 的窗口就不再流逝，判定不再和调度赛跑
    await evaluate(`(() => {
      window.__race = null;
      const tick = () => {
        if (__debug.ready() && (${waitExpr})) {
          window.__race = __debug.state();
          document.getElementById('btn-pause').click();
          // 重开要等两帧再点。真人也是先看见遮罩、再点按钮，两下不可能落在同一帧；
          // 同一帧连点会把"暂停"和"重开"两个场景操作排进同一次队列派发，队列里的暂停
          // 落到已经被重开拆掉的场景上，Phaser 报 "Cannot pause non-running Scene"。
          // 那是同帧连点造出来的假告警（实测隔两帧就没了），不是产品缺陷，别去改产品迁就它
          requestAnimationFrame(() => requestAnimationFrame(
            () => document.getElementById('btn-restart').click()));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    const fired = await evaluate('__aimHit()');
    if (fired !== 'fired') return { skip: `这一发没打出去（${fired}）` };
    let race = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !race) {
      race = await evaluate('window.__race');
      if (!race) await sleep(16);
    }
    if (!race) return { skip: `页面里的自触发没等到 ${waitExpr}（15s）` };
    const t1 = Date.now();
    let sawOver = false, maxTurn = -1, last = null, sawNull = false;
    while (Date.now() - t1 < 5000) {
      last = await st();
      if (!last) { sawNull = true; break; }
      maxTurn = Math.max(maxTurn, last.turn);
      if (await evaluate(`!document.getElementById('over').hidden`)) sawOver = true;
      await sleep(40);
    }
    // race 一并带回去，进失败详情：失败时要能一眼看出"到底有没有点进窗口"。
    // 这一条吃过亏——窗口没点进去时现象（末态是旧局在跑）和"重开没生效"一模一样，
    // 只看末态会把"测错了"当成"产品坏了"，反过来也会把假绿当成通过
    return { last, sawOver, maxTurn, sawNull, race };
  }

  // 两个窗口的触发点都是"命中已判定、旧局还没交接"这段（IMPACT_HOLD 800ms / 击杀 620ms）：
  // 这才是旧局往时钟上排回调的时刻。**飞行中**重开排不到任何回调（那时候定时器还没排），
  // 所以不构成窗口——最初把窗口①写成"飞行中"，实测在未修复的代码上也照样绿，是假窗口。
  const raceCases = [
    ['非致命命中后重开', `__debug.state().phase === 'impact'`, false],
    ['击杀判定中重开', `__debug.state().phase === 'impact'`, true],
  ];
  for (const [tag, waitExpr, lethal] of raceCases) {
    const r = await restartRace(waitExpr, lethal);
    if (r.skip) { check(`S12b ${tag}：新局干净`, false, r.skip); continue; }
    const c = r.last;
    const ok = !r.sawNull && !r.sawOver && r.maxTurn === 0 && c && c.winner === null
      && c.shots[0] === 0 && c.shots[1] === 0
      && c.hp[0] === DATA_HP && c.hp[1] === DATA_HP + K;
    check(`S12b ${tag}：新局干净`, ok,
      `观察 5s 内 maxTurn=${r.maxTurn} 结算页=${r.sawOver} 末态 phase=${c && c.phase} `
      + `hp=${c && c.hp.join('/')} shots=${c && c.shots.join('/')} winner=${c && c.winner}`
      + `｜重开点在了 phase=${r.race.phase} turn=${r.race.turn} shots=${r.race.shots.join('/')}`
      + `（若不是 impact/turn 0/这一局刚出手，说明窗口根本没点进去，别当产品故障查）`);
  }

  // S13 静音
  const icon = await evaluate(`__debug.mute()`);
  check('S13 静音按钮切换且 SFX 关闭', icon === '🔇' && (await evaluate(`SFX.isEnabled()`)) === false, `icon=${icon}`);
  await evaluate(`__debug.mute()`);

  // S14 回到主菜单
  await tap('btn-pause'); await sleep(200);
  await tap('btn-quit'); await sleep(500);
  d = await dom();
  check('S14 回到主菜单且对战界面收起', d.title && !d.hud);

  check('S15 全程零控制台错误', errors.length === 0, errors.slice(0, 4).join(' | '));
}

// 这两个值在 main() 里从页面读（见读 DATA.WEAPONS.length 处），这里只开声明
let DATA_WEAPON_COUNT, DATA_CAM_MIN, DATA_HP;

let code = 0;
try {
  await main();
} catch (e) {
  console.log('❌ 冒烟中断: ' + e.message);
  if (errors.length) console.log('   控制台错误: ' + errors.slice(0, 5).join(' | '));
  code = 1;
} finally {
  try { ws && ws.close(); } catch {}
  await sleep(300);
  reapOne(inst);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n浏览器冒烟：${results.length - failed}/${results.length} 通过`);
process.exit(code || (failed ? 1 : 0));
