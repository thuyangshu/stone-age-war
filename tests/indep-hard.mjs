// 独立用例 · hard 档残留专项（A5/A6 待验项的量化侧）
//
// 背景：docs/需求与验收.md §五/§七/§八 把 hard 档记为"本轮未处置的残留"，理由里有一条
// **承重的定性判断**：「这条响应是悬崖不是斜率（0 → 6 一跳 59 点），任何数值微调都可能
// 把它甩回 98% 或砸到 10% 以下」。那条判断是"不继续调 hard"的依据，也是"hard 只能靠
// 实机试玩判"的依据——所以它必须被独立量一遍，不能只引用表里的两个端点。
//
// 本文件与 indep-komi.mjs ⑤ 的分工：
//   indep-komi ⑤ 量的是**出厂分档表**下三档镜像各一个点（产品现状）。
//   本文件量的是**把分档表整体覆写成标量 k** 时 hard 镜像的整条曲线（响应形状）。
//   两者共用 komi-curve 的同一条覆写通道（DATA.KOMI = 标量），改动后必须都能跑。
//
// 判据（三条）：
//   ① 端点复现：hard 镜像在 k=0 与 k=6 的先手胜率必须落在合并样本 95%CI 内复现文档表值
//   ② 悬崖/斜率二选一：量相邻两点的跳幅，判"最大单步跳幅"是否 ≥ 全区间跨度的一半
//      —— 是则"悬崖"，否则"斜率"。这条把文档的形容词变成一个可判真假的量。
//   ③ 单调性：曲线必须单调下降（贴目越多先手越吃亏）；非单调说明 knobs 之间有耦合，
//      那比"悬崖"更麻烦，须单独记。
//
// 用法：node tests/indep-hard.mjs [每族局数，默认 1200] [贴目取值列表，默认 "0,6,8,10,12"]
//   第三参两种写法：
//     "10"            → 老用法，跑 k=0..10 的整数细网格（约 160 秒，量响应形状时用）
//     "0,6,8,10,12"   → 指定点（默认值：文档表两个端点 0/6 + 残留段关心的 8/10/12）
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const D = require(join(__dirname, '..', 'js', 'data.js'));
const W = require(join(__dirname, '..', 'js', 'world.js'));
const L = require(join(__dirname, '..', 'js', 'logic.js'));

const N = Number(process.argv[2]) || 1200;          // 每族局数

