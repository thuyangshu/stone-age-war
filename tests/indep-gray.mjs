// 独立用例 · 灰度 + 压力（2026-09-27 第二轮：贴目由标量 12 改为分档表 {easy:0,medium:12,hard:6}）
//
// 为什么这一轮要做灰度：改动的是**玩法数值**（谁拿多少血）。数值改动最容易"修好一条线、
// 悄悄劣化另一条"——上一轮受击体改胶囊时，三条线就是一起动的。所以把改动**前后两个世界**
// 放在同一批种子上对打，看的是"有没有劣化"，不是"新值过不过线"（后者是 indep-a4 的活）。
//
//   旧世界 = DATA.KOMI 覆写成标量 12（改动前的行为，三档同值）
//   新世界 = 出厂分档表
//
// 灰度判据（三条，缺一不可）：
//   ① 新世界三条验收线全过（硬线，与 indep-a4 同口径同种子，数字必须一致）
//   ② 对新世界而言**没有哪条线比旧世界更贴线**（余量不缩小）；旧世界不过的线不适用
//   ③ 三档仍单调可分：easy 打不过 medium、hard 打得过 medium（各自 >3 点，不是掷硬币）
//
// 压力：九种难度组合（3×3，含三档镜像）× 两族种子，每局须在 200 回合内分出胜负，
// 全程无 NaN、无卡局、无负血、无 hp 越界。这是 N5 在"分档"之后的复核。
//
// 用法：node tests/indep-gray.mjs [每族局数，默认 1200]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const D = require(join(__dirname, '..', 'js', 'data.js'));
const L = require(join(__dirname, '..', 'js', 'logic.js'));

