"""Optional Lovable Titanium preview: local HTML only, no device writes."""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, Response, send_file

bp = Blueprint("titanium_ui", __name__)
WEB_DIR = Path(__file__).resolve().parent / "static" / "pilot-next"


@bp.get("/pilot-next")
def pilot_next_page():
    entry = WEB_DIR / "index.html"
    if not entry.is_file():
        return Response(
            '<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Smart Pilot Titanium Preview</title>'
            '<main style="font:16px system-ui;padding:24px;max-width:560px">'
            '<h1>Titanium preview not bundled</h1>'
            '<p>Offline Lovable assets are not installed yet. '
            'Your current device controls are unaffected.</p>'
            '<a href="local">Return to existing live controls</a></main></html>',
            status=503, mimetype="text/html",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    response = send_file(entry, mimetype="text/html", max_age=0)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@bp.get("/api/pilot-next/meta")
def pilot_next_meta():
    """Non-sensitive integration status; never probes or commands hardware."""
    return {
        "ui": "lovable-titanium",
        "mode": "preview",
        "hardware_commands_enabled": False,
        "bundle_ready": (WEB_DIR / "index.html").is_file(),
    }
