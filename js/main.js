// 入口：创建 Phaser 游戏，挂上 DOM 界面，并暴露自动化测试接口
window.addEventListener('load', () => {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#BFE0F0',
    banner: false,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [BattleScene],
    // 声音全由 ZzFX 负责，关掉 Phaser 自带的音频管理器，免得再建一个音频上下文
    audio: { noAudio: true },
  });

  // Phaser 3.90 转屏缺陷的兜底：方向变化时它用旧尺寸刷新一次就不再更新，稍后再刷一次
  const refit = () => setTimeout(() => {
    game.scale.refresh();
    const sc = game.scene.getScene('battle');
    if (sc && sc.s) sc.layout();
  }, 60);
  window.addEventListener('resize', refit);
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', refit);
  else window.addEventListener('orientationchange', refit);

  UI.init(game);

  // ---------- 自动化测试接口（只读状态 + 强制触发，不影响正常游玩） ----------
  const sc = () => game.scene.getScene('battle');
  window.__debug = {
    game,
    ready: () => !!(sc() && sc().s),
    mode: () => UI.mode(),
    level: () => UI.level(),
    state() {
      const s = sc() && sc().s;
      if (!s) return null;
      return {
        phase: s.phase, turn: s.turn, winner: s.winner, mode: s.mode, level: s.level,
        hp: s.players.map((p) => Math.max(0, Math.round(p.hp))),
        burn: s.players.map((p) => (p.burn ? p.burn.turns : 0)),
        ammo: s.players.map((p) => Object.assign({}, p.ammo)),
        weapon: s.weapon ? s.weapon.id : null,
        shots: s.players.map((p) => p.shots),
        decals: s.decals,
        limitLeft: s.limitLeft,
        zoom: sc().cameras.main.zoom,
        proj: s.proj ? { x: s.proj.x, y: s.proj.y, type: s.proj.weapon.id } : null,
        spawns: s.world.spawns.map((q) => ({ x: q.x, y: q.y })),
        ponds: s.world.ponds.length, bushes: s.world.bushes.length,
        fps: Math.round(game.loop.actualFps),
        // Phaser 的帧时间戳（毫秒，rAF 给的时间，等价于墙钟）。核对过 vendor 源码：
        // Phaser.TimeStep 里是 `this.time = t`，t 来自 rAF，不是积累的 delta。
        // 所以它只回答"页面还在不在渲染"，**不能**当游戏进度用——CPU 被压满时它照走。
        // 冒烟 S4 的进度判据用 phase/turn/shots 那几个语义量，这个只用于失败时打线索
        clock: Math.round(game.loop.time),
      };
    },
    start(mode = 'solo', level = 'medium', seed) {
      const s = sc();
      s.scene.resume();
      s.s = null;
      s.startBattle(mode, level, seed);
      return true;
    },
    pick: (id) => sc().pickWeapon(id),
    fire: (angle, power) => {
      const s = sc();
      if (!s.s) return false;
      // onUp 头一行就是 `if (!s.dragging) return`——不把拖拽状态补上，这条后门
      // 会在原地静默返回：调用方以为打出去了，其实一发没发。
      s.s.aim = { valid: true, angle, power };
      s.s.dragging = true;
      s.onUp();
      return true;
    },
    aimAngle(elev) { return elev * Math.PI / 180; },
    setThinkMs: (ms) => { const s = sc().s; if (s) { s.thinkMs = ms; DATA.TURN.AI_THINK[s.level] = ms; } },
    // 让当前 AI 立刻走一步（不用等思考演出）
    forceAi() {
      const s = sc();
      if (!s || !s.s || s.s.winner !== null) return false;
      s.s.turn; s.aiTurn();
      return true;
    },
    nextTurn() { sc().nextTurn(); return true; },
    // 直接把血量压到 n，用于快速打出结局
    setHp(who, n) { const s = sc().s; if (s) { s.players[who].hp = n; UI.syncHp(); } },
    handoffOk() { document.getElementById('btn-handoff').click(); return true; },
    // 读砸痕贴图的像素（alpha>0 说明确实烙上去了）
    decalPixel(x, y) {
      return new Promise((res) => {
        const rt = sc().decalRT;
        if (!rt || !rt.snapshotPixel) return res(null);
        rt.snapshotPixel(x, y, (c) => res({ r: c.red, g: c.green, b: c.blue, a: c.alpha }));
      });
    },
    // 读地形贴图的像素，用于验证"池塘有水/灌木是绿"
    terrainPixel(x, y) {
      return new Promise((res) => {
        const tex = game.textures.get('terrain');
        if (!tex || !tex.getSourceImage) return res(null);
        const cv = tex.getSourceImage();
        // 地形贴图左右各外扩了 BLEED，世界坐标要加上这段偏移才对得上图片像素
        const c = cv.getContext('2d').getImageData(Math.round(x) + DATA.TERRAIN.BLEED, Math.round(y), 1, 1).data;
        res({ r: c[0], g: c[1], b: c[2], a: c[3] });
      });
    },
    // 瞄准预览画了什么：预测线点数 + 有没有落点圈（F9 的验收要这两样都在）
    aimPreview() { const a = sc().aimStats; return a ? { dots: a.dots, ring: a.ring } : null; },
    pause: () => { document.getElementById('btn-pause').click(); return UI.isPaused(); },
    mute: () => { document.getElementById('btn-mute').click(); return document.getElementById('btn-mute').textContent; },
    dom() {
      const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden; };
      return {
        title: vis('title'), hud: vis('hud'), weapons: vis('weapons'), power: vis('power'),
        banner: vis('banner'), handoff: vis('handoff'), pause: vis('pause'), over: vis('over'),
        overText: document.getElementById('over-title').textContent,
        overSub: document.getElementById('over-sub').textContent,
        slots: document.querySelectorAll('#weapons .wslot').length,
        dimmed: document.querySelectorAll('#weapons .wslot.dim').length,
      };
    },
  };
});
