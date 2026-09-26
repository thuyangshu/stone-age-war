// A4 难度验收线 · 判定口径（测试侧持有，2026-09-27 起；此前口径由开发持有，审计第 5 轮裁定越界）
//
// 口径（三档统一）：
//   95% 置信区间（1.96·√(p(1-p)/n)）不得越过验收线。线在哪一侧由该档语义定：
//     easy  vs medium：easy 胜率 ≤ 30%  → 区间**上沿** ≤ 30%
//     hard  vs medium：hard 胜率 ≥ 75%  → 区间**下沿** ≥ 75%
//     medium 镜像：45% ~ 55%            → 区间**完全落在**带内（等价性检验形式）
//   判定做在**合并样本**上：两族种子（A/B）合并成一个 n 再算区间，分族数字只作诊断打印。
//   理由：两族"各自都过"= 两个 95% 事件相乘，误红率翻倍（真值 51.4%、N=2400/族时
//   单族 94.2% → 两族都过只剩 88.7%）。合并后仍是同一批 4800 局、同一批世界，
//   覆盖不变，只是判定不再让两个独立噪声相与。
//   N = 2400/族/对局（镜像合并 4800；easy/hard 同样 2×2400，全量 14400 局约 75 秒）。
//   最小 N 的算术见 docs/需求与验收.md §五。
//
// 与前版口径的关系：N=200 时区间半宽 6.9% > 带宽 ±5%，镜像两侧硬线连"完美 50%"都判红
// （需要 rate≥51.9% 且 rate≤48.1%，空集）——那是口径与 N 共同造成的空集，不是产品缺陷。
// 本文件也保留"点估计比线"的反例打印，供审计复核。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const LOGIC = require(join(__dirname, '..', 'js', 'logic.js'));

const N = Number(process.argv[2]) || 2400;        // 每族局数
const Z = 1.96;                                    // 95% 置信区间
const SEEDS = [
  { name: 'A', at: (i) => 5000 + i * 13 },
  { name: 'B', at: (i) => 20260000 + i * 31 },
];
// 线：lo=null 表示无下沿；hi=null 表示无上沿
const PAIRS = [
  { a: 'easy',   b: 'medium', lo: null, hi: 0.30, desc: 'easy 胜率 ≤30%' },
  { a: 'medium', b: 'medium', lo: 0.45, hi: 0.55, desc: '镜像 45~55%' },
  { a: 'hard',   b: 'medium', lo: 0.75, hi: null, desc: 'hard 胜率 ≥75%' },
];

console.log(`A4 口径：95%CI 不得越线；判定在合并样本上（两族合并），分族仅诊断`);
console.log(`N=${N}/族/对局 → 合并 2×${N}=${2 * N}\n`);
console.log('对局'.padEnd(17) + '族'.padEnd(4) + 'n'.padEnd(7) + '先手胜率'.padEnd(10)
  + '95%CI'.padEnd(20) + '验收线'.padEnd(13) + '平均回合'.padEnd(9) + '未完成');
console.log('─'.repeat(100));

let bad = 0;
const pooledRows = [];
for (const { a, b, lo, hi, desc } of PAIRS) {
  const perFam = [];
  let pw = 0, pn = 0, turns = 0, stuck = 0, nan = 0;   // pooled
  for (const set of SEEDS) {
    let aWin = 0, done = 0, fTurns = 0, fStuck = 0, fNan = 0;
    for (let i = 0; i < N; i++) {
      const r = LOGIC.simulateMatch(set.at(i), a, b);
      if (!r.ok) { if (r.reason === 'nan-hp') fNan++; else fStuck++; continue; }
      done++; fTurns += r.turns;
      if (r.winner === 0) aWin++;                       // simulateMatch 里玩家 0 恒为先手
    }
    perFam.push({ name: set.name, n: done, win: aWin, turns: fTurns, stuck: fStuck, nan: fNan });
    pw += aWin; pn += done; turns += fTurns; stuck += fStuck; nan += fNan;
  }
  // 分族诊断（不参与判定）
  for (const f of perFam) {
    const rate = f.n ? f.win / f.n : NaN;
    const ci = f.n ? Z * Math.sqrt(0.25 / f.n) : NaN;
    console.log(
      (f.name === SEEDS[0].name ? `${a} vs ${b}` : '').padEnd(17)
      + f.name.padEnd(4) + String(f.n).padEnd(7)
      + `${(rate * 100).toFixed(1)}%`.padEnd(10)
      + `[${((rate - ci) * 100).toFixed(1)}%, ${((rate + ci) * 100).toFixed(1)}%]`.padEnd(20)
      + `${lo === null ? '' : (lo * 100).toFixed(0) + '%'}${lo !== null && hi !== null ? '~' : ''}${hi === null ? '' : (hi * 100).toFixed(0) + '%'}`.padEnd(13)
      + `${(f.turns / f.n).toFixed(1)}`.padEnd(9)
      + `${f.stuck}${f.nan ? ` (NaN ${f.nan})` : ''}`,
    );
  }
  // 合并判定
  const rate = pw / pn;
  const ci = Z * Math.sqrt(0.25 / pn);
  const low = rate - ci, up = rate + ci;
  const ok = (lo === null || low >= lo) && (hi === null || up <= hi) && stuck === 0 && nan === 0;
  if (!ok) bad++;
  const div = Math.abs(perFam[0].win / perFam[0].n - perFam[1].win / perFam[1].n);
  console.log(
    ''.padEnd(17) + '合并'.padEnd(4) + String(pn).padEnd(7)
    + `${(rate * 100).toFixed(1)}%`.padEnd(10)
    + `[${(low * 100).toFixed(1)}%, ${(up * 100).toFixed(1)}%]`.padEnd(20)
    + '→'.padEnd(13)
    + `${(turns / pn).toFixed(1)}`.padEnd(9)
    + `${ok ? '✅' : '❌'} ${desc}`
    + `　族间差 ${(div * 100).toFixed(1)} 点${div > 0.03 ? ' ⚠ 种子敏感' : ''}`,
  );
  pooledRows.push({ pair: `${a} vs ${b}`, n: pn, rate, low, up, ok, desc });
}
console.log('');
if (bad) { console.log(`❌ ${bad} 档不达标（合并口径）`); process.exit(1); }
console.log('✅ 三档在合并样本上都不越线');
