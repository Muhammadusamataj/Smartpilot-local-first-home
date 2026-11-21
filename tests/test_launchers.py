"""Unit tests for the desktop and Android launchers.

The launchers import ``app`` and ``waitress`` inside their entry points. We
replace both with lightweight fakes so nothing binds a port or starts a real
server. The tests only assert the order of the startup calls and the arguments
passed through to waitress.
"""

import os
import sys
from types import ModuleType

import pytest

import android_entry
import desktop_launcher


# The fake Flask app object handed to waitress.serve().
APP = object()

# Environment variables the launchers read or mutate. Clearing (and restoring
# via monkeypatch) keeps these tests independent of any real AUTH/host config.
LAUNCHER_ENV = (
    "SESSION_FILE",
    "PORT",
    "SERVER_HOST",
    "TAILSCALE_IP",
    "TUYA_NETWORK_HINT",
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "ALLOW_NO_AUTH",
)


@pytest.fixture
def calls(monkeypatch):
    """Install fake app/waitress modules and return the shared call log.

    Each entry is ``(name, ...)`` so the exact order of startup calls can be
    asserted. ``serve`` entries also carry the app object and its keyword args.
    """
    for key in LAUNCHER_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(android_entry, "_STARTED", False)
    monkeypatch.setattr(android_entry, "_SERVER", None)
    monkeypatch.setattr(android_entry, "_SERVER_DONE", None)

    log = []

    fake_app = ModuleType("app")
    fake_app.app = APP
    fake_app.auto_setup_if_needed = lambda: log.append(("auto_setup_if_needed",))
    fake_app.check_no_auth_binding = lambda host: log.append(
        ("check_no_auth_binding", host))

    class FakeServer:
        def __init__(self, application, kwargs):
            self.application = application
            self.kwargs = kwargs
            self.closed = False

        def run(self):
            pass

        def close(self):
            self.closed = True

    fake_waitress = ModuleType("waitress")
    fake_waitress.serve = lambda application, **kwargs: log.append(
        ("serve", application, kwargs))

    def create_server(application, **kwargs):
        log.append(("serve", application, kwargs))
        return FakeServer(application, kwargs)

    fake_waitress.create_server = create_server

    monkeypatch.setitem(sys.modules, "app", fake_app)
    monkeypatch.setitem(sys.modules, "waitress", fake_waitress)

    # The desktop main() should not probe for a real Tailscale client here.
    monkeypatch.setattr(desktop_launcher, "_tailscale_ipv4", lambda: "")

    return log


def test_desktop_checks_non_loopback_host_before_setup_and_serve(
        calls, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", [
        "desktop_launcher.py",
        "--no-browser",
        "--data-dir", str(tmp_path),
        "--host", "0.0.0.0",
        "--port", "9000",
    ])

    desktop_launcher.main()

    assert [entry[0] for entry in calls] == [
        "check_no_auth_binding",
        "auto_setup_if_needed",
        "serve",
    ]
    assert calls[0] == ("check_no_auth_binding", "0.0.0.0")
    _, application, kwargs = calls[-1]
    assert application is APP
    assert kwargs == {"host": "0.0.0.0", "port": 9000, "threads": 8}


def test_desktop_loopback_host_still_checks_before_serve(calls, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "argv", [
        "desktop_launcher.py",
        "--no-browser",
        "--data-dir", str(tmp_path),
        "--host", "127.0.0.1",
    ])

    desktop_launcher.main()

    assert [entry[0] for entry in calls] == [
        "check_no_auth_binding",
        "auto_setup_if_needed",
        "serve",
    ]
    assert calls[0] == ("check_no_auth_binding", "127.0.0.1")
    assert calls[-1][2] == {"host": "127.0.0.1", "port": 8000, "threads": 8}


def test_desktop_guard_failure_prevents_setup_and_serve(calls, monkeypatch, tmp_path):
    """A refusing guard must abort the start before waitress is called."""
    def refuse(host):
        calls.append(("check_no_auth_binding", host))
        raise RuntimeError("no auth on non-loopback")

    sys.modules["app"].check_no_auth_binding = refuse
    monkeypatch.setattr(sys, "argv", [
        "desktop_launcher.py",
        "--no-browser",
        "--data-dir", str(tmp_path),
        "--host", "0.0.0.0",
    ])

    with pytest.raises(RuntimeError, match="no auth on non-loopback"):
        desktop_launcher.main()

    assert calls == [("check_no_auth_binding", "0.0.0.0")]


