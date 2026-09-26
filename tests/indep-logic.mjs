// 独立测试员用例（逻辑层）· 与开发方用例分开存放，互不覆盖
// 覆盖开发方用例里没有的：大海量种子扫描、风参数、angleRange、FIRST_SHOT_BIAS/CONVERGE、
// F31 换武器、F17 同帧直击优先、以及更宽的 fuzz 种子域
// 用法：node tests/indep-logic.mjs       （只读 js/，不改任何产品代码）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../js/data.js');
const W = require('../js/world.js');
const L = require('../js/logic.js');

const DEG = L.DEG;
let pass = 0, fail = 0;
const bad = [];
function ck(cond, name, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; bad.push(`${name} — ${detail}`); console.log(`❌ ${name}${detail ? '  ' + detail : ''}`); }
}
const flat = (gy = D.TERRAIN.GROUND_Y) => ({
  seed: 0, h: new Float64Array(W.N).fill(gy), hills: [], ponds: [], bushes: [], decos: [], spawns: [],
});
const P = (x, y, hp = 100) => ({ x, y, hp, burn: null, ammo: {}, shots: 0 });

// ─────────────────────────────────────────────────────────────
console.log('\n══ A. F2/F3 大地图扫描：400 个种子的站位与地形 ══');
{
  const S = D.TERRAIN.SPAWN;
  let fb = 0, noSpawn = 0, wet = 0, gapBad = 0, halfBad = 0, bushHit = 0, surfBad = 0, unreach = 0;
  const fbSeeds = [], wetSeeds = [], unreachSeeds = [];
  for (let seed = 1; seed <= 400; seed++) {
    const w = L.newBattle(seed);
    const [a, b] = w.spawns || [];
    if (!a || !b) { noSpawn++; continue; }
    if (w.spawnFallback) { fb++; fbSeeds.push(seed); }
    if (a.x < S.left[0] || a.x > S.left[1] || b.x < S.right[0] || b.x > S.right[1]) halfBad++;
    const gap = b.x - a.x;
    if (gap < S.gap[0] || gap > S.gap[1]) gapBad++;
    for (const p of [a, b]) {
      if (!Number.isFinite(p.y) || Math.abs(p.y - W.surfaceAt(w, p.x)) > 0.01) surfBad++;
      const pond = W.pondAt(w, p.x);
      if (pond && W.surfaceAt(w, p.x) >= pond.y - 4) { wet++; wetSeeds.push(seed); }
      // 角色身体（宽 ±20、高 62）不许插进灌木里
      for (const bu of w.bushes) {
        const bh = { x0: bu.x, x1: bu.x + bu.w, y0: bu.y, y1: bu.y + bu.h };
        if (p.x + 20 > bh.x0 && p.x - 20 < bh.x1 && p.y > bh.y0 && p.y - 62 < bh.y1) bushHit++;
      }
    }
    const stone = D.WEAPONS[0];
    if (!L.reachable(w, a, b, stone) || !L.reachable(w, b, a, stone)) { unreach++; unreachSeeds.push(seed); }
  }
  ck(noSpawn === 0, 'A1 400 个种子都有两个站位', `无站位 ${noSpawn}`);
  ck(fb === 0, 'A2 无兜底站位（兜底可能站水里/打不到）', fb ? `兜底 ${fb} 次，种子 ${fbSeeds.slice(0, 8)}` : '0');
  ck(halfBad === 0, 'A3 站位在各自半区', `越界 ${halfBad}`);
  ck(gapBad === 0, 'A4 间距落在 500–1200px', `越界 ${gapBad}`);
  ck(surfBad === 0, 'A5 站位 y 与地表一致（不悬空/不埋地）', `不一致 ${surfBad}`);
  ck(wet === 0, 'A6 站位干燥、不落水', wet ? `${wet} 次，种子 ${wetSeeds.slice(0, 8)}` : '0');
  ck(bushHit === 0, 'A7 站位不卡在灌木里', `重叠 ${bushHit}`);
  ck(unreach === 0, 'A8 投石双向可达', unreach ? `${unreach} 次，种子 ${unreachSeeds.slice(0, 8)}` : '0');
}

