// 双 AI 对战难度分布：不看胜率手感，只看数据够不够得着验收线
// 用法：node tests/bot-playtest.mjs [每档局数，默认 200]
//
// 验收线（见 docs/需求与验收.md §五）：
//   easy vs medium   → easy 胜率 ≤ 30%
//   medium vs medium → 45% ~ 55%（镜像局，先手不该有压倒优势）
//   hard vs medium   → hard 胜率 ≥ 75%
//
// 判定口径（三档同一条规则，2026-09-27 统一）：**95% 置信区间不得越过验收线**。
// 验收线是硬线，区间只要沾到线外就算不达标——这条对三档一视同仁，
// 每档的"线在哪一侧"由它自己的语义决定，规则本身不偏不倚：
//   easy    ≤30%    → 区间上沿 ≤30
//   medium  45~55%  → 区间下沿 ≥45 且 区间上沿 ≤55（两侧都是硬线）
//   hard    ≥75%    → 区间下沿 ≥75
// 为什么不用"区间与验收带相交就算过"：那条太松。N=200 时标准误 3.5%，
// 真值 60% 的区间下沿也能压到 53%，照样与 45~55 相交——先手优势大到 60%
// 也判合格，等于这条线形同虚设。也不用点估计：N=200 时抖一下就有 3.5%，
// 会把"50% 上下正常波动"读成"先手有优势"。
//
// 每条对局跑**两套独立种子**：单套种子量出来的胜率会偏。实测 medium 镜像在
// 四套种子（各 400 局）上分别是 59.5% / 62.5% / 57.5% / 62.7%——只跑一套
// 会把"这套种子恰好偏低"当成"达标"。两套都过才算这一档过。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const LOGIC = require('../js/logic.js');

const N = Number(process.argv[2]) || 200;
// 两套种子基：bot-playtest 历来用的一套，加一套独立的大间隔序列
const SEEDS = [
  { name: 'A', at: (i) => 5000 + i * 13 },
  { name: 'B', at: (i) => 20260000 + i * 31 },
];
// lo/hi = 验收线（null 表示这一侧不设线）
const PAIRS = [
  { a: 'easy', b: 'medium', desc: 'easy 胜率 ≤30%', lo: null, hi: 0.30 },
  { a: 'medium', b: 'medium', desc: 'medium 镜像 45%~55%', lo: 0.45, hi: 0.55 },
  { a: 'hard', b: 'medium', desc: 'hard 胜率 ≥75%', lo: 0.75, hi: null },
];

let bad = 0;
console.log(`双 AI 对战 ${N} 局/档/套种子（固定种子序列，结果可复现）\n`);
console.log('对局'.padEnd(17) + '种子'.padEnd(6) + 'A 胜率'.padEnd(11)
  + '95%CI 区间'.padEnd(20) + '验收线'.padEnd(14) + '平均回合  未分胜负');
console.log('─'.repeat(96));

for (const { a, b, desc, lo, hi } of PAIRS) {
  for (const set of SEEDS) {
    let aWin = 0, turns = 0, done = 0, stuck = 0, nan = 0;
    for (let i = 0; i < N; i++) {
      const r = LOGIC.simulateMatch(set.at(i), a, b);
      if (!r.ok) { if (r.reason === 'nan-hp') nan++; else stuck++; continue; }
      done++; turns += r.turns;
      if (r.winner === 0) aWin++;      // simulateMatch 里玩家 0 恒为先手
    }
    if (!done) { console.log(`${a} vs ${b} 种子${set.name}：一局都没打完`); bad++; continue; }
    const rate = aWin / done;
    const ci = 1.96 * Math.sqrt(0.25 / done);
    const low = rate - ci, up = rate + ci;
    const ok = (lo === null || low >= lo) && (hi === null || up <= hi) && stuck === 0 && nan === 0;
    if (!ok) bad++;
    const lineTxt = `${lo === null ? '' : `${(lo * 100).toFixed(0)}%`}`
      + `${lo !== null && hi !== null ? '~' : ''}${hi === null ? '' : `${(hi * 100).toFixed(0)}%`}`;
    console.log(
      (set.name === SEEDS[0].name ? `${a} vs ${b}` : '').padEnd(17)
      + set.name.padEnd(6)
      + `${(rate * 100).toFixed(1)}%`.padEnd(11)
      + `[${(low * 100).toFixed(1)}%, ${(up * 100).toFixed(1)}%]`.padEnd(20)
      + lineTxt.padEnd(14)
      + `${(turns / done).toFixed(1)}`.padEnd(10)
      + `${stuck}${nan ? ` (NaN ${nan})` : ''}`
      + `   ${ok ? '✅' : '❌'} ${set.name === SEEDS[0].name ? desc : ''}`,
    );
  }
}
console.log('');
if (bad) { console.log(`❌ ${bad} 行不达标（同一条对局两套种子都过才算这一档过）`); process.exit(1); }
console.log('✅ 三档难度在两套独立种子上都落在验收区间内');
