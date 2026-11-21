"""Tests for the custom integration's pure helpers (no Home Assistant needed)."""

import importlib.util
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
