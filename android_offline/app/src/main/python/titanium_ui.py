"""Optional Lovable Titanium preview: local HTML only, no device writes."""
from __future__ import annotations

from pathlib import Path

from flask import Blueprint, Response, jsonify, send_file

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
            'Your current device controls are unaffected.</p></main></html>',
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



# Only the seven explicitly named Smart Pilot devices are represented.
# Real identifiers, IP addresses, keys, and DP details never leave this endpoint.
_SWITCH_NAMES = (
    "Water Tank",
    "First Floor Breaker",
    "Ground Floor",
    "Bore Motor",
    "Geyser",
)
_AC_NAMES = (
    ("pro", "19HFAB T3 Pro"),
    ("ff", "FF Haier 19HFAB T3"),
)


@bp.get("/api/pilot-next/snapshot")
def pilot_next_snapshot():
    """Read cached status only, never initiate a LAN read or issue a command.

    Existing Flask authentication and origin protections apply to this path.
    A verified flag from the existing backend is the sole source of online
    truth. A missing/stale/unconfigured device is always unknown.
    """
    # Lazy imports keep this optional preview module safe to load on its own.
    import local_control
    import haier_control

    try:
        tuya_response = local_control.local_devices()
        tuya_data = tuya_response.get_json(silent=True) or {}
        if not isinstance(tuya_data, dict):
            tuya_data = {}
    except Exception:
        tuya_data = {}
    visible_tuya = [
        d for d in tuya_data.get("devices", [])
        if isinstance(d, dict)
    ] if isinstance(tuya_data.get("devices"), list) else []

    rows = []
    for slot, name in _AC_NAMES:
        verified = False
        mode = "unknown"
        try:
            config = haier_control._load()
            entry = config.get(slot, {})
            summary = haier_control._summary(slot, entry)
            verified = summary.get("verified") is True
            saved_mode = summary.get("mode")
            if saved_mode in {"manual", "auto"}:
                mode = saved_mode
        except Exception:
            pass
        rows.append({
            "name": name,
            "ecosystem": "haier",
            "connection": "online" if verified else "unknown",
            "controlMode": mode,
        })

    for name in _SWITCH_NAMES:
        matches = [d for d in visible_tuya if d.get("name") == name]
        # Ambiguous duplicate names cannot be mapped to a specific device.
        verified = len(matches) == 1 and matches[0].get("verified") is True
        rows.append({
            "name": name,
            "ecosystem": "tuya",
            "connection": "online" if verified else "unknown",
        })

    response = {
        "source": "local_cache",
        "read_only": True,
        "hardware_commands_enabled": False,
        "devices": rows,
    }
    reply = jsonify(response)
    reply.headers["Cache-Control"] = "no-store"
    reply.headers["X-Content-Type-Options"] = "nosniff"
    return reply
