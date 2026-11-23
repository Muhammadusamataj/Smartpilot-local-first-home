"""Additive coverage for the opt-in family hub / client proxy."""
import base64
import json

import haier_control
import pytest

import family_hub as fh

USER = "family"
PASSWORD = "super-secret-value"
HUB = "http://192.168.100.19:8000"


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(haier_control, "LOCAL_FILE", tmp_path / "haier.enc")
    monkeypatch.setattr(haier_control, "KEY_FILE", tmp_path / "haier.key")
    return tmp_path


def test_default_off_and_client_credentials_never_leak(isolated):
    assert fh.status()["mode"] == "off"
    result = fh.configure("client", HUB, USER, PASSWORD)
    assert result["mode"] == "client"
    assert result["connected"] is False
    blob = fh._file().read_bytes()
    assert PASSWORD.encode() not in blob
    assert USER.encode() not in blob
    status = fh.status()
    assert "username" not in json.dumps(status)
    assert "password" not in json.dumps(status)
    assert PASSWORD not in json.dumps(status)
    assert status["hub_url"] == HUB


def test_config_validation(isolated):
    with pytest.raises(fh.FamilyError):
        fh.configure("unknown")
    with pytest.raises(fh.FamilyError):
        fh.configure("client", "127.0.0.1:8000", USER, PASSWORD)
    with pytest.raises(fh.FamilyError):
        fh.configure("client", HUB, USER, "")
    with pytest.raises(fh.FamilyError):
        fh.configure("client", HUB + "/admin", USER, PASSWORD)
    assert fh.status()["mode"] == "off"


def test_config_rejects_public_and_link_local_addresses(isolated):
    for address in ("http://8.8.8.8:8000", "http://169.254.1.1:8000",
                    "http://172.32.0.1:8000", "http://hub.example:8000"):
        with pytest.raises(fh.FamilyError):
            fh.configure("client", address, USER, PASSWORD)
    assert fh.status()["mode"] == "off"


def test_disconnect_removes_saved_credentials(isolated):
    fh.configure("client", HUB, USER, PASSWORD)
    assert fh._file().exists()
    assert fh.disconnect()["mode"] == "off"
    assert not fh._file().exists()


def test_allowlist_blocks_key_and_config_endpoints(isolated):
    fh.configure("client", HUB, USER, PASSWORD)
    assert fh.should_proxy("GET", "/api/local/devices?id=abc")
    assert fh.should_proxy("POST", "/api/haier/command")
    for method, path in (
        ("GET", "/api/local/backup"),
        ("POST", "/api/local/restore"),
        ("POST", "/api/local/device"),
        ("POST", "/api/haier/config"),
        ("POST", "/api/haier/cloud/login"),
        ("GET", "/api/family/status"),
    ):
        assert not fh.should_proxy(method, path)
    with pytest.raises(fh.FamilyError):
        fh.proxy_request("POST", "/api/haier/config", b"{}")


def test_proxy_uses_basic_auth_and_returns_only_allowed_body(isolated, monkeypatch):
    fh.configure("client", HUB, USER, PASSWORD)
    seen = {}

    class FakeResponse:
        status = 200
        headers = {"Content-Type": "application/json"}

        def read(self):
            return b'{"devices":[]}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    class FakeOpener:
        def open(self, req, timeout):
            seen["req"] = req
            seen["timeout"] = timeout
            return FakeResponse()

    monkeypatch.setattr(fh, "build_opener", lambda *a, **k: FakeOpener())
    code, raw, ctype = fh.proxy_request("GET", "/api/local/devices?id=abc", b"")
    assert code == 200 and raw == b'{"devices":[]}' and "json" in ctype
    expected = "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    assert seen["req"].get_header("Authorization") == expected
    assert seen["req"].full_url.startswith(HUB)
    assert fh.status()["connected"] is True
    assert PASSWORD not in json.dumps(fh.status())


def test_client_mode_is_ignored_by_all_other_installs(isolated):
    assert not fh.should_proxy("GET", "/api/local/devices")
    with pytest.raises(fh.FamilyError):
        fh.proxy_request("GET", "/api/local/devices")


def test_app_forwards_only_allowlisted_paths(isolated, monkeypatch):
    import app as app_module

    monkeypatch.delenv("AUTH_USERNAME", raising=False)
    monkeypatch.delenv("AUTH_PASSWORD", raising=False)
    fh.configure("client", HUB, USER, PASSWORD)
    calls = []

    def fake_proxy(method, path, body=b"", content_type=""):
        calls.append((method, path))
        return 200, b'{"ok":true}', "application/json"

    monkeypatch.setattr(fh, "proxy_request", fake_proxy)
    client = app_module.app.test_client()
    response = client.get("/api/local/devices?id=abc")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}
    assert calls == [("GET", "/api/local/devices?id=abc")]

    calls.clear()
    response = client.get("/api/family/status")
    assert response.status_code == 200
    assert calls == []
    assert response.get_json()["mode"] == "client"
