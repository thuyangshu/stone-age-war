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
  // M1 相机不聚焦：focusOnTurn 里那次 pan 摘成空操作
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
  m5: { file: 'js/logic.js', from: 'const hpMax = DATA.HP + (i === 1 ? DATA.KOMI : 0);',
        to: 'const hpMax = DATA.HP;  /* M5 取消贴目 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '① newPlayer(…,1) 满血 = HP + KOMI' },
  // M6 贴目发错人（发给先手）
  m6: { file: 'js/logic.js', from: 'const hpMax = DATA.HP + (i === 1 ? DATA.KOMI : 0);',
        to: 'const hpMax = DATA.HP + (i === 0 ? DATA.KOMI : 0);  /* M6 贴目发错人 */',
        suite: 'node tests/indep-komi.mjs 40', expect: '① newPlayer(…,0) 满血 = HP' },
  // M7 贴目取值归零（功能在、数值没了）：不是看"有没有发贴目"，而是看跨档镜像还守不守得住
  m7: { file: 'js/data.js', from: 'KOMI: 12,', to: 'KOMI: 0,  /* M7 贴目归零 */',
        suite: 'node tests/indep-a4.mjs 1200', expect: '❌ 1 档不达标' },
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
