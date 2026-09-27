// 独立用例：后手贴目 · 逻辑层
// 2026-09-27 第二轮：贴目由标量 12 改为分档表 DATA.KOMI = {easy:0, medium:12, hard:6}，
// 本文件从头按"分档"重写——原版通篇按标量写（`D.HP + D.KOMI`），分档后那是字符串拼接。
//
// 目的：验贴目的机械后果，不只验"表里是那几个数"——
//   ⓪ komiFor 取值规则：取较高档、顺序无关、认不出的档落 medium 锚定值、标量覆写仍可用
//   ① 发放对象是回合顺序（player 1），不是"人/AI"，且三种走法共用 newPlayer 一条规则
//   ② hpMax 与 hp 一致（血条比例要用 hpMax，满血不会溢出）
//   ③ 贴目血不参与任何 100 夹取：直击/溅射/灼烧都在 HP+komi 基数上算
//   ④ 收尾不变量：0 ≤ hp ≤ hpMax、败方 hp 恰为 0、无 NaN、胜方 hp 可以 >100（证明没有 100 夹取）
//   ⑤ 贴目不改变伤害数值与灼烧节奏（只改分母）
// 用法：node tests/indep-komi.mjs [对局数]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const D = require(join(__dirname, '..', 'js', 'data.js'));
const W = require(join(__dirname, '..', 'js', 'world.js'));
const L = require(join(__dirname, '..', 'js', 'logic.js'));

