"""The Java foreground service and the Python entry point stay in sync."""

import os
import sys
import types

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


def test_loopback_start_still_works_without_credentials(monkeypatch):
    fake_app = types.ModuleType("app")
    flask_app = object()
    checked = []
    fake_app.app = flask_app
    fake_app.auto_setup_if_needed = lambda: None
    fake_app.check_no_auth_binding = lambda host=None: checked.append(host)
    monkeypatch.setitem(sys.modules, "app", fake_app)

    fake_waitress = types.ModuleType("waitress")
    fake_waitress.create_server = lambda app, host, port, threads: (app, host, port, threads)
    monkeypatch.setitem(sys.modules, "waitress", fake_waitress)

    server = android_entry._build_server("127.0.0.1", 8000)

    assert checked == ["127.0.0.1"]
    assert server == (flask_app, "127.0.0.1", 8000, 8)
