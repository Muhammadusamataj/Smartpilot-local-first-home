"""Regression tests for the local-only control API and its state truthfulness."""

import contextlib
import datetime
import importlib
import json
import threading
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

    # Reload local_control first: its file paths are read at import time, and
    # app.py registers that exact blueprint object.
    import local_control
    local_control = importlib.reload(local_control)
    import app
    app = importlib.reload(app)
    app.app.config.update(TESTING=True)
    return app, local_control, devices_cache, lan_cache, profiles


def _device(device_id="plug1", key="5vps+n4FwxR2?df;"):
    return {
        "id": device_id, "name": "Plug", "local_key": key, "category": "plug",
        "ip": "192.168.1.50", "online": True,
        "function": {"switch_1": {"code": "switch_1", "type": "Boolean", "values": "{}"}},
        "status_range": {},
        "local_strategy": {"1": {"status_code": "switch_1", "value_convert": "raw"}},
    }


def _entry(body):
    return {"session_key": "test-session", "cached_at": time.time(), "body": body}


def _seed(local, devices_cache, lan_cache, device=None, results=None):
    device_cache.save(str(devices_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"devices": [device or _device()]}))
    device_cache.save(str(lan_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"results": results or {}, "summary": {"matched": len(results or {})}}))


def _seed_devices(local, devices_cache, lan_cache, devices):
    device_cache.save(str(devices_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"devices": devices}))
    device_cache.save(str(lan_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"results": {}, "summary": {"matched": 0}}))


def test_network_warning_flags_a_different_wifi(local_app, monkeypatch):
    _, local, *_ = local_app
    monkeypatch.setenv("TUYA_NETWORK_HINT", "192.168.10.29/24")
    monkeypatch.setenv("TUYA_NETWORK_HINT_EXPLICIT", "1")
    monkeypatch.delenv("LAN_SUBNET", raising=False)
    results = {"plug1": {"status": "unreachable", "ip": "192.168.100.12"}}

    warning = local._network_warning(results)

    assert warning["code"] == "subnet_mismatch"
    assert warning["local"] == "192.168.10.0/24"
    assert warning["devices"] == ["192.168.100.0/24"]


def test_network_warning_is_silent_for_a_routed_vlan(local_app, monkeypatch):
    _, local, *_ = local_app
    monkeypatch.setenv("TUYA_NETWORK_HINT", "192.168.10.29/24")
    monkeypatch.setenv("TUYA_NETWORK_HINT_EXPLICIT", "1")
    monkeypatch.setenv("LAN_SUBNET", "192.168.100.0/24")
    assert local._network_warning({"plug1": {"status": "unreachable", "ip": "192.168.100.12"}}) is None


