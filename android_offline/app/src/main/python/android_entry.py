"""Entry point called from OfflineActivity via Chaquopy.

Runs the project's Flask app with waitress entirely on the device. All writable
state (session, encrypted caches, preferences) lives in the app's private files
directory, which Java passes in as `data_dir`.

For the opt-in "direct phone mode", Java passes a non-loopback `host` together
with Basic Auth credentials; loopback stays the default and needs no auth.
`reconfigure()` applies a later toggle change in-process, so no process kill
(or unreliable restart alarm) is needed.
"""

from __future__ import annotations

import ipaddress
import json
import math
import os
import sys
import threading
import time

_LOCK = threading.Lock()
_STARTED = False
_SERVER = None
_SERVER_DONE = None
# Allowlisted, non-secret Wi-Fi/VPN facts pushed by the Android service.
_NETWORK_FACTS: dict = {}
NETWORK_FACTS_MAX_AGE_SECONDS = 120

_ENV_KEYS = (
    "SESSION_FILE", "PORT", "SERVER_HOST", "TUYA_NETWORK_HINT",
    "TUYA_NETWORK_HINT_EXPLICIT", "TAILSCALE_IP", "AUTH_USERNAME", "AUTH_PASSWORD",
)


class ServerStillRunning(RuntimeError):
    """The previous waitress loop has not released the port yet."""


def _snapshot_env() -> dict:
    return {key: os.environ[key] for key in _ENV_KEYS if key in os.environ}


def _restore_env(snapshot: dict) -> None:
    for key in _ENV_KEYS:
        if key in snapshot:
            os.environ[key] = snapshot[key]
        else:
            os.environ.pop(key, None)


def _configure(data_dir: str, host: str, port: int, network_hint: str,
               tailscale_ip: str, auth_user: str, auth_password: str) -> None:
    """Publish the launch settings as environment variables for app.py."""
    os.makedirs(data_dir, exist_ok=True)
    os.environ["SESSION_FILE"] = os.path.join(data_dir, "session.json")
    os.environ["PORT"] = str(port)
    os.environ["SERVER_HOST"] = str(host)
    hint = str(network_hint or "").strip()
    if hint:
        # This comes from the phone's Wi-Fi manager, so it is proof of the
        # network the app is actually on (unlike a desktop default-route guess).
        os.environ["TUYA_NETWORK_HINT"] = hint
        os.environ["TUYA_NETWORK_HINT_EXPLICIT"] = "1"
    else:
        os.environ.pop("TUYA_NETWORK_HINT", None)
        os.environ.pop("TUYA_NETWORK_HINT_EXPLICIT", None)
    tailscale = str(tailscale_ip or "").strip()
    if tailscale:
        os.environ["TAILSCALE_IP"] = tailscale
    else:
        os.environ.pop("TAILSCALE_IP", None)
    # A non-loopback bind exposes device local keys, so credentials must be in
    # place before the app's auth guard is evaluated.
    if auth_user:
        os.environ["AUTH_USERNAME"] = str(auth_user).strip()
    else:
        os.environ.pop("AUTH_USERNAME", None)
    if auth_password:
        os.environ["AUTH_PASSWORD"] = str(auth_password)
    else:
        os.environ.pop("AUTH_PASSWORD", None)


def _prepare_import_path() -> None:
    # Chaquopy adds its source directory to sys.path; keep this robust.
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)


def _build_server(host: str, port: int):
    """Validate the new config and return an unstarted waitress server."""
    from app import app, auto_setup_if_needed, check_no_auth_binding
    from waitress import create_server

    check_no_auth_binding(host)
    auto_setup_if_needed()
    return create_server(app, host=host, port=int(port), threads=8)


def _run_server(server, done: threading.Event) -> None:
    """Block on waitress, then signal that the listening socket is released."""
    try:
        server.run()
    finally:
        done.set()


def _start_runner(server, done: threading.Event) -> None:
    """Own the blocking waitress loop without blocking the Java config task."""
    threading.Thread(target=_run_server, args=(server, done),
                     name="tuya-local-waitress", daemon=True).start()


def start(data_dir: str, host: str = "127.0.0.1", port: int = 8000,
          network_hint: str = "", tailscale_ip: str = "",
          auth_user: str = "", auth_password: str = "") -> None:
    """Start the embedded server once; the waitress loop runs on its own thread."""
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        if _STARTED:
            return
        snapshot = _snapshot_env()
        try:
            _configure(data_dir, host, port, network_hint, tailscale_ip,
                       auth_user, auth_password)
            _prepare_import_path()
            server = _build_server(host, port)
        except Exception:
            _restore_env(snapshot)
            _STARTED = False
            raise
        done = threading.Event()
        _SERVER = server
        _SERVER_DONE = done
        _STARTED = True
    _start_runner(server, done)


def is_running() -> bool:
    """Whether this process already owns a listening embedded server."""
    with _LOCK:
        return bool(_STARTED and _SERVER is not None)


