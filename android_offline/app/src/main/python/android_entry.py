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

import os
import sys
import threading

_LOCK = threading.Lock()
_STARTED = False
_SERVER = None
_SERVER_DONE = None


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
