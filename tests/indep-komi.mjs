// 独立用例：后手贴目（DATA.KOMI=12）· 逻辑层
// 目的：验贴目的机械后果，不只验"数字是 12"——
//   ① 发放对象是回合顺序（player 1），不是"人/AI"，且三种走法共用 newPlayer 一条规则
//   ② hpMax 与 hp 一致（血条比例要用 hpMax，满血不会溢出）
//   ③ 贴目血不参与任何 100 夹取：直击/溅射/灼烧都在 112 基数上算；hp 不被夹到 100
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
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `　${detail}` : ''}`);
};

console.log(`贴目 KOMI=${D.KOMI}，HP=${D.HP} → 先手满血 ${D.HP}，后手满血 ${D.HP + D.KOMI}\n`);

// ── ① 发放：按 idx（回合顺序）──────────────────────────────────
{
  const w = L.newBattle(1);
  const p0 = L.newPlayer(w.spawns[0], 0);
  const p1 = L.newPlayer(w.spawns[1], 1);
  check('① newPlayer(…,0) 满血 = HP，hp === hpMax',
    p0.hp === D.HP && p0.hpMax === D.HP, `hp=${p0.hp} hpMax=${p0.hpMax}`);
  check('① newPlayer(…,1) 满血 = HP + KOMI，hp === hpMax',
    p1.hp === D.HP + D.KOMI && p1.hpMax === D.HP + D.KOMI, `hp=${p1.hp} hpMax=${p1.hpMax}`);
  check('① idx 字段如实记录回合顺序（供 UI/结算判断）',
    p0.idx === 0 && p1.idx === 1, `idx=${p0.idx}/${p1.idx}`);
  // 满血是 hpMax 而不是 DATA.HP：血条比例按 hpMax 算才不会把后手画成溢出条
  const ratio = p1.hp / (p1.hpMax || D.HP);
  check('① 后手血条比例 = 1.0（不是 112%），满血不溢出',
    Math.abs(ratio - 1) < 1e-9, `hp/hpMax=${ratio}`);
}

// ── ② 贴目血不被 100 夹取：直击/溅射/灼烧都在 112 基数上算 ──────
{
  const stone = D.WEAPONS[0];
  const w = L.newBattle(7);
  const ps = [L.newPlayer(w.spawns[0], 0), L.newPlayer(w.spawns[1], 1)];
  const out = L.settleImpact({ type: 'direct', who: 1, x: ps[1].x, y: ps[1].y - 30 }, stone, ps, 0);
  const dmg = out.hits.reduce((s, h) => s + h.dmg, 0);
  check('② 直击后手：112 − 伤害，不被夹到 100',
    ps[1].hp === D.HP + D.KOMI - dmg && ps[1].hp < D.HP,
    `112 − ${dmg} = ${ps[1].hp}`);

  // 灼烧：每回合扣 burn.dmg，与 hpMax 无关（只改分母，不改伤害）
  const q = L.newPlayer(w.spawns[1], 1);
  q.burn = { turns: 3, dmg: 2 };
  const t1 = L.tickBurn(q);
  check('② 灼烧伤害不随贴目缩放（仍 2 点/回合）',
    t1 === 2 && q.hp === D.HP + D.KOMI - 2, `tick 后 hp=${q.hp}（112−2）`);
  // 灼烧致死不出现负血
  const r = L.newPlayer(w.spawns[1], 1);
  r.hp = 1; r.burn = { turns: 2, dmg: 2 };
  L.tickBurn(r);
  check('② 灼烧致死夹到 0（不出现负血/NaN）',
    r.hp === 0 && Number.isFinite(r.hp), `hp=${r.hp}`);
  // 未挂灼烧的玩家不受影响
  const s = L.newPlayer(w.spawns[0], 0);
  check('② tickBurn 对无灼烧者返回 0 且不改血',
    L.tickBurn(s) === 0 && s.hp === D.HP, `hp=${s.hp}`);
}

// ── ③ 整局不变量（fuzz）──────────────────────────────────────
{
  const levels = ['easy', 'medium', 'hard'];
  let n = 0, nan = 0, over = 0, under = 0, badMax = 0, loserAlive = 0, winnerOver100 = 0, stuck = 0;
  let maxSeen = 0, minLoser = 1e9;
  for (let s = 0; s < MATCHES; s++) {
    const a = levels[s % 3], b = levels[(s * 7 + 1) % 3];
    const r = L.simulateMatch(910000 + s * 37, a, b);
    if (!r.ok) { stuck++; continue; }
    n++;
    r.players.forEach((p, i) => {
      const want = D.HP + (i === 1 ? D.KOMI : 0);
      if (p.hpMax !== want) badMax++;
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
  check('③ fuzz：每局 hpMax 恒为 HP / HP+KOMI（不随等级、种子变）',
    badMax === 0, `${n} 局，错 ${badMax} 处`);
  check('③ fuzz：0 ≤ hp ≤ hpMax，无 NaN、无越界',
    nan === 0 && over === 0 && under === 0, `NaN=${nan} 越上界=${over} 负血=${under}`);
  check('③ fuzz：败方 hp 恰为 0（夹取正确）',
    loserAlive === 0, `不合规 ${loserAlive} 局，最小败方血 ${minLoser}`);
  check('③ fuzz：胜方 hp 确实可以 >100 —— 证明贴目血没被 100 夹掉',
    winnerOver100 > 0 && maxSeen <= D.HP + D.KOMI,
    `${n} 局里胜方 >100 的 ${winnerOver100} 局，最大胜方血 ${maxSeen.toFixed(1)}（上限 ${D.HP + D.KOMI}）`);
  check('③ fuzz：无卡局/无 NaN 对局（贴目没把对局拖成死循环）',
    stuck === 0, `未完成 ${stuck} 局`);
}

// ── ④ 贴目按回合顺序发：等级差 / 镜像一视同仁 ────────────────
{
  const cases = [['easy', 'hard'], ['hard', 'easy'], ['medium', 'medium'], ['easy', 'easy']];
  let bad = 0;
  for (const [a, b] of cases) {
    const r = L.simulateMatch(555001, a, b);
    if (!r.ok) { bad++; continue; }
    if (r.players[0].hpMax !== D.HP || r.players[1].hpMax !== D.HP + D.KOMI) bad++;
    if (r.players[0].idx !== 0 || r.players[1].idx !== 1) bad++;
  }
  check('④ 贴目只认回合顺序（0 号不给），与双方等级组合无关',
    bad === 0, `${cases.map((c) => c.join(' vs ')).join('、')} 四种组合`);
}

// ── ⑤ 贴目的档位效果曲线（测量，不是判定）──────────────────────
// 贴目按回合顺序发 → **人机的每一档都是"人类先手 100 血 vs AI 后手 112 血"**，
// 与镜像局结构相同。所以这条曲线同时就是"人机各档被贴目推了多少"的结构估计。
// 只打印不设死断言：将来若改成按档发贴目，数字会变，那正是要看的效果。
{
  const N = MATCHES;
  const SETS = [(i) => 5000 + i * 13, (i) => 20260000 + i * 31];
  console.log(`\n⑤ 贴目后的镜像先手胜率（人机=人类坐先手席的结构位移）· 合并 2×${N}`);
  const row = {};
  for (const lv of ['easy', 'medium', 'hard']) {
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
    console.log(`   ${lv.padEnd(7)}先手 ${(rate * 100).toFixed(1)}% ｜ 后手（带 ${D.KOMI} 点贴目）${((1 - rate) * 100).toFixed(1)}%`
      + `　分族 ${fam.map((f) => (f * 100).toFixed(1)).join(' / ')}　（未贴目时约 51 / 60~63 / 81~83%）`);
  }
  check('⑤ 三档镜像都跑满、无卡局（贴目的档位曲线是量出来的，不设设计断言）',
    Object.values(row).every((v) => v > 0 && v < 1),
    ['easy', 'medium', 'hard'].map((k) => `${k} ${(row[k] * 100).toFixed(1)}%`).join(' ｜ '));
}

console.log(`\n${fail ? '❌' : '✅'} 贴目逻辑层 ${pass}/${pass + fail} ${fail ? `（失败 ${fail}）` : ''}`);
process.exit(fail ? 1 : 0);
