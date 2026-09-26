// 石器大战 · 全部数值表（纯数据，浏览器与 Node 通用）
// 调平衡只改这一个文件：武器、物理、地形、AI、相机、回合节奏
const DATA = {
  TITLE: '石器大战',
  HP: 100,        // 双方满血
  HIT_R: 26,      // 角色受击半径（px，世界坐标）

  PHYS: {
    G: 900,           // 基础重力 px/s²（各武器按 gMul 缩放）
    SUB_DT: 1 / 240,  // 物理子步长（秒）：最高速弹丸单步位移 6.7px < 判定直径，不穿模
    PROJ_R: 6,        // 弹丸碰撞半径
    MAX_SPEED: 1600,  // 初速上限（子步长按此值校验）
    MAX_FRAME: 0.05,  // 单帧时间钳制：切后台回来不暴跳
    MIN_POWER: 0.12,  // 最小出手力度（防误触）
    DRAG_START: 24,   // 拖拽死区（px）：小于此距离视为取消
    DRAG_FULL: 150,   // 拖满力度所需拖距（px）
    ANGLE: [5, 85],   // 出手仰角范围（度）
    WIND_ACCEL: 26,   // 每级风的水平加速度 px/s²（P1 风恒 0 级，P2 启用）
    PREVIEW_N: 40,    // 轨迹预览采样点数
  },

  TERRAIN: {
    W: 1600, H: 1000,       // 世界逻辑尺寸
    GROUND_Y: 780,          // 基准地面高度（y 向下）
    SAMPLE: 8,              // 高度场采样间隔 → (1600/8+1)=201 点
    HILL: { count: [3, 5], amp: [40, 120], width: [260, 480], maxH: 260 },
    // flatMax：挖池塘前两岸高差上限，超过就换地方（斜坡上挖碗会淹掉一侧岸）
    POND: { chance: 0.6, w: [180, 340], depth: 70, xRange: [400, 1200], flatMax: 34 },
    BUSH: { count: [2, 5], w: 62, h: 46, margin: 80, spawnClear: 110 },
    DECO: { count: [18, 34] },   // 装饰（草/花/小石/兽骨）只记种子，渲染时同种子绘制
    SPAWN: { left: [150, 650], right: [950, 1450], gap: [500, 1200], dryMargin: 60 },
    EDGE: 40,               // 两侧边缘抬升高度，防止弹丸贴边穿出
    // 地形贴图左右各外扩 BLEED、向下外扩 BLEED_BOTTOM。桌面宽屏下世界比视野窄
    // （适配缩放被高度卡住），不外扩就会看见地形是个浮在背景上的方块，左右两条直角切口。
    // 取 500/400 是照相机 bounds（game.js setBounds(-500,-500,W+1000,H+900)）定的：
    // 外扩后贴图正好盖满 bounds，任何屏幕比例都看不到边界。
    BLEED: 500, BLEED_BOTTOM: 400,
    RETRY: 8,               // 站位/弧线校验不通过时的整体重掷次数
  },

  // 溅射：内圈满伤，边缘 25% 下限，半径外为 0 → dmg × max(0.25, 1 − 0.75×dist/r)
  SPLASH_FLOOR: 0.25,
  SPLASH_FALLOFF: 0.75,

  TURN: {
    BANNER_MS: 1100,     // 回合横幅
    IMPACT_HOLD: 900,    // 结算停留（让玩家看清伤害数字与砸痕）
    AI_AIM_MS: 500,      // AI 瞄准演出
    AI_THINK: { easy: 900, medium: 650, hard: 450 },  // 按难度覆盖
    HANDOFF: true,       // 双人模式交接遮罩
    LIMIT: 30,           // 回合软时限（秒），超时按当前力度自动发射
    TIMEOUT_POWER: 0.6,  // 超时时若玩家没在瞄，用这个力度平推一发（不让对局卡死）
  },

  CAM: { minZoom: 0.55, followSpeed: 6, overviewDelay: 600, EDGE: 60 },

  // 三档 AI：难度只由误差注入与选武策略区分，弹道解算完全共用玩家那一套
  //
  // 误差量级要按"px 散布 vs 判定半径"校，不能只看弧度。
  // 初版 hard 给到 angErr 0.0025 / powErr 0.007，看着"很准"，实测散布约 7px，
  // 而判定圈是 HIT_R 26 + 弹丸半径 —— 于是 hard 直击率 100%。
  // 双方都必中的对局就退化成纯伤害竞速：先手方永远先打出致命的那一发，
  // 实测 hard 镜像局先手胜率 98%（本该 50%），等于掷硬币决定胜负。
  //
  // 第二轮（2026-09-26，修 aiAim 的直击捷径 + 让 CONVERGE 真的生效之后）：
  // 上面那条"放宽到 0.012/0.024"的结论作废了——捷径修好后 AI 才第一次真的会瞄直击，
  // 于是量出锁定目标（同一目标第 5 发）后的单发直击率：easy 71% / medium 95% / hard 100%。
  // medium 和 hard 在实现上已不可区分，hard 对 medium 掉到 65%，A4 的 ≥75% 失守。
  //
  // 根因是**判定圈太宽**：巨石判定半径 HIT_R 26 + 弹丸 16 = 42px，
  // 而 medium 的基准误差 0.025 rad 在 1100px 距离上横向散布只有 27px——落在圈里。
  // 三档误差全在圈内，精度差换不来伤害差（溅射半径 70~150px 又会把偏差吃回去），
  // 所以要拉开档次只能把误差顶到圈**边缘**：medium 散布调到约 44px。
  // 这不是把 medium 调弱，是让它第一次成为"打得中但不保证"的中档。
  //
  // 定档结果（bot-playtest 口径，每档 200 局，按 95% 置信区间判定）：
  //   easy 打 medium 18.5%+6.9%（验收 ≤30%）　medium 镜像先手 57.5%±6.9%（验收 45~55%）
  //   hard 打 medium 84.5%−6.9%（验收 ≥75%）
  // 锁定目标后的单发直击率：easy 35% / medium 95% / hard 100%——三档终于分得开了。
  // hard 镜像的先手胜率 77%（这项没有验收线，是设计红线）：初版 98% 时对局等于掷硬币，
  // 现在留在 77%，硬碰硬仍有来有回。
  AI: {
    easy:   { angErr: 0.156, powErr: 0.180, missChance: 0.30, pickRandom: 3, greedy: 0 },
    medium: { angErr: 0.040, powErr: 0.080, missChance: 0.15, pickRandom: 0, greedy: 0.8 },
    hard:   { angErr: 0.009, powErr: 0.018, missChance: 0,   pickRandom: 0, greedy: 1 },
    FIRST_SHOT_BIAS: 2.6,  // 对全新目标的第一发误差放大倍数（给玩家观察期）
    // 对全新目标的第一发，**落点**至少离目标这么远（px）。这是硬保证，不是调概率：
    // 光放大误差做不到"必偏"（hard 首发直击率仍有 45%），光挪瞄点也不够——
    // easy 的 missChance 一口气抖 ±0.16 弧度，能把挪开的瞄点又拽回来，
    // 400 局/档实测落点偏移最小只到 34px。所以 aiAim 是"出手前拿真碰撞判一遍，
    // 不合格就继续往外推"，合格线取这个数。口径见 docs/需求与验收.md F30
    FIRST_SHOT_OFFSET: 120,
    // 每多打一发，误差乘这个系数（收敛但不会归零）。
    // 取 0.85 而不是 0.55：下限 MIN_ERR_RATIO 是 0.5，0.55 一步就撞到下限，
    // 收敛过程只剩"第 2 发"这一档，这个旋钮等于只有开和关两态。
    // 0.85 的序列是 1 → .85 → .72 → .61 → .52 → .5 → .5…，逐发收紧，
    // 才对得上"落点方差随射击收敛"这条设计原则
    CONVERGE: 0.85,
    // 收敛的下限，按**本档基准误差的比例**取，不能用一个全局弧度下限：
    // 绝对下限会让三档打到后半程收敛到同一个精度（easy 也变成 hard），难度区分就没了。
    // 取 0.5 = 每档最后都停在"自己基准误差的一半"，档间比例全程保持不变。
    MIN_ERR_RATIO: 0.5,
    // 够得着的判定阈值（px）：弹道全程离瞄点最近都到不了这个距离，就算"这武器打不到"，
    // aiChoose 会换下一件。200 局实测：正常可达时最近距离最多 42px（且那 42px 是
    // 直击命中点落在对手碰撞圈边缘，已按直击单独放行），够不着的局面则是几百到几千像素，
    // 40 落在中间的空档里。回旋镖会有一成左右被判够不着——那是真的：它 1.2 秒就折返，
    // 出程只够覆盖约 890px，比站位间距上限还短
    REACH_TOL: 40,
  },

  // 武器表：每件对应一个验证过的功能位
  // v 初速 / gMul 重力系数 / dmg 直击 / splash 溅射 / ammo 每局弹药（0=无限）
  //
  // 射程铁律（2026-09-26 修正）：满力最大射程 R = v²/(G×gMul) **必须 ≥ 1500px**
  // （站位间距上限 1200px + 余量）。初版按"轻武器快、重武器慢"直觉给的数值，
  // 导致巨石满力只飞 367px、4 件武器够不着对手，AI 只能永远退到 45° 兜底。
  // 现在射程不再承担区分度——区分度交给弹道弧度、伤害、溅射、弹药，与 Worms/坦克之星一致。
  WEAPONS: [
    { id: 'stone', name: '投石', v: 1200, gMul: 1, dmg: 14, splash: { r: 70, dmg: 6 }, ammo: 0,
      r: 7, color: 0x9AA0A6, edge: 0x6E7479,           // 射程 1600
      desc: '无限弹药，兜底与教学' },

    { id: 'spear', name: '石矛', v: 1040, gMul: 0.5, dmg: 18, splash: { r: 45, dmg: 4 }, ammo: 4,
      r: 6, color: 0x8B5A3C, edge: 0x9AA0A6, len: 34, rot: true, pierceBush: true,
      desc: '弹道平直，穿透灌木' },                     // 射程 2403

    { id: 'arrow', name: '石箭', v: 1100, gMul: 0.45, dmg: 10, splash: { r: 35, dmg: 3 }, ammo: 6,
      r: 5, color: 0x8B5A3C, edge: 0xE8E2D8, len: 30, rot: true, pierceBush: true,
      desc: '最快最平，伤害最低' },                     // 射程 2988

    { id: 'axe', name: '石斧', v: 1320, gMul: 1.25, dmg: 20, splash: { r: 95, dmg: 9 }, ammo: 3,
      r: 9, color: 0x6E7479, edge: 0x8B5A3C, spin: true,
      desc: '重弧线，大范围溅射' },                     // 射程 1549

    { id: 'sling', name: '投石索', v: 1170, gMul: 0.8, dmg: 14, splash: { r: 50, dmg: 5 }, ammo: 5,
      r: 6, color: 0x9AA0A6, edge: 0x4A342A, bounce: 1,
      desc: '落地反弹一次' },                           // 射程 1901

    { id: 'boomerang', name: '回旋镖', v: 1050, gMul: 0.7, dmg: 12, splash: null, ammo: 3,
      r: 8, color: 0x8B5A3C, edge: 0x5E3A26, spin: true, returnAt: 1.1, catchR: 34,
      desc: '去回两段，接住返还弹药' },                 // 射程 1750

    { id: 'torch', name: '火把', v: 1220, gMul: 1, dmg: 10, splash: { r: 55, dmg: 4 }, ammo: 4,
      r: 7, color: 0xE0863C, edge: 0xFFD9A0, spin: true, burn: { turns: 3, dmg: 2 },
      desc: '点燃：3 回合每回合扣 2' },                 // 射程 1653

    { id: 'boulder', name: '巨石', v: 1375, gMul: 1.4, dmg: 26, splash: { r: 150, dmg: 14 }, ammo: 2,
      r: 16, color: 0x9AA0A6, edge: 0x6E7479, spin: true,
      desc: '终极大范围' },                             // 射程 1500
  ],

  // 配色（与 docs/美术方案.md 同源）
  COLORS: {
    skyTop: 0xBFE0F0, skyBot: 0xFFD9B8,
    gTop: 0x7FA85C, gBot: 0x5E7F42,      // 草地
    dTop: 0x8B5E3C, dBot: 0x6B4530,      // 泥土
    rock: 0x9AA0A6, rockDark: 0x6E7479,
    water: 0x6FB3D0, waterDark: 0x4A8AA8,
    bushTop: 0x6E9B4E, bushBot: 0x4E7038,
    deco: 0x5E7F42,
    clay: 0xE0863C, clayD: 0xC0603B,     // 陶土橙 / 陶红：点缀色（花、脸纹），与玩家主题色分开命名
    p1: 0xE0863C, p2: 0xC0603B,          // 双方主题色
    bone: 0xFAF0E4, ink: 0x4A342A, hud: 0xFAF0E4,
  },
};

if (typeof module !== 'undefined') module.exports = DATA;
