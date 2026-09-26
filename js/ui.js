// DOM 叠层与流程状态机：标题 → 选模式/难度 → 对战 → 交接 → 结算
// 只做界面与输入接管，规则一律问 BattleScene / LOGIC
const UI = (() => {
  const $ = (id) => document.getElementById(id);
  let game = null;
  let mode = 'solo';
  let level = 'medium';
  let muted = false;
  let paused = false;
  let slots = [];
  let lastSec = -1;

  const scene = () => (game ? game.scene.getScene('battle') : null);
  const S = () => { const sc = scene(); return sc && sc.s ? sc.s : null; };

  function show(id) { const el = $(id); if (el) el.hidden = false; }
  function hide(id) { const el = $(id); if (el) el.hidden = true; }

  // ---------------- 初始化 ----------------
  function init(g) {
    game = g;
    buildWeaponBar();
    wire();
    $('diff').hidden = false;
    hide('hud'); hide('weapons'); hide('power'); hide('banner');
    hide('handoff'); hide('pause'); hide('over');
    show('title');
    updateRotateHint();
    window.addEventListener('resize', () => { updateRotateHint(); const sc = scene(); if (sc && sc.s) sc.layout(); });
    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', () => { updateRotateHint(); });
    }
    // 切后台回来不暴跳：直接暂停（MAX_FRAME 已是第二道保险）
    document.addEventListener('visibilitychange', () => { if (document.hidden && !paused && S()) doPause(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S()) (paused ? doResume() : doPause()); });
  }

  function buildWeaponBar() {
    const bar = $('weapons');
    bar.innerHTML = '';
    slots = DATA.WEAPONS.map((wp) => {
      const b = document.createElement('button');
      b.className = 'wslot';
      b.type = 'button';
      b.title = wp.name + '：' + wp.desc;
      const cv = TEX.weaponIcon(wp, 80);
      cv.setAttribute('aria-hidden', 'true');
      const nm = document.createElement('span');
      nm.className = 'wname'; nm.textContent = wp.name;
      const am = document.createElement('span');
      am.className = 'ammo';
      b.append(cv, nm, am);
      b.addEventListener('click', () => {
        const sc = scene();
        if (sc && sc.pickWeapon(wp.id)) syncWeapon();
      });
      bar.appendChild(b);
      return { el: b, ammoEl: am, wp };
    });
  }

  function wire() {
    $('btn-solo').addEventListener('click', () => { mode = 'solo'; start(); });
    $('btn-duo').addEventListener('click', () => { mode = 'duo'; start(); });
    for (const b of document.querySelectorAll('#diff .lv')) {
      b.addEventListener('click', () => {
        level = b.dataset.lv;
        for (const o of document.querySelectorAll('#diff .lv')) o.classList.toggle('on', o === b);
      });
    }
    $('btn-handoff').addEventListener('click', () => {
      hide('handoff');
      const sc = scene(); if (sc) sc.resumeTurn();
    });
    $('btn-resume').addEventListener('click', doResume);
    $('btn-restart').addEventListener('click', () => { hide('pause'); paused = false; start(); });
    $('btn-quit').addEventListener('click', toTitle);
    $('btn-again').addEventListener('click', () => { hide('over'); start(); });
    $('btn-home').addEventListener('click', toTitle);
    $('btn-pause').addEventListener('click', doPause);
    $('btn-mute').addEventListener('click', toggleMute);
  }

  function updateRotateHint() {
    const portraitPhone = window.innerHeight > window.innerWidth && window.innerWidth < 560;
    const el = $('rotate');
    if (el) el.hidden = !portraitPhone;
  }

  // ---------------- 开局 ----------------
  function start() {
    hide('title'); hide('over'); hide('handoff'); hide('pause');
    paused = false;
    SFX.unlock();
    hide('weapons');
    show('hud');
    show('weapons');
    const sc = scene();
    if (!sc) return;
    if (sc.sys.isPaused()) sc.sys.resume();
    sc.startBattle(mode, level);
  }

  function toTitle() {
    hide('over'); hide('pause'); hide('handoff');
    hide('hud'); hide('weapons'); hide('power'); hide('foe');
    show('title');
    paused = false;
    const sc = scene();
    if (sc && sc.sys.isPaused()) sc.sys.resume();
    if (sc) { sc.s = null; sc.children.removeAll(true); }
  }

  // 场景搭好地形与角色后回调
  function onBattleReady() {
    syncHp();
    syncWeapon();
    $('turnsub').textContent = mode === 'duo' ? '本地双人' : '人机 · ' + ({ easy: '轻松', medium: '普通', hard: '硬核' }[level] || '普通');
  }

  function onTurnStart(turn, human) {
    syncHp(); syncWeapon();
    $('turnlabel').textContent = (mode === 'duo' ? '玩家' + (turn === 0 ? '一' : '二') : (turn === 0 ? '你' : '对手'));
    if (human) { $('turnsub').textContent = '拖拽瞄准'; lastSec = -1; }
    else { $('turnsub').textContent = '对手思考中…'; }
    banner((mode === 'duo' ? '玩家' + (turn === 0 ? '一' : '二') : (turn === 0 ? '你的回合' : '对手回合')));
  }

  function setPhase(phase) {
    if (phase === 'handoff') {
      const s = S();
      $('handoff-who').textContent = '轮到' + (s && s.turn === 0 ? '玩家一' : '玩家二');
      show('handoff');
    } else if (phase === 'fly') {
      $('turnsub').textContent = '飞行中…';
    }
  }

  // ---------------- 血条与武器 ----------------
  function syncHp() {
    const s = S();
    if (!s) return;
    s.players.forEach((p, i) => {
      const card = $('p' + i + 'card');
      if (!card) return;
      const fill = card.querySelector('.hpfill');
      const pct = Math.max(0, Math.min(1, p.hp / DATA.HP));
      fill.style.width = (pct * 100) + '%';
      fill.classList.toggle('low', pct <= 0.34);
      const burn = card.querySelector('.burn');
      if (burn) burn.hidden = !p.burn;
    });
  }

  function syncWeapon() {
    const s = S();
    if (!s) return;
    const ammo = s.players[s.turn].ammo;
    const canPick = s.phase === 'aim' && scene().isHuman();
    for (const sl of slots) {
      const n = ammo[sl.wp.id];
      const inf = !Number.isFinite(n);
      sl.ammoEl.textContent = inf ? '∞' : String(n);
      sl.ammoEl.style.visibility = inf ? 'hidden' : 'visible';
      sl.el.classList.toggle('dim', !(n > 0));
      const on = !!s.weapon && s.weapon.id === sl.wp.id;
      sl.el.classList.toggle('on', on);
      sl.el.disabled = !canPick || !(n > 0);
      // 手机上武器栏要横向滚，选中的那件可能整格在屏外——玩家看不到自己拿的是什么。
      // 回合开始会自动预选投石（第一件），正好是最左边那格，必中这个坑。
      if (on) scrollSlotIntoView(sl.el);
    }
  }

  function scrollSlotIntoView(el) {
    const bar = el.parentElement;
    if (!bar || bar.scrollWidth <= bar.clientWidth) return;
    const left = el.offsetLeft, right = left + el.offsetWidth;
    if (left < bar.scrollLeft) bar.scrollLeft = left - 8;
    else if (right > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = right - bar.clientWidth + 8;
  }

  // 对手跑出视野时贴边指个方向。手机竖屏一屏只装得下世界宽度的四成，
  // 相机又跟在射手身上，不指一下就是对着看不见的目标盲投。
  // 每帧都会被调，所以只在值真变了才写 DOM，否则一秒钟六十次样式重算
  let foeKey = '', foeShown = false;
  function updateFoeHint() {
    const el = $('foe');
    if (!el) return;
    const s = S(), sc = scene();
    const cam = sc && sc.s ? sc.cameras.main : null;
    // 只在轮到自己出手时指方向。人机模式里轮到 AI 时，1-turn 那一方是"玩家自己"，
    // 照着指就会打出"对手 →"去指玩家本人——一个只为"我该往哪打"存在的东西，
    // 在不用我打的时候本来也不该出现
    if (!s || !cam || s.winner !== null || paused || s.phase === 'handoff' || s.phase === 'over'
        || !sc.isHuman()) {
      if (foeShown) { el.hidden = true; foeShown = false; }
      return;
    }
    const W = window.innerWidth, H = window.innerHeight;
    const foe = s.players[1 - s.turn];
    const sx = (foe.x - cam.worldView.x) * cam.zoom;
    const sy = (foe.y - 70 - cam.worldView.y) * cam.zoom;
    // 留边：上下各有顶栏和武器栏，指到那儿等于没有
    const mx = 58, top = 100, bot = H - 148;
    if (sx > mx && sx < W - mx && sy > top && sy < bot) {
      if (foeShown) { el.hidden = true; foeShown = false; }
      return;
    }
    const x = Math.round(Math.max(mx, Math.min(W - mx, sx)));
    const y = Math.round(Math.max(top, Math.min(bot, sy)));
    const who = mode === 'duo' ? '玩家' + (1 - s.turn === 0 ? '一' : '二') : '对手';
    // 箭头挂在外侧（贴哪边就往哪边指），不写成"→ 对手 →"
    const txt = sx < mx ? '← ' + who : (sx > W - mx ? who + ' →' : who);
    const key = x + ',' + y + ',' + txt;
    if (key !== foeKey) {
      foeKey = key;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.textContent = txt;
    }
    if (!foeShown) { el.hidden = false; foeShown = true; }
  }

  function syncTimer(sec) {
    if (sec === lastSec) return;
    lastSec = sec;
    const s = S();
    if (!s || s.phase !== 'aim') return;
    $('turnsub').textContent = '拖拽瞄准 · ' + sec + 's';
    if (sec <= 5 && sec > 0) SFX.play('tick', 800);
  }

  function showPower(on, power = 0) {
    const el = $('power');
    if (!on) { el.hidden = true; return; }
    el.hidden = false;
    el.querySelector('.pw-fill').style.width = (power * 100).toFixed(0) + '%';
    el.querySelector('.pw-num').textContent = Math.round(power * 100) + '%';
    $('turnsub').textContent = '松手投掷';
  }

  function banner(text) {
    const el = $('banner');
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, DATA.TURN.BANNER_MS);
  }

  // ---------------- 结算 / 暂停 ----------------
  function showOver(winner) {
    const s = S();
    $('over-title').textContent = mode === 'duo'
      ? '玩家' + (winner === 0 ? '一' : '二') + ' 获胜'
      : (winner === 0 ? '你赢了' : '你输了');
    const w = s ? s.players[winner] : null;
    const l = s ? s.players[1 - winner] : null;
    $('over-sub').textContent = w && l ? `剩余血量 ${Math.max(0, Math.round(w.hp))} 对 ${Math.max(0, Math.round(l.hp))}` : '';
    show('over');
    hide('power'); hide('foe');
  }

  function doPause() {
    if (paused) return;
    paused = true;
    const sc = scene();
    if (sc && sc.s) sc.s.paused = true;
    if (sc) sc.scene.pause();
    show('pause');
  }

  function doResume() {
    if (!paused) return;
    paused = false;
    hide('pause');
    const sc = scene();
    if (sc) { sc.scene.resume(); if (sc.s) sc.s.paused = false; }
  }

  function toggleMute() {
    muted = !muted;
    SFX.setEnabled(!muted);
    $('btn-mute').textContent = muted ? '🔇' : '🔊';
  }

  return {
    init, start, onBattleReady, onTurnStart, setPhase, syncHp, syncWeapon, syncTimer,
    showPower, showOver, banner, updateFoeHint,
    mode: () => mode, level: () => level, isPaused: () => paused,
  };
})();
