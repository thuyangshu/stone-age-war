// 弹道、碰撞、伤害、AI、对局规则的纯逻辑测试
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const W = require('../js/world.js');
const L = require('../js/logic.js');

const flat = (groundY = D.TERRAIN.GROUND_Y) => {   // 一块平地，用来隔离弹道本身
  const h = new Float64Array(W.N).fill(groundY);
  return { seed: 0, h, hills: [], ponds: [], bushes: [], decos: [], spawns: [] };
};
const P = (x, y, hp = 100) => ({ x, y, hp, burn: null, ammo: {}, shots: 0 });

// 轨迹对某点的最近距离。
// 不能用"落点 vs 目标点"来验证解析解——弹丸穿过目标后还会继续飞到地面，
// 早先这么比，把"穿过"误判成 400px 偏差。最近距离才是"解得对不对"的正确度量。
const closest = (pts, tx, ty) => {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, Math.hypot(q.x - tx, q.y - ty));
  return best;
};
// 细采样模拟：1/240 步长下单步位移约 4.6px，取最近距离时误差上限约 2.3px
const fine = (w, p, ctx = {}, opts = {}) =>
  L.simulate(w, p, ctx, Object.assign({ maxT: 14, sampleEvery: 1 }, opts));

// ---------------- 数值表铁律 ----------------

test('回归：每件武器满力射程 ≥1500px（站位间距上限 1200 + 余量）', () => {
  for (const wp of D.WEAPONS) {
    const R = (wp.v * wp.v) / (D.PHYS.G * wp.gMul);
    assert.ok(R >= 1500, `${wp.name} 满力射程只有 ${R.toFixed(0)}px，够不着对手`);
  }
});

test('回归：单物理子步位移 < 弹丸直径（不穿模的数学前提）', () => {
  for (const wp of D.WEAPONS) {
    const step = wp.v * D.PHYS.SUB_DT;
    assert.ok(step < wp.r * 2, `${wp.name} 单步位移 ${step.toFixed(2)}px ≥ 直径 ${wp.r * 2}px，可能穿模`);
  }
});

test('回归：无限弹药武器（ammo:0）折算成 Infinity，且永远可选', () => {
  const ps = [P(200, 700), P(1200, 700)];
  for (const p of ps) for (const wp of D.WEAPONS) p.ammo[wp.id] = wp.ammo > 0 ? wp.ammo : Infinity;
  assert.equal(ps[0].ammo.stone, Infinity);
  // 把所有限量武器打光
  for (const wp of D.WEAPONS) if (Number.isFinite(ps[0].ammo[wp.id])) ps[0].ammo[wp.id] = 0;
  const picked = L.aiPickWeapon(ps, 0, 'hard', W.mulberry32(1));
  assert.equal(picked.id, 'stone', '限量武器打光后必须还能掏出投石，否则对局卡死');
});

// ---------------- 弹道 ----------------

test('回归：瞄向左边（dx<0）也要有解析解（曾导致后手方一枪打不中）', () => {
  const right = L.solveShot(1000, 900, 600, 0);
  const left = L.solveShot(1000, 900, -600, 0);
  assert.ok(right && right.low !== null, '向右应有平射解');
  assert.ok(left && left.low !== null, '向左也必须有解');
  // 左右对称：向左的平射角 = π − 向右的平射角
  assert.ok(Math.abs(left.low - (Math.PI - right.low)) < 1e-9);
  assert.ok(Math.abs(left.high - (Math.PI - right.high)) < 1e-9);
});

test('解析解往返：按解出的角度发射，弹道穿过目标点（误差 <6px）', () => {
  const v = 1100, g = 900;
  const w = flat();
  const sy = 600;
  for (const [dx, dy] of [[400, 0], [700, 80], [900, -120], [-600, 60], [-850, -90]]) {
    const s = L.solveShot(v, g, dx, dy);
    assert.ok(s, `dx=${dx} dy=${dy} 应有解`);
    const sx = dx < 0 ? 1000 : 500;          // 让目标点留在世界宽度内
    const tx = sx + dx, ty = sy + dy;
    assert.ok(tx > 0 && tx < D.TERRAIN.W, `目标 x=${tx} 应在世界内`);
    for (const ang of [s.low, s.high]) {
      if (ang === null) continue;
      const p = L.makeProjectile({ v, gMul: 1, r: 6 }, sx, sy, ang, 1);
      const r = fine(w, p);
      const err = closest(r.pts, tx, ty);
      assert.ok(err < 6, `角度 ${(ang / L.DEG).toFixed(1)}° dx=${dx} dy=${dy} 偏离目标 ${err.toFixed(1)}px`);
    }
  }
});

test('反解力度：给定仰角与力度，弹道穿过目标点（±8px）', () => {
  const vMax = 950, g = 900;
  const w = flat();
  const sy = 600;
  let cases = 0;
  for (const [dx, dy] of [[500, 40], [800, -60], [-700, 100], [-900, -40]]) {
    for (const elev of [25, 40, 55, 70]) {
      const pw = L.solvePower(vMax, g, dx, dy, elev * L.DEG);
      if (pw === null || pw > 1) continue;
      const sx = dx < 0 ? 1100 : 400;
      const ang = dx < 0 ? Math.PI - elev * L.DEG : elev * L.DEG;
      const p = L.makeProjectile({ v: vMax, gMul: 1, r: 6 }, sx, sy, ang, pw);
      const r = fine(w, p);
      const err = closest(r.pts, sx + dx, sy + dy);
      assert.ok(err < 8, `仰角 ${elev}° dx=${dx} dy=${dy} 偏离目标 ${err.toFixed(1)}px`);
      cases++;
    }
  }
  assert.ok(cases >= 10, `有效用例只有 ${cases} 组，覆盖太薄`);
});

