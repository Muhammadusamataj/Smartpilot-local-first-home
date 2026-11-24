#!/usr/bin/env python3
"""Copy the root web app into the Home Assistant add-on build context.

Home Assistant builds an add-on from the folder that contains config.yaml; it
cannot reach files in the repository root. Run this after changing the app:

    python tools/sync_addon.py

The generated `tuya_local_key/app/` tree is committed so the Supervisor can
build the add-on without GitHub Actions or GHCR.
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON = ROOT / "tuya_local_key"
TARGET = ADDON / "app"

PY_FILES = [
    "app.py",
    "wsgi.py",
    "device_cache.py",
    "device_preferences.py",
    "device_values.py",
    "lan_scan.py",
    "local_control.py",
    "titanium_ui.py",
    "pilot_extras.py",
    "tuya_versions.py",
    "haier_control.py",
    "haier_hrdp_adapter.py",
    "haier_cloud_login.py",
    "family_hub.py",
    "support_report.py",
    "tuya_devices.py",
    "updates.py",
]
EXTRA_FILES = [
    "pyproject.toml",
    "requirements.txt",
    "requirements-web.txt",
    "LICENSE",
    "NOTICE",
]


def main() -> None:
    if TARGET.exists():
        shutil.rmtree(TARGET)
    TARGET.mkdir(parents=True)

    for name in PY_FILES + EXTRA_FILES:
        source = ROOT / name
        if not source.is_file():
            raise SystemExit(f"Missing source file: {source}")
        shutil.copy2(source, TARGET / name)

    for folder in ("templates", "static"):
        shutil.copytree(ROOT / folder, TARGET / folder)

    vendor = ROOT / "haismart_hrdp"
    if not vendor.is_dir():
        raise SystemExit(f"Missing vendored source: {vendor}")
    shutil.copytree(vendor, TARGET / "haismart_hrdp")

    icon = ROOT / "tuya_local_key" / "icon.png"
    target_icon = TARGET / "tuya_local_key" / "icon.png"
    target_icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(icon, target_icon)

    print(f"Synced add-on app sources -> {TARGET}")


if __name__ == "__main__":
    main()