def test_manual_add_accepts_real_non_hex_keys(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().post("/api/local/device", json={
        "name": "Plug", "id": "plug1", "local_key": "5vps+n4FwxR2?df;",
        "ip": "192.168.1.50", "version": "3.4", "dp": "1",
    })

    assert response.status_code == 200, response.get_json()
    saved = local._devices()[0]
    assert saved["local_key"] == "5vps+n4FwxR2?df;"
    assert saved["online"] is False
    assert local._results()["plug1"]["status"] == "unverified"
    assert json.loads(Path(profiles).read_text(encoding="utf-8"))["plug1"]["last_ok"] == 0


@pytest.mark.parametrize("key", ["short", "a" * 33, "has space in it", ""])
def test_manual_add_rejects_invalid_keys(local_app, key):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().post("/api/local/device", json={
        "name": "Plug", "id": "plug1", "local_key": key, "ip": "192.168.1.50",
    })

    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_local_key"


def test_manual_device_can_be_edited_in_place(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().put("/api/local/device", json={
        "id": "plug1", "name": "Kitchen Plug", "ip": "192.168.1.77", "version": "3.5",
    })

    assert response.status_code == 200, response.get_json()
    row = app.app.test_client().get("/api/local/devices").get_json()["devices"][0]
    assert row["name"] == "Kitchen Plug"
    assert row["ip"] == "192.168.1.77"
    assert row["version"] == "3.5"
    assert "local_key" not in row
    assert len(local._devices()) == 1
    assert local._devices()[0]["local_key"] == "5vps+n4FwxR2?df;"
    assert local._results()["plug1"]["status"] == "unverified"
    assert json.loads(Path(profiles).read_text(encoding="utf-8"))["plug1"]["ip"] == "192.168.1.77"


def test_edit_can_replace_key_without_echoing_it(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().put("/api/local/device", json={
        "id": "plug1", "name": "Plug", "ip": "192.168.1.50", "version": "3.4",
        "local_key": "N3w!KeyAbcd#1234",
    })

    assert response.status_code == 200, response.get_json()
    assert "local_key" not in response.get_json()
    assert local._devices()[0]["local_key"] == "N3w!KeyAbcd#1234"
    assert "local_key" not in app.app.test_client().get("/api/local/devices").get_json()["devices"][0]


def test_edit_rejects_unknown_device_bad_ip_and_future_version(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    client = app.app.test_client()

    assert client.put("/api/local/device", json={
        "id": "missing", "name": "X", "ip": "192.168.1.50", "version": "3.4",
    }).status_code == 404
    bad_ip = client.put("/api/local/device", json={
        "id": "plug1", "name": "X", "ip": "999.1.1.1", "version": "3.4",
    })
    assert bad_ip.status_code == 400
    assert bad_ip.get_json()["error"] == "invalid_ip"
    bad_version = client.put("/api/local/device", json={
        "id": "plug1", "name": "X", "ip": "192.168.1.50", "version": "3.6",
    })
    assert bad_version.status_code == 400
    assert bad_version.get_json()["error"] == "invalid_version"


def test_local_trailing_slash_redirects_to_canonical_base(local_app):
    app, *_ = local_app

    response = app.app.test_client().get("/local/")

    assert response.status_code == 308
    assert response.headers["Location"].endswith("/local")


def test_saved_ip_is_not_reported_as_online_when_reads_are_stale(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    old = time.time() - 7200
    _seed(local, devices_cache, lan_cache)
    Path(profiles).write_text(json.dumps({
        "plug1": {"ip": "192.168.1.50", "version": "3.4", "last_ok": old,
                  "checked_at": old, "fail_count": 0},
    }), encoding="utf-8")

    data = app.app.test_client().get("/api/local/devices").get_json()
    row = data["devices"][0]

    assert row["reachable"] is True, "address is still known for retries"
    assert row["verified"] is False
    assert row["status_label"] == "Address saved"


def test_failed_reads_stop_the_saved_profile_from_pretending_success(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    old = time.time() - 7200
    _seed(local, devices_cache, lan_cache)
    Path(profiles).write_text(json.dumps({
        "plug1": {"ip": "192.168.1.50", "version": "3.4", "last_ok": old,
                  "checked_at": old, "fail_count": 3, "last_failed": time.time()},
    }), encoding="utf-8")

    merged = local._merged_results()["plug1"]
    assert merged["status"] != local.lan_scan.OK
    row = app.app.test_client().get("/api/local/devices").get_json()["devices"][0]
    assert row["verified"] is False


def test_fresh_gateway_result_is_not_overwritten_by_stale_child_profile(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    old = time.time() - 7200
    child = _device("sensor1", "Ab3!kQ9zPl2#mNvX")
    child["gateway_id"] = "gw1"
    child["node_id"] = "node1"
    gateway = _device("gw1", "Zz00Yy11Xx22Ww33")
    _seed(local, devices_cache, lan_cache, None, {
        "gw1": {"status": "ok", "ip": "192.168.1.60", "version": "3.4",
                "checked_at": time.time()},
        "sensor1": {"status": "via_gateway", "gateway_id": "gw1",
                    "checked_at": time.time()},
    })
    devices = local._devices()
    device_cache.save(str(devices_cache), local.DEVICE_CACHE_KEY_FILE,
                      _entry({"devices": [gateway, child]}))
    Path(profiles).write_text(json.dumps({
        "sensor1": {"ip": "192.168.1.99", "version": "3.4", "last_ok": old,
                    "checked_at": old, "fail_count": 0},
    }), encoding="utf-8")

    merged = local._merged_results()["sensor1"]
    assert merged["status"] == "via_gateway"
    assert "ip" not in merged, "a stale child IP must not masquerade as the gateway's reply"
    rows = {row["id"]: row for row in
            app.app.test_client().get("/api/local/devices").get_json()["devices"]}
    assert rows["sensor1"]["verified"] is False


def test_command_requires_successful_readback(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, results={
        "plug1": {"status": "ok", "ip": "192.168.1.50", "version": "3.4",
                  "checked_at": time.time()},
    })
    monkeypatch.setattr(local.device_values, "read", lambda context: {
        "status": "ok", "dps": {"1": False}, "read_at": time.time(),
    })
    monkeypatch.setattr(local.lan_scan, "_new_device", lambda *args, **kwargs: _FakeDevice())

    response = app.app.test_client().post("/api/local/command", json={
        "device_id": "plug1", "dp": "1", "value": True,
    })

    assert response.status_code == 502
    assert response.get_json()["error"] == "readback_mismatch"


class _FakeDevice:
    disabledetect = False
    dev_type = ""

    def set_dpsUsed(self, value):
        pass

    def set_value(self, dp, value):
        return {}

    def close(self):
        pass


def test_failed_status_uses_an_error_http_code(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, results={
        "plug1": {"status": "ok", "ip": "192.168.1.50", "version": "3.4",
                  "checked_at": time.time()},
    })
    monkeypatch.setattr(local.device_values, "read", lambda context: {"status": "unreachable"})

    response = app.app.test_client().get("/api/local/status?id=plug1")

    assert response.status_code == 502
    assert response.get_json()["code"] == "unreachable"


@pytest.mark.parametrize("bad_id", ["plug/1", "plug 1", "ünicode", "x" * 65])
def test_preferences_reject_non_hex_favorite_ids(local_app, bad_id):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().post("/api/local/preferences", json={
        "favorites": [bad_id], "rooms": {}, "homes": [],
    })

    # IDs must match [A-Za-z0-9_-]{1,64}; "plug1" is valid, these are not.
    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_favorites"
    assert local._load_preferences()["favorites"] == []


def test_preferences_round_trip_never_stores_local_keys(local_app, tmp_path):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    body = {
        "favorites": ["plug1"],
        "rooms": {"plug1": "Kitchen"},
        "homes": [{"id": "home1", "name": "Flat"}],
    }

    response = app.app.test_client().post("/api/local/preferences", json=body)

    assert response.status_code == 200
    saved = response.get_json()
    assert set(saved) == {"favorites", "rooms", "homes", "updated_at"}
    assert saved["favorites"] == ["plug1"]
    assert saved == local._load_preferences()
    assert saved == app.app.test_client().get("/api/local/preferences").get_json()
    raw = (tmp_path / "local-preferences.json").read_text(encoding="utf-8")
    assert "local_key" not in raw
    assert _device()["local_key"] not in raw


def test_device_rows_expose_favorite_and_room_home_metadata(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    plugged = _device()
    plugged.update({
        "room_id": "room1", "room_name": "Kitchen",
        "home_id": "home1", "home_name": "Flat",
    })
    other = _device("plug2", "Ab3!kQ9zPl2#mNvX")
    other.update({"room_id": "", "room_name": ""})
    _seed_devices(local, devices_cache, lan_cache, [plugged, other])
    client = app.app.test_client()
    assert client.post("/api/local/preferences", json={
        "favorites": ["plug1"], "rooms": {},
        "homes": [{"id": "home1", "name": "Flat"}],
    }).status_code == 200

    rows = {row["id"]: row for row in client.get("/api/local/devices").get_json()["devices"]}

    assert rows["plug1"]["favorite"] is True
    assert rows["plug1"]["room_id"] == "room1"
    assert rows["plug1"]["room_name"] == "Kitchen"
    assert rows["plug1"]["room_status"] == "assigned"
    assert rows["plug1"]["home_id"] == "home1"
    assert rows["plug1"]["home_name"] == "Flat"
    assert rows["plug2"]["favorite"] is False
    assert rows["plug2"]["room_status"] == "unassigned"
    assert rows["plug2"]["room_name"] == ""


def test_dp_schema_exposes_scale_and_unit_for_readings(local_app):
    """Tuya's own schema supplies the divisor and unit; no APK is needed."""
    app, local, devices_cache, lan_cache, _ = local_app
    breaker = _device()
    breaker.update({
        "name": "Water Tank",
        "status_range": {
            "forward_energy_total": {
                "code": "forward_energy_total", "type": "Integer",
                "values": json.dumps({"unit": "kW\ufffdh", "min": 0,
                                      "max": 99999999, "scale": 2, "step": 1}),
            },
            "phase_a": {"code": "phase_a", "type": "Raw", "values": "{}"},
        },
        "status": {"forward_energy_total": 12150},
        "local_strategy": {
            "1": {"status_code": "forward_energy_total"},
            "6": {"status_code": "phase_a"},
        },
    })
    _seed_devices(local, devices_cache, lan_cache, [breaker])

    points = {item["code"]: item for item in local._points(breaker)}
    energy = points["forward_energy_total"]
    assert energy["scale"] == 2
    assert energy["unit"] == "kWh"
    assert energy["min"] == 0 and energy["max"] == 99999999
    assert "scale" not in points["phase_a"]


@pytest.mark.parametrize("values,expected", [
    ({"unit": "mA", "scale": 0}, {"scale": 0, "unit": "mA"}),
    ({"unit": "<script>", "scale": 99}, {}),
    ({"unit": "nonsense", "scale": 1.5}, {}),
    ({"unit": " V", "scale": 2.0}, {"scale": 2, "unit": "V"}),
])
def test_dp_schema_rejects_unknown_units_and_bad_scales(local_app, values, expected):
    app, local, devices_cache, lan_cache, _ = local_app
    assert local._range({"values": json.dumps(values)}) == expected


@pytest.mark.parametrize("payload,error", [
    ({"name": "Scene", "actions": [
        {"device_id": "missing", "dp": "1", "value": True}]}, "unknown_device"),
    ({"name": "Scene", "actions": [
        {"device_id": "plug1", "dp": "x", "value": True}]}, "invalid_action"),
    ({"name": "Scene", "actions": [
        {"device_id": "plug1", "dp": "2", "value": 1}]}, "unknown_dp"),
    ({"name": "Scene", "actions": [
        {"device_id": "plug1", "dp": "1", "value": {"bad": 1}}]}, "invalid_value"),
    ({"name": "Scene", "actions": [
        {"device_id": "plug1", "dp": "1", "value": True}] * 21}, "invalid_actions"),
])
def test_scene_create_validates_devices_dps_and_values(local_app, payload, error):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().post("/api/local/scenes", json=payload)

    assert response.status_code == 400
    assert response.get_json()["error"] == error
    assert local._load_scenes() == []


def test_scene_create_and_get_expose_the_documented_shape(local_app, tmp_path):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    client = app.app.test_client()

    response = client.post("/api/local/scenes", json={
        "name": "Movie", "icon": "film",
        "actions": [{"device_id": "plug1", "dp": "1", "value": True}],
        "schedule": {"enabled": True, "time": "21:30", "days": [4, 6]},
    })

    assert response.status_code == 200
    scene = response.get_json()["scene"]
    assert set(scene) == {
        "id", "name", "icon", "actions", "schedule",
        "created_at", "updated_at", "last_run",
    }
    assert scene["schedule"] == {"enabled": True, "time": "21:30", "days": [4, 6]}
    assert scene["actions"] == [{"device_id": "plug1", "dp": "1", "value": True}]
    assert scene["last_run"] == ""
    data = client.get("/api/local/scenes").get_json()
    assert data["scenes"] == [scene]
    assert data["scheduler"]["available"] is True
    assert data["scheduler"]["note"] == local.SCHEDULER_NOTE
    raw = (tmp_path / "local-scenes.json").read_text(encoding="utf-8")
    assert "local_key" not in raw
    assert _device()["local_key"] not in raw


def test_scene_run_reports_partial_failure_without_faking_success(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed_devices(local, devices_cache, lan_cache, [
        _device(), _device("plug2", "Ab3!kQ9zPl2#mNvX"),
    ])
    monkeypatch.setattr(local, "_context", lambda device_id: {"device_id": device_id})

    def fake_send(context, dp, value):
        if context["device_id"] == "plug1":
            return {"ok": True, "confirmed": True}
        return {"ok": False, "error": "readback_mismatch"}

    monkeypatch.setattr(local, "_send", fake_send)
    client = app.app.test_client()
    created = client.post("/api/local/scenes", json={
        "name": "Two plugs",
        "actions": [
            {"device_id": "plug1", "dp": "1", "value": True},
            {"device_id": "plug2", "dp": "1", "value": True},
        ],
    }).get_json()["scene"]

    response = client.post("/api/local/scenes/run", json={"id": created["id"]})

    assert response.status_code == 200
    body = response.get_json()
    assert set(body) == {"ok", "succeeded", "failed", "results"}
    assert body["ok"] is False
    assert (body["succeeded"], body["failed"]) == (1, 1)
    assert body["results"][0] == {
        "device_id": "plug1", "dp": "1", "ok": True, "error": None, "verified": True,
    }
    assert body["results"][1] == {
        "device_id": "plug2", "dp": "1", "ok": False,
        "error": "readback_mismatch", "verified": False,
    }
    assert local._load_scenes()[0]["last_run"] == datetime.date.today().isoformat()


def test_scene_run_returns_409_when_a_device_is_busy(local_app, monkeypatch):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    monkeypatch.setattr(local, "_context", lambda device_id: {"device_id": device_id})
    monkeypatch.setattr(
        local, "_send", lambda context, dp, value: {"ok": True, "confirmed": True})

    @contextlib.contextmanager
    def busy(_device_id):
        yield False

    monkeypatch.setattr(local, "_busy_guard", busy)
    client = app.app.test_client()
    created = client.post("/api/local/scenes", json={
        "name": "Busy", "actions": [{"device_id": "plug1", "dp": "1", "value": True}],
    }).get_json()["scene"]

    response = client.post("/api/local/scenes/run", json={"id": created["id"]})

    assert response.status_code == 409
    assert response.get_json() == {"error": "busy"}


def test_due_scenes_helper_checks_local_minute_day_and_last_run(local_app):
    _, local, *_ = local_app

    def make(scene_id, *, time="09:05", days=(4,), enabled=True, last_run=""):
        return {"id": scene_id, "last_run": last_run, "schedule": {
            "enabled": enabled, "time": time, "days": list(days),
        }}

    scenes = [
        make("due"), make("wrong_day", days=(3,)), make("wrong_time", time="09:06"),
        make("disabled", enabled=False),
        make("already", last_run="2026-11-20"),
    ]
    # 2026-11-20 is a Friday (weekday 4).
    now = datetime.datetime(2026, 11, 20, 9, 5)

    due = local._due_scenes(scenes, now)
    same_minute = local._due_scenes(scenes, now.timestamp())

    assert [scene["id"] for scene in due] == ["due"]
    assert [scene["id"] for scene in same_minute] == ["due"]


def test_scene_last_run_is_claimed_once_per_day(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)
    created = app.app.test_client().post("/api/local/scenes", json={
        "name": "Once", "actions": [{"device_id": "plug1", "dp": "1", "value": True}],
    }).get_json()["scene"]
    today = datetime.date.today().isoformat()

    assert local._set_scene_last_run(created["id"], today) is True
    assert local._set_scene_last_run(created["id"], today) is False
    assert local._load_scenes()[0]["last_run"] == today


def test_delete_unknown_scene_returns_404(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().delete("/api/local/scenes?id=missing")

    assert response.status_code == 404
    assert response.get_json()["error"] == "unknown_scene"


def test_scheduler_thread_is_not_started_in_tests(local_app):
    _, local, *_ = local_app

    assert local._testing_mode() is True
    assert local._scheduler_started is False
    assert not any(thread.name == "local-scenes-scheduler" and thread.is_alive()
                   for thread in threading.enumerate())


def _auto_results():
    return {"plug1": {"status": "unverified", "ip": "192.168.1.50",
                      "version": "auto", "checked_at": time.time()}}


def test_manual_add_accepts_auto_protocol(local_app):
    app, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().post("/api/local/device", json={
        "name": "Plug", "id": "plug1", "local_key": "5vps+n4FwxR2?df;",
        "ip": "192.168.1.50", "version": "auto", "dp": "1",
    })

    assert response.status_code == 200, response.get_json()
    assert local._results()["plug1"]["version"] == "auto"
    assert json.loads(Path(profiles).read_text(encoding="utf-8"))["plug1"]["version"] == "auto"


def test_edit_accepts_auto_protocol(local_app):
    app, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache)

    response = app.app.test_client().put("/api/local/device", json={
        "id": "plug1", "name": "Plug", "ip": "192.168.1.50", "version": "auto",
    })

    assert response.status_code == 200, response.get_json()
    assert response.get_json()["version"] == "auto"
    assert local._results()["plug1"]["version"] == "auto"


def test_connection_allow_auto_exposes_probe_context_without_leaking_it(local_app):
    _, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, results=_auto_results())
    devices, results = local._devices(), local._merged_results()

    context = local.device_values.connection(devices, results, "plug1", allow_auto=True)

    assert context["version"] == ""
    assert context["ip"] == "192.168.1.50"
    assert context["key"] == _device()["local_key"]  # private, never in an API reply
    with pytest.raises(local.device_values.ReadUnavailable):
        local.device_values.connection(devices, results, "plug1")


def test_auto_protocol_is_detected_once_then_cached(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, profiles = local_app
    _seed(local, devices_cache, lan_cache, results=_auto_results())
    probed = []

    def fake_probe(dev_id, ip, key, version, gateway=False):
        probed.append(version)
        return {"match": version == "3.3", "device22": False}

    monkeypatch.setattr(local.lan_scan, "probe", fake_probe)

    context = local._context("plug1")

    assert probed == ["3.3"]
    assert context["version"] == "3.3"
    assert local._results()["plug1"]["version"] == "3.3"
    assert json.loads(Path(profiles).read_text(encoding="utf-8"))["plug1"]["version"] == "3.3"
    # A cached version means later reads never pay the probe cost again.
    assert local._context("plug1")["version"] == "3.3"
    assert probed == ["3.3"]


def test_auto_protocol_with_no_answer_stays_unresolved(local_app, monkeypatch):
    _, local, devices_cache, lan_cache, _ = local_app
    _seed(local, devices_cache, lan_cache, results=_auto_results())
    monkeypatch.setattr(local.lan_scan, "probe", lambda *a, **k: {"match": False})

    with pytest.raises(local.device_values.ReadUnavailable) as error:
        local._context("plug1")

    assert str(error.value) == "missing_protocol"
    assert local._results()["plug1"]["version"] == "auto"
