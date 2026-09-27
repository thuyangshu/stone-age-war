// 独立测试员用例：F30「AI 对全新目标第一发必偏」硬保证，按验收文档 §六 的口径逐条核对。
// 文档口径（docs/需求与验收.md §六）：三档 × 八武器 × 40 种子 = 960 发首发，
//   合格线 = 不直击 且 落点到目标的距离 ≥ AI.FIRST_SHOT_OFFSET（120px）。
// 常量名兼容两版：老 data.js 叫 FIRST_MISS_MIN，00:41 后改名 FIRST_SHOT_OFFSET（值都是 120）。
// 只读 js/data.js、js/logic.js、js/world.js，不碰产品代码。
// 用法：node tests/indep-f30.mjs
//
// ⚠ 2026-09-27 自纠（第一轮）：**量距的参照点有两个，本文件原先把它们当成一个**。
//   文档 §六 的「距离量法」行当时写的是：落点与 `(target.x, target.y − 30)`（旧圆圆心）的距离；
//   产品 firstShotOk 量的是落点与 `bodyMid(target)` 的距离，
//   `bodyMid = target.y − (HIT.BOT + HIT.TOP)/2 = target.y − 68.5`（受击胶囊改竖向之后的中点）。
//   两处差 38.5px：按文档字面量出 54 发"破线"（最小 93.0px），按产品口径是 0 发（最小 120.3px）。
//   结论：产品是对的，文档那处 y−30 是胶囊改版前的旧圆心。文档后来已订正。
//
// ⚠ 2026-09-27 再修（第二轮）：第一轮的修法**修错了方向**——把文档字面口径**写死在仪器里**
//   （`const REF_DOC = (t) => t.y - 30`）。于是文档订正成 bodyMid 之后这条比对永远红：
//   它比的是"仪器里那份旧字符串"和"产品"，**根本没读文档**。这不是闸门，是刻舟求剑——
//   文档改好了它红，文档改坏了它照样红，两种情况下给出的信号一模一样。
//   第二轮的修法：**现场读 docs/需求与验收.md §六 表格的「距离量法」行**，从中解析参照点表达式，
//   再拿它跟产品口径比。口径的**唯一来源是文档**，仪器只负责把两者摆到一起。
//   自证（本轮实测）：在仓库副本里把该行改回 `y − 30` → 本条变红；还原成 bodyMid → 变绿。
//   F30-c/g/h 按**产品口径**判产品对错；F30-e/e2 判**文档口径与产品口径是否同源**，
//   不同源说明受击体改版时又漏了一处，该订正的是文档（要偏出的是身体，不是身体下方 38.5px 的点）。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(pathToFileURL(join(ROOT, 'tests', 's.js')));
const D = require(join(ROOT, 'js', 'data.js'));
const W = require(join(ROOT, 'js', 'world.js'));
const L = require(join(ROOT, 'js', 'logic.js'));