test('回归：高抛弧线飞出世界顶部不算出界（曾把大仰角射击全判成打飞）', () => {
  const w = flat();
  const p = L.makeProjectile({ v: 1200, gMul: 1, r: 6 }, 300, 700, 80 * L.DEG, 1);
  const r = L.simulate(w, p, {}, { maxT: 14 });
  assert.equal(r.impact.type, 'ground', '顶点在 y<0 的高抛应当正常落地');
  assert.ok(r.pts.some((q) => q.y < 0), '这条弧线本应飞到画面上方之外');
});

test('高速平射不穿模：贴着山坡打必定命中地表', () => {
  const w = W.genTerrain(21);
  const fastest = D.WEAPONS.reduce((a, b) => (a.v > b.v ? a : b));
  for (let x = 100; x < D.TERRAIN.W - 100; x += 97) {
    const y = W.surfaceAt(w, x) - 20;
    const p = L.makeProjectile(fastest, x, y, 0.001, 1);   // 近乎水平
    const r = L.simulate(w, p, {}, { maxT: 6 });
    assert.ok(r.impact && r.impact.type !== 'out', `x=${x} 的平射穿出了世界`);
  }
});

// ---------------- 碰撞与伤害 ----------------

test('落水：有水花但零伤害', () => {
  const w = flat();
  w.ponds.push({ x0: 600, x1: 900, y: 700, rim: 760, bottom: 820, depth: 70 });
  for (let i = 0; i < W.N; i++) {
    const x = i * D.TERRAIN.SAMPLE;
    if (x >= 600 && x <= 900) w.h[i] = 800;   // 池底挖到水面之下
  }
  const ps = [P(300, 600), P(1200, 600)];
  // 低力度抛物线，落点算在池塘中段（x≈810）
  const p = L.makeProjectile(D.WEAPONS[0], 700, 600, 3 * L.DEG, 0.2);
  p.owner = 0;
  const r = L.simulate(w, p, {}, { players: ps, maxT: 12 });
  assert.equal(r.impact.type, 'water', '应该落进池塘');
  const out = L.settleImpact(r.impact, D.WEAPONS[0], ps, 0);
  assert.equal(out.hits.length, 0, '落水不该造成任何伤害');
  assert.equal(ps[0].hp, 100);
  assert.equal(ps[1].hp, 100);
});

test('灌木：普通武器被拦下，石矛/石箭穿透', () => {
  // 灌木坐在地上（y = 地表 − 高度），不能悬空——悬空的灌木下方有缝，弹丸会从底下溜过去
  const BX = 700, BW = D.TERRAIN.BUSH.w, BH = D.TERRAIN.BUSH.h;
  const bush = { x: BX, y: D.TERRAIN.GROUND_Y - BH, w: BW, h: BH };
  const run = (weapon) => {
    const w = flat();
    w.bushes.push(bush);
    const p = L.makeProjectile(weapon, 200, 663, 0.001, 1);
    const r = L.simulate(w, p, {}, { maxT: 6 });
    return r.impact;
  };
  for (const id of ['stone', 'axe']) {
    const im = run(D.WEAPONS.find((x) => x.id === id));
    assert.equal(im.type, 'bush', `${id} 应被灌木拦下，实际 ${im.type}`);
    assert.ok(im.x < BX + BW + 40, `${id} 不该穿过灌木`);
  }
  for (const id of ['spear', 'arrow']) {
    const im = run(D.WEAPONS.find((x) => x.id === id));
    assert.notEqual(im.type, 'bush', `${id} 应穿透灌木，实际被拦下`);
    assert.ok(im.x > BX + BW, `${id} 应飞到灌木另一侧（落点 x=${im.x.toFixed(0)}）`);
  }
});

test('投石索：落地反弹一次且速度衰减，不会无限弹', () => {
  const w = flat();
  const sling = D.WEAPONS.find((x) => x.id === 'sling');
  // 力度要压到落点在 1600 宽的世界内——满力时弹丸还没落地就先飞出右边界了
  const p = L.makeProjectile(sling, 300, 600, 20 * L.DEG, 0.5);
  const r = L.simulate(w, p, {}, { maxT: 12 });
  const bounces = r.events.filter((e) => e.type === 'bounce');
  assert.equal(bounces.length, 1, `应该只反弹 1 次，实际 ${bounces.length} 次`);
  assert.equal(r.impact.type, 'ground', '弹一次之后要落地收场');
  assert.ok(bounces[0].x < D.TERRAIN.W, '反弹点应在世界内');

  // 单独再跑一遍，量反弹前后的速率，确认是衰减不是原速弹
  const q = L.makeProjectile(sling, 300, 600, 20 * L.DEG, 0.5);
  let before = null, after = null;
  const ctx = { world: w, players: null, wind: 0 };
  for (let i = 0; i < 240 * 12; i++) {
    const sp = Math.hypot(q.vx, q.vy);
    const e = L.stepProjectile(q, D.PHYS.SUB_DT, ctx);
    if (e && e.type === 'bounce') { before = sp; after = Math.hypot(q.vx, q.vy); break; }
    if (e) break;
  }
  assert.ok(before && after, '这一发应当发生反弹');
  assert.ok(after < before * 0.7, `反弹应显著减速：${before.toFixed(0)} → ${after.toFixed(0)} px/s`);
});

