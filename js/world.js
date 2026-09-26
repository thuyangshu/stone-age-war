// 地形：纯逻辑，不碰 DOM / canvas / Phaser / Math.random（随机全走传入种子）
// 高度场（height field）方案：201 个采样点 @8px + 池塘段 + 灌木放置物。
// 地形不可破坏（题材决定），所以碰撞全部解析求解，不需要像素位图。
// 双环境：浏览器里 DATA 是全局 const，Node 里 require 进来（同一份源码，不加构建步骤）
const WORLD = ((DATA) => {
  const T = DATA.TERRAIN;
  const N = Math.round(T.W / T.SAMPLE) + 1;

  // mulberry32：小巧的确定性伪随机，同一 seed 必然复现同一战场
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rand = (r, lo, hi) => lo + r() * (hi - lo);
  const randInt = (r, lo, hi) => Math.floor(lo + r() * (hi - lo + 1));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---------- 采样 ----------
  function surfaceAt(w, x) {
    if (x < 0 || x > T.W) return T.H;      // x=0 与 x=W 是合法的采样端点，不能算越界
    const t = x / T.SAMPLE;
    const i = clamp(Math.floor(t), 0, N - 2);
    const f = t - i;
    return w.h[i] * (1 - f) + w.h[i + 1] * f;
  }

  // 该 x 处是否有水（池塘段内且地表被挖到水面以下）
  function pondAt(w, x) {
    for (const p of w.ponds) if (x >= p.x0 && x <= p.x1) return p;
    return null;
  }

  // 该点是否落在灌木里（灌木是弹丸拦截面，不是地形）
  function bushAt(w, x, y) {
    for (const b of w.bushes) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  // ---------- 生成 ----------
  function genTerrain(seed) {
    const r = mulberry32(seed >>> 0);
    const h = new Float64Array(N);
    for (let i = 0; i < N; i++) h[i] = T.GROUND_Y;

    // 1) 山丘：3–5 个高斯钟形叠加（y 向下，所以是减去高度）
    const hills = [];
    const hc = randInt(r, T.HILL.count[0], T.HILL.count[1]);
    for (let k = 0; k < hc; k++) {
      const cx = rand(r, 120, T.W - 120);
      const amp = rand(r, T.HILL.amp[0], T.HILL.amp[1]);
      const width = rand(r, T.HILL.width[0], T.HILL.width[1]);
      hills.push({ cx, amp, width });
      for (let i = 0; i < N; i++) {
        const x = i * T.SAMPLE;
        const d = (x - cx) / width;
        h[i] -= amp * Math.exp(-d * d * 2);
      }
    }
    // 限制最高点，免得两侧射手被抬到天上
    const base = T.GROUND_Y;
    for (let i = 0; i < N; i++) h[i] = Math.max(h[i], base - T.HILL.maxH);

    const w = { seed: seed >>> 0, h, hills, ponds: [], bushes: [], decos: [], spawns: [] };

    // 2) 池塘：60% 概率挖一段碗形。
    //    水面高度必须由地形现算，不能写死——早先写死成常数，碰上池塘恰好吃在山丘上时，
    //    挖完的池底比"水面"还高，池塘根本蓄不上水（视觉上是一片旱地，却按水域判定）
    if (r() < T.POND.chance) {
      const pw = rand(r, T.POND.w[0], T.POND.w[1]);
      // 找一段相对平坦的地方挖：斜坡上挖出来的"碗"是斜的，水面怎么定都会淹掉一侧岸
      let x0 = null;
      for (let k = 0; k < 24; k++) {
        const cx = rand(r, T.POND.xRange[0], T.POND.xRange[1] - pw);
        const lo = Math.min(surfaceAt(w, cx), surfaceAt(w, cx + pw));
        const hi = Math.max(surfaceAt(w, cx), surfaceAt(w, cx + pw));
        if (hi - lo <= T.POND.flatMax) { x0 = cx; break; }
      }
      if (x0 !== null) {
        const x1 = x0 + pw;
        for (let i = 0; i < N; i++) {
          const x = i * T.SAMPLE;
          if (x < x0 || x > x1) continue;
          // 两端为 0、中间最深的碗形
          const u = ((x - x0) / pw) * 2 - 1;
          h[i] += T.POND.depth * Math.cos((u * Math.PI) / 2);
        }
        // y 向下为正，所以"较低的岸"是 max。用 min 会取到高岸，水面高过另一侧，整片岸被淹
        const rim = Math.max(surfaceAt(w, x0), surfaceAt(w, x1));
        const bottom = surfaceAt(w, (x0 + x1) / 2);
        // 水面必须严格落在岸与池底之间：高于岸会溢，低于底则池子是干的
        const y = Math.min(rim + (bottom - rim) * 0.7, bottom - 4);
        if (bottom > y + 2) w.ponds.push({ x0, x1, y, rim, bottom, depth: T.POND.depth });
      }
    }

    // 3) 两侧边缘抬升，弹丸不会贴边溜出世界
    for (let i = 0; i < N; i++) {
      const x = i * T.SAMPLE;
      const e = Math.min(x, T.W - x);
      if (e < T.EDGE * 3) h[i] -= T.EDGE * (1 - e / (T.EDGE * 3));
    }

    // 4) 站位：必须先于灌木确定。早先顺序反了，灌木会长在射手头上把他整个罩住，
    //    实测 78% 的射击被"自己脚下的掩体"挡下，AI 命中率跌到 15%
    for (let k = 0; k < 6 && !w.spawns.length; k++) w.spawns = pickSpawns(w, r) || [];
    if (!w.spawns.length) {
      // 兜底：极端地形（连续 6 次校验都不过）也要保证双方有位置站，宁可牺牲弧线校验
      const ax = T.W * 0.18, bx = T.W * 0.82;
      w.spawns = [{ x: ax, y: surfaceAt(w, ax) }, { x: bx, y: surfaceAt(w, bx) }];
      w.spawnFallback = true;
    }

    // 5) 灌木：落在山丘之间，避开池塘与双方站位（射手脚边不留掩体）
    const bc = randInt(r, T.BUSH.count[0], T.BUSH.count[1]);
    for (let k = 0; k < bc; k++) {
      for (let tries = 0; tries < 20; tries++) {
        const x = rand(r, T.BUSH.margin, T.W - T.BUSH.margin - T.BUSH.w);
        const cx = x + T.BUSH.w / 2;
        if (pondAt(w, cx)) continue;
        const b = { x, y: surfaceAt(w, cx) - T.BUSH.h, w: T.BUSH.w, h: T.BUSH.h, sway: rand(r, 0, Math.PI * 2) };
        // 与已有灌木保持距离
        if (w.bushes.some((o) => Math.abs(o.x + o.w / 2 - cx) < 110)) continue;
        // 与站位保持距离：灌木中心到任一射手的水平距离 < 站位净空则放弃
        if (w.spawns.some((s) => Math.abs(s.x - cx) < T.BUSH.spawnClear)) continue;
        w.bushes.push(b);
        break;
      }
    }

    // 6) 装饰：只记位置与种类，渲染时按同种子绘制
    const dc = randInt(r, T.DECO.count[0], T.DECO.count[1]);
    for (let k = 0; k < dc; k++) {
      const x = rand(r, 20, T.W - 20);
      if (pondAt(w, x)) continue;
      if (w.spawns.some((s) => Math.abs(s.x - x) < 40)) continue;
      const kinds = ['grass', 'grass', 'flower', 'pebble', 'bone'];
      w.decos.push({
        x, y: surfaceAt(w, x),
        kind: kinds[randInt(r, 0, kinds.length - 1)],
        s: rand(r, 0.7, 1.4), flip: r() < 0.5,
      });
    }

    return w;
  }

  // ---------- 站位选取 ----------
  // 干燥（不在池塘里）、坡度平缓、两侧间距 500–1200，且满力高抛至少有一条能打到对方的弧线
  function pickSpawns(w, rng) {
    const S = T.SPAWN;
    const dry = (x) => {
      const p = pondAt(w, x);
      if (!p) return true;
      return surfaceAt(w, x) < p.y - 4;   // 地表必须高于水面才算干地
    };
    const flat = (x) => {
      const a = surfaceAt(w, x - 24), b = surfaceAt(w, x + 24);
      return Math.abs(a - b) < 46;
    };
    for (let t = 0; t < T.RETRY * 4; t++) {
      const ax = rand(rng, S.left[0], S.left[1]);
      const bx = rand(rng, S.right[0], S.right[1]);
      const gap = bx - ax;
      if (gap < S.gap[0] || gap > S.gap[1]) continue;
      if (!dry(ax) || !dry(bx) || !flat(ax) || !flat(bx)) continue;
      // 池塘边缘 60px 内不站人（免得站在半坡上）
      if (w.ponds.some((p) => [ax, bx].some((x) => x > p.x0 - S.dryMargin && x < p.x1 + S.dryMargin && surfaceAt(w, x) >= p.y - 4))) continue;
      const a = { x: ax, y: surfaceAt(w, ax) };
      const b = { x: bx, y: surfaceAt(w, bx) };
      return [a, b];
    }
    return null;
  }

  // ---------- 射线/线段求交 ----------
  // 从 (x0,y0) 到 (x1,y1) 扫过，返回第一个命中事件；无命中返回 null
  // step: 采样步长（px），默认 2px —— 远小于任何弹丸半径，不会跳过薄地形
  function segHit(w, x0, y0, x1, y1, opts = {}) {
    const step = opts.step || 2;
    const pierceBush = !!opts.pierceBush;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const x = x0 + dx * f, y = y0 + dy * f;
      // 注意：世界顶部之上（y<0）不算出界——高抛弧线顶点常常飞到画面上方之外，
      // 早先在这里判 out，导致所有大仰角射击刚出手就被判"打飞"，AI 命中率接近 0
      if (x < 0 || x > T.W) return { type: 'out', x, y, f, nx: x, ny: y, t: 0 };
      // 灌木拦截（矛/箭穿透）
      if (!pierceBush) {
        const b = bushAt(w, x, y);
        if (b) return { type: 'bush', x, y, f, bush: b, nx: x, ny: b.y };
      }
      // 水面：先于地表判定（池塘里的地表在水下）
      const p = pondAt(w, x);
      if (p && y >= p.y) return { type: 'water', x, y, f, nx: x, ny: p.y, pond: p };
      // 地表
      const sy = surfaceAt(w, x);
      if (y >= sy) {
        return { type: 'ground', x, y, f, nx: x, ny: sy, slope: slopeAt(w, x) };
      }
      if (y > T.H) return { type: 'out', x, y, f, nx: x, ny: y };
    }
    return null;
  }

  // 地表法线倾角（弧度，0=水平），用于弹跳方向
  function slopeAt(w, x) {
    const a = surfaceAt(w, x - 6), b = surfaceAt(w, x + 6);
    return Math.atan2(b - a, 12);
  }

  // 曾经有个 blocked(w,a,b) 做"两点之间是否被山丘挡住"的连线采样，给"对手被挡住"
  // 剪影提示和 AI 强制高抛用。这两件事后来都没做（剪影见 docs/需求与验收.md 已知取舍，
  // 高抛则被 aiAim 的逐个试射天然覆盖），函数就只剩注释在说谎——已删除。
  // 真要恢复，判定就是沿连线按 8px 采样、任一点低于 surfaceAt 即算遮挡。

  return { N, mulberry32, genTerrain, pickSpawns, surfaceAt, pondAt, bushAt, segHit, slopeAt, clamp };
})(typeof DATA !== 'undefined' ? DATA : require('./data.js'));

if (typeof module !== 'undefined') module.exports = WORLD;
