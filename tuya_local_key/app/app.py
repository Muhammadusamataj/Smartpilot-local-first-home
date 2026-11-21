#!/usr/bin/env python3
"""
Web interface for tuya_devices — QR-login to Smart Life and list your devices.

Endpoints (JSON unless noted):
  GET  /                    -> the single-page UI (HTML)
  GET  /api/state           -> {"logged_in": bool}
  POST /api/auto-setup      -> {"ok": true} (background device fetch + LAN scan)
  GET  /api/updates         -> cached release status and installation-specific update link
  POST /api/updates/check   -> manually refresh release status
  POST /api/login/start     -> {"token", "qr"} (qr is a data: PNG) | {"error"}
  POST /api/login/poll      -> {"status": "pending"|"confirmed"|"expired"}
  GET  /api/devices         -> {"devices": [...], "cached_at": ts,
                                "changes"?: {...}, "stale"?: true} | 401/502 {"error"}
  GET/PATCH /api/device-exclusions -> {"excluded_ids": [...], "revision", "account_id"}
  POST /api/logout          -> {"ok": true}
  GET  /api/lan             -> {"results", "summary", "changes", "changes_at",
                                "targets", "job"} | 401
  POST /api/lan/scan        -> 202 {"job"} for {"targets": "..."} or
                               {"device_id", "ip"?} | 400/401/404/409/503 {"error"}
  GET  /api/lan/scan        -> {"job": {...} | null}
  DELETE /api/lan/scan      -> {"ok": true}
  POST /api/lan/read        -> {"device_id", "status", "dps"?, "read_at"?}
  POST /api/support-report  -> {"report", "account_id"} for {"device_id", "account_id"?}
  GET  /local               -> local-only control UI (HTML)
  GET  /api/local/devices   -> {"devices": [...], "scanned": bool, "repair": {...}}
  POST /api/local/ensure    -> silently reuse saved LAN IPs, reconnect only if needed
  GET  /api/local/status    -> {"status", "read_at"?, "values"?} for ?id=<device>
  POST /api/local/command   -> {"ok", "dp", "value"} for local DP writes
"""

import base64
import copy
import hashlib
import ipaddress
import hmac
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, render_template, request, send_file

import device_cache
import device_preferences
import device_values
import lan_scan
import support_report
import tuya_devices as core
import updates

SESSION_FILE = os.environ.get(
    "SESSION_FILE", os.path.expanduser("~/.config/tuya-smartlife/session.json")
)
OPTIONS_FILE = Path(os.environ.get("HASS_OPTIONS_FILE", "/data/options.json"))
APP_ICON = Path(__file__).resolve().parent / "tuya_local_key" / "icon.png"


def _options():
    try:
        return json.loads(OPTIONS_FILE.read_text())
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


_OPTS = _options()


def _setting(name, default=""):
    """HA's options.json (if present) wins over the env var."""
    value = _OPTS.get(name)
    if value is None or value == "":
        value = _OPTS.get(name.lower())
    return str(value).strip() if value is not None and value != "" else os.environ.get(name, default)


QR_SCHEME = _setting("QR_SCHEME", "smartlife")
LAN_SUBNET = _setting("LAN_SUBNET")
AUTH_USERNAME = _setting("AUTH_USERNAME")
AUTH_PASSWORD = _setting("AUTH_PASSWORD")
# Home Assistant ingress is the only supported no-password remote mode: HA
# authenticates the user, and the Supervisor proxies every request from a
# fixed peer. The add-on sets INGRESS_ONLY explicitly so an unrelated token
# in another deployment cannot silently turn off authentication.
SUPERVISOR_PROXY = "172.30.32.2"
INGRESS_ONLY = _setting("INGRESS_ONLY").strip().lower() not in {
    "off", "0", "false", "no", "",
}
CHECK_FOR_UPDATES = _setting("CHECK_FOR_UPDATES", "true").strip().lower() not in {"off", "0", "false", "no"}
# After a QR login (and on startup when a scan is missing), fetch the device
# list and scan each device's /24 automatically. Set AUTO_SETUP=off to disable.
AUTO_SETUP = _setting("AUTO_SETUP", "on").strip().lower() not in {"off", "0", "false", "no"}


def auto_setup_enabled():
    """Background setup must not race explicit requests in Flask TESTING mode."""
    return AUTO_SETUP and not app.config.get("TESTING")
# Android passes the phone's own Wi-Fi subnet so a scan can run even when the
# cloud device IPs are missing or stale. On a PC, ask the OS which local subnet
# the default route uses; a UDP connect picks the address without sending data.
def _local_subnet_hint():
    configured = os.environ.get("TUYA_NETWORK_HINT", "").strip()
    if configured:
        return configured
    try:
        import socket
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            ip = probe.getsockname()[0]
        finally:
            probe.close()
        if ip and not ip.startswith("127."):
            return f"{ip}/24"
    except OSError:
        pass
    return ""


# Only an explicit hint (the Android app passes the phone's Wi-Fi /24) proves
# which network this client is actually on. A subnet guessed from the default
# route is not enough to call a saved address unreachable across networks.
# Decide this once: app.py is imported and reloaded by tests, and the guessed
# hint below would otherwise look explicit on the second import.
if "TUYA_NETWORK_HINT_EXPLICIT" not in os.environ:
    os.environ["TUYA_NETWORK_HINT_EXPLICIT"] = (
        "1" if os.environ.get("TUYA_NETWORK_HINT", "").strip() else "0"
    )
NETWORK_HINT_EXPLICIT = os.environ["TUYA_NETWORK_HINT_EXPLICIT"].strip().lower() not in {
    "0", "false", "no", "off", "",
}
NETWORK_HINT = _local_subnet_hint()
# local_control reads the same hints at import time. Keep both in sync.
if NETWORK_HINT:
    os.environ.setdefault("TUYA_NETWORK_HINT", NETWORK_HINT)
if LAN_SUBNET:
    os.environ.setdefault("LAN_SUBNET", LAN_SUBNET)

DEVICE_CACHE_TTL_SECONDS = 3 * 24 * 60 * 60

_SESSION_DIR = os.path.dirname(SESSION_FILE) or "."
DEVICE_CACHE_FILE = os.environ.get(
    "DEVICE_CACHE_FILE", os.path.join(_SESSION_DIR, "devices.cache")
)
DEVICE_CACHE_KEY_FILE = os.environ.get(
    "DEVICE_CACHE_KEY_FILE", os.path.join(_SESSION_DIR, "cache.key")
)
LAN_CACHE_FILE = os.environ.get(
    "LAN_CACHE_FILE", os.path.join(_SESSION_DIR, "lan.cache")
)
DEVICE_PREFERENCES_FILE = os.environ.get(
    "DEVICE_PREFERENCES_FILE", os.path.join(_SESSION_DIR, "device-preferences.json")
)
UPDATE_CACHE_FILE = os.environ.get("UPDATE_CACHE_FILE", os.path.join(_SESSION_DIR, "update-check.json"))
MAX_EXCLUSION_REQUEST_BYTES = 256 * 1024
MAX_EXCLUSION_BATCH = 2000
DEVICE_CACHE_PERSIST = _setting("DEVICE_CACHE", "on").lower() not in {
    "off", "0", "false", "no",
}
SESSION_INVALID_ERROR_CODES = {
    "1002",  # access_token is null
    "1010",  # token is expired
    "1011",  # token invalid
    "1012",  # token status is invalid
    "1400",  # token invalid
    "2029",  # session status is invalid,
}