let pass = 0, fail = 0;
const ck = (ok, name, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`); };

// ── 参照点口径：产品侧（firstShotOk 的 bodyMid）与文档侧（§六「距离量法」行）──
const PROD_OFF = (D.HIT.BOT + D.HIT.TOP) / 2;               // 产品：胶囊中点相对 y 的偏移，出厂 68.5
const REF_CODE = (t) => t.y - PROD_OFF;                     // 产品口径的参照点
// 文档口径解析器。只认两种写法，认不出就报"解析失败"（红），不猜：
//   ① 写成受击胶囊中点 / bodyMid / HIT.BOT + HIT.TOP 的中点式  → 与产品同源
//   ② 写成字面量 `y − N`（旧圆的 30 属于这一类）              → 与产品不同源就会红
const DOC_PATH = join(ROOT, 'docs', '需求与验收.md');
const parseDocRef = () => {
  let md;
  try { md = readFileSync(DOC_PATH, 'utf8'); } catch (e) { return { ok: false, why: `读不到 ${DOC_PATH}：${e.message}` }; }
  const line = md.split('\n').find((l) => /^\|\s*距离量法\s*\|/.test(l));
  if (!line) return { ok: false, why: '§六 的表格里找不到以「距离量法」开头的行' };
  const cell = (line.split('|')[2] || '').trim();
  const lit = cell.match(/y\s*[−–—-]\s*(\d+(?:\.\d+)?)/);   // 行内的字面量 y − N（注意 U+2212 减号）
  const litVal = lit ? Number(lit[1]) : null;
  if (/bodyMid\s*\(/.test(cell) || /HIT\.BOT\s*\+\s*HIT\.TOP/.test(cell)) {
    return { ok: true, kind: 'bodyMid', cell, lit: litVal };
  }
  if (litVal !== null) return { ok: true, kind: 'literal', off: litVal, cell, lit: litVal };
  return { ok: false, why: '「距离量法」行里既没有 bodyMid / HIT.BOT+HIT.TOP 的中点式，也没有字面量 y − N', cell };
};
const DOC = parseDocRef();
const DOC_OFF = DOC.ok ? (DOC.kind === 'bodyMid' ? PROD_OFF : DOC.off) : NaN;
const REF_DOC = (t) => t.y - DOC_OFF;                       // 文档口径的参照点（来自文档，不是写死的）
const docDesc = DOC.ok
  ? (DOC.kind === 'bodyMid' ? `受击胶囊中点 bodyMid（y − (HIT.BOT+HIT.TOP)/2）` : `字面量 y − ${DOC.off}`)
  : `解析失败（${DOC.why}）`;
const SHOT_OFF = D.AI.FIRST_SHOT_OFFSET ?? D.AI.FIRST_MISS_MIN;
console.log(`   合格线常量：${SHOT_OFF}px（${D.AI.FIRST_SHOT_OFFSET !== undefined ? 'FIRST_SHOT_OFFSET' : 'FIRST_MISS_MIN'}）`);

const levels = ['easy', 'medium', 'hard'];
const rows = [];
const allD = [];        // 按**产品口径**（distance to bodyMid）量的落点距
const allDDoc = [];     // 按**文档 §六 字面口径**（distance to y−30）量的落点距
let direct = 0, total = 0, noImpact = 0, noSolution = 0;
const foeHits = [];

console.log('\n══ F30 硬保证：960 发首发，真打一遍看落点（不是看瞄点）══');
for (const level of levels) {
  const d = [];
  let n = 0, dir = 0;
  const byWeapon = {};
  for (const weapon of D.WEAPONS) {
    byWeapon[weapon.id] = { directOnFoe: 0, directOnSelf: 0, min: Infinity, minDoc: Infinity };
    for (let s = 0; s < 40; s++) {
      const w = L.newBattle(5000 + s * 137);
      const me = { x: w.spawns[0].x, y: w.spawns[0].y, hp: 100, ammo: {}, shots: 0 };
      const foe = { x: w.spawns[1].x, y: w.spawns[1].y, hp: 100, ammo: {}, shots: 0 };
      const rng = W.mulberry32(70000 + s * 977 + D.WEAPONS.indexOf(weapon) * 31);
      const aim = L.aiAim(w, me, foe, weapon, level, rng, 0);      // hist=0：全新目标首发
      if (!aim) { noSolution++; continue; }
      const proj = L.makeProjectile(weapon, me.x, me.y - 34, aim.angle, aim.power);
      proj.owner = 0;
      const r = L.simulate(w, proj, {}, { players: [me, foe], maxT: 20 });
      const e = r.impact || (r.events && r.events.find((x) => x.type === 'direct' || x.type === 'ground' || x.type === 'bush'));
      if (!e) { noImpact++; continue; }
      total++; n++;
      const dist = Math.hypot(e.x - foe.x, e.y - REF_CODE(foe));   // 产品 firstShotOk 的判据
      const distDoc = Math.hypot(e.x - foe.x, e.y - REF_DOC(foe));  // 文档 §六 字面
      d.push(dist); allD.push(dist); allDDoc.push(distDoc);
      byWeapon[weapon.id].min = Math.min(byWeapon[weapon.id].min, dist);
      byWeapon[weapon.id].minDoc = Math.min(byWeapon[weapon.id].minDoc ?? Infinity, distDoc);
      // who=1 是被打的对手（真违反"第一发必偏"），who=0 是弹丸回头打到自己（另一码事）
      if (e.type === 'direct') { dir++; direct++; if (e.who === 1) { byWeapon[weapon.id].directOnFoe++; foeHits.push({ level, weapon: weapon.id, seed: s, x: +e.x.toFixed(0), y: +e.y.toFixed(0) }); } else { byWeapon[weapon.id].directOnSelf++; } }
    }
  }
  d.sort((a, b) => a - b);
  rows.push({ level, n, dir, min: d[0], med: d[Math.floor(d.length / 2)], under: d.filter((x) => x < SHOT_OFF).length, byWeapon });
  console.log(`   ${level.padEnd(6)} ${n} 发  直击 ${dir}  落点距靶心 min ${d[0].toFixed(1)}  中位 ${d[Math.floor(d.length / 2)].toFixed(1)}  <${SHOT_OFF}px 的 ${d.filter((x) => x < SHOT_OFF).length} 发`);
}
allD.sort((a, b) => a - b);
allDDoc.sort((a, b) => a - b);
console.log(`   合计 ${total} 发（无解 ${noSolution}，无落点 ${noImpact}）`);

const under120 = allD.filter((x) => x < 120).length;
const underOff = allD.filter((x) => x < SHOT_OFF).length;
const underOffDoc = allDDoc.filter((x) => x < SHOT_OFF).length;
const selfHits = rows.reduce((a, r) => a + Object.values(r.byWeapon).reduce((b, v) => b + v.directOnSelf, 0), 0);
console.log(`   直击明细：打到对手 ${foeHits.length} 发，弹丸回头打到自己 ${selfHits} 发`);
if (foeHits.length) console.log('   ' + JSON.stringify(foeHits));
for (const r of rows) {
  const bad = Object.entries(r.byWeapon).filter(([, v]) => v.directOnFoe || v.min < SHOT_OFF);
  if (bad.length) console.log(`   ${r.level} 的问题武器：` + bad.map(([k, v]) => `${k}(直击对手${v.directOnFoe} 最近${v.min === Infinity ? '-' : v.min.toFixed(0)}px)`).join(' '));
}
ck(foeHits.length === 0, 'F30-a 首发没有一发直接命中对手（硬保证的核心）',
  `打到对手 ${foeHits.length}/${total}${selfHits ? `；另有 ${selfHits} 发回头打到射手自己（不算违反 F30，但要另行判是否合理）` : ''}`);
ck(total === 960 || total > 900, 'F30-b 矩阵确实跑满了 3 档 × 8 武器 × 40 种子', `实得 ${total} 发`);
ck(underOff === 0, `F30-c 每发落点距**受击胶囊中点** ≥ ${SHOT_OFF}px（产品 firstShotOk 的实际判据）`,
  underOff ? `${underOff}/${total} 发不足 ${SHOT_OFF}px，最小 ${allD[0].toFixed(1)}px` : `全部 ≥${SHOT_OFF}px，最小 ${allD[0].toFixed(1)}px，中位 ${allD[Math.floor(allD.length / 2)].toFixed(1)}px`);
ck(under120 === underOff && SHOT_OFF === 120, 'F30-d 合格线常量就是文档 §六 写的 120px',
  SHOT_OFF === 120 ? '常量就是 120' : `常量是 ${SHOT_OFF}，与文档字面 120 不同`);
// F30-e 专判**文档口径与产品口径是否同源**。参照点是从文档 §六「距离量法」行**现场解析**出来的
// （见文件头第二轮说明：上一版把文档字面写死在仪器里，文档订正后这条永远红，等于没读文档）。
// 不同源说明受击体改版时把参照点挪了、而文档那行没跟着改（或反过来）。
// 这条红了要订正的是**文档**（产品量胶囊中点语义正确：要偏出的是身体，不是身体下方 38.5px 的一个点）。
const fmtPx = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'NaN');
console.log(`\n   文档 §六「距离量法」现场解析 → ${docDesc}`);
const driftPx = DOC.ok ? Math.abs(DOC_OFF - PROD_OFF) : NaN;
const eOk = DOC.ok && driftPx < 0.05 && underOffDoc === underOff;
ck(eOk, 'F30-e 验收文档 §六 的「距离量法」与产品口径（距 bodyMid）一致（口径现场读文档，不写死）',
  eOk
    ? `文档口径 = 产品口径（${docDesc}，即 y − ${PROD_OFF.toFixed(1)}），${total} 发里破线数一致（各 ${underOff} 发）`
    : !DOC.ok
      ? `文档口径解析失败：${DOC.why}`
      : `口径漂移 ${fmtPx(driftPx)}px：文档口径（${docDesc}）${underOffDoc}/${total} 发破线、最小 ${fmtPx(allDDoc[0])}px；`
        + `产品口径（距 bodyMid = y − ${PROD_OFF.toFixed(1)}）${underOff}/${total} 发破线、最小 ${fmtPx(allD[0])}px。`
        + `→ docs/需求与验收.md §六「距离量法」行与产品不同源，待订正（产品侧不改）`);
// F30-e2 同一类漂移的另一半：公式对、数字过期。文档那行若写了"出厂值即 y − N"，
// 该数值必须等于产品 HIT 现算出来的中点（改 HIT 时最容易只改代码漏改这个数）。
if (DOC.ok && DOC.kind === 'bodyMid' && DOC.lit !== null) {
  ck(Math.abs(DOC.lit - PROD_OFF) < 0.05, 'F30-e2 文档「距离量法」行写的出厂数值与产品 HIT 现算的中点一致',
    `文档写 y − ${DOC.lit}，产品 (HIT.BOT+HIT.TOP)/2 = (${D.HIT.BOT}+${D.HIT.TOP})/2 = ${PROD_OFF}`);
} else {
  console.log(`   ⚠ F30-e2 跳过（跳过≠通过）：${!DOC.ok ? '文档行解析失败' : DOC.kind !== 'bodyMid' ? '文档写的是字面量参照点，没有"公式+出厂数值"两部分可比' : '文档该行未写出厂数值'}`);
}

// ── 第三套种子再扫一遍（换一套种子构造，避免"只在自己那套种子上成立"）──
console.log('\n══ 加宽扫描：另一套种子 × 每件武器 200 个 × 三档 ══');
{
  let n = 0, hit = 0, minD = Infinity, under = 0;
  for (const level of levels) {
    let lvMin = Infinity, lvHit = 0;
    for (const [wi, weapon] of D.WEAPONS.entries()) {
      for (let s = 0; s < 200; s++) {
        const w = L.newBattle(31337 + s * 613 + wi * 17);
        const me = { x: w.spawns[0].x, y: w.spawns[0].y, hp: 100, ammo: {}, shots: 0 };
        const foe = { x: w.spawns[1].x, y: w.spawns[1].y, hp: 100, ammo: {}, shots: 0 };
        const aim = L.aiAim(w, me, foe, weapon, level, W.mulberry32(s * 7919 + wi * 13 + 5), 0);
        const proj = L.makeProjectile(weapon, me.x, me.y - 34, aim.angle, aim.power);
        proj.owner = 0;
        const r = L.simulate(w, proj, {}, { players: [me, foe], maxT: 20 });
        if (!r.impact) continue;
        n++;
        const d = Math.hypot(r.impact.x - foe.x, r.impact.y - REF_CODE(foe));   // 产品口径
        minD = Math.min(minD, d); lvMin = Math.min(lvMin, d);
        if (d < SHOT_OFF) under++;
        if (r.impact.type === 'direct' && r.impact.who === 1) { hit++; lvHit++; }
      }
    }
    console.log(`   ${level.padEnd(6)} 最近落点 ${lvMin.toFixed(1)}px，直击对手 ${lvHit}`);
  }
  ck(hit === 0 && under === 0, 'F30-h 换一套种子的 4800 发首发同样零直击、零破线',
    `${n} 发，直击 ${hit}，破线 ${under}，最近 ${minD.toFixed(1)}px`);
}

// ── 真实出手路径：aiChoose 真正会打出去的那一发（玩家对局里遇到的就是它）──
console.log('\n══ 真实出手路径：aiChoose 选出来的首发 ══');
{
  let n = 0, hit = 0, close = 0, hopelessFired = 0, minD = Infinity;
  const per = {};
  for (const level of levels) {
    per[level] = { n: 0, hit: 0, close: 0, hopleless: 0, min: Infinity };
    for (let s = 0; s < 200; s++) {
      const w = L.newBattle(6000 + s * 211);
      const players = [L.newPlayer(w.spawns[0], 0), L.newPlayer(w.spawns[1], 1)];
      const rng = W.mulberry32(80000 + s * 313 + level.length);
      const chosen = L.aiChoose(w, players, 0, level, rng);
      if (!chosen) continue;
      n++; per[level].n++;
      if (chosen.aim.hopeless) { hopelessFired++; per[level].hopleless++; }
      const proj = L.makeProjectile(chosen.wp, players[0].x, players[0].y - 34, chosen.aim.angle, chosen.aim.power);
      proj.owner = 0;
      const r = L.simulate(w, proj, {}, { players, maxT: 20 });
      const e = r.impact;
      if (!e) continue;
      const d = Math.hypot(e.x - players[1].x, e.y - REF_CODE(players[1]));   // 产品口径
      minD = Math.min(minD, d); per[level].min = Math.min(per[level].min, d);
      if (e.type === 'direct' && e.who === 1) { hit++; per[level].hit++; }
      if (d < SHOT_OFF) { close++; per[level].close++; }
    }
  }
  for (const lv of levels) console.log(`   ${lv.padEnd(6)} ${per[lv].n} 发  直击对手 ${per[lv].hit}  落点 <${SHOT_OFF}px 的 ${per[lv].close}  最近 ${per[lv].min.toFixed(1)}px  （hopeless 出手 ${per[lv].hopleless}）`);
  ck(hit === 0, 'F30-f aiChoose 真实出手的首发里没有直击对手', `直击 ${hit}/${n}`);
  ck(close === 0, `F30-g aiChoose 真实出手的首发落点全部 ≥ ${SHOT_OFF}px`, `${close}/${n} 不足，最近 ${minD.toFixed(1)}px`);
}

// ── 漏网那几发：推挤循环到底推不推得出去（决定修法是"提高上限"还是"得换兜底"）──
if (foeHits.length) {
  console.log('\n══ 漏网发：继续往外推能不能推出直击 ══');
  const hit0 = foeHits[0];
  const w = L.newBattle(5000 + hit0.seed * 137);
  const me = { x: w.spawns[0].x, y: w.spawns[0].y, hp: 100, ammo: {}, shots: 0 };
  const foe = { x: w.spawns[1].x, y: w.spawns[1].y, hp: 100, ammo: {}, shots: 0 };
  const weapon = D.WEAPONS.find((x) => x.id === hit0.weapon);
  const rng = W.mulberry32(70000 + hit0.seed * 977 + D.WEAPONS.indexOf(weapon) * 31);
  const aim = L.aiAim(w, me, foe, weapon, hit0.level, rng, 0);
  const direct = (angle, power) => {
    const p = L.makeProjectile(weapon, me.x, me.y - 34, angle, power);
    p.owner = 0;
    const r = L.simulate(w, p, {}, { maxT: 20, players: [me, foe] });
    return !!(r.impact && r.impact.type === 'direct');
  };
  const sign = foe.x < me.x ? -1 : 1;
  const run = (dir) => {
    let a = aim.angle, pw = aim.power;
    for (let i = 0; i < 60; i++) {
      a = L.clamp(a + dir * 0.03, 0, Math.PI); pw = L.clamp(pw * 0.94, D.PHYS.MIN_POWER, 1);
      if (!direct(a, pw)) return i + 1;
    }
    return null;
  };
  console.log(`   aiAim 交出的这发（${hit0.weapon}/${hit0.level}）确实是直击：${direct(aim.angle, aim.power)}`);
  console.log(`   顺着原方向再推 60 次：${run(sign) === null ? '仍然直击（推不出去）' : `第 ${run(sign)} 次推出`}`);
  console.log(`   反向推 60 次：${run(-sign) === null ? '仍然直击' : `第 ${run(-sign)} 次推出`}`);
  ck(run(sign) !== null || run(-sign) !== null,
    'F30-e 漏网那发只要多推几次就能推出直击（=> 改法可以是提高上限/换方向）',
    '推 60 次两个方向都出不去，就必须换兜底策略（例如改瞄别处/换武器/故意短打）');
}

console.log(`\nF30：${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
