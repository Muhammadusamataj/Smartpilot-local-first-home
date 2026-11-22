"""Additive coverage for the optional Haier cloud key-renewal path."""
import json

import haier_cloud_login as cloud
import haier_control as h
import pytest

KEY = "0123456789abcdef0123456789abcdef"
NEW_KEY = "fedcba9876543210fedcba9876543210"
DID = "3C1640F9099B"


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(h, "LOCAL_FILE", tmp_path / "haier.enc")
    monkeypatch.setattr(h, "KEY_FILE", tmp_path / "haier.key")
    config = h._load()
    config["pro"] = {**h._validate_device("192.168.100.19", DID, KEY, 500), "mode": "manual"}
    h._save(config)
    return config


def test_renew_updates_encrypted_config_without_returning_key(monkeypatch, isolated):
    calls = []

    def fake_request(host, path, payload, access, client_id, zone, method="POST"):
        calls.append(path)
        if path == cloud.LOGIN_PATH:
            return {"retCode": "00000", "data": {"tokenInfo": {
                "uhomeAccessToken": "access", "refreshToken": "refresh", "zoneInfo": "0"}}}
        if path == cloud.DEVICE_PATH:
            return {"retCode": "00000", "data": {"deviceInfos": [
                {"baseInfo": {"deviceId": DID, "deviceName": "Pro"}}]}}
        raise AssertionError(path)

    monkeypatch.setattr(cloud, "_request", fake_request)
    monkeypatch.setattr(cloud, "_gateway_keys",
                        lambda access, client_id, zone, ids: {DID: {"key": NEW_KEY, "version": 502}})

    result = cloud.renew("user@example.com", "secret")

    assert result["ok"] and result["renewed"] == {"pro": 502}
    assert NEW_KEY not in json.dumps(result)
    assert "refresh" not in json.dumps(result)
    saved = h._load()["pro"]
    assert saved["local_key"] == NEW_KEY and saved["key_version"] == 502
    assert saved["ip"] == "192.168.100.19" and saved["device_id"] == DID
    assert cloud.LOGIN_PATH in calls and cloud.DEVICE_PATH in calls


def test_status_and_sign_out_never_expose_secrets(monkeypatch, isolated):
    monkeypatch.setattr(cloud, "_request", lambda *a, **k: {
        "retCode": "00000", "data": {"tokenInfo": {
            "uhomeAccessToken": "access", "refreshToken": "refresh", "zoneInfo": "0"}}})
    monkeypatch.setattr(cloud, "_gateway_keys",
                        lambda access, client_id, zone, ids: {DID: {"key": NEW_KEY, "version": 502}})
    cloud.renew("user@example.com", "secret")

    status = cloud.status()
    assert status["logged_in"] and NEW_KEY not in json.dumps(status)
    assert "refresh" not in json.dumps(status)
    assert "haier-cloud.enc" not in json.dumps(status)

    assert cloud.sign_out()["logged_in"] is False
    assert cloud.status()["logged_in"] is False


def test_password_encryption_uses_hybrid_scheme():
    field, sesame = cloud._encrypt_password("secret")
    assert field and sesame and field != "secret"
    assert len(__import__("base64").b64decode(field)) % 16 == 0