app = Flask(__name__)
# Keep core.web_dict()'s field order (name/id/local key first, specs last); the
# UI and the CSV export follow it.
app.json.sort_keys = False

# token -> login info, for in-flight logins (single-process; guarded by a lock).
_pending = {}
_lock = threading.Lock()
PENDING_LOGIN_TTL_SECONDS = 180
_devices_cache = None
_devices_cache_loaded = False
_devices_cache_lock = threading.Lock()
_devices_fetch_lock = threading.Lock()
# Account transitions take the fetch lock first, so an SDK token renewal cannot
# write an old session back after logout/login. Preference reads and writes use
# only the short account lock and never wait for a cloud request.
_account_lock = threading.Lock()
_account_generation = 0
_device_preferences = device_preferences.PreferenceStore(DEVICE_PREFERENCES_FILE)
# LAN scan results, stored like the device list and cleared with it. One scan
# job at a time, on its own thread; _lan_lock guards both.
_lan_cache = None
_lan_cache_loaded = False
_lan_job = None
_lan_lock = threading.Lock()
# A manual value read and a scan must never compete for a local socket.
_lan_read_lock = threading.Lock()
# One automatic setup per login generation, even if several entry points ask.
_auto_setup_lock = threading.Lock()
_auto_setup_seen = set()
_update_checker = updates.UpdateChecker(UPDATE_CACHE_FILE) if CHECK_FOR_UPDATES else None


def _cleanup_pending(now=None):
    now = now or time.time()
    expired = [
        token for token, info in _pending.items()
        if now - info["created_at"] > PENDING_LOGIN_TTL_SECONDS
    ]
    for token in expired:
        _pending.pop(token, None)


def _session_cache_key(session):
    """Identity of the logged-in session, digested.

    Hashed rather than kept as-is because it is stored with the cache, and the
    identity includes the account's user code.
    """
    identity = json.dumps([
        SESSION_FILE,
        session.get("client_id"),
        session.get("user_code"),
        session.get("terminal_id"),
        session.get("endpoint"),
    ])
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _load_persisted_cache():
    global _devices_cache, _devices_cache_loaded
    if _devices_cache_loaded:
        return
    _devices_cache_loaded = True
    if not DEVICE_CACHE_PERSIST:
        # Turning the setting off should take any list already stored with it,
        # not leave one sitting there until the next logout.
        device_cache.clear(DEVICE_CACHE_FILE, DEVICE_CACHE_KEY_FILE, LAN_CACHE_FILE)
        return
    if _devices_cache is not None:
        return
    _devices_cache = device_cache.load(DEVICE_CACHE_FILE, DEVICE_CACHE_KEY_FILE)


def _clear_devices_cache():
    global _devices_cache, _devices_cache_loaded
    # LAN results go with the device list. Drop the running scan first, so it
    # can't write its results back after the files below are gone.
    _clear_lan()
    with _devices_cache_lock:
        _devices_cache = None
        _devices_cache_loaded = True  # nothing left on disk worth reading
        device_cache.clear(DEVICE_CACHE_FILE, DEVICE_CACHE_KEY_FILE, LAN_CACHE_FILE)


def _devices_cache_for_session(session):
    _load_persisted_cache()
    if not _devices_cache:
        return None
    if _devices_cache["session_key"] != _session_cache_key(session):
        return None
    return _devices_cache


def _cached_devices_response(session, now):
    cache = _devices_cache_for_session(session)
    if not cache:
        return None
    if now - cache["cached_at"] >= DEVICE_CACHE_TTL_SECONDS:
        return None
    return cache["body"]


def _snapshot_body(cache, refresh, reason):
    body = dict(cache["body"])
    body["stale"] = True
    body["stale_reason"] = reason
    if refresh:
        body["refresh_failed"] = True
    return body


def _devices_response(body, session):
    """Tie device/LAN responses, including old cache snapshots, to an account."""
    try:
        digest = device_preferences.account_id(session)
    except device_preferences.AccountIdentityError:
        # Old/incomplete sessions can still report their existing device error;
        # the preferences endpoint explicitly asks them to log in again.
        return jsonify(body)
    return jsonify(dict(body, account_id=digest))


def _is_session_invalid_error(error):
    if isinstance(error, KeyError):
        return True

    code = str(getattr(error, "error_code", ""))
    if code in SESSION_INVALID_ERROR_CODES:
        return True

    message = str(getattr(error, "error_message", error)).lower()
    if "sign invalid" in message or "signature invalid" in message:
        return code == "-9999999" or "-9999999" in message

    return any(
        marker in message
        for marker in (
            "access_token is null",
            "invalid token",
            "token is expired",
            "token invalid",
            "token expired",
            "token status is invalid",
            "login expired",
            "session expired",
            "session status is invalid",
        )
    )


@app.get("/")
def index():
    version = support_report.app_version()
    release_version = re.sub(r"^(\d+\.\d+)\.0$", r"\1", version)
    return render_template("index.html", gateway_categories=sorted(lan_scan.GATEWAY_CATEGORIES),
                           app_version=version, app_release_tag="v" + release_version,
                           check_for_updates=CHECK_FOR_UPDATES)


@app.get("/icon.png")
def app_icon():
    return send_file(APP_ICON, mimetype="image/png", max_age=86400)


@app.get("/api/updates")
def update_status():
    return _update_status(manual=False)


@app.post("/api/updates/check")
def check_updates_manually():
    return _update_status(manual=True)


def _update_status(manual):
    if not CHECK_FOR_UPDATES:
        return jsonify({"enabled": False, "available": False, "status": "disabled"})
    token = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HASSIO_TOKEN")
    home_assistant = bool(token or request.headers.get("X-Ingress-Path"))
    return jsonify(_update_checker.status(support_report.app_version(), home_assistant=home_assistant,
                                          supervisor_token=token, manual=manual))


def _is_supervisor_ingress():
    """True only for a real HA Supervisor proxied request.

    The peer address comes from the socket, not from a spoofable forwarding
    header. HA strips and rewrites X-Ingress-Path itself.
    """
    return (request.remote_addr == SUPERVISOR_PROXY
            and bool(request.headers.get("X-Ingress-Path")))


