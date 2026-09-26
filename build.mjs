// 打包：把 index.html 引用的 CSS 与全部 JS（含第三方库）内联成一个独立 HTML，发一个文件即可玩
// 用法：node build.mjs  → dist/石器大战.html 与内容相同的 dist/stone-fight.html
//（英文名副本：部分安卓文件管理器/聊天软件转存中文文件名会乱码）
// 只读 index.html 与源码，不修改任何源文件；产物可随时重新生成
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTS = [join(ROOT, 'dist', '石器大战.html'), join(ROOT, 'dist', 'stone-fight.html')];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };

let html = read('index.html');
const used = [];

// 内联脚本里出现 </script 或 <!-- 会提前截断/改变解析，转义成等价写法
const escJs = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const escCss = (s) => s.replace(/<\/(style)/gi, '<\\/$1');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => {
  used.push(href);
  const css = read(href);
  // 闸门：CSS 里的外部资源（url() 引用非 data: 资源、@import）内联后会断链
  const ext = css.match(/url\(\s*['"]?(?!data:)[^)'"]+['"]?\s*\)|@import[^;]+;/gi);
  if (ext) fail(`${href} 里有外部资源引用，单文件里会找不到：\n  ${ext.join('\n  ')}`);
  return `<style>\n${escCss(css)}\n</style>`;
});
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  used.push(src);
  return `<script>/* ${src} */\n${escJs(read(src))}\n</script>`;
});

// 闸门：不允许残留任何外部引用，否则朋友那边会缺文件
const leftover = html.match(/<(script|link|img|iframe|audio|video|source)[^>]+(src|href)="(?!data:|#)[^"]*"/gi);
if (leftover) fail('仍有未内联的外部引用：\n  ' + leftover.join('\n  '));

// 闸门：脚本顺序错了浏览器会静默跑不起来（world 必须在 logic 前，logic 加载时要同步取 WORLD）
const order = used.filter((u) => u.startsWith('js/'));
const need = ['js/data.js', 'js/world.js', 'js/logic.js'];
for (let i = 0; i < need.length; i++) {
  if (order[i] !== need[i]) fail(`脚本顺序不对：第 ${i + 1} 个应是 ${need[i]}，实际是 ${order[i] || '(无)'}`);
}

// 第三方库的 MIT 许可要求随"所有副本"附带版权声明与许可全文：把 vendor/LICENSES.md 整份放进开头的注释。
// HTML 注释里不能出现 "--"，替换成等价的全角破折号，不影响阅读
const licenses = read('vendor/LICENSES.md').replace(/--/g, '—');
for (const name of ['Phaser', 'ZzFX', 'ravaged-planet']) {
  if (!licenses.includes(`## ${name}`)) fail(`vendor/LICENSES.md 缺少 ${name} 的许可声明`);
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
html = html.replace('<title>',
  `<!-- 石器大战 单文件版 · 打包于 ${stamp} · 由 build.mjs 从源码生成，请勿手改 -->\n`
  + `<!--\n${licenses}\n-->\n<title>`);

mkdirSync(dirname(OUTS[0]), { recursive: true });
for (const out of OUTS) writeFileSync(out, html);
console.log(`✅ 已生成 ${OUTS.join('\n         ')}`);
console.log(`   内联 ${used.length} 个文件：${used.join('、')}`);
console.log(`   已嵌入第三方许可声明（Phaser、ZzFX、ravaged-planet）`);
console.log(`   大小 ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
