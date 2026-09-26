// 双 AI 对战难度分布：不看胜率手感，只看数据够不够得着验收线
// 用法：node tests/bot-playtest.mjs [每档局数，默认 200]
//
// 验收线（见 docs/需求与验收.md）：
//   easy vs medium   → easy 胜率 ≤ 30%
//   medium vs medium → 45% ~ 55%（镜像局，先手不该有压倒优势）
//   hard vs medium   → hard 胜率 ≥ 75%
//
// 镜像局按 95% 置信区间判定而不是看点估计：N=60 时标准误就有 6.5%，
// 光看一个点估计会把"50% 上下抖一下"读成"先手有优势"（实测同一套逻辑
// 换个种子基能跑出 61.7%，再测 800 局才落回 54.1%±3.5%）。
// 另两档余量大（≤30% / ≥75%），点估计足够，但仍把区间一并打出来备查。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LOGIC = require('../js/logic.js');

const N = Number(process.argv[2]) || 200;
const PAIRS = [
  { a: 'easy', b: 'medium', desc: 'easy 胜率 ≤30%', want: (r, ci) => r + ci <= 0.30 },
  { a: 'medium', b: 'medium', desc: 'medium 镜像 45%~55%', want: (r, ci) => r - ci <= 0.55 && r + ci >= 0.45 },
  { a: 'hard', b: 'medium', desc: 'hard 胜率 ≥75%', want: (r, ci) => r - ci >= 0.75 },
];

let bad = 0;
console.log(`双 AI 对战 ${N} 局/档（固定种子序列，结果可复现）\n`);
console.log('对局'.padEnd(19) + 'A 胜率    95%CI       平均回合  未分胜负');
console.log('─'.repeat(68));

for (const { a, b, desc, want } of PAIRS) {
  let aWin = 0, turns = 0, done = 0, stuck = 0, nan = 0;
  for (let i = 0; i < N; i++) {
    const r = LOGIC.simulateMatch(5000 + i * 13, a, b);
    if (!r.ok) { if (r.reason === 'nan-hp') nan++; else stuck++; continue; }
    done++; turns += r.turns;
    if (r.winner === 0) aWin++;      // simulateMatch 里玩家 0 恒为先手
  }
  if (!done) { console.log(`${a} vs ${b}：一局都没打完`); bad++; continue; }
  const rate = aWin / done;
  const ci = 1.96 * Math.sqrt(0.25 / done);
  const ok = want(rate, ci) && stuck === 0 && nan === 0;
  if (!ok) bad++;
  console.log(
    `${a} vs ${b}`.padEnd(19)
    + `${(rate * 100).toFixed(1)}%`.padEnd(10)
    + `±${(ci * 100).toFixed(1)}%`.padEnd(11)
    + `${(turns / done).toFixed(1)}`.padEnd(10)
    + `${stuck}${nan ? ` (NaN ${nan})` : ''}`
    + `   ${ok ? '✅' : '❌'} ${desc}`,
  );
}
console.log('');
if (bad) { console.log(`❌ ${bad} 档不达标`); process.exit(1); }
console.log('✅ 三档难度全部落在验收区间内');
