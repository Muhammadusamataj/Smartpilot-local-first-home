"""Opt-in Titanium UI regression tests (no hardware, network or keystore)."""
from __future__ import annotations

import importlib
from pathlib import Path
import sys

from flask import Flask


BACKEND = Path(__file__).resolve().parents[1] / "android_offline/app/src/main/python"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

titanium_ui = importlib.import_module("titanium_ui")


def make_client(tmp_path, monkeypatch):
    monkeypatch.setattr(titanium_ui, "WEB_DIR", tmp_path)
    app = Flask(__name__)
    app.register_blueprint(titanium_ui.bp)
    app.config.update(TESTING=True)
    return app.test_client()


def test_missing_bundle_is_safe_and_keeps_old_controls(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    response = client.get("/pilot-next")
    assert response.status_code == 503
    assert b"Titanium preview not bundled" in response.data
    assert b'href="local"' in response.data
    assert response.headers["Cache-Control"] == "no-store"


def test_preview_serves_only_local_compiled_html(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text(
        '<!doctype html><div id="pilot-next-root"></div>'
        '<script src="static/pilot-next/assets/app.js"></script>',
        encoding="utf-8",
    )
    client = make_client(tmp_path, monkeypatch)
    response = client.get("/pilot-next")
    assert response.status_code == 200
    assert b"pilot-next-root" in response.data
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Cache-Control"] == "no-store"


def test_preview_exposes_no_write_endpoint(tmp_path, monkeypatch):
    client = make_client(tmp_path, monkeypatch)
    assert client.post("/pilot-next", json={"power": "on"}).status_code == 405
    assert client.post("/api/pilot-next/meta", json={"command": "on"}).status_code == 405
    result = client.get("/api/pilot-next/meta").json
    assert result["hardware_commands_enabled"] is False
    assert result["mode"] == "preview"
    assert result["bundle_ready"] is False


def test_builder_is_source_pinned():
    script = (BACKEND.parents[4] / "tools/build_lovable_webview.py").read_text(
        encoding="utf-8"
    )
    assert "ef0f9f88a9c3621d919d25116dc4e14fa3b74f1a" in script
    assert '"--frozen-lockfile"' in script
    assert "history: createHashHistory()" in script
    assert "sendCommand(" not in script
