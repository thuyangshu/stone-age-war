// 单发直击率标定仪：锁定目标（同一目标第 N 发）之后，三档 AI 各自打得中几成。
//
// 用途：data.js 里"三档难度只由误差注入区分"这条设计，唯一的量尺就是**直击率**。
// 受击体形状、误差参数、武器伤害任何一项动了，都得拿这把尺子重量一遍，
// 否则"三档分得开"就是句空话（实测过一次：判定体从圆改成胶囊后，
// hard 直击率顶到 100%，三档当场合并成一档）。
//
// 用法：node tools/hitrate.cjs [每档局数，默认 1200] [hist=5] [武器 id，留空=按 aiChoose 自己选]
const LOGIC = require('../js/logic.js');
const WORLD = require('../js/world.js');

const N = Number(process.argv[2]) || 1200;
const HIST = process.argv[3] === undefined ? 5 : Number(process.argv[3]);
const FORCE = process.argv[4] || null;

// 与 bot-playtest 同一套种子基，量出来的东西能互相对照
const seedAt = (i) => 5000 + i * 13;

function measure(lv) {
  let n = 0, hit = 0;
  for (let i = 0; i < N; i++) {
    const seed = seedAt(i);
    const w = LOGIC.newBattle(seed);
    const me = LOGIC.newPlayer(w.spawns[0], 0);
    const foe = LOGIC.newPlayer(w.spawns[1], 1);
    const rng = WORLD.mulberry32(seed * 31 + 7);
    // aiChoose 的 hist 取自 players[me].shots，不是入参——不在这里设上，
    // 每发都会被当成"全新目标的第一发"，被 F30 的硬保证推着必偏，
    // 三档一律量出 0%（这个坑踩过一次）
    me.shots = HIST;
    let wp = FORCE ? LOGIC.DATAWEAPONS_FIND(FORCE) : null;
    let aim;
    if (wp) {
      aim = LOGIC.aiAim(w, me, foe, wp, lv, rng, HIST);
    } else {
      const act = LOGIC.aiChoose(w, [me, foe], 0, lv, rng);
      wp = act.wp; aim = act.aim;
    }
    const proj = LOGIC.makeProjectile(wp, me.x, me.y - 34, aim.angle, aim.power);
    proj.owner = 0;
    const r = LOGIC.simulate(w, proj, {}, { maxT: 20, players: [me, foe] });
    if (!r.impact) continue;
    n++;
    if (r.impact.type === 'direct') hit++;
  }
  return { lv, hit, n, rate: hit / n };
}

// 按 id 找武器（data.js 的 WEAPONS 是数组）
LOGIC.DATAWEAPONS_FIND = (id) => require('../js/data.js').WEAPONS.find((x) => x.id === id);

console.log(`锁定目标第 ${HIST} 发、每档 ${N} 局${FORCE ? '、固定武器 ' + FORCE : '、武器由 aiChoose 自选'}`);
console.log('─'.repeat(52));
// 标定基准：上一轮（旧圆判定体 + 旧误差）量到的 33 / 68 / 94。2026-09-27 换成胶囊并
// 放宽 easy×1.1、medium×1.3 之后是 73 / 90 / 100——三档仍然单调分得开，但**间距被压扁**，
// 且 hard 已顶到 99.9%（锁定后基本必中）。这组数字留着对照，不是验收线：
// 难度验收看的是 §五的三条胜率线，不是直击率本身。
const base = { easy: 0.73, medium: 0.90, hard: 1.00 };
for (const lv of ['easy', 'medium', 'hard']) {
  const r = measure(lv);
  console.log(`${lv.padEnd(7)} 直击率 ${(r.rate * 100).toFixed(1)}%   (${r.hit}/${r.n})   标定基准 ${(base[lv] * 100).toFixed(0)}%`);
}
