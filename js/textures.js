// 程序化美术：全部用 Canvas2D 画，零图片文件
// 同一套绘制函数供两处复用——DOM 武器图标（<canvas>）与 Phaser 贴图（textures.createCanvas）
// 风格按 docs/美术方案.md：扁平矢量、无描边、色块分形、暖色调、圆润几何
const TEX = (() => {
  const C = DATA.COLORS;
  const hx = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

  // 一档明暗：同色系压暗，扁平风靠这个分形，不靠描边
  const dark = (n, k = 0.78) => {
    const r = ((n >> 16) & 255) * k, g = ((n >> 8) & 255) * k, b = (n & 255) * k;
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  };
  const light = (n, k = 1.22) => {
    const r = Math.min(255, ((n >> 16) & 255) * k), g = Math.min(255, ((n >> 8) & 255) * k), b = Math.min(255, (n & 255) * k);
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  };

  function newCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function blob(ctx, pts) {           // 不规则多边形（石头用）
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  // 绕圈取点，radius 抖动做成卵石
  function rockPts(cx, cy, r, n, jitter, seed) {
    const pts = [];
    let s = seed || 1;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff); };
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 - jitter + rnd() * jitter * 2);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    return pts;
  }

  // ---------------- 武器 ----------------
  // 基准：中心在 (0,0)，长度 100（−50…+50 沿 X 轴），刃/尖朝 +X。旋转交给调用方
  const WEAPON_ART = {
    stone(ctx) {
      ctx.fillStyle = hx(C.rock);
      ctx.beginPath(); ctx.arc(0, 0, 30, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = dark(C.rock);
      ctx.beginPath(); ctx.arc(6, 7, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hx(C.rock);
      ctx.beginPath(); ctx.arc(-4, -5, 22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = dark(C.rock, 0.9);
      ctx.beginPath(); ctx.arc(-12, -12, 4.5, 0, Math.PI * 2); ctx.fill();
    },
    spear(ctx) {
      ctx.fillStyle = '#8B5A3C';                       // 木杆
      roundRect(ctx, -50, -3.5, 80, 7, 3.5); ctx.fill();
      ctx.fillStyle = hx(C.rock);
      ctx.beginPath(); ctx.moveTo(28, -10); ctx.lineTo(52, 0); ctx.lineTo(28, 10); ctx.closePath(); ctx.fill();
      ctx.fillStyle = dark(C.rock, 0.72);
      ctx.beginPath(); ctx.moveTo(28, 0); ctx.lineTo(52, 0); ctx.lineTo(28, 10); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hx(C.ink);
      for (const x of [24, 17, 10]) { roundRect(ctx, x, -4.6, 3.2, 9.2, 1.2); ctx.fill(); }
    },
    arrow(ctx) {
      ctx.fillStyle = '#A8794F';
      roundRect(ctx, -50, -2.2, 84, 4.4, 2.2); ctx.fill();
      ctx.fillStyle = hx(C.bone);
      ctx.beginPath(); ctx.moveTo(33, -6); ctx.lineTo(48, 0); ctx.lineTo(33, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#E0863C';                       // 尾羽
      ctx.beginPath(); ctx.moveTo(-50, 0); ctx.lineTo(-34, -11); ctx.lineTo(-26, 0); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-50, 0); ctx.lineTo(-34, 11); ctx.lineTo(-26, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hx(C.ink);
      roundRect(ctx, 28, -3, 3, 6, 1); ctx.fill();
    },
    axe(ctx) {
      ctx.fillStyle = '#8B5A3C';
      roundRect(ctx, -50, -4, 84, 8, 4); ctx.fill();
      ctx.fillStyle = hx(C.rock);
      ctx.beginPath();
      ctx.moveTo(4, -34); ctx.lineTo(44, -26); ctx.lineTo(48, 26); ctx.lineTo(4, 34);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = dark(C.rock, 0.74);
      ctx.beginPath(); ctx.moveTo(38, -27); ctx.lineTo(48, -26); ctx.lineTo(48, 26); ctx.lineTo(38, 27); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hx(C.ink);
      for (const x of [-2, 4, 10]) { roundRect(ctx, x, -5, 3.4, 10, 1.2); ctx.fill(); }
    },
    sling(ctx) {
      ctx.strokeStyle = hx(C.ink); ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-50, -17); ctx.lineTo(10, -2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-50, 17); ctx.lineTo(10, 2); ctx.stroke();
      ctx.fillStyle = '#6B4530';
      ctx.beginPath(); ctx.moveTo(6, -17); ctx.lineTo(40, -20); ctx.lineTo(40, 20); ctx.lineTo(6, 17); ctx.closePath(); ctx.fill();
      ctx.fillStyle = dark(0x6B4530, 0.8);
      ctx.beginPath(); ctx.moveTo(6, 4); ctx.lineTo(40, 4); ctx.lineTo(40, 20); ctx.lineTo(6, 17); ctx.closePath(); ctx.fill();
      ctx.fillStyle = hx(C.rock);
      ctx.beginPath(); ctx.arc(23, 0, 10, 0, Math.PI * 2); ctx.fill();
    },
    boomerang(ctx) {
      ctx.strokeStyle = '#8B5A3C'; ctx.lineWidth = 14; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-36, 20); ctx.quadraticCurveTo(-2, 2, 36, -22); ctx.stroke();
      ctx.strokeStyle = dark(0x8B5A3C, 0.82); ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(-36, 20); ctx.quadraticCurveTo(-14, 9, -2, 2); ctx.stroke();
      ctx.strokeStyle = hx(C.ink); ctx.lineWidth = 2.4;
      for (const t of [0.34, 0.5, 0.66]) {
        const x = -36 + t * 72, y = 20 + (t * t * -42);
        ctx.beginPath(); ctx.moveTo(x - 4, y - 5); ctx.lineTo(x + 4, y + 5); ctx.stroke();
      }
    },
    torch(ctx) {
      ctx.fillStyle = '#8B5A3C';
      roundRect(ctx, -50, -4, 74, 8, 4); ctx.fill();
      ctx.fillStyle = hx(C.ink);
      roundRect(ctx, 12, -13, 28, 26, 9); ctx.fill();
      ctx.fillStyle = dark(C.ink, 0.8);
      roundRect(ctx, 26, -13, 6, 26, 3); ctx.fill();
      roundRect(ctx, 15, -11, 4, 22, 2); ctx.fill();
      ctx.fillStyle = '#E0863C';
      ctx.beginPath(); ctx.moveTo(26, -46); ctx.quadraticCurveTo(48, -24, 26, -12); ctx.quadraticCurveTo(4, -24, 26, -46); ctx.fill();
      ctx.fillStyle = '#FFD9A0';
      ctx.beginPath(); ctx.moveTo(26, -36); ctx.quadraticCurveTo(37, -24, 26, -15); ctx.quadraticCurveTo(15, -24, 26, -36); ctx.fill();
    },
    boulder(ctx) {
      ctx.fillStyle = hx(C.rock);
      blob(ctx, rockPts(0, 0, 46, 9, 0.16, 7)); ctx.fill();
      ctx.fillStyle = dark(C.rock, 0.76);
      blob(ctx, rockPts(8, 12, 34, 8, 0.14, 23)); ctx.fill();
      ctx.fillStyle = hx(C.rock);
      blob(ctx, rockPts(-6, -8, 33, 8, 0.14, 41)); ctx.fill();
      ctx.strokeStyle = dark(C.rock, 0.66); ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(-16, -18); ctx.lineTo(-2, -4); ctx.lineTo(-8, 10); ctx.stroke();
    },
  };

  // 在 (cx,cy) 处画一件武器，len 为长度，ang 为旋转（弧度）
  function drawWeapon(ctx, wp, cx, cy, len, ang) {
    const art = WEAPON_ART[wp.id];
    if (!art) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang || 0);
    ctx.scale(len / 100, len / 100);
    art(ctx);
    ctx.restore();
  }

  // DOM 武器槽用的图标（返回 <canvas>）
  function weaponIcon(wp, size) {
    const c = newCanvas(size, size);
    const ctx = c.getContext('2d');
    drawWeapon(ctx, wp, size / 2, size / 2, size * 0.82, wp.spin || wp.rot ? -0.5 : 0);
    return c;
  }

  // ---------------- 地形 ----------------
  // 把整个战场画进一张世界尺寸的位图：天空之下、草地泥土分层、池塘、灌木、装饰
  function paintTerrain(ctx, w) {
    const T = DATA.TERRAIN, N = w.h.length;

    // 泥土底：沿地表轮廓填到画面底部
    const grad = ctx.createLinearGradient(0, T.GROUND_Y - 200, 0, T.H);
    grad.addColorStop(0, hx(C.dTop));
    grad.addColorStop(1, hx(C.dBot));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, w.h[0]);
    for (let i = 1; i < N; i++) ctx.lineTo(i * T.SAMPLE, w.h[i]);
    ctx.lineTo(T.W, T.H); ctx.lineTo(0, T.H);
    ctx.closePath(); ctx.fill();

    // 草皮：沿地表描粗线，再用更亮的细线压一层顶边（扁平分层的做法）
    const stroke = (width, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, w.h[0]);
      for (let i = 1; i < N; i++) ctx.lineTo(i * T.SAMPLE, w.h[i]);
      ctx.stroke();
    };
    stroke(30, hx(C.gBot));
    stroke(15, hx(C.gTop));

    // 池塘：水面之下的水，水面上一条浅色反光
    for (const p of w.ponds) {
      const g2 = ctx.createLinearGradient(0, p.y, 0, p.bottom + 30);
      g2.addColorStop(0, hx(C.water));
      g2.addColorStop(1, hx(C.waterDark));
      ctx.fillStyle = g2;
      // 水体 = 水面线以下、池底以上那块。上沿用 y=p.y 的水平线封口，下沿贴池底曲线。
      // 早先把封口画在 GROUND_Y+60，等于把多边形从池底一路拉到地面下 60px——
      // 水整片画进了池底的泥土里，而真正的池子（水面线到池底那十几像素）是干的：
      // 看上去池底发绿像长草，挖开土里才有水。采样一验就露馅（池心竖列 0/6 是水色）。
      // 两端靠 max(pondFloor, p.y) 收口：岸边地表高于水面处自然收成零厚度，不会淹上岸。
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y);
      for (let x = p.x0; x <= p.x1; x += 8) {
        ctx.lineTo(x, Math.max(pondFloor(w, x), p.y));
      }
      ctx.lineTo(p.x1, p.y);
      ctx.closePath(); ctx.fill();
      // 反光条只画水面真有水的那一段。岸边的池底高过水面线，水在那里厚度是零，
      // 照 x0+6..x1-6 整条画过去，白线就横在草地上，看着像画错了一道
      let xl = null, xr = null;
      for (let x = p.x0; x <= p.x1; x += 2) {
        if (pondFloor(w, x) > p.y + 1) { if (xl === null) xl = x; xr = x; }
      }
      if (xl !== null && xr - xl > 16) {
        ctx.strokeStyle = 'rgba(250,240,228,.55)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(xl + 4, p.y); ctx.lineTo(xr - 4, p.y); ctx.stroke();
      }
    }

    // 灌木：三团圆叠出蓬松剪影
    for (const b of w.bushes) drawBushShape(ctx, b.x + b.w / 2, b.y + b.h, b.w, b.h);

    // 装饰
    for (const d of w.decos) drawDeco(ctx, d);
  }

  function pondFloor(w, x) {
    const T = DATA.TERRAIN;
    const t = x / T.SAMPLE;
    const i = Math.max(0, Math.min(w.h.length - 2, Math.floor(t)));
    const f = t - i;
    return w.h[i] * (1 - f) + w.h[i + 1] * f;
  }

  function drawBushShape(ctx, cx, baseY, bw, bh) {
    const r = bw * 0.34;
    const blobs = [[-bw * 0.26, -bh * 0.34, r * 0.94], [bw * 0.26, -bh * 0.34, r * 0.94], [0, -bh * 0.62, r * 1.06]];
    ctx.fillStyle = hx(C.bushBot);
    for (const [dx, dy, rr] of blobs) { ctx.beginPath(); ctx.arc(cx + dx, baseY + dy + 4, rr, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = hx(C.bushTop);
    for (const [dx, dy, rr] of blobs) { ctx.beginPath(); ctx.arc(cx + dx, baseY + dy - 3, rr * 0.86, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = light(C.bushTop, 1.14);
    ctx.beginPath(); ctx.arc(cx - bw * 0.1, baseY - bh * 0.74, r * 0.42, 0, Math.PI * 2); ctx.fill();
  }

  function drawDeco(ctx, d) {
    const s = d.s, flip = d.flip ? -1 : 1;
    ctx.save(); ctx.translate(d.x, d.y); ctx.scale(flip * s, s);
    if (d.kind === 'grass') {
      ctx.strokeStyle = hx(C.deco); ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      for (const [a, l] of [[-0.5, 13], [0, 17], [0.45, 12]]) {
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(Math.sin(a) * l * 0.4, -l * 0.6, Math.sin(a) * l, -l);
        ctx.stroke();
      }
    } else if (d.kind === 'flower') {
      ctx.strokeStyle = hx(C.deco); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -13); ctx.stroke();
      ctx.fillStyle = hx(C.clay);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(Math.cos(a) * 3.6, -13 + Math.sin(a) * 3.6, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = hx(C.bone);
      ctx.beginPath(); ctx.arc(0, -13, 2.6, 0, Math.PI * 2); ctx.fill();
    } else if (d.kind === 'pebble') {
      ctx.fillStyle = hx(C.rockDark);
      blob(ctx, rockPts(0, -3, 5.5, 7, 0.2, 11)); ctx.fill();
    } else {
      ctx.strokeStyle = hx(C.bone); ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-9, -3); ctx.lineTo(9, -3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-6, -3); ctx.lineTo(-6, -9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(6, -3); ctx.lineTo(6, -9); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------- 原始人 ----------------
  // 姿势：idle 待机 / wind 蓄力 / throw 投掷 / hit 受击 / dead 倒地
  // 用分节肢体画（不是整张图），这样蓄力—出手能真的动起来
  const HERO = { W: 132, H: 168, cx: 66, foot: 156 };
  const POSES = {
    idle:  { lean: 0.00, back: [-2.28, -0.30], front: [0.42, 0.30], thigh: 0.10, head: 0.00 },
    wind:  { lean: -0.16, back: [-3.05, -0.25], front: [0.30, 0.42], thigh: 0.16, head: -0.10 },
    throw: { lean: 0.20, back: [-1.05, -0.05], front: [0.72, 0.20], thigh: -0.06, head: 0.12 },
    hit:   { lean: -0.26, back: [-2.05, -0.55], front: [0.05, 0.62], thigh: 0.22, head: -0.24 },
    dead:  { lean: 0.62, back: [-1.75, 0.20], front: [0.30, 0.50], thigh: 0.46, head: 0.50 },
  };
  // 两套配色：主角 A（暖色调）与主角 B（深肤色+爆炸头），同一套造型语言
  const SKINS = {
    a: { skin: 0xE8A97A, skinD: 0xC98A5E, hair: '#5E3A26', cloth: 0x8B5A3C, clothD: 0x6B4530, accent: 0xE0863C, strap: 0x4A342A },
    b: { skin: 0xC98A5E, skinD: 0xA06B45, hair: '#2B1D16', cloth: 0xC0603B, clothD: 0x9A4A2C, accent: 0xFFD9A0, strap: 0x4A342A },
  };

  function limb(ctx, x, y, a1, l1, a2, l2, wdt, color) {
    ctx.strokeStyle = color; ctx.lineWidth = wdt; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const ex = x + Math.cos(a1) * l1, ey = y + Math.sin(a1) * l1;
    const hx2 = ex + Math.cos(a1 + a2) * l2, hy2 = ey + Math.sin(a1 + a2) * l2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.lineTo(hx2, hy2); ctx.stroke();
    return [hx2, hy2];
  }

  // facing: 1 面向右（默认），-1 面向左；t 为呼吸相位
  function drawHero(ctx, skinKey, pose, facing, t) {
    const S = SKINS[skinKey] || SKINS.a;
    const P = POSES[pose] || POSES.idle;
    const cx = HERO.cx, foot = HERO.foot;
    const breathe = Math.sin(t * 2.2) * 1.4;

    ctx.save();
    ctx.translate(cx, foot);
    ctx.scale(facing, 1);
    ctx.rotate(P.lean * 0.5);

    const hipY = -46 + breathe * 0.3, shY = -92 + breathe;

    // 腿
    const legA = 1.5708 + P.thigh;
    limb(ctx, -9, hipY, legA - 0.12, 26, 0.16, 24, 15, S.skinD);
    limb(ctx, 9, hipY, legA + 0.12, 26, 0.16, 24, 15, S.skinD);
    ctx.fillStyle = hx(S.skinD);
    ctx.beginPath(); ctx.ellipse(-16, -1, 11, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(16, -1, 11, 6, 0, 0, Math.PI * 2); ctx.fill();

    // 躯干
    ctx.fillStyle = hx(S.skin);
    ctx.beginPath();
    ctx.moveTo(-16, hipY + 4); ctx.lineTo(-19, shY + 4);
    ctx.quadraticCurveTo(0, shY - 8, 19, shY + 4);
    ctx.lineTo(16, hipY + 4); ctx.closePath(); ctx.fill();

    // 兽皮短袍 + 锯齿下摆（参考图统一的概括方式）
    ctx.fillStyle = hx(S.cloth);
    ctx.beginPath();
    ctx.moveTo(-20, shY + 8); ctx.lineTo(20, shY + 8);
    ctx.lineTo(23, hipY + 16); ctx.lineTo(16, hipY + 8);
    ctx.lineTo(8, hipY + 18); ctx.lineTo(0, hipY + 8);
    ctx.lineTo(-8, hipY + 18); ctx.lineTo(-16, hipY + 8);
    ctx.lineTo(-23, hipY + 16); ctx.closePath(); ctx.fill();
    ctx.fillStyle = hx(S.clothD);
    ctx.beginPath(); ctx.moveTo(-3, shY + 8); ctx.lineTo(20, shY + 8); ctx.lineTo(23, hipY + 16); ctx.lineTo(8, hipY + 18); ctx.closePath(); ctx.fill();

    // 斜披单肩带（回避参考图"毛领"那套）
    ctx.strokeStyle = hx(S.strap); ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-14, shY + 6); ctx.lineTo(13, hipY + 14); ctx.stroke();

    // 骨饰项链
    ctx.fillStyle = hx(C.bone);
    for (let i = 0; i < 5; i++) {
      const a = -0.9 + i * 0.45;
      ctx.beginPath(); ctx.arc(Math.sin(a) * 15, shY + 12 + Math.cos(a) * 5, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    // 手臂：后手（远端）先画，压在手感层次之下
    const backHand = limb(ctx, -12, shY + 6, P.back[0], 22, P.back[1], 22, 12, S.skinD);
    const frontHand = limb(ctx, 12, shY + 6, P.front[0], 22, P.front[1], 22, 12, S.skin);

    // 头
    const headX = 2 + P.head * 6, headY = shY - 16 + P.head * 4;
    ctx.save();
    ctx.translate(headX, headY); ctx.rotate(P.head);
    ctx.fillStyle = hx(S.skin);
    ctx.beginPath(); ctx.ellipse(0, 0, 16, 17, 0, 0, Math.PI * 2); ctx.fill();
    // 头发：一大团 + 两撮翘起
    ctx.fillStyle = S.hair;
    ctx.beginPath(); ctx.ellipse(-1, -7, 17.5, 13, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(-13, -9, 7, 8, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-6, -17); ctx.lineTo(1, -27); ctx.lineTo(6, -16); ctx.closePath(); ctx.fill();
    // 眉 + 眼（白眼球黑瞳，刻意区别于参考图的整块脸漆）
    ctx.fillStyle = S.hair;
    roundRect(ctx, 1, -6.5, 11, 3.4, 1.4); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.ellipse(7, 0.5, 4.4, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2B1D16';
    ctx.beginPath(); ctx.arc(8.6, 0.5, 2.2, 0, Math.PI * 2); ctx.fill();
    // 颧骨两道横纹
    ctx.strokeStyle = hx(C.clay); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(3, 7); ctx.lineTo(12, 6.4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3, 10); ctx.lineTo(11, 9.4); ctx.stroke();
    ctx.restore();

    ctx.restore();
    return { back: backHand, front: frontHand };
  }

  // 生成一张姿势贴图，返回 { key, w, h, ox, oy }
  function heroTexture(scene, skinKey, pose, facing) {
    const key = `hero-${skinKey}-${pose}-${facing > 0 ? 'r' : 'l'}`;
    if (scene.textures.exists(key)) return key;
    const { W, H } = HERO;
    const tex = scene.textures.createCanvas(key, W, H);
    const ctx = tex.getContext();
    drawHero(ctx, skinKey, pose, facing, 0);
    tex.refresh();
    return key;
  }

  const HERO_BOX = { W: HERO.W, H: HERO.H, cx: HERO.cx, foot: HERO.foot };

  // ---------------- Phaser 贴图工厂 ----------------
  // 地形每局重画：先删旧贴图再建，否则 createCanvas 会因同名直接返回旧图
  function buildTerrain(scene, w) {
    const key = 'terrain';
    if (scene.textures.exists(key)) scene.textures.remove(key);
    const T = DATA.TERRAIN, E = T.BLEED, B = T.BLEED_BOTTOM;
    // 先按世界尺寸画一张（paintTerrain 全程用世界坐标），再拼装到外扩后的大图上。
    // 外扩不是为了好看，是为了把"世界到此为止"这条边界推出屏幕：
    // 桌面宽屏下视野比世界宽，不做这一步就会看见地形是个浮在背景上的矩形。
    const base = newCanvas(T.W, T.H);
    paintTerrain(base.getContext('2d'), w);   // 普通 canvas 要显式给 '2d'，Phaser 的 CanvasTexture 才可省
    const tex = scene.textures.createCanvas(key, T.W + E * 2, T.H + B);
    const ctx = tex.getContext();
    ctx.drawImage(base, E, 0);
    // 左右各把最边上的 1px 竖列横向拉成一条：边缘那几十像素本来就接近平的，
    // 拉出来与原地形接得上，草地/泥土/岩石的分层也跟着延过去，看不出接缝。
    ctx.drawImage(base, 0, 0, 1, T.H, 0, 0, E, T.H);
    ctx.drawImage(base, T.W - 1, 0, 1, T.H, T.W + E, 0, E, T.H);
    // 底边同理横拉一条到底：相机能往下多看到 400px，不补就在画面最下沿露背景
    ctx.drawImage(base, 0, T.H - 1, T.W, 1, 0, T.H, T.W + E * 2, B);
    tex.refresh();
    return key;
  }

  // 粒子用的白点（白色才能被 setParticleTint 任意染色）
  function dotTexture(scene) {
    const key = 'dot';
    if (scene.textures.exists(key)) return key;
    const tex = scene.textures.createCanvas(key, 14, 14);
    const ctx = tex.getContext();
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    ctx.beginPath(); ctx.arc(7, 7, 6.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(7, 7, 4.6, 0, Math.PI * 2); ctx.fill();
    tex.refresh();
    return key;
  }

  // 飞行中的武器：每件一张不旋转的贴图，旋转交给 sprite.rotation
  function weaponTexture(scene, wp) {
    const key = 'wp-' + wp.id;
    if (scene.textures.exists(key)) return key;
    const S = 132;
    const tex = scene.textures.createCanvas(key, S, S);
    drawWeapon(tex.getContext(), wp, S / 2, S / 2, S * 0.78, 0);
    tex.refresh();
    return key;
  }

  return {
    newCanvas, drawWeapon, weaponIcon, paintTerrain, drawBushShape, drawDeco,
    drawHero, heroTexture, HERO_BOX, SKINS, POSES, hx, dark, light, roundRect, rockPts, blob,
    buildTerrain, dotTexture, weaponTexture,
  };
})();