console.log('\n══ B. F26 风参数：wind 必须真的改变弹道 ══');
{
  const w = flat();
  // 力度 1 打在平地上射程正好 1600px，从 x=300 出发必然飞出世界（三档落点都是 1601=出界），
  // 量不出风的差别。压到半力让落点留在世界内。
  const run = (wind) => {
    const p = L.makeProjectile(D.WEAPONS[0], 300, 600, 45 * DEG, 0.5);
    const r = L.simulate(w, p, { wind }, { maxT: 8 });
    return r.impact ? r.impact.x : r.pts[r.pts.length - 1].x;
  };
  const endA = run(0), endB = run(3), endC = run(-3);
  ck(Math.abs(endB - endA) > 20, 'B1 顺风确实吹远（wind=3 与 wind=0 落点不同）',
    `落点 ${endA.toFixed(0)} → ${endB.toFixed(0)}，差 ${(endB - endA).toFixed(0)}px`);
  ck(endB > endA && endC < endA, 'B2 风向符号正确（正风向右吹）',
    `wind=-3 落点 ${endC.toFixed(0)} < 0 风 ${endA.toFixed(0)} < +3 风 ${endB.toFixed(0)}`);
  ck(Math.abs((endB - endA) - (endA - endC)) < 12, 'B3 正负风对称',
    `右偏 ${(endB - endA).toFixed(1)}px / 左偏 ${(endA - endC).toFixed(1)}px`);
  // 线性度：风加速度 ×2，偏移应 ×2（WIND_ACCEL 是加速度不是位移）
  const endD = run(6);
  const r1 = endB - endA, r2 = endD - endA;
  ck(Math.abs(r2 - r1 * 2) < 12, 'B4 风级与偏移成线性（每级 WIND_ACCEL 加速度）',
    `3 级偏 ${r1.toFixed(1)}px，6 级偏 ${r2.toFixed(1)}px`);
  ck(D.PHYS.WIND_ACCEL > 0, 'B5 WIND_ACCEL 已配置（P1 风恒 0 但结构在位）', `${D.PHYS.WIND_ACCEL}`);
  ck(true, 'B6 P1 恒 0 级由 game.js `ctx = { wind: 0 }` 保证（代码审查，见报告台账）');
}

console.log('\n══ C. F14 angleRange：出手仰角夹在 5°–85° ══');
{
  const [lo, hi] = D.PHYS.ANGLE;
  const right = L.angleRange(400, 1000);
  const left = L.angleRange(1200, 600);
  ck(Math.abs(right[0] - lo * DEG) < 1e-12 && Math.abs(right[1] - hi * DEG) < 1e-12,
    'C1 朝右：5°–85°', `[${(right[0] / DEG).toFixed(1)}°, ${(right[1] / DEG).toFixed(1)}°]`);
  ck(Math.abs(left[0] - (180 - hi) * DEG) < 1e-12 && Math.abs(left[1] - (180 - lo) * DEG) < 1e-12,
    'C2 朝左：95°–175°（镜像）', `[${(left[0] / DEG).toFixed(1)}°, ${(left[1] / DEG).toFixed(1)}°]`);
  // solveShot 的解必须全部落在 angleRange 内（否则 UI 夹不住 AI 解）
  let outside = 0;
  for (let s = 1; s <= 100; s++) {
    const w = L.newBattle(s);
    const [a, b] = w.spawns;
    for (const [from, to] of [[a, b], [b, a]]) {
      const [l, h] = L.angleRange(from.x, to.x);
      const sol = L.solveShot(D.WEAPONS[0].v, D.PHYS.G, to.x - from.x, (to.y - 30) - (from.y - 34));
      if (!sol) continue;
      for (const ang of [sol.low, sol.high]) if (ang !== null && (ang < l - 1e-9 || ang > h + 1e-9)) outside++;
    }
  }
  ck(outside === 0, 'C3 100 张图上解析解都落在合法区间内', `越界 ${outside} 个`);
}

