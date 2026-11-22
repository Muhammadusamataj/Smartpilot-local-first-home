"""Synthetic tests for the vendored local Haier decoder adapter — no hardware."""
from dataclasses import dataclass

import pytest

import haier_hrdp_adapter as adapter
import haismart_hrdp as hrdp

ENTRY = {
    "ip": "192.168.1.50",
    "device_id": "A1B2C3D4E5F6",
    "local_key": "c018aabbccddeeff0011223344556677",
    "key_version": 4,
    "uplus_id": "abcdef",
}


def _blob(length=127, indoor=50):
    raw = bytearray(length)
    raw[2:4] = b"\x27\x15"       # status report marker
    raw[80:82] = b"\xff\xff"     # EPP frame marker
    raw[90:92] = b"\x6d\x01"     # full-status command
    raw[92] = 10                 # target = 26 C
    raw[94] = (1 << 5) | 5       # cool + auto fan
    raw[97] = 1                  # power on
    if length >= 105:
        raw[104] = indoor        # original 127-byte indoor sensor offset
    if length >= 107:
        raw[106] = indoor        # derived 129-byte indoor sensor offset
    return bytes(raw)


def test_classic_status_maps_to_existing_smart_pilot_keys(monkeypatch):
    monkeypatch.setattr(adapter, "_hrdp", lambda: hrdp)
    monkeypatch.setattr(hrdp, "read_status", lambda *a, **kw: [_blob()])

    status = adapter.read_status(ENTRY)

    assert status["power_on"] is True
    assert status["target_c"] == 26
    assert status["room_c"] == 25
    assert status["hvac_mode"] == "cool"
    assert status["fan"] == "auto"
    assert status["layout"] == "classic-6"
    assert status["writable"] is True
    assert status["adapter"] == "haismart-hrdp"


def test_unknown_layout_is_readable_but_never_writable(monkeypatch):
    monkeypatch.setattr(adapter, "_hrdp", lambda: hrdp)
    monkeypatch.setattr(hrdp, "read_status", lambda *a, **kw: [_blob(129, indoor=48)])

    status = adapter.read_status(ENTRY)

    assert status["room_c"] == 24
    assert status["writable"] is False
    assert "read-only" in status["layout"]


def test_key_rotation_is_explained_without_echoing_the_key(monkeypatch):
    class Fake:
        LocalKeyRotated = hrdp.LocalKeyRotated

        @staticmethod
        def read_status(*args, **kwargs):
            return []

        @staticmethod
        def probe_localkey_version(*args, **kwargs):
            return 7

    monkeypatch.setattr(adapter, "_hrdp", lambda: Fake)

    with pytest.raises(adapter.LocalKeyRotation) as raised:
        adapter.read_status(ENTRY)

    message = str(raised.value)
    assert "v7" in message and "v4" in message
    assert ENTRY["local_key"] not in message


@dataclass(frozen=True)
class _Reply:
    device_id: str
    host: str
    uplus_id: str = "aabbccdd"
    port: int = 56800
    sdk_version: str = "2.0.0"
    firmware: tuple = ("1.0.0",)
    cloud_state: int = 1006

    @property
    def cloud_state_name(self):
        return "disconnected"

    @property
    def cloud_connected(self):
        return False


def test_discovery_returns_identity_only(monkeypatch):
    good = _Reply(device_id="A1B2C3D4E5F6", host="192.168.1.50")
    outside = _Reply(device_id="BBCCDDEEFF00", host="8.8.8.8")

    class Fake:
        @staticmethod
        def query(host, timeout=None):
            assert host == "192.168.1.50"
            return good

        @staticmethod
        def discover(broadcast=None, timeout=None):
            return [good, outside]

    monkeypatch.setattr(adapter, "_hrdp", lambda: Fake)

    rows = adapter.discover(host="192.168.1.50")
    assert len(rows) == 1
    assert rows[0]["ip"] == "192.168.1.50"
    assert rows[0]["device_id"] == "A1B2C3D4E5F6"
    assert rows[0]["cloud_state_name"] == "disconnected"
    assert all("local_key" not in key for row in rows for key in row)

    broadcast_rows = adapter.discover()
    assert [row["device_id"] for row in broadcast_rows] == ["A1B2C3D4E5F6"]