test('回旋镖：会折返并被发射者接住（接住则返还弹药）', () => {
  const w = flat();
  const boom = D.WEAPONS.find((x) => x.id === 'boomerang');
  for (const ang of [30, 45, 60, 80]) {                 // 各种弧度都要能回来
    const p = L.makeProjectile(boom, 300, 550, ang * L.DEG, 1);
    const r = L.simulate(w, p, {}, { maxT: 12 });
    assert.equal(r.impact.type, 'catch', `${ang}° 应飞回被接住，实际 ${r.impact.type}`);
    assert.ok(r.time > boom.returnAt, '折返发生在 returnAt 之后');
  }
  // 折返段不受重力：一旦掉到发射点水平线以下就再也拉不回来（曾实测四个角度全砸地）
  const wLow = flat(3000);
  const p = L.makeProjectile(boom, 300, 550, 60 * L.DEG, 1);
  const r = L.simulate(wLow, p, {}, { maxT: 12 });
  assert.equal(r.impact.type, 'catch', '地面再低也不该影响接住');
});

test('火把：点燃 3 回合，每回合掉血，不叠加只刷新', () => {
  const torch = D.WEAPONS.find((x) => x.id === 'torch');
  const ps = [P(300, 700), P(1200, 700)];
  const out = L.settleImpact({ type: 'direct', who: 1, x: 1200, y: 670 }, torch, ps, 0);
  assert.deepEqual(out.hits, [{ who: 1, dmg: torch.dmg, kind: 'direct' }]);
  assert.ok(ps[1].burn, '应当被点燃');
  assert.equal(ps[1].burn.turns, 3);
  // 重复点燃只刷新回合数
  ps[1].burn.turns = 1;
  L.settleImpact({ type: 'direct', who: 1, x: 1200, y: 670 }, torch, ps, 0);
  assert.equal(ps[1].burn.turns, 3, '重复点燃应刷新而不是叠加');
  // 三个回合后自动熄灭
  let total = 0;
  for (let i = 0; i < 3; i++) total += L.tickBurn(ps[1]);
  assert.equal(total, 2 * 3);
  assert.equal(ps[1].burn, null, '回合用完应熄灭');
});

test('溅射衰减：贴脸 100% / 中点 62.5% / 半径处 25% / 半径外 0', () => {
  const s = { r: 100, dmg: 20 };
  assert.ok(Math.abs(L.splashAt(0, s) - 20) < 1e-9);
  assert.ok(Math.abs(L.splashAt(50, s) - 12.5) < 1e-9);
  assert.ok(Math.abs(L.splashAt(100, s) - 5) < 1e-9);
  assert.equal(L.splashAt(100.1, s), 0);
  assert.equal(L.splashAt(0, null), 0);
});

test('直击只算直击伤害，不再叠加同一次落地的溅射', () => {
  const stone = D.WEAPONS[0];
  const ps = [P(300, 700), P(1200, 700)];
  const out = L.settleImpact({ type: 'direct', who: 1, x: 1200, y: 670 }, stone, ps, 0);
  assert.equal(out.hits.length, 1, '直击应只产生一条伤害记录');
  assert.equal(out.hits[0].kind, 'direct');
  assert.equal(ps[1].hp, 100 - stone.dmg);
});

test('落地溅射会误伤站太近的发射者（品类惯例，也是风险）', () => {
  const stone = D.WEAPONS[0];
  const ps = [P(300, 700), P(900, 700)];
  const out = L.settleImpact({ type: 'ground', x: 320, y: 700 }, stone, ps, 0);
  assert.ok(out.hits.some((h) => h.who === 0), '贴着自己落地就该吃溅射');
  assert.ok(ps[0].hp < 100);
});

// ---------------- AI ----------------

test('AI 误差单调：easy > medium > hard', () => {
  const w = W.genTerrain(4);
  const run = (lv) => {
    const rng = W.mulberry32(2024);
    const me = { x: w.spawns[0].x, y: w.spawns[0].y };
    const foe = { x: w.spawns[1].x, y: w.spawns[1].y };
    // 拿掉误差后的"理想角"做基准，量各档实际散布
    let sq = 0, n = 0;
    for (let i = 0; i < 40; i++) {
      const a = L.aiAim(w, me, foe, D.WEAPONS[0], lv, rng, 5);
      const b = L.aiAim(w, me, foe, D.WEAPONS[0], lv, new (function () { return () => 0.5; })(), 5);
      sq += (a.angle - b.angle) ** 2 + (a.power - b.power) ** 2;
      n++;
    }
    return Math.sqrt(sq / n);
  };
  const e = run('easy'), m = run('medium'), h = run('hard');
  assert.ok(e > m, `easy 散布 ${e.toFixed(4)} 应大于 medium ${m.toFixed(4)}`);
  assert.ok(m > h, `medium 散布 ${m.toFixed(4)} 应大于 hard ${h.toFixed(4)}`);
});