console.log('\n══ D. F17 命中判定顺序：同子步内对手与地面都中，只算直击 ══');
{
  const w = flat();
  const gy = D.TERRAIN.GROUND_Y;
  const ps = [P(300, gy), P(900, gy)];
  const FIELDS = (weapon, x, y, vx, vy) => ({
    x, y, px: x, py: y, vx, vy, weapon, g: D.PHYS.G * (weapon.gMul || 1), r: weapon.r,
    alive: true, age: 0, phase: 'fly', bounces: 0, spin: 0, owner: 0,
    origin: { x, y }, trail: [],
  });
  const stone = D.WEAPONS[0];
  // 一个子步内同时穿过对手碰撞圆（圆心 y=地表−30，半径 26+7=33）与地表：
  // 唯一构造方式是给单步位移大到一次跨过"圆顶(y=gy−63) → 地表(y=gy)"这段，
  // 正式武器 6.7px/步做不到，所以手搓一发高速弹丸，专测 tie-break 分支本身。
  const p = FIELDS(stone, 900, gy - 100, 0, 30000);
  const r = L.simulate(w, p, {}, { players: ps, maxT: 1, sampleEvery: 1 });
  ck(r.impact && r.impact.type === 'direct' && r.impact.who === 1,
    'D1 同子步内先入碰撞圆再触地 → 判直击', `实际 ${r.impact && r.impact.type}/${r.impact && r.impact.who}`);
  const out = L.settleImpact(r.impact, stone, [P(300, gy), P(900, gy)], 0);
  ck(out.hits.length === 1 && out.hits[0].kind === 'direct' && out.hits[0].who === 1,
    'D2 该命中只结算一条直击伤害，不再叠加落地溅射',
    `hits=${JSON.stringify(out.hits)}`);
  // 反向：地表先被扫到（对手在更远、弹道中途就砸地），不许误判成直击
  const far = [P(300, gy), P(1400, gy)];
  const p2 = L.makeProjectile(stone, 300, gy - 30, 0.001, 0.25);
  p2.owner = 0;
  const r2 = L.simulate(w, p2, {}, { players: far, maxT: 10 });
  ck(r2.impact && r2.impact.type === 'ground', 'D3 半路落地不会误判成直击远处对手',
    `实际 ${r2.impact && r2.impact.type}`);
  // 实战形态：用解析解打到站在地上的对手胸口，必须是直击而不是触地
  let direct = 0, other = 0;
  for (const [dx, sx] of [[600, 300], [700, 200], [500, 400], [-600, 1000], [-700, 900]]) {
    const sy = gy, tx = sx + dx, ty = gy - 30;
    const sol = L.solveShot(stone.v, D.PHYS.G, dx, ty - (sy - 34));
    if (!sol) continue;
    for (const arc of [sol.low, sol.high]) {
      if (arc === null) continue;
      const pp = L.makeProjectile(stone, sx, sy - 34, arc, 1);
      pp.owner = 0;
      const rr = L.simulate(w, pp, {}, { players: [P(sx, sy), P(tx, ty)], maxT: 12 });
      if (!rr.impact) continue;
      if (rr.impact.type === 'direct') direct++; else other++;
    }
  }
  ck(direct > 0 && other === 0, 'D4 解析解打站在地上的对手：全部记直击',
    `直击 ${direct}，其它 ${other}`);
}

