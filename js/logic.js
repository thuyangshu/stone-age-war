// 纯逻辑：弹道解算、子步积分、碰撞事件、伤害结算、AI、回合规则
// 不碰 DOM / canvas / Phaser / Math.random（随机全走传入 rng），Node 可直接单测
// 双环境：浏览器里 DATA/WORLD 是全局 const，Node 里 require 进来
const LOGIC = ((DATA, WORLD) => {
  const P = DATA.PHYS;
  const T = DATA.TERRAIN;

  // ---------- 基础数学 ----------
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const DEG = Math.PI / 180;

  // 线段与圆的首次相交参数 t∈[0,1]，无交返回 -1
  function segCircle(x0, y0, x1, y1, cx, cy, r) {
    const dx = x1 - x0, dy = y1 - y0;
    const fx = x0 - cx, fy = y0 - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-9) return fx * fx + fy * fy <= r * r ? 0 : -1;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - r * r;
    if (c <= 0) return 0;                       // 起点已在圆内
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    const t1 = (-b - s) / (2 * a);
    return t1 >= 0 && t1 <= 1 ? t1 : -1;
  }

  // 线段与竖直胶囊的首次相交参数 t∈[0,1]，无交返回 -1。
  // 胶囊 = 从 (cx, y-BOT) 到 (cx, y-TOP) 的竖直线段，向外扩 R（玩家身体，见 data.js HIT）。
  // 形状用等距圆串逼近：每条圆各自给出精确的进入参数，取最小即"最先进入身体"的时刻，
  // 与地形比先后的语义一分不改。圆间距按半径选，让两圆之间的凹陷不超过 SCALLOP——
  // 0.5px 的扇贝落在 22px 半径的身体上，比任何弹丸半径小一个数量级。
  // 为什么不写解析胶囊：圆串直接复用了上面这条已经测过的 segCircle，没有新的几何代码
  // 可以写错；解析法（线段—线段最近距离）返回的是最近点而不是进入点，与 tTerrain
  // 比先后时语义会变。
  const CAPSULE_SCALLOP = 0.5;
  function segCapsule(x0, y0, x1, y1, cx, cy, r, bot, top) {
    const yb = cy - bot, yt = cy - top;                 // 下端 y 更大
    const span = yb - yt;
    if (span <= 0) return segCircle(x0, y0, x1, y1, cx, cy, r);
    const step = 2 * Math.sqrt(Math.max(0.01, 2 * r * CAPSULE_SCALLOP - CAPSULE_SCALLOP * CAPSULE_SCALLOP));
    const n = Math.max(2, Math.ceil(span / step) + 1);
    let best = -1;
    for (let i = 0; i < n; i++) {
      const yy = yt + (span * i) / (n - 1);
      const t = segCircle(x0, y0, x1, y1, cx, yy, r);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    return best;
  }

  // 身体上"算哪儿"用的中心（AI 瞄点、够不够得着、溅射衰减的基准）。
  // 与受击体同源，免得又出现两处各写一个数、改了一处漏一处
  const bodyMid = (p) => p.y - (DATA.HIT.BOT + DATA.HIT.TOP) / 2;

  // ---------- 弹道解析解 ----------
  // 已知初速 v、重力 g、水平差 dx、垂直差 dy（y 向下为正），反解出手仰角（弧度，世界坐标）
  // 返回 { low, high }（平射解 / 高抛解），够不着返回 null
  // dx 为负（瞄向左边）时内部做水平镜像求解，再把角度镜像回来 —— 否则后手方永远解不出来
  function solveShot(v, g, dx, dy) {
    if (v <= 0 || Math.abs(dx) < 1e-6) return null;
    const left = dx < 0;
    const adx = Math.abs(dx);
    const k = (g * adx * adx) / (2 * v * v);
    const disc = adx * adx - 4 * k * (k - dy);
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    const t1 = (adx - s) / (2 * k);   // 平射
    const t2 = (adx + s) / (2 * k);   // 高抛
    const lo = DATA.PHYS.ANGLE[0] * DEG, hi = DATA.PHYS.ANGLE[1] * DEG;
    // 仰角范围在镜像帧里判定（镜像不改变仰角大小）
    const pick = (t) => {
      const a = Math.atan(t);
      if (a < lo || a > hi) return null;
      return left ? Math.PI - a : a;
    };
    const low = pick(t1), high = pick(t2);
    if (low === null && high === null) return null;
    return { low, high };
  }

  // 出手角度的合法区间（世界坐标，按朝向给）
  function angleRange(fromX, toX) {
    const lo = DATA.PHYS.ANGLE[0] * DEG, hi = DATA.PHYS.ANGLE[1] * DEG;
    return toX < fromX ? [Math.PI - hi, Math.PI - lo] : [lo, hi];
  }

  // 单帧时间钳制：切后台再回来 delta 可能是几十秒，不钳住就是一帧跑完几百步积分，
  // 弹丸瞬移、相机暴跳。宁可让物理慢半拍，也不要它跳。
  function clampFrame(deltaMs) {
    return Math.min(deltaMs / 1000, P.MAX_FRAME);
  }

  // 把屏幕上的拉弓向量换算成合法的出手角度与力度。
  // 死区有两道，缺一不可：拖距不足 DRAG_START 是"没拖，是点了一下"，
  // 力度低于 MIN_POWER 是"手抖了一下"——两者都当取消，否则误触就白送一发。
  function pullToAim(pull, fromX, toX) {
    const bad = { valid: false, power: 0, angle: 0 };
    const len = Math.hypot(pull.x, pull.y);
    if (len < P.DRAG_START) return bad;                 // 没拖，是点了一下
    const power = clamp((len - P.DRAG_START) / (P.DRAG_FULL - P.DRAG_START), 0, 1);
    if (power < P.MIN_POWER) return bad;                // 拖了，但轻到不像要出手
    // 屏幕 y 向下、出手角以"向上为正"，故取 −pull.y；
    // 拉到背后（朝对手的反方向）时夹到最近一端，不做"往回扔"这种无效操作
    const [lo, hi] = angleRange(fromX, toX);
    const angle = clamp(Math.atan2(-pull.y, pull.x), lo, hi);
    return { valid: true, power, angle };
  }

  // 回合超时该按什么出手：玩家正在瞄就顺着他那一发打出去，
  // 没在瞄（切后台、放下手机走了）就按最小仰角平推一发。绝不让对局停在这儿等人。
  function timeoutAim(aim, me, foe) {
    if (aim && aim.valid) return aim;
    const [lo] = angleRange(me.x, foe.x);
    return { angle: lo, power: DATA.TURN.TIMEOUT_POWER };
  }

  // 给定出手仰角，反解所需力度（0–1）——这是玩家的真实打法：先定弧度，再调用力。
  // 只有 solveShot 时 AI 被迫满力，于是只剩"平射/高抛"两个极端解；
  // 中等距离上平射解常常算出负角度（低于 5° 下限），全部武器被逼成 78° 垂直吊射。
  // elev 为仰角（弧度，恒正）；dx 为带符号水平差。够不着或角度太平返回 null
  function solvePower(vMax, g, dx, dy, elev) {
    const adx = Math.abs(dx);
    if (adx < 1e-6) return null;
    const c = Math.cos(elev), t = Math.tan(elev);
    // 推导（y 向下为正，左右同式）：dy = −adx·tanθ + g·adx²/(2v²cos²θ)
    //   → g·adx²/(2v²cos²θ) = dy + adx·tanθ = need
    // 这里早期写成 `adx*t − dy`，dy 符号反了：AI 的每一发力度的算错，
    // 目标越低越离谱。solveShot 的判别式 (k−dy) 展开后同样是 +dy，可作对照。
    const need = adx * t + dy;
    if (need <= 1e-6) return null;      // 该角度太平（或朝下），够不到
    const v2 = (g * adx * adx) / (2 * c * c * need);
    if (!(v2 > 0)) return null;
    return Math.sqrt(v2) / vMax;
  }

  // ---------- 弹丸 ----------
  function makeProjectile(weapon, x, y, angle, power) {
    const speed = Math.min(weapon.v * power, P.MAX_SPEED);
    return {
      x, y,
      px: x, py: y,                       // 上一子步位置（扫掠判定用）
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,       // y 向下为正，仰角向上 → vy 为负
      weapon,
      g: P.G * (weapon.gMul || 1),
      r: weapon.r || P.PROJ_R,
      speed, angle,
      alive: true,
      age: 0,
      phase: 'fly',
      bounces: 0,
      spin: 0,
      owner: null,                        // 发射者索引，由调用方设置
      origin: { x, y },
      trail: [],
    };
  }

  // 单个物理子步。返回命中事件或 null（仍在飞）
  // ctx = { world, players, ground, wind }
  function stepProjectile(p, dt, ctx) {
    if (!p.alive) return null;
    const w = ctx.world;
    const wind = (ctx.wind || 0) * P.WIND_ACCEL;

    // 回旋镖折返：到时间后朝发射点加速回旋
    if (p.weapon.returnAt && p.phase === 'fly' && p.age >= p.weapon.returnAt) {
      p.phase = 'return';
    }
    const returning = p.phase === 'return';
    if (returning) {
      const dx = p.origin.x - p.x, dy = p.origin.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < (p.weapon.catchR || 30)) {
        p.alive = false;
        return { type: 'catch', x: p.x, y: p.y, caught: true };
      }
      // 折返靠"翼面升力"：不是朝原点加一个加速度，而是把速度方向逐步拧向发射者。
      // 早先写成"朝原点加速 + 照常受重力"，结果掉到发射点水平线以下就再也拉不回来
      // ——四种角度实测全砸地或飞出世界，接住逻辑一次都没触发过。
      // 升力要压住重力，折返段索性不受重力（回旋镖本来也是靠升力平飞的）
      const spd = Math.max(p.weapon.v * 0.6, Math.hypot(p.vx, p.vy) * 0.94);
      const cur = Math.atan2(p.vy, p.vx);
      let da = Math.atan2(dy, dx) - cur;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const maxTurn = 9 * dt;
      const na = cur + Math.max(-maxTurn, Math.min(maxTurn, da));
      p.vx = Math.cos(na) * spd;
      p.vy = Math.sin(na) * spd;
    }

    const ox = p.x, oy = p.y;
    if (!returning) p.vy += p.g * dt;      // 折返段不受重力
    p.vx += wind * dt;
    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;

    // 直击：扫掠线段与对手碰撞圆求交（只打对手，不打自己）
    let tHit = Infinity, hitWho = -1;
    if (ctx.players) {
      for (let i = 0; i < ctx.players.length; i++) {
        if (i === p.owner) continue;
        const q = ctx.players[i];
        if (q.hp <= 0) continue;
        const t = segCapsule(ox, oy, nx, ny, q.x, q.y, DATA.HIT.R + p.r, DATA.HIT.BOT, DATA.HIT.TOP);
        if (t >= 0 && t < tHit) { tHit = t; hitWho = i; }
      }
    }

    // 地形：扫掠段与高度场/水面/灌木求交
    const ev = WORLD.segHit(w, ox, oy, nx, ny, { pierceBush: !!p.weapon.pierceBush, step: 2 });
    const tTerrain = ev ? ev.f : Infinity;

    p.px = ox; p.py = oy;
    p.spin += dt * 12;
    p.age += dt;

    if (tHit <= tTerrain && hitWho >= 0) {
      p.x = ox + (nx - ox) * tHit;
      p.y = oy + (ny - oy) * tHit;
      p.alive = false;
      return { type: 'direct', x: p.x, y: p.y, who: hitWho };
    }

    if (ev && tTerrain <= 1) {
      p.x = ev.x; p.y = ev.y;
      if (ev.type === 'out') { p.alive = false; return { type: 'out', x: p.x, y: p.y }; }
      // 投石索：落地反弹一次（衰减）
      if (p.weapon.bounce && p.bounces < p.weapon.bounce && ev.type === 'ground') {
        p.bounces++;
        const sn = ev.slope || 0;
        const cos = Math.cos(2 * sn), sin = Math.sin(2 * sn);
        const rvx = p.vx * cos + p.vy * sin;
        const rvy = p.vx * sin - p.vy * cos;
        p.vx = rvx * 0.55;
        p.vy = rvy * 0.55;
        p.x = ev.nx; p.y = ev.ny - 2;
        p.px = p.x; p.py = p.y;
        return { type: 'bounce', x: p.x, y: p.y };
      }
      p.alive = false;
      return { type: ev.type === 'ground' ? 'ground' : ev.type, x: p.x, y: p.y, ev };
    }

    p.x = nx; p.y = ny;
    return null;
  }

  // 快进模拟（玩家轨迹预览 / AI 复核 / 站位弧线校验三处共用同一套物理）
  function simulate(w, proj, ctx, opts = {}) {
    const maxT = opts.maxT || 12;
    const dt = opts.dt || P.SUB_DT;      // 地图校验用粗步长换速度，正式对局一律 SUB_DT
    const pts = [{ x: proj.x, y: proj.y }];
    const events = [];
    let t = 0, impact = null;
    const c = { world: w, players: opts.players || null, wind: ctx && ctx.wind ? ctx.wind : 0 };
    // 预览时不该被发射者自己的身体挡住——不传 players 就没有直击判定
    const guard = Math.ceil(maxT / dt);
    const every = opts.sampleEvery || 4;
    for (let i = 0; i < guard; i++) {
      const e = stepProjectile(proj, dt, c);
      t += dt;
      if (i % every === 0) pts.push({ x: proj.x, y: proj.y });
      if (e) {
        events.push(e);
        // 反弹不是终点：投石索弹一下还要接着飞。早先在这里无条件 break，
        // 导致反弹在模拟里从未发生——轨迹预览和 AI 评估都在弹跳点被截断
        if (e.type === 'bounce') continue;
        impact = e;
        break;
      }
      if (!proj.alive) break;
      if (proj.y > T.H + 200) { impact = { type: 'out', x: proj.x, y: proj.y }; break; }
    }
    pts.push({ x: proj.x, y: proj.y });
    return { pts, impact, time: t, events };
  }

  // ---------- 地图校验 ----------
  // a 能否用该武器打到 b（摆一组仰角逐个试射，命中判定放宽到 60px）
  // 校验用粗步长（1/60）跑，快 4 倍；只判断"打不打得到"，不要求像素级精确
  function reachable(w, a, b, weapon) {
    const g = P.G * (weapon.gMul || 1);
    // 锚在身体**下端**而不是中心：这条量的是"有一发能落到对手脚边"，落点是地面点，
    // 从脚底量才对得上。锚到中心（+38px）会把"落到脚边"判成够不着，
    // 一批本来能打的图会被无谓重掷——实测 200 张图里 9 张因此误判
    const sx = a.x, sy = a.y - 34, tx = b.x, ty = b.y - DATA.HIT.BOT;
    const dx = tx - sx, dy = ty - sy;
    const left = dx < 0;
    const toWorld = (e) => (left ? Math.PI - e : e);
    for (let d = 10; d <= 85; d += 5) {
      const pw = solvePower(weapon.v, g, dx, dy, d * DEG);
      if (pw === null || pw > 1) continue;
      const proj = makeProjectile(weapon, sx, sy, toWorld(d * DEG), clamp(pw, P.MIN_POWER, 1));
      const r = simulate(w, proj, {}, { maxT: 10, dt: 1 / 60 });
      if (r.impact && Math.hypot(r.impact.x - tx, r.impact.y - ty) < 60) return true;
    }
    return false;
  }

  // 生成一个"打得起来"的战场：双方都能打到对方，且可用武器越多越好。
  // 没有这层校验时，地形可能生成"两个射手中间横着 5 座山丘"的死局地图——
  // 任何武器任何角度都够不着，对局直接卡死（实测出现过连续 6 发零伤害）。
  function newBattle(seed, opts = {}) {
    // 实测 200 个种子都能在 12 次内找到合格地图（平均 1.4 次），留到 16 次保底
    const tries = opts.tries || 16;
    const list = opts.weapons || DATA.WEAPONS;
    let best = null, bestScore = -1;
    for (let k = 0; k < tries; k++) {
      const w = WORLD.genTerrain((seed + k * 7919) >>> 0);
      const [a, b] = w.spawns;
      // 投石是无限弹药的兜底武器，它必须双向可达，否则这一局无法推进
      if (!reachable(w, a, b, list[0]) || !reachable(w, b, a, list[0])) continue;
      // 其余武器数一数有几件双向可用，多的优先（对局更有变化）
      let score = 0;
      for (let i = 1; i < list.length; i++) {
        if (reachable(w, a, b, list[i]) && reachable(w, b, a, list[i])) score++;
      }
      if (score > bestScore) { bestScore = score; best = w; }
      if (score >= list.length - 2) break;      // 已经足够好，不必再找
    }
    return best || WORLD.genTerrain(seed);
  }

  // ---------- 伤害 ----------
  // 溅射：内圈满伤，边缘 25% 下限，半径外为 0
  function splashAt(dist, splash) {
    if (!splash || dist > splash.r) return 0;
    const f = Math.max(DATA.SPLASH_FLOOR, 1 - DATA.SPLASH_FALLOFF * (dist / splash.r));
    return splash.dmg * f;
  }

  // 结算一次命中，返回 { hits: [{who, dmg, kind}], burn }
  // players 会被就地修改
  function settleImpact(impact, weapon, players, shooter) {
    const hits = [];
    let burn = null;
    if (!impact) return { hits, burn };

    if (impact.type === 'direct') {
      const i = impact.who;
      hits.push({ who: i, dmg: weapon.dmg, kind: 'direct' });
      if (weapon.burn) burn = { who: i, ...weapon.burn };
    } else if (impact.type === 'ground' || impact.type === 'bounce') {
      // 落地溅射：半径内所有活着的角色都吃（含自己——站太近会误伤，品类惯例）
      for (let i = 0; i < players.length; i++) {
        const q = players[i];
        if (q.hp <= 0) continue;
        // 溅射基准点取身体**下端**而不是中心：落地溅射是"炸在脚边"，从脚底量最贴物理。
        // 之前这里写死 -30，与受击体各说各话；现在跟 HIT 同源
        const d = Math.hypot(q.x - impact.x, (q.y - DATA.HIT.BOT) - impact.y);
        const dm = splashAt(d, weapon.splash);
        if (dm > 0) hits.push({ who: i, dmg: dm, kind: 'splash' });
        if (weapon.burn && d <= (weapon.splash ? weapon.splash.r : 40)) burn = { who: i, ...weapon.burn };
      }
    }
    // 落水：只有水花，没有伤害（impact.type === 'water' 时 hits 为空）

    for (const h of hits) players[h.who].hp = Math.max(0, players[h.who].hp - h.dmg);
    if (burn && players[burn.who].hp > 0) {
      // 重复点燃只刷新回合数，不叠加伤害
      players[burn.who].burn = { turns: burn.turns, dmg: burn.dmg };
    }
    return { hits, burn };
  }

  // 回合开始时结算燃烧
  function tickBurn(player) {
    if (!player.burn || player.hp <= 0) return 0;
    player.burn.turns--;
    const d = player.burn.dmg;
    player.hp = Math.max(0, player.hp - d);
    if (player.burn.turns <= 0) player.burn = null;
    return d;
  }

  // ---------- AI ----------
  // 按功能位给武器打分排序。aiPickWeapon 与 aiChoose 共用同一份打分，
  // 分成两处写迟早会漂移成"选出来的和打出去的不是同一件"
  function scoreWeapons(players, me) {
    const foe = players[1 - me];
    // 弹药见底时投石（无限）永远是最后的选择，不会出现"无武器可出"
    const list = DATA.WEAPONS.filter((wp) => players[me].ammo[wp.id] > 0);
    return list.map((wp) => {
      let s = wp.dmg * 0.6 + (wp.splash ? wp.splash.dmg : 0) * 0.4 + wp.v / 1200;
      if (wp.burn && !foe.burn) s += 4;           // 对手没着火时，火把优先级抬升
      if (!wp.splash) s -= 1;                     // 无溅射武器容错低
      return { wp, s };
    }).sort((a, b) => b.s - a.s);
  }

  // 选武器：按功能位打分，难度只决定"取最优"的严格程度
  function aiPickWeapon(players, me, level, rng) {
    const scored = scoreWeapons(players, me);
    if (!scored.length) return null;
    const cfg = DATA.AI[level];
    if (cfg.greedy >= 1) return scored[0].wp;
    if (rng() < cfg.greedy) return scored[0].wp;
    // 非最优：从前几名里随机挑一个（AI 也会"试试别的"）
    const n = Math.min(cfg.pickRandom || 3, scored.length);
    return scored[Math.floor(rng() * n)].wp;
  }

  // 选武器 + 瞄准一起做。aiPickWeapon 单独用不了"够不够得着"这个条件——
  // 它连世界都拿不到，看不出"石箭够得着、投石够不着"。
  // 抽签规则与 aiPickWeapon 一致（greedy 档取最高、其余从前几名里随机），
  // 只在算出来 hopeless 时按分数往下顺延，换来"打不到就换个武器打"。
  // 注意 rng 消耗与 aiPickWeapon 不同：每试一件都要抽误差，试几件就抽几次。
  function aiChoose(w, players, me, level, rng) {
    const foe = players[1 - me];
    const cfg = DATA.AI[level];
    const hist = players[me].shots;
    const scored = scoreWeapons(players, me);
    if (!scored.length) return null;

    let pick = 0;
    if (cfg.greedy < 1 && rng() >= cfg.greedy) {
      pick = Math.floor(rng() * Math.min(cfg.pickRandom || 3, scored.length));
    }
    // 先试抽中的那件，再按分数顺延其余的。早先写的是 for (i = pick; i < len; i++)，
    // 只往后扫：抽中第 4 名时，排在它前面的三件根本不试——而那三件里可能就有
    // 唯一够得着的。F31 实测 easy 种子 1 选中了够不着的巨石，两件打得到的它没试过。
    const order = [pick];
    for (let i = 0; i < scored.length; i++) if (i !== pick) order.push(i);
    for (const i of order) {
      const wp = scored[i].wp;
      const aim = aiAim(w, players[me], foe, wp, level, rng, hist);
      if (!aim.hopeless) return { wp, aim };
    }
    // 一件都够不着：拿分最高的照打（弹道会落在半路）。实测触发率为 0——
    // 站位生成时已经校验过投石双向可达，这条留着是为了不把状态机卡死
    const wp = scored[0].wp;
    return { wp, aim: aiAim(w, players[me], foe, wp, level, rng, hist) };
  }

  // 对全新目标的第一发，这一发算不算合格：既不直击，落点也离目标至少
  // FIRST_SHOT_OFFSET 远。走的是真实碰撞判定，不是估算——"第一发必偏"是硬保证，
  // 只有拿真正的命中检测验一遍才算保证。口径与时序见 docs/需求与验收.md F30
  function firstShotOk(w, me, target, weapon, angle, power) {
    const p = makeProjectile(weapon, me.x, me.y - 34, angle, power);
    p.owner = 0;                      // owner=0 即射手本人，把他排除在命中目标外
                                      // （不指定 owner 的话，射手自己也会被当成靶子）
    const r = simulate(w, p, {}, { maxT: 20, players: [me, target] });
    if (!r.impact) return true;       // 弹丸没有落点（飞出世界）：谈不上打中
    if (r.impact.type === 'direct') return false;
    // 按**落点**判而不是按瞄点：瞄点挪开了 115~187px，但后面的误差注入还能把它
    // 拽回来一截，看落点才知道这发弹最后偏到哪儿去了
    const d = Math.hypot(r.impact.x - target.x, r.impact.y - bodyMid(target));
    return d >= DATA.AI.FIRST_SHOT_OFFSET;
  }

  // 把一发不合规的首发往外推到合规。两条路径共用（正常解与"够不着"兜底），
  // 只此一份，免得一边改了另一边漏——"够不着"那条路径曾经就是不设防的
  // （实测回旋镖在 3/300 张图上靠那条路径直击了对手）
  //
  // 收敛靠得住：角度会被 aLo/aHi 夹住、可能推不动，但力度每轮乘 0.94 必减——
  // 减到 MIN_POWER（0.12）时初速只剩 0.12v，射程 v²sin2θ/g 掉到几十像素，
  // 这发弹落在射手脚下，而站位间距至少 500px，必然远出合格线。
  // 所以"推到底"这个状态本身就是合格的，循环必然在有限步内退出，不是赌运气。
  // 轮数上限按"能从 1.0 降到 MIN_POWER"取：0.94ⁿ ≤ 0.12 要 n=35，故 n 轮内必到
  // 那个保底状态，40 留了余量。实测 1200 发首发（aiChoose 真正出手的那一发）
  // 的推挤轮数：54.3% 一次就过、29.3% 推 1 轮、9.5% 推 2 轮，最长 10 轮
  function nudgeToFirstShotMiss(w, me, target, weapon, angle, power, left, aLo, aHi) {
    for (let i = 0; i < 40 && !firstShotOk(w, me, target, weapon, angle, power); i++) {
      angle = clamp(angle + (left ? -1 : 1) * 0.03, aLo, aHi);
      power = clamp(power * 0.94, P.MIN_POWER, 1);
    }
    return { angle, power };
  }

  // 瞄准：给角度反解力度 + 弧线校验 + 误差注入
  // hist：对同一目标已射击次数（新目标首发放大误差，随交火收敛但有下限）
  function aiAim(w, me, target, weapon, level, rng, hist = 0) {
    const cfg = DATA.AI[level];
    const g = P.G * (weapon.gMul || 1);
    const sx = me.x, sy = me.y - 34;              // 出手点
    let tx = target.x, ty = bodyMid(target);      // 瞄身体中心（受击胶囊的中点，见 data.js HIT）
    // 全新目标的第一发：先把瞄点沿垂直方向挪开，给下面的硬校验一个起手位。
    // 光靠放大误差做不到"必偏"——误差乘 2.6 倍后 hard 档首发直击率仍有 45%，
    // 观察期形同虚设（见 docs/需求与验收.md F30）。挪开量带随机，
    // 看着像失手不像放水。
    // 这里只是**起手**，不承担保证：挪开的距离会被后面的误差注入吃掉一截，
    // 真正"落点偏出 FIRST_SHOT_OFFSET"由出口那圈真实碰撞校验兜底。
    // 偏移量取 1.2 倍合格线：够着合格线，又给误差注入留出往回拽的余量，
    // 让出口校验多数时候一次就过（一次不过就多推一轮，见下面的循环）
    if (hist === 0) {
      const ox = tx - sx, oy = ty - sy;
      const l = Math.hypot(ox, oy) || 1;
      const off = DATA.AI.FIRST_SHOT_OFFSET * (0.96 + rng() * 0.6) * (rng() < 0.5 ? -1 : 1);
      tx += (-oy / l) * off;                      // (−oy, ox)/l 是连线的垂直单位向量
      ty += (ox / l) * off;
    }
    const dx = tx - sx, dy = ty - sy;
    const left = dx < 0;
    const [aLo, aHi] = angleRange(me.x, tx);
    // 把镜像帧的仰角换算成世界角度
    const toWorld = (e) => (left ? Math.PI - e : e);

    // 候选仰角：从"最舒服的中等弧度"往外扩，先试常规弧度再试极端解。
    // 玩家就是这么打的——先看弧度顺不顺眼，再调用力。
    const cands = [];
    const push = (e) => { if (e >= 0 && e <= Math.PI / 2) cands.push(e); };
    const full = solveShot(weapon.v, g, dx, dy);
    if (full) { push(full.low); push(full.high); }
    for (const d of [45, 38, 52, 32, 60, 26, 68, 20, 75, 14, 82]) push(d * DEG);

    // 逐个试射：落点离目标够近就用它
    let best = null;
    for (const elev of cands) {
      const pw = solvePower(weapon.v, g, dx, dy, elev);
      if (pw === null) continue;
      const p = clamp(pw, P.MIN_POWER, 1);
      const ang = toWorld(elev);
      const proj = makeProjectile(weapon, sx, sy, ang, p);
      // 直击判定要两件事同时成立才生效：传 players（不传就只算地形，预览就是这么用的），
      // 且指定 owner（不指定的话连射手自己都会被当成目标）。原先两件都没做，
      // 于是下面那行直击加权恒为 0、"能直击就不再找了"这条捷径从来没走到过——
      // AI 反而在躲开直击：穿过对手的弧线会被当成"落点偏了很远"扣分。
      proj.owner = 0;
      const r = simulate(w, proj, {}, { maxT: 14, players: [me, target] });
      if (!r.impact) continue;
      const miss = Math.hypot(r.impact.x - tx, r.impact.y - ty);
      // 够不够得着，看的是"这条弹道全程离瞄点最近能到多近"，而不是落点离瞄点多远：
      // 回旋镖飞到半路会折返、投石索落地还会弹一下，落点在投手脚下或半路，
      // 拿落点去比就成"够得着也判够不着"（实测 200 局里误判 11 次）
      let near = miss;
      for (const q of r.pts) near = Math.min(near, Math.hypot(q.x - tx, q.y - ty));
      const direct = r.impact.type === 'direct' ? -1 : 0;   // 直接命中最好
      const cost = direct + miss / 100 + Math.abs(pw - 1) * 0.01;
      if (!best || cost < best.cost) best = { elev, power: p, cost, miss, near, direct: direct < 0 };
      if (direct < 0) break;                                 // 能直击就不再找了
    }
    // 够不着：没有任何一条弧线能落到瞄点附近。这个判定必须做出来，否则 aiAim 会
    // 安安静静地返回一发"满力也只飞到半路"的弹，调用方看不出这是够不着，
    // 也就永远想不到换武器（F31）。判定阈值见 data.js 的 REACH_TOL
    // 直击要单独放行：命中点落在对手受击体边缘时，miss 天然等于
    // 身体半径 + 弹丸半径（巨石是 22+16=38px 再叠上胶囊半高），拿 miss 直接比阈值
    // 会把"打得准"判成"够不着"——巨石曾因此 200/200 全判够不着
    if (!best || (!best.direct && best.near > DATA.AI.REACH_TOL)) {
      let hAngle = toWorld(45 * DEG), hPower = 1;
      // 够不着 ≠ 打不到：45° 满力这一发从来没验过直击，实测真能打中
      // （回旋镖在 3/300 张图上就这么直击了对手）。全新目标的第一发在这条路径上
      // 同样受 F30 硬保证约束，所以一并推挤——两条出口一份保证，不留例外
      if (hist === 0) ({ angle: hAngle, power: hPower } =
        nudgeToFirstShotMiss(w, me, target, weapon, hAngle, hPower, left, aLo, aHi));
      return { angle: hAngle, power: hPower, hopeless: true, near: best ? best.near : Infinity };
    }

    let angle = toWorld(best.elev);
    let power = best.power;
    // 误差注入：新目标首发放大，之后每发乘 CONVERGE 收敛，收敛到本档基准误差的一半为止。
    // 这里早先写的是 max(CONVERGE**hist, 1/bias)，hist≥1 时 1/bias≡1、
    // hist=0 时 CONVERGE⁰=1，两次取 max 都是 1——decay 恒等于 1，CONVERGE 是个空旋钮，
    // 误差从头到尾都是基准值。现在按"首发乘 BIAS、其后每发乘 CONVERGE"算。
    const scale = (hist === 0 ? DATA.AI.FIRST_SHOT_BIAS : 1)
                * DATA.AI.CONVERGE ** Math.max(0, hist - 1);
    const k = Math.max(scale, DATA.AI.MIN_ERR_RATIO);
    const ae = cfg.angErr * k;
    const pe = cfg.powErr * k;
    angle += (rng() * 2 - 1) * ae;
    power *= 1 + (rng() * 2 - 1) * pe;
    // 故意打偏（低难度的手下留情）
    if (cfg.missChance > 0 && rng() < cfg.missChance) {
      angle += (rng() * 2 - 1) * 0.16;
      power *= 0.86 + rng() * 0.2;
    }
    // 钳制必须在校验之前：hitsDirect 拿的是"最终出手参数"，钳制放在后面的话
    // 验的是另一发弹——误差注入能把 power 顶到 1.26，满力弹打过顶、校验判"没直击"
    // 于是循环一次不跑，随后 clamp 把 power 压回 1.0 才打出去，正好命中。
    // （F30 的 1/40 次漏网就是这么来的：验的和打的不是同一发）
    angle = clamp(angle, aLo, aHi);
    power = clamp(power, P.MIN_POWER, 1);
    // 硬保证「全新目标第一发不直击、且落点偏出 FIRST_SHOT_OFFSET」：上面挪开的瞄点
    // 会被误差注入又拽回来——easy 的 missChance 一口气抖 ±0.16 弧度，比挪开量还大，
    // 光挪瞄点保证不了（400 局/档实测落点偏移最小 34px）。所以出手前拿真碰撞验一遍，
    // 不合格就继续往外推，推到合格为止。**没有"推不动就照原样打"这条退路**
    // （上面那条"够不着"的出口也走同一份推挤，见 nudgeToFirstShotMiss）
    if (hist === 0) {
      ({ angle, power } = nudgeToFirstShotMiss(w, me, target, weapon, angle, power, left, aLo, aHi));
    }
    return { angle, power, hopeless: false, elev: best.elev, miss: best.miss, near: best.near };
  }

  // ---------- 整局推演 ----------
  // 贴目取值：一局取双方里**较高**的那一档（同档就是它自己）。DATA.KOMI 是
  // {easy,medium,hard} 的表；本地双人双方都是人、没有档位，取锚定值 medium。
  // 传进来的档位认不出（undefined/拼错）时同样落到 medium——宁可发锚定值，
  // 也不要发 undefined 把 hp 变成 NaN。
  // 覆写成标量（DATA.KOMI = 8）时按标量发：tools/komi-curve.cjs 扫曲线就靠这条。
  const RANK = { easy: 0, medium: 1, hard: 2 };
  function komiFor(a, b) {
    const K = DATA.KOMI;
    if (typeof K === 'number') return K;
    let best = null;
    for (const lv of [a, b]) if (lv in RANK && (best === null || RANK[lv] > RANK[best])) best = lv;
    return K[best || 'medium'];
  }

  // 纯逻辑跑完一整局（bot-playtest 难度回归 与 fuzz 测试共用，不涉及任何渲染）
  // i 就是回合顺序（0 先手 / 1 后手），贴目按它发——不按"人/AI"发，
  // 这样人机、双人、AI 对战三种走法用的是同一条规则。
  // komi 省略时按 komiFor() 的默认（medium 锚定值）；game.js 传的是所选难度那一档。
  function newPlayer(spawn, i, komi) {
    const ammo = newAmmo();
    const k = komi === undefined ? komiFor() : komi;
    const hpMax = DATA.HP + (i === 1 ? k : 0);
    return { x: spawn.x, y: spawn.y, hp: hpMax, hpMax, burn: null, ammo, shots: 0, idx: i };
  }

  // data.js 里 ammo:0 表示"无限"；这里换成 Infinity，让"还有弹药吗"统一成 >0 一个判断，
  // 且递减逻辑永远不会把无限武器打成 0（否则兜底武器会消失）
  function newAmmo() {
    const ammo = {};
    for (const wp of DATA.WEAPONS) ammo[wp.id] = wp.ammo > 0 ? wp.ammo : Infinity;
    return ammo;
  }

  function simulateMatch(seed, lvA, lvB, opts = {}) {
    const maxTurns = opts.maxTurns || 200;
    const w = newBattle(seed);
    const spawns = w.spawns;
    if (!spawns || spawns.length < 2) return { ok: false, reason: 'no-spawn', seed };
    const rng = WORLD.mulberry32((seed ^ 0x9E3779B9) >>> 0);
    const komi = komiFor(lvA, lvB);
    const players = [newPlayer(spawns[0], 0, komi), newPlayer(spawns[1], 1, komi)];
    const levels = [lvA, lvB];
    const log = [];

    for (let turn = 0; turn < maxTurns; turn++) {
      const me = turn % 2;
      const foe = 1 - me;
      const burnDmg = tickBurn(players[me]);
      if (burnDmg) log.push({ turn, me, burn: burnDmg });
      if (players[me].hp <= 0) return { ok: true, winner: foe, turns: turn, seed, players, log };
      if (players[foe].hp <= 0) return { ok: true, winner: me, turns: turn, seed, players, log };

      const act = aiChoose(w, players, me, levels[me], rng);
      const wp = act.wp, aim = act.aim;
      players[me].shots++;
      if (Number.isFinite(players[me].ammo[wp.id])) players[me].ammo[wp.id]--;

      const proj = makeProjectile(wp, players[me].x, players[me].y - 34, aim.angle, aim.power);
      proj.owner = me;
      const res = simulate(w, proj, {}, { players, maxT: 14 });
      const out = settleImpact(res.impact, wp, players, me);
      log.push({ turn, me, weapon: wp.id, angle: aim.angle, power: aim.power, impact: res.impact && res.impact.type, hits: out.hits });
      if (!Number.isFinite(players[0].hp) || !Number.isFinite(players[1].hp)) {
        return { ok: false, reason: 'nan-hp', turn, seed };
      }
    }
    return { ok: false, reason: 'no-winner', turns: maxTurns, seed, players };
  }

  return {
    DEG, clamp, segCircle, segCapsule, bodyMid, solveShot, solvePower, angleRange, makeProjectile, stepProjectile, simulate,
    clampFrame, pullToAim, timeoutAim,
    simulateMatch, newPlayer, newAmmo, komiFor,
    reachable, newBattle, splashAt, settleImpact, tickBurn, aiPickWeapon, aiAim, aiChoose,
  };
})(
  typeof DATA !== 'undefined' ? DATA : require('./data.js'),
  typeof WORLD !== 'undefined' ? WORLD : require('./world.js')
);

if (typeof module !== 'undefined') module.exports = LOGIC;
