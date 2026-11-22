#!/usr/bin/env python3
"""Safely replace the offline APK when its signing certificate changed.

Android refuses an in-place update when the signing certificate changes. This
tool backs up the debuggable app's private data, keeps a rollback copy of the
installed APK, installs the new build, restores the data, and verifies it.

The backup is validated *before* anything is uninstalled, kept outside the repo,
and never deleted on failure. Use ``--restore-only`` to retry a restore without
repeating the uninstall/install, or ``--verify-backup`` to inspect a backup.

Examples:
    python tools/install_preserving_data.py --yes
    python tools/install_preserving_data.py --apk dist/SmartPilot-Local.apk --yes
    python tools/install_preserving_data.py --restore-only ~/.smartpilot-backups/data-....tar --yes
    python tools/install_preserving_data.py --verify-backup ~/.smartpilot-backups/data-....tar
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime
from pathlib import Path
from typing import Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_offline_apk import EXPECTED_SIGNER_SHA256  # noqa: E402

PACKAGE = "com.example.tuyalocalkey.offline.v2.debug"
DATA_DIR = f"/data/data/{PACKAGE}"
DEVICE_TAR = "/data/local/tmp/smartpilot-backup.tar"
DEVICE_APK = "/data/local/tmp/smartpilot-rollback.apk"

BACKUP_HOME = Path(os.environ.get(
    "SMARTPILOT_BACKUP_HOME", str(Path.home() / "Documents" / "SmartPilot-Backups")
))

RESTORE_HELP = """Smart Pilot Local — data backup
===============================

Each `smartpilot-data-<date>.tar` is a full copy of the app's private data
(Haier keys, Tuya keys, scenes, schedules, settings). Its `.json` file lists the
contents and checksum. The matching `smartpilot-previous-<date>.apk` is the
installed APK at the time of backup, used for rollback.

These files contain encryption keys. Keep this folder private; do not upload it
to cloud storage or share it in chat.

HOW TO RESTORE (on the phone with USB/wireless debugging connected)
-------------------------------------------------------------------
1. Find the newest `smartpilot-data-*.tar` in this folder.
2. Run, replacing the filename with yours:

   python tools\\install_preserving_data.py --restore-only "%USERPROFILE%\\Documents\\SmartPilot-Backups\\smartpilot-data-YYYYMMDD-HHMMSS.tar" --yes

3. The tool verifies the backup, restores it, launches the app and checks the
   endpoints. It never deletes the backup.

To create a fresh backup without reinstalling anything:

   python tools\\install_preserving_data.py --backup-only --yes

To inspect a backup without a phone:

   python tools\\install_preserving_data.py --verify-backup "<path-to-tar>"
