#!/usr/bin/env python3
"""把「满幅方形」的品牌图变成 macOS 规范的应用图标。

为什么需要它（这个仓库真栽过的坑）：
  品牌素材（icons/icon.png / control-panel/public/dove-logo.png）是**不透明满幅方块**，
  直接拿去当 macOS 应用图标 → Dock 里就是一个比邻居大一圈的实心方块、还是直角。
  macOS 的图标网格要求：1024 画布、本体 824（四周各留 100px 透明边距）、本体带连续圆角。
  所以这里：读主图 → 缩到 824 → 套超椭圆圆角（n≈5，Apple squircle 的常用近似；
  要普通圆角就把 SQUIRCLE_N 换掉、用半径 ≈185.4 的圆角矩形）→ 放到 1024 透明画布正中
  → 输出各尺寸 PNG + .icns。

用法（需要 Pillow：python3 -m pip install Pillow）：
  python3 apps/desktop/tools/make-macos-icon.py \
      control-panel/public/dove-logo.png apps/desktop/src-tauri/icons

产物（写进 outdir）：
  32x32.png / 128x128.png / 128x128@2x.png / icon.png(=1024)
    —— 这四个就是 tauri.conf.json 的 icon 列表（Windows/Linux 也吃它们）
  icon.icns —— macOS 包用的那份；走系统 iconutil 生成（唯一能写出合法 icns 的现成工具）
"""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024        # Apple 图标画布
BODY = 824           # 本体边长（1024 - 2×100 的透明边距）
SQUIRCLE_N = 5.0     # 超椭圆指数：Apple squircle 的常用近似（普通圆角矩形≈把这条换成半径 185.4）


def squircle_mask(size: int, n: float = SQUIRCLE_N) -> Image.Image:
    """|x/a|^n + |y/a|^n = 1 的超椭圆掩膜（a = size/2，中心在画布正中）。"""
    mask = Image.new("L", (size, size), 0)
    a = size / 2
    pts = []
    steps = 720
    for i in range(steps):
        t = 2 * math.pi * i / steps
        ct, st = math.cos(t), math.sin(t)
        pts.append((
            a + a * (abs(ct) ** (2 / n)) * (1 if ct >= 0 else -1),
            a + a * (abs(st) ** (2 / n)) * (1 if st >= 0 else -1),
        ))
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    return mask


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    src, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    art = Image.open(src).convert("RGBA")
    if art.width != art.height:
        raise SystemExit(f"主图必须是正方形：{src} 是 {art.size}")
    art = art.resize((BODY, BODY), Image.LANCZOS)
    art.putalpha(squircle_mask(BODY))

    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    off = (CANVAS - BODY) // 2
    master.paste(art, (off, off), art)

    for name, size in {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": CANVAS}.items():
        master.resize((size, size), Image.LANCZOS).save(outdir / name)

    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / "icon.iconset"
        iconset.mkdir()
        for size, tag in [
            (16, "16x16"), (32, "16x16@2x"), (32, "32x32"), (64, "32x32@2x"),
            (128, "128x128"), (256, "128x128@2x"), (256, "256x256"),
            (512, "256x256@2x"), (512, "512x512"), (1024, "512x512@2x"),
        ]:
            master.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{tag}.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(outdir / "icon.icns")], check=True)

    print("写好：" + "、".join(str(outdir / n) for n in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.icns"]))


if __name__ == "__main__":
    main()