console.log('\n══ E. F30 AI 首发放大 / 随轮次收敛 ══');
{
  const w = L.newBattle(4);
  const me = { x: w.spawns[0].x, y: w.spawns[0].y };
  const foe = { x: w.spawns[1].x, y: w.spawns[1].y };
  const spreadLv = (level, hist, n = 400) => {
    const rng = W.mulberry32(99);
    let sq = 0;
    const zero = () => 0.5;
    for (let i = 0; i < n; i++) {
      const a = L.aiAim(w, me, foe, D.WEAPONS[0], level, rng, hist);
      const b = L.aiAim(w, me, foe, D.WEAPONS[0], level, zero, hist);
      sq += (a.angle - b.angle) ** 2 + (a.power - b.power) ** 2;
    }
    return Math.sqrt(sq / n);
  };
  const spread = (hist, n = 400) => spreadLv('hard', hist, n);
  // 收敛倍率 k(h) 完全由 DATA 三个旋钮决定；触底的轮次也算出来，别写死轮数
  const kAt = (h) => Math.max((h === 0 ? D.AI.FIRST_SHOT_BIAS : 1)
    * D.AI.CONVERGE ** Math.max(0, h - 1), D.AI.MIN_ERR_RATIO);
  const hFloor = Math.max(1, 1 + Math.ceil(Math.log(D.AI.MIN_ERR_RATIO) / Math.log(D.AI.CONVERGE)));
  const s0 = spread(0), s1 = spread(1), s2 = spread(2), s3 = spread(3);
  const sF = spread(hFloor), sF2 = spread(hFloor + 6);
  ck(s0 > s1 * 1.4, 'E1 首发（hist=0）误差显著大于后续发（FIRST_SHOT_BIAS 生效）',
    `首发 ${s0.toFixed(4)} vs 次发 ${s1.toFixed(4)}，比 ${(s0 / s1).toFixed(2)}（BIAS=${D.AI.FIRST_SHOT_BIAS}）`);
  // F30 后半句"误差随射击轮次收敛"：hist≥1 起不再有首发偏移，散布就是注入误差本身
  ck(s1 > s2 * (1 / D.AI.CONVERGE) * 0.95 && s2 > s3 * (1 / D.AI.CONVERGE) * 0.95,
    'E2 误差随射击轮次逐发收敛（F30 后半句），收敛幅度与 CONVERGE 一致',
    `h1=${s1.toFixed(4)} > h2=${s2.toFixed(4)} > h3=${s3.toFixed(4)}，`
    + `实测 ${(s1 / s2).toFixed(3)}/${(s2 / s3).toFixed(3)} vs 1/CONVERGE=${(1 / D.AI.CONVERGE).toFixed(3)}`);
  // 收敛有下限：到 MIN_ERR_RATIO 就稳住（CONVERGE 再乘下去也不动了）
  ck(sF > 0 && Math.abs(sF - sF2) / sF < 0.2, 'E2b 收敛触底后稳住，不会一路归零',
    `h${hFloor}=${sF.toFixed(4)} h${hFloor + 6}=${sF2.toFixed(4)} 差 ${(Math.abs(sF - sF2) / sF * 100).toFixed(1)}%`);
  ck(kAt(0) > kAt(1) && kAt(1) > kAt(hFloor) && kAt(hFloor) === D.AI.MIN_ERR_RATIO
    && kAt(hFloor) === kAt(hFloor + 6),
    'E2c 逐发收敛倍率与 DATA 里的旋钮一致（首发放大→逐发乘 CONVERGE→触底 MIN_ERR_RATIO）',
    `BIAS=${D.AI.FIRST_SHOT_BIAS} CONVERGE=${D.AI.CONVERGE} MIN_ERR_RATIO=${D.AI.MIN_ERR_RATIO}，`
    + `触底于 h${hFloor}，k(0..3,h${hFloor},h${hFloor + 6})=`
    + `${[0, 1, 2, 3, hFloor, hFloor + 6].map((h) => kAt(h).toFixed(3)).join(' / ')}`);
  // 收敛有下限：不许归零，否则退化成"双方必中"的伤害竞速
  const s40 = spread(40, 400);
  ck(s40 > 0, 'E3 误差不会归零（MIN_ERR 生效，保住手感波动）', `h40=${s40.toFixed(4)}`);

  // F30 原文"第一发必偏"：实测首发直击率与"落点离靶心多远"
  // 代码里 aiAim 对 hist=0 先把瞄点沿连线法向挪开 FIRST_MISS_MIN 像素（硬保证不直击）。
  // 挪开的是"瞄点"，可是选弧的代价函数里 direct（直击）权重 -1，远比 miss/100 大，
  // 于是只要有一条弧能穿过对手，它就会胜出并 break——偏移瞄点被整个绕过。
  let firstHit = 0, laterHit = 0, firstN = 0, laterN = 0;
  const firstMiss = [];
  for (let s = 1; s <= 120; s++) {
    const ww = L.newBattle(s);
    const m = { x: ww.spawns[0].x, y: ww.spawns[0].y };
    const f = { x: ww.spawns[1].x, y: ww.spawns[1].y };
    for (let k = 0; k < 6; k++) {
      const rng = W.mulberry32(s * 31 + k);
      const aim = L.aiAim(ww, m, f, D.WEAPONS[0], 'hard', rng, k);
      const proj = L.makeProjectile(D.WEAPONS[0], m.x - 0, m.y - 34, aim.angle, aim.power);
      proj.owner = 0;
      const r = L.simulate(ww, proj, {}, {
        players: [{ x: m.x, y: m.y, hp: 100 }, { x: f.x, y: f.y, hp: 100 }], maxT: 14,
      });
      const e = r.events[0];
      const hit = !!(e && e.type === 'direct');
      if (k === 0) {
        firstN++; if (hit) firstHit++;
        if (e) firstMiss.push(Math.hypot(e.x - f.x, e.y - (f.y - 30)));
      } else { laterN++; if (hit) laterHit++; }
    }
  }
  firstMiss.sort((a, b) => a - b);
  const med = firstMiss[Math.floor(firstMiss.length / 2)];
  ck(true, 'E4 首发直击率实测（供判定"第一发必偏"是否字面成立）',
    `首发直击 ${firstHit}/${firstN} = ${(firstHit / firstN * 100).toFixed(1)}%，后续 ${(laterHit / laterN * 100).toFixed(1)}%`);
  ck(med >= D.AI.FIRST_MISS_MIN * 0.8, 'E4b 首发落点被真的推离靶心（偏移瞄点没被解算绕过）',
    `首发落点距靶心中位 ${med.toFixed(1)}px，最小 ${firstMiss[0].toFixed(1)}px`
    + `（偏移量 ${D.AI.FIRST_MISS_MIN}±20%，落点中位应≥${(D.AI.FIRST_MISS_MIN * 0.8).toFixed(0)}）`);
  if (firstHit / firstN > 0.05) {
    console.log(`   ⚠ F30 字面"第一发必偏"不成立：hard 档首发仍有 ${(firstHit / firstN * 100).toFixed(1)}% 直接命中，`
      + `首发落点距靶心最近的只有 ${firstMiss[0].toFixed(1)}px（直击判定半径约 33px）`);
  }
}

