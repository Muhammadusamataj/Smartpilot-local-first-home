"""P0 reliability regressions for LAN read recovery and diagnostics.

Everything here is read-only with respect to real hardware: sockets, TinyTuya
reads and probes are always mocked. No ON/OFF command is sent.
"""

import importlib
import json
import time
from pathlib import Path

import pytest

import device_cache


@pytest.fixture()
def local_app(tmp_path, monkeypatch):
    session = tmp_path / "session.json"
    key = tmp_path / "cache.key"
    devices_cache = tmp_path / "devices.cache"
    lan_cache = tmp_path / "lan.cache"
    profiles = tmp_path / "lan-profile.json"
    for name, value in {
        "SESSION_FILE": str(session),
        "DEVICE_CACHE_KEY_FILE": str(key),
        "DEVICE_CACHE_FILE": str(devices_cache),
        "LAN_CACHE_FILE": str(lan_cache),
        "LAN_PROFILE_FILE": str(profiles),
        "LOCAL_PREFS_FILE": str(tmp_path / "local-preferences.json"),
        "LOCAL_SCENES_FILE": str(tmp_path / "local-scenes.json"),
        "CHECK_FOR_UPDATES": "false",
    }.items():
        monkeypatch.setenv(name, value)

    import local_control
    local_control = importlib.reload(local_control)
    import app
    app = importlib.reload(app)
    app.app.config.update(TESTING=True)
    return app, local_control, devices_cache, lan_cache, profiles


def _entry(body):
    return {"session_key": "test-session", "cached_at": time.time(), "body": body}


def _device(device_id="plug1", key="5vps+n4FwxR2?df;"):
    return {
        "id": device_id, "name": "Plug", "local_key": key, "category": "plug",
        "ip": "192.168.1.50", "version": "3.4", "online": True,
        "function": {"switch_1": {"code": "switch_1", "type": "Boolean", "values": "{}"}},
        "status_range": {},
        "local_strategy": {"1": {"status_code": "switch_1", "value_convert": "raw"}},
    }


def _seed(local, devices_cache, lan_cache, profile=None):
    device_cache.save(str(devices_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"devices": [_device()]}))
    device_cache.save(str(lan_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"results": {}, "summary": {"matched": 0}}))
    if profile is not None:
        Path(local.LAN_PROFILE_FILE).write_text(json.dumps({"plug1": profile}),
                                                encoding="utf-8")


def _failing_profile():
    now = time.time()
    return {
        "ip": "192.168.1.50", "version": "3.4", "device22": False,
        "last_ok": now - 3600, "checked_at": now - 3600,
        "last_failed": now - 5, "fail_count": 3,
    }


