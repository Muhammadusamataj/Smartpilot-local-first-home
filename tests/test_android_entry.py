"""The Java foreground service and the Python entry point stay in sync."""

import os

import android_entry


def test_entry_point_exposes_service_helpers(monkeypatch):
    monkeypatch.setattr(android_entry, "_STARTED", False)
    monkeypatch.setattr(android_entry, "_SERVER", None)
    monkeypatch.setattr(android_entry, "_SERVER_DONE", None)
    monkeypatch.delenv("TUYA_NETWORK_HINT", raising=False)
    monkeypatch.delenv("TUYA_NETWORK_HINT_EXPLICIT", raising=False)

    assert android_entry.is_running() is False
    android_entry.update_network_hint(" 192.168.50.21/24 ")
    assert os.environ["TUYA_NETWORK_HINT"] == "192.168.50.21/24"
    assert os.environ["TUYA_NETWORK_HINT_EXPLICIT"] == "1"
    android_entry.stop()
    assert android_entry.is_running() is False
