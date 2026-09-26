// 贴目（KOMI）曲线：量"回合顺序"值多少血。
// 镜像对局里双方 AI 相同、目标相同，唯一的不对称就是回合顺序，所以镜像局的先手胜率
// 就是回合顺序的价值。跑法：同一批种子、同一套判定，**只覆写 DATA.KOMI**——
// KOMI 是在 LOGIC.newPlayer 里现读的（`DATA.HP + (i === 1 ? DATA.KOMI : 0)`），
// 覆写即生效，logic.js 一个字都不用动，也不用改 data.js 的出厂值。
//
// 用法：node tools/komi-curve.cjs [N] [档次,逗号分隔] [贴目,逗号分隔]
//   node tools/komi-curve.cjs 2400                    # 默认 medium,hard × 0,11,12,12.5,13
//   node tools/komi-curve.cjs 2400 medium 0,6,12,18
//
// 输出的每个格子都带 N、种子基、95%CI 与越线标记，可直接引用而不必再解释口径。
// docs/需求与验收.md §五 的贴目表就是 `node tools/komi-curve.cjs 2400` 的原样输出。
const ROOT = require('node:path').join(__dirname, '..', 'js') + '/';
const DATA = require(ROOT + 'data.js');
const LOGIC = require(ROOT + 'logic.js');
const WORLD = require(ROOT + 'world.js');

function sim(seed, lvA, lvB) {
  const w = LOGIC.newBattle(seed);
  const sp = w.spawns;
  if (!sp || sp.length < 2) return null;
  const rng = WORLD.mulberry32((seed ^ 0x9E3779B9) >>> 0);
  const players = [LOGIC.newPlayer(sp[0], 0), LOGIC.newPlayer(sp[1], 1)];
  for (let turn = 0; turn < 200; turn++) {
    const me = turn % 2, foe = 1 - me;
    LOGIC.tickBurn(players[me]);
    if (players[me].hp <= 0) return { winner: foe, turns: turn };
    if (players[foe].hp <= 0) return { winner: me, turns: turn };
    const act = LOGIC.aiChoose(w, players, me, [lvA, lvB][me], rng);
    players[me].shots++;
    if (Number.isFinite(players[me].ammo[act.wp.id])) players[me].ammo[act.wp.id]--;
    const proj = LOGIC.makeProjectile(act.wp, players[me].x, players[me].y - 34, act.aim.angle, act.aim.power);
    proj.owner = me;
    const res = LOGIC.simulate(w, proj, {}, { players, maxT: 14 });
    LOGIC.settleImpact(res.impact, act.wp, players, me);
    if (!Number.isFinite(players[0].hp) || !Number.isFinite(players[1].hp)) return null;
  }
  return null;
}

const SETS = [{ n: 'A', at: (i) => 5000 + i * 13 }, { n: 'B', at: (i) => 20260000 + i * 31 }];
const N = Number(process.argv[2] || 2400);
const TIERS = process.argv[3] ? process.argv[3].split(',') : ['medium', 'hard'];
const KOMIS = process.argv[4] ? process.argv[4].split(',').map(Number) : [0, 11, 12, 12.5, 13];
const base = DATA.KOMI;

console.log(`N=${N}/档/套（种子基 A: 5000+13i，B: 20260000+31i）  仪器：本脚本，走 LOGIC.newPlayer`);
console.log(`镜像对局先手（player 0）胜率。ci = 1.96·√(0.25/N) = ${(1.96 * Math.sqrt(0.25 / N) * 100).toFixed(2)}%`);
console.log('');
for (const tier of TIERS) {
  console.log(`── ${tier} 镜像 ──`);
  for (const k of KOMIS) {
    DATA.KOMI = k;
    const cells = SETS.map((s) => {
      let win = 0, d = 0, turns = 0;
      for (let i = 0; i < N; i++) {
        const r = sim(s.at(i), tier, tier);
        if (!r) continue;
        d++; turns += r.turns;
        if (r.winner === 0) win++;
      }
      const p = win / d;
      const ci = 1.96 * Math.sqrt(0.25 / d);
      const bad = p - ci > 0.55 || p + ci < 0.45;
      return `${s.n} ${(p * 100).toFixed(1).padStart(5)}% [${((p - ci) * 100).toFixed(1)},${((p + ci) * 100).toFixed(1)}]${bad ? '❌' : '✅'} 平均${(turns / d).toFixed(1)}回合`;
    });
    console.log(`  贴目 ${String(k).padStart(4)}  ${cells.join('   ')}`);
  }
}
DATA.KOMI = base;
