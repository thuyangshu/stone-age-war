#!/usr/bin/env python3
"""去除 FLUX 生成图的背景与脚下投影，输出透明 PNG。

原理（2026-09-26 实测得出）：FLUX 出的白底图和它默认加的脚下椭圆投影都是**中性色**
（R≈G≈B，差值 ≤25），而角色/道具的肤色、木头、石头、骨饰全部是**暖色或冷色**
（R-B 差值 85+）。所以判据用"中性且亮"而非"接近白色"，能一次抠掉背景+投影，
且绝不误伤角色内部的浅色元素（骨饰、眼白）。

用法：
  python3 tools/cutout.py 输入.png 输出.png [选项]
选项：
  --chroma N   中性判定阈值：max(RGB)-min(RGB) ≤ N 视为中性，默认 25
  --bright N   亮度下限：min(RGB) ≥ N 视为够亮，默认 140
  --feather N  边缘羽化，默认 0（扁平风格要硬边；1 可柔化锯齿）
  --trim       裁到内容外接框（游戏精灵图建议开）
  --pad N      trim 后四周留白，默认 4
  --size WxH   等比缩放到不超过该尺寸
  --no-connect 关闭"仅抠与边缘连通区域"的约束（默认开启，保护内部中性色元素）
  --warm-chroma N   暖色投影的中性度上限，默认 60（设 0 关闭该判据）
  --warm-bright N   暖色投影的亮度下限，默认 180
"""
import sys
from PIL import Image, ImageFilter
from collections import deque

def parse_args(argv):
    if len(argv) < 3:
        print(__doc__); sys.exit(1)
    src, dst = argv[1], argv[2]
    o = {"chroma": 25, "bright": 140, "feather": 0, "trim": False,
         "pad": 4, "size": None, "connect": True,
         "warm_chroma": 60, "warm_bright": 180}
    i = 3
    while i < len(argv):
        a = argv[i]
        if a == "--chroma": o["chroma"] = int(argv[i+1]); i += 2
        elif a == "--bright": o["bright"] = int(argv[i+1]); i += 2
        elif a == "--feather": o["feather"] = int(argv[i+1]); i += 2
        elif a == "--pad": o["pad"] = int(argv[i+1]); i += 2
        elif a == "--trim": o["trim"] = True; i += 1
        elif a == "--no-connect": o["connect"] = False; i += 1
        elif a == "--warm-chroma": o["warm_chroma"] = int(argv[i+1]); i += 2
        elif a == "--warm-bright": o["warm_bright"] = int(argv[i+1]); i += 2
        elif a == "--size":
            w, h = argv[i+1].lower().split("x"); o["size"] = (int(w), int(h)); i += 2
        else:
            print("未知选项:", a); sys.exit(1)
    return src, dst, o

def is_bg(p, chroma, bright, warm_chroma, warm_bright):
    """判据一：中性且亮（白底 + 中性灰投影，dev 模型典型）
       判据二：极亮且低中性度（暖奶白投影，schnell 模型典型）
    两道判据都只能抠"与画布边缘连通"的像素，所以角色内部的浅色元素（骨饰、浅色衣料）
    只要被角色自身的深色边缘包住，就不会被误伤。"""
    r, g, b = p[0], p[1], p[2]
    c = max(r, g, b) - min(r, g, b)
    m = min(r, g, b)
    if c <= chroma and m >= bright:
        return True
    if warm_chroma > 0 and c <= warm_chroma and m >= warm_bright:
        return True
    return False

def cutout(img, o):
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    chroma, bright = o["chroma"], o["bright"]
    wc, wb = o["warm_chroma"], o["warm_bright"]

    if not o["connect"]:
        # 不要求连通：全图直接判（快，但会误伤内部中性色元素）
        for y in range(h):
            for x in range(w):
                if is_bg(px[x, y], chroma, bright, wc, wb):
                    px[x, y] = (255, 255, 255, 0)
        return img

    # 从四边泛洪，只抠与画布边缘连通的背景/投影区域
    visited = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not visited[y*w+x] and is_bg(px[x, y], chroma, bright, wc, wb):
                visited[y*w+x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not visited[y*w+x] and is_bg(px[x, y], chroma, bright, wc, wb):
                visited[y*w+x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (255, 255, 255, 0)
        for dx, dy in ((1,0), (-1,0), (0,1), (0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny*w+nx] and is_bg(px[nx, ny], chroma, bright, wc, wb):
                visited[ny*w+nx] = 1; q.append((nx, ny))
    return img

def main():
    src, dst, o = parse_args(sys.argv)
    img = Image.open(src).convert("RGBA")
    before = img.size
    img = cutout(img, o)
    if o["feather"] > 0:
        a = img.getchannel("A").filter(ImageFilter.GaussianBlur(o["feather"] * 0.5))
        img.putalpha(a)
    if o["trim"]:
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)
            p = o["pad"]
            canvas = Image.new("RGBA", (img.width + p*2, img.height + p*2), (0, 0, 0, 0))
            canvas.paste(img, (p, p))
            img = canvas
    if o["size"]:
        img.thumbnail(o["size"], Image.LANCZOS)
    img.save(dst)
    alpha = img.getchannel("A")
    transparent = sum(alpha.histogram()[:10])
    total = img.width * img.height
    print(f"✅ {dst}  {before[0]}x{before[1]} → {img.width}x{img.height}  透明 {transparent*100//max(total,1)}%")

if __name__ == "__main__":
    main()