@app.before_request
def _require_auth():
    # Read at request time so the Android app can switch its opt-in direct
    # mode on/off without a full process restart.
    username = _setting("AUTH_USERNAME")
    password = _setting("AUTH_PASSWORD")

    if username and password:
        # Trust Supervisor's proxy peer, never a client-supplied header alone.
        if _is_supervisor_ingress():
            return

        auth = request.authorization
        ok = bool(auth) and auth.type == "basic" and (
            hmac.compare_digest((auth.username or "").encode(), username.encode())
            & hmac.compare_digest((auth.password or "").encode(), password.encode())
        )
        if not ok:
            return ("Authentication required.", 401,
                    {"WWW-Authenticate": 'Basic realm="Tuya Local Key"'})

        # Basic Auth is attached automatically by browsers on cross-site requests.
        # Reject a foreign Origin on state-changing API calls (curl/mobile clients
        # that send no Origin still work). Ingress requests are already exempted.
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.path.startswith("/api/"):
            origin = request.headers.get("Origin")
            if origin and urlparse(origin).netloc.lower() != request.host.lower():
                return ("Cross-origin request blocked.", 403)
        return

    # No app-level credentials. In ingress-only deployments HA has already
    # authenticated the user, but only the Supervisor proxy may reach us.
    # This closes a published direct port without breaking sidebar access.
    if INGRESS_ONLY:
        if _is_supervisor_ingress():
            return
        return ("Home Assistant ingress only.", 403)


