// 独立测试员用例：变异测试——专治"注释性断言"（等不到也照样过的空断言）。
// 做法：把产品代码复制到 /tmp，注掉一处真实功能，再跑开发方的 tests/browser-smoke.mjs；
// 若那条本该抓它的断言仍然 ✅，说明它是空断言（或根本没覆盖这条路径）。
// 只在副本上动手，绝不碰仓库里的产品代码。
// 用法：node tests/indep-mutation.mjs <m1..m6|all> [组]
//   m1~m3 打开发方冒烟；m4~m6 打贴目相关的用例（K 组 / 贴目逻辑层）
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MUT = {
  // M1 相机不聚焦：focusOnTurn 里那次 pan 摘成空操作。
  //   沿革（别把这两条读混了）：
  //   ・2026-09-27 第一轮实测**存活**（总红条数 0）：当时开发方冒烟的 S-5 判的是"射手的 x 落在
  //     cam.worldView 里"，镜头停在别处（上一步留下的位置）也可能蒙对，抓不住这个变异。
  //   ・开发侧已在 commit 12b7a7f 加固 S-5：改判**视野中心**（|射手 x − 视野中心| ≤ 视野半宽/4）。
  //   ・2026-09-27 第二轮（测试侧收尾）复验：同一变异**已被抓住**，总红条数 1。
  //     实测 射手 x=486 / 视野中心 801 / 半宽 354.5 / 容差 88.6 → 中心距 315 > 88.6 → 红。
  m1: { file: 'js/game.js', from: "cam.pan(s.players[s.turn].x, s.players[s.turn].y - 40, 420, 'Sine.easeInOut', false);",
        to: "/* M1 摘掉聚焦 pan */;", expect: 'S-5 首回合镜头把射手带进手机屏幕' },
  // M2 指示器永不收起：两条隐藏分支（不在自己回合 / 对手在视野内）全部注掉
  m2: { file: 'js/ui.js', from: 'if (foeShown) { el.hidden = true; foeShown = false; }',
        to: 'if (false) { el.hidden = true; foeShown = false; }  /* M2 永不收起 */', all: true,
        expect: 'S10 对手在视野内时指示自动收起' },
  // M3 指示器永不出现
  m3: { file: 'js/ui.js', from: 'if (!foeShown) { el.hidden = false; foeShown = true; }',
        to: 'if (false) { el.hidden = false; foeShown = true; }  /* M3 永不出现 */', all: true,
        expect: 'S10 对手越屏时贴边指示方向' },
  // M4 血条分母退回全局 DATA.HP（后手带贴目时血条会画错；满血被 Math.min 夹住看不出来）
  m4: { file: 'js/ui.js', from: 'const pct = Math.max(0, Math.min(1, p.hp / (p.hpMax || DATA.HP)));',
        to: 'const pct = Math.max(0, Math.min(1, p.hp / DATA.HP));  /* M4 分母退回全局满血 */',
        suite: 'node tests/indep-browser.mjs --only-k', expect: 'K2 血条按 hpMax 画' },
  // M5 取消贴目（后手也发 100 血）
  //   夹具在 2026-09-27 第二轮随源码改过：贴目分档后 newPlayer 的第三参是 k（不是 DATA.KOMI），
  //   旧的 from 字符串匹配不上，变异会**静默不生效**（脚本只打印一行"变异无效"就继续）。
  m5: { file: 'js/logic.js', from: 'const hpMax = DATA.HP + (i === 1 ? k : 0);',
        to: 'const hpMax = DATA.HP;  /* M5 取消贴目 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '① komi=12（medium）newPlayer(…,1) 满血' },
  // M6 贴目发错人（发给先手）。只在 komi≠0 的档上抓得到：easy 贴 0，两边同值分不出对错
  m6: { file: 'js/logic.js', from: 'const hpMax = DATA.HP + (i === 1 ? k : 0);',
        to: 'const hpMax = DATA.HP + (i === 0 ? k : 0);  /* M6 贴目发错人 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '① komi=12（medium）newPlayer(…,0) 满血' },
  // M7 贴目取值归零（功能在、数值没了）：不是看"有没有发贴目"，而是看跨档镜像还守不守得住。
  //   分档后要改的是表里的值，不是标量——旧的 from `KOMI: 12,` 已经匹配不上。
  m7: { file: 'js/data.js', from: 'KOMI: { easy: 0, medium: 12, hard: 6 },',
        to: 'KOMI: { easy: 0, medium: 0, hard: 0 },  /* M7 贴目归零 */',
        suite: 'node tests/indep-a4.mjs 1200', expect: '档不达标' },
  // M8 取值规则反转（取较低档而不是较高档）。专打新增的 ⓪ 白盒块——那条断言不是空的
  m8: { file: 'js/logic.js', from: 'RANK[lv] > RANK[best]', to: 'RANK[lv] < RANK[best]  /* M8 取较低档 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '⓪ 取双方里较高的一档' },
  // M9 认不出的档不再落锚定值（K[best] 而不是 K[best || 'medium']）→ 发 undefined → hp 变 NaN
  m9: { file: 'js/logic.js', from: "return K[best || 'medium'];", to: 'return K[best];  /* M9 不落锚定值 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '⓪ 认不出的档落 medium 锚定值' },
  // M1b 与 m1 同一个变异，改打**测试侧**的 C 组。
  //   S-5（开发方冒烟）是单场景：只判当前这一屏的视野中心。C 组每个种子都重新 nav()、
  //   判"整只射手精灵完整落在视口内"，是同一缺陷的第二道独立闸门。
  //   沿革：m1 存活的那一轮，这里是唯一抓得住它的断言；12b7a7f 加固 S-5 之后两条都抓得住，
  //   保留 m1b 是因为它不依赖开发方那条断言的写法——S-5 再被改宽，C 组仍会红。
  m1b: { file: 'js/game.js', from: "cam.pan(s.players[s.turn].x, s.players[s.turn].y - 40, 420, 'Sine.easeInOut', false);",
        to: '/* M1b 摘掉聚焦 pan */;',
        suite: 'node tests/indep-browser.mjs --only-c', expect: '第一回合相机把"当前射手"取进画面' },
  // M10 把原型链那道修复**退回原样**（owns(RANK, lv) → lv in RANK）。
  //   这条的存在意义就是钉住 2026-09-27 修掉的那个 bug：夹具退回实现、断言必须变红，
  //   否则说明那两条 ⓪ 断言只是"跟着实现走"，没有真的守住这条约定。
  m10: { file: 'js/logic.js', from: 'if (owns(RANK, lv) && (best === null || RANK[lv] > RANK[best])) best = lv;',
        to: 'if (lv in RANK && (best === null || RANK[lv] > RANK[best])) best = lv;  /* M10 退回原型链穿透 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '⓪ 原型链上的键名' },
  // M11 受击体退回旧圆（HIT 胶囊 → BOT=TOP=30, R=33，穿模 bug 的原形态）。
  //   开发方称 S2c "已证伪过"（说改回去会爆到 76px），断言有牙与否由**这条**说了算，
  //   不采信声称：夹具退回实现、S2c 必须变红。
  m11: { file: 'js/data.js', from: 'HIT: { BOT: 20, TOP: 117, R: 22 },',
        to: 'HIT: { BOT: 30, TOP: 30, R: 33 },  /* M11 退回旧圆 */',
        expect: 'S2c 受击体盖住画出来的身体' },
};
const which = process.argv[2] || 'all';
const ids = which === 'all' ? Object.keys(MUT) : [which];

for (const id of ids) {
  const m = MUT[id];
  const dir = `/tmp/stone-mut-${id}-${process.pid}`;
  rmSync(dir, { recursive: true, force: true });
  execSync(`rsync -a --exclude node_modules --exclude .git "${ROOT}/" "${dir}/"`);
  const p = join(dir, m.file);
  const src = readFileSync(p, 'utf8');
  const n = src.split(m.from).length - 1;
  if (!n) { console.log(`❌ ${id}: 目标代码没找到，变异无效（${m.file}）`); continue; }
  writeFileSync(p, m.all ? src.split(m.from).join(m.to) : src.replace(m.from, m.to));
  const suite = m.suite || 'node tests/browser-smoke.mjs';
  console.log(`\n══ ${id}：注掉 ${m.file} 的 ${n} 处（跑「${suite}」，期望「${m.expect}」变红）══`);
  let out = '', timedOut = false;
  try { out = execSync(suite, { cwd: dir, encoding: 'utf8', timeout: 600000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); timedOut = e.killed === true || /ETIMEDOUT|timed out/i.test(String(e.message)); }
  const line = out.split('\n').find((l) => l.includes(m.expect));
  const reds = out.split('\n').filter((l) => l.trim().startsWith('❌'));
  if (!line) {
    // 没跑出这条断言行：要么套件崩了/超时了，要么被我的复制或执行搞坏了——不能当成"变异存活"
    console.log(`   ⚠ 冒烟输出里根本没有「${m.expect}」这一行（${timedOut ? '执行超时' : '套件没跑到'}），本次变异结论无效`);
    console.log(`   输出末尾 3 行：${out.trim().split('\n').slice(-3).join(' | ').slice(0, 200) || '(空输出)'}`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }
  const caught = line.trim().startsWith('❌');
  console.log(`   ${line.trim().slice(0, 150)}`);
  console.log(`   总红条数 ${reds.length}${reds.length ? '：' + reds.map((r) => r.replace(/^❌\s*/, '').slice(0, 24)).join(' / ') : ''}`);
  console.log(caught ? `   ✅ 变异被抓住（断言不是空断言）` : `   ❌ 变异存活 —— 这条断言是空的：功能坏了它照样过`);
  rmSync(dir, { recursive: true, force: true });
}
