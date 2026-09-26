// 独立测试员用例：变异测试——专治"注释性断言"（等不到也照样过的空断言）。
// 做法：把产品代码复制到 /tmp，注掉一处真实功能，再跑开发方的 tests/browser-smoke.mjs；
// 若那条本该抓它的断言仍然 ✅，说明它是空断言（或根本没覆盖这条路径）。
// 只在副本上动手，绝不碰仓库里的产品代码。
// 用法：node tests/indep-mutation.mjs <m1|m2|m3|all>
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
  console.log(`\n══ ${id}：注掉 ${m.file} 的 ${n} 处（期望「${m.expect}」变红）══`);
  let out = '';
  try { out = execSync('node tests/browser-smoke.mjs', { cwd: dir, encoding: 'utf8', timeout: 240000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const line = out.split('\n').find((l) => l.includes(m.expect)) || '(没找到这条断言的行)';
  const reds = out.split('\n').filter((l) => l.trim().startsWith('❌'));
  const caught = line.trim().startsWith('❌');
  console.log(`   ${line.trim().slice(0, 150)}`);
  console.log(`   总红条数 ${reds.length}${reds.length ? '：' + reds.map((r) => r.replace(/^❌\s*/, '').slice(0, 24)).join(' / ') : ''}`);
  console.log(caught ? `   ✅ 变异被抓住（断言不是空断言）` : `   ❌ 变异存活 —— 这条断言是空的：功能坏了它照样过`);
  rmSync(dir, { recursive: true, force: true });
}