const MATCHES = Number(process.argv[2]) || 400;   // 同时用作 ⑤ 的每族镜像是局数
const LV = ['easy', 'medium', 'hard'];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `　${detail}` : ''}`);
};

const komiOf = (lv) => D.KOMI[lv];
console.log(`贴目表 KOMI=${JSON.stringify(D.KOMI)}，HP=${D.HP} → `
  + LV.map((lv) => `${lv} 后手满血 ${D.HP + komiOf(lv)}`).join('，'));
console.log('');

// ── ⓪ komiFor 取值规则（分档后新增的白盒块）────────────────────
// 这是"哪一档发多少"的唯一实现，分档表本身只是数据。它错了，三条难度线全部失去意义。
{
  // 取较高档：先手优势的大小随**这一局**的命中率走，不随某一方的水平走
  const higher = [['easy', 'hard', 6], ['hard', 'easy', 6], ['easy', 'medium', 12],
    ['medium', 'easy', 12], ['medium', 'hard', 6], ['hard', 'medium', 6]];
  const bad = higher.filter(([a, b, want]) => L.komiFor(a, b) !== want);
  check('⓪ 取双方里较高的一档', bad.length === 0,
    higher.map(([a, b]) => `${a}+${b}=${L.komiFor(a, b)}`).join(' '));

  // 同档就是它自己
  const same = LV.filter((lv) => L.komiFor(lv, lv) !== komiOf(lv));
  check('⓪ 同档取它自己', same.length === 0,
    LV.map((lv) => `${lv}=${L.komiFor(lv, lv)}`).join(' '));

  // 参数顺序无关
  const order = [];
  for (const a of LV) for (const b of LV) {
    if (L.komiFor(a, b) !== L.komiFor(b, a)) order.push(`${a}/${b}`);
  }
  check('⓪ 参数顺序无关（komiFor(a,b) === komiFor(b,a)）', order.length === 0,
    order.length ? `不对称：${order.join('、')}` : '九种组合全部对称');

  // 认不出的档 → medium 锚定值。含 undefined / null / 空串 / 大小写错 / 拼错
  const junk = [undefined, null, '', ' ', 'EASY', 'Medium', 'eas', 'hardx', 0, 1, 2, NaN, {}, []];
  const junkRes = junk.map((j) => {
    const k = L.komiFor(j, undefined);
    const w = L.newBattle(1);
    const p = L.newPlayer(w.spawns[1], 1, k);     // 真的发下去，看 hp 会不会烂
    return { j, k, hp: p.hp, hpMax: p.hpMax, ok: k === komiOf('medium') && Number.isFinite(p.hpMax) };
  });
  const junkBad = junkRes.filter((r) => !r.ok);
  check('⓪ 认不出的档落 medium 锚定值且 hp 仍是有限数',
    junkBad.length === 0,
    junkBad.length ? junkBad.map((r) => `${JSON.stringify(r.j)}→${JSON.stringify(r.k)}, hpMax=${JSON.stringify(r.hpMax)}`).join('；')
      : `${junkRes.length} 种垃圾输入全部 → ${komiOf('medium')}`);

  // 原型链名：`lv in RANK` 对 Object.prototype 上的键（toString / constructor / __proto__ …）
  // 也返回 true，于是 best 被设成该名字，K[best] 取到的是**函数**而不是数字。
  // 后果不是 NaN 而是字符串（"100function toString() { [native code] }"）：hp 变成非数字字符串，
  // hp<=0 恒 false（打不死）、hp/hpMax = NaN（血条崩）。这条与注释里"宁可发锚定值，
  // 也不要发 undefined 把 hp 变成 NaN"的意图直接冲突，单列一条。
  const proto = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];
  const protoRes = proto.map((j) => {
    const k = L.komiFor(j, undefined);
    const w = L.newBattle(1);
    const p = L.newPlayer(w.spawns[1], 1, k);
    return { j, k, hpMax: p.hpMax,
      ok: typeof k === 'number' && Number.isFinite(k) && Number.isFinite(p.hpMax) };
  });
  const protoBad = protoRes.filter((r) => !r.ok);
  check('⓪ 原型链上的键名（toString/constructor/__proto__…）也落锚定值，不得发出函数/对象',
    protoBad.length === 0,
    protoBad.length
      ? protoBad.map((r) => `${r.j}→${typeof r.k} hpMax=${JSON.stringify(r.hpMax).slice(0, 46)}`).join('；')
      : `${proto.length} 种全部落锚定值`);

  // 返回值必须**永远**是有限数：把上面所有输入汇总成一条不变量
  const allBad = [...junkRes, ...protoRes].filter((r) => !(typeof r.k === 'number' && Number.isFinite(r.k)));
  check('⓪ komiFor 返回值恒为有限数（任何输入都不返回 undefined/NaN/函数/对象）',
    allBad.length === 0,
    allBad.length ? allBad.map((r) => `${r.j}→${typeof r.k}`).join('、') : `${junk.length + proto.length} 种输入`);

  // 标量覆写：tools/komi-curve.cjs 靠这条扫曲线。断了它，那条工具会静默退化成"三档同值"
  // ——不报错、照样出三个数，但三个数是同一个世界的，曲线失去意义（静默失败）。
  {
    const keep = D.KOMI;
    const scalar = [0, 6, 8, 12, 12.5];
    let bad2 = [];
    for (const s of scalar) {
      D.KOMI = s;
      for (const [a, b] of [['easy', 'easy'], ['easy', 'hard'], ['hard', 'easy'],
        ['medium', 'medium'], ['hard', 'hard'], [undefined, null], ['easy', undefined]]) {
        if (L.komiFor(a, b) !== s) bad2.push(`${a}/${b}@${s}→${L.komiFor(a, b)}`);
      }
      // newPlayer 的默认路径也要跟着走标量
      const w = L.newBattle(1);
      if (L.newPlayer(w.spawns[1], 1).hpMax !== D.HP + s) bad2.push(`newPlayer默认@${s}`);
    }
    D.KOMI = keep;
    check('⓪ DATA.KOMI 被覆写成标量时按标量发（komi-curve 工具依赖这条）',
      bad2.length === 0 && D.KOMI === keep,
      bad2.length ? bad2.join('、') : `${scalar.length} 个标量 × 7 种档位组合全对，事后已还原`);
  }

  // newPlayer 的第三参缺省 = komiFor() 的默认（medium 锚定值），不是 0 也不是 NaN
  {
    const w = L.newBattle(1);
    const d = L.newPlayer(w.spawns[1], 1);
    check('⓪ newPlayer 省略 komi 时按 medium 锚定值发（不是 0、不是 NaN）',
      d.hpMax === D.HP + komiOf('medium') && Number.isFinite(d.hp),
      `hpMax=${d.hpMax}（期望 ${D.HP + komiOf('medium')}）`);
  }
}

// ── ① 发放：按 idx（回合顺序）──────────────────────────────────
{
  const w = L.newBattle(1);
  for (const lv of LV) {
    const k = komiOf(lv);
    const p0 = L.newPlayer(w.spawns[0], 0, k);
    const p1 = L.newPlayer(w.spawns[1], 1, k);
    check(`① komi=${String(k).padEnd(2)}（${lv}）newPlayer(…,0) 满血 = HP，hp === hpMax`,
      p0.hp === D.HP && p0.hpMax === D.HP, `hp=${p0.hp} hpMax=${p0.hpMax}`);
    check(`① komi=${String(k).padEnd(2)}（${lv}）newPlayer(…,1) 满血 = HP + komi，hp === hpMax`,
      p1.hp === D.HP + k && p1.hpMax === D.HP + k, `hp=${p1.hp} hpMax=${p1.hpMax}`);
    check(`① komi=${String(k).padEnd(2)}（${lv}）idx 字段如实记录回合顺序`,
      p0.idx === 0 && p1.idx === 1, `idx=${p0.idx}/${p1.idx}`);
    const ratio = p1.hp / (p1.hpMax || D.HP);
    check(`① komi=${String(k).padEnd(2)}（${lv}）后手血条比例 = 1.0，满血不溢出`,
      Math.abs(ratio - 1) < 1e-9, `hp/hpMax=${ratio}`);
  }
}

// ── ② 贴目血不被 100 夹取：直击/溅射/灼烧都在 HP+komi 基数上算 ──
for (const lv of LV) {
  const K = komiOf(lv), FULL = D.HP + K;
  const stone = D.WEAPONS[0];
  const w = L.newBattle(7);
  const ps = [L.newPlayer(w.spawns[0], 0, K), L.newPlayer(w.spawns[1], 1, K)];
  const out = L.settleImpact({ type: 'direct', who: 1, x: ps[1].x, y: ps[1].y - 30 }, stone, ps, 0);
  const dmg = out.hits.reduce((s, h) => s + h.dmg, 0);
  check(`②[${lv}] 直击后手：${FULL} − 伤害，不被夹到 ${D.HP}`,
    ps[1].hp === FULL - dmg && (K === 0 || ps[1].hp < D.HP),
    `${FULL} − ${dmg} = ${ps[1].hp}`);

  const q = L.newPlayer(w.spawns[1], 1, K);
  q.burn = { turns: 3, dmg: 2 };
  const t1 = L.tickBurn(q);
  check(`②[${lv}] 灼烧伤害不随贴目缩放（仍 2 点/回合）`,
    t1 === 2 && q.hp === FULL - 2, `tick 后 hp=${q.hp}（${FULL}−2）`);
  // "贴目血没被 100 夹掉"的**确定性**证据就在这里：扣完 2 点仍高于 100。
  // 不靠"跑很多局总能碰上几个胜方 >100"——那是概率事件，N 小就假红（测试方自纠：
  // 原来这条挂在 ③ 的 fuzz 计数上，N=40 时 0 局、N=400 时才 3 局）。
  check(`②[${lv}] 扣血后 hp 恰为 ${FULL}−2`
    + (K > 0 ? `，且仍 > ${D.HP}（贴目血没被 100 夹掉）` : `（K=0，无贴目可夹）`),
    q.hp === FULL - 2 && (K === 0 || q.hp > D.HP),
    `hp=${q.hp}（${FULL}−2），K=${K}`);
  const r = L.newPlayer(w.spawns[1], 1, K);
  r.hp = 1; r.burn = { turns: 2, dmg: 2 };
  L.tickBurn(r);
  check(`②[${lv}] 灼烧致死夹到 0（不出现负血/NaN）`,
    r.hp === 0 && Number.isFinite(r.hp), `hp=${r.hp}`);
  const s = L.newPlayer(w.spawns[0], 0, K);
  check(`②[${lv}] tickBurn 对无灼烧者返回 0 且不改血`,
    L.tickBurn(s) === 0 && s.hp === D.HP, `hp=${s.hp}`);
}

// ── ③ 整局不变量（fuzz）──────────────────────────────────────
{
  let n = 0, nan = 0, over = 0, under = 0, badMax = 0, loserAlive = 0, winnerOver100 = 0, stuck = 0;
  let maxSeen = 0, minLoser = 1e9;
  for (let s = 0; s < MATCHES; s++) {
    const a = LV[s % 3], b = LV[(s * 7 + 1) % 3];
    const r = L.simulateMatch(910000 + s * 37, a, b);
    if (!r.ok) { stuck++; continue; }
    n++;
    const want = L.komiFor(a, b);
    r.players.forEach((p, i) => {
      if (p.hpMax !== D.HP + (i === 1 ? want : 0)) badMax++;
      if (!Number.isFinite(p.hp) || !Number.isFinite(p.hpMax)) nan++;
      if (p.hp > p.hpMax) over++;
      if (p.hp < 0) under++;
    });
    const win = r.players[r.winner], los = r.players[1 - r.winner];
    if (los.hp !== 0) loserAlive++;
    if (win.hp > D.HP) winnerOver100++;
    maxSeen = Math.max(maxSeen, win.hp);
    minLoser = Math.min(minLoser, los.hp);
  }
  check('③ fuzz：每局 hpMax 恒为 HP / HP+komiFor(a,b)（不随种子变）',
    badMax === 0, `${n} 局，错 ${badMax} 处`);
  check('③ fuzz：0 ≤ hp ≤ hpMax，无 NaN、无越界',
    nan === 0 && over === 0 && under === 0, `NaN=${nan} 越上界=${over} 负血=${under}`);
  check('③ fuzz：败方 hp 恰为 0（夹取正确）',
    loserAlive === 0, `不合规 ${loserAlive} 局，最小败方血 ${minLoser}`);
  // 这条**故意不再断言** winnerOver100 > 0：那是"跑够多局总会碰上几个胜方 >100"的
  // 概率事件，N=40 时 0 局就假红（测试方自纠，2026-09-27）。"贴目血没被 100 夹掉"
  // 的确定性证据在 ②（扣完 2 点仍 >100）。这里只留不变量：谁都不许超自己的上限。
  check('③ fuzz：胜方 hp 不超各自上限（贴目血没被夹掉、也没越上界）',
    maxSeen <= D.HP + Math.max(...LV.map(komiOf)),
    `${n} 局，最大胜方血 ${maxSeen.toFixed(1)}（上限 ${D.HP + Math.max(...LV.map(komiOf))}）；`
    + `其中 >100 的 ${winnerOver100} 局（诊断量，非断言）`);
  check('③ fuzz：无卡局/无 NaN 对局（贴目没把对局拖成死循环）',
    stuck === 0, `未完成 ${stuck} 局`);
}

// ── ④ 贴目按回合顺序发：等级差 / 镜像一视同仁 ────────────────
{
  const cases = [['easy', 'hard'], ['hard', 'easy'], ['medium', 'medium'], ['easy', 'easy'],
    ['hard', 'hard'], ['easy', 'medium'], ['medium', 'hard']];
  let bad = 0;
  const seen = [];
  for (const [a, b] of cases) {
    const r = L.simulateMatch(555001, a, b);
    const want = L.komiFor(a, b);
    seen.push(`${a}/${b}=${want}`);
    if (!r.ok) { bad++; continue; }
    if (r.players[0].hpMax !== D.HP || r.players[1].hpMax !== D.HP + want) bad++;
    if (r.players[0].idx !== 0 || r.players[1].idx !== 1) bad++;
  }
  check('④ 贴目只认回合顺序（0 号不给），发的是双方较高档，与谁是谁无关',
    bad === 0, seen.join(' '));
}

// ── ⑤ 贴目的档位效果曲线（测量，不是判定）──────────────────────
// 贴目按回合顺序发 → **人机的每一档都是"人类先手 100 血 vs AI 后手 HP+该档贴目 血"**，
// 与镜像局结构相同。所以这条曲线同时就是"人机各档被贴目推了多少"的结构估计。
// 只打印不设死断言：将来若改成按别的方式发贴目，数字会变，那正是要看的效果。
{
  const N = MATCHES;
  const SETS = [(i) => 5000 + i * 13, (i) => 20260000 + i * 31];
  console.log(`\n⑤ 贴目后的镜像先手胜率（人机=人类坐先手席的结构位移）· 合并 2×${N}`);
  const row = {};
  for (const lv of LV) {
    let w = 0, n = 0; const fam = [];
    for (const at of SETS) {
      let fw = 0, fn = 0;
      for (let i = 0; i < N; i++) {
        const r = L.simulateMatch(at(i), lv, lv);
        if (!r.ok) continue;
        fn++; if (r.winner === 0) fw++;
      }
      fam.push(fw / fn); w += fw; n += fn;
    }
    const rate = w / n;
    row[lv] = rate;
    console.log(`   ${lv.padEnd(7)}贴目 ${String(komiOf(lv)).padStart(2)} ｜ 先手 ${(rate * 100).toFixed(1)}%`
      + ` ｜ 后手（带贴目）${((1 - rate) * 100).toFixed(1)}%`
      + `　分族 ${fam.map((f) => (f * 100).toFixed(1)).join(' / ')}`);
  }
  check('⑤ 三档镜像都跑满、无卡局（贴目的档位曲线是量出来的，不设设计断言）',
    Object.values(row).every((v) => v > 0 && v < 1),
    LV.map((k) => `${k} ${(row[k] * 100).toFixed(1)}%`).join(' ｜ '));
}

console.log(`\n${fail ? '❌' : '✅'} 贴目逻辑层 ${pass}/${pass + fail} ${fail ? `（失败 ${fail}）` : ''}`);
process.exit(fail ? 1 : 0);
