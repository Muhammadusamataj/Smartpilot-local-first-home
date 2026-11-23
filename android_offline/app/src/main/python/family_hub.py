"""Optional family hub: share an already-local device set with family phones.

One phone stays at home as the hub (its existing opt-in "Direct mode" provides
the LAN bind + Basic Auth). Other phones run the same app in *client* mode: the
WebView keeps talking to its own loopback server, and that server forwards only
a small allowlist of read/control API calls to the hub with the saved Basic
Auth credentials. Credentials live in an encrypted file, are never returned by
an API, never rendered in the UI and never logged. Device keys never leave the
hub, and no new cloud service is involved.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import os
import socket
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from flask import Blueprint, jsonify, request

import haier_control

bp = Blueprint("family_hub", __name__)

OFF, HUB, CLIENT = "off", "hub", "client"
MODES = {OFF, HUB, CLIENT}
TIMEOUT = 12

# Only read/control calls are forwarded. Endpoints that accept or export a
# local key (device add, restore, backup, Haier config/cloud login) are
# deliberately absent: a family member can press buttons, not re-key the hub.
ALLOWED = {
    ("GET", "/api/local/devices"),
    ("GET", "/api/local/preferences"),
    ("GET", "/api/local/scenes"),
    ("POST", "/api/local/scenes"),
    ("POST", "/api/local/scenes/run"),
    ("DELETE", "/api/local/scenes"),
    ("POST", "/api/local/ensure"),
    ("GET", "/api/local/status"),
    ("POST", "/api/local/command"),
    ("GET", "/api/local/scheduler"),
    ("POST", "/api/local/scheduler/tick"),
    ("GET", "/api/local/rules"),
    ("POST", "/api/local/rules"),
    ("DELETE", "/api/local/rules"),
    ("GET", "/api/local/events"),
    ("GET", "/api/local/usage"),
    ("GET", "/api/haier/devices"),
    ("GET", "/api/haier/discover"),
    ("POST", "/api/haier/mode"),
    ("POST", "/api/haier/pause"),
    ("POST", "/api/haier/read"),
    ("POST", "/api/haier/poll"),
    ("POST", "/api/haier/command"),
}


class FamilyError(RuntimeError):
    pass


def _file():
    return haier_control.LOCAL_FILE.with_name("family-hub.enc")


def _load() -> dict:
    path = _file()
    if not path.exists():
        return {"mode": OFF}
    cipher = haier_control._cipher()
    if cipher is None:
        return {"mode": OFF}
    try:
        data = json.loads(cipher.decrypt(path.read_bytes()))
    except Exception:
        return {"mode": OFF}
    if not isinstance(data, dict) or data.get("mode") not in MODES:
        return {"mode": OFF}
    return data


def _save(config: dict):
    haier_control._atomic_private(
        _file(), haier_control._cipher(create=True)
        .encrypt(json.dumps(config).encode("utf-8"))
    )


def _lan_ip() -> str:
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))  # chooses the Wi-Fi IP without sending data
            ip = probe.getsockname()[0]
        finally:
            probe.close()
        return ip if ip and not ip.startswith("127.") else ""
    except OSError:
        return ""


def _normalise_url(value: str) -> str:
    raw = str(value or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        raise FamilyError("Enter a valid hub address") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FamilyError("Enter the hub address, e.g. http://192.168.100.19:8000")
    if parts.username or parts.password:
        raise FamilyError("Do not put the login inside the address")
    if parts.hostname in ("127.0.0.1", "localhost", "::1"):
        raise FamilyError("Use the hub phone's Wi-Fi address, not this phone")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise FamilyError("Use the hub address without a path")
    try:
        address = ipaddress.IPv4Address(parts.hostname)
    except ipaddress.AddressValueError:
        raise FamilyError("Use the hub phone's numeric Wi-Fi address") from None
    if not any(address in ipaddress.ip_network(network) for network in (
            "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
        raise FamilyError("Only private LAN hub addresses are allowed")
    netloc = parts.netloc
    if parts.port is None and ":" not in netloc:
        netloc += ":8000"
    return f"{parts.scheme}://{netloc}"


def _auth_setting(name: str) -> str:
    """Match app.py's options.json precedence without importing at module load."""
    try:
        import app
        return str(app._setting(name) or "")
    except Exception:
        return str(os.environ.get(name) or "")


