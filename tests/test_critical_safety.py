"""Regression tests for server-side critical-device safety and read scheduling.

The two-tap UI confirmation is presentation only. These tests prove the write
path and every unattended automation path refuse unsafe operations on their own.
"""

import json
import threading
import time
from pathlib import Path

from test_local_control import _device, _seed, _seed_devices, local_app  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
GEYSER = "bf04a442f57b19789dfflz"
BORE = "bf069004945cef348chgdf"


def test_critical_ids_match_frontend_classification():
    """Backend and UI must protect exactly the same five devices."""
    import local_control

    source = (ROOT / "static/js/features/local-control/main.js").read_text(encoding="utf-8")
    assert len(local_control.CRITICAL_DEVICE_IDS) == 5
    for device_id in local_control.CRITICAL_DEVICE_IDS:
        assert device_id in source


def test_critical_ids_match_pilot_extras():
    """The automation layer and LAN control layer must agree exactly."""
    import local_control
    import pilot_extras

    assert pilot_extras.CRITICAL_DEVICE_IDS == local_control.CRITICAL_DEVICE_IDS


def test_scene_never_operates_a_critical_device(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed_devices(local, devices_cache, lan_cache, [_device(GEYSER, "5vps+n4FwxR2?df;")])
    monkeypatch.setattr(local, "_context", lambda device_id: {"device_id": device_id})
    sent = []

    def fake_send(context, dp, value):
        sent.append((context["device_id"], dp))
        return {"ok": True, "confirmed": True}

    monkeypatch.setattr(local, "_send", fake_send)
    client = app.app.test_client()
    scene = client.post("/api/local/scenes", json={
        "name": "Night", "actions": [{"device_id": GEYSER, "dp": "1", "value": True}],
    }).get_json()["scene"]

    body = client.post("/api/local/scenes/run", json={"id": scene["id"]}).get_json()

    assert body["ok"] is False and body["failed"] == 1
    assert body["results"][0]["error"] == "critical_automation_blocked"
    assert sent == []  # no write reached the LAN driver


def test_critical_rule_is_rejected_at_save_time(local_app):
    app, *_ = local_app
    response = app.app.test_client().post("/api/local/rules", json={
        "name": "Geyser auto OFF", "kind": "on_duration",
        "device_id": GEYSER, "dp": "1", "minutes": 30,
        "action": False, "enabled": True,
    })
    assert response.status_code == 400
    assert response.get_json()["error"] == "critical_device_blocked"


def test_critical_command_requires_known_dp_and_fresh_verified_read(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, profiles = local_app
    _seed_devices(local, devices_cache, lan_cache, [_device(GEYSER, "5vps+n4FwxR2?df;")])
    monkeypatch.setattr(local, "_context", lambda device_id: {
        "device_id": device_id, "ip": "192.168.1.50", "version": "3.4",
    })
    sent = []

    def fake_send(context, dp, value):
        sent.append((dp, value))
        return {"ok": True, "confirmed": True}

    monkeypatch.setattr(local, "_send", fake_send)
    client = app.app.test_client()

    # No successful live read -> no write at all.
    response = client.post("/api/local/command", json={
        "device_id": GEYSER, "dp": "1", "value": True,
    })
    assert response.status_code == 403
    assert response.get_json()["code"] == "critical_unverified"

    # A saved timestamp authorises only a declared DP, never a raw number.
    stored = json.loads(Path(profiles).read_text(encoding="utf-8")) if Path(profiles).exists() else {}
    stored[GEYSER] = {"last_ok": time.time(), "last_failed": 0}
    Path(profiles).write_text(json.dumps(stored), encoding="utf-8")
    response = client.post("/api/local/command", json={
        "device_id": GEYSER, "dp": "99", "value": True,
    })
    assert response.status_code == 403
    assert response.get_json()["code"] == "critical_unknown_dp"
    assert sent == []

    # A verified device still accepts its normal, declared control.
    response = client.post("/api/local/command", json={
        "device_id": GEYSER, "dp": "1", "value": True,
    })
    assert response.status_code == 200
    assert sent == [("1", True)]


def test_status_read_queues_briefly_instead_of_dropping(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    monkeypatch.setattr(local, "_context", lambda device_id: {
        "device_id": device_id, "ip": "192.168.1.50", "version": "3.4",
        "host_id": device_id, "gateway_id": None, "key": "synthetic",
        "node_id": "", "device22": False, "gateway": False, "dp_ids": [],
    })
    monkeypatch.setattr(local.device_values, "read", lambda context: {
        "status": "ok", "dps": {"1": True}, "read_at": time.time(),
    })

    outcome = {}

    def call():
        try:
            outcome["code"] = app.app.test_client().get(
                "/api/local/status?id=plug1").status_code
        except Exception as error:  # pragma: no cover - diagnostic only
            outcome["error"] = repr(error)

    lock = local._device_lock("plug1")
    lock.acquire()
    worker = threading.Thread(target=call)
    worker.start()
    time.sleep(0.3)
    assert outcome == {}  # it waited for the in-flight operation
    lock.release()
    worker.join(timeout=5)
    assert outcome == {"code": 200}


def test_status_retries_bounded_but_writes_never_auto_retry():
    main = (ROOT / "static/js/features/local-control/main.js").read_text(encoding="utf-8")
    controls = (ROOT / "static/js/features/local-control/controls.js").read_text(encoding="utf-8")
    assert "attempt < 2" in main and "attempt < 3" not in main
    assert "never auto-retry a write" in controls
    assert "refreshLater(deviceId, card, refresh)" in controls
