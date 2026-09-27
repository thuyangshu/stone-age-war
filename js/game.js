// 战斗场景：Phaser 只管表现（相机/输入/补间/粒子/贴图），规则全部来自 LOGIC / WORLD
// 世界坐标固定 1600×1000，y 向下为正，与 world.js 的高度场同一套坐标
const DEPTH = { sky: 0, far: 1, terrain: 5, decal: 6, player: 10, aim: 11, proj: 12, fx: 14, text: 30 };

class BattleScene extends Phaser.Scene {
  constructor() { super('battle'); }

  create() {
    this.s = null;
    this.cameras.main.setBackgroundColor('#BFE0F0');
    this.input.on('pointerdown', (p) => this.onDown(p));
    this.input.on('pointermove', (p) => this.onMove(p));
    this.input.on('pointerup', (p) => this.onUp(p));
    this.input.on('pointerupoutside', (p) => this.onUp(p));
    this.events.on('shutdown', () => { this.s = null; });
  }

  // ---------------- 开局 ----------------
  startBattle(mode, level, seed) {
    this.abandon();                 // 先把上一局残留的回调/补间作废（见 abandon 的注释）
    const w = LOGIC.newBattle(seed === undefined ? (Math.random() * 1e9) | 0 : seed);
    this.s = {
      mode, level,
      world: w,
      // 玩家结构体与 bot 推演共用同一份构造函数，弹药"0 即无限"的约定只有一处
      players: w.spawns.map((sp, i) => LOGIC.newPlayer(sp, i)),
      turn: 0, phase: 'idle', weapon: null, proj: null, winner: null,
      aim: null, dragging: false, dragFrom: null, dragPull: 0,
      thinkMs: DATA.TURN.AI_THINK[level] || 600,
      limitLeft: DATA.TURN.LIMIT,
      decals: 0, floaters: [],
    };
    this.buildScene();
    UI.onBattleReady();
    this.later(220, () => this.beginTurn(true));
  }

  // 延时回调一律走这里。场景时钟上的回调不会因为"开了新一局"自动作废：
  // buildScene() 只清显示对象、不清时钟，于是上一局排下的 nextTurn / endGame
  // 会在新一局里醒来。实测两个后果（测试方 T-4/T-5 两轮独立复现）：
  //   ① 命中落地后那 IMPACT_HOLD 内点重开 → 新局被上一局的 nextTurn 推进，
  //      玩家一的回合被跳过，直接变成玩家二；
  //   ② 击杀结算那 620ms 内点重开 → 满血 100/100 的新局被判出胜负，
  //      弹窗写"玩家一 获胜 / 剩余血量 100 对 100"。
  // 局次号在开局与回主菜单时各 +1，回调醒来先比对，过期直接返回。
  later(ms, fn) {
    const g = this.gen;
    return this.time.delayedCall(ms, () => { if (this.gen === g) fn(); });
  }

  // 把"当前这一局"整局作废：局次号 +1（让已投递、撤不回来的回调醒来即弃），
  // 再清空场景时钟与补间。开新局和回主菜单都要走这一步——
  // 回主菜单那条尤其不能省：toTitle() 只把 s 置空、显示对象清掉，时钟照样在走，
  // 上一局的 nextTurn 醒来后会去读 null 的 s。
  abandon() {
    this.gen = (this.gen || 0) + 1;
    this.time.removeAllEvents();
    this.tweens.killAll();          // 上一局的补间都指着上一局已销毁的精灵
  }