def test_ensure_never_returns_all_saved_for_real_read_failures(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    captured = []

    def fake_ensure(reason=""):
        captured.append(reason)
        local._ensure_state["reason"] = reason

    monkeypatch.setattr(local, "_ensure_async", fake_ensure)
    local._ensure_state.update({"running": False, "reason": "all_saved"})

    body = app.app.test_client().post("/api/local/ensure").get_json()

    assert captured == ["read_failures"]
    assert body["reason"] != "all_saved"


def test_recovery_verifies_tcp_then_readback_without_scanning(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    monkeypatch.setattr(local, "_ensure_async", lambda reason="": None)
    monkeypatch.setattr(local.lan_scan, "tcp_state", lambda ip, seconds: local.lan_scan.OPEN)
    monkeypatch.setattr(local.lan_scan, "sweep", lambda *a, **k: pytest.fail("no subnet sweep"))
    reads = []

    def fake_read(context):
        reads.append(context["version"])
        if len(reads) == 1:
            return {"status": "key_or_protocol"}
        return {"status": "ok", "dps": {"1": False}, "read_at": time.time()}

    monkeypatch.setattr(local.device_values, "read", fake_read)
    probes = []

    def fake_probe(dev_id, ip, key, version, gateway=False):
        probes.append(version)
        return {"match": version == "3.5", "device22": False}

    monkeypatch.setattr(local.lan_scan, "probe", fake_probe)
    local._ensure_state["running"] = False

    local._ensure_connections()

    assert local._ensure_state["reason"] == "done"
    assert local._ensure_state["matched"] == 1
    assert reads == ["3.4", "3.5"]
    assert "3.4" not in probes, "the failed saved protocol is not probed again"
    assert probes and set(probes) <= {"3.3", "3.5"}, "bounded protocol retries at saved IP only"
    profile = json.loads(Path(local.LAN_PROFILE_FILE).read_text(encoding="utf-8"))["plug1"]
    assert profile["version"] == "3.5"
    assert profile["last_ok"] > profile["last_failed"]
    assert profile["fail_count"] == 0


def test_silent_device_is_not_probed_or_scanned(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    monkeypatch.setattr(local, "_ensure_async", lambda reason="": None)
    monkeypatch.setattr(local.lan_scan, "tcp_state", lambda ip, seconds: local.lan_scan.SILENT)
    monkeypatch.setattr(local.lan_scan, "probe",
                        lambda *a, **k: pytest.fail("no protocol probe when TCP is closed"))
    monkeypatch.setattr(local.lan_scan, "sweep",
                        lambda *a, **k: pytest.fail("no subnet sweep"))
    local._ensure_state["running"] = False

    local._ensure_connections()

    assert local._ensure_state["reason"] == "device_silent"
    assert local._ensure_state["matched"] == 0


def test_failure_backoff_is_bounded_and_jittered(local_app, monkeypatch):
    _, local, *_ = local_app
    scheduled = []
    monkeypatch.setattr(local.random, "uniform", lambda low, high: high)
    monkeypatch.setattr(local, "_ensure_async", lambda reason="": scheduled.append(reason))
    Path(local.LAN_PROFILE_FILE).write_text(json.dumps({"plug1": {
        "ip": "192.168.1.50", "version": "3.4", "fail_count": 2,
        "last_ok": time.time() - 100, "last_failed": time.time() - 10,
    }}), encoding="utf-8")

    local._remember_failure("plug1", {}, "unreachable")

    profile = json.loads(Path(local.LAN_PROFILE_FILE).read_text(encoding="utf-8"))["plug1"]
    assert profile["fail_count"] == 3
    assert 400 <= profile["next_attempt_at"] - time.time() <= 481
    assert scheduled == ["read_failures"]


def test_diagnostics_is_read_only_and_never_contains_secrets(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    monkeypatch.setattr(local.lan_scan, "tcp_state", lambda ip, seconds: local.lan_scan.OPEN)
    monkeypatch.setattr(local.lan_scan, "probe", lambda *a, **k: {
        "match": True, "device22": False, "error": None,
        "session_key_installed": True,
    })
    monkeypatch.setattr(local.device_values, "read", lambda context: {
        "status": "ok", "dps": {"1": False}, "read_at": time.time(),
    })
    before = Path(profiles).read_bytes()

    response = app.app.test_client().get("/api/local/diagnostics?id=plug1")
    body = response.get_json()
    text = json.dumps(body)

    assert response.status_code == 200
    assert body["status"]["result"] == "ok"
    assert body["status"]["dp_ids"] == ["1"]
    assert body["tcp6668"]["state"] == local.lan_scan.OPEN
    assert body["protocol"]["handshake"]["session_key_installed"] is True
    assert body["history"]["fail_count"] == 3
    for forbidden in ("local_key", "5vps+n4FwxR2?df;", "token", "password", "SESSION_FILE"):
        assert forbidden not in text
    assert Path(profiles).read_bytes() == before, "diagnostics must not mutate profile state"


def test_diagnostics_scanner_failure_is_reported_not_a_500(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    monkeypatch.setattr(local.lan_scan, "tcp_state", lambda ip, seconds: local.lan_scan.OPEN)
    monkeypatch.setattr(local.lan_scan, "probe", lambda *a, **k: {"match": True})
    monkeypatch.setattr(local.device_values, "read",
                        lambda context: (_ for _ in ()).throw(local.lan_scan.ScannerUnavailable()))

    response = app.app.test_client().get("/api/local/diagnostics?id=plug1")

    assert response.status_code == 200
    assert response.get_json()["status"]["result"] == "scanner_unavailable"


def test_android_network_facts_are_allowlisted(monkeypatch):
    import android_entry

    android_entry.update_network_facts(json.dumps({
        "source": "android_service", "observed_at": time.time(),
        "wifi": {"connected": True, "ipv4": "192.168.10.29/24", "ssid": "secret-ssid"},
        "vpn": {"connected": True, "tailscale_ip": "100.1.2.3"},
        "default_route": {"transport": "wifi", "is_default": True},
        "token": "do-not-leak",
    }))
    facts = android_entry.network_facts()

    assert facts["source"] == "android_service"
    assert facts["wifi"]["ipv4"] == "192.168.10.29/24"
    assert facts["default_route"]["transport"] == "wifi"
    assert "ssid" not in json.dumps(facts)
    assert "do-not-leak" not in json.dumps(facts)


def test_probe_only_detection_is_not_online(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache)
    Path(profiles).write_text(json.dumps({"plug1": {
        "ip": "192.168.1.50", "version": "3.4", "last_ok": 0,
        "checked_at": time.time(), "fail_count": 0,
    }}), encoding="utf-8")
    context = {"ip": "192.168.1.50", "host_id": "plug1", "node_id": "", "device22": False}

    local._store_detected_version("plug1", context, "3.5", False)

    merged = local._merged_results()["plug1"]
    assert merged["status"] == "unverified"
    profile = json.loads(Path(profiles).read_text(encoding="utf-8"))["plug1"]
    assert profile["last_ok"] == 0
    assert local._verified("plug1", context, merged, {"plug1": profile}) is False


def test_concurrent_polling_starts_only_one_recovery_worker(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    started = []
    real_thread = local.threading.Thread

    class RecordingThread(real_thread):
        def start(self):
            started.append(self.name)

    monkeypatch.setattr(local.threading, "Thread", RecordingThread)
    monkeypatch.setattr(local, "_ensure_connections", lambda: None)

    for _ in range(12):
        local._ensure_async("read_failures")

    assert started == ["local-reconnect"]
    assert local._ensure_state["running"] is True
    assert local._ensure_state["reason"] == "read_failures"


def test_transient_packet_loss_keeps_last_known_good_address(local_app):
    _, local, devices_cache, lan_cache, _ = local_app
    good = _failing_profile()
    good.update({"last_ok": time.time() - 10, "last_failed": 0, "fail_count": 0})
    _seed(local, devices_cache, lan_cache, good)
    results = {"plug1": {"status": "unreachable", "ip": "192.168.99.99",
                         "version": "3.5", "checked_at": time.time()}}

    ip, version = local._saved_address("plug1", results, {"plug1": good})
    merged = local._merged_results()["plug1"]

    assert (ip, version) == ("192.168.1.50", "3.4")
    assert merged["ip"] == "192.168.1.50", "a failed scan must not erase the good IP"


def test_diagnostics_reports_vpn_route_without_route_secrets(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, _failing_profile())
    monkeypatch.setattr(local.lan_scan, "tcp_state", lambda ip, seconds: local.lan_scan.SILENT)
    monkeypatch.setattr(local, "_diagnostic_network", lambda: {
        "source": "android_service", "observed_at": time.time(), "hint_only": False,
        "wifi": {"connected": True, "ipv4": "192.168.10.29/24"},
        "vpn": {"connected": True, "tailscale_ip": "100.1.2.3"},
        "default_route": {"transport": "vpn", "is_default": True},
    })

    body = app.app.test_client().get("/api/local/diagnostics?id=plug1").get_json()

    assert body["network"]["default_route"]["transport"] == "vpn"
    assert body["network"]["vpn"]["tailscale_ip"] == "100.1.2.3"
    assert body["tcp6668"]["state"] == local.lan_scan.SILENT
    assert body["addresses"]["reachable_ip"] is None
    assert body["status"]["result"] == "not_attempted"
