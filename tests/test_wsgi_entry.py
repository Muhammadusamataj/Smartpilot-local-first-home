"""The production WSGI entry point must guard the bind before serving."""
import importlib
import re
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def test_wsgi_entry_checks_the_bind_before_publishing_the_app(monkeypatch):
    fake_app_module = types.ModuleType("app")
    flask_app = object()
    checked = []
    fake_app_module.app = flask_app
    fake_app_module.check_no_auth_binding = lambda host=None: checked.append(host)
    monkeypatch.setitem(sys.modules, "app", fake_app_module)
    monkeypatch.delitem(sys.modules, "wsgi", raising=False)

    monkeypatch.setattr(sys, "argv", ["waitress-serve", "wsgi:app"])
    module = importlib.import_module("wsgi")

    assert checked == ["0.0.0.0"]
    assert module.app is flask_app
    assert module.application is flask_app


def test_wsgi_entry_fails_closed_when_the_guard_rejects_the_bind(monkeypatch):
    fake_app_module = types.ModuleType("app")
    fake_app_module.app = object()

    def reject(*args, **kwargs):
        raise RuntimeError("AUTH_USERNAME/AUTH_PASSWORD are not set")

    fake_app_module.check_no_auth_binding = reject
    monkeypatch.setitem(sys.modules, "app", fake_app_module)
    monkeypatch.delitem(sys.modules, "wsgi", raising=False)

    with pytest.raises(RuntimeError, match="AUTH_USERNAME/AUTH_PASSWORD"):
        importlib.import_module("wsgi")


def test_docker_images_start_through_the_guarded_wsgi_entry():
    root_dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    addon_dockerfile = (ROOT / "tuya_local_key" / "Dockerfile").read_text(encoding="utf-8")

    assert "wsgi:app" in root_dockerfile
    assert "wsgi:app" in addon_dockerfile
    assert re.search(r"^COPY .*\bwsgi\.py\b", root_dockerfile, re.M)
    assert "app:app" not in root_dockerfile
    assert "app:app" not in addon_dockerfile


@pytest.mark.parametrize(("argv", "addresses"), [
    (["waitress-serve", "--listen=127.0.0.1:8000", "wsgi:app"], ["127.0.0.1:8000"]),
    (["waitress-serve", "--listen", "[::1]:8000", "wsgi:app"], ["[::1]:8000"]),
    (["waitress-serve", "--host=127.0.0.1", "wsgi:app"], ["127.0.0.1"]),
    (["waitress-serve", "--listen=127.0.0.1:8000 0.0.0.0:8001", "wsgi:app"],
     ["127.0.0.1:8000", "0.0.0.0:8001"]),
])
def test_wsgi_checks_actual_cli_listeners(monkeypatch, argv, addresses):
    fake_app_module = types.ModuleType("app")
    fake_app_module.app = object()
    checked = []
    fake_app_module.check_no_auth_binding = lambda host: checked.append(host)
    monkeypatch.setitem(sys.modules, "app", fake_app_module)
    monkeypatch.delitem(sys.modules, "wsgi", raising=False)
    monkeypatch.setattr(sys, "argv", argv)

    importlib.import_module("wsgi")

    assert checked == addresses


def test_wsgi_cli_binding_cannot_be_overridden_by_loopback_env(monkeypatch):
    fake_app_module = types.ModuleType("app")
    fake_app_module.app = object()

    def guard(host):
        if host != "127.0.0.1:8000":
            raise RuntimeError("Refusing non-loopback listener")

    fake_app_module.check_no_auth_binding = guard
    monkeypatch.setitem(sys.modules, "app", fake_app_module)
    monkeypatch.delitem(sys.modules, "wsgi", raising=False)
    monkeypatch.setenv("HOST", "127.0.0.1")
    monkeypatch.setenv("WAITRESS_HOST", "127.0.0.1")
    monkeypatch.setattr(sys, "argv", [
        "waitress-serve", "--listen=127.0.0.1:8000 0.0.0.0:8001", "wsgi:app",
    ])

    with pytest.raises(RuntimeError, match="non-loopback"):
        importlib.import_module("wsgi")