@app.after_request
def no_store_api_responses(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _json_object():
    """The request's JSON body when it is an object, else {} (never a 500)."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


@app.get("/api/state")
def state():
    return jsonify({"logged_in": os.path.isfile(SESSION_FILE)})


@app.post("/api/login/start")
def login_start():
    data = _json_object()
    user_code = str(data.get("user_code") or "").strip()
    if not user_code:
        return jsonify({"error": "A user code is required."}), 400
    try:
        token = core.mint_qr_token(user_code)
    except core.LoginError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # network/SDK error
        return jsonify({"error": f"Could not reach Tuya: {e}"}), 502

    with _lock:
        _cleanup_pending()
        _pending[token] = {"user_code": user_code, "created_at": time.time()}

    png = base64.b64encode(
        core.qr_png_bytes(f"{QR_SCHEME}--qrLogin?token={token}")
    ).decode()
    return jsonify({"token": token, "qr": f"data:image/png;base64,{png}"})


@app.post("/api/login/poll")
def login_poll():
    global _account_generation
    data = _json_object()
    token = str(data.get("token") or "").strip()
    with _lock:
        _cleanup_pending()
        login = _pending.get(token)
        user_code = login["user_code"] if login else None
    if not user_code:
        return jsonify({"status": "expired"}), 404
    with _account_lock:
        generation = _account_generation
    session = core.poll_login(token, user_code)
    if session:
        with _devices_fetch_lock, _account_lock:
            with _lock:
                if generation != _account_generation or token not in _pending:
                    return jsonify({"status": "expired"}), 409
            try:
                core.save_session(SESSION_FILE, session)
            except Exception as e:
                return jsonify({"error": f"session_save_failed: {e}"}), 500
            _account_generation += 1
            with _lock:
                _pending.pop(token, None)
            _clear_devices_cache()
            if auto_setup_enabled():
                _spawn_auto_setup(_session_cache_key(session), _account_generation)
        return jsonify({"status": "confirmed"})
    return jsonify({"status": "pending"})


@app.get("/api/devices")
def devices():
    global _devices_cache, _devices_cache_loaded
    with _account_lock:
        session = core.load_session(SESSION_FILE)
    if not session:
        return jsonify({"error": "not_logged_in"}), 401
    refresh = request.args.get("refresh") in {"1", "true", "yes"}
    request_start = time.time()

    if not refresh:
        with _devices_cache_lock:
            cached = _cached_devices_response(session, request_start)
        if cached:
            return _devices_response(cached, session)

    with _devices_fetch_lock:
        with _account_lock:
            current = core.load_session(SESSION_FILE)
            if not current:
                return jsonify({"error": "not_logged_in"}), 401
            if _session_cache_key(current) != _session_cache_key(session):
                return jsonify({"error": "account_changed"}), 409
        with _devices_cache_lock:
            cache = _devices_cache_for_session(session)

            if cache and cache["cached_at"] > request_start:
                # Only a cache written strictly after this request began may be
                # reused; an equal timestamp is this request's own starting
                # state and must still take the refresh path.
                return _devices_response(cache["body"], session)
            if not refresh:
                cached = _cached_devices_response(session, request_start)
                if cached:
                    return _devices_response(cached, session)
            previous = cache

        try:
            devs = core.devices_from_session(session, SESSION_FILE)
        except Exception as e:
            invalid = _is_session_invalid_error(e)
            if previous:
                return _devices_response(_snapshot_body(
                    previous, refresh, "session_invalid" if invalid else "fetch_failed"
                ), session)
            if invalid:
                _clear_devices_cache()
                return jsonify({"error": "session_invalid"}), 401
            return jsonify({"error": "fetch_failed"}), 502

        now = time.time()
        listed = [core.web_dict(d) for d in devs]
        body = {
            "devices": listed,
            "cached_at": now,
            "cache_expires_at": now + DEVICE_CACHE_TTL_SECONDS,
        }
        if isinstance(devs, core.Devices):
            body["homes"] = devs.homes
            if devs.device_rooms is not None:
                body["rooms_loaded"] = True
            home_names = {home["id"]: home["name"] for home in devs.homes}
            for device in listed:
                device_id = str(device.get("id"))
                ids = devs.home_ids.get(device_id, [])
                device["home_ids"] = list(ids)
                device["home_names"] = [home_names.get(home_id, "") for home_id in ids]
                if devs.device_rooms is not None:
                    device["room_status"] = "unknown"
                    if device_id in devs.device_rooms:
                        room = devs.device_rooms[device_id]
                        device["room_status"] = "assigned" if room is not None else "unassigned"
                        device["room_id"] = room["id"] if room is not None else None
                        if room is not None:
                            device["room_name"] = room["name"]
                            device["room_display_order"] = room["display_order"]
        if previous:
            changes = core.diff_devices(previous["body"].get("devices", []), listed)
            if any(changes.values()):
                body["changes"] = changes
        entry = {
            "body": body,
            "cached_at": now,
            "session_key": _session_cache_key(session),
        }
        with _devices_cache_lock:
            _devices_cache = entry
            _devices_cache_loaded = True
        if DEVICE_CACHE_PERSIST:
            device_cache.save(DEVICE_CACHE_FILE, DEVICE_CACHE_KEY_FILE, entry)
        return _devices_response(body, session)


def _preference_account():
    """Resolve the saved account while holding _account_lock."""
    session = core.load_session(SESSION_FILE)
    if not session:
        return None, None, (jsonify({"error": "not_logged_in"}), 401)
    try:
        digest = device_preferences.account_id(session)
    except device_preferences.AccountIdentityError:
        return None, None, (jsonify({"error": "account_identity_unavailable"}), 409)
    return session, digest, None


@app.get("/api/device-exclusions")
def device_exclusions():
    with _account_lock:
        _, digest, error = _preference_account()
        if error:
            return error
        try:
            return jsonify(_device_preferences.get(digest))
        except device_preferences.PreferenceError:
            return jsonify({"error": "preferences_unavailable"}), 503


@app.patch("/api/device-exclusions")
def update_device_exclusions():
    with _account_lock:
        session, digest, error = _preference_account()
        if error:
            return error
        if (request.content_length is not None
                and request.content_length > MAX_EXCLUSION_REQUEST_BYTES):
            return jsonify({"error": "invalid_exclusions"}), 400
        payload = request.stream.read(MAX_EXCLUSION_REQUEST_BYTES + 1)
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeError, RecursionError):
            data = None
        if (len(payload) > MAX_EXCLUSION_REQUEST_BYTES or not request.is_json
                or not isinstance(data, dict)
                or set(data) - {"exclude", "restore", "restore_all", "account_id"}):
            return jsonify({"error": "invalid_exclusions"}), 400
        exclude, restore = data.get("exclude", []), data.get("restore", [])
        restore_all = data.get("restore_all", False)
        if (not isinstance(exclude, list) or not isinstance(restore, list)
                or type(restore_all) is not bool or (restore_all and (exclude or restore))
                or len(exclude) + len(restore) > MAX_EXCLUSION_BATCH
                or any(not device_preferences.valid_device_id(value)
                       for value in exclude + restore)):
            return jsonify({"error": "invalid_exclusions"}), 400
        exclude, restore = set(exclude), set(restore)
        if exclude & restore:
            return jsonify({"error": "invalid_exclusions"}), 400
        if "account_id" in data and data["account_id"] != digest:
            return jsonify({"error": "account_changed"}), 409
        if exclude:
            listed = _session_devices(session)
            if listed is None:
                return jsonify({"error": "device_snapshot_required"}), 409
            unknown = exclude - {device.get("id") for device in listed}
            if unknown:
                return jsonify({"error": "unknown_device_ids", "unknown_ids": sorted(unknown)}), 400
        try:
            return jsonify(_device_preferences.update(
                digest, exclude=exclude, restore=restore, restore_all=restore_all))
        except device_preferences.PreferenceError:
            return jsonify({"error": "preferences_unavailable"}), 503


@app.post("/api/logout")
def logout():
    global _account_generation
    with _devices_fetch_lock, _account_lock:
        try:
            os.remove(SESSION_FILE)
        except OSError:
            pass
        _account_generation += 1
        with _lock:
            _pending.clear()
        _clear_devices_cache()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# LAN scan (see lan_scan): local IPs and protocol versions
# --------------------------------------------------------------------------- #
def _empty_lan_body():
    return {"results": {}, "summary": None, "targets": "", "changes": None, "changes_at": None}


def _lan_body_for(session_key):
    """The stored LAN results for this session, or None. Hold _lan_lock."""
    global _lan_cache, _lan_cache_loaded
    if not _lan_cache_loaded:
        _lan_cache_loaded = True
        if DEVICE_CACHE_PERSIST and _lan_cache is None:
            _lan_cache = device_cache.load(LAN_CACHE_FILE, DEVICE_CACHE_KEY_FILE)
    if not _lan_cache or _lan_cache["session_key"] != session_key:
        return None
    return _lan_cache["body"]


def _save_lan(session_key, body):
    """Hold _lan_lock."""
    global _lan_cache, _lan_cache_loaded
    entry = {"body": body, "cached_at": time.time(), "session_key": session_key}
    _lan_cache = entry
    _lan_cache_loaded = True
    if DEVICE_CACHE_PERSIST:
        device_cache.save(LAN_CACHE_FILE, DEVICE_CACHE_KEY_FILE, entry, prefix=".lan-")


def _clear_lan():
    global _lan_cache, _lan_cache_loaded, _lan_job
    with _lan_lock:
        if _lan_job is not None:
            _lan_job["cancel"].set()
        _lan_job = None
        _lan_cache = None
        _lan_cache_loaded = True  # the caller removes the file


def _key_digest(local_key):
    return hashlib.sha256(str(local_key or "").encode("utf-8")).hexdigest()


def _device_link(device):
    """The cloud relationship used when checking a sub-device or lending a key."""
    return {field: device.get(field) for field in ("gateway_id", "node_id", "sub", "category")}


def _lan_key_evidence(job, dev_id, result, results, current):
    """Private evidence tying a successful result to its scan's keys and links.

    A child's result proves only its gateway connection. It inherits the
    gateway's key dependencies, including the sub-device lending a key to a
    keyless gateway. Protocol 3.1 still only identifies a plaintext reply;
    unchanged key evidence must never be presented as key authentication there.
    """
    if result.get("status") not in (lan_scan.OK, lan_scan.VIA_GATEWAY) or not result.get("ip"):
        return None
    dependencies = {dev_id}
    connection = result
    connection_id = dev_id
    if result.get("status") == lan_scan.VIA_GATEWAY:
        gateway_id = result.get("gateway_id")
        if gateway_id in current:
            connection = results.get(gateway_id) or {}
            if (connection.get("status") != lan_scan.OK
                    or connection.get("ip") != result.get("ip")
                    or connection.get("version") != result.get("version")):
                return None
            dependencies.add(gateway_id)
            connection_id = gateway_id
    if connection.get("key_from"):
        dependencies.add(connection["key_from"])
    key_id = connection.get("key_from") or connection_id
    if not (current.get(key_id) or {}).get("local_key"):
        return None
    keys, links = job["key_digests"], job["device_links"]
    if any(dep not in keys or dep not in links for dep in dependencies):
        return None
    return {
        "key_digests": {dep: keys[dep] for dep in dependencies},
        "device_links": {dep: links[dep] for dep in dependencies},
        "gateway_id": result.get("gateway_id"),
        "key_from": result.get("key_from"),
    }


def _lan_key_current(result, evidence, current):
    """Whether this saved connection used the keys and relationships listed now."""
    if not evidence or result.get("status") not in (lan_scan.OK, lan_scan.VIA_GATEWAY):
        return False
    if any(result.get(field) != evidence.get(field) for field in ("gateway_id", "key_from")):
        return False
    keys, links = evidence.get("key_digests") or {}, evidence.get("device_links") or {}
    return bool(keys) and all(
        dev_id in current
        and digest == _key_digest(current[dev_id].get("local_key"))
        and links.get(dev_id) == _device_link(current[dev_id])
        for dev_id, digest in keys.items()
    )


def _job_view(job):
    if not job:
        return None
    view = {k: job.get(k) for k in (
        "id", "kind", "state", "device_id", "targets", "started_at",
        "finished_at", "summary", "result", "error", "also",
    )}
    view["progress"] = dict(job.get("progress") or {})
    # Cancelled, but the checks already under way still finishing.
    view["cancelling"] = job.get("state") == "running" and job["cancel"].is_set()
    return view


def _add_auto_target(subnets, text):
    """Normalise one IP or subnet hint to a /24 and add it to `subnets`."""
    text = str(text or "").strip()
    if not text:
        return
    try:
        if "/" in text:
            network = ipaddress.ip_network(text, strict=False)
        else:
            network = ipaddress.ip_network(f"{ipaddress.ip_address(text)}/24", strict=False)
    except ValueError:
        return
    if network.version != 4:
        return
    value = str(network)
    if value not in subnets:
        subnets.append(value)


def _ip_network_or_none(text):
    """An IPv4 network for an IP or subnet hint, or None when unusable."""
    text = str(text or "").strip()
    if not text:
        return None
    try:
        if "/" in text:
            network = ipaddress.ip_network(text, strict=False)
        else:
            network = ipaddress.ip_network(f"{ipaddress.ip_address(text)}/24", strict=False)
    except ValueError:
        return None
    return network if network.version == 4 else None


def _subnet_warning(results):
    """Explain failed local reads when this host is on a different subnet.

    The Android app passes the phone's Wi-Fi subnet in NETWORK_HINT. A saved
    address on another subnet can never answer TCP 6668 from here, so a scan
    only produces "unreachable" and a refused address that is the phone itself.
    An explicit LAN_SUBNET that covers the saved devices is deliberate (a
    routed IoT VLAN), so it suppresses the warning.
    """
    local = _ip_network_or_none(NETWORK_HINT)
    if local is None or not NETWORK_HINT_EXPLICIT:
        return None
    explicit = _ip_network_or_none(LAN_SUBNET)
    saved = {}
    for result in (results or {}).values():
        if not isinstance(result, dict) or result.get("status") == lan_scan.OK:
            continue
        network = _ip_network_or_none(result.get("ip"))
        if network is not None:
            saved.setdefault(str(network), network)
    if not saved:
        return None
    if explicit and all(network.subnet_of(explicit) for network in saved.values()):
        return None
    outside = sorted(str(network) for network in saved.values()
                     if not network.subnet_of(local))
    if not outside:
        return None
    return {
        "code": "subnet_mismatch",
        "local": str(local),
        "devices": outside,
        "message": (
            f"Devices are saved on {', '.join(outside)}, but this machine is on "
            f"{local}. TCP port 6668 cannot be reached between different Wi-Fi "
            "networks. Connect to the devices' 2.4 GHz Wi-Fi (or allow routing "
            "to their subnet), then scan again. A refused address in the scan "
            "is usually this phone/router, not a Tuya device."
        ),
    }


def _auto_targets(devices):
    """Use the phone/PC subnet first, then cloud IPs: at most four /24s."""
    subnets = []
    for hint in (NETWORK_HINT, LAN_SUBNET):
        _add_auto_target(subnets, hint)
    for device in devices or []:
        if isinstance(device, dict):
            _add_auto_target(subnets, device.get("ip"))
    return ",".join(subnets[:4])


def _spawn_auto_setup(session_key, generation, devices=None):
    """Fetch devices and scan their subnets in the background, once per login.

    `devices` may be the already cached list. Using it avoids a cloud request
    when the LAN keys are on disk, which is the common phone/offline case.
    """
    marker = (session_key, generation)
    with _auto_setup_lock:
        if marker in _auto_setup_seen:
            return
        _auto_setup_seen.add(marker)
    cached = [dict(row) for row in (devices or []) if isinstance(row, dict)]

    def run():
        try:
            # Reuse the real endpoints, so caches, locks and job state stay in
            # one place. A test client is safe here: each call gets its own
            # request context, while waitress keeps serving the UI.
            with app.test_client() as client:
                rows = cached
                if not rows:
                    response = client.get("/api/devices?refresh=1")
                    if response.status_code != 200:
                        app.logger.warning("Auto setup: device fetch failed (%s)", response.status_code)
                        return
                    rows = (response.get_json() or {}).get("devices") or []
                targets = _auto_targets(rows)
                if not targets:
                    app.logger.info("Auto setup: no usable device IP hints")
                    return
                with _account_lock:
                    current, current_key = _lan_session()
                    if not current or current_key != session_key or generation != _account_generation:
                        return
                client.post("/api/lan/scan", json={"targets": targets})
        except Exception as error:
            app.logger.warning("Auto setup failed: %s", type(error).__name__)

    threading.Thread(target=run, name="auto-setup", daemon=True).start()


def auto_setup_if_needed():
    """Start the background setup when a session exists but IPs are missing."""
    if not auto_setup_enabled():
        return
    with _account_lock:
        session, session_key = _lan_session()
        if not session:
            return
        generation = _account_generation
    with _lan_lock:
        if _lan_job and _lan_job["state"] == "running":
            return
        results = (_lan_body_for(session_key) or {}).get("results") or {}
    with _devices_cache_lock:
        cache = _devices_cache_for_session(session)
    devices = ((cache or {}).get("body") or {}).get("devices") or []
    missing = [d for d in devices
               if d.get("local_key") and d.get("id")
               and not (results.get(str(d["id"])) or {}).get("ip")]
    if not devices or missing:
        _spawn_auto_setup(session_key, generation, devices)


@app.post("/api/auto-setup")
def auto_setup_route():
    """Let the UI ask for the same background setup on a cold visit."""
    auto_setup_if_needed()
    return jsonify({"ok": True})


def _lan_session():
    session = core.load_session(SESSION_FILE)
    return session, (_session_cache_key(session) if session else None)


def _session_devices(session):
    with _devices_cache_lock:
        cache = _devices_cache_for_session(session)
    if not cache:
        return None
    return [d for d in cache["body"].get("devices", []) if isinstance(d, dict)]


def _lent_key(result, current):
    """The sub-device key a keyless gateway's result says it answered to."""
    source = (result or {}).get("key_from")
    return (current.get(source) or {}).get("local_key") if source else None


def _hand_over_gateway_keys(merged, results, current):
    """A sub-device key is one gateway's. A gateway that just answered to one
    takes it from any other gateway stored with it, and sub-devices stored as
    reached through it under another key lose that link. Both come from a
    check that took one gateway for another, which the next check undoes."""
    fresh = {}   # key -> the gateway that just answered to it
    for dev_id, result in results.items():
        key = _lent_key(result, current)
        if key and result.get("status") == lan_scan.OK:
            fresh[key] = dev_id
    keys = {gateway_id: key for key, gateway_id in fresh.items()}
    for dev_id, result in list(merged.items()):
        if dev_id in results:
            continue
        device = current.get(dev_id) or {}
        key = _lent_key(result, current)
        if key and fresh.get(key, dev_id) != dev_id:
            del merged[dev_id]
        elif (result.get("status") == lan_scan.VIA_GATEWAY and result.get("gateway_id") in keys
              and not device.get("gateway_id")
              and device.get("local_key") != keys[result["gateway_id"]]):
            merged[dev_id] = dict(result, gateway_id=None)


def _remembered(stored):
    """What a scan starts from: each device's last address and version, and
    for a keyless gateway, the sub-device key it answered to."""
    remembered = {}
    for dev_id, r in stored.items():
        if r.get("status") == lan_scan.VIA_GATEWAY:
            continue
        entry = {"ip": r["ip"], "version": r.get("version"),
                 "device22": r.get("device22", False)} if r.get("ip") else {}
        if r.get("key_from"):
            # Kept even when its last result has no address.
            entry["key_from"] = r["key_from"]
        if entry:
            remembered[dev_id] = entry
    return remembered


def _gateways_left(devices, stored):
    """(gateway id, ip) for each keyless gateway a check just left with only
    one key it can have, and the address where that key answered last. Its
    own check could only confirm that, so it runs without being asked."""
    lent, _ = lan_scan.lend_keys(devices, _remembered(stored))
    left = []
    for gateway_id, source in lent.items():
        if (stored.get(gateway_id) or {}).get("key_from"):
            continue   # found before, whatever it answered since
        ip = (stored.get(source) or {}).get("ip")
        if ip:
            left.append((gateway_id, ip))
    return left


def _merge_lan(job, outcome, current):
    """Fold a finished scan into the stored results. Hold _lan_lock."""
    key = job["session_key"]
    stored = _lan_body_for(key) or _empty_lan_body()
    body = dict(stored)
    previous = stored.get("results") or {}

    if job["kind"] == "device":
        # A device found is news wherever it was found. A failure only says
        # something about the address the device was known at: one at an
        # address typed in by hand (a typo, a guess) must not replace what is
        # stored. The job's own result still reports it.
        checked = outcome["results"].get(job["device_id"]) or {}
        known_ip = (previous.get(job["device_id"]) or {}).get("ip")
        if checked.get("status") != lan_scan.OK and checked.get("ip") != known_ip:
            return

    results = {}
    for dev_id, result in outcome["results"].items():
        device = current.get(dev_id)
        if device is None:
            continue   # gone from the device list while the scan ran
        if job["key_digests"].get(dev_id) != _key_digest(device.get("local_key")):
            continue   # a Refresh changed its key mid-scan; this result proves nothing
        source = result.get("key_from")
        if source and job["key_digests"].get(source) != _key_digest(
                (current.get(source) or {}).get("local_key")):
            continue   # the same, for the sub-device key a keyless gateway answered to
        results[dev_id] = result

    names = {dev_id: d.get("name") or "" for dev_id, d in current.items()}
    changes = lan_scan.diff_results(previous, results, names)
    gateways = lan_scan.gateway_ids(current.values())
    merged = {dev_id: r for dev_id, r in previous.items()
              if dev_id in current
              and not (dev_id in gateways and r.get("status") == lan_scan.VIA_GATEWAY)}
    merged.update(results)
    _hand_over_gateway_keys(merged, results, current)
    body["results"] = merged
    evidence = {dev_id: proof for dev_id, proof in (stored.get("key_evidence") or {}).items()
                if dev_id in merged}
    for dev_id, result in results.items():
        proof = _lan_key_evidence(job, dev_id, result, results, current)
        if proof:
            evidence[dev_id] = proof
        else:
            evidence.pop(dev_id, None)
    # This map stays inside the encrypted cache. API consumers receive only a
    # boolean, so key fingerprints never enter JSON responses or CSV exports.
    body["key_evidence"] = evidence

    now = time.time()
    whole = job["kind"] == "scan" and not outcome["summary"]["cancelled"]
    if job["kind"] == "scan":
        body["summary"] = outcome["summary"]
        body["targets"] = job["targets"]
    if whole:
        # A full scan speaks for every device, like a Refresh does for the list.
        body["changes"] = changes if any(changes.values()) else None
        body["changes_at"] = now if body["changes"] else None
    else:
        # A single check or a cancelled scan only speaks for what it reached:
        # what it found replaces that device's entry of the same kind, and a
        # device that answers to its key again no longer counts as failing.
        existing = body.get("changes") or {}
        combined = {}
        for kind, entries in changes.items():
            fresh = {e["id"] for e in entries}
            kept = [
                e for e in existing.get(kind, [])
                if e["id"] not in fresh and not (
                    kind == "local_key_failed"
                    and (results.get(e["id"]) or {}).get("status") == lan_scan.OK)
            ]
            combined[kind] = sorted(kept + entries, key=lambda e: (e["name"].lower(), e["id"]))
        if not any(combined.values()):
            body["changes"] = body["changes_at"] = None
        else:
            body["changes"] = combined
            if any(changes.values()) or not body.get("changes_at"):
                body["changes_at"] = now   # something new: show the notice again
    _save_lan(key, body)


def _run_lan_job(job, targets, devices, known, only, routers):
    def progress(snapshot):
        with _lan_lock:
            job["progress"] = snapshot

    # Anything tinytuya does wrong ends here, in this job. The device list and
    # the stored results are never touched by a scan that didn't finish.
    try:
        outcome = lan_scan.scan(targets, devices, known, progress=progress,
                                cancel=job["cancel"], only=only, routers=routers)
    except lan_scan.ScannerUnavailable as e:
        app.logger.warning("LAN scan unavailable: %s", e)
        with _lan_lock:
            job.update(state="failed", error="scanner_unavailable", finished_at=time.time())
        return
    except Exception as e:
        # The type only: a message could carry a device's repr, which has its key.
        app.logger.warning("LAN scan failed: %s", type(e).__name__)
        with _lan_lock:
            job.update(state="failed", error="scan_failed", finished_at=time.time())
        return

    try:
        result = outcome["results"].get(job["device_id"]) if job["device_id"] else None
        if not _save_lan_outcome(job, outcome):
            return
        also = []
        if job["kind"] == "device" and (result or {}).get("key_from") and result["status"] == lan_scan.OK:
            also = _check_gateways_left(job, devices)
        with _lan_lock:
            if _lan_job is job and job["state"] == "running":
                job.update(
                    state="cancelled" if outcome["summary"]["cancelled"] else "done",
                    finished_at=time.time(),
                    summary=outcome["summary"],
                    result=result,
                    also=also,
                )
    except Exception as e:
        # A job left "running" would refuse every later scan until a logout.
        app.logger.warning("LAN scan results not saved: %s", type(e).__name__)
        with _lan_lock:
            job.update(state="failed", error="scan_failed", finished_at=time.time())


def _save_lan_outcome(job, outcome, device_id=None):
    """Merge an outcome into the stored results, unless the session it belongs
    to is gone. Returns False, and marks the job discarded, if it is. With
    device_id, it is merged as a check of that device."""
    session, session_key = _lan_session()
    current = {d.get("id"): d for d in (_session_devices(session) or [])} if session else {}
    with _lan_lock:
        if _lan_job is not job or session_key != job["session_key"]:
            # Logged out, or logged in again, while it ran: the results belong
            # to a device list that is gone.
            job.update(state="discarded", finished_at=time.time())
            return False
        _merge_lan(dict(job, device_id=device_id) if device_id else job, outcome, current)
    return True


def _check_gateways_left(job, devices):
    """A check that named a keyless gateway can leave one key for another
    gateway: check that one too, where its key answered last. Returns
    [{"device_id", "result"}] for the job's view."""
    with _lan_lock:
        stored = (_lan_body_for(job["session_key"]) or _empty_lan_body()).get("results") or {}
    also = []
    for gateway_id, ip in _gateways_left(devices, stored):
        if job["cancel"].is_set():
            break
        known = _remembered(stored)
        known[gateway_id] = dict(known.get(gateway_id, {}), ip=ip)
        try:
            outcome = lan_scan.scan([ip], devices, known, cancel=job["cancel"], only=[gateway_id])
        except Exception as e:
            app.logger.warning("Gateway check after a check failed: %s", type(e).__name__)
            break
        # Merged like a check of that gateway: a failure isn't saved.
        if not _save_lan_outcome(job, outcome, device_id=gateway_id):
            break
        also.append({"device_id": gateway_id, "result": outcome["results"].get(gateway_id)})
    return also


@app.get("/api/lan")
def lan_state():
    session, session_key = _lan_session()
    if not session:
        return jsonify({"error": "not_logged_in"}), 401
    with _devices_cache_lock:
        _load_persisted_cache()  # also drops a stored LAN file when DEVICE_CACHE=off
    current = {d.get("id"): d for d in (_session_devices(session) or [])}
    with _lan_lock:
        body = _lan_body_for(session_key) or _empty_lan_body()
        job = _lan_job if _lan_job and _lan_job["session_key"] == session_key else None
        evidence = body.get("key_evidence") or {}
        results = {dev_id: dict(result, key_current=_lan_key_current(result, evidence.get(dev_id), current))
                   for dev_id, result in (body.get("results") or {}).items()}
        return _devices_response({
            "results": results,
            "summary": body.get("summary"),
            "changes": body.get("changes"),
            "changes_at": body.get("changes_at"),
            "targets": body.get("targets") or LAN_SUBNET,
            "job": _job_view(job),
            "network_warning": _subnet_warning(results),
        }, session)


def _bad_targets(message):
    return jsonify({"error": "bad_targets", "message": message}), 400


def _scan_account_precondition(session, data):
    """A tab may supply its account before mutating a scan. Hold _account_lock."""
    if "account_id" not in data:
        return None
    try:
        digest = device_preferences.account_id(session)
    except device_preferences.AccountIdentityError:
        return jsonify({"error": "account_identity_unavailable"}), 409
    if data["account_id"] != digest:
        return jsonify({"error": "account_changed"}), 409
    return None


@app.post("/api/lan/scan")
def lan_scan_start():
    global _lan_job
    data = _json_object()
    with _account_lock:
        session, session_key = _lan_session()
        if not session:
            return jsonify({"error": "not_logged_in"}), 401
        error = _scan_account_precondition(session, data)
        if error:
            return error

    # Keys come from the device list already loaded: a scan never calls Tuya.
    devices = _session_devices(session)
    if not devices:
        return jsonify({"error": "no_devices"}), 409
    with _lan_lock:
        stored = (_lan_body_for(session_key) or _empty_lan_body()).get("results") or {}
    remembered = _remembered(stored)

    device_id = str(data.get("device_id") or "").strip()
    if device_id:
        device = next((d for d in devices if d.get("id") == device_id), None)
        if device is None:
            return jsonify({"error": "unknown_device"}), 404
        # A sub-device is checked through its gateway. A device with no key of
        # its own can't be checked, unless it is a gateway whose key Tuya lists
        # on its sub-devices. Bluetooth-only devices have none at all.
        refusal = lan_scan.check_refusal(devices, device_id, remembered)
        if refusal:
            return jsonify({"error": refusal}), 400
        text = str(data.get("ip") or "").strip() or remembered.get(device_id, {}).get("ip", "")
        try:
            targets = lan_scan.parse_targets(text)
        except lan_scan.TargetError as e:
            return _bad_targets(str(e))
        if len(targets) != 1:
            return _bad_targets("Enter one IP address.")
        # What the other devices answered to before goes along too: it tells
        # which sub-device keys other gateways already took.
        known = dict(remembered)
        known[device_id] = dict(remembered.get(device_id, {}), ip=targets[0])
        # The whole list goes along, so a gateway is known as one, but only this
        # device (and its sub-devices) is looked for. An IP typed for one device
        # is wanted, so it is never taken for the router.
        kind, text, only, routers = "device", targets[0], [device_id], None
    else:
        text = str(data.get("targets") or "").strip()
        try:
            targets = lan_scan.parse_targets(text)
        except lan_scan.TargetError as e:
            return _bad_targets(str(e))
        known, kind, only = remembered, "scan", None
        routers = lan_scan.likely_routers(text)

    try:
        lan_scan.require_scanner()
    except lan_scan.ScannerUnavailable as e:
        app.logger.warning("LAN scan unavailable: %s", e)
        return jsonify({"error": "scanner_unavailable"}), 503

    job = {
        "id": base64.urlsafe_b64encode(os.urandom(9)).decode(),
        "kind": kind,
        "state": "running",
        "device_id": device_id or None,
        "targets": text,
        "started_at": time.time(),
        "finished_at": None,
        "progress": {},
        "summary": None,
        "result": None,
        "error": None,
        "session_key": session_key,
        "key_digests": {d.get("id"): _key_digest(d.get("local_key")) for d in devices},
        "device_links": {d.get("id"): _device_link(d) for d in devices},
        "cancel": threading.Event(),
    }
    with _account_lock:
        current, current_key = _lan_session()
        if not current:
            return jsonify({"error": "not_logged_in"}), 401
        if current_key != session_key:
            return jsonify({"error": "account_changed"}), 409
        with _lan_lock:
            if _lan_read_lock.locked():
                return jsonify({"error": "read_running"}), 409
            if _lan_job is not None and _lan_job["state"] == "running":
                return jsonify({"error": "scan_running"}), 409
            _lan_job = job
            view = _job_view(job)
    # Its own thread, so a scan doesn't hold one of waitress's request threads.
    thread = threading.Thread(
        target=_run_lan_job, args=(job, targets, devices, known, only, routers),
        name="lan-scan", daemon=True,
    )
    try:
        thread.start()
    except RuntimeError:   # no thread to be had: don't leave the job "running"
        app.logger.warning("LAN scan could not start a thread")
        with _lan_lock:
            job.update(state="failed", error="scan_failed", finished_at=time.time())
        return jsonify({"error": "scan_failed"}), 503
    return _devices_response({"job": view}, session), 202


@app.post("/api/lan/read")
def lan_read():
    data = _json_object()
    device_id = str(data.get("device_id") or "").strip()
    with _account_lock:
        session, session_key = _lan_session()
        if not session:
            return jsonify({"error": "not_logged_in"}), 401
        error = _scan_account_precondition(session, data)
        if error:
            return error
        generation = _account_generation
        devices = _session_devices(session)
        if not devices:
            return jsonify({"error": "no_devices"}), 409
        with _lan_lock:
            results = (_lan_body_for(session_key) or _empty_lan_body())["results"]
            try:
                context = device_values.connection(devices, results, device_id)
            except device_values.ReadUnavailable as e:
                code = str(e)
                return jsonify({"error": code}), 404 if code == "unknown_device" else 400
            if (_lan_job and _lan_job["state"] == "running"):
                return jsonify({"error": "scan_running"}), 409
            if not _lan_read_lock.acquire(blocking=False):
                return jsonify({"error": "read_running"}), 409
    try:
        try:
            result = device_values.read(context)
        except lan_scan.ScannerUnavailable:
            return jsonify({"error": "scanner_unavailable"}), 503
        except Exception:
            return jsonify({"error": "read_failed"}), 502
        with _account_lock:
            current, current_key = _lan_session()
            if not current or current_key != session_key or generation != _account_generation:
                return jsonify({"error": "account_changed"}), 409
            current_devices = _session_devices(current) or []
            with _lan_lock:
                results = (_lan_body_for(session_key) or _empty_lan_body())["results"]
                try:
                    latest = device_values.connection(current_devices, results, device_id)
                except device_values.ReadUnavailable:
                    latest = None
                if latest != context:
                    return jsonify({"error": "device_changed"}), 409
            return _devices_response(dict(result, device_id=device_id), current)
    finally:
        _lan_read_lock.release()


@app.post("/api/support-report")
def download_support_report():
    if request.content_length is not None and request.content_length > 4096:
        return jsonify({"error": "request_too_large"}), 413
    data = _json_object()
    device_id = data.get("device_id")
    if not isinstance(device_id, str) or not device_id or len(device_id) > 256:
        return jsonify({"error": "invalid_device"}), 400
    with _account_lock:
        session, session_key = _lan_session()
        if not session:
            return jsonify({"error": "not_logged_in"}), 401
        error = _scan_account_precondition(session, data)
        if error:
            return error
        generation = _account_generation
        with _devices_cache_lock:
            cache = _devices_cache_for_session(session)
            if not cache:
                return jsonify({"error": "no_devices"}), 409
            devices = copy.deepcopy([d for d in cache["body"].get("devices", []) if isinstance(d, dict)])
            snapshot_at = cache.get("cached_at")
        current = {device.get("id"): device for device in devices}
        if device_id not in current:
            return jsonify({"error": "unknown_device"}), 404
        with _lan_lock:
            stored = _lan_body_for(session_key) or _empty_lan_body()
            evidence = stored.get("key_evidence") or {}
            results = {dev_id: dict(copy.deepcopy(result),
                                   key_current=_lan_key_current(result, evidence.get(dev_id), current))
                       for dev_id, result in (stored.get("results") or {}).items()}
            job = copy.deepcopy(_job_view(_lan_job)) if _lan_job and _lan_job["session_key"] == session_key else None
    try:
        report = support_report.build(devices, results, device_id, snapshot_at, job=job, session=session)
    except Exception as error:
        app.logger.warning("Support report unavailable: %s", type(error).__name__)
        return jsonify({"error": "report_unavailable"}), 502
    with _account_lock:
        current_session, current_key = _lan_session()
        if not current_session or current_key != session_key or generation != _account_generation:
            return jsonify({"error": "account_changed"}), 409
        return _devices_response({"report": report}, current_session)


@app.get("/api/lan/scan")
def lan_scan_progress():
    session, session_key = _lan_session()
    if not session:
        return jsonify({"error": "not_logged_in"}), 401
    with _lan_lock:
        job = _lan_job if _lan_job and _lan_job["session_key"] == session_key else None
        return _devices_response({"job": _job_view(job)}, session)


@app.delete("/api/lan/scan")
def lan_scan_cancel():
    data = _json_object()
    with _account_lock:
        session, session_key = _lan_session()
        if not session:
            return jsonify({"error": "not_logged_in"}), 401
        error = _scan_account_precondition(session, data)
        if error:
            return error
        with _lan_lock:
            if _lan_job and _lan_job["session_key"] == session_key and _lan_job["state"] == "running":
                _lan_job["cancel"].set()
        return _devices_response({"ok": True}, session)


# Local-only control lives in its own module. It reuses the encrypted caches, so
# no cloud request is needed to read or command a device once login + scan were
# done. Register last so every app-level before_request/after_request hook above
# applies to these routes too.
import local_control  # noqa: E402

app.register_blueprint(local_control.bp)

import haier_control  # noqa: E402
app.register_blueprint(haier_control.bp)

# Additive: an opt-in client mode forwards a small allowlist of API calls to a
# family hub. Default is off, so every existing installation is unaffected.
import family_hub  # noqa: E402
app.register_blueprint(family_hub.bp)


@app.before_request
def _family_hub_proxy():
    if not family_hub.should_proxy(request.method, request.path):
        return None
    path = request.path
    if request.query_string:
        path += "?" + request.query_string.decode("utf-8", "replace")
    try:
        code, raw, ctype = family_hub.proxy_request(
            request.method, path, request.get_data(), request.content_type or ""
        )
    except family_hub.FamilyError as exc:
        return jsonify({"error": str(exc)}), 502
    return Response(raw, status=code, content_type=ctype)


def _auth_is_configured():
    """The same credentials _require_auth() enforces, re-read for launchers."""
    return bool((AUTH_USERNAME and AUTH_PASSWORD)
                or (_setting("AUTH_USERNAME") and _setting("AUTH_PASSWORD")))


def _binding_host(host=None):
    """Where a launcher intends to listen, from its argument, env or argv.

    No hint means 0.0.0.0: the safe assumption for the waitress entry points,
    which must opt in before exposing unauthenticated local keys.
    """
    if host is not None and str(host).strip():
        return str(host).strip()
    for name in ("HOST", "SERVER_HOST", "FLASK_RUN_HOST", "WAITRESS_HOST"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    argv = sys.argv[1:]
    for index, arg in enumerate(argv):
        if arg.startswith("--host="):
            value = arg.split("=", 1)[1].strip()
            if value:
                return value
        if arg == "--host" and index + 1 < len(argv):
            value = argv[index + 1].strip()
            if value:
                return value
    return "0.0.0.0"


def _is_loopback_host(host):
    value = str(host or "").strip().lower()
    if not value:
        return False
    if value.startswith("[") and "]" in value:
        value = value[1:value.index("]")]
    elif value.count(":") == 1:   # host:port, not an unbracketed IPv6 address
        value = value.split(":", 1)[0]
    if value in {"localhost", "localhost.localdomain"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def check_no_auth_binding(host=None):
    """Guard a server start that would expose local keys without auth.

    Callers pass the address they bind to; otherwise HOST, SERVER_HOST,
    FLASK_RUN_HOST, WAITRESS_HOST or --host supplies it. Production WSGI
    startup imports wsgi.py, which calls this before the socket is opened.
    It is not called by importing app.py itself, so a Flask test client can
    reload the app without credentials. INGRESS_ONLY is a deliberate safe
    exception: HA has authenticated the user and the Supervisor is the only
    permitted request source.
    """
    if _auth_is_configured() or INGRESS_ONLY:
        return
    bind_host = _binding_host(host)
    if _is_loopback_host(bind_host):
        return
    message = (
        "AUTH_USERNAME/AUTH_PASSWORD are not set: binding to "
        f"{bind_host} would expose device local keys over HTTP without "
        "authentication. Set AUTH_USERNAME and AUTH_PASSWORD, set "
        "INGRESS_ONLY=1 for Home Assistant Supervisor ingress, or set "
        "ALLOW_NO_AUTH=1 to accept that risk explicitly."
    )
    if os.environ.get("ALLOW_NO_AUTH") != "1":
        raise RuntimeError(message)
    print("WARNING: " + message, file=sys.stderr)


def run_dev_server():
    """Flask's development server, for working on the app from source.
    """
    host = "127.0.0.1"
    check_no_auth_binding(host)
    app.run(host=host, port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    run_dev_server()
