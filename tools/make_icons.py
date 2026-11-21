#!/usr/bin/env python3
"""Generate the app icon used by the web UI, Windows EXE and Android APKs.

The source of truth is tuya_local_key/icon.png (128x128, as expected by the
packaging tests). Android launcher icons are rendered from the same design at
the standard densities, plus an adaptive foreground for Android 8+.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ANDROID_PROJECTS = (ROOT / "android", ROOT / "android_offline")

START = (37, 99, 235)   # indigo-600
END = (109, 40, 217)    # violet-700
WHITE = (255, 255, 255, 255)


def _lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def _gradient(size, radius):
    """Diagonal gradient clipped to a rounded square."""
    scale = 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    box = (0, 0, size * scale - 1, size * scale - 1)
    draw.rounded_rectangle(box, radius=radius * scale, fill=(255, 255, 255, 255))

    art = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    art_draw = ImageDraw.Draw(art)
    span = size * scale
    for y in range(span):
        t = (y / span) * 0.65 + ((y / span) ** 0.7) * 0.35
        color = _lerp(START, END, min(1.0, t)) + (255,)
        art_draw.line((0, y, span, y), fill=color)
    canvas.putalpha(canvas.getchannel("A"))
    art.putalpha(Image.composite(art.getchannel("A"), Image.new("L", art.size, 0), canvas.getchannel("A")))
    canvas.alpha_composite(art)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def _power_symbol(image, center, radius, width):
    draw = ImageDraw.Draw(image)
    cx, cy = center
    box = (cx - radius, cy - radius, cx + radius, cy + radius)
    # A gap at the top (270 degrees) makes the familiar power button shape.
    draw.arc(box, start=300, end=240, fill=WHITE, width=width)
    draw.line((cx, cy - radius + width // 2, cx, cy + radius // 3), fill=WHITE, width=width)
    # Small rounded cap, so the stroke looks intentional at small sizes.
    draw.ellipse((cx - width // 2, cy - radius, cx + width // 2, cy - radius + width), fill=WHITE)


def _app_icon(size=128):
    image = _gradient(size, radius=round(size * 0.24))
    _power_symbol(image, (size // 2, size // 2 + round(size * 0.02)),
                  round(size * 0.235), max(3, round(size * 0.062)))
    return image


def _foreground(size=432):
    """Transparent artwork for Android adaptive icons (safe zone ~66%)."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    _power_symbol(image, (size // 2, size // 2), round(size * 0.205), round(size * 0.047))
    return image


def _round_icon(size):
    image = _app_icon(max(size, 128)).resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    image.putalpha(mask.resize((size, size), Image.Resampling.LANCZOS))
    return image


def _write_android(project: Path, icon: Image.Image, foreground: Image.Image):
    res = project / "app" / "src" / "main" / "res"
    densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for density, size in densities.items():
        mipmap = res / f"mipmap-{density}"
        mipmap.mkdir(parents=True, exist_ok=True)
        icon.resize((size, size), Image.Resampling.LANCZOS).save(mipmap / "ic_launcher.png")
        _round_icon(size).save(mipmap / "ic_launcher_round.png")

    fg_dir = res / "mipmap-xxxhdpi"
    foreground.save(fg_dir / "ic_launcher_foreground.png")
    adaptive = res / "mipmap-anydpi-v26"
    adaptive.mkdir(parents=True, exist_ok=True)
    (adaptive / "ic_launcher.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@color/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n', encoding="utf-8")
    (adaptive / "ic_launcher_round.xml").write_text(
        (adaptive / "ic_launcher.xml").read_text(encoding="utf-8"), encoding="utf-8")

    values = res / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        f'    <color name="ic_launcher_background">#{START[0]:02X}{START[1]:02X}{START[2]:02X}</color>\n'
        '</resources>\n', encoding="utf-8")


def main():
    icon = _app_icon()
    icon_path = ROOT / "tuya_local_key" / "icon.png"
    icon_path.parent.mkdir(parents=True, exist_ok=True)
    icon.save(icon_path)
    print(f"+ wrote {icon_path.relative_to(ROOT)} ({icon.size[0]}x{icon.size[1]})")

    foreground = _foreground()
    for project in ANDROID_PROJECTS:
        if project.is_dir():
            _write_android(project, icon, foreground)
            print(f"+ wrote launcher icons -> {project.relative_to(ROOT)}/app/src/main/res")


if __name__ == "__main__":
    main()
