"""Builds the site's icons and social card from the logo (run by hand when the
logo changes; the outputs are committed). Needs Pillow.

    python web/scripts/make-brand.py

Input:  web/brand/logo-source.png (2048x2048: the navy rounded square on white)
Output: web/public/ favicon.ico (16/32/48), favicon-32.png, apple-touch-icon.png
        (180, opaque), icon-192.png, icon-512.png, logo-64.png, og-card.png
        (1200x630).
"""
import os
from collections import deque

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
SRC = os.path.join(WEB, "brand", "logo-source.png")
OUT = os.path.join(WEB, "public")

NAVY = (34, 32, 79)        # --color-brand
GREEN = (10, 182, 135)     # --color-brand-accent


def logo_rgba() -> Image.Image:
    """The rounded square cut out of its white background, padded to a square."""
    im = Image.open(SRC).convert("RGB")
    W, H = im.size
    px = im.load()
    # Bounding box of the non-white artwork.
    xs = [x for x in range(W) if any(min(px[x, y]) < 200 for y in range(0, H, 4))]
    ys = [y for y in range(H) if any(min(px[x, y]) < 200 for x in range(0, W, 4))]
    pad = 4
    box = (max(0, xs[0] - pad), max(0, ys[0] - pad), min(W, xs[-1] + pad + 1), min(H, ys[-1] + pad + 1))
    im = im.crop(box)
    w, h = im.size
    px = im.load()
    # Background = white pixels reachable from the crop's border.
    bg = [[False] * w for _ in range(h)]
    q = deque((x, y) for x in range(w) for y in (0, h - 1)) + deque((x, y) for y in range(h) for x in (0, w - 1))
    while q:
        x, y = q.popleft()
        if not (0 <= x < w and 0 <= y < h) or bg[y][x] or min(px[x, y]) < 235:
            continue
        bg[y][x] = True
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if bg[y][x]:
                op[x, y] = (0, 0, 0, 0)
                continue
            near_bg = any(0 <= x + dx < w and 0 <= y + dy < h and bg[y + dy][x + dx] for dx in (-2, 0, 2) for dy in (-2, 0, 2))
            if near_bg:
                # Anti-aliased edge: pixel = a * navy + (1 - a) * white.
                a = max(0.0, min(1.0, (255 - r) / (255 - NAVY[0])))
                op[x, y] = (*NAVY, round(a * 255))
            else:
                op[x, y] = (r, g, b, 255)
    side = max(w, h)
    sq = Image.new("RGBA", (side, side))
    sq.paste(out, ((side - w) // 2, (side - h) // 2))
    return sq


def save(im: Image.Image, name: str, size: int) -> None:
    im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), optimize=True)


def font(size: int, bold: bool) -> ImageFont.FreeTypeFont:
    for f in (["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"]):
        for d in (r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu"):
            p = os.path.join(d, f)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    logo = logo_rgba()
    for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("logo-64.png", 64), ("favicon-32.png", 32)]:
        save(logo, name, size)
    logo.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
    # iOS shows apple-touch-icon on its own rounded tile: opaque, a little margin.
    tile = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
    small = logo.resize((156, 156), Image.LANCZOS)
    tile.alpha_composite(small, (12, 12))
    tile.convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)

    # Social card, 1200x630: logo left, name and tagline right.
    card = Image.new("RGB", (1200, 630), (255, 255, 255))
    d = ImageDraw.Draw(card)
    d.rectangle((0, 0, 1200, 12), fill=NAVY)
    d.rectangle((0, 618, 1200, 630), fill=GREEN)
    card.paste(logo.resize((300, 300), Image.LANCZOS), (90, 165), logo.resize((300, 300), Image.LANCZOS))
    d.text((440, 190), "CodeJudge", font=font(96, True), fill=NAVY)
    y = 320
    for line in ["Practise algorithms on a judge", "you can trust."]:
        d.text((444, y), line, font=font(40, False), fill=(39, 39, 42))
        y += 54
    d.text((444, y + 26), "100 original problems · 6 languages", font=font(28, False), fill=(10, 140, 105))
    card.save(os.path.join(OUT, "og-card.png"), optimize=True)
    print("wrote", sorted(os.listdir(OUT)))


main()