  buildScene() {
    const s = this.s, w = s.world;
    this.children.removeAll(true);
    this.skyGfx = this.add.graphics().setDepth(DEPTH.sky);
    this.paintSky();
    // 贴图左右各外扩了 BLEED，摆位要相应左移，世界 x=0 才落在图片的 BLEED 处
    this.terrain = this.add.image(-DATA.TERRAIN.BLEED, 0, TEX.buildTerrain(this, w))
      .setOrigin(0).setDepth(DEPTH.terrain);
    this.decalRT = this.add.renderTexture(0, 0, DATA.TERRAIN.W, DATA.TERRAIN.H).setOrigin(0).setDepth(DEPTH.decal);
    this.aimGfx = this.add.graphics().setDepth(DEPTH.aim);
    this.trailGfx = this.add.graphics().setDepth(DEPTH.proj - 1);

    // 两位原始人：A 面向右（在左侧），B 面向左
    this.heroes = s.players.map((p, i) => {
      const skin = i === 0 ? 'a' : 'b';
      const spr = this.add.image(p.x, p.y, TEX.heroTexture(this, skin, 'idle', i === 0 ? 1 : -1))
        .setOrigin(TEX.HERO_BOX.cx / TEX.HERO_BOX.W, 1 - 8 / TEX.HERO_BOX.H)
        .setDepth(DEPTH.player);
      spr.skin = skin;
      spr.facing = i === 0 ? 1 : -1;
      spr.pose = 'idle';
      // 待机呼吸：极轻微的上下浮动，不做大幅摆动，免得瞄不准
      this.tweens.add({ targets: spr, y: p.y - 3, duration: 1500 + i * 130, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
      return spr;
    });

    this.projSpr = this.add.image(0, 0, '__DEFAULT').setDepth(DEPTH.proj).setVisible(false);
    this.sparks = this.add.particles(0, 0, TEX.dotTexture(this), {
      speed: { min: 40, max: 210 }, lifespan: { min: 260, max: 620 },
      scale: { start: 1.15, end: 0 }, alpha: { start: 1, end: 0 },
      gravityY: 520, emitting: false,
    }).setDepth(DEPTH.fx);
    this.water = this.add.particles(0, 0, TEX.dotTexture(this), {
      speed: { min: 90, max: 260 }, lifespan: { min: 380, max: 760 },
      scale: { start: 0.9, end: 0 }, alpha: { start: 1, end: 0 },
      gravityY: 900, emitting: false, tint: 0xCFEAF5,
    }).setDepth(DEPTH.fx);
    this.smoke = this.add.particles(0, 0, TEX.dotTexture(this), {
      speed: { min: 12, max: 70 }, lifespan: { min: 420, max: 900 },
      scale: { start: 1.5, end: 2.6 }, alpha: { start: .5, end: 0 }, emitting: false,
    }).setDepth(DEPTH.fx);

    this.cameras.main.setBounds(-500, -500, DATA.TERRAIN.W + 1000, DATA.TERRAIN.H + 900);
    this.layout();
    this.cameras.main.centerOn(DATA.TERRAIN.W / 2, DATA.TERRAIN.H / 2);
    this.refreshHeroes();
  }

  paintSky() {
    const g = this.skyGfx, W = DATA.TERRAIN.W;
    g.clear();
    // 天空：整块渐变铺满世界并外扩，任何缩放/平移都不会露底
    g.fillGradientStyle(DATA.COLORS.skyTop, DATA.COLORS.skyTop, DATA.COLORS.skyBot, DATA.COLORS.skyBot, 1);
    g.fillRect(-900, -900, W + 1800, 1900);
    // 太阳
    g.fillStyle(0xFFE9C4, .85); g.fillCircle(W * 0.74, 150, 62);
    g.fillStyle(0xFFF4DE, .95); g.fillCircle(W * 0.74, 150, 44);
    // 远山两层：越远越淡，压在地形之后当纵深
    const hill = (y, amp, color, alpha, seed) => {
      g.fillStyle(color, alpha);
      g.beginPath();
      g.moveTo(-900, y + 300);
      let s = seed;
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      for (let x = -900; x <= W + 900; x += 130) {
        g.lineTo(x, y - Math.abs(Math.sin(x * 0.0016 + seed)) * amp - rnd() * 14);
      }
      g.lineTo(W + 900, y + 300);
      g.closePath(); g.fillPath();
    };
    hill(720, 150, 0x8FA9B8, .55, 3);
    hill(760, 110, 0x7C97A6, .7, 11);
  }

  layout() {
    const cam = this.cameras.main;
    const vw = this.scale.width, vh = this.scale.height;
    // 顶栏与武器栏各占一条，可用高度要减掉，否则人物被压在 UI 底下
    const pad = 84;
    const availH = Math.max(200, vh - pad);
    const fit = Math.min(vw / DATA.TERRAIN.W, availH / DATA.TERRAIN.H);
    cam.setZoom(Math.max(DATA.CAM.minZoom, Math.min(1.05, fit)));
    cam.setFollowOffset(0, pad * 0.18);
  }

  // 把镜头挪到当前射手身上；世界整个装得下（桌面全景）就不用挪。
  // 这件事必须发生在 beginTurn 里而不是 nextTurn 里：原先只有 nextTurn 挪镜头，
  // 于是每局第一回合镜头还停在 buildScene 时的世界中心——手机竖屏一屏只装得下
  // 世界宽度的四成，玩家第一眼看到的是地图中央，射手自己在屏外
  // （390×844 实测 8 局里 6 局射手不完整、2 局完全在屏外），第二回合起才自愈。
  focusOnTurn() {
    const s = this.s;
    if (!s) return;
    const cam = this.cameras.main;
    const vw = this.scale.width / cam.zoom, vh = this.scale.height / cam.zoom;
    if (vw >= DATA.TERRAIN.W && vh >= DATA.TERRAIN.H) return;
    cam.pan(s.players[s.turn].x, s.players[s.turn].y - 40, 420, 'Sine.easeInOut', false);
  }

  // ---------------- 回合 ----------------
  beginTurn(first) {
    const s = this.s;
    if (!s || s.winner !== null) return;
    this.focusOnTurn();
    const p = s.players[s.turn];
    // 燃烧在本人回合开始结算
    const burn = LOGIC.tickBurn(p);
    if (burn) {
      SFX.play('burn');
      this.floatText(p.x, p.y - 120, `-${burn}`, '#E0863C');
      this.hitBurst(p.x, p.y - 60, 0xE0863C, 8);
      UI.syncHp();
      if (p.hp <= 0) return this.endGame(1 - s.turn);
    }
    s.phase = 'aim';
    s.weapon = null;
    s.aim = null;
    s.limitLeft = DATA.TURN.LIMIT;
    // 替玩家预选第一件还有弹药的武器。回合开始 `weapon=null` 而拖拽又要求已选武器，
    // 于是"上手先拖一下试试"的玩家会撞进一段毫无反馈的死区：没线、没力度条、没提示，
    // 就是不动——看起来像游戏坏了。预选之后拖拽随时有反应，想换武器再点一下即可。
    if (this.isHuman()) s.weapon = DATA.WEAPONS.find((w) => s.players[s.turn].ammo[w.id] > 0) || null;
    this.refreshHeroes();
    this.clearAim();
    UI.onTurnStart(s.turn, this.isHuman());
    if (this.isHuman()) return;
    // AI：先"思考"再"瞄准"再出手，三段留白让玩家看清它在干什么
    s.phase = 'think';
    this.later(s.thinkMs, () => {
      if (!this.s || this.s.winner !== null) return;
      if (this.s.turn !== s.turn) return;
      this.aiTurn();
    });
  }

  aiTurn() {
    const s = this.s;
    // 选武与瞄准一起定：够不着的武器要换掉，光选不解算是看不出够不够得着的
    const act = LOGIC.aiChoose(s.world, s.players, s.turn, s.level, Math.random);
    const wp = act.wp;
    const aim = act.aim;
    s.weapon = wp;
    s.phase = 'aimshow';
    UI.syncWeapon();
    SFX.play('click');
    // 瞄准演出：把这条瞄准线亮一下，玩家能看出 AI 打算往哪打
    this.showAimLine(aim.angle, Math.min(1, aim.power * 1.06));
    this.later(DATA.TURN.AI_AIM_MS, () => {
      if (!this.s || this.s.winner !== null || this.s.turn !== s.turn) return;
      this.clearAim();
      this.fire(aim.angle, aim.power);
    });
  }

  isHuman() {
    const s = this.s;
    if (!s) return false;
    return s.mode === 'duo' ? true : s.turn === 0;
  }

  pickWeapon(id) {
    const s = this.s;
    if (!s || s.phase !== 'aim' || !this.isHuman()) return false;
    const wp = DATA.WEAPONS.find((x) => x.id === id);
    if (!wp || !(s.players[s.turn].ammo[wp.id] > 0)) return false;
    s.weapon = wp;
    SFX.play('click');
    UI.syncWeapon();
    return true;
  }

  // ---------------- 瞄准 ----------------
  onDown(p) {
    const s = this.s;
    if (!s || s.phase !== 'aim' || !this.isHuman() || !s.weapon) return;
    s.dragging = true;
    s.dragFrom = { x: p.x, y: p.y };
    s.dragPull = 0;
    UI.showPower(true);
  }

  onMove(p) {
    const s = this.s;
    if (!s || !s.dragging) return;
    // 弹弓式：按下点 → 当前点构成拉弓向量，出手方向与它相反
    const pull = { x: s.dragFrom.x - p.x, y: s.dragFrom.y - p.y };
    s.dragPull = Math.hypot(pull.x, pull.y);
    const res = this.aimFromPull(pull);
    s.aim = res;
    this.showAimLine(res.angle, res.power);
    UI.showPower(true, res.power);
  }

  onUp(p) {
    const s = this.s;
    if (!s || !s.dragging) return;
    s.dragging = false;
    UI.showPower(false);
    const res = s.aim;
    s.aim = null;
    this.clearAim();
    if (!res || !res.valid) return;   // 死区（拖距不足 / 力度不够）已在 LOGIC.pullToAim 里判掉
    // 手指从画布一路拖到 HUD 上、松在某个按钮上：这一发作废，按钮说了算。
    // 拖到暂停键上松手的人，本意是"这一发不打了"，不该顺带白扔一件武器（测试方 I4）
    if (this.releaseOverUi(p)) return;
    this.fire(res.angle, res.power);
  }

  // 松手点是不是压在 HUD 的按钮上。HUD 整层是 pointer-events:none、只有按钮是 auto
  // （style.css），所以画布上的正常松手 elementFromPoint 拿回来的是 canvas 自己，
  // 这条只在真的压在控件上时才拦。鼠标事件直接有 clientX/Y，触摸得掏 changedTouches——
  // 手机上这条路才是正路，两种都得认
  releaseOverUi(p) {
    const e = (p && p.event) || (this.input.activePointer && this.input.activePointer.event);
    const t = e && ((e.changedTouches && e.changedTouches[0]) || e);
    if (!t || typeof t.clientX !== 'number' || typeof t.clientY !== 'number') return false;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    return !!(el && el.closest && el.closest('button'));
  }

  // 把屏幕拉弓向量换算成合法的出手角度与力度。
  // 死区与角度夹取都在 LOGIC.pullToAim 里，那边是纯逻辑、能被单测钉死——
  // 放在这儿就只有跑起来才知道有没有踩空
  aimFromPull(pull) {
    const s = this.s;
    const me = s.players[s.turn], foe = s.players[1 - s.turn];
    return LOGIC.pullToAim(pull, me.x, foe.x);
  }

  showAimLine(angle, power) {
    const s = this.s;
    const g = this.aimGfx;
    g.clear();
    const me = s.players[s.turn];
    const wp = s.weapon || DATA.WEAPONS[0];
    const p = LOGIC.makeProjectile(wp, me.x, me.y - 34, angle, power);
    const r = LOGIC.simulate(s.world, p, {}, { maxT: 8 });
    const pts = r.pts;
    const step = Math.max(1, Math.floor(pts.length / DATA.PHYS.PREVIEW_N));
    g.fillStyle(0xFAF0E4, .85);
    let dots = 0;
    for (let i = 0; i < pts.length; i += step) {
      const t = i / pts.length;
      g.fillCircle(pts[i].x, pts[i].y, 3.4 - t * 1.8);
      dots++;
    }
    // 观测点：这一帧到底画了几个点、有没有画落点圈。
    // Phaser 的 Graphics 只留一个压平的数字数组 commandBuffer，从外面数不出图元类型，
    // 而冒烟要能证明"预测线"和"落点圈"两样都真的画了（F9），所以在这儿记一笔
    this.aimStats = { dots, ring: !!r.impact };
    if (r.impact) {
      const isWater = r.impact.type === 'water';
      g.lineStyle(3.5, isWater ? 0x6FB3D0 : 0xFAF0E4, .95);
      g.strokeCircle(r.impact.x, r.impact.y, 15 + power * 12);
      g.lineStyle(2, 0x4A342A, .5);
      g.strokeCircle(r.impact.x, r.impact.y, 15 + power * 12 + 5);
    }
    // 出手点上的方向指示
    g.lineStyle(4, 0xFAF0E4, .8);
    g.beginPath();
    g.moveTo(me.x, me.y - 34);
    g.lineTo(me.x + Math.cos(angle) * 46, me.y - 34 - Math.sin(angle) * 46);
    g.strokePath();
  }

  clearAim() { this.aimGfx.clear(); }

  // ---------------- 发射与飞行 ----------------
  fire(angle, power) {
    const s = this.s;
    if (!s || s.winner !== null) return null;
    const me = s.players[s.turn];
    const wp = s.weapon || DATA.WEAPONS[0];
    const proj = LOGIC.makeProjectile(wp, me.x, me.y - 34, angle, power);
    proj.owner = s.turn;
    s.proj = proj;
    s.phase = 'fly';
    s.flyT = 0;
    s.acc = 0;
    s.trail = [];
    if (Number.isFinite(me.ammo[wp.id])) me.ammo[wp.id]--;
    me.shots++;
    this.projSpr.setTexture(TEX.weaponTexture(this, wp)).setVisible(true)
      .setPosition(proj.x, proj.y).setRotation(0);
    SFX.play(wp.returnAt ? 'fly' : 'throw');
    this.tweens.add({ targets: this.heroes[s.turn], duration: 220, yoyo: true, repeat: 1,
      y: this.heroes[s.turn].y - 5, ease: 'Quad.out' });
    this.setPose(s.turn, 'throw');
    this.later(280, () => this.setPose(s.turn, 'idle'));
    UI.syncWeapon();
    UI.setPhase('fly');
    return proj;
  }

  update(time, delta) {
    const s = this.s;
    if (!s) return;
    this.tickLimit(delta);            // 倒计时先跑：早先被下面的 fly 判断提前 return 挡掉了
    // 每帧钉一次越屏指示：相机跟着弹丸飞的时候对手随时可能滑出视野，
    // 放在相位切换处算会漏掉这种"飞着飞着就没了"的情况
    UI.updateFoeHint();
    if (s.phase !== 'fly' || !s.proj) return;
    const dt = LOGIC.clampFrame(delta);
    s.acc += dt;
    const h = DATA.PHYS.SUB_DT;
    const ctx = { world: s.world, players: s.players, wind: 0 };
    let guard = 0;
    while (s.acc >= h && guard++ < 64) {
      const ev = LOGIC.stepProjectile(s.proj, h, ctx);
      s.acc -= h;
      s.flyT += h;
      if (ev) { this.onImpact(ev); return; }
      if (s.proj.y > DATA.TERRAIN.H + 300 || s.flyT > 16) {
        return this.onImpact({ type: 'out', x: s.proj.x, y: s.proj.y });
      }
    }
    const p = s.proj;
    this.projSpr.setPosition(p.x, p.y);
    if (p.weapon.spin) this.projSpr.rotation += dt * 13;
    else if (p.weapon.rot) this.projSpr.setRotation(Math.atan2(p.vy, p.vx));
    else this.projSpr.rotation += dt * 6;
    // 尾迹：回旋镖留得长一些，能看清去回两段
    s.trail.push({ x: p.x, y: p.y });
    if (s.trail.length > (p.weapon.returnAt ? 60 : 26)) s.trail.shift();
    const g = this.trailGfx;
    g.clear();
    g.lineStyle(3, p.weapon.color, .45);
    g.beginPath();
    g.moveTo(s.trail[0].x, s.trail[0].y);
    for (const q of s.trail) g.lineTo(q.x, q.y);
    g.strokePath();
    this.followProjectile(p);
  }

  followProjectile(p) {
    const cam = this.cameras.main;
    const vw = this.scale.width / cam.zoom, vh = this.scale.height / cam.zoom;
    // 世界装得下就不动镜头，免得画面乱晃
    if (vw >= DATA.TERRAIN.W && vh >= DATA.TERRAIN.H) return;
    cam.pan(p.x, p.y, 260, 'Sine.easeOut', false);
  }

  onImpact(ev) {
    const s = this.s;
    s.phase = 'impact';
    const wp = s.proj.weapon;
    const x = ev.x, y = ev.y;
    this.projSpr.setVisible(false);
    this.trailGfx.clear();
    const t = ev.type;

    if (t === 'catch') {
      SFX.play('catch');
      this.floatText(x, y - 30, '接住 +1', '#FAF0E4');
      const me = s.players[s.turn];
      if (Number.isFinite(me.ammo[wp.id])) me.ammo[wp.id]++;
      UI.syncWeapon();
    } else if (t === 'water') {
      SFX.play('splash');
      this.water.explode(22, x, y);
      this.ring(x, y, 0x6FB3D0, 46);
    } else if (t === 'bush') {
      SFX.play('rustle');
      this.sparks.setParticleTint(DATA.COLORS.bushTop);
      this.sparks.explode(12, x, y);
      this.smoke.setParticleTint(DATA.COLORS.bushTop);
      this.smoke.explode(5, x, y);
    } else if (t === 'bounce') {
      SFX.play('bounce');
      this.sparks.setParticleTint(DATA.COLORS.dTop);
      this.sparks.explode(7, x, y);
      this.projSpr.setVisible(true);
      s.phase = 'fly';
      return;
    } else if (t === 'out') {
      UI.setPhase('impact');
      return this.later(DATA.TURN.IMPACT_HOLD * 0.6, () => this.nextTurn());
    } else {
      SFX.play(t === 'direct' ? 'crack' : 'thud');
      this.sparks.setParticleTint(DATA.COLORS.dTop);
      this.sparks.explode(t === 'direct' ? 16 : 24, x, y);
      this.smoke.setParticleTint(0xBFB0A0);
      this.smoke.explode(t === 'direct' ? 6 : 12, x, y);
      this.addDecal(wp, x, y, t);
      const shake = Math.min(0.01, 0.003 + (wp.splash ? wp.splash.r : 40) / 24000);
      this.cameras.main.shake(170, shake);
    }

    const out = LOGIC.settleImpact(ev, wp, s.players, s.turn);
    for (const h of out.hits) {
      const tp = s.players[h.who];
      this.floatText(tp.x, tp.y - 118 - Math.random() * 14, `-${h.dmg}`, h.kind === 'direct' ? '#FFD9A0' : '#E0863C');
      this.hitBurst(tp.x, tp.y - 60, h.kind === 'direct' ? 0xFFD9A0 : 0xE0863C, h.kind === 'direct' ? 14 : 8);
      this.setPose(h.who, 'hit');
      this.later(320, () => this.setPose(h.who, 'idle'));
    }
    if (out.hits.some((h) => h.who === s.turn)) SFX.play('hurt', 300);
    UI.syncHp();
    UI.syncWeapon();
    UI.setPhase('impact');

    const dead = s.players.findIndex((p) => p.hp <= 0);
    if (dead >= 0) { this.later(620, () => this.endGame(1 - dead)); return; }
    this.later(DATA.TURN.IMPACT_HOLD, () => this.nextTurn());
  }

  addDecal(wp, x, y, type) {
    const g = this.add.graphics();
    const big = wp.splash ? wp.splash.r : 40;
    if (type === 'ground') {
      g.fillStyle(0x000000, .22);
      g.fillEllipse(x, y + 2, big * 1.15, big * 0.4);
      g.fillStyle(DATA.COLORS.dBot, .55);
      g.fillEllipse(x, y, big * 0.82, big * 0.28);
      g.fillStyle(DATA.COLORS.dTop, .5);
      g.fillEllipse(x, y - 2, big * 0.45, big * 0.15);
    }
    if (wp.burn) {
      g.fillStyle(0x4A342A, .4);
      g.fillEllipse(x, y, big * 1.3, big * 0.45);
      g.fillStyle(0xC0603B, .35);
      g.fillEllipse(x, y - 2, big * 0.7, big * 0.25);
    }
    this.decalRT.draw(g);
    g.destroy();
    this.s.decals++;
  }

  ring(x, y, color, r) {
    const g = this.add.graphics().setDepth(DEPTH.fx);
    g.lineStyle(4, color, .9);
    g.strokeCircle(x, y, 6);
    this.tweens.add({
      targets: g, alpha: 0, duration: 460, ease: 'Quad.out',
      onUpdate: (tw, t) => { g.clear(); g.lineStyle(4, color, .9 * (1 - t)); g.strokeCircle(x, y, 6 + r * t); },
      onComplete: () => g.destroy(),
    });
  }

  hitBurst(x, y, tint, n) {
    this.sparks.setParticleTint(tint);
    this.sparks.explode(n, x, y);
  }

  floatText(x, y, str, color) {
    const t = this.add.text(x, y, str, {
      fontFamily: 'system-ui, sans-serif', fontSize: '26px', fontStyle: 'bold',
      color, stroke: '#4A342A', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(DEPTH.text);
    this.tweens.add({
      targets: t, y: y - 56, alpha: 0, duration: 900, ease: 'Quad.out',
      onComplete: () => t.destroy(),
    });
  }

  setPose(who, pose) {
    const spr = this.heroes[who];
    if (!spr || spr.pose === pose) return;
    spr.pose = pose;
    spr.setTexture(TEX.heroTexture(this, spr.skin, pose, spr.facing));
  }

  refreshHeroes() {
    if (!this.heroes) return;
    this.heroes.forEach((spr, i) => {
      const p = this.s.players[i];
      spr.setPosition(p.x, p.y);
      if (p.hp <= 0) { spr.pose = 'dead'; spr.setTexture(TEX.heroTexture(this, spr.skin, 'dead', spr.facing)); }
    });
  }

  // ---------------- 回合推进 ----------------
  nextTurn() {
    const s = this.s;
    if (!s || s.winner !== null) return;
    s.proj = null;
    s.turn = 1 - s.turn;
    this.projSpr.setVisible(false);
    this.trailGfx.clear();
    this.clearAim();
    // 镜头交给 beginTurn 里的 focusOnTurn()——那里是唯一的挪镜头入口，
    // 分两处写就会出现"第一回合没人管"这种漏（见 focusOnTurn 注释）
    // 双人模式：换手前先挡住屏幕，防误触
    if (s.mode === 'duo') {
      // 相位必须跟着改。早先只弹了遮罩、phase 留在 'impact'，于是"正在等交接"
      // 和"正在结算"在状态上完全一样——对手回合已经开始、屏幕上却还盖着上一发的结算。
      s.phase = 'handoff';
      UI.setPhase('handoff');
      return;
    }
    this.beginTurn(false);
  }

  // 交接遮罩确认后由 UI 调用
  resumeTurn() {
    const s = this.s;
    if (!s || s.phase !== 'handoff' || s.winner !== null) return;   // 只认交接相位，连点两下不会重复开局
    this.beginTurn(false);
  }

  endGame(winner) {
    const s = this.s;
    if (!s || s.winner !== null) return;
    s.winner = winner;
    s.phase = 'over';
    this.setPose(1 - winner, 'dead');
    this.clearAim();
    this.cameras.main.pan(s.players[winner].x, s.players[winner].y - 40, 500, 'Sine.easeInOut');
    SFX.play(winner === 0 || s.mode === 'duo' ? 'win' : 'lose');
    this.later(560, () => UI.showOver(winner));
  }

  // ---------------- 回合计时 ----------------
  tickLimit(dtMs) {
    const s = this.s;
    if (!s || s.paused || s.phase !== 'aim' || !this.isHuman()) return;
    s.limitLeft -= dtMs / 1000;
    const sec = Math.max(0, Math.ceil(s.limitLeft));
    if (sec !== s.limitShown) { s.limitShown = sec; UI.syncTimer(sec); }
    if (s.limitLeft <= 0) {
      // 超时按当前瞄准自动出手；没在瞄就按最小仰角平推一发，不让对局卡住
      const me = s.players[s.turn], foe = s.players[1 - s.turn];
      const aim = LOGIC.timeoutAim(s.aim, me, foe);
      UI.showPower(false);
      s.dragging = false;
      this.fire(aim.angle, aim.power);
    }
  }
}
