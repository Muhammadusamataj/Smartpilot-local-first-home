#!/usr/bin/env python3
"""Build a single-file Windows EXE of Tuya Local Key.

    python build_exe.py                 # -> dist/TuyaLocalKey.exe
    python build_exe.py --onedir        # -> dist/TuyaLocalKey/TuyaLocalKey.exe
    python build_exe.py --no-install    # skip pip install / PyInstaller install

The build bundles templates, static assets, the icon and pyproject.toml (used
for the version shown in the UI) into the executable. Runtime data is stored
outside the bundle by desktop_launcher.py.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NAME = "TuyaLocalKey"
DIST = ROOT / "dist"
BUILD = ROOT / "build" / "pyinstaller"


def _run(*command: str) -> None:
    print("+ " + " ".join(str(c) for c in command), flush=True)
    subprocess.check_call([str(c) for c in command], cwd=ROOT)


def _install(args: argparse.Namespace) -> None:
    if not args.no_install:
        _run(sys.executable, "-m", "pip", "install", "-r", "requirements-web.txt")
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        _run(sys.executable, "-m", "pip", "install", "pyinstaller>=6.0")


def _icon() -> Path | None:
    """Make an .ico from the bundled PNG (PyInstaller needs ICO on Windows)."""
    source = ROOT / "tuya_local_key" / "icon.png"
    if not source.exists():
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    BUILD.mkdir(parents=True, exist_ok=True)
    target = BUILD / "app.ico"
    with Image.open(source) as image:
        image.save(target, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return target


def build(args: argparse.Namespace) -> Path:
    _install(args)
    sep = os.pathsep  # ';' on Windows, ':' on POSIX
    icon = _icon()

    datas = [
        ("templates", "templates"),
        ("static", "static"),
        ("tuya_local_key/icon.png", "tuya_local_key"),
        ("pyproject.toml", "."),
        ("LICENSE", "."),
        ("NOTICE", "."),
    ]

    command = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--name", NAME,
        "--distpath", str(DIST),
        "--workpath", str(BUILD),
        "--specpath", str(BUILD),
    ]
    command += ["--onedir"] if args.onedir else ["--onefile"]
    if icon:
        command += ["--icon", str(icon)]
    for src, dst in datas:
        source = ROOT / src
        if source.exists():
            command += ["--add-data", f"{source}{sep}{dst}"]
        elif src in {"templates", "static"}:
            raise SystemExit(f"Missing required folder: {source}")

    # Packages loaded indirectly by the SDK / server / QR generator.
    for module in ("waitress", "tinytuya", "tuya_sharing", "qrcode", "flask", "paho"):
        command += ["--collect-submodules", module]

    command += ["--hidden-import", "waitress"]
    command += ["--hidden-import", "desktop_launcher"]
    command.append(str(ROOT / "desktop_launcher.py"))

    _run(*command)
    exe = DIST / NAME / f"{NAME}.exe" if args.onedir else DIST / f"{NAME}.exe"
    if not exe.exists():
        raise SystemExit(f"Build finished but {exe} was not found.")
    return exe


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onedir", action="store_true", help="folder build (faster startup)")
    parser.add_argument("--no-install", action="store_true",
                        help="do not install requirements-web.txt / PyInstaller")
    args = parser.parse_args()
    exe = build(args)
    print(f"\nBuilt: {exe}")
    print("Run it, then use the Devices screen (the browser opens automatically).")
    print("Data/session files are stored next to the EXE in a 'data' folder.")


if __name__ == "__main__":
    main()
