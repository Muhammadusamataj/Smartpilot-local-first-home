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
    assert b'href="local"' not in response.data
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


def test_offline_builder_rewrites_ssr_shell_for_live_webview(tmp_path):
    """Static UI conversion must keep hash routing and a live local banner."""
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
        '};\n'
        'content: "Smart-home control prototype for Haier ACs and Smart Life devices. Preview only.",\n'
        'content: "Smart-home control prototype for Haier ACs and Smart Life devices. Preview only.",\n',
        encoding="utf-8",
    )
    (tmp_path / "src/components/sp").mkdir(parents=True)
    (tmp_path / "src/components/sp/AppShell.tsx").write_text(
        '<ShieldCheck className="size-3.5" aria-hidden /> {t("prototype")}\n'
        "No hardware is connected. Controls are previews and never reach your devices.\n"
        '{t("prototype")} · {t("previewOnly")}\n'
        '{t("prototype")} · {t("previewOnly")}\n',
        encoding="utf-8",
    )
    (tmp_path / "src/routes/climate.tsx").write_text(
        'import { PageHeader, PreviewBadge } from "@/components/sp/primitives";\n'
        "eyebrow={<PreviewBadge />}\n",
        encoding="utf-8",
    )
    (tmp_path / "src/routes/settings.tsx").write_text(
        'body: "Planned primary adapter. Not configured in this prototype.",\n'
        '    status: "Not configured",\n'
        'body: "5 devices catalogued. No account linked, no credentials stored.",\n'
        '    status: "Not connected",\n'
        'body: "2 ACs catalogued. The official HaiSmart app stays fully usable.",\n'
        '    status: "Not connected",\n'
        '<dd className="font-medium">Web UI prototype — no hardware control</dd>\n'
        "The Android app is a separate project and is not updated by this web prototype.\n"
        '              title="Hardware actuation"\n'
        '              body="Disabled in this prototype. Nothing is ever sent to a device."\n'
        '              checked={false}\n'
        '              locked\n',
        encoding="utf-8",
    )
    (tmp_path / "src/routes/activity.tsx").write_text(
        'import { DemoBadge, EmptyState, PageHeader, Panel, PreviewBadge } from "@/components/sp/primitives";\n'
        '{e.source === "demo" ? <DemoBadge /> : <PreviewBadge />}\n',
        encoding="utf-8",
    )
    (tmp_path / "src/routes/index.tsx").write_text(
        '"Home dashboard for your Haier ACs and Smart Life devices. Preview-only prototype.",\n',
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
    assert "Titanium Live" in html
    assert "UI preview only" not in html
    assert 'href="local"' not in html
    assert "@media (pointer: coarse)" in html
    assert "min-height: 44px" in html
    entry = (tmp_path / "src/pilot-spa.tsx").read_text(encoding="utf-8")
    assert "RouterProvider" in entry
    assert "getRouter" in entry
    assert "api/pilot-next/snapshot" not in entry
    assert "hardware_commands_enabled" not in entry
    assert "DEVICE_NAMES" not in entry
    assert "sendCommand(" not in entry
    # The live overlay must land under src/ (not the repo root) for Vite.
    overlay_adapter = tmp_path / "src/lib/smartpilot/local-backend-adapter.ts"
    assert overlay_adapter.is_file()
    assert "class LocalBackendAdapter" in overlay_adapter.read_text(encoding="utf-8")
    assert not (tmp_path / "lib/smartpilot/local-backend-adapter.ts").exists()
    home = (tmp_path / "src/routes/index.tsx").read_text(encoding="utf-8")
    assert "connection.state" in home
    assert "Approval-gated writes" in home
    assert "offlineDemo" not in home
    # Preview-only visible copy must be replaced honestly in the live bundle.
    shell = (tmp_path / "src/components/sp/AppShell.tsx").read_text(encoding="utf-8")
    assert "No hardware is connected" not in shell
    assert "Live local control · verified reads only" in shell
    assert "explicit approval" in shell
    climate = (tmp_path / "src/routes/climate.tsx").read_text(encoding="utf-8")
    assert "LiveBadge" in climate and "PreviewBadge" not in climate
    settings = (tmp_path / "src/routes/settings.tsx").read_text(encoding="utf-8")
    assert "Planned primary adapter. Not configured in this prototype." not in settings
    assert "Unverified writes are refused by the backend." in settings
    assert "@/lib/smartpilot/backend-api" in settings
    activity = (tmp_path / "src/routes/activity.tsx").read_text(encoding="utf-8")
    assert "PreviewBadge" not in activity
    assert "LiveBadge" in activity


def test_live_overlay_uses_existing_backend_endpoints_only():
    """Live adapter may only call the existing Flask read/command routes."""
    overlay = BACKEND.parents[4] / "tools/lovable_full_live"
    adapter = (overlay / "local-backend-adapter.ts").read_text(encoding="utf-8")
    assert 'const LOCAL = "/api/local"' in adapter
    assert 'const HAIER = "/api/haier"' in adapter
    assert "${LOCAL}/devices" in adapter
    assert "${LOCAL}/status?id=" in adapter
    assert "${LOCAL}/command" in adapter
    assert "${HAIER}/devices" in adapter
    assert "${HAIER}/poll" in adapter
    assert "${HAIER}/command" in adapter
    assert "${HAIER}/mode" in adapter
    assert "sendCommand(" in adapter
    assert "needs_approval" in adapter
    assert "Waiting for a verified local read" in adapter



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
