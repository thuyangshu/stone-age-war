// 音效：ZzFX 代码合成，零音频文件（与 survivor 同源用法）
// ZzFX 1.3 的共享音频上下文是 ZZFX.x、总音量是 ZZFX.volume（已对 vendor/zzfx.global.js 核过字段名）
const SFX = (() => {
  const presets = {
    click:    [.18, 0, 900, , .01, .03, , 2],
    throw:    [.22, .05, 420, , .02, .16, 2, 1.4, -22],            // 掷出的破空声
    fly:      [.12, .02, 700, , .05, .1, , 1, -4, , , , , 3],       // 飞行呼啸（回旋镖）
    thud:     [.3, .08, 160, , .01, .18, 4, 1.6, -18, , , , , 6],   // 砸地
    crack:    [.35, .06, 260, , .01, .22, 3, 2.2, -30, , , , , 8],  // 直击命中
    splash:   [.28, .1, 520, , .02, .3, , .8, -60, , , , , 14],     // 入水
    rustle:   [.2, .12, 1100, , .02, .16, , 1, -20, , , , , 18],    // 灌木
    bounce:   [.2, .04, 340, , .01, .12, 2, 1.8, 12, , , , , 4],    // 投石索弹跳
    catch:    [.24, 0, 660, , .02, .14, , 1.5, 40, , 880, .05],     // 回旋镖接住
    ignite:   [.26, .1, 220, .02, .12, .3, 4, 1, -8, , , , , 12],   // 火把点燃
    burn:     [.16, .15, 150, , .03, .12, 4, 1, -6, , , , , 10],    // 燃烧跳字
    breakBush:[.22, .1, 300, , .01, .14, 3, 2, -40, , , , , 10],    // 掩体被砸
    turn:     [.26, 0, 523, .01, .06, .18, , 1.2, , , 784, .07],    // 回合横幅
    win:      [.4, 0, 523, .04, .3, .45, , 1, , , 262, .12, .12],
    lose:     [.4, 0, 262, .05, .3, .5, 1, 1, -10],
    tick:     [.1, 0, 1400, , .005, .03, , 2],                      // 倒计时
  };
  const last = {};
  let enabled = true;

  // gap：同名音效的最小间隔（毫秒），免得连击时炸耳
  function play(name, gap = 0) {
    if (!enabled || typeof zzfx !== 'function') return;
    const p = presets[name];
    if (!p) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (gap && last[name] && now - last[name] < gap) return;
    last[name] = now;
    try { zzfx(...p); } catch (e) { /* 环境无音频时静默 */ }
  }

  // 音频上下文在页面加载时创建，浏览器（尤其 iOS Safari）会挂起它，
  // 必须在用户手势里 resume 才出声。返回 Promise，恢复完成后兑现
  function unlock() {
    if (typeof ZZFX !== 'undefined' && ZZFX.x && ZZFX.x.state !== 'running') return ZZFX.x.resume();
    return Promise.resolve();
  }

  function setEnabled(on) { enabled = !!on; }
  function isEnabled() { return enabled; }

  return { play, unlock, setEnabled, isEnabled };
})();
