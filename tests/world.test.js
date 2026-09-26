// 地形生成、碰撞查询、站位与地图可达性
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/data.js');
const W = require('../js/world.js');
const L = require('../js/logic.js');

test('地形生成可复现：同种子完全一致，不同种子基本不同', () => {
  const a = W.genTerrain(123), b = W.genTerrain(123);
  assert.deepEqual(Array.from(a.h), Array.from(b.h));
  assert.deepEqual(a.spawns, b.spawns);
  let differ = 0;
  for (let s = 1; s <= 20; s++) {
    const x = W.genTerrain(s), y = W.genTerrain(s + 1000);
    if (Array.from(x.h).some((v, i) => v !== y.h[i])) differ++;
  }
  assert.ok(differ >= 18, `不同种子应产生不同地形，实际 ${differ}/20`);
});

test('地表连续：相邻采样点不出现断崖（< 24px）', () => {
  for (let s = 1; s <= 40; s++) {
    const w = W.genTerrain(s);
    for (let i = 0; i < W.N - 1; i++) {
      const d = Math.abs(w.h[i + 1] - w.h[i]);
      assert.ok(d < 24, `种子 ${s} 第 ${i} 点跳变 ${d.toFixed(1)}px`);
    }
    for (let i = 0; i < W.N; i++) {
      assert.ok(Number.isFinite(w.h[i]), `种子 ${s} 第 ${i} 点非有限值`);
    }
  }
});

test('池塘：水面平直、两端有岸、地表在水面之下', () => {
  let seen = 0;
  for (let s = 1; s <= 60; s++) {
    const w = W.genTerrain(s);
    for (const p of w.ponds) {
      seen++;
      // 两端（岸）必须高于水面
      assert.ok(W.surfaceAt(w, p.x0 - 2) < p.y, `种子 ${s} 左岸没露出水面`);
      assert.ok(W.surfaceAt(w, p.x1 + 2) < p.y, `种子 ${s} 右岸没露出水面`);
      // 中间必须低于水面（是"挖"出来的，不是平的）
      assert.ok(W.surfaceAt(w, (p.x0 + p.x1) / 2) > p.y, `种子 ${s} 池塘没挖下去`);
    }
  }
  assert.ok(seen > 10, `60 个种子里只出现 ${seen} 个池塘，取样太少`);
});

test('站位：在各自半区、干燥、间距合规、彼此不同', () => {
  const S = D.TERRAIN.SPAWN;
  for (let s = 1; s <= 60; s++) {
    const w = W.genTerrain(s);
    const [a, b] = w.spawns;
    assert.ok(a && b, `种子 ${s} 没有站位`);
    assert.ok(a.x >= S.left[0] && a.x <= S.left[1], `种子 ${s} 左侧站位越界 ${a.x}`);
    assert.ok(b.x >= S.right[0] && b.x <= S.right[1], `种子 ${s} 右侧站位越界 ${b.x}`);
    const gap = b.x - a.x;
    assert.ok(gap >= S.gap[0] && gap <= S.gap[1], `种子 ${s} 间距 ${gap.toFixed(0)} 越界`);
    // 干燥：不在池塘里
    for (const p of [a, b]) {
      const pond = W.pondAt(w, p.x);
      if (pond) assert.ok(W.surfaceAt(w, p.x) < pond.y - 4, `种子 ${s} 站位落在水里`);
    }
  }
});

test('回归：灌木不生成在射手头上（曾导致 78% 的射击被自家掩体挡下）', () => {
  for (let s = 1; s <= 80; s++) {
    const w = W.genTerrain(s);
    for (const bush of w.bushes) {
      const cx = bush.x + bush.w / 2;
      for (const sp of w.spawns) {
        assert.ok(Math.abs(sp.x - cx) >= D.TERRAIN.BUSH.spawnClear,
          `种子 ${s} 灌木中心 ${cx.toFixed(0)} 距站位 ${sp.x.toFixed(0)} 过近`);
      }
    }
  }
});

test('回归：地图必须双向可达（否则对局卡死，任你什么角度都够不着）', () => {
  let fallback = 0;
  // 100 张：文档 F3 的验收口径就是"100 张地形全过可达性校验"，
  // 用例数是 40 的话那句验收写的就是假的（审计 G-1）
  for (let s = 1; s <= 100; s++) {
    const w = L.newBattle(s);
    const [a, b] = w.spawns;
    if (w.spawnFallback) fallback++;
    const stone = D.WEAPONS[0];                 // 投石：无限弹药的兜底武器
    assert.ok(L.reachable(w, a, b, stone), `种子 ${s} 左打不到右`);
    assert.ok(L.reachable(w, b, a, stone), `种子 ${s} 右打不到左`);
  }
  assert.equal(fallback, 0, `有 ${fallback}/40 张地图退到了兜底站位，说明校验过严或地形太极端`);
});

test('线段求交：能分辨地面 / 水面 / 灌木，且不把天空判成出界', () => {
  const w = W.genTerrain(5);
  // 从天而降打到地面
  const g = W.segHit(w, 300, -500, 300, 2000);
  assert.equal(g.type, 'ground');
  // 世界顶部之上不是出界（高抛弧线常飞到画面上方）
  assert.equal(W.segHit(w, 300, 100, 300, -400), null, '向上飞不应判出界');
  // 横向飞出世界才是出界
  assert.equal(W.segHit(w, 1500, 200, 1800, 200).type, 'out');
  assert.equal(W.segHit(w, 100, 200, -100, 200).type, 'out');
});

test('surfaceAt 与高度场一致，世界之外不返回 NaN', () => {
  const w = W.genTerrain(11);
  for (let x = 0; x <= D.TERRAIN.W; x += 37) {
    const y = W.surfaceAt(w, x);
    assert.ok(Number.isFinite(y) && y > 0 && y < D.TERRAIN.H, `x=${x} → y=${y}`);
  }
  assert.equal(W.surfaceAt(w, -50), D.TERRAIN.H);
  assert.equal(W.surfaceAt(w, D.TERRAIN.W + 50), D.TERRAIN.H);
});
