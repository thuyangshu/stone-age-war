// 本地生图：调用 Draw Things 的 A1111 兼容 API（http://127.0.0.1:7860）
// 用法：
//   node tools/gen-image.mjs --check                          # 检查连通性与可用模型
//   node tools/gen-image.mjs "提示词" 输出.png [选项]
// 选项：
//   --w 1024 --h 1024     尺寸（默认 1024x1024）
//   --steps 8             步数（FLUX schnell 用 4-8，dev 用 20-30）
//   --cfg 1               CFG（FLUX 用 1）
//   --seed 123            随机种子（默认随机）
//   --model flux_1_schnell_q8p.ckpt   模型文件名（默认自动选 schnell）
//   --neg "负面词"        负面提示词
//   --timeout 300         超时秒数（默认 300）
// 说明：Draw Things 必须处于运行状态，且设置里开了 API Server（HTTP, 7860）
import { writeFileSync } from 'node:fs';

const HOST = process.env.DRAWTHINGS_HOST || '127.0.0.1';
const PORT = process.env.DRAWTHINGS_PORT || '7860';
const BASE = `http://${HOST}:${PORT}`;

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

async function api(path, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// --check：探活 + 列出可用模型
if (has('check')) {
  try {
    const opts = await api('/sdapi/v1/options', null, 5000);
    console.log('✅ Draw Things API 在线:', BASE);
    const models = opts?.models || opts?.sd_models || [];
    if (models.length) {
      console.log('可用模型:');
      const norm = (m) => (typeof m === 'string' ? { title: m, model: m } : m);
      for (const m of models.slice(0, 20).map(norm)) console.log(`  - ${m.model || m.title}`);
    } else {
      console.log('（options 里没有模型列表，可直接指定 --model 文件名）');
    }
    if (opts?.model) console.log('当前加载模型:', opts.model);
  } catch (e) {
    console.error('❌ 无法连接 Draw Things API:', e.message);
    console.error('   请在 Draw Things 里开启：设置 → API Server → HTTP → 端口 7860 → Server Online 打开');
    process.exit(1);
  }
  process.exit(0);
}

const prompt = argv[0];
const out = argv[1];
if (!prompt || !out || prompt.startsWith('--')) {
  console.error('用法: node tools/gen-image.mjs "提示词" 输出.png [--w 1024 --h 1024 --steps 8 --cfg 1 --seed N --model 文件名]');
  process.exit(1);
}

const payload = {
  prompt,
  negative_prompt: opt('neg', ''),
  width: parseInt(opt('w', '1024'), 10),
  height: parseInt(opt('h', '1024'), 10),
  steps: parseInt(opt('steps', '8'), 10),
  cfg_scale: parseFloat(opt('cfg', '1')),
  sampler_name: opt('sampler', 'Euler A Trailing'),
  batch_size: 1,
  seed: parseInt(opt('seed', String(Math.floor(Math.random() * 1e9))), 10),
};
const model = opt('model', 'flux_1_schnell_q8p.ckpt');
if (model) payload.model = model;

console.log(`生成中… ${payload.width}x${payload.height} ${payload.steps}步 model=${model}`);
const t0 = Date.now();
let res;
try {
  res = await api('/sdapi/v1/txt2img', payload, parseInt(opt('timeout', '300'), 10) * 1000);
} catch (e) {
  console.error('❌ 生成失败:', e.message);
  process.exit(1);
}
const b64 = res?.images?.[0];
if (!b64) {
  console.error('❌ 返回里没有图片:', JSON.stringify(res).slice(0, 300));
  process.exit(1);
}
writeFileSync(out, Buffer.from(b64, 'base64'));
const kb = (Buffer.from(b64, 'base64').length / 1024).toFixed(0);
console.log(`✅ 已保存 ${out}（${kb} KB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，seed=${payload.seed}）`);
