"""Tests for the data-preserving APK migration helpers (no device required)."""
from __future__ import annotations

import hashlib
import io
import json
import tarfile

import pytest

from tools.install_preserving_data import (
    CRYPTO_FILES,
    REQUIRED_FILES,
    StepError,
    sha256_file,
    validate_backup,
    write_manifest,
)


def _make_backup(path, files: dict[str, bytes], *, prefix: str = "./") -> None:
    with tarfile.open(path, "w") as tar:
        for name, payload in files.items():
            info = tarfile.TarInfo(prefix + name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))


def _complete_files() -> dict[str, bytes]:
    files = {}
    for index in range(20):
        files[f"files/chaquopy/asset{index}.txt"] = b"x" * 64
    for name in REQUIRED_FILES:
        files[name] = b"secret" if name in CRYPTO_FILES else b"{}"
    files["files/haier-pilot.enc"] = b"encrypted"
    files["files/devices.cache"] = b"devices"
    return files


def test_validate_backup_accepts_complete_archive(tmp_path):
    backup = tmp_path / "data.tar"
    _make_backup(backup, _complete_files())

    manifest = validate_backup(backup)

    assert manifest["data_file"] == "data.tar"
    assert manifest["data_size"] == backup.stat().st_size
    assert manifest["data_sha256"] == sha256_file(backup)
    assert manifest["entries"] == len(_complete_files())
    assert manifest["required_present"] == list(REQUIRED_FILES)
    assert "files/haier-pilot.enc" in manifest["valuable_present"]
    assert "files/haier-cloud.enc" in manifest["valuable_missing"]


def test_validate_backup_rejects_missing_crypto_key(tmp_path):
    files = _complete_files()
    files.pop("files/haier-pilot.key")
    backup = tmp_path / "data.tar"
    _make_backup(backup, files)

    with pytest.raises(StepError, match="missing required files"):
        validate_backup(backup)


def test_validate_backup_rejects_empty_crypto_key(tmp_path):
    files = _complete_files()
    files["files/cache.key"] = b""
    backup = tmp_path / "data.tar"
    _make_backup(backup, files)

    with pytest.raises(StepError, match="empty encryption key"):
        validate_backup(backup)


def test_validate_backup_rejects_truncated_archive(tmp_path):
    backup = tmp_path / "data.tar"
    _make_backup(backup, _complete_files())
    payload = backup.read_bytes()
    backup.write_bytes(payload[: len(payload) // 2])

    with pytest.raises(StepError, match="corrupt or truncated"):
        validate_backup(backup)


def test_validate_backup_rejects_too_few_entries(tmp_path):
    backup = tmp_path / "data.tar"
    _make_backup(backup, {name: b"x" for name in REQUIRED_FILES})

    with pytest.raises(StepError, match="expected >= 15"):
        validate_backup(backup)


def test_validate_backup_rejects_missing_shared_prefs(tmp_path):
    files = {
        name: payload for name, payload in _complete_files().items()
        if not name.startswith("shared_prefs/")
    }
    files["files/extra.bin"] = b"padding"
    backup = tmp_path / "data.tar"
    _make_backup(backup, files)

    with pytest.raises(StepError, match="missing files/ or shared_prefs/"):
        validate_backup(backup)


def test_write_manifest_round_trip(tmp_path):
    backup = tmp_path / "data.tar"
    backup.write_bytes(b"payload")
    expected = hashlib.sha256(b"payload").hexdigest()

    manifest_path = write_manifest(backup, {"data_sha256": expected})

    assert manifest_path == backup.with_suffix(".json")
    assert json.loads(manifest_path.read_text(encoding="utf-8"))["data_sha256"] == expected
