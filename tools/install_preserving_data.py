#!/usr/bin/env python3
"""Install a re-signed APK while preserving the old app's private data.

Android refuses an in-place update when the signing certificate changes. This
tool is for that one migration: it copies the debuggable app's data directory
off the phone with `run-as`, uninstalls the old APK, installs the new one, and
restores the data under the new signature. The local copy is temporary and is
deleted immediately afterwards.

Usage:
    python tools/install_preserving_data.py --yes
    python tools/install_preserving_data.py --apk dist/SmartPilot-Local.apk --yes
"""
from __future__ import annotations

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from build_offline_apk import EXPECTED_SIGNER_SHA256

PACKAGE = "com.example.tuyalocalkey.offline.v2.debug"


def run(cmd, *, binary=False, stdin=None):
    return subprocess.run(
        cmd, input=stdin, stdout=subprocess.PIPE if binary else None,
        stderr=subprocess.STDOUT, text=not binary,
    )


def find_adb(sdk: Path) -> str:
    found = shutil.which("adb")
    if found:
        return found
    for name in ("adb.exe", "adb"):
        candidate = sdk / "platform-tools" / name
        if candidate.exists():
            return str(candidate)
    raise SystemExit("adb not found")


def verify_signer(sdk: Path, apk: Path) -> None:
    tools = sdk / "build-tools"
    exe = sorted(tools.glob("*/apksigner.bat")) if os.name == "nt" else sorted(tools.glob("*/apksigner"))
    if not exe:
        raise SystemExit("apksigner not found; refusing to migrate")
    command = [str(exe[-1]), "verify", "--print-certs", str(apk)]
    if exe[-1].suffix.lower() == ".bat":
        command = ["cmd", "/c", *command]
    result = subprocess.run(command, capture_output=True, text=True)
    match = re.search(r"certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)", result.stdout or "")
    if not match:
        raise SystemExit("could not read APK certificate")
    actual = match.group(1).replace(":", "").lower()
    expected = EXPECTED_SIGNER_SHA256.replace(":", "").lower()
    if actual != expected:
        raise SystemExit(f"APK signer {actual} does not match expected {expected}")
    print(f"+ APK signer verified: {actual}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", default="dist/SmartPilot-Local.apk")
    parser.add_argument("--serial", default="")
    parser.add_argument("--sdk-root", default=os.environ.get("ANDROID_HOME")
                        or os.environ.get("ANDROID_SDK_ROOT")
                        or r"C:\Users\abc\AppData\Local\Android\Sdk")
    parser.add_argument("--yes", action="store_true", help="required confirmation")
    args = parser.parse_args()

    if not args.yes:
        raise SystemExit("Refusing to uninstall without --yes. This replaces the installed APK.")

    sdk = Path(args.sdk_root)
    apk = Path(args.apk).resolve()
    if not apk.is_file():
        raise SystemExit(f"APK not found: {apk}")
    verify_signer(sdk, apk)

    adb = find_adb(sdk)
    base = [adb]
    if args.serial:
        base += ["-s", args.serial]
    devices = run(base + ["devices"]).stdout or ""
    lines = [line for line in devices.splitlines() if line.strip().endswith("\tdevice")]
    if not lines and not args.serial:
        raise SystemExit("No connected adb device. Connect the phone and try again.")

    def adb_cmd(*parts):
        return base + list(parts)

    pwd = run(adb_cmd("shell", "run-as", PACKAGE, "pwd"))
    data_dir = (pwd.stdout or "").strip()
    if pwd.returncode != 0 or data_dir != f"/data/data/{PACKAGE}":
        raise SystemExit(
            "run-as failed or returned an unexpected directory. The installed app must "
            f"be debuggable and rooted at /data/data/{PACKAGE}; got {data_dir!r}."
        )
    print(f"+ found installed app data at {data_dir}")

    print("+ stopping app")
    run(adb_cmd("shell", "am", "force-stop", PACKAGE))

    backup = run(adb_cmd("exec-out", "run-as", PACKAGE, "tar", "cf", "-", "."), binary=True)
    if backup.returncode != 0 or len(backup.stdout or b"") < 1024:
        raise SystemExit("Could not back up app data; nothing was uninstalled.")
    temp = tempfile.NamedTemporaryFile(prefix="smartpilot-data-", suffix=".tar", delete=False)
    try:
        temp.write(backup.stdout)
        temp.close()
        print(f"+ backed up {len(backup.stdout)} bytes of app data (temporary local copy)")

        print("+ uninstalling old signature")
        uninstalled = run(adb_cmd("uninstall", PACKAGE))
        if uninstalled.returncode != 0:
            raise SystemExit("Uninstall failed; app data on the phone is untouched.")

        print("+ installing new APK")
        installed = run(adb_cmd("install", "-r", str(apk)))
        if installed.returncode != 0:
            raise SystemExit(
                "Install failed. Reinstall the previous APK from GitHub Releases to restore the old signature."
            )

        print("+ restoring app data")
        restored = run(adb_cmd("exec-out", "run-as", PACKAGE, "tar", "xf", "-"),
                       binary=True, stdin=backup.stdout)
        if restored.returncode != 0:
            raise SystemExit("Data restore failed; check the temporary backup before leaving the phone.")

        run(adb_cmd("shell", "run-as", PACKAGE, "rm", "-rf", "cache/WebView"))
        run(adb_cmd("shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"))
        print("+ launch requested; verify Settings and device endpoints before closing")
    finally:
        try:
            os.unlink(temp.name)
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
