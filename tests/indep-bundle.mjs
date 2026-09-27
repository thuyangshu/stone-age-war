// 独立用例 · 单文件打包版与源码版「逐字节」一致性（N6）
// 冒烟里的 B 组只比对同种子下的行为，行为一致但代码不同照样能过；
// 这里直接把 dist/*.html 里内联的每一段拆出来，跟仓库里的源文件对字节。
// 用法：node tests/indep-bundle.mjs [root]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(ROOT, 'dist');
let pass = 0, fail = 0;
const bad = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; bad.push(name); console.log(`❌ ${name}${detail ? '  ' + detail : ''}`); }
}

const bundles = existsSync(distDir)
  ? readdirSync(distDir).filter((f) => f.endsWith('.html'))
  : [];
check('dist/ 下存在单文件打包版', bundles.length > 0, bundles.join(', '));

for (const file of bundles) {
  const html = readFileSync(join(distDir, file), 'utf8');
  console.log(`\n── ${file} ──`);

  // 2026-09-27：build.mjs 把时间戳换成了内容指纹（源码 sha256 前 12 位），
  // 打包因此可复现（连打两次 md5 相同）；这里两种格式都认，别只认旧的那种。
  const stamp = (html.match(/源码指纹 ([0-9a-f]{12})/) || html.match(/打包于 ([\d-]+ [\d:]+)/) || [])[1];
  const builtAt = statSync(join(distDir, file)).mtimeMs;
  const stale = [];
  console.log(`   源码指纹/打包戳：${stamp || '（无）'}（文件时间 ${new Date(builtAt).toLocaleString('zh-CN')}）`);

  // 1) 逐段比对：每个内联 <script>/<style> 块开头都有 /* 源路径 */ 标记
  const blocks = [
    ...[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]),
    ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]),
  ];
  let compared = 0;
  for (const blk of blocks) {
    const head = blk.slice(0, 200).match(/^\s*\/\*\s*([\w./-]+\.(?:js|css))\s*\*\//);
    if (!head) continue;
    const rel = head[1];
    const src = join(ROOT, rel);
    if (!existsSync(src)) { check(`  ${rel} 源文件存在`, false, '打包版内联了仓库里没有的文件'); continue; }
    // 去掉标记、去掉首尾空行，再比正文
    const body = blk.slice(blk.indexOf(head[0]) + head[0].length).replace(/^\s*\n/, '').replace(/\s+$/, '');
    const orig = readFileSync(src, 'utf8').replace(/\s+$/, '');
    compared++;
    if (body === orig) { console.log(`   ✅ ${rel} 与源文件逐字节一致（${orig.length} 字符）`); pass++; }
    else {
      // 定位第一处差异，给出可核对的证据
      let i = 0; while (i < Math.min(body.length, orig.length) && body[i] === orig[i]) i++;
      const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
      fail++; bad.push(`${file} 内联的 ${rel}`);
      console.log(`   ❌ ${rel} 与源文件不一致：第 ${i} 个字符起分叉`);
      console.log(`      打包版：${ctx(body)}`);
      console.log(`      源码版：${ctx(orig)}`);
      console.log(`      长度 打包 ${body.length} / 源码 ${orig.length}`);
    }
    // 3) 源码比打包版本身还新 → 打包版是旧的（用文件时间比，避开时区换算）
    const mtimeMs = statSync(src).mtimeMs;
    if (mtimeMs > builtAt + 2000) {
      stale.push(`${rel}（源码 ${new Date(mtimeMs).toLocaleString('zh-CN')} 晚于打包版 ${new Date(builtAt).toLocaleString('zh-CN')}）`);
    }
  }
  check(`  ${file} 全部内联段都能对到源文件`, compared >= 10, `比对了 ${compared} 段`);
  check(`  ${file} 的源码改动都已打进包里（不是旧包）`, stale.length === 0,
    stale.length ? stale.join('；') : '打包版不比任何源文件旧');

  // 2) 外部依赖：不能有任何外链
  const ext = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
    .map((m) => m[1]).filter((u) => !u.startsWith('data:') && u !== '#');
  check(`  ${file} 零外部引用（双击即可离线打开，N1）`, ext.length === 0, ext.join(', ') || '无外链');
  const mod = /<script[^>]*type\s*=\s*["']module["']/.test(html);
  check(`  ${file} 不含 ES module（file:// 下会被 CORS 拦掉，N1）`, !mod, mod ? '含 type="module"' : '纯经典脚本');
  check(`  ${file} 带第三方许可声明`, /Phaser|MIT|许可/.test(html), '');
  check(`  ${file} 体积在合理范围（<6MB）`, html.length < 6e6, `${(html.length / 1048576).toFixed(2)} MB`);
}

console.log(`\n打包版一致性用例：${pass}/${pass + fail} 通过`);
if (fail) { console.log('未通过：'); for (const b of bad) console.log('  · ' + b); }
process.exit(fail ? 1 : 0);