console.log('\n══ E2. F29 三档只由误差/选武区分，弹道解算与玩家共用同一套 ══');
{
  const w = L.newBattle(7);
  const me = { x: w.spawns[0].x, y: w.spawns[0].y };
  const foe = { x: w.spawns[1].x, y: w.spawns[1].y };
  const zero = () => 0.5;              // 零误差：把"误差注入"这一层摘掉
  const base = L.aiAim(w, me, foe, D.WEAPONS[0], 'hard', zero, 5);
  let same = 0;
  for (const lv of ['easy', 'medium', 'hard']) {
    const a = L.aiAim(w, me, foe, D.WEAPONS[0], lv, zero, 5);
    if (Math.abs(a.angle - base.angle) < 1e-12 && Math.abs(a.power - base.power) < 1e-12) same++;
  }
  ck(same === 3, 'E2-1 三档在零误差下解出完全相同的角度与力度（共用同一套解算）',
    `一致 ${same}/3 档`);
  // aiAim 里除 cfg 之外不应读任何按难度分支的东西
  const src = L.aiAim.toString();
  ck(!/level\s*===\s*'|level\s*!==\s*'|switch\s*\(level/.test(src),
    'E2-2 aiAim 不对难度写分支（只读 DATA.AI[level] 的参数）');
  const keys = new Set();
  for (const lv of ['easy', 'medium', 'hard']) for (const k of Object.keys(D.AI[lv])) keys.add(k);
  ck([...keys].every((k) => ['angErr', 'powErr', 'missChance', 'pickRandom', 'greedy'].includes(k)),
    'E2-3 三档配置只有误差与选武两类旋钮', [...keys].join(','));
}

console.log('\n══ F. F31 AI 够不着对手时换武器 ══');
{
  // 结论先摆事实：aiPickWeapon 的形参里根本没有 world，物理上不可能做可达性判断
  ck(/function aiPickWeapon\(players, me, level, rng\)/.test(L.aiPickWeapon.toString()),
    'F1 aiPickWeapon 形参无 world（代码事实）',
    L.aiPickWeapon.toString().split('\n')[0].trim());
  // 构造：把对手放到只有"射程最远"才够得着的距离，看 AI 是否仍选最贪心的巨石
  const w = flat();
  const players = [P(200, 700), P(1600 - 200, 700)];
  for (const p of players) for (const wp of D.WEAPONS) p.ammo[wp.id] = wp.ammo > 0 ? wp.ammo : Infinity;
  const picks = {};
  const rng = W.mulberry32(5);
  for (let i = 0; i < 200; i++) {
    const wp = L.aiPickWeapon(players, 0, 'hard', rng);
    picks[wp.id] = (picks[wp.id] || 0) + 1;
  }
  ck(true, 'F2 hard 档在 1200px 间距下的选武分布（是否考虑够不够得着）', JSON.stringify(picks));

  // 实战量化：模拟 300 局，统计"打出去落在离对手 250px 开外"的空放率
  let shots = 0, wasted = 0, hopeless = 0;
  for (let s = 2000; s <= 2300; s++) {
    const ww = L.newBattle(s);
    const [a, b] = ww.spawns;
    const me = { x: a.x, y: a.y }, foe = { x: b.x, y: b.y };
    const rng = W.mulberry32(s);
    for (const wp of D.WEAPONS) {
      const aim = L.aiAim(ww, me, foe, wp, 'hard', rng, 3);
      if (aim.hopeless) { hopeless++; continue; }
      const proj = L.makeProjectile(wp, me.x, me.y - 34, aim.angle, aim.power);
      proj.owner = 0;
      const r = L.simulate(ww, proj, {}, {
        players: [{ x: me.x, y: me.y, hp: 100 }, { x: foe.x, y: foe.y, hp: 100 }], maxT: 14,
      });
      shots++;
      const im = r.impact;
      if (!im) { wasted++; continue; }
      const d = Math.hypot(im.x - foe.x, im.y - (foe.y - 30));
      if (d > 250) wasted++;
    }
  }
  ck(true, 'F3 每件武器在 300 张图上对同一目标的空放率',
    `空放 ${wasted}/${shots} = ${(wasted / shots * 100).toFixed(1)}%，hopeless ${hopeless}`);
}

console.log('\n══ G. N5 更宽种子域的 fuzz（开发方只跑种子 1–500） ══');
{
  const levels = ['easy', 'medium', 'hard'];
  let nan = 0, stuck = 0, noSpawn = 0, bad = 0;
  const stuckSeeds = [];
  for (let i = 0; i < 900; i++) {
    const seed = 900000 + i * 7;
    const a = levels[i % 3], b = levels[(i + 1) % 3];
    const m = L.simulateMatch(seed, a, b);
    if (!m.ok) {
      if (m.reason === 'nan-hp') nan++;
      else if (m.reason === 'no-spawn') noSpawn++;
      else { stuck++; stuckSeeds.push(seed); }
      continue;
    }
    for (const p of m.players) {
      if (!Number.isFinite(p.hp) || p.hp < 0 || p.hp > D.HP) bad++;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) bad++;
    }
  }
  ck(nan === 0 && noSpawn === 0 && bad === 0, 'G1 900 局大种子域无 NaN / 无越界血量 / 无站位失败',
    `nan=${nan} noSpawn=${noSpawn} 血量越界=${bad}`);
  ck(stuck === 0, 'G2 900 局全部在 200 回合内分出胜负', stuck ? `${stuck} 局未分胜负，种子 ${stuckSeeds.slice(0, 6)}` : '0');
}

