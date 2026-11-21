#!/usr/bin/env python3
"""Build and safely update the Android app on one connected device.

    python tools/adb_update.py                 # detect variant from installed package
    python tools/adb_update.py --serial XYZ    # required when multiple devices are connected
    python tools/adb_update.py --variant server|offline --no-build

The script never uninstalls the app or clears its data. It stops with a clear
message if Android reports a signing mismatch.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = {
    "server": [
        "com.example.tuyalocalkey", "com.example.tuyalocalkey.debug",
    ],
    "offline": [
        "com.example.tuyalocalkey.offline.v2", "com.example.tuyalocalkey.offline.v2.debug",
        "com.example.tuyalocalkey.offline", "com.example.tuyalocalkey.offline.debug",
    ],
}
GRADLE_FILES = {
    "server": ROOT / "android" / "app" / "build.gradle",
    "offline": ROOT / "android_offline" / "app" / "build.gradle",
}
BUILDERS = {
    "server": ROOT / "build_apk.py",
    "offline": ROOT / "build_offline_apk.py",
}
APKS = {
    "server": ROOT / "dist" / "TuyaLocalKey.apk",
    "offline": ROOT / "dist" / "SmartPilot-Local.apk",
}


def run(args, *, capture=True, check=False):
    print("+ " + " ".join(str(part) for part in args), flush=True)
    result = subprocess.run([str(part) for part in args], cwd=ROOT, text=True,
                            capture_output=capture)
    if check and result.returncode:
        raise SystemExit(f"Command failed ({result.returncode}): {result.stdout}\n{result.stderr}")
    return result


def find_adb(explicit=None):
    if explicit:
        return explicit
    found = shutil.which("adb")
    if found:
        return found
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if sdk:
        exe = "adb.exe" if os.name == "nt" else "adb"
        candidate = Path(sdk) / "platform-tools" / exe
        if candidate.exists():
            return str(candidate)
    raise SystemExit("adb not found. Set ANDROID_HOME or pass --adb <path>.")


def devices(adb):
    output = run([adb, "devices", "-l"]).stdout
    rows = []
    for line in output.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            rows.append((parts[0], line))
    return rows


def installed_packages(adb, serial):
    output = run([adb, "-s", serial, "shell", "pm", "list", "packages"]).stdout
    found = {}
    for variant, names in PACKAGES.items():
        for name in names:
            if f"package:{name}" in output:
                found[variant] = name
                break
    return found


def package_details(adb, serial, package):
    output = run([adb, "-s", serial, "shell", "dumpsys", "package", package]).stdout
    details = {}
    for key in ("versionCode", "versionName"):
        match = re.search(rf"{key}=(\S+)", output)
        if match:
            details[key] = match.group(1)
    signatures = [line.strip() for line in output.splitlines() if "signatures" in line.lower()]
    return details, signatures[:4]


def local_version(path):
    text = path.read_text(encoding="utf-8")
    code = re.search(r"versionCode\s+(\d+)", text)
    name = re.search(r"versionName\s+['\"]([^'\"]+)['\"]", text)
    return (code.group(1) if code else "?"), (name.group(1) if name else "?")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adb")
    parser.add_argument("--serial")
    parser.add_argument("--variant", choices=sorted(PACKAGES))
    parser.add_argument("--no-build", action="store_true", help="install the APK already in dist/")
    parser.add_argument("--no-launch", action="store_true")
    args = parser.parse_args()

    adb = find_adb(args.adb)
    found = devices(adb)
    if not found:
        raise SystemExit("No authorized device found. Connect over USB or enable wireless ADB.")
    serial = args.serial
    if not serial and len(found) > 1:
        raise SystemExit("Multiple devices connected; pass --serial <id>. Refusing to guess: " +
                         ", ".join(row[0] for row in found))
    if not serial:
        serial = found[0][0]
    if serial not in [row[0] for row in found]:
        raise SystemExit(f"Serial {serial} is not connected/authorized.")

    installed = installed_packages(adb, serial)
    variant = args.variant
    if not variant:
        if len(installed) == 1:
            variant = next(iter(installed))
        elif not installed:
            variant = "offline"  # documented default for first install
            print("No matching app installed; defaulting to the offline variant.")
        else:
            raise SystemExit("Both variants are installed; pass --variant explicitly.")
    package = installed.get(variant, PACKAGES[variant][0])

    if package in installed.values():
        details, signatures = package_details(adb, serial, package)
        print(f"Installed: {package} versionCode={details.get('versionCode', '?')} "
              f"versionName={details.get('versionName', '?')}")
        for line in signatures:
            print("  " + line)
        code, _ = local_version(GRADLE_FILES[variant])
        try:
            if int(code) <= int(details.get("versionCode", 0)):
                raise SystemExit(f"Local versionCode {code} is not newer than installed "
                                 f"{details['versionCode']}; bump it before updating.")
        except (TypeError, ValueError):
            print("Warning: could not compare versionCode values.")
    else:
        print(f"No installed {package}; this will be a fresh install (data preserved if present).")

    if not args.no_build:
        builder = BUILDERS[variant]
        sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
        env = os.environ.copy()
        if sdk:
            env["ANDROID_HOME"] = sdk
        print(f"+ python {builder.name}")
        subprocess.check_call([sys.executable, str(builder)], cwd=ROOT, env=env)

    apk = APKS[variant]
    if not apk.exists():
        raise SystemExit(f"APK not found: {apk}")

    result = run([adb, "-s", serial, "install", "-r", str(apk)], capture=False)
    if result.returncode:
        raise SystemExit("Install failed. If Android reported INSTALL_FAILED_UPDATE_INCOMPATIBLE, "
                         "the existing app used a different signing key. Stop here: do not "
                         "uninstall or clear data without explicit permission.")

    print(f"Installed {package} on {serial} from {apk.name}")
    if not args.no_launch:
        resolved = run([adb, "-s", serial, "shell", "cmd", "package", "resolve-activity",
                        "--brief", package]).stdout.strip().splitlines()
        component = next((line.strip() for line in reversed(resolved) if "/" in line), "")
        if component:
            run([adb, "-s", serial, "shell", "am", "start", "-n", component], capture=False)
        else:
            run([adb, "-s", serial, "shell", "monkey", "-p", package, "1"], capture=False)
        time.sleep(3)
        logs = run([adb, "-s", serial, "logcat", "-d", "-t", "200"]).stdout
        errors = [line for line in logs.splitlines()
                  if " AndroidRuntime " in line or "FATAL EXCEPTION" in line or package in line]
        print("--- recent logcat (filtered) ---")
        print("\n".join(errors[-40:]) or "(no matching errors)")
    print("Done. Data, login and local keys were not cleared.")


if __name__ == "__main__":
    main()
