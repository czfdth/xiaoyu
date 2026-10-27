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


def template_desk(d, W, H, pal, rnd):
    """Offline illustration: a fully clothed whale maid drawing beside a sunset window."""
    def box(values):
        return [v * (W if i % 2 == 0 else H) / 1000 for i, v in enumerate(values)]
    def pts(values):
        return [(x * W / 1000, y * H / 1000) for x, y in values]
    line = (49, 65, 101)
    blue = (76, 133, 196)
    light = (137, 193, 232)
    white = (249, 249, 240)
    skin = (255, 224, 201)
    stroke = max(2, W // 250)
    d.rectangle([0, 0, W, H], fill=(247, 240, 224))
    d.rounded_rectangle(box([68, 160, 405, 615]), radius=W // 35, fill=(224, 209, 186))
    for y in range(180, 585):
        t = (y - 180) / 405
        color = tuple(int(a * (1 - t) + b * t) for a, b in zip((137, 158, 202), (255, 179, 140)))
        d.line(box([90, y, 385, y]), fill=color, width=max(1, H // 400))
    d.ellipse(box([180, 350, 300, 470]), fill=(255, 222, 160))
    for x, y, r in [(110, 510, 150), (240, 530, 150), (315, 500, 120)]:
        d.ellipse(box([x-r, y, x+r, y+140]), fill=(117, 141, 171))
    d.rectangle(box([77, 575, 405, 625]), fill=(226, 214, 192))
    d.rectangle(box([230, 177, 242, 590]), fill=white)
    d.rectangle(box([85, 365, 388, 375]), fill=white)
    d.rounded_rectangle(box([83, 176, 390, 592]), radius=W // 60, outline=line, width=stroke)
    # Long blue hair and a recognisable whale tail behind the desk.
    d.rounded_rectangle(box([425, 285, 715, 780]), radius=W // 8, fill=blue, outline=line, width=stroke)
    d.polygon(pts([(660, 745), (810, 650), (885, 620), (856, 700), (935, 745), (844, 764), (777, 711), (715, 791)]), fill=light, outline=line)
    d.line(pts([(685, 753), (802, 700), (846, 733)]), fill=blue, width=stroke)
    # Closed-neck dress and apron, partly behind the table.
    d.rounded_rectangle(box([450, 525, 700, 825]), radius=W // 18, fill=(44, 74, 121), outline=line, width=stroke)
    d.polygon(pts([(495, 536), (639, 536), (663, 792), (477, 792)]), fill=white, outline=line)
    d.ellipse(box([490, 516, 638, 559]), fill=white, outline=line, width=stroke)
    d.polygon(pts([(558, 554), (527, 540), (525, 577), (558, 568), (590, 581), (591, 540)]), fill=blue, outline=line)
    # Face, fringe, fin ears and white maid headband.
    d.ellipse(box([451, 310, 681, 543]), fill=skin, outline=line, width=stroke)
    d.polygon(pts([(453, 379), (402, 339), (413, 417), (458, 438)]), fill=light, outline=line)
    d.polygon(pts([(680, 385), (733, 346), (715, 425), (679, 437)]), fill=light, outline=line)
    d.pieslice(box([434, 277, 697, 465]), 175, 355, fill=light, outline=line, width=stroke)
    d.polygon(pts([(458, 349), (492, 429), (518, 343), (553, 411), (583, 337), (620, 422), (657, 349)]), fill=light)
    for x, y in [(465, 323), (492, 301), (526, 288), (562, 283), (601, 287), (635, 301), (665, 321)]:
        d.ellipse(box([x-17, y-15, x+17, y+15]), fill=white, outline=line, width=max(1, stroke//2))
    d.line(pts([(563, 282), (572, 248), (546, 230)]), fill=blue, width=stroke+2)
    d.polygon(pts([(658, 322), (696, 302), (707, 346), (666, 336), (642, 357), (628, 319)]), fill=(60, 107, 175), outline=line)
    for x in (514, 606):
        d.arc(box([x-22, 418, x+20, 451]), 185, 352, fill=line, width=stroke)
        d.ellipse(box([x-9, 427, x+9, 458]), fill=(44, 77, 124))
        d.ellipse(box([x-6, 430, x, 438]), fill=white)
    d.arc(box([548, 475, 579, 490]), 5, 165, fill=line, width=max(2, stroke//2))
    for x in (486, 631):
        d.ellipse(box([x-15, 464, x+15, 475]), fill=(245, 171, 163))
    # Sleeves, hand and pen.
    d.rounded_rectangle(box([420, 569, 500, 703]), radius=W//30, fill=white, outline=line, width=stroke)
    d.rounded_rectangle(box([641, 570, 719, 707]), radius=W//30, fill=white, outline=line, width=stroke)
    d.ellipse(box([618, 643, 694, 709]), fill=skin, outline=line, width=stroke)
    d.line(pts([(635, 620), (673, 738)]), fill=(40, 59, 94), width=stroke+2)
    d.ellipse(box([633, 662, 670, 699]), fill=skin, outline=line, width=max(1, stroke//2))
    # Foreground table, open book, quiet cup and tiny whale drawing.
    d.rounded_rectangle(box([55, 710, 949, 920]), radius=W//35, fill=(193, 151, 116), outline=line, width=stroke)
    d.line(box([80, 755, 919, 755]), fill=(221, 183, 142), width=stroke)
    d.polygon(pts([(358, 756), (526, 730), (555, 751), (739, 752), (716, 864), (550, 854), (374, 879)]), fill=white, outline=line)
    d.line(pts([(555, 753), (550, 851)]), fill=(166, 176, 182), width=max(2, stroke//2))
    for i in range(4):
        d.line(pts([(394, 787+i*17), (506, 772+i*17)]), fill=(193, 203, 205), width=max(1, stroke//2))
    d.ellipse(box([591, 787, 667, 827]), fill=light, outline=line, width=max(1, stroke//2))
    d.polygon(pts([(660, 806), (689, 784), (685, 814), (696, 834), (663, 822)]), fill=blue, outline=line)
    d.ellipse(box([606, 799, 613, 806]), fill=line)
    d.rounded_rectangle(box([178, 744, 261, 835]), radius=W//50, fill=(251, 247, 230), outline=line, width=stroke)
    d.arc(box([241, 755, 292, 819]), 265, 90, fill=line, width=stroke)
    for _ in range(12):
        x, y = rnd.randint(90, 930), rnd.randint(895, 968)
        d.ellipse(box([x, y, x+2, y+2]), fill=(221, 198, 169))


TEMPLATES = {
    "two_fish": template_two_fish,
    "whale": template_whale,
    "house": template_house,
    "heart": template_heart,
    "cat": template_cat,
    "moon": template_moon,
    "desk": template_desk,
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
