#!/usr/bin/env python3
"""Build the fully offline Android APK (Python + Flask run on the device).

    python build_offline_apk.py                # -> dist/TuyaLocalKey-Offline.apk
    python build_offline_apk.py --release      # release variant (secure signing config required)
    python build_offline_apk.py --install      # adb install -r after building

The script copies the current app sources, templates, static assets and icon
into android_offline/app/src/main/python before building, so there is only one
copy of the application code to maintain.

Requirements: Android SDK (ANDROID_HOME), JDK 17, Python 3.12 on PATH.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT / "android_offline"
PY_DIR = PROJECT / "app" / "src" / "main" / "python"
DIST = ROOT / "dist"

PY_MODULES = [
    "android_entry.py", "app.py", "device_cache.py", "device_preferences.py",
    "device_values.py", "lan_scan.py", "local_control.py", "haier_control.py", "support_report.py",
    "tuya_devices.py", "tuya_versions.py", "updates.py", "pyproject.toml",
]


def _sdk_root(explicit: str | None) -> Path:
    value = explicit or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not value:
        raise SystemExit("Set ANDROID_HOME to your Android SDK folder.")
    path = Path(value).expanduser()
    if not path.is_dir():
        raise SystemExit(f"Android SDK folder does not exist: {path}")
    return path


def _adb(sdk: Path) -> str:
    found = shutil.which("adb")
    if found:
        return found
    candidate = sdk / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    if candidate.exists():
        return str(candidate)
    raise SystemExit("adb not found (expected in ANDROID_HOME/platform-tools).")


def _check_java() -> None:
    exe = "java.exe" if os.name == "nt" else "java"
    java_home = os.environ.get("JAVA_HOME")
    if java_home and (Path(java_home) / "bin" / exe).exists():
        return
    if shutil.which("java"):
        return
    raise SystemExit("JDK not found. Set JAVA_HOME or put java on PATH.")


def _sync_sources() -> None:
    PY_DIR.mkdir(parents=True, exist_ok=True)
    for name in PY_MODULES:
        source = ROOT / name
        if not source.exists():
            raise SystemExit(f"Missing source file: {source}")
        shutil.copy2(source, PY_DIR / name)
    for name in ("templates", "static"):
        source = ROOT / name
        if not source.is_dir():
            raise SystemExit(f"Missing source folder: {source}")
        shutil.copytree(source, PY_DIR / name, dirs_exist_ok=True)
    icon = ROOT / "tuya_local_key" / "icon.png"
    if icon.exists():
        target = PY_DIR / "tuya_local_key"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(icon, target / "icon.png")
    print(f"+ synced sources -> {PY_DIR}")


def _prepare_wrapper() -> list[str]:
    """Reuse the wrapper generated for the WebView project."""
    source = ROOT / "android"
    files = [
        source / "gradle" / "wrapper" / "gradle-wrapper.jar",
        source / "gradle" / "wrapper" / "gradle-wrapper.properties",
        source / "gradlew.bat",
        source / "gradlew",
    ]
    for item in files:
        if not item.exists():
            raise SystemExit(f"Gradle wrapper file missing: {item}. Run build_apk.py once first.")
        relative = item.relative_to(source)
        target = PROJECT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
    wrapper = PROJECT / ("gradlew.bat" if os.name == "nt" else "gradlew")
    return [str(wrapper)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", default=None, help="Android SDK folder")
    parser.add_argument("--release", action="store_true", help="build the release variant")
    parser.add_argument("--install", action="store_true", help="adb install after building")
    parser.add_argument("--no-sync", action="store_true", help="keep existing Python sources")
    args = parser.parse_args()

    sdk = _sdk_root(args.sdk_root)
    _check_java()
    if not args.no_sync:
        _sync_sources()
    (PROJECT / "local.properties").write_text(f"sdk.dir={sdk.as_posix()}\n", encoding="utf-8")

    cmd = _prepare_wrapper()
    variant = "release" if args.release else "debug"
    task = "assembleRelease" if args.release else "assembleDebug"
    print(f"+ {' '.join(cmd)} {task}")
    subprocess.check_call([*cmd, task, "--no-daemon"], cwd=PROJECT)

    src = PROJECT / "app" / "build" / "outputs" / "apk" / variant / f"app-{variant}.apk"
    if not src.exists():
        raise SystemExit(f"Build finished but {src} was not found.")
    DIST.mkdir(parents=True, exist_ok=True)
    apk = DIST / "TuyaLocalKey-Offline.apk"
    shutil.copy2(src, apk)

    print(f"\nBuilt: {apk}")
    if args.install:
        adb = _adb(sdk)
        print(f"+ {adb} install -r {apk}")
        subprocess.check_call([adb, "install", "-r", str(apk)], cwd=ROOT)


if __name__ == "__main__":
    main()