test('AI 能解出可命中解，不会退化成满力 45° 兜底', () => {
  let good = 0, total = 0;
  for (let s = 1; s <= 30; s++) {
    const w = L.newBattle(s);
    const rng = W.mulberry32(s);
    const me = { x: w.spawns[0].x, y: w.spawns[0].y };
    const foe = { x: w.spawns[1].x, y: w.spawns[1].y };
    const aim = L.aiAim(w, me, foe, D.WEAPONS[0], 'hard', rng, 3);
    total++;
    if (!aim.hopeless) good++;
  }
  assert.ok(good / total > 0.95, `只有 ${(good / total * 100).toFixed(0)}% 的地图解得出解`);
});

test('AI 不会选没有弹药的武器', () => {
  const ps = [P(300, 700), P(1200, 700)];
  for (const p of ps) for (const wp of D.WEAPONS) p.ammo[wp.id] = wp.ammo > 0 ? wp.ammo : Infinity;
  ps[0].ammo.boulder = 0;
  ps[0].ammo.axe = 0;
  const rng = W.mulberry32(7);
  for (let i = 0; i < 60; i++) {
    const wp = L.aiPickWeapon(ps, 0, 'easy', rng);
    assert.ok(wp.id !== 'boulder' && wp.id !== 'axe', `选中了没弹药的 ${wp.name}`);
  }
});

// ---------------- 对局 ----------------

test('Fuzz：500 局全自动对局，不出错、不出现 NaN、200 回合内分出胜负', () => {
  const levels = ['easy', 'medium', 'hard'];
  let nan = 0, stuck = 0, spawnFail = 0;
  for (let i = 0; i < 500; i++) {
    const a = levels[i % 3], b = levels[(i * 2 + 1) % 3];
    const m = L.simulateMatch(i + 1, a, b);
    if (!m.ok) {
      if (m.reason === 'nan-hp') nan++;
      else if (m.reason === 'no-winner') stuck++;
      else if (m.reason === 'no-spawn') spawnFail++;
      continue;
    }
    // 期望的贴目独立算一遍——不用 L.komiFor，否则成了拿它自己验它自己。
    // 规则：取双方里较高的一档（同档就是它自己）
    const RANK = { easy: 0, medium: 1, hard: 2 };
    const komi = D.KOMI[RANK[a] > RANK[b] ? a : b];
    for (const p of m.players) {
      assert.ok(Number.isFinite(p.hp), `HP 出现 NaN（种子 ${i + 1}）`);
      // 上界按各人自己的满血算：后手有贴目（DATA.KOMI 分档），拿全局 D.HP 当上界会误报
      assert.ok(p.hp >= 0 && p.hp <= p.hpMax, `HP 越界 ${p.hp}/${p.hpMax}（种子 ${i + 1}）`);
      assert.ok(p.hpMax === D.HP + (p.idx === 1 ? komi : 0),
        `满血值不对：${p.hpMax}（${a} vs ${b} 应贴 ${komi}，种子 ${i + 1}）`);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `坐标出现 NaN（种子 ${i + 1}）`);
    }
    assert.ok([0, 1].includes(m.winner));
  }
  assert.equal(nan, 0, `${nan} 局出现 NaN`);
  assert.equal(spawnFail, 0, `${spawnFail} 局没有站位`);
  assert.ok(stuck <= 5, `${stuck}/500 局打满 200 回合未分胜负`);
});