console.log('\n══ H. 回归：整局内不变量（血量单调不增、弹药不减、回合交替） ══');
{
  let hpUp = 0, ammoUp = 0, turnBad = 0, burnNeg = 0;
  for (let s = 1; s <= 120; s++) {
    const m = L.simulateMatch(s * 977 + 3, 'medium', 'hard');
    if (!m.ok) continue;
    const hp = [D.HP, D.HP];
    for (const e of m.log) {
      if (e.me === undefined) continue;
      if (e.turn % 2 !== e.me) turnBad++;
      if (e.burn && e.burn < 0) burnNeg++;
    }
    for (const p of m.players) if (p.hp > hp[0]) hpUp++;
  }
  ck(turnBad === 0, 'H1 出手方与回合号奇偶一致', `不符 ${turnBad}`);
  ck(burnNeg === 0, 'H2 燃烧伤害非负', `负值 ${burnNeg}`);
  // 弹药守恒：无限武器不会被打成 0
  const players = [P(300, 700), P(1200, 700)];
  for (const p of players) for (const wp of D.WEAPONS) p.ammo[wp.id] = wp.ammo > 0 ? wp.ammo : Infinity;
  players[0].ammo.stone = Infinity;
  for (let i = 0; i < 500; i++) {
    const wp = L.aiPickWeapon(players, 0, 'hard', Math.random);
    if (Number.isFinite(players[0].ammo[wp.id])) players[0].ammo[wp.id]--;
  }
  ck(players[0].ammo.stone === Infinity, 'H3 无限弹药武器永远打成 Infinity（兜底武器不消失）',
    `stone=${players[0].ammo.stone}`);
  ck(L.aiPickWeapon(players, 0, 'hard', Math.random).id !== undefined, 'H4 弹药见底仍能选出武器');
}

console.log(`\n──────── 独立逻辑用例：${pass} 通过 / ${fail} 失败 ────────`);
if (bad.length) { console.log('失败项：'); for (const b of bad) console.log('  · ' + b); }
process.exit(fail ? 1 : 0);