def test_android_checks_guard_before_setup_and_serve(calls, monkeypatch, tmp_path):
    monkeypatch.setattr(android_entry, "_STARTED", False)

    android_entry.start(str(tmp_path), host="127.0.0.1", port=8123)

    assert [entry[0] for entry in calls] == [
        "check_no_auth_binding",
        "auto_setup_if_needed",
        "serve",
    ]
    assert calls[0] == ("check_no_auth_binding", "127.0.0.1")
    _, application, kwargs = calls[-1]
    assert application is APP
    assert kwargs == {"host": "127.0.0.1", "port": 8123, "threads": 8}


def test_android_remote_mode_sets_auth_before_binding(calls, monkeypatch, tmp_path):
    """Direct phone mode must carry credentials into app.py's auth guard."""
    monkeypatch.setattr(android_entry, "_STARTED", False)
    # start() writes os.environ directly; register the same keys with
    # monkeypatch so they are restored even though the fixture deleted them.
    monkeypatch.setenv("AUTH_USERNAME", "tuya")
    monkeypatch.setenv("AUTH_PASSWORD", "s3cret")

    android_entry.start(str(tmp_path), host="0.0.0.0", port=8000,
                        network_hint="192.168.100.0/24", tailscale_ip="100.113.16.78",
                        auth_user="tuya", auth_password="s3cret")

    assert os.environ["AUTH_USERNAME"] == "tuya"
    assert os.environ["AUTH_PASSWORD"] == "s3cret"
    assert os.environ["TUYA_NETWORK_HINT_EXPLICIT"] == "1"
    assert os.environ["TAILSCALE_IP"] == "100.113.16.78"
    assert calls[0] == ("check_no_auth_binding", "0.0.0.0")
    assert calls[-1][2] == {"host": "0.0.0.0", "port": 8000, "threads": 8}


def test_android_loopback_mode_does_not_set_auth(calls, monkeypatch, tmp_path):
    monkeypatch.setattr(android_entry, "_STARTED", False)

    android_entry.start(str(tmp_path), host="127.0.0.1", port=8000)

    assert "AUTH_USERNAME" not in os.environ
    assert "AUTH_PASSWORD" not in os.environ
    assert calls[-1][2] == {"host": "127.0.0.1", "port": 8000, "threads": 8}


def test_android_reconfigure_enables_remote_mode_in_process(calls, monkeypatch, tmp_path):
    """Toggling on must rebind without killing the process."""
    android_entry.start(str(tmp_path), host="127.0.0.1")
    first_server = android_entry._SERVER
    monkeypatch.setenv("AUTH_USERNAME", "tuya")
    monkeypatch.setenv("AUTH_PASSWORD", "s3cret")
    calls.clear()

    android_entry.reconfigure(str(tmp_path), host="0.0.0.0", port=8000,
                              tailscale_ip="100.113.16.78",
                              auth_user="tuya", auth_password="s3cret")

    assert first_server.closed is True
    assert android_entry._SERVER is not first_server
    assert os.environ["AUTH_USERNAME"] == "tuya"
    assert os.environ["AUTH_PASSWORD"] == "s3cret"
    assert calls[0] == ("check_no_auth_binding", "0.0.0.0")
    assert calls[-1][2] == {"host": "0.0.0.0", "port": 8000, "threads": 8}


def test_android_reconfigure_disables_remote_mode_in_process(calls, monkeypatch, tmp_path):
    """Toggling off must drop credentials and return to loopback."""
    monkeypatch.setenv("AUTH_USERNAME", "tuya")
    monkeypatch.setenv("AUTH_PASSWORD", "s3cret")
    android_entry.start(str(tmp_path), host="0.0.0.0",
                        auth_user="tuya", auth_password="s3cret")
    first_server = android_entry._SERVER
    calls.clear()

    android_entry.reconfigure(str(tmp_path), host="127.0.0.1", port=8000)

    assert first_server.closed is True
    assert "AUTH_USERNAME" not in os.environ
    assert "AUTH_PASSWORD" not in os.environ
    assert calls[0] == ("check_no_auth_binding", "127.0.0.1")
    assert calls[-1][2] == {"host": "127.0.0.1", "port": 8000, "threads": 8}


def test_android_second_start_does_not_start_twice(calls, monkeypatch, tmp_path):
    monkeypatch.setattr(android_entry, "_STARTED", False)

    android_entry.start(str(tmp_path), host="127.0.0.1", port=8123)
    assert android_entry._STARTED is True
    calls.clear()

    android_entry.start(str(tmp_path), host="127.0.0.1", port=8123)

    assert calls == []
