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


def _configure(data_dir: str, host: str, port: int, network_hint: str,
               tailscale_ip: str, auth_user: str, auth_password: str) -> None:
    """Publish the launch settings as environment variables for app.py."""
    os.makedirs(data_dir, exist_ok=True)
    os.environ["SESSION_FILE"] = os.path.join(data_dir, "session.json")
    os.environ["PORT"] = str(port)
    os.environ["SERVER_HOST"] = str(host)
    if network_hint:
        # This comes from the phone's Wi-Fi manager, so it is proof of the
        # network the app is actually on (unlike a desktop default-route guess).
        os.environ["TUYA_NETWORK_HINT"] = str(network_hint).strip()
        os.environ["TUYA_NETWORK_HINT_EXPLICIT"] = "1"
    if tailscale_ip:
        os.environ["TAILSCALE_IP"] = str(tailscale_ip).strip()
    # A non-loopback bind exposes device local keys, so credentials must be in
    # place before the app's auth guard is evaluated.
    if auth_user:
        os.environ["AUTH_USERNAME"] = str(auth_user).strip()
    if auth_password:
        os.environ["AUTH_PASSWORD"] = str(auth_password)
    else:
        os.environ.pop("AUTH_PASSWORD", None)
    if not auth_user:
        os.environ.pop("AUTH_USERNAME", None)


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


def start(data_dir: str, host: str = "127.0.0.1", port: int = 8000,
          network_hint: str = "", tailscale_ip: str = "",
          auth_user: str = "", auth_password: str = "") -> None:
    """Start the embedded server once and block on its run loop."""
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        if _STARTED:
            return
        _configure(data_dir, host, port, network_hint, tailscale_ip,
                   auth_user, auth_password)
        _prepare_import_path()
        try:
            server = _build_server(host, port)
        except Exception:
            _STARTED = False
            raise
        done = threading.Event()
        _SERVER = server
        _SERVER_DONE = done
        _STARTED = True
    _run_server(server, done)


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
    facts = {
        "source": "android_service" if data.get("source") == "android_service" else "unavailable",
        "observed_at": float(data.get("observed_at") or time.time()),
        "wifi": {
            "connected": bool(wifi.get("connected")),
            "ipv4": _safe_network_text(wifi.get("ipv4"), ipv4=True),
        },
        "vpn": {
            "connected": bool(vpn.get("connected")),
            "tailscale_ip": _safe_network_text(vpn.get("tailscale_ip")),
        },
        "default_route": {
            "transport": transport if transport in {
                "wifi", "vpn", "cellular", "ethernet", "unknown",
            } else "unknown",
            "is_default": bool(route.get("is_default")),
        },
    }
    with _LOCK:
        _NETWORK_FACTS = facts


def network_facts() -> dict:
    """A copy of the last Android facts, labelled stale when too old."""
    with _LOCK:
        facts = dict(_NETWORK_FACTS)
    if not facts:
        return {"source": "unavailable", "observed_at": 0}
    if time.time() - float(facts.get("observed_at") or 0) > NETWORK_FACTS_MAX_AGE_SECONDS:
        facts = dict(facts)
        facts["source"] = "stale"
    return facts


def stop() -> None:
    """Close the server and release the port for a clean rebind."""
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        old = _SERVER
        old_done = _SERVER_DONE
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        if old_done is not None:
            old_done.wait(timeout=5)
        _SERVER = None
        _SERVER_DONE = None
        _STARTED = False


def reconfigure(data_dir: str, host: str, port: int = 8000,
                network_hint: str = "", tailscale_ip: str = "",
                auth_user: str = "", auth_password: str = "") -> None:
    """Rebind after the remote-access toggle changes, without a process kill.

    Closing the old server unblocks its `run()` loop. Wait for its completion
    event before binding the same port again; otherwise waitress raises
    ``EADDRINUSE`` while the old socket is still open. An Event is used instead
    of Thread.join() because Java-created Chaquopy threads are dummy threads.
    """
    global _SERVER, _SERVER_DONE, _STARTED
    with _LOCK:
        _configure(data_dir, host, port, network_hint, tailscale_ip,
                   auth_user, auth_password)
        _prepare_import_path()
        old = _SERVER
        old_done = _SERVER_DONE
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        if old_done is not None:
            old_done.wait(timeout=5)
        try:
            server = _build_server(host, port)
        except Exception:
            _SERVER = None
            _SERVER_DONE = None
            _STARTED = False
            raise
        done = threading.Event()
        _SERVER = server
        _SERVER_DONE = done
        _STARTED = True
    _run_server(server, done)
