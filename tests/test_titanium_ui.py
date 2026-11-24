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


def test_offline_builder_rewrites_ssr_shell_without_device_commands(tmp_path):
    """Static UI conversion must not introduce HTTP APIs or nested HTML shell."""
    from importlib.util import module_from_spec, spec_from_file_location

    path = BACKEND.parents[4] / "tools/build_lovable_webview.py"
    spec = spec_from_file_location("build_lovable_webview", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)

    (tmp_path / "src/routes").mkdir(parents=True)
    (tmp_path / "src/router.tsx").write_text(
        'import { createRouter } from "@tanstack/react-router";\n'
        'export const getRouter = () => createRouter({\n'
        '    routeTree,\n'
        '});\n',
        encoding="utf-8",
    )
    (tmp_path / "src/routes/__root.tsx").write_text(
        'import appCss from "../styles.css?url";\n'
        'const route = {\n'
        '    links: [\n'
        '      {\n'
        '        rel: "stylesheet",\n'
        '        href: appCss,\n'
        '      },\n'
        '      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },\n'
        '      { rel: "preconnect", href: "https://fonts.googleapis.com" },\n'
        '      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },\n'
        '      {\n'
        '        rel: "stylesheet",\n'
        '        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&family=Sora:wght@500;600;700&display=swap",\n'
        '      },\n'
        '    ],\n'
        '  shellComponent: RootShell,\n'
        '};\n',
        encoding="utf-8",
    )

    module.make_webview_build(tmp_path)
    router = (tmp_path / "src/router.tsx").read_text(encoding="utf-8")
    root = (tmp_path / "src/routes/__root.tsx").read_text(encoding="utf-8")
    html = (tmp_path / "index.html").read_text(encoding="utf-8")

    assert "createHashHistory()" in router
    assert "shellComponent: undefined" in root
    assert "appCss" not in root
    assert "fonts.googleapis.com" not in root
    assert "fonts.gstatic.com" not in root
    assert "/src/pilot-spa.tsx" in html
    assert "UI preview only" in html
    assert 'href="local"' in html
    entry = (tmp_path / "src/pilot-spa.tsx").read_text(encoding="utf-8")
    assert "api/pilot-next/snapshot" in entry
    assert 'method: "GET"' in entry
    assert 'method: "POST"' not in entry
    assert "snapshot?.hardware_commands_enabled !== false" in entry
    assert "DEVICE_NAMES" in entry
    assert "Device cards below are demo only" in entry
    assert "sendCommand(" not in entry



def test_read_only_snapshot_never_exposes_credentials_or_unverified_status(
    tmp_path, monkeypatch,
):
    from types import SimpleNamespace

    class StubResponse:
        def get_json(self, silent=False):
            return {
                "devices": [
                    {"id": "private-id", "name": "Geyser", "verified": True,
                     "local_key": "never-expose-me", "ip": "192.168.1.5"},
                    {"id": "another", "name": "Bore Motor", "verified": False,
                     "local_key": "also-secret"},
                    {"id": "outside", "name": "Unrelated Device", "verified": True},
                ],
            }

    fake_tuya = SimpleNamespace(local_devices=lambda: StubResponse())
    fake_haier = SimpleNamespace(
        _load=lambda: {
            "pro": {"secret": "never-expose-me", "mode": "manual"},
            "ff": {"secret": "never-expose-me", "mode": "auto"},
        },
        _summary=lambda slot, entry: {
            "verified": slot == "pro", "mode": entry["mode"],
            "local_key": entry["secret"], "ip": "192.168.1.7",
        },
    )
    monkeypatch.setitem(sys.modules, "local_control", fake_tuya)
    monkeypatch.setitem(sys.modules, "haier_control", fake_haier)
    response = make_client(tmp_path, monkeypatch).get("/api/pilot-next/snapshot")
    assert response.status_code == 200
    assert response.json["source"] == "local_cache"
    assert response.json["read_only"] is True
    assert response.json["hardware_commands_enabled"] is False
    devices = response.json["devices"]
    assert len(devices) == 7
    assert {d["name"] for d in devices} == {
        "19HFAB T3 Pro", "FF Haier 19HFAB T3", "Water Tank",
        "First Floor Breaker", "Ground Floor", "Bore Motor", "Geyser",
    }
    by_name = {d["name"]: d for d in devices}
    assert by_name["19HFAB T3 Pro"]["controlMode"] == "manual"
    assert by_name["FF Haier 19HFAB T3"]["controlMode"] == "auto"
    assert by_name["19HFAB T3 Pro"]["connection"] == "online"
    assert by_name["FF Haier 19HFAB T3"]["connection"] == "unknown"
    assert by_name["Geyser"]["connection"] == "online"
    assert by_name["Bore Motor"]["connection"] == "unknown"
    assert by_name["Water Tank"]["connection"] == "unknown"
    payload = response.get_data(as_text=True)
    assert "never-expose-me" not in payload
    assert "192.168." not in payload
    assert "private-id" not in payload
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert make_client(tmp_path, monkeypatch).post(
        "/api/pilot-next/snapshot", json={"power": "on"}
    ).status_code == 405


def test_ambiguous_duplicate_names_are_never_claimed_online(tmp_path, monkeypatch):
    from types import SimpleNamespace

    class StubResponse:
        def get_json(self, silent=False):
            return {"devices": [
                {"name": "Geyser", "verified": True},
                {"name": "Geyser", "verified": True},
            ]}

    monkeypatch.setitem(sys.modules, "local_control",
                        SimpleNamespace(local_devices=lambda: StubResponse()))
    monkeypatch.setitem(sys.modules, "haier_control",
                        SimpleNamespace(_load=lambda: {},
                                        _summary=lambda *_: {"verified": False}))
    result = make_client(tmp_path, monkeypatch).get("/api/pilot-next/snapshot").json
    geyser = next(row for row in result["devices"] if row["name"] == "Geyser")
    assert geyser["connection"] == "unknown"
