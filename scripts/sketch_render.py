# -*- coding: utf-8 -*-
"""手绘风小画生成器：几何形状 + 中文标题，像小孩画的。

用法:
  python sketch_render.py --template two_fish --caption "爸爸和我" --out C:\path\a.png
模板: two_fish / whale / house / heart / cat / moon
"""
import argparse
import math
import os
import random

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
]

PALETTES = {
    "night": {"bg": (18, 32, 74), "fg": (250, 250, 252), "a": (70, 120, 220), "b": (150, 205, 250), "line": (250, 250, 252)},
    "paper": {"bg": (252, 250, 244), "fg": (60, 60, 66), "a": (90, 140, 230), "b": (170, 215, 250), "line": (70, 70, 76)},
    "warm": {"bg": (255, 246, 238), "fg": (120, 70, 50), "a": (240, 160, 120), "b": (255, 205, 170), "line": (150, 90, 70)},
}


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_fish(d, x, y, size, color, outline, flip=False):
    r = size // 2
    s = -1 if flip else 1
    d.ellipse([x - r, y - r * 0.7, x + r, y + r * 0.7], fill=color, outline=outline, width=3)
    tail = [(x + s * r * 0.92, y), (x + s * r * 1.7, y - r * 0.55), (x + s * r * 1.7, y + r * 0.55)]
    d.polygon(tail, fill=color, outline=outline)
    d.ellipse([x - s * r * 0.45 - r * 0.12, y - r * 0.28, x - s * r * 0.45 + r * 0.12, y - r * 0.04], fill=outline)


def template_two_fish(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    for _ in range(18):
        bx, by, br = rnd.randint(30, W - 30), rnd.randint(24, H - 60), rnd.randint(3, 9)
        d.ellipse([bx - br, by - br, bx + br, by + br], outline=pal["fg"], width=2)
    draw_fish(d, int(W * 0.40), int(H * 0.58), int(W * 0.30), pal["a"], pal["fg"])
    draw_fish(d, int(W * 0.70), int(H * 0.70), int(W * 0.15), pal["b"], pal["fg"])


def template_whale(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    cx, cy, rw, rh = int(W * 0.48), int(H * 0.62), int(W * 0.32), int(W * 0.20)
    d.ellipse([cx - rw, cy - rh, cx + rw, cy + rh], fill=pal["a"], outline=pal["fg"], width=3)
    d.polygon([(cx + rw * 0.85, cy), (cx + rw * 1.5, cy - rh * 0.7), (cx + rw * 1.5, cy + rh * 0.7)], fill=pal["a"], outline=pal["fg"])
    d.ellipse([cx - rw * 0.55, cy - rh * 0.25, cx - rw * 0.35, cy], fill=pal["fg"])
    for i, off in enumerate([0, 14, -10]):
        x = cx - rw * 0.1 + off
        d.arc([x - 14, cy - rh - 34 - i * 8, x + 14, cy - rh + 6], 200, 340, fill=pal["fg"], width=3)


def template_house(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    d.ellipse([W * 0.66, H * 0.14, W * 0.86, H * 0.34], fill=pal["b"], outline=pal["fg"], width=3)
    d.rectangle([W * 0.22, H * 0.46, W * 0.62, H * 0.78], fill=pal["a"], outline=pal["fg"], width=3)
    d.polygon([(W * 0.16, H * 0.46), (W * 0.42, H * 0.26), (W * 0.68, H * 0.46)], fill=pal["a"], outline=pal["fg"])
    d.rectangle([W * 0.30, H * 0.56, W * 0.38, H * 0.66], fill=pal["bg"], outline=pal["fg"], width=2)
    d.rectangle([W * 0.46, H * 0.56, W * 0.56, H * 0.78], fill=pal["b"], outline=pal["fg"], width=2)
    d.line([W * 0, H * 0.80, W, H * 0.80], fill=pal["fg"], width=3)


def template_heart(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    cx, cy, s = W / 2, H * 0.56, W * 0.30
    pts = []
    for i in range(120):
        t = 2 * math.pi * i / 120
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * s / 16, cy - y * s / 16))
    d.polygon(pts, fill=pal["a"], outline=pal["fg"])


def template_cat(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    cx, cy, r = W * 0.46, H * 0.56, W * 0.20
    d.polygon([(cx - r, cy - r * 0.6), (cx - r * 0.7, cy - r * 1.5), (cx - r * 0.2, cy - r * 0.95)], fill=pal["a"], outline=pal["fg"])
    d.polygon([(cx + r, cy - r * 0.6), (cx + r * 0.7, cy - r * 1.5), (cx + r * 0.2, cy - r * 0.95)], fill=pal["a"], outline=pal["fg"])
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=pal["a"], outline=pal["fg"], width=3)
    for dx in (-r * 0.35, r * 0.35):
        d.ellipse([cx + dx - r * 0.1, cy - r * 0.15, cx + dx + r * 0.1, cy + r * 0.05], fill=pal["fg"])
    d.arc([cx - r * 0.2, cy + r * 0.1, cx + r * 0.2, cy + r * 0.4], 20, 160, fill=pal["fg"], width=3)


def template_moon(d, W, H, pal, rnd):
    d.rounded_rectangle([0, 0, W, H], radius=0, fill=pal["bg"])
    for _ in range(26):
        sx, sy = rnd.randint(20, W - 20), rnd.randint(20, int(H * 0.75))
        d.ellipse([sx - 2, sy - 2, sx + 2, sy + 2], fill=pal["fg"])
    d.ellipse([W * 0.55, H * 0.16, W * 0.86, H * 0.47], fill=pal["b"])
    d.ellipse([W * 0.62, H * 0.12, W * 0.93, H * 0.43], fill=pal["bg"])


TEMPLATES = {
    "two_fish": template_two_fish,
    "whale": template_whale,
    "house": template_house,
    "heart": template_heart,
    "cat": template_cat,
    "moon": template_moon,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", default="two_fish", choices=sorted(TEMPLATES))
    ap.add_argument("--caption", default="")
    ap.add_argument("--palette", default="night", choices=sorted(PALETTES))
    ap.add_argument("--size", type=int, default=900)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rnd = random.Random(args.seed or random.randint(0, 10**6))
    pal = PALETTES[args.palette]
    W = H = args.size
    img = Image.new("RGB", (W, H), pal["bg"])
    d = ImageDraw.Draw(img)
    TEMPLATES[args.template](d, W, H, pal, rnd)

    if args.caption:
        font = load_font(int(W * 0.075))
        bbox = d.textbbox((0, 0), args.caption, font=font)
        tw = bbox[2] - bbox[0]
        d.text(((W - tw) / 2, H * 0.10), args.caption, font=font, fill=pal["fg"])

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    img.save(args.out, "PNG")
    print(args.out)


if __name__ == "__main__":
    main()