def status() -> dict:
    cfg = _load()
    mode = cfg.get("mode", OFF)
    return {
        "mode": mode,
        "direct_mode": bool(_auth_setting("AUTH_USERNAME") and _auth_setting("AUTH_PASSWORD")),
        "lan_ip": _lan_ip(),
        "hub_url": str(cfg.get("hub_url") or "") if mode == CLIENT else "",
        "connected": bool(cfg.get("last_ok")) if mode == CLIENT else False,
        "last_error": str(cfg.get("last_error") or "") if mode == CLIENT else "",
    }


def is_client() -> bool:
    return _load().get("mode") == CLIENT


def configure(mode: str = OFF, hub_url: str = "", username: str = "",
              password: str = "") -> dict:
    mode = str(mode or OFF).strip().lower()
    if mode not in MODES:
        raise FamilyError("Unknown family mode")
    if mode == CLIENT:
        saved = {
            "mode": CLIENT,
            "hub_url": _normalise_url(hub_url),
            "username": str(username or ""),
            "password": str(password or ""),
            "last_ok": False,
            "last_error": "",
        }
        if not saved["username"] or not saved["password"]:
            raise FamilyError("Hub username and password are required")
    else:
        saved = {"mode": mode}
    _save(saved)
    return status()


def disconnect() -> dict:
    try:
        _file().unlink()
    except FileNotFoundError:
        pass
    return status()


def should_proxy(method: str, path: str) -> bool:
    """Whether a request should go to the hub instead of being served locally."""
    if not is_client():
        return False
    route = str(path or "").split("?", 1)[0]
    return (str(method or "GET").upper(), route) in ALLOWED


def _mark(ok: bool, error: str = "") -> None:
    cfg = _load()
    if cfg.get("mode") != CLIENT:
        return
    cfg["last_ok"] = bool(ok)
    cfg["last_error"] = str(error or "")
    _save(cfg)


def proxy_request(method: str, path: str, body: bytes = b"", content_type: str = ""):
    """Forward one allowlisted call; return (status, raw_body, content_type)."""
    cfg = _load()
    if cfg.get("mode") != CLIENT:
        raise FamilyError("Family client mode is not enabled")
    route = str(path or "").split("?", 1)[0]
    if (str(method or "GET").upper(), route) not in ALLOWED:
        raise FamilyError("This action is not available through a family hub")

    url = str(cfg["hub_url"]).rstrip("/") + (path if str(path).startswith("/") else "/" + str(path))
    auth = base64.b64encode(
        f"{cfg.get('username', '')}:{cfg.get('password', '')}".encode("utf-8")
    ).decode("ascii")
    headers = {"Authorization": "Basic " + auth}
    if content_type:
        headers["Content-Type"] = str(content_type)
    req = Request(
        url,
        data=body if str(method).upper() in {"POST", "PUT", "PATCH", "DELETE"} else None,
        headers=headers,
        method=str(method or "GET").upper(),
    )
    try:
        # Never route a family credential through a system proxy.
        with build_opener(ProxyHandler({})).open(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "application/json")
            code = getattr(resp, "status", None) or resp.getcode()
    except HTTPError as exc:
        # Do not echo a hub error body: it can contain internal detail.
        _mark(False, f"Hub returned HTTP {exc.code}")
        raise FamilyError(f"Hub returned HTTP {exc.code}") from None
    except (URLError, OSError, TimeoutError):
        _mark(False, "Hub could not be reached")
        raise FamilyError("Hub could not be reached (same Wi-Fi? hub phone on?)") from None
    _mark(True)
    return int(code), raw, str(ctype or "application/json")


def check() -> dict:
    try:
        proxy_request("GET", "/api/local/devices", b"")
    except FamilyError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@bp.get("/api/family/status")
def family_status():
    return jsonify(status())


@bp.post("/api/family/config")
def family_config():
    data = request.get_json(silent=True) or {}
    try:
        result = configure(
            data.get("mode", OFF),
            data.get("hub_url", ""),
            data.get("username", ""),
            data.get("password", ""),
        )
    except FamilyError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({**result, "ok": True})


@bp.post("/api/family/check")
def family_check():
    return jsonify(check())


@bp.post("/api/family/disconnect")
def family_disconnect():
    return jsonify({**disconnect(), "ok": True})