test('贴目分档：一局取双方较高档；认不出的档落锚定值；标量覆写仍生效', () => {
  // 规则来源：2026-09-27 作者裁决。判定体从圆换成胶囊后双方命中率一起抬高，
  // 三条验收线各自要求不同的贴目（easy≈0 / medium 12 / hard 6），一个标量无解。
  assert.deepStrictEqual(D.KOMI, { easy: 0, medium: 12, hard: 6 },
    '出厂贴目表被动过——它同时是三条验收线的支点（见 data.js KOMI 注释与 docs/需求与验收.md §五）');
  // 取双方较高档，且与参数顺序无关（先手/后手换位不该改结论）
  assert.equal(L.komiFor('easy', 'medium'), 12);
  assert.equal(L.komiFor('medium', 'easy'), 12);
  assert.equal(L.komiFor('hard', 'medium'), 6);
  assert.equal(L.komiFor('medium', 'hard'), 6);
  assert.equal(L.komiFor('hard', 'hard'), 6);
  assert.equal(L.komiFor('easy', 'easy'), 0);
  // 认不出的档位落 medium 锚定值：本地双人双方都是人、没有档位，走的正是这条；
  // 拼错档名时也宁可发锚定值，不要发 undefined 把 hp 弄成 NaN
  assert.equal(L.komiFor(), 12);
  assert.equal(L.komiFor(null, null), 12);
  assert.equal(L.komiFor('nonsense', 'easy'), 0, '认得出的一方仍该生效');
  assert.equal(L.komiFor('hard', undefined), 6);
  // 原型链上的键名也必须落锚定值。这条是独立测试员 indep-komi ⓪ 打进来的真 bug：
  // 判档位原本用 `lv in RANK`，而 `in` 穿原型链——('constructor' in RANK) 为真、
  // RANK['constructor'] 是 Object 构造函数，best 被写成 'constructor'，
  // 再取 K['constructor'] 又是函数，hpMax 直接变成 "100function Object() { [native code] }"。
  // 产品 UI 的档位只从按钮来，到不了这条路径；但"认不出的档落 medium"是写明的约定，
  // 约定就得真兜住。这里连同返回值类型一起钉死，免得再退回字符串拼接。
  for (const k of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']) {
    const v = L.komiFor(k, k);
    assert.equal(typeof v, 'number', `komiFor('${k}') 应落锚定值，实得 ${typeof v}`);
    assert.equal(v, 12, `komiFor('${k}') 应落锚定值 12，实得 ${v}`);
  }
  // 真档位与原型链键混着传：真档位该照常生效，别被原型链那条短路掉
  assert.equal(L.komiFor('constructor', 'hard'), 6);
  assert.equal(L.komiFor('easy', '__proto__'), 0);
  // 标量覆写：tools/komi-curve.cjs 扫曲线靠这条。删了它那条工具会静默退化成"三档同值"
  const base = D.KOMI;
  try {
    D.KOMI = 7;
    assert.equal(L.komiFor('easy', 'medium'), 7);
    assert.equal(L.komiFor('hard', 'hard'), 7);
    const sp = L.newBattle(1234).spawns;
    assert.equal(L.newPlayer(sp[0], 0).hpMax, D.HP);
    assert.equal(L.newPlayer(sp[1], 1).hpMax, D.HP + 7);
  } finally { D.KOMI = base; }
});

test('贴目只发给后手，且只跟档位走——不按"谁是 AI"发', () => {
  // 人机、双人、AI 对战三种走法共用 newPlayer，这条钉住"贴目落在回合顺序上"这个不变量
  for (const [a, b, k] of [['medium', 'easy', 12], ['hard', 'medium', 6], ['easy', 'easy', 0]]) {
    const m = L.simulateMatch(4242, a, b);
    assert.ok(m.ok, `${a} vs ${b} 这局没跑起来`);
    assert.equal(m.players[0].hpMax, D.HP, `${a} vs ${b} 先手满血`);
    assert.equal(m.players[1].hpMax, D.HP + k, `${a} vs ${b} 后手满血应贴 ${k}`);
    // 只查 hpMax：simulateMatch 返回的是**终局**状态，后手可能已经被打到 0 血
  }
});

test('回归：镜像对局不该先手必胜（同档 AI 互打先手胜率须接近 50%）', () => {
  // 这条是"双方都必中"的探针：AI 误差一旦小到打不偏，对局就退化成纯伤害竞速，
  // 先手方稳定先打出致命一击。初版 hard 直击率 100% → 镜像先手胜率 98%。
  for (const lv of ['medium', 'hard']) {
    let first = 0, total = 0;
    for (let s = 1; s <= 200; s++) {
      const m = L.simulateMatch(s * 13 + 5, lv, lv);
      if (!m.ok) continue;
      total++;
      if (m.winner === 0) first++;
    }
    const rate = first / total;
    assert.ok(rate <= 0.82, `${lv} 镜像先手胜率 ${(rate * 100).toFixed(0)}%，先手优势过大——AI 误差可能小到打不偏`);
    assert.ok(rate >= 0.18, `${lv} 镜像先手胜率 ${(rate * 100).toFixed(0)}%，先手被压得过低`);
  }
});

test('难度验收：easy 打不过 medium，hard 打得过 medium', () => {
  const duel = (a, b, n) => {
    const w = [0, 0];
    for (let s = 1; s <= n; s++) {
      const m = L.simulateMatch(s * 13 + 5, a, b);
      if (m.ok) w[m.winner]++;
    }
    return w[0] / (w[0] + w[1]);
  };
  const easy = (duel('easy', 'medium', 200) + (1 - duel('medium', 'easy', 200))) / 2;
  const hard = (duel('hard', 'medium', 200) + (1 - duel('medium', 'hard', 200))) / 2;
  assert.ok(easy <= 0.30, `easy 对 medium 胜率 ${(easy * 100).toFixed(1)}% 应 ≤30%`);
  assert.ok(hard >= 0.75, `hard 对 medium 胜率 ${(hard * 100).toFixed(1)}% 应 ≥75%`);
});

// ---------- 下面这组补的是"验收文档声称有单测、实际没有"的七条 ----------
// 根因是这些逻辑当时写在 game.js 里（依赖 Phaser，Node 跑不了），文档却按"单测"写。
// 修法是把纯逻辑部分抽进 logic.js，而不是把文档改小。

