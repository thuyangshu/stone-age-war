// 无头 Chrome 的收尸队与静音开关——三个自建启动器共用：
// tester-cdp.mjs（8 个测试脚本的底座）、browser-smoke.mjs（smoke.sh 每次提交都跑）、bot-playtest.mjs。
//
// 起因是一次真实事故：测试中途抛错或被 Ctrl-C 打断时，各脚本末尾的清理代码根本不执行，
// 无头 Chrome 留在后台，带着放开的自动播放策略一直外放游戏 BGM，占着 20%+ CPU，
// 临时 profile 目录堆了 200MB。三处启动器各有一份清理逻辑，修一处补不了另外两处，
// 所以把兜底集中到这里。
import { rmSync } from 'node:fs';

// 静音到扬声器，但音频图照常运转：AudioContext.state 与 AnalyserNode 读数都不受影响，
// 断言"音乐真实有输出"的用例照样成立（读的是图内 meterNode，不是声卡）。
// 真要用耳朵听时 TESTER_AUDIBLE=1 放开。写错成 false/off/no 一律按静音处理——
// 这个开关一旦误判就是在人的电脑上外放，宁可失之于静。
const AUDIBLE = /^(1|true|yes|on)$/i.test(process.env.TESTER_AUDIBLE || '');
export const MUTE = AUDIBLE ? [] : ['--mute-audio'];

// 三处启动器共用的 spawn 选项。detached 让 Chrome 自成进程组，
// 这样收尸时一发信号就能带走整棵进程树（主进程 + 一堆 helper），
// 不必指望杀了主进程之后 helper 自己识相退出——那个时序不可靠，实测会偶发留下整个实例。
export const SPAWN_OPTS = { stdio: 'ignore', detached: true };

const LIVE = new Set();
let hooked = false;

// 收一个实例。手工调用（正常结束、启动失败）和退出钩子共用，幂等。
export function reapOne(inst) {
  if (!inst) return;
  LIVE.delete(inst);
  // 负 pid = 整个进程组。detached 让 Chrome 自成一组，一发就带走主进程和所有 helper。
  // 但必须先确认子进程确实还活着：它一旦被回收，pid 就可能已经轮给了别的进程，
  // 那时 kill(-pid) 不会报 ESRCH，而是把 SIGKILL 结结实实打在一个无关的进程组上——
  // 炸的是用户自己的进程。chrome.kill() 在子进程已回收后是空操作，安全性正在这里，别丢掉。
  if (inst.chrome.exitCode === null && inst.chrome.signalCode === null) {
    try { process.kill(-inst.chrome.pid, 'SIGKILL'); } catch { try { inst.chrome.kill('SIGKILL'); } catch {} }
  } else {
    try { inst.chrome.kill('SIGKILL'); } catch {}
  }
  // 即便整组都杀了，濒死的 helper 仍可能正握着 profile 里的文件，紧跟着删有概率删不净。
  // maxRetries 走的是同步重试，在 exit 钩子里合法（那里只能跑同步代码）。
  try { rmSync(inst.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
}

export function reapAll() { for (const inst of [...LIVE]) reapOne(inst); }

// 登记一个刚 spawn 出来的实例，返回句柄；正常结束时把句柄交给 reapOne 即可。
export function register(chrome, profile) {
  const inst = { chrome, profile };
  LIVE.add(inst);
  if (!hooked) {
    hooked = true;
    // 未捕获的异常与拒绝走 Node 默认路径退出，'exit' 照样触发，
    // 所以这里不注册 uncaughtException——注册了会吞掉崩溃现场，反而看不见测试的真实失败。
    process.on('exit', reapAll);
    // 注册信号处理会盖掉 Node 的默认退出行为，清理完必须自己退，否则 Ctrl-C 按了没反应。
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      process.on(sig, () => { reapAll(); process.exit(code); });
    }
  }
  return inst;
}

// 看门狗：挂死是最坏的一种泄漏——进程根本不退出（ws 句柄吊着事件循环），
// 退出钩子等的是 'exit'，于是永远等不到，浏览器就在后台一直活着。
//
// 计时的是"静默时长"而不是总耗时：测试每发一个 CDP 请求、每收到一个自己请求的回包，
// 就 ping() 重置。所以压力测试、机器人试玩这类长跑脚本只要还在推进就永远不会被掐，
// 而页面死循环、ws 断掉、await 了一个永不兑现的 promise，这些真挂死必被掐。
//
// 关键是只认"回我们请求的包"，不认页面自发的 console / 异常 / 导航事件：
// 那些只证明浏览器活着，不证明测试还在推进——而测试挂死最常见的形态恰恰是
// 页面出问题后不停报错，那时它最吵，认了就等于把看门狗架空。
// TESTER_WATCHDOG=0 关闭，或给秒数覆盖默认值。退出码 124 沿用 timeout(1) 的惯例。
export function watchdog(idleSec) {
  const sec = Number(process.env.TESTER_WATCHDOG ?? idleSec);
  if (!sec) return { ping() {}, stop() {} };
  let t = null;
  const arm = () => {
    t = setTimeout(() => {
      console.error(`\n看门狗：${sec} 秒内测试没有推进（没发出请求、也没收到回包），判定挂死，强制收尸退出`);
      reapAll();
      process.exit(124);
    }, sec * 1000);
    t.unref();   // 别让看门狗自己把进程吊住：该退出时就让它退
  };
  arm();
  return {
    ping() { t?.refresh(); },              // refresh 保持 unref 状态，不会把进程吊住
    stop() { if (t) { clearTimeout(t); t = null; } },
  };
}
