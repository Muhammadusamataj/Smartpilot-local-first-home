#!/usr/bin/env python3
"""Generate the unique Smart Pilot launcher icon (legacy + adaptive assets).

The mark is a cyan automation flow wave on a deep-navy field with an amber
live node. It is intentionally unrelated to the orange Smart Life / Tuya
launcher art. Run after changing the palette:

    python tools/make_app_icon.py

Only Pillow is required; every density is derived from one master drawing so
the legacy and adaptive icons stay identical.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
MASTER = 1024

BG_TOP = (16, 38, 62)
BG_BOTTOM = (6, 16, 30)
CYAN = (107, 231, 242, 255)
CYAN_SOFT = (84, 197, 216, 150)
AMBER = (255, 196, 84, 255)
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
PROJECTS = (
    ROOT / "android_offline" / "app" / "src" / "main" / "res",
    ROOT / "android" / "app" / "src" / "main" / "res",
)
BACKGROUND_COLOR = "#10263E"


def _gradient(size: int) -> Image.Image:
    """Vertical two-stop gradient, built from a 1px strip for speed."""
    strip = Image.new("RGB", (1, size))
    px = strip.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
    return strip.resize((size, size), Image.Resampling.BILINEAR).convert("RGBA")


def _wave_points(size: int) -> list[tuple[float, float]]:
    """The ⌁-like flow mark: two smooth humps inside the adaptive safe zone."""
    s = size
    return [
        (0.285 * s, 0.545 * s),
        (0.350 * s, 0.395 * s),
        (0.435 * s, 0.545 * s),
        (0.520 * s, 0.395 * s),
        (0.605 * s, 0.545 * s),
        (0.700 * s, 0.420 * s),
    ]


def _draw_wave(layer: Image.Image, width_ratio: float, color: tuple[int, ...]) -> None:
    size = layer.width
    draw = ImageDraw.Draw(layer)
    points = _wave_points(size)
    width = max(1, round(size * width_ratio))
    draw.line(points, fill=color, width=width, joint="curve")
    for x, y in (points[0], points[-1]):
        r = width / 2
        draw.ellipse((x - r, y - r, x + r, y + r), fill=color)


def _foreground(size: int) -> Image.Image:
    """Transparent adaptive foreground (glyph only)."""
    s = size
    fg = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Two incomplete orbit arcs hint at an automated, always-on loop.
    orbit = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    od = ImageDraw.Draw(orbit)
    box = (0.205 * s, 0.205 * s, 0.795 * s, 0.795 * s)
    od.arc(box, start=205, end=515, fill=CYAN_SOFT, width=max(1, round(0.013 * s)))
    od.arc(box, start=25, end=155, fill=(84, 197, 216, 90), width=max(1, round(0.010 * s)))
    fg.alpha_composite(orbit)

    # Soft glow underneath the crisp wave.
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    _draw_wave(glow, 0.095, (74, 210, 235, 105))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(1, round(0.018 * s))))
    fg.alpha_composite(glow)

    wave = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    _draw_wave(wave, 0.052, CYAN)
    fg.alpha_composite(wave)

    # Amber "live/local" node at the leading end.
    ld = ImageDraw.Draw(fg)
    x, y = _wave_points(s)[-1]
    r = 0.030 * s
    ld.ellipse((x - r, y - r, x + r, y + r), fill=AMBER)
    return fg


def _mask(size: int, round_icon: bool) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    if round_icon:
        md.ellipse((0, 0, size - 1, size - 1), fill=255)
    else:
        md.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.22), fill=255)
    return mask


def generate() -> None:
    master_fg = _foreground(MASTER)
    for res in PROJECTS:
        if not res.is_dir():
            continue
        (res / "values" / "ic_launcher_background.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            "<resources>\n"
            f'    <color name="ic_launcher_background">{BACKGROUND_COLOR}</color>\n'
            "</resources>\n",
            encoding="utf-8",
        )
        for density, size in DENSITIES.items():
            folder = res / f"mipmap-{density}"
            folder.mkdir(parents=True, exist_ok=True)
            base = _gradient(size)
            fg = master_fg.resize((size, size), Image.Resampling.LANCZOS)
            for name, round_icon in (("ic_launcher.png", False), ("ic_launcher_round.png", True)):
                icon = base.copy()
                icon.alpha_composite(fg)
                icon.putalpha(_mask(size, round_icon))
                icon.convert("RGBA").save(folder / name)
        adaptive = res / "mipmap-xxxhdpi" / "ic_launcher_foreground.png"
        adaptive.parent.mkdir(parents=True, exist_ok=True)
        master_fg.resize((432, 432), Image.Resampling.LANCZOS).save(adaptive)
        print(f"+ icon assets -> {res}")


if __name__ == "__main__":
    generate()