"""

# Loss of either of these makes every encrypted setting unreadable.
CRYPTO_FILES = ("files/haier-pilot.key", "files/cache.key")
# Present in every installed build of this app.
REQUIRED_FILES = CRYPTO_FILES + (
    "files/lan-profile.json",
    "files/local-usage.json",
    "shared_prefs/remote_access.xml",
)
# Present only after the corresponding feature was used.
VALUABLE_FILES = (
    "files/haier-pilot.enc",
    "files/haier-cloud.enc",
    "files/devices.cache",
    "files/lan.cache",
    "files/local-rules.json",
    "files/local-rule-state.json",
    "files/local-events.json",
    "files/family-hub.enc",
    "shared_prefs/smartpilot_updates.xml",
)
MIN_ENTRIES = 15

HEALTH_ENDPOINTS = (
    "/api/haier/devices",
    "/api/haier/cloud/status",
    "/api/local/scheduler",
    "/api/family/status",
)


class StepError(RuntimeError):
    """A named step failed; the message explains the current device state."""


def run(cmd: list[str], *, binary: bool = False, stdin: bytes | None = None,
        timeout: int = 180) -> subprocess.CompletedProcess:
    # Never merge stderr into stdout for binary data: an adb warning would be
    # appended to the tar stream and silently corrupt the backup.
    stderr = subprocess.PIPE if binary else subprocess.STDOUT
    try:
        return subprocess.run(
            cmd, input=stdin, stdout=subprocess.PIPE, stderr=stderr,
            text=not binary, timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise StepError(f"Timed out after {timeout}s: {' '.join(cmd)}") from exc


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _norm(name: str) -> str:
    return name.lstrip("./")


def validate_backup(path: Path) -> dict:
    """Check that a backup is a complete, readable app-data archive.

    Raises StepError if the tar is truncated or lacks the files needed to
    decrypt settings. Returns a manifest dict suitable for writing to JSON.
    """
    if not path.is_file():
        raise StepError(f"Backup not found: {path}")
    if path.stat().st_size < 1024:
        raise StepError(f"Backup is too small to be app data: {path}")

    # tarfile silently stops at a partial header, so check the end-of-archive
    # marker explicitly. A truncated backup must never reach the uninstall step.
    with path.open("rb") as handle:
        handle.seek(-1024, os.SEEK_END)
        tail = handle.read(1024)
    if tail != b"\x00" * 1024:
        raise StepError(f"Backup is corrupt or truncated (no end marker): {path}")

    names: list[str] = []
    sizes: dict[str, int] = {}
    try:
        with tarfile.open(path, "r:") as tar:
            for member in tar:
                name = _norm(member.name)
                if name in (".", ""):
                    continue
                names.append(name)
                if member.isfile():
                    sizes[name] = member.size
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise StepError(f"Backup is corrupt or truncated ({exc}): {path}") from exc

    if len(names) < MIN_ENTRIES:
        raise StepError(f"Backup has only {len(names)} entries; expected >= {MIN_ENTRIES}")
    if not any(n.startswith("files/") for n in names) or not any(
        n.startswith("shared_prefs/") for n in names
    ):
        raise StepError("Backup is missing files/ or shared_prefs/ directories")

    present = set(sizes)
    missing_required = [name for name in REQUIRED_FILES if name not in present]
    if missing_required:
        raise StepError(
            "Backup is missing required files: " + ", ".join(missing_required)
        )
    empty_crypto = [name for name in CRYPTO_FILES if sizes.get(name, 0) == 0]
    if empty_crypto:
        raise StepError("Backup has empty encryption key files: " + ", ".join(empty_crypto))

    return {
        "created": datetime.now().astimezone().isoformat(timespec="seconds"),
        "package": PACKAGE,
        "data_file": path.name,
        "data_sha256": sha256_file(path),
        "data_size": path.stat().st_size,
        "entries": len(names),
        "required_present": list(REQUIRED_FILES),
        "valuable_present": [n for n in VALUABLE_FILES if n in present],
        "valuable_missing": [n for n in VALUABLE_FILES if n not in present],
    }


def write_manifest(backup: Path, manifest: dict) -> Path:
    target = backup.with_suffix(".json")
    target.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return target


class Adb:
    def __init__(self, sdk: Path, serial: str):
        self.exe = self._find(sdk)
        self.base = [self.exe] + (["-s", serial] if serial else [])

    @staticmethod
    def _find(sdk: Path) -> str:
        found = shutil.which("adb")
        if found:
            return found
        for name in ("adb.exe", "adb"):
            candidate = sdk / "platform-tools" / name
            if candidate.is_file():
                return str(candidate)
        raise StepError("adb not found")

    def cmd(self, *parts: str) -> list[str]:
        return self.base + list(parts)

    def shell(self, command: str, timeout: int = 180) -> subprocess.CompletedProcess:
        return run(self.cmd("shell", command), timeout=timeout)

    def run_as(self, *args: str, timeout: int = 180) -> subprocess.CompletedProcess:
        return run(self.cmd("shell", "run-as", PACKAGE, *args), timeout=timeout)

    def devices(self) -> list[str]:
        out = run(self.cmd("devices"), timeout=60).stdout or ""
        return [line.split("\t")[0] for line in out.splitlines()
                if line.strip().endswith("\tdevice")]

    def pull(self, remote: str, local: Path, timeout: int = 600) -> None:
        result = run(self.cmd("pull", remote, str(local)), timeout=timeout)
        if result.returncode != 0 or not local.is_file():
            raise StepError(f"adb pull failed for {remote}: {result.stdout}")

    def push(self, local: Path, remote: str, timeout: int = 600) -> None:
        result = run(self.cmd("push", str(local), remote), timeout=timeout)
        if result.returncode != 0:
            raise StepError(f"adb push failed for {local}: {result.stdout}")


def verify_signer(sdk: Path, apk: Path) -> None:
    tools = sdk / "build-tools"
    exe = sorted(tools.glob("*/apksigner.bat")) if os.name == "nt" \
        else sorted(tools.glob("*/apksigner"))
    if not exe:
        raise StepError("apksigner not found; refusing to migrate")
    command = [str(exe[-1]), "verify", "--print-certs", str(apk)]
    if exe[-1].suffix.lower() == ".bat":
        command = ["cmd", "/c", *command]
    result = run(command, timeout=120)
    match = re.search(r"certificate SHA-256 digest:\s*([0-9A-Fa-f:]+)", result.stdout or "")
    if not match:
        raise StepError(f"Could not read APK certificate: {result.stdout}")
    actual = match.group(1).replace(":", "").lower()
    expected = EXPECTED_SIGNER_SHA256.replace(":", "").lower()
    if actual != expected:
        raise StepError(f"APK signer {actual} does not match expected {expected}")
    print(f"+ APK signer verified: {actual}")


def check_device(adb: Adb) -> str:
    if not adb.devices():
        raise StepError("No connected adb device. Connect the phone and retry.")
    result = adb.run_as("pwd")
    data_dir = (result.stdout or "").strip()
    if result.returncode != 0 or data_dir not in {DATA_DIR, f"/data/user/0/{PACKAGE}"}:
        raise StepError(
            "run-as failed or returned an unexpected directory. The installed app "
            f"must be debuggable and rooted at {DATA_DIR}; got {data_dir!r}."
        )
    version = adb.shell(
        f"dumpsys package {PACKAGE} | grep versionName"
    ).stdout or ""
    version = version.strip().splitlines()[-1].strip() if version.strip() else "unknown"
    print(f"+ device OK: {data_dir} ({version})")
    return data_dir


def create_backup(adb: Adb, data_dir: str) -> tuple[Path, Path]:
    """Create, pull and validate a backup plus a rollback APK.

    Returns (data_backup, rollback_apk). Nothing is uninstalled here.
    """
    print("+ stopping app")
    adb.shell(f"am force-stop {PACKAGE}")

    BACKUP_HOME.mkdir(parents=True, exist_ok=True)
    help_file = BACKUP_HOME / "RESTORE.txt"
    if not help_file.exists():
        help_file.write_text(RESTORE_HELP, encoding="utf-8")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    local_tar = BACKUP_HOME / f"smartpilot-data-{stamp}.tar"
    local_apk = BACKUP_HOME / f"smartpilot-previous-{stamp}.apk"

    print("+ streaming backup off the device")
    made = run(
        adb.cmd("exec-out", "run-as", PACKAGE, "tar", "cf", "-", "-C", data_dir, "."),
        binary=True, timeout=600,
    )
    if made.returncode != 0 or len(made.stdout or b"") < 1024:
        detail = (made.stderr or b"").decode(errors="replace").strip()
        raise StepError(
            f"Backup stream failed: {detail}\nNothing was uninstalled."
        )
    local_tar.write_bytes(made.stdout)
    manifest = validate_backup(local_tar)
    write_manifest(local_tar, manifest)
    print(f"+ backup verified: {manifest['entries']} entries, "
          f"sha256 {manifest['data_sha256'][:16]}...")

    print("+ saving rollback APK")
    path = adb.shell(f"pm path {PACKAGE}").stdout or ""
    path = path.strip().splitlines()[0].replace("package:", "").strip() if path.strip() else ""
    if path:
        try:
            adb.pull(path, local_apk)
            manifest["rollback_apk"] = local_apk.name
            manifest["rollback_apk_sha256"] = sha256_file(local_apk)
            write_manifest(local_tar, manifest)
            print(f"+ rollback APK saved: {local_apk.name}")
        except StepError as exc:
            print(f"! could not save rollback APK: {exc}")
            local_apk = Path()
    else:
        print("! could not locate installed APK for rollback")
        local_apk = Path()

    adb.shell(f"rm -f {DEVICE_TAR}")
    return local_tar, local_apk


def restore_data(adb: Adb, data_dir: str, backup: Path) -> None:
    """Push and extract a validated backup, then verify critical files."""
    print(f"+ restoring {backup.name}")
    adb.push(backup, DEVICE_TAR)
    try:
        result = adb.run_as("tar", "xf", DEVICE_TAR, "-C", data_dir, timeout=600)
        if result.returncode != 0:
            raise StepError(f"Data restore failed: {result.stdout}")
    finally:
        adb.shell(f"rm -f {DEVICE_TAR}")

    for name in REQUIRED_FILES:
        checked = adb.run_as("stat", "-c", "%s", name)
        if checked.returncode != 0 or not (checked.stdout or "").strip().isdigit():
            raise StepError(f"Restored file missing or unreadable: {name}")
    print("+ restored files verified on device")
    adb.run_as("rm", "-rf", "cache/WebView")


def launch(adb: Adb) -> None:
    result = adb.shell(
        f"monkey -p {PACKAGE} -c android.intent.category.LAUNCHER 1", timeout=60
    )
    if result.returncode != 0 and "Events injected" not in (result.stdout or ""):
        raise StepError(f"Could not launch app: {result.stdout}")
    print("+ launch requested")


def verify_health(port: int) -> None:
    import time
    import urllib.request

    base = f"http://127.0.0.1:{port}"
    last_error = ""
    for _ in range(20):
        try:
            for endpoint in HEALTH_ENDPOINTS:
                with urllib.request.urlopen(base + endpoint, timeout=10) as response:
                    payload = json.load(response)
                if not isinstance(payload, dict):
                    raise ValueError(f"unexpected response from {endpoint}")
            print("+ app endpoints healthy")
            return
        except Exception as exc:  # noqa: BLE001 - retry while server starts
            last_error = str(exc)
            time.sleep(1)
    raise StepError(f"App did not become healthy on port {port}: {last_error}")


def rollback(adb: Adb, backup: Path, rollback_apk: Path) -> None:
    print("!!! rolling back to the previously installed APK")
    try:
        if rollback_apk.is_file():
            adb.shell(f"am force-stop {PACKAGE}")
            installed = run(adb.cmd("uninstall", PACKAGE), timeout=180)
            restored = run(adb.cmd("install", "-r", str(rollback_apk)), timeout=600)
            if installed.returncode == 0 and restored.returncode == 0:
                restore_data(adb, DATA_DIR, backup)
                launch(adb)
                print("!!! rollback complete; previous version and data restored")
                return
            print(f"!!! rollback install failed: {restored.stdout}")
        else:
            print("!!! no rollback APK was saved")
    except StepError as exc:
        print(f"!!! rollback error: {exc}")
    print(f"!!! MANUAL RECOVERY REQUIRED. Backup kept at {backup}")


def do_install(args: argparse.Namespace, sdk: Path, apk: Path) -> None:
    if not args.yes:
        raise StepError("Refusing to uninstall without --yes. This replaces the installed APK.")
    if not apk.is_file():
        raise StepError(f"APK not found: {apk}")
    verify_signer(sdk, apk)
    adb = Adb(sdk, args.serial)
    data_dir = check_device(adb)

    backup, rollback_apk = create_backup(adb, data_dir)
    try:
        print("+ uninstalling previous signature")
        result = run(adb.cmd("uninstall", PACKAGE), timeout=180)
        if result.returncode != 0:
            raise StepError(f"Uninstall failed: {result.stdout}\nDevice data is untouched.")

        print("+ installing new APK")
        result = run(adb.cmd("install", "-r", str(apk)), timeout=600)
        if result.returncode != 0:
            raise StepError(f"Install failed: {result.stdout}")

        restore_data(adb, data_dir, backup)
        launch(adb)
        if not args.no_health_check:
            adb.shell(f"forward tcp:{args.port} tcp:8000")
            verify_health(args.port)

        print(f"+ DONE. Backup kept at {backup}")
        if args.delete_backup:
            backup.unlink(missing_ok=True)
            backup.with_suffix(".json").unlink(missing_ok=True)
            print("+ backup deleted as requested")
    except StepError as exc:
        print(f"! FAILED: {exc}")
        print(f"! Backup kept at {backup}")
        if not args.no_rollback:
            rollback(adb, backup, rollback_apk)
        raise SystemExit(1) from exc


def do_backup_only(args: argparse.Namespace, sdk: Path) -> None:
    adb = Adb(sdk, args.serial)
    data_dir = check_device(adb)
    backup, rollback_apk = create_backup(adb, data_dir)
    launch(adb)
    print(f"+ backup saved: {backup}")
    print(f"+ manifest:     {backup.with_suffix('.json')}")
    if rollback_apk.is_file():
        print(f"+ rollback APK: {rollback_apk}")
    print(f"+ instructions: {BACKUP_HOME / 'RESTORE.txt'}")


def do_restore_only(args: argparse.Namespace, sdk: Path) -> None:
    if not args.yes:
        raise StepError("Refusing to overwrite app data without --yes.")
    backup = Path(args.restore_only).expanduser().resolve()
    validate_backup(backup)
    adb = Adb(sdk, args.serial)
    data_dir = check_device(adb)
    restore_data(adb, data_dir, backup)
    launch(adb)
    if not args.no_health_check:
        adb.shell(f"forward tcp:{args.port} tcp:8000")
        verify_health(args.port)
    print(f"+ DONE. Backup still at {backup}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", default="dist/SmartPilot-Local.apk")
    parser.add_argument("--serial", default="")
    parser.add_argument("--sdk-root", default=os.environ.get("ANDROID_HOME")
                        or os.environ.get("ANDROID_SDK_ROOT")
                        or r"C:\Users\abc\AppData\Local\Android\Sdk")
    parser.add_argument("--yes", action="store_true", help="required confirmation")
    parser.add_argument("--backup-only", action="store_true",
                        help="create a validated backup without uninstalling anything")
    parser.add_argument("--restore-only", metavar="TAR",
                        help="restore an existing validated backup without reinstalling")
    parser.add_argument("--verify-backup", metavar="TAR",
                        help="validate a local backup and print its manifest, then exit")
    parser.add_argument("--no-rollback", action="store_true")
    parser.add_argument("--no-health-check", action="store_true")
    parser.add_argument("--delete-backup", action="store_true",
                        help="delete the local backup after a fully verified success")
    parser.add_argument("--port", type=int, default=18000)
    args = parser.parse_args()

    if args.verify_backup:
        manifest = validate_backup(Path(args.verify_backup).expanduser().resolve())
        print(json.dumps(manifest, indent=2))
        return

    sdk = Path(args.sdk_root)
    if args.backup_only:
        do_backup_only(args, sdk)
    elif args.restore_only:
        do_restore_only(args, sdk)
    else:
        do_install(args, sdk, Path(args.apk).expanduser().resolve())


if __name__ == "__main__":
    main()
