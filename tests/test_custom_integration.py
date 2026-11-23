"""Tests for the custom integration's pure helpers (no Home Assistant needed)."""

import asyncio
import importlib.util
import sys
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PURE = ROOT / "custom_components" / "mylocal_devices" / "pure.py"

spec = importlib.util.spec_from_file_location("mylocal_pure", PURE)
pure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pure)


def test_real_switch_wins_over_prepayment_switch():
    points = [
        {"dp": "11", "code": "prepayment_switch", "type": "boolean", "cloud_value": False},
        {"dp": "16", "code": "switch", "type": "boolean", "cloud_value": True},
    ]
    assert pure.primary_point(points)["dp"] == "16"
    assert pure.main_score(points[0]) > pure.main_score(points[1])


def test_switch_1_is_a_valid_main_toggle():
    point = {"dp": "1", "code": "switch_1", "type": "boolean", "cloud_value": False}
    assert pure.is_bool_point(point)
    assert pure.main_score(point) == 0


def test_bool_conversion_covers_cloud_and_live_values():
    assert pure.as_bool(True) is True
    assert pure.as_bool(1) is True
    assert pure.as_bool("on") is True
    assert pure.as_bool("OFF") is False
    assert pure.as_bool("unknown") is None


def test_live_value_overrides_cached_cloud_value():
    device = {
        "live_values": {"16": True},
        "points": [{"dp": "16", "code": "switch", "cloud_value": False}],
    }
    point = device["points"][0]
    assert pure.point_value(device, point) is True
    assert pure.point_value({"points": [point]}, point) is False


def test_live_power_dp_becomes_a_sensor_point_even_without_cached_spec():
    cached = [
        {"dp": "16", "code": "switch", "type": "boolean", "cloud_value": True},
    ]
    live = [
        {"dp": "16", "code": "switch", "type": "boolean", "value": True},
        {"dp": "18", "code": "18", "type": "", "value": 1234},
        {"dp": "19", "code": "19", "type": "", "value": 56},
    ]
    merged = pure.merge_live_points(cached, live)

    assert [point["dp"] for point in merged] == ["16", "18", "19"]
    power = merged[1]
    assert power["code"] == "18"
    assert pure.is_bool_point(power) is False
    assert pure.point_type(power) == "integer"
    assert pure.point_value({"live_values": {"18": 1234}}, power) == 1234
    assert merged[0]["cloud_value"] is True


def test_live_value_can_upgrade_a_cached_point_without_a_type():
    cached = [{"dp": "18", "code": "energy", "cloud_value": None}]
    merged = pure.merge_live_points(cached, [{"dp": "18", "value": 9.5}])

    assert merged[0]["cloud_value"] == 9.5
    assert pure.point_type(merged[0]) == ""  # float inference is not needed for a sensor
    assert pure.is_bool_point(merged[0]) is False


def test_custom_repository_slug_prefix_is_found():
    addons = [
        {"slug": "core_ssh", "name": "Terminal & SSH"},
        {"slug": "a1b2c3_tuya_local_key", "name": "MY Local Devices Tuya"},
    ]
    assert pure.find_addon(addons, "tuya_local_key") == "a1b2c3_tuya_local_key"


def test_addon_can_also_be_found_by_name():
    addons = [{"slug": "xyz_custom", "name": "MY Local Devices Tuya"}]
    assert pure.find_addon(addons, "tuya_local_key", "MY Local Devices Tuya") == "xyz_custom"


def test_diagnostics_sensor_allowlist_never_leaks_secrets_or_values():
    body = {
        "network": {
            "wifi": {"connected": True, "ipv4": "192.168.100.21/24",
                     "ssid": "secret-ssid", "dns": "1.1.1.1"},
            "vpn": {"connected": True, "tailscale_ip": "100.1.2.3"},
            "default_route": {"transport": "vpn", "is_default": True},
        },
        "addresses": {"saved_ip": "192.168.100.50", "reachable_confidence": "dp_response"},
        "tcp6668": {"state": "open", "elapsed_ms": 12.5},
        "protocol": {"detected": "3.4", "handshake": {
            "match": True, "session_key_installed": True, "error_kind": None}},
        "status": {"result": "ok", "dp_ids": ["1", "18"], "dps": {"1": True}},
        "history": {"fail_count": 3, "recovery_reason": "read_ok"},
        "local_key": "5vps+n4FwxR2?df;", "token": "secret-token",
    }

    clean = pure.sanitize_diagnostics(body)
    text = str(clean)

    assert clean["confidence"] == "dp_response"
    assert clean["tcp_state"] == "open"
    assert clean["protocol_detected"] == "3.4"
    assert clean["default_route"] == "vpn"
    assert clean["dp_ids"] == ["1", "18"]
    assert clean["fail_count"] == 3
    for forbidden in ("local_key", "token", "ssid", "dns", "dps", "secret", "1.1.1.1"):
        assert forbidden not in text