test('F13/F14：拖拽死区与仰角夹取（<24px 或力度 <0.12 视为取消）', () => {
  const fromX = 300, toX = 1200;
  const PH = D.PHYS;
  // 死区一：拖距不足 DRAG_START —— "没拖，是点了一下"
  assert.equal(L.pullToAim({ x: 0, y: 0 }, fromX, toX).valid, false);
  assert.equal(L.pullToAim({ x: PH.DRAG_START - 1, y: 0 }, fromX, toX).valid, false);
  // 死区二：拖距够了但力度低于 MIN_POWER —— "拖了，但轻到不像要出手"
  const lightLen = PH.DRAG_START + (PH.DRAG_FULL - PH.DRAG_START) * PH.MIN_POWER * 0.5;
  assert.ok(lightLen > PH.DRAG_START, '构造点应在死区一之外');
  assert.equal(L.pullToAim({ x: lightLen, y: 0 }, fromX, toX).valid, false, '力度不够也应取消');
  // 刚过死区二就该有效，且力度落在 (0,1]
  const okLen = PH.DRAG_START + (PH.DRAG_FULL - PH.DRAG_START) * PH.MIN_POWER * 1.05;
  const just = L.pullToAim({ x: okLen, y: 0 }, fromX, toX);
  assert.equal(just.valid, true);
  assert.ok(just.power > PH.MIN_POWER && just.power <= 1);
  // 拖满 = 满力；拖过头封顶在 1
  assert.equal(L.pullToAim({ x: PH.DRAG_FULL, y: 0 }, fromX, toX).power, 1);
  assert.equal(L.pullToAim({ x: 99999, y: 0 }, fromX, toX).power, 1);
  // 仰角夹取：往身后拖（朝对手反方向）时夹到最近一端，不往回扔
  const [lo, hi] = L.angleRange(fromX, toX);
  const back = L.pullToAim({ x: 300, y: 300 }, fromX, toX);
  assert.ok(back.angle >= lo && back.angle <= hi, `身后拖应夹进 [${lo},${hi}]，实际 ${back.angle}`);
  // 反手方向（toX < fromX）区间镜像到第二象限
  const [mlo, mhi] = L.angleRange(toX, fromX);
  assert.ok(mlo > Math.PI / 2 && mhi < Math.PI, '朝左时仰角区间应落在第二象限');
  assert.ok(Math.abs(mlo - (Math.PI - hi)) < 1e-12 && Math.abs(mhi - (Math.PI - lo)) < 1e-12,
    '左右两个区间必须互为镜像，否则后手方解不出解');
});

test('F7：回合超时按当前瞄准出手；没在瞄就平推一发，不让对局卡死', () => {
  const me = { x: 300, y: D.TERRAIN.GROUND_Y }, foe = { x: 1200, y: D.TERRAIN.GROUND_Y };
  // 玩家正在瞄：超时就照他这一发打出去，不另起炉灶
  const aiming = { valid: true, angle: 1.1, power: 0.42 };
  assert.deepEqual(L.timeoutAim(aiming, me, foe), aiming);
  // 没在瞄（切后台、人离开了）：最小仰角平推
  for (const idle of [null, { valid: false, power: 0, angle: 0 }]) {
    const a = L.timeoutAim(idle, me, foe);
    const [lo] = L.angleRange(me.x, foe.x);
    assert.equal(a.angle, lo, '托底那一发应走最小仰角');
    assert.equal(a.power, D.TURN.TIMEOUT_POWER);
    // 托底力度必须自己过得了死区，否则"自动出手"会被判成取消，回合照样卡死
    assert.ok(a.power >= D.PHYS.MIN_POWER,
      `托底力度 ${a.power} 低于死区 ${D.PHYS.MIN_POWER}，会自动取消`);
  }
  // 反手方向同样要镜像，不能朝身后扔
  const back = L.timeoutAim(null, foe, me);
  assert.equal(back.angle, L.angleRange(foe.x, me.x)[0]);
  assert.ok(back.angle > Math.PI / 2, '朝左打时角度应落在第二象限');
});

test('N3：单帧时间钳制——切后台回来 delta 上万毫秒，只准跑一帧的量', () => {
  assert.equal(L.clampFrame(16.7), 16.7 / 1000);
  assert.equal(L.clampFrame(D.PHYS.MAX_FRAME * 1000), D.PHYS.MAX_FRAME);
  assert.equal(L.clampFrame(60000), D.PHYS.MAX_FRAME, '切后台 60 秒回来只能按 MAX_FRAME 走');
  assert.equal(L.clampFrame(1e9), D.PHYS.MAX_FRAME);
  assert.equal(L.clampFrame(0), 0);
  // 钳制值必须真能兜住：单帧最多推进的子步数不能失控
  assert.ok(L.clampFrame(60000) / D.PHYS.SUB_DT <= 16, '单帧子步数应有界');
});