def update_network_hint(hint: str) -> None:
    """Refresh the Wi-Fi hint used by the local scan without a restart."""
    value = str(hint or "").strip()
    if value:
        os.environ["TUYA_NETWORK_HINT"] = value
        os.environ["TUYA_NETWORK_HINT_EXPLICIT"] = "1"
    else:
        # Wi-Fi lost: an old hint must not look like current proof.
        os.environ.pop("TUYA_NETWORK_HINT", None)
        os.environ.pop("TUYA_NETWORK_HINT_EXPLICIT", None)


def _safe_network_text(value, *, ipv4: bool = False) -> str:
    text = str(value or "").strip()[:64]
    if not text:
        return ""
    try:
        if ipv4:
            ipaddress.IPv4Network(text, strict=False)
        else:
            ipaddress.ip_address(text)
        return text
    except ValueError:
        return ""


def _safe_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    return False


def update_network_facts(payload) -> None:
    """Store only allowlisted Android network facts for read-only diagnostics.

    No SSID, BSSID, DNS, token, URL or raw exception can reach this record.
    """
    global _NETWORK_FACTS
    try:
        data = json.loads(payload) if isinstance(payload, (str, bytes, bytearray)) else payload
    except (TypeError, ValueError):
        data = None
    if not isinstance(data, dict):
        data = {}
    wifi = data.get("wifi") if isinstance(data.get("wifi"), dict) else {}
    vpn = data.get("vpn") if isinstance(data.get("vpn"), dict) else {}
    route = data.get("default_route") if isinstance(data.get("default_route"), dict) else {}
    transport = str(route.get("transport") or "unknown").strip().lower()
    try:
        observed_at = float(data.get("observed_at") or time.time())
    except (TypeError, ValueError, OverflowError):
        observed_at = time.time()
    if not math.isfinite(observed_at):
        observed_at = time.time()
    facts = {
        "source": "android_service" if data.get("source") == "android_service" else "unavailable",
        "observed_at": observed_at,
        "wifi": {
            "connected": _safe_bool(wifi.get("connected")),
            "ipv4": _safe_network_text(wifi.get("ipv4"), ipv4=True),
        },
        "vpn": {
            "connected": _safe_bool(vpn.get("connected")),
            "tailscale_ip": _safe_network_text(vpn.get("tailscale_ip")),
        },
        "default_route": {
            "transport": transport if transport in {
                "wifi", "vpn", "cellular", "ethernet", "unknown",
            } else "unknown",
            "is_default": _safe_bool(route.get("is_default")),
        },
    }
    with _LOCK:
        _NETWORK_FACTS = facts


def network_facts() -> dict:
    """A copy of the last Android facts, labelled stale when too old.

    An empty result means "no usable Android facts"; local_control then falls
    back to the explicit env hint instead of treating an "unavailable"
    placeholder as real network evidence.
    """
    with _LOCK:
        facts = dict(_NETWORK_FACTS)
    if not facts or str(facts.get("source") or "") == "unavailable":
        return {}
    try:
        observed_at = float(facts.get("observed_at") or 0)
    except (TypeError, ValueError, OverflowError):
        observed_at = 0
    if not math.isfinite(observed_at) or time.time() - observed_at > NETWORK_FACTS_MAX_AGE_SECONDS:
        facts = dict(facts)
        facts["source"] = "stale"
    return facts


def _close_old_server_locked() -> None:
    """Close the previous server and prove its run loop really exited."""
    old = _SERVER
    old_done = _SERVER_DONE
    if old is not None:
        try:
            old.close()
        except Exception:
            pass
    if old_done is not None and not old_done.wait(timeout=5):
        raise ServerStillRunning("previous embedded server still owns the port")


def stop() -> bool:
    """Close the server; return False when the old loop is still holding it."""
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        if _SERVER is None:
            _SERVER = None
            _SERVER_DONE = None
            _STARTED = False
            return True
        try:
            _close_old_server_locked()
        except ServerStillRunning:
            return False
        _SERVER = None
        _SERVER_DONE = None
        _STARTED = False
        return True


def reconfigure(data_dir: str, host: str, port: int = 8000,
                network_hint: str = "", tailscale_ip: str = "",
                auth_user: str = "", auth_password: str = "") -> None:
    """Rebind after the remote-access toggle changes, without a process kill.

    The old server must release its socket before a new one is built. If the
    shutdown or new bind fails, raise and clear the server state so the Python
    bridge never reports a stale "running" flag.
    """
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        _close_old_server_locked()
        snapshot = _snapshot_env()
        try:
            _configure(data_dir, host, port, network_hint, tailscale_ip,
                       auth_user, auth_password)
            _prepare_import_path()
            server = _build_server(host, port)
        except Exception:
            _restore_env(snapshot)
            _SERVER = None
            _SERVER_DONE = None
            _STARTED = False
            raise
        done = threading.Event()
        _SERVER = server
        _SERVER_DONE = done
        _STARTED = True
    _start_runner(server, done)
