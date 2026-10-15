"""Generates src-tauri/icons/* from code.   python scripts/make_icon.py"""
from pathlib import Path
from PIL import Image, ImageDraw

SS = 4
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"


def draw(size: int) -> Image.Image:
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    top, bottom = (203, 166, 247), (137, 180, 250)
    for y in range(s):
        t = y / (s - 1)
        gd.line([(0, y), (s, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.23), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    u = s / 100.0
    dark = (30, 30, 46, 255)
    w = 9 * u
    # "<" and ">" brackets with a slash
    d.line([(40 * u, 28 * u), (20 * u, 50 * u), (40 * u, 72 * u)], fill=dark, width=int(w), joint="curve")
    d.line([(60 * u, 28 * u), (80 * u, 50 * u), (60 * u, 72 * u)], fill=dark, width=int(w), joint="curve")
    d.line([(55 * u, 24 * u), (45 * u, 76 * u)], fill=dark, width=int(w * 0.8))
    for cx, cy in [(40, 28), (40, 72), (60, 28), (60, 72), (20, 50), (80, 50)]:
        d.ellipse([cx * u - w / 2, cy * u - w / 2, cx * u + w / 2, cy * u + w / 2], fill=dark)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [draw(n) for n in sizes]
    imgs[-1].save(OUT / "icon.png")
    imgs[-1].save(OUT / "icon.ico", sizes=[(n, n) for n in sizes], append_images=imgs[:-1])
    draw(32).save(OUT / "32x32.png")
    draw(128).save(OUT / "128x128.png")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