test('F26：wind 参数真的作用在弹道上（P1 恒 0 级，但结构必须有效）', () => {
  const w = flat();
  const y = D.TERRAIN.GROUND_Y;
  // 力度取 0.6（射程约 576px，从 x=300 落到 x≈876）。取 0.9 的话射程 1296px，
  // 弹丸直接飞到世界右边界 x=1600 被判出界，落点被边界钉死——
  // 顺风逆风都"落在"1600，风的效果完全看不出来（原断言实测 1600.4 → 1601.0）
  const shot = () => L.makeProjectile(D.WEAPONS[0], 300, y - 34, 45 * L.DEG, 0.6);
  const run = (wind) => {
    const r = L.simulate(w, shot(), { wind }, { maxT: 20 });
    assert.ok(r.impact, `风 ${wind} 级这一发没落地`);
    return r.impact.x;
  };
  const zero = run(0), tail = run(3), head = run(-3);
  assert.ok(tail > zero + 20, `顺风应打得更远：${zero.toFixed(1)} → ${tail.toFixed(1)}`);
  assert.ok(head < zero - 20, `逆风应打得更近：${zero.toFixed(1)} → ${head.toFixed(1)}`);
  assert.ok(Math.abs((tail - zero) + (head - zero)) < 1.5, '风是纯水平加速度，正负偏移应对称');
  assert.equal(run(0), zero, '同一发同风级必须复现（无隐藏随机）');
});

// 口径（auditor 判例层裁定，与 docs/需求与验收.md F30 同一口径）：
// 「第一发必偏」= **不直击** 且 **落点离目标 ≥ AI.FIRST_SHOT_OFFSET（120px）**。
// 判落点不判瞄点：瞄点挪开了，误差注入还能把弹拽回来一截，只有落点是真的。
// 这里是**硬保证**不是调概率——aiAim 出手前拿真碰撞验过，不合格就继续往外推。
//
// 量在哪一层很重要：**要量 aiChoose 真正出手的那一发**，不能点名某件武器直接调 aiAim——
// AI 会换武器（够不着就换下一件），点名的武器可能根本不在它最终的选择里，
// 量出来的不是"AI 的第一发"。下面第一个用例走 aiChoose，
// 第二个用例再把八件武器逐件摊开（那是覆盖面检查，不是口径）
function firstShotOf(seed, lv) {
  const w = L.newBattle(seed);
  const players = [L.newPlayer(w.spawns[0], 0), L.newPlayer(w.spawns[1], 1)];
  const rng = W.mulberry32((seed ^ 0x9E3779B9) >>> 0);
  const act = L.aiChoose(w, players, 0, lv, rng);
  const proj = L.makeProjectile(act.wp, players[0].x, players[0].y - 34, act.aim.angle, act.aim.power);
  proj.owner = 0;
  const r = L.simulate(w, proj, {}, { players, maxT: 14 });
  return { act, impact: r.impact, foe: players[1] };
}

test('F30：AI 对全新目标的第一发不直击，且落点偏出 FIRST_SHOT_OFFSET（硬保证）', () => {
  const FLOOR = D.AI.FIRST_SHOT_OFFSET;
  let worst = Infinity, n = 0, direct = 0, hopeless = 0;
  for (const lv of ['easy', 'medium', 'hard']) {
    for (let s = 1; s <= 300; s++) {
      const { act, impact, foe } = firstShotOf(s, lv);
      if (act.aim.hopeless) hopeless++;
      n++;
      if (!impact) continue;                     // 没落点（飞出世界）谈不上打中
      if (impact.type === 'direct') direct++;
      const d = Math.hypot(impact.x - foe.x, impact.y - L.bodyMid(foe));
      assert.ok(impact.type !== 'direct' && d >= FLOOR,
        `${lv} seed=${s} 首发 wp=${act.wp.id} 类型=${impact.type} 偏移=${d.toFixed(1)}px，破硬保证线 ${FLOOR}px`);
      worst = Math.min(worst, d);
    }
  }
  // aiChoose 只在"八件武器全都够不着"时才走兜底，而站位生成已校验投石双向可达
  assert.equal(hopeless, 0, `有 ${hopeless}/${n} 发走了"全都够不着"兜底，那条路径上没有硬校验`);
  // 最小值贴着合格线，正是"硬保证在生效"的签名（不是靠调大概率撞出来的）
  assert.ok(worst < FLOOR * 1.5,
    `全场最小偏移 ${worst.toFixed(0)}px 离合格线 ${FLOOR}px 太远，说明偏移量是拍出来的、没有真的校验`);
  assert.equal(direct, 0, `首发直击 ${direct}/${n} 次，"给玩家观察期"不成立`);
});

// 覆盖面检查：八件武器逐件点名，验各自的弹道特性下硬校验都兜得住
// （回旋镖飞出去会折返、投石索落地反弹、巨石判定圈 42px）
//
// **不跳过 hopeless**：aiAim 判"够不着"虽会提前返回，但那条出口也走同一份
// nudgeToFirstShotMiss，所以它照样得破不了线。这段早前是 `if (aim.hopeless) continue;`
// 跳过的——审计就是从这个缺口打进来的：回旋镖在种子 111/116/153（三档一致）
// 由该早返回直接命中对手。跳过等于把整条路径划在保证之外，现在补上。
//
// 种子放到 300：审计复现用的 111/116/153 必须在样本内，否则"全验"二字站不住
test('F30 覆盖面：八件武器各自动用硬保证时都不破线', () => {
  const FLOOR = D.AI.FIRST_SHOT_OFFSET;
  for (const lv of ['easy', 'medium', 'hard']) {
    for (const wp of D.WEAPONS) {
      let n = 0, nearest = Infinity, direct = 0, hopeless = 0;
      for (let s = 1; s <= 300; s++) {
        const w = L.newBattle(s);
        const me = L.newPlayer(w.spawns[0], 0);
        const foe = L.newPlayer(w.spawns[1], 1);
        const aim = L.aiAim(w, me, foe, wp, lv, W.mulberry32(s * 31 + 7), 0);
        if (aim.hopeless) hopeless++;
        const proj = L.makeProjectile(wp, me.x, me.y - 34, aim.angle, aim.power);
        proj.owner = 0;
        const r = L.simulate(w, proj, {}, { maxT: 20, players: [me, foe] });
        if (!r.impact) continue;
        n++;
        if (r.impact.type === 'direct') direct++;
        nearest = Math.min(nearest, Math.hypot(r.impact.x - foe.x, r.impact.y - L.bodyMid(foe)));
      }
      assert.ok(n > 0, `${lv}/${wp.id} 一发都没验到，这件的覆盖是空的`);
      assert.equal(direct, 0, `${lv}/${wp.id} 首发直击 ${direct} 次（hopeless ${hopeless} 发）`);
      assert.ok(nearest >= FLOOR,
        `${lv}/${wp.id} 首发落点最近只偏了 ${nearest.toFixed(0)}px，低于硬保证线 ${FLOOR}px（hopeless ${hopeless} 发）`);
    }
  }
});