const N = Number(process.argv[2]) || 1200;
const Z = 1.96;
const SETS = [{ n: 'A', at: (i) => 5000 + i * 13 }, { n: 'B', at: (i) => 20260000 + i * 31 }];
const PAIRS = [
  { a: 'easy', b: 'medium', lo: null, hi: 0.30, desc: 'easy 胜率 ≤30%' },
  { a: 'medium', b: 'medium', lo: 0.45, hi: 0.55, desc: '镜像 45~55%' },
  { a: 'hard', b: 'medium', lo: 0.75, hi: null, desc: 'hard 胜率 ≥75%' },
];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { (ok ? pass++ : fail++); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `　${detail}` : ''}`); };

// 跑一条线，返回合并判定量
function runPair({ a, b, lo, hi }) {
  let pw = 0, pn = 0, turns = 0, stuck = 0, nan = 0, badHp = 0;
  for (const set of SETS) {
    for (let i = 0; i < N; i++) {
      const r = L.simulateMatch(set.at(i), a, b);
      if (!r.ok) { if (r.reason === 'nan-hp') nan++; else stuck++; continue; }
      pn++; turns += r.turns;
      if (r.winner === 0) pw++;
      const want = L.komiFor(a, b);
      r.players.forEach((p, k) => {
        if (p.hpMax !== D.HP + (k === 1 ? want : 0)) badHp++;
        if (!Number.isFinite(p.hp) || p.hp < 0 || p.hp > p.hpMax) badHp++;
      });
    }
  }
  const rate = pw / pn;
  const ci = Z * Math.sqrt(0.25 / pn);
  // "距线余量"：正数=带内，负数=越线。无下沿的线看下沿没有意义，用 null 表示不适用
  const margin = (lo === null && hi === null) ? null
    : Math.min(lo === null ? Infinity : rate - lo - ci, hi === null ? Infinity : hi - ci - rate);
  return { rate, ci, lo, hi, pn, margin, stuck, nan, badHp, turns: turns / pn,
    ok: (lo === null || rate - ci >= lo) && (hi === null || rate + ci <= hi) && stuck === 0 && nan === 0 };
}

console.log(`每族 ${N} 局 → 每条线合并 ${2 * N} 局（ci=±${(Z * Math.sqrt(0.25 / (2 * N)) * 100).toFixed(1)} 点），两族种子 A/B 与 indep-a4 同基\n`);

// ══ ① 灰度：旧世界（标量 12）vs 新世界（分档表）══════════════
console.log('── ① 灰度对比：同一批种子，贴目 12 一统 vs 出厂分档表 ──');
const keep = D.KOMI;
D.KOMI = 12;                                   // 旧世界：标量覆写（komi-curve 同一条通道）
const oldWorld = PAIRS.map((p) => ({ ...p, r: runPair(p) }));
D.KOMI = keep;                                 // 新世界：出厂分档表
const newWorld = PAIRS.map((p) => ({ ...p, r: runPair(p) }));

console.log('对局'.padEnd(17) + '旧(标量12)'.padEnd(22) + '新(分档表)'.padEnd(22) + '验收线'.padEnd(14) + '判定');
for (let i = 0; i < PAIRS.length; i++) {
  const o = oldWorld[i].r, n = newWorld[i].r, p = PAIRS[i];
  const line = `${p.lo === null ? '' : (p.lo * 100).toFixed(0) + '%'}`
    + `${p.lo !== null && p.hi !== null ? '~' : ''}${p.hi === null ? '' : (p.hi * 100).toFixed(0) + '%'}`;
  const fmt = (r) => `${(r.rate * 100).toFixed(1)}% [${((r.rate - r.ci) * 100).toFixed(1)},${((r.rate + r.ci) * 100).toFixed(1)}] ${r.ok ? '✅' : '❌'}`;
  console.log(`${(p.a + ' vs ' + p.b).padEnd(17)}${fmt(o).padEnd(22)}${fmt(n).padEnd(22)}${line.padEnd(14)}${n.ok ? '新 ✅' : '新 ❌'}`);
}
console.log('');

// ①-a 新世界三条线全过（与 indep-a4 同口径；数字必须与 indep-a4 一致）
{
  const bad = newWorld.filter((p) => !p.r.ok);
  check('① 新世界（出厂分档表）三条验收线全过', bad.length === 0,
    bad.length ? bad.map((p) => `${p.a}vs${p.b} ${(p.r.rate * 100).toFixed(1)}%`).join('、')
      : newWorld.map((p) => `${p.a}vs${p.b} ${(p.r.rate * 100).toFixed(1)}%`).join('　'));
}

// ①-b 没有劣化：新世界在每条线上的余量不得比旧世界小
//     （旧世界本来就不过的线不适用——那正是本轮要修的东西，谈不上"劣化"）
{
  const worse = [];
  for (let i = 0; i < PAIRS.length; i++) {
    const o = oldWorld[i].r, n = newWorld[i].r;
    if (!o.ok) continue;                          // 旧世界不过 → 不适用
    if (n.margin < o.margin - 1e-9) worse.push(`${PAIRS[i].a}vs${PAIRS[i].b} 余量 ${(o.margin * 100).toFixed(2)} → ${(n.margin * 100).toFixed(2)} 点`);
  }
  check('① 没有劣化：旧世界过得去的线，新世界余量不缩小', worse.length === 0,
    worse.length ? worse.join('；')
      : oldWorld.map((p, i) => `${p.a}vs${p.b} 旧${p.r.ok ? `余${(p.r.margin * 100).toFixed(2)}点` : '本就不过'} → 新${newWorld[i].r.ok ? `余${(newWorld[i].r.margin * 100).toFixed(2)}点` : '不过'}`).join('；'));
}

// ①-c 旧世界的短板如实记：标量 12 在哪些线上不过——这是"一个标量治不了三档"的实证
//     （文档 §五 的论点是"medium 要 ≥11、hard 打 medium 要 ≤8，两者无交集"。这里给的是
//      标量 12 这一点的实测，与那条论点是两件事，别混。）
{
  const failed = oldWorld.filter((p) => !p.r.ok).map((p) => `${p.a}vs${p.b} ${(p.r.rate * 100).toFixed(1)}%`);
  check('① 旧世界（标量 12）确实过不了某条线 —— 分档不是为了调口味', failed.length > 0,
    failed.length ? `旧世界不合规：${failed.join('、')}` : '旧世界三条线全过——那本轮的改动就缺乏依据，需回问开发');
}

// ══ ② 压力：九种难度组合 ══════════════════════════════════════
console.log('\n── ② 压力：九种难度组合 × 两族种子，200 回合内分胜负、无 NaN ──');
{
  const LV = ['easy', 'medium', 'hard'];
  let games = 0, stuck = 0, nan = 0, badHp = 0, neg = 0, over = 0, notZero = 0, maxTurn = 0;
  const rows = [];
  for (const a of LV) for (const b of LV) {
    let n = 0, fw = 0, mt = 0, st = 0;
    for (const set of SETS) {
      for (let i = 0; i < N; i++) {
        const r = L.simulateMatch(set.at(i), a, b);
        if (!r.ok) { if (r.reason === 'nan-hp') nan++; else { stuck++; st++; } continue; }
        n++; games++; mt = Math.max(mt, r.turns);
        if (r.winner === 0) fw++;
        const want = L.komiFor(a, b);
        r.players.forEach((p, k) => {
          if (p.hpMax !== D.HP + (k === 1 ? want : 0)) badHp++;
          if (!Number.isFinite(p.hp) || !Number.isFinite(p.hpMax)) nan++;
          if (p.hp < 0) neg++;
          if (p.hp > p.hpMax) over++;
        });
        if (r.players[1 - r.winner].hp !== 0) notZero++;
      }
    }
    maxTurn = Math.max(maxTurn, mt);
    rows.push({ a, b, n, rate: fw / n, mt, st });
  }
  for (const r of rows) {
    console.log(`   ${(r.a + ' vs ' + r.b).padEnd(17)}${String(r.n).padEnd(6)}先手 ${(r.rate * 100).toFixed(1)}%　最长 ${r.mt} 回合　卡局 ${r.st}`);
  }
  const bad = stuck + nan + badHp + neg + over + notZero;
  check(`② 压力：${games} 局（9 组合 × 2 族 × ${N}）全部在 200 回合内分胜负`, stuck === 0 && games > 0,
    `卡局 ${stuck}　最长 ${maxTurn} 回合（上限 200）`);
  check('② 压力：无 NaN、无负血、无 hp>hpMax、无 hpMax 错值、败方恰为 0',
    nan === 0 && badHp === 0 && neg === 0 && over === 0 && notZero === 0,
    `NaN=${nan} hpMax错=${badHp} 负血=${neg} 越上界=${over} 败方未归零=${notZero}`);
  check('② 压力：贴目随组合变而 hpMax 跟着变，且 hp 从不超上界',
    bad === 0, `${games} 局累计异常 ${bad} 处`);

  // 单调可分：这是"三档还分得开"的最小判据
  const em = rows.find((r) => r.a === 'easy' && r.b === 'medium');
  const hm = rows.find((r) => r.a === 'hard' && r.b === 'medium');
  check('② 单调可分：easy 打不过 medium（<47%）且 hard 打得过 medium（>53%）',
    em.rate < 0.47 && hm.rate > 0.53,
    `easy vs medium ${(em.rate * 100).toFixed(1)}%　hard vs medium ${(hm.rate * 100).toFixed(1)}%`);
}

console.log(`\n${fail ? '❌' : '✅'} 灰度+压力 ${pass}/${pass + fail} ${fail ? `（失败 ${fail}）` : ''}`);
process.exit(fail ? 1 : 0);
