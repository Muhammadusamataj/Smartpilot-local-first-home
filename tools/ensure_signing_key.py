#!/usr/bin/env python3
"""Keep the Android debug signing key stable across builds/machines.

The public APK on GitHub Releases is signed with a fixed certificate. If the
local keystore is lost, Gradle silently generates a new one and Android then
refuses to upgrade installed copies. This helper restores the key from a
private backup outside the repo and verifies its certificate fingerprint.

The keystore password is the standard public Android debug password; no secret
is printed or stored in the repository.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
from pathlib import Path

ALIAS = "androiddebugkey"
STOREPASS = "android"
PRIMARY = Path(__file__).resolve().parent / "keys" / "debug.keystore"
BACKUP = Path(os.environ.get("SMARTPILOT_SIGNING_HOME",
                             str(Path.home() / ".smartpilot-signing"))) / "debug.keystore"


def _keytool() -> str:
    java_home = os.environ.get("JAVA_HOME")
    candidates = []
    if java_home:
        candidates.append(str(Path(java_home) / "bin" / "keytool.exe"))
        candidates.append(str(Path(java_home) / "bin" / "keytool"))
    candidates += glob.glob(r"C:\Program Files\Java\*\bin\keytool.exe")
    candidates += glob.glob(r"C:\Program Files (x86)\Java\*\bin\keytool.exe")
    candidates.append("keytool")
    for candidate in candidates:
        if candidate == "keytool" or Path(candidate).is_file():
            return candidate
    raise SystemExit("keytool not found")


def fingerprint(path: Path) -> str:
    result = subprocess.run(
        [_keytool(), "-list", "-v", "-keystore", str(path),
         "-storepass", STOREPASS, "-alias", ALIAS],
        capture_output=True, text=True,
    )
    text = (result.stdout or "") + (result.stderr or "")
    match = re.search(r"SHA256:\s*([0-9A-Fa-f:]+)", text)
    if result.returncode != 0 or not match:
        raise SystemExit(f"Could not read signing key fingerprint from {path}")
    return match.group(1).replace(":", "").lower()


def ensure_key(expected_sha256: str) -> Path:
    expected = expected_sha256.replace(":", "").lower()

    if not PRIMARY.is_file() and BACKUP.is_file():
        PRIMARY.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(BACKUP, PRIMARY)
        print(f"+ restored signing key from {BACKUP}")

    if not PRIMARY.is_file():
        raise SystemExit(
            f"Signing key missing at {PRIMARY} and backup missing at {BACKUP}. "
            "Restore the private debug keystore before building."
        )

    actual = fingerprint(PRIMARY)
    if actual != expected:
        raise SystemExit(
            f"Signing key fingerprint {actual} does not match expected {expected}. "
            "Restore the correct private keystore from the backup."
        )

    if not BACKUP.is_file():
        BACKUP.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PRIMARY, BACKUP)
        print(f"+ saved signing key backup to {BACKUP}")

    print(f"+ signing key OK: {actual}")
    return PRIMARY


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from build_offline_apk import EXPECTED_SIGNER_SHA256
    ensure_key(EXPECTED_SIGNER_SHA256)
