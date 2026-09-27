// 打包：把 index.html 引用的 CSS 与全部 JS（含第三方库）内联成一个独立 HTML，发一个文件即可玩
// 用法：node build.mjs  → dist/石器大战.html 与内容相同的 dist/stone-fight.html
//（英文名副本：部分安卓文件管理器/聊天软件转存中文文件名会乱码）
// 只读 index.html 与源码，不修改任何源文件；产物可随时重新生成
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// 戳从**墙上时钟**改成**源码指纹**（2026-09-27，采审计第 5 轮的建议）。
// 原来写的是打包那一刻的时间，于是同一份源码每重建一次就得到不同的文件、不同的 md5，
// "冻结版本"就成了句空话——测试方量到的 md5 和交付声明的 md5 永远差那么一行。
// 指纹只由内联进去的内容算出来（此刻 html 已是全量内联、还没插戳），
// 所以源码不动产物就一个字节不动，md5 才是"这一版"的身份证而不是"这一次构建"的。
const stamp = createHash('sha256').update(html).digest('hex').slice(0, 12);
html = html.replace('<title>',
  `<!-- 石器大战 单文件版 · 源码指纹 ${stamp} · 由 build.mjs 从源码生成，请勿手改 -->\n`
  + `<!--\n${licenses}\n-->\n<title>`);

// 交付物改动铁律：dist 是生成物，但它是"可能被人打开过、编辑过"的成品，
// 而 smoke.sh 第 6 步会在每次跑闸门时就地重建它——工作区有改动时，这一步会顺手
// 冲掉任何手工改动（审计第 5 轮指出）。生成前按铁律那条"比对成品与生成脚本的 mtime"查：
//   放行：① 产物不存在 ② 产物和刚重建的结果只差打包时间戳（等于没改，写了也是白写）
//         ③ 产物比某个源文件旧（源码变了，这就是一次正常重建）
//   拦下：产物比**所有**源文件都新，内容却和重建结果对不上——源码没动、产物变了，
//         只可能是有人手工改过。这时拒绝覆盖，让人先备份。
// 两种戳都认：老产物写的是"打包于 <时间>"，新产物写的是"源码指纹 <hex>"。
// 只认新格式的话，格式切换后的第一次重建会把上一版误判成"手工改过"而拒绝覆盖——
// 那一次误报正是这条守卫最不该出现的地方（它本来是防覆盖的，结果挡住了正常重建）。
const stampRe = /(打包于 [\d-]+ [\d:]+|源码指纹 [0-9a-f]{12})/;
const strip = (t) => t.replace(stampRe, '源码指纹 —');
const srcMtime = Math.max(...used.map((u) => statSync(join(ROOT, u)).mtimeMs));
const handEdited = OUTS.filter((out) => {
  let prev, mt;
  try { prev = readFileSync(out, 'utf8'); mt = statSync(out).mtimeMs; } catch { return false; }
  if (strip(prev) === strip(html)) return false;   // 内容一致，只是时间戳不同
  return mt > srcMtime;                            // 比所有源文件都新，却对不上 → 手工改过
});
if (handEdited.length && !process.env.FORCE_BUNDLE) {
  console.error('❌ 拒绝覆盖 dist：产物比所有源文件都新，内容却和源码重建的结果对不上——');
  console.error('   源码没动而产物变了，只可能是有人手工改过它：');
  for (const s of handEdited) console.error(`   ${s}`);
  console.error('   先备份（cp 到 _备份-日期-HHMM/）再跑；确认要覆盖就加 FORCE_BUNDLE=1。');
  process.exit(2);
}

mkdirSync(dirname(OUTS[0]), { recursive: true });
for (const out of OUTS) writeFileSync(out, html);
console.log(`✅ 已生成 ${OUTS.join('\n         ')}`);
console.log(`   内联 ${used.length} 个文件：${used.join('、')}`);
console.log(`   已嵌入第三方许可声明（Phaser、ZzFX、ravaged-planet）`);
console.log(`   大小 ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