def test_diagnostics_sensor_rejects_malformed_and_unsafe_codes():
    clean = pure.sanitize_diagnostics({
        "history": {"fail_count": "many", "recovery_reason": "Traceback (most recent call last)"},
        "tcp6668": {"state": "OSError: [Errno 113] No route"},
    })
    assert clean["fail_count"] == 0
    assert clean["recovery_reason"] == ""
    assert clean["tcp_state"] == ""


def test_diagnostics_validates_addresses_and_booleans_strictly():
    clean = pure.sanitize_diagnostics({
        "network": {
            "source": "android_service", "observed_at": float("inf"),
            "wifi": {"connected": "false", "ipv4": "not-an-ip/24"},
            "vpn": {"connected": "YES", "tailscale_ip": "100.64.0.1"},
            "default_route": {"transport": "wifi", "is_default": "off"},
        },
        "addresses": {
            "saved_ip": "<script>alert(1)</script>",
            "reachable_ip": "192.168.1.50",
        },
        "protocol": {"handshake": {"match": "false", "attempted": 1}},
    })

    assert clean["network_source"] == "android_service"
    assert clean["network_observed_at"] is None
    assert clean["wifi_connected"] is False
    assert clean["wifi_ipv4"] == ""
    assert clean["vpn_connected"] is True
    assert clean["vpn_tailscale_ip"] == "100.64.0.1"
    assert clean["default_route_active"] is False
    assert clean["saved_ip"] == ""
    assert clean["reachable_ip"] == "192.168.1.50"
    assert clean["handshake_match"] is False
    assert clean["handshake_attempted"] is True


def _load_coordinator_module(monkeypatch):
    """Load the coordinator with minimal Home Assistant stand-ins."""
    package_name = "mylocal_devices_coordinator_test"
    package_dir = PURE.parent

    config_entries = types.ModuleType("homeassistant.config_entries")
    config_entries.ConfigEntry = type("ConfigEntry", (), {})
    core = types.ModuleType("homeassistant.core")
    core.HomeAssistant = type("HomeAssistant", (), {})
    exceptions = types.ModuleType("homeassistant.exceptions")
    exceptions.ConfigEntryNotReady = type("ConfigEntryNotReady", (Exception,), {})
    helpers = types.ModuleType("homeassistant.helpers")
    helpers.__path__ = []
    update_coordinator = types.ModuleType("homeassistant.helpers.update_coordinator")

    class DataUpdateCoordinator:
        def __class_getitem__(cls, item):
            return cls

        def __init__(self, hass, logger, *, name, update_interval):
            self.hass, self.logger = hass, logger
            self.name, self.update_interval = name, update_interval

    update_coordinator.DataUpdateCoordinator = DataUpdateCoordinator
    for name, module in {
        "homeassistant": types.ModuleType("homeassistant"),
        "homeassistant.config_entries": config_entries,
        "homeassistant.core": core,
        "homeassistant.exceptions": exceptions,
        "homeassistant.helpers": helpers,
        "homeassistant.helpers.update_coordinator": update_coordinator,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)
    sys.modules["homeassistant"].__path__ = []

    api = types.ModuleType(package_name + ".api")
    api.ApiError = type("ApiError", (Exception,), {})

    async def unavailable(*args, **kwargs):
        raise api.ApiError("add-on unavailable")

    api.api_request = unavailable
    const = types.ModuleType(package_name + ".const")
    const.CONF_ADDON_URL = "addon_url"
    const.DEFAULT_SCAN_INTERVAL = 20
    const.DOMAIN = "mylocal_devices"
    for name, module in {
        package_name + ".api": api,
        package_name + ".const": const,
        package_name + ".pure": pure,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)

    init_path = package_dir / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        package_name, init_path,
        submodule_search_locations=[str(package_dir)],
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_coordinator_clears_diagnostics_when_device_recovers(monkeypatch):
    module = _load_coordinator_module(monkeypatch)
    coordinator = module.MyLocalCoordinator(object(), "http://addon", {})
    coordinator._diagnostics_cache["plug1"] = (
        time.monotonic(), {"confidence": "read_ok"},
    )

    facts = asyncio.run(coordinator._async_diagnostics({"id": "plug1"}, False))

    assert facts == {}
    assert coordinator._diagnostics_cache == {}


def test_coordinator_drops_very_old_diagnostics_when_addon_is_offline(monkeypatch):
    module = _load_coordinator_module(monkeypatch)
    coordinator = module.MyLocalCoordinator(object(), "http://addon", {})
    coordinator._diagnostics_cache["plug1"] = (
        time.monotonic() - module.DIAGNOSTICS_MAX_AGE - 1,
        {"confidence": "read_ok"},
    )

    facts = asyncio.run(coordinator._async_diagnostics({"id": "plug1"}, True))

    assert facts == {}
    assert coordinator._diagnostics_cache == {}
