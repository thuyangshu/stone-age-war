#!/usr/bin/env bash
# 一步出素材：FLUX 生成 → 自动抠图去投影 → 带透明通道的 PNG
#
# 用法：
#   ./tools/make-asset.sh "提示词" 输出.png [--w 640 --h 896 --steps 20 --model flux_1_dev_q8p.ckpt --seed 123]
#   ./tools/make-asset.sh --check          # 检查 Draw Things API 是否在线
#
# 常用模型：
#   flux_1_dev_q8p.ckpt      精细、~88s，定稿用
#   flux_1_schnell_q8p.ckpt  快、~25s，批量试提示词用
#
# 说明：生成图先存到 /tmp，抠完只保留成品，不污染 assets/
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--check" ]; then exec node tools/gen-image.mjs --check; fi
if [ $# -lt 2 ]; then sed -n '2,12p' "$0"; exit 1; fi

PROMPT="$1"; OUT="$2"; shift 2
TMP="/tmp/gen-$$.png"

# FLUX 默认画风是"带描边+渐变的可爱卡通"，靠这组锚词强压成扁平矢量（2026-09-26 实测得出）
STYLE="flat vector illustration, solid flat color shapes only, minimalist geometric design, no outlines, no gradients, no shading, editorial vector art style, isolated on pure white background, no ground shadow"
NEG="outline, gradient, shading, drop shadow, ground shadow, 3d render, chibi, child, big head, detailed eyes, texture, watermark, text, multiple people, extra limbs, deformed"

echo "① 生成中…"
node tools/gen-image.mjs "$PROMPT, $STYLE" "$TMP" --neg "$NEG" \
  --w 640 --h 896 --steps 20 --cfg 1 --model flux_1_dev_q8p.ckpt "$@"

echo "② 抠图中…"
python3 tools/cutout.py "$TMP" "$OUT" --trim --size 512x768
rm -f "$TMP"
echo "✅ 成品：$OUT"