// 贴目采样点。2026-09-27 修：原来写的是
//   `const KMAX = Number(process.argv[3]) === undefined ? 10 : Number(process.argv[3]);`
// ——`Number(undefined)` 是 **NaN，不是 undefined**，所以第三参缺省时 KMAX=NaN，
// `for (let k = 0; k <= KMAX; k++)` 一次都不进，curve 是空数组，
// 后面 `curve.find(...).rate` 直接 TypeError（本文件此前"一跑即崩在 :105"的真因，
// 不是采样没写完）。下面按"整数 = 0..K 细网格 / 逗号列表 = 指定点"解析，缺省走 5 个点。
const DEFAULT_KS = [0, 6, 8, 10, 12];
const KS = (() => {
  const raw = process.argv[3];
  if (raw === undefined) return DEFAULT_KS;
  if (/^\d+$/.test(raw)) return Array.from({ length: Number(raw) + 1 }, (_, i) => i);
  const list = raw.split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  return [...new Set(list)].sort((a, b) => a - b);
})();
if (!KS.length) { console.error('贴目取值列表为空，无法采样'); process.exit(2); }
const Z = 1.96;
const SETS = [{ n: 'A', at: (i) => 5000 + i * 13 }, { n: 'B', at: (i) => 20260000 + i * 31 }];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `　${detail}` : ''}`);
};

// 把分档表覆写成标量 k，量 hard 镜像（同档同 AI，唯一不对称是回合顺序）的先手胜率
function mirrorRate(lv, k) {
  const keep = D.KOMI;
  D.KOMI = k;
  let w = 0, n = 0; const fam = [];
  let stuck = 0, nan = 0;
  for (const set of SETS) {
    let fw = 0, fn = 0;
    for (let i = 0; i < N; i++) {
      const r = L.simulateMatch(set.at(i), lv, lv);
      if (!r.ok) { if (r.reason === 'nan-hp') nan++; else stuck++; continue; }
      fn++; if (r.winner === 0) fw++;
    }
    fam.push(fn ? fw / fn : NaN); w += fw; n += fn;
  }
  D.KOMI = keep;
  return { k, rate: w / n, n, fam, ci: Z * Math.sqrt(0.25 / n), stuck, nan };
}

// ── 直击率（hist=5 锁定目标）：三档分得开的唯一量尺 ──────────────
// 与 tools/hitrate.cjs 同口径，但**独立实现**（不 require 那个工具，避免"工具错了
// 测试跟着错"）。差异只在种子基相同、口径以需求文档 §五 表头为准。
function hitRate(lv, HIST = 5) {
  const WEAPONS = require(join(__dirname, '..', 'js', 'data.js')).WEAPONS;
  let n = 0, hit = 0;
  for (let i = 0; i < N; i++) {
    const seed = 5000 + i * 13;
    const w = L.newBattle(seed);
    const me = L.newPlayer(w.spawns[0], 0);
    const foe = L.newPlayer(w.spawns[1], 1);
    const rng = W.mulberry32(seed * 31 + 7);
    me.shots = HIST;                       // 不设上，每发都会被 F30 硬保证推成"必偏"
    const act = L.aiChoose(w, [me, foe], 0, lv, rng);
    const wp = WEAPONS.find((x) => x.id === act.wp.id) || act.wp;
    const proj = L.makeProjectile(wp, me.x, me.y - 34, act.aim.angle, act.aim.power);
    proj.owner = 0;
    const r = L.simulate(w, proj, {}, { maxT: 20, players: [me, foe] });
    if (!r.impact) continue;
    n++;
    if (r.impact.type === 'direct') hit++;
  }
  return { lv, hit, n, rate: hit / n };
}

console.log(`hard 残留专项 · 每族 ${N} 局（合并 ${2 * N}，ci=±${(Z * Math.sqrt(0.25 / (2 * N)) * 100).toFixed(1)} 点）`);
console.log(`种子与 indep-a4 / indep-komi / bot-playtest 同基（A 5000+13i、B 20260000+31i）`);
console.log(`贴目采样点：${KS.join(' / ')}（共 ${KS.length} 点，每点 ${2 * N} 局）`);
// 低 N 误红保护（同 indep-a4 的建议级修复）：本文件 ③ 的直击率与 tools/hitrate.cjs 同口径，
// 口径最小 N = 1200/档。低于它时数字本身噪声过大，只能当诊断，不能拿来判产品对错。
if (N < 1200) {
  console.log(`⚠ N=${N} 低于本仪器口径最小 N（直击率 ≥1200 局/档，与 tools/hitrate.cjs 同口径；`
    + `跑 600 时 easy 读到 77.0% vs N=1200 的 73.3%）——本结果只作诊断，不作判定`);
}
console.log('');

// ── ① hard 镜像响应曲线（覆写标量）────────────────────────────
console.log('── ① hard 镜像先手胜率 vs 贴目（分档表整体覆写成标量）──');
const curve = [];
for (const k of KS) {
  const r = mirrorRate('hard', k);
  curve.push(r);
  console.log(`   komi ${String(k).padStart(2)} ｜ 先手 ${(r.rate * 100).toFixed(1)}%`
    + ` [${((r.rate - r.ci) * 100).toFixed(1)}, ${((r.rate + r.ci) * 100).toFixed(1)}]`
    + `　分族 ${r.fam.map((f) => (f * 100).toFixed(1)).join(' / ')}`
    + `　n=${r.n}${r.stuck || r.nan ? ` ⚠ 卡局${r.stuck} NaN${r.nan}` : ''}`);
}
console.log('');

// ①-a 端点复现文档表值（§五 那张曲线表的 hard 列）
{
  const at0 = curve.find((r) => r.k === 0), at6 = curve.find((r) => r.k === 6);
  // 文档表值：k=0 → 98.8% / 99.3%（分族），k=6 → 39.5% / 38.4%
  // 采样点里没有 0 / 6 时不判红也不静默跳过——打印一行醒目的跳过说明（缺的是文档端点，
  // 跳过了这条仪器就没量到"端点复现"，必须让人看见）
  for (const [k, r, want] of [[0, at0, '98.8% / 99.3%'], [6, at6, '39.5% / 38.4%']]) {
    if (!r) { console.log(`   ⚠ 本次采样点（${KS.join('/')}）不含 k=${k}，端点复现检查跳过——不是通过，是没量`); continue; }
    const ok = Math.abs(r.rate - (k === 0 ? 0.988 : 0.395)) <= r.ci + 0.01;
    check(`① k=${k} 端点复现文档表值（${want}）`, ok,
      `实测 ${(r.rate * 100).toFixed(1)}% 分族 ${r.fam.map((f) => (f * 100).toFixed(1)).join(' / ')}  n=${r.n}`);
  }
}

// ①-b 悬崖 vs 斜率：文档的定性判断（"0→6 一跳 59 点，是悬崖不是斜率"）能否成立
//      判据用"最大单步跳幅"占全区间跨度的比例：≥ 1/2 记悬崖。
//      这是把形容词变成可判真假的量，不是替作者拍板"该不该调"。
{
  const first = curve[0].rate, last = curve[curve.length - 1].rate;
  const span = first - last;                                  // 正数：贴目越大先手越吃亏
  let maxStep = 0, maxAt = -1, maxFrom = -1;
  for (let i = 1; i < curve.length; i++) {
    const d = curve[i - 1].rate - curve[i].rate;
    if (d > maxStep) { maxStep = d; maxAt = curve[i].k; maxFrom = curve[i - 1].k; }
  }
  const ratio = maxStep / span;
  check('① hard 镜像的响应是"悬崖"（最大单步跳幅 ≥ 全区间跨度的一半）', ratio >= 0.5,
    `跨度 ${(span * 100).toFixed(1)} 点（k=${curve[0].k}→k=${curve[curve.length - 1].k}），最大单步 ${(maxStep * 100).toFixed(1)} 点`
    + `（k=${maxFrom}→${maxAt}），占 ${(ratio * 100).toFixed(0)}%`);
  // 单步跳幅的具体值，供报告引用"任何一个中间值都不可靠"这句话
  console.log(`   （相邻跳幅：${curve.slice(1).map((r, i) => `k${curve[i].k}→${r.k} ${((curve[i].rate - r.rate) * 100).toFixed(1)}`).join('，')}）`);
}

// ①-c 单调性：曲线必须单调下降，非单调说明旋钮之间有耦合
{
  const up = [];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].rate > curve[i - 1].rate + curve[i].ci + curve[i - 1].ci) up.push(`k=${curve[i].k}`);
  }
  check('① 曲线单调不升（超出两倍 CI 的反向跳才算耦合）', up.length === 0,
    up.length ? `反向跳：${up.join('、')}` : `${curve.length} 个点无显著反弹`);
}

// ── ② 出场档位下 hard 镜像 = 产品的 hard 人机结构（§五"结构位移"那列）──
// 出厂分档表下 hard 档贴目是 6，所以这一格就是人机 hard 的结构代理量。
{
  const keep = D.KOMI;
  D.KOMI = keep;                                // 出厂表原样
  const r = mirrorRate('hard', 6);              // 6 === DATA.KOMI.hard
  check('② 出厂 hard 贴目确实是 6', keep.hard === 6, `DATA.KOMI.hard=${keep.hard}`);
  console.log(`   出厂 hard 镜像先手 ${(r.rate * 100).toFixed(1)}%（分族 ${r.fam.map((f) => (f * 100).toFixed(1)).join(' / ')}）`
    + ` → 人机 hard 结构位移约 ${((r.rate - 1) * 100).toFixed(0)} 点（相对"未贴目 98.8%"的代理量）`);
}

// ── ③ 直击率：三档分得开的量尺（文档 §五 残留段引用的是 73.3 / 90.2 / 99.9）──
console.log('\n── ③ 锁定目标第 5 发直击率（独立实现，不用 tools/hitrate.cjs）──');
{
  const rows = ['easy', 'medium', 'hard'].map((lv) => hitRate(lv));
  for (const r of rows) {
    console.log(`   ${r.lv.padEnd(7)} ${(r.rate * 100).toFixed(1)}%  (${r.hit}/${r.n})`);
  }
  const [e, m, h] = rows;
  check('③ 三档直击率单调（easy < medium < hard）', e.rate < m.rate && m.rate < h.rate,
    `${(e.rate * 100).toFixed(1)}% < ${(m.rate * 100).toFixed(1)}% < ${(h.rate * 100).toFixed(1)}%`);
  check('③ hard 直击率复现文档的"落回必中退化区"（≥ 99%）', h.rate >= 0.99,
    `实测 ${(h.rate * 100).toFixed(1)}%（文档表值 99.9%）`);
}

console.log(`\n${fail ? '❌' : '✅'} hard 残留专项 ${pass}/${pass + fail} ${fail ? `（失败 ${fail}）` : ''}`);
process.exit(fail ? 1 : 0);