test('F30：误差随射击轮次收敛（CONVERGE 不是空旋钮），且下限按本档比例', () => {
  const w = L.newBattle(5);
  const me = L.newPlayer(w.spawns[0], 0);
  const foe = L.newPlayer(w.spawns[1], 1);
  // 同一批 rng 种子下角度的标准差 = 注入误差的量级
  const spread = (lv, hist) => {
    const xs = [];
    for (let s = 0; s < 60; s++) {
      xs.push(L.aiAim(w, me, foe, D.WEAPONS[0], lv, W.mulberry32(s * 977 + 13), hist).angle);
    }
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const h1 = spread('hard', 1), h3 = spread('hard', 3), h9 = spread('hard', 9);
  // 收敛：hist=3 的散布要明显小于 hist=1（0.55² 若生效，应降到约一半）
  assert.ok(h3 < h1 * 0.75, `误差没有收敛：hist1=${h1.toFixed(5)} hist3=${h3.toFixed(5)}`);
  // 收敛到底就停住，不再继续缩（下限生效）
  assert.ok(h9 > h3 * 0.6, `下限没生效，误差一路缩到 ${h9.toFixed(5)}`);
  assert.ok(h9 > 0, '误差不该归零——"永远有手感波动"是设计原则');
  // 下限按本档比例取：easy 收敛后必须仍明显比 hard 差，否则三档会收敛到同一个精度
  const e9 = spread('easy', 9);
  assert.ok(e9 > h9 * 1.5, `easy 收敛后(${e9.toFixed(5)})与 hard(${h9.toFixed(5)})挤到一起了，难度区分被抹平`);
});

test('F31：够不着的武器要换掉（hopeless 不上报给调用方）', () => {
  const y = D.TERRAIN.GROUND_Y;
  const w = flat(y);
  // 间距取 1200px——站位间距规范的上限，射手与靶子都还在世界（1600 宽）里面。
  // 平地上只有回旋镖够不着：它 1.2 秒就折返，出程只覆盖约 890px。
  // 早先这里把靶子摆在 2000px 外，那个位置已经在世界外面了，弹丸飞到 x=1600
  // 就被判出界，八件武器"全都够不着"——测的是个不存在的局面，
  // 唯一能通过的方式是不看局面直接发，等于把 bug 写进了断言
  const me = L.newPlayer({ x: 300, y }, 0);
  const foe = L.newPlayer({ x: 1500, y }, 1);
  const players = [me, foe];
  const boomerang = D.WEAPONS.find((q) => q.id === 'boomerang');
  const aimOf = (wp) => L.aiAim(w, me, foe, wp, 'hard', W.mulberry32(1), 3);

  assert.ok(aimOf(boomerang).hopeless, '前提不成立：1200px 外回旋镖本该够不着');
  assert.ok(!aimOf(D.WEAPONS[0]).hopeless, '前提不成立：投石本该够得着');

  for (const lv of ['easy', 'medium', 'hard']) {
    for (let s = 1; s <= 12; s++) {
      const act = L.aiChoose(w, players, 0, lv, W.mulberry32(s));
      assert.ok(act && act.aim, `${lv} 种子 ${s} 没有返回结果`);
      assert.equal(act.aim.hopeless, false,
        `${lv} 种子 ${s} 选了够不着的 ${act.wp.id}——七件打得到的武器它没试`);
    }
  }

  // 全都够不着时（把靶子挪到世界外）：如实报告 hopeless，并退回分数最高的一件，
  // 不能抛错也不能返回 null 把状态机卡死。真实对局走不到这里——站位生成时
  // 已校验过投石双向可达，这条是防御路径
  const far = L.newPlayer({ x: 2400, y }, 1);
  const act = L.aiChoose(w, [me, far], 0, 'hard', W.mulberry32(1));
  assert.ok(act && act.wp && act.aim, '全都够不着时也必须返回一件可打的武器');
  assert.equal(act.aim.hopeless, true, '全都够不着时应当如实报告 hopeless');
  assert.equal(act.wp.id, 'boulder', '兜底应退回打分最高的武器');
});
