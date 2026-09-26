#!/usr/bin/env bash
# 石器大战 · 六步冒烟闸门。任一步失败即停：
#   语法 → 单测 → 资源引用 → 无头浏览器 → 难度分布 → 单文件打包版
# 只要源码，不要 dist：第 6 步会自己重新打包（SKIP_BUNDLE=1 可跳过）
set -e
cd "$(dirname "$0")"
echo "── 1/6 语法检查 ──"
for f in js/*.js tests/*.mjs build.mjs; do node --check "$f"; done
echo "   全部 JS 语法通过"
echo "── 2/6 逻辑单测 ──"
# 不能写 `node --test ... | tail`：管道的退出码取自 tail，单测挂了闸门照样绿
unit=$(node --test tests/*.test.js 2>&1) || { echo "$unit" | tail -30; exit 1; }
echo "$unit" | tail -8
echo "── 3/6 资源引用 ──"
missing=0
for f in $(grep -o 'src="[^"]*"' index.html | sed 's/src="//;s/"//'); do
  [ -f "$f" ] || { echo "   ❌ index.html 引用了不存在的 $f"; missing=1; }
done
for id in $(grep -o "getElementById('[a-z-]*')" js/*.js | sed "s/.*('//;s/')//" | sort -u); do
  grep -q "id=\"$id\"" index.html || { echo "   ❌ js 取了不存在的元素 #$id"; missing=1; }
done
[ "$missing" = 0 ] || exit 1
echo "   引用全部存在"
echo "── 4/6 无头浏览器 ──"
node tests/browser-smoke.mjs
echo "── 5/6 难度分布 ──"
node tests/bot-playtest.mjs
if [ "${SKIP_BUNDLE}" = "1" ]; then
  echo "── 6/6 单文件打包版（已跳过）──"
else
  echo "── 6/6 单文件打包版 ──"
  node build.mjs
  # 同上：别用管道，挂了要真的挂
  bundle=$(SMOKE_PAGE="$PWD/dist/石器大战.html" node tests/browser-smoke.mjs 2>&1) \
    || { echo "$bundle" | grep -E "❌|通过|中断" ; exit 1; }
  echo "$bundle" | tail -2
fi
echo "✅ 冒烟全绿"
