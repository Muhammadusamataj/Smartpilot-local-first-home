"""Local-only device control, served at /local by the existing web app.

Uses the encrypted device cache (keys) and LAN scan cache (IP + protocol) from
Tuya Local Key. No cloud request is made here: status reads and commands go
straight to the device over tinytuya.
"""

from __future__ import annotations

import contextlib
import datetime
import ipaddress
import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, Response, jsonify, redirect, render_template, request, url_for

import device_cache
import device_values
import lan_scan
import pilot_extras
import tuya_devices
import tuya_versions

bp = Blueprint("local_control", __name__)

SESSION_FILE = os.environ.get(
    "SESSION_FILE", os.path.expanduser("~/.config/tuya-smartlife/session.json")
)
_SESSION_DIR = os.path.dirname(SESSION_FILE) or "."
DEVICE_CACHE_FILE = os.environ.get(
    "DEVICE_CACHE_FILE", os.path.join(_SESSION_DIR, "devices.cache")
)
DEVICE_CACHE_KEY_FILE = os.environ.get(
    "DEVICE_CACHE_KEY_FILE", os.path.join(_SESSION_DIR, "cache.key")
)
LAN_CACHE_FILE = os.environ.get("LAN_CACHE_FILE", os.path.join(_SESSION_DIR, "lan.cache"))
# Plain, non-secret memory of the last LAN address that worked. This lets the
# app reconnect on the next launch without a full scan. No keys are stored here.
LAN_PROFILE_FILE = os.environ.get(
    "LAN_PROFILE_FILE", os.path.join(_SESSION_DIR, "lan-profile.json")
)
# Non-secret sidecars for UI state. They live next to the LAN profile and never
# contain a local key, token or a live device read.
_PREFS_DIR = os.path.dirname(LAN_PROFILE_FILE) or "."
LAN_LOCAL_PREFS_FILE = os.environ.get(
    "LOCAL_PREFS_FILE", os.path.join(_PREFS_DIR, "local-preferences.json")
)
LAN_SCENES_FILE = os.environ.get(
    "LOCAL_SCENES_FILE", os.path.join(_PREFS_DIR, "local-scenes.json")
)

MAX_VALUE_BYTES = 4096
# A failed read should not start a subnet scan on every refresh. Back off from
# 2min to 30min, and never scan when the saved address still answers on 6668.
RECONNECT_MIN_SECONDS = 120
RECONNECT_MAX_SECONDS = 1800
TCP_PROBE_SECONDS = 0.4
# A saved address is not proof that the device is alive right now. Only a
# successful local read within this window earns the "Online" label.
REACHABLE_FRESH_SECONDS = 600
READBACK_STATUSES = {
    "unreachable", "no_values", "key_or_protocol", "connection_failed", "read_failed",
}
# Sidecar limits: a corrupt/oversized file must never break the devices page.
MAX_LOCAL_JSON_BYTES = 2 * 1024 * 1024
MAX_LIST_ENTRIES = 500
MAX_SCENE_ACTIONS = 20
MAX_NAME_CHARS = 60
SCHEDULER_INTERVAL_SECONDS = 30
SCHEDULER_NOTE = (
    "Schedules run only while this server process is running. Phone-closed "
    "execution requires an always-on host such as the desktop service or HA add-on."
)
_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_TIME_RE = re.compile(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]\Z")
_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")

_ensure_lock = threading.Lock()
_profile_lock = threading.RLock()
_prefs_lock = threading.RLock()
_scenes_lock = threading.RLock()
_device_locks_guard = threading.Lock()
_device_locks: dict[str, threading.RLock] = {}


def _device_lock(device_id: str) -> threading.RLock:
    """Serialize status reads and writes for one device (and its gateway)."""
    with _device_locks_guard:
        return _device_locks.setdefault(str(device_id), threading.RLock())


@contextlib.contextmanager
def _busy_guard(device_id: str, wait_seconds: float = 0):
    """Serialize local sessions. Commands may briefly wait for an ongoing read.

    Status polling remains non-blocking, so background polling never queues up
    behind an interactive write. This is a wait for a lock, NOT a retry of a write.
    """
    lock = _device_lock(device_id)
    acquired = lock.acquire(timeout=wait_seconds) if wait_seconds > 0 else lock.acquire(blocking=False)
    if not acquired:
        yield False
        return
    try:
        yield True
    finally:
        lock.release()

_ensure_state = {
    "running": False, "started_at": 0.0, "finished_at": 0.0,
    "swept": 0, "addresses": 0, "matched": 0, "reason": "",
}
MAX_STRING_CHARS = 256

# The scan cache is the source of truth for the IP. These messages only explain
# why it could not be resolved, without exposing keys or raw SDK errors.
_ISSUE_MESSAGES = {
    "missing_ip": "IP abhi save nahi hua. Auto scan apne aap chal raha hai — thoda wait karein.",
    "missing_protocol": "Protocol version detect nahi hua. Version ko Auto karein ya Scan network dobara chalayein.",
    "no_local_key": "Local key nahi mili. Main screen par dobara login karein.",
    "gateway_unavailable": "Is sub-device ka gateway cache me nahi. Refresh karein phir Scan network.",
    "missing_node_id": "Sub-device node ID nahi mila. Dobara login karein.",
    "unknown_device": "Ye device list me nahi. Refresh karein.",
    "unverified": "Address saved hai, par abhi local reply nahi mila. pehli read ka intezaar karein.",
    "busy": "Ye device abhi busy hai. Thoda wait karke dobara karein.",
    "readback_mismatch": "Command bheja gaya, par device ne nayi value confirm nahi ki.",
    "readback_failed": "Command bheja gaya, par readback nahi ho paya.",
}


def _message(code: str) -> str:
    return _ISSUE_MESSAGES.get(code, code)


def _ip_hint(device: dict) -> str:
    """A cached cloud IP, used only as a scan hint / one-device check target."""
    text = str(device.get("ip") or "").strip()
    try:
        if text and ipaddress.ip_address(text):
            return text
    except ValueError:
        pass
    return ""


def _normalise_hint(text: str) -> str:
    """A detected IP or subnet, normalised to a scan-ready /24 network."""
    text = str(text or "").strip()
    if not text:
        return ""
    try:
        if "/" in text:
            network = ipaddress.ip_network(text, strict=False)
        else:
            network = ipaddress.ip_network(f"{ipaddress.ip_address(text)}/24", strict=False)
    except ValueError:
        return ""
    return str(network) if network.version == 4 else ""


def _detected_subnet() -> str:
    """The subnet Android/Windows detected, or the configured LAN_SUBNET."""
    for name in ("TUYA_NETWORK_HINT", "LAN_SUBNET"):
        value = _normalise_hint(os.environ.get(name, ""))
        if value:
            return value
    return ""


def _subnet_hint(devices: list[dict]) -> str:
    detected = _detected_subnet()
    if detected:
        return detected
    for device in devices:
        ip = _ip_hint(device)
        if ip:
            return str(ipaddress.ip_network(f"{ip}/24", strict=False))
    return ""


def _network_warning(results: dict | None = None) -> dict | None:
    """Say when saved device IPs cannot be reached from this machine's subnet.

    On Android the Wi-Fi subnet comes from the host app; on other clients app.py
    puts it in the same environment. A different subnet makes every local read
    "unreachable", and a scan only reports the phone/router as refusing 6668.
    """
    # An explicit hint (Android passes the phone's Wi-Fi /24) proves where this
    # client is. A subnet guessed from the default route must not produce a
    # false "different network" warning.
    if not os.environ.get("TUYA_NETWORK_HINT_EXPLICIT"):
        return None
    local = _normalise_hint(os.environ.get("TUYA_NETWORK_HINT", ""))
    if not local:
        return None
    explicit = _normalise_hint(os.environ.get("LAN_SUBNET", ""))
    local_net = ipaddress.ip_network(local)
    explicit_net = ipaddress.ip_network(explicit) if explicit else None
    saved = {}
    for result in (results if results is not None else _merged_results()).values():
        if not isinstance(result, dict) or result.get("status") == lan_scan.OK:
            continue
        ip = _normalise_hint(result.get("ip"))
        if ip and ip not in saved:
            saved[ip] = ipaddress.ip_network(ip)
    if not saved:
        return None
    if explicit_net and all(net.subnet_of(explicit_net) for net in saved.values()):
        return None
    outside = sorted(str(net) for net in saved.values() if not net.subnet_of(local_net))
    if not outside:
        return None
    return {
        "code": "subnet_mismatch",
        "local": local,
        "devices": outside,
        "message": (
            f"Devices are saved on {', '.join(outside)}, but this machine is on "
            f"{local}. TCP port 6668 cannot be reached between different Wi-Fi "
            "networks. Connect to the devices' 2.4 GHz Wi-Fi (or allow routing "
            "to their subnet), then try again."
        ),
    }


def _body(path: str) -> dict:
    entry = device_cache.load(path, DEVICE_CACHE_KEY_FILE)
    return (entry or {}).get("body") or {}


def _devices() -> list[dict]:
    rows = _body(DEVICE_CACHE_FILE).get("devices") or []
    return [row for row in rows if isinstance(row, dict)]


def _results() -> dict:
    rows = _body(LAN_CACHE_FILE).get("results") or {}
    return rows if isinstance(rows, dict) else {}


def _profiles() -> dict:
    """Read the saved LAN connections (IP/version only, never a local key)."""
    with _profile_lock:
        try:
            data = json.loads(Path(LAN_PROFILE_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
    return data if isinstance(data, dict) else {}


def _save_profiles(profiles: dict) -> None:
    path = Path(LAN_PROFILE_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with _profile_lock:
        temp.write_text(json.dumps(profiles, indent=2, sort_keys=True), encoding="utf-8")
        os.replace(temp, path)


def _profile_failed(profile: dict) -> bool:
    """A profile with recent failures is not a trustworthy success record."""
    last_ok = float(profile.get("last_ok") or 0)
    last_failed = float(profile.get("last_failed") or 0)
    return (last_failed > last_ok or int(profile.get("fail_count") or 0) >= 3)


def _merged_results() -> dict:
    """LAN scan results plus the last addresses that answered.

    A saved address stays usable for retries, but a fresh failure/gateway result
    or an old profile is never promoted to "ok": an address is not live status.
    """
    results = dict(_results())
    for device_id, profile in _profiles().items():
        ip = str(profile.get("ip") or "").strip()
        version = str(profile.get("version") or "").strip()
        if not ip or not tuya_versions.is_supported(version):
            continue
        current = dict(results.get(device_id) or {})
        current_ts = float(current.get("checked_at") or current.get("last_ok") or 0)
        saved_ts = float(profile.get("last_ok") or profile.get("checked_at") or 0)
        if current and current_ts >= saved_ts:
            # A newer scan result wins, including VIA_GATEWAY / unreachable results
            # that carry no IP of their own.
            results[device_id] = current
            continue
        failed = _profile_failed(profile)
        current.setdefault("status", "stale" if failed else lan_scan.OK)
        if not failed or not current.get("status"):
            current["status"] = "stale" if failed else lan_scan.OK
        current.update({
            "ip": ip,
            "version": version,
            "checked_at": saved_ts or time.time(),
        })
        if "device22" in profile:
            current["device22"] = bool(profile["device22"])
        results[device_id] = current
    return results


def _remember_success(device_id: str, context: dict) -> None:
    with _profile_lock:
        profiles = _profiles()
        entry = dict(profiles.get(device_id) or {})
        now = time.time()
        entry.update({
            "ip": context["ip"],
            "version": str(context["version"]),
            "device22": bool(context.get("device22")),
            "subnet": _detected_subnet() or entry.get("subnet", ""),
            "last_ok": now,
            "checked_at": now,
            "last_failed": 0,
            "fail_count": 0,
        })
        profiles[device_id] = entry
        _save_profiles(profiles)


def _remember_failure(device_id: str, context: dict, status: str) -> None:
    with _profile_lock:
        profiles = _profiles()
        entry = dict(profiles.get(device_id) or {})
        if context.get("ip"):
            entry.setdefault("ip", context["ip"])
            entry.setdefault("version", str(context["version"]))
        entry["fail_count"] = int(entry.get("fail_count") or 0) + 1
        entry["checked_at"] = time.time()
        entry["last_failed"] = entry["checked_at"]
        profiles[device_id] = entry
        _save_profiles(profiles)
        failed = entry["fail_count"] >= 3 and status in READBACK_STATUSES
    if failed:
        _ensure_async()


def repair_state() -> dict:
    return dict(_ensure_state)


def _by_id(devices: list[dict]) -> dict[str, dict]:
    return {str(d.get("id")): d for d in devices if d.get("id")}


# Tuya reports scaled integers in the DP schema (`scale`) together with a
# display unit. Keep only known units instead of echoing arbitrary cloud text
# into the UI. The replacement character is what Windows produces for the
# middle dot in "kW·h" when the cache is decoded with the wrong codec.
_UNIT_ALIASES = {
    "kwh": "kWh", "kw h": "kWh", "wh": "Wh",
    "ma": "mA", "a": "A", "v": "V", "w": "W", "kw": "kW",
    "c": "°C", "°c": "°C", "℃": "°C", "f": "°F", "℉": "°F",
    "%": "%", "ppm": "ppm", "s": "s", "min": "min", "h": "h",
    "ms": "ms", "db": "dB", "lux": "lux", "l": "L", "ml": "mL",
}


def _clean_unit(value) -> str:
    """Return a short, known display unit, or an empty string."""
    if not isinstance(value, str):
        return ""
    text = value.strip().lower().replace("\ufffd", "").replace("·", " ").strip()
    if not text or len(text) > 8:
        return ""
    return _UNIT_ALIASES.get(text, "")


def _range(spec: dict) -> dict:
    """Read Tuya's `values` JSON into min/max/step/options/scale/unit."""
    raw = spec.get("values")
    if not isinstance(raw, str):
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key in ("min", "max", "step"):
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = value
    # A non-negative integer scale means the raw value is value / 10**scale.
    # Accept floats only when they are whole numbers (some clouds send 2.0).
    scale = data.get("scale")
    if isinstance(scale, (int, float)) and not isinstance(scale, bool):
        if 0 <= scale <= 6 and float(scale).is_integer():
            out["scale"] = int(scale)
    unit = _clean_unit(data.get("unit"))
    if unit:
        out["unit"] = unit
    options = data.get("range")
    if isinstance(options, list) and 1 <= len(options) <= 64:
        out["options"] = [str(item) for item in options]
    return out


def _points(device: dict) -> list[dict]:
    """DP metadata from the cached cloud spec, never the local key."""
    status = device.get("status") or {}
    functions = device.get("function") or {}
    ranges = device.get("status_range") or {}
    strategy = device.get("local_strategy") or {}
    points = []
    for dp, info in sorted(strategy.items(), key=lambda pair: int(pair[0]) if str(pair[0]).isdigit() else 9999):
        dp = str(dp)
        if not dp.isdigit():
            continue
        info = info if isinstance(info, dict) else {}
        code = str(info.get("status_code") or info.get("function_code") or dp)
        spec = functions.get(code) or ranges.get(code) or {}
        spec = spec if isinstance(spec, dict) else {}
        dtype = str(spec.get("type") or "").lower()
        if not dtype and code in status:
            value = status.get(code)
            dtype = "boolean" if isinstance(value, bool) else "integer" if isinstance(value, int) else "string"
        item = {"dp": dp, "code": code, "type": dtype}
        item.update(_range(spec))
        item["cloud_value"] = status.get(code)
        points.append(item)
    return points


def _verified(device_id: str, context: dict | None, results: dict, profiles: dict) -> bool:
    """True only after a recent successful local read of this exact device."""
    if not context or not context["ip"]:
        return False
    result = results.get(device_id) or {}
    profile = profiles.get(device_id) or {}
    if context["node_id"] and result.get("sub_online") is not True:
        return False
    if str(result.get("status") or "") != lan_scan.OK:
        return False
    if _profile_failed(profile):
        return False
    checked = max(
        float(result.get("checked_at") or result.get("last_ok") or 0),
        float(profile.get("last_ok") or 0),
    )
    return checked > 0 and time.time() - checked <= REACHABLE_FRESH_SECONDS


def _public(device: dict, context: dict | None, issue: str = "", *,
            results: dict | None = None, profiles: dict | None = None,
            favorite: bool = False, room_id: str = "", room_name: str = "",
            room_status: str = "unknown", home_id: str = "",
            home_name: str = "") -> dict:
    device_id = str(device.get("id") or "")
    verified = _verified(device_id, context, results or {}, profiles or {})
    lan_known = bool(context and context["ip"])
    return {
        "id": device_id,
        "name": str(device.get("name") or device.get("id") or ""),
        "category": str(device.get("category") or ""),
        "product_name": str(device.get("product_name") or ""),
        "ip": context["ip"] if context else "",
        "ip_hint": _ip_hint(device),
        "version": context["version"] if context else "",
        "sub": bool(context and context["node_id"]),
        "gateway": bool(context and context["gateway"]),
        # Kept for compatibility: "we have an address to try", not live status.
        "reachable": lan_known,
        "lan_known": lan_known,
        "verified": verified,
        "status_label": "Online" if verified else ("Address saved" if lan_known else "Offline"),
        "issue": issue,
        "issue_message": _message(issue) if issue else "",
        "points": _points(device),
        # Additive UI metadata; no existing field is removed or reinterpreted.
        "favorite": bool(favorite),
        "room_id": room_id,
        "room_name": room_name,
        "room_status": room_status,
        "home_id": home_id,
        "home_name": home_name,
    }


def _auto_detect_version(devices: list[dict], results: dict, device_id: str):
    """Probe every supported protocol for an "Auto" device.

    Uses the same address/key resolution as a normal read but never mutates
    state. Returns (version, device22) for the first protocol that answers, or
    None when the device is unreachable / the local driver is unavailable.
    """
    try:
        context = device_values.connection(devices, results, device_id, allow_auto=True)
    except device_values.ReadUnavailable:
        return None
    if tuya_versions.is_supported(context["version"]):
        return context["version"], bool(context["device22"])
    for version in tuya_versions.AUTO_DETECT_VERSIONS:
        try:
            outcome = lan_scan.probe(context["host_id"], context["ip"], context["key"],
                                     version, gateway=context["gateway"])
        except lan_scan.ScannerUnavailable:
            return None
        if outcome.get("match"):
            return version, bool(outcome.get("device22"))
    return None


def _store_detected_version(device_id: str, context: dict, version: str, device22: bool) -> None:
    """Cache the detected protocol so later reads never have to probe again."""
    now = time.time()
    host_id = context["host_id"]
    lan_body = _body(LAN_CACHE_FILE)
    results = dict(lan_body.get("results") or {})
    entry = dict(results.get(host_id) or {})
    entry.update({
        "status": lan_scan.OK, "ip": context["ip"], "version": version,
        "device22": bool(device22), "checked_at": now,
    })
    results[host_id] = entry
    lan_body["results"] = results
    _write_cache(LAN_CACHE_FILE, lan_body)
    with _profile_lock:
        profiles = _profiles()
        profile = dict(profiles.get(device_id) or {})
        profile.update({
            "ip": context["ip"], "version": version, "device22": bool(device22),
            "checked_at": now, "last_ok": now, "last_failed": 0, "fail_count": 0,
        })
        profiles[device_id] = profile
        _save_profiles(profiles)


def _context(device_id: str):
    devices = _devices()
    if not _by_id(devices).get(device_id):
        raise device_values.ReadUnavailable("unknown_device")
    results = _merged_results()
    try:
        return device_values.connection(devices, results, device_id)
    except device_values.ReadUnavailable as error:
        if str(error) != "missing_protocol":
            raise
    # "Auto" (or a legacy empty version): probe once, remember the answer.
    detected = _auto_detect_version(devices, results, device_id)
    if not detected:
        raise device_values.ReadUnavailable("missing_protocol")
    context = device_values.connection(devices, results, device_id, allow_auto=True)
    _store_detected_version(device_id, context, detected[0], detected[1])
    return device_values.connection(devices, _merged_results(), device_id)


def _coerce(value, point: dict):
    """Validate a command against the cached DP spec. Returns (value, error)."""
    dtype = point.get("type", "")
    if dtype in ("bool", "boolean"):
        if isinstance(value, bool):
            return value, None
        text = str(value).strip().lower()
        if text in {"true", "1", "on", "yes"}:
            return True, None
        if text in {"false", "0", "off", "no"}:
            return False, None
        return None, "invalid_value"
    if dtype in ("int", "integer", "value"):
        try:
            number = int(str(value).strip())
        except (ValueError, TypeError):
            return None, "invalid_value"
        low, high = point.get("min"), point.get("max")
        if (low is not None and number < low) or (high is not None and number > high):
            return None, "out_of_range"
        return number, None
    if dtype in ("enum", "string", "str", "json", "raw"):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        if len(text.encode("utf-8")) > MAX_VALUE_BYTES:
            return None, "value_too_large"
        if dtype == "enum":
            options = point.get("options") or []
            if options and text not in options:
                return None, "invalid_value"
            return text, None
        if dtype in ("json", "raw"):
            try:
                parsed = json.loads(text)
            except ValueError:
                return None, "invalid_value"
            if not isinstance(parsed, (dict, list)):
                return None, "invalid_value"
            return parsed, None
        if len(text) > MAX_STRING_CHARS:
            return None, "value_too_large"
        return text, None
    # Unknown type: only accept a small scalar, never an arbitrary object.
    if isinstance(value, (bool, int)):
        return value, None
    if isinstance(value, str) and len(value) <= MAX_STRING_CHARS:
        return value, None
    return None, "unsupported_dp_type"


def _same_value(actual, expected) -> bool:
    """Compare a readback value with the command, allowing SDK type coercion."""
    if isinstance(expected, bool):
        return actual is expected or str(actual).strip().lower() in {
            "true", "1",
        } if expected else actual is False or str(actual).strip().lower() in {"false", "0"}
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        try:
            return float(actual) == float(expected)
        except (TypeError, ValueError):
            return False
    return str(actual) == str(expected)


def _readback(context: dict, dp: str, value) -> dict:
    """Confirm the write with up to two READS, never resend the write.

    Some Tuya devices acknowledge a command before their status DP is updated.
    A short delayed read can distinguish propagation lag from a true mismatch.
    Uncertainty is returned as uncertainty, not as a definitive OFF/ON result.
    """
    last = {"ok": False, "error": "readback_failed"}
    for attempt in range(2):
        if attempt:
            time.sleep(0.55)  # read-only retry: no extra set_value is issued
        outcome = device_values.read(context)
        if outcome.get("status") != "ok":
            last = {"ok": False, "error": "readback_failed", "status": outcome.get("status")}
            continue
        dps = outcome.get("dps") or {}
        if dp in dps and _same_value(dps[dp], value):
            return {"ok": True, "confirmed": True}
        last = {"ok": False, "error": "readback_mismatch"}  # don't leak raw DP values
    return last


def _send(context: dict, dp: str, value) -> dict:
    """Set one DP locally, closing every socket on all paths, then read back."""
    parent = child = None
    try:
        version = "3.3" if context["version"] == "3.2" else context["version"]
        parent = lan_scan._new_device(context["host_id"], context["ip"], context["key"], version)
        parent.disabledetect = context["gateway"]
        if context["device22"] or context["version"] == "3.2":
            parent.dev_type = "device22"
            parent.set_dpsUsed({item: None for item in context["dp_ids"]})
        device = parent
        if context["node_id"]:
            device = child = lan_scan._load_tinytuya().Device(
                context["device_id"], cid=context["node_id"], parent=parent,
                connection_timeout=lan_scan.PROBE_TIMEOUT_SECONDS,
                connection_retry_limit=1, connection_retry_delay=0,
            )
        reply = device.set_value(int(dp), value)
        if isinstance(reply, dict) and reply.get("Err"):
            return {"ok": False, "error": "device_error"}
    except OSError:
        return {"ok": False, "error": "unreachable"}
    except lan_scan.ScannerUnavailable:
        return {"ok": False, "error": "scanner_unavailable"}
    except Exception:
        return {"ok": False, "error": "command_failed"}
    finally:
        for device in (child, parent):
            if device is not None:
                try:
                    device.close()
                except Exception:
                    pass
    return _readback(context, dp, value)


# --- Preferences, rooms and scenes ---------------------------------------
# Everything here is additive UI state. The files are plain JSON next to the
# LAN profile; they never hold a local key, a token or a live device read.

def _load_local_json(path: str, default: dict) -> dict:
    """Read a small sidecar dict; size/format errors become an empty dict."""
    try:
        if Path(path).stat().st_size > MAX_LOCAL_JSON_BYTES:
            return dict(default)
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return dict(default)
    return data if isinstance(data, dict) else dict(default)


def _save_local_json(path: str, body: dict, prefix: str) -> None:
    payload = json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")
    tuya_devices.atomic_write(path, payload, prefix=prefix)


def _valid_id(value) -> bool:
    return isinstance(value, str) and bool(_ID_RE.fullmatch(value))


def _clean_name(value, *, allow_empty: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if len(text) > MAX_NAME_CHARS:
        return None
    if not text and not allow_empty:
        return None
    return text


def _as_text(value) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _safe_ts(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number >= 0 else 0.0


def _empty_preferences() -> dict:
    return {"favorites": [], "rooms": {}, "homes": [], "updated_at": 0.0}


def _normalise_preferences(data) -> dict:
    """Drop malformed entries instead of letting them break the devices page."""
    out = _empty_preferences()
    if not isinstance(data, dict):
        return out
    favorites = data.get("favorites")
    if isinstance(favorites, list):
        for item in favorites:
            if len(out["favorites"]) >= MAX_LIST_ENTRIES:
                break
            if _valid_id(item) and item not in out["favorites"]:
                out["favorites"].append(item)
    rooms = data.get("rooms")
    if isinstance(rooms, dict):
        for key, value in rooms.items():
            if len(out["rooms"]) >= MAX_LIST_ENTRIES:
                break
            name = _clean_name(value, allow_empty=True)
            if _valid_id(key) and name is not None:
                out["rooms"][key] = name
    homes = data.get("homes")
    if isinstance(homes, list):
        for entry in homes:
            if len(out["homes"]) >= MAX_LIST_ENTRIES:
                break
            if not isinstance(entry, dict):
                continue
            home_id, name = entry.get("id"), _clean_name(entry.get("name"))
            if _valid_id(home_id) and name is not None:
                if any(home["id"] == home_id for home in out["homes"]):
                    continue
                out["homes"].append({"id": home_id, "name": name})
    out["updated_at"] = _safe_ts(data.get("updated_at", 0.0))
    return out


def _load_preferences() -> dict:
    with _prefs_lock:
        return _normalise_preferences(_load_local_json(LAN_LOCAL_PREFS_FILE, {}))


def _save_preferences(body: dict) -> None:
    with _prefs_lock:
        _save_local_json(LAN_LOCAL_PREFS_FILE, body, ".local-prefs-")


def _validate_preferences_input(data) -> tuple[dict | None, str | None]:
    """Strict POST validation; never copy unknown fields into the file."""
    if not isinstance(data, dict):
        return None, "invalid_request"
    favorites = data.get("favorites", [])
    if not isinstance(favorites, list) or len(favorites) > MAX_LIST_ENTRIES:
        return None, "invalid_favorites"
    clean_favorites = []
    for item in favorites:
        if not _valid_id(item):
            return None, "invalid_favorites"
        if item not in clean_favorites:
            clean_favorites.append(item)

    rooms = data.get("rooms", {})
    if not isinstance(rooms, dict) or len(rooms) > MAX_LIST_ENTRIES:
        return None, "invalid_rooms"
    clean_rooms = {}
    for key, value in rooms.items():
        name = _clean_name(value, allow_empty=True)
        if not _valid_id(key) or name is None:
            return None, "invalid_rooms"
        clean_rooms[key] = name

    homes = data.get("homes", [])
    if not isinstance(homes, list) or len(homes) > MAX_LIST_ENTRIES:
        return None, "invalid_homes"
    clean_homes = []
    for entry in homes:
        if not isinstance(entry, dict):
            return None, "invalid_homes"
        home_id, name = entry.get("id"), _clean_name(entry.get("name"))
        if not _valid_id(home_id) or name is None:
            return None, "invalid_homes"
        if any(home["id"] == home_id for home in clean_homes):
            continue
        clean_homes.append({"id": home_id, "name": name})

    return {
        "favorites": clean_favorites,
        "rooms": clean_rooms,
        "homes": clean_homes,
        "updated_at": time.time(),
    }, None


def _device_metadata(device: dict, rooms: dict, homes: dict) -> dict:
    """Use cached row metadata first; a saved room name is the only fallback."""
    device_id = str(device.get("id") or "")
    room = device.get("room") if isinstance(device.get("room"), dict) else {}
    home = device.get("home") if isinstance(device.get("home"), dict) else {}
    room_id = _as_text(device.get("room_id")) or _as_text(room.get("id"))
    room_name = _as_text(device.get("room_name")) or _as_text(room.get("name"))
    home_id = _as_text(device.get("home_id")) or _as_text(home.get("id"))
    home_name = _as_text(device.get("home_name")) or _as_text(home.get("name"))
    has_row_room = any(key in device for key in ("room_id", "room_name", "room"))

    if room_name:
        room_status = "assigned"
    elif room_id:
        # The row knows a room ID but gives no name: never invent one.
        room_status = "unknown"
    elif device_id in rooms:
        room_name = _as_text(rooms.get(device_id))
        room_status = "assigned" if room_name else "unassigned"
    elif has_row_room:
        room_status = "unassigned"
    else:
        room_status = "unknown"
    if not home_name and home_id:
        home_name = _as_text(homes.get(home_id))
    return {
        "room_id": room_id, "room_name": room_name, "room_status": room_status,
        "home_id": home_id, "home_name": home_name,
    }


def _empty_schedule() -> dict:
    return {"enabled": False, "time": "", "days": []}


def _parse_schedule(value, *, strict: bool = False) -> tuple[dict, str | None]:
    fallback = _empty_schedule()

    def bad():
        return (fallback, "invalid_schedule") if strict else (fallback, None)

    if not isinstance(value, dict):
        return bad()
    enabled = value.get("enabled", False)
    if not isinstance(enabled, bool):
        return bad()
    text = value.get("time", "")
    if not isinstance(text, str):
        return bad()
    text = text.strip()
    if text and not _TIME_RE.fullmatch(text):
        return bad()
    days = value.get("days", [])
    if not isinstance(days, list) or len(days) > 7:
        return bad()
    clean_days = []
    for day in days:
        if isinstance(day, bool) or not isinstance(day, int) or not 0 <= day <= 6:
            return bad()
        if day not in clean_days:
            clean_days.append(day)
    clean_days.sort()
    if enabled and (not text or not clean_days):
        return bad()
    return {"enabled": enabled, "time": text, "days": clean_days}, None


def _normalise_scene(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    scene_id = item.get("id")
    name = _clean_name(item.get("name"))
    if not _valid_id(scene_id) or name is None:
        return None
    icon = _clean_name(item.get("icon", ""), allow_empty=True)
    if icon is None:
        icon = ""
    raw_actions = item.get("actions")
    if not isinstance(raw_actions, list) or not 1 <= len(raw_actions) <= MAX_SCENE_ACTIONS:
        return None
    actions = []
    for action in raw_actions:
        if not isinstance(action, dict) or "value" not in action:
            return None
        device_id, dp = action.get("device_id"), _as_text(action.get("dp"))
        if not _valid_id(device_id) or not dp.isdigit():
            return None
        actions.append({"device_id": device_id, "dp": dp, "value": action["value"]})
    schedule, _ = _parse_schedule(item.get("schedule"))
    created = _safe_ts(item.get("created_at")) or time.time()
    last_run = item.get("last_run", "")
    if not isinstance(last_run, str) or (last_run and not _DATE_RE.fullmatch(last_run)):
        last_run = ""
    return {
        "id": scene_id, "name": name, "icon": icon, "actions": actions,
        "schedule": schedule, "created_at": created,
        "updated_at": _safe_ts(item.get("updated_at")) or created,
        "last_run": last_run,
    }


def _load_scenes() -> list[dict]:
    with _scenes_lock:
        raw = _load_local_json(LAN_SCENES_FILE, {})
        rows = raw.get("scenes")
        if not isinstance(rows, list):
            return []
        scenes, seen = [], set()
        for item in rows[:MAX_LIST_ENTRIES]:
            scene = _normalise_scene(item)
            if scene is not None and scene["id"] not in seen:
                scenes.append(scene)
                seen.add(scene["id"])
        return scenes


def _save_scenes(scenes: list[dict]) -> None:
    with _scenes_lock:
        _save_local_json(LAN_SCENES_FILE, {"scenes": scenes}, ".local-scenes-")


def _validate_scene_input(data, devices_by_id: dict) -> tuple[dict | None, str | None]:
    """Validate a scene against cached DP metadata; store only coerced values."""
    if not isinstance(data, dict):
        return None, "invalid_request"
    name = _clean_name(data.get("name"))
    if name is None:
        return None, "invalid_name"
    icon = _clean_name(data.get("icon", ""), allow_empty=True)
    if icon is None:
        return None, "invalid_icon"
    raw_actions = data.get("actions")
    if not isinstance(raw_actions, list) or not 1 <= len(raw_actions) <= MAX_SCENE_ACTIONS:
        return None, "invalid_actions"
    actions = []
    for action in raw_actions:
        if not isinstance(action, dict):
            return None, "invalid_actions"
        device_id, dp = action.get("device_id"), _as_text(action.get("dp"))
        if not _valid_id(device_id) or not dp.isdigit():
            return None, "invalid_action"
        device = devices_by_id.get(device_id)
        if not device or not device.get("local_key"):
            return None, "unknown_device"
        point = {item["dp"]: item for item in _points(device)}.get(dp)
        if not point:
            return None, "unknown_dp"
        if "value" not in action:
            return None, "invalid_value"
        value, error = _coerce(action["value"], point)
        if error:
            return None, error
        actions.append({"device_id": device_id, "dp": dp, "value": value})
    schedule, error = _parse_schedule(data.get("schedule", {}), strict=True)
    if error:
        return None, error
    return {"name": name, "icon": icon, "actions": actions, "schedule": schedule}, None


def _scene_result(device_id: str, dp: str, ok: bool, error=None, verified: bool = False) -> dict:
    return {
        "device_id": device_id, "dp": dp, "ok": bool(ok),
        "error": error if not ok else None, "verified": bool(verified),
    }


def _set_scene_last_run(scene_id: str, today: str) -> bool:
    """Claim a scene for today; False means it already ran (or was deleted)."""
    with _scenes_lock:
        scenes = _load_scenes()
        changed = False
        for scene in scenes:
            if scene["id"] == scene_id and scene["last_run"] != today:
                scene["last_run"] = today
                changed = True
        if changed:
            _save_scenes(scenes)
        return changed


def _execute_scene(scene: dict, *, update_last_run: bool = True) -> dict:
    """Run actions in order; a busy device aborts the run before it completes."""
    results = []
    succeeded = failed = 0
    devices_by_id = _by_id(_devices())
    for action in scene["actions"]:
        device_id, dp = action["device_id"], action["dp"]
        with _busy_guard(device_id) as acquired:
            if not acquired:
                results.append(_scene_result(device_id, dp, False, "busy"))
                return {
                    "busy": True, "ok": False, "succeeded": succeeded,
                    "failed": failed + 1, "results": results,
                }
            try:
                context = _context(device_id)
                device = devices_by_id.get(device_id)
                point = ({item["dp"]: item for item in _points(device)}.get(dp)
                         if device else None)
                if not point:
                    result = _scene_result(device_id, dp, False, "unknown_dp")
                else:
                    value, error = _coerce(action.get("value"), point)
                    if error:
                        result = _scene_result(device_id, dp, False, error)
                    else:
                        outcome = _send(context, dp, value)
                        ok = bool(outcome.get("ok"))
                        verified = bool(outcome.get("confirmed") or outcome.get("verified")) if ok else False
                        result = _scene_result(
                            device_id, dp, ok,
                            None if ok else str(outcome.get("error") or "command_failed"),
                            verified,
                        )
            except device_values.ReadUnavailable as error:
                result = _scene_result(device_id, dp, False, str(error))
            except Exception:
                result = _scene_result(device_id, dp, False, "command_failed")
        if result["ok"]:
            succeeded += 1
        else:
            failed += 1
        results.append(result)
    outcome = {
        "ok": failed == 0, "succeeded": succeeded, "failed": failed, "results": results,
    }
    if update_last_run and succeeded:
        _set_scene_last_run(scene["id"], datetime.datetime.now().strftime("%Y-%m-%d"))
    return outcome


def _testing_mode() -> bool:
    """Avoid a background timer under pytest or a TESTING Flask app."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return True
    if os.environ.get("LOCAL_CONTROL_TESTING", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    try:
        if "pytest" in sys.modules:
            return True
    except Exception:
        pass
    try:
        app_module = sys.modules.get("app")
        config = getattr(getattr(app_module, "app", None), "config", None)
        if config is not None and config.get("TESTING"):
            return True
    except Exception:
        pass
    return False


def _due_scenes(scenes, now=None) -> list[dict]:
    """Pure minute/day check: 0=Monday, last_run is a local YYYY-MM-DD."""
    if isinstance(now, datetime.datetime):
        moment = now
    elif isinstance(now, (int, float)):
        moment = datetime.datetime.fromtimestamp(now)
    else:
        moment = datetime.datetime.now()
    today = moment.strftime("%Y-%m-%d")
    minute = moment.strftime("%H:%M")
    weekday = moment.weekday()
    due = []
    for scene in scenes or []:
        if not isinstance(scene, dict) or scene.get("last_run") == today:
            continue
        schedule = scene.get("schedule")
        if not isinstance(schedule, dict) or not schedule.get("enabled"):
            continue
        if schedule.get("time") != minute:
            continue
        days = schedule.get("days")
        if not isinstance(days, list) or weekday not in days:
            continue
        due.append(scene)
    return due


def _scheduler_loop() -> None:
    while True:
        time.sleep(SCHEDULER_INTERVAL_SECONDS)
        try:
            if _testing_mode():
                continue
            today = datetime.datetime.now().strftime("%Y-%m-%d")
            for scene in _due_scenes(_load_scenes()):
                # Claim before running so a slow action cannot overlap a tick.
                if not _set_scene_last_run(scene["id"], today):
                    continue
                _execute_scene(scene, update_last_run=False)
        except Exception:
            # Never log scene values, local keys or tokens.
            continue


_scheduler_started = False


def _start_scheduler() -> None:
    global _scheduler_started
    if _scheduler_started or _testing_mode():
        return
    _scheduler_started = True
    threading.Thread(target=_scheduler_loop, name="local-scenes-scheduler", daemon=True).start()


# --- Silent LAN reconnect -------------------------------------------------
# Once a device has answered, its address is remembered. A later launch uses
# that address first and only does a short, throttled scan if the device no
# longer answers (for example after the phone joined a different Wi-Fi).

def _ensure_async() -> None:
    if _ensure_state["running"]:
        return
    threading.Thread(target=_ensure_connections, name="local-reconnect", daemon=True).start()


def _saved_address(device_id: str, results: dict, profiles: dict) -> tuple[str, str]:
    result = results.get(device_id) or {}
    profile = profiles.get(device_id) or {}
    ip = str(result.get("ip") or profile.get("ip") or "").strip()
    version = str(result.get("version") or profile.get("version") or "").strip()
    return ip, version


def _candidate_subnets(devices: list[dict], profiles: dict) -> list[str]:
    subnets = []
    detected = _detected_subnet()
    if detected:
        subnets.append(detected)
    for device in devices:
        hints = [profiles.get(str(device.get("id")) or {}, {}).get("subnet"), _ip_hint(device)]
        for hint in hints:
            normalised = _normalise_hint(hint)
            if normalised and normalised not in subnets:
                subnets.append(normalised)
        if len(subnets) >= 2:
            break
    return subnets[:2]


def _ensure_connections() -> None:
    with _ensure_lock:
        if _ensure_state["running"]:
            return
        _ensure_state.update({
            "running": True, "started_at": time.time(), "finished_at": 0.0,
            "swept": 0, "addresses": 0, "matched": 0, "reason": "checking",
        })
    try:
        devices = [d for d in _devices() if d.get("local_key") and d.get("id")]
        if not devices:
            _ensure_state["reason"] = "no_devices"
            return
        profiles = _profiles()
        results = _merged_results()
        if _network_warning(results):
            # Scanning a subnet we cannot reach only overwrites good addresses
            # with "unreachable" and wastes the reconnect budget.
            _ensure_state["reason"] = "subnet_mismatch"
            return
        missing = []
        for device in devices:
            try:
                device_values.connection(devices, results, str(device["id"]))
            except device_values.ReadUnavailable:
                missing.append(device)
        if not missing:
            _ensure_state["reason"] = "all_saved"
            return

        # A device that still answers on 6668 does not need a subnet scan: the
        # problem is its key/protocol, which scanning cannot fix.
        need_scan = []
        for device in missing:
            device_id = str(device["id"])
            ip, _ = _saved_address(device_id, results, profiles)
            if ip and lan_scan.tcp_state(ip, TCP_PROBE_SECONDS) == lan_scan.OPEN:
                continue
            need_scan.append(device)
        if not need_scan:
            _ensure_state["reason"] = "device_silent"
            return

        last_attempt = max(
            float((profiles.get(str(d["id"])) or {}).get("last_scan_at") or 0)
            for d in need_scan
        )
        worst_fails = max(
            int((profiles.get(str(d["id"])) or {}).get("fail_count") or 0)
            for d in need_scan
        )
        wait = min(RECONNECT_MAX_SECONDS, RECONNECT_MIN_SECONDS * (2 ** min(worst_fails, 5)))
        if time.time() - last_attempt < wait:
            _ensure_state["reason"] = "waiting"
            return

        subnets = _candidate_subnets(need_scan, profiles)
        if not subnets:
            _ensure_state["reason"] = "no_network"
            return

        targets = ",".join(subnets)
        try:
            addresses = lan_scan.parse_targets(targets)
        except lan_scan.TargetError:
            _ensure_state["reason"] = "bad_network"
            return

        now = time.time()
        for device in need_scan:
            device_id = str(device["id"])
            entry = dict(profiles.get(device_id) or {})
            entry["last_scan_at"] = now
            profiles[device_id] = entry
        _save_profiles(profiles)

        _ensure_state.update({"addresses": len(addresses), "swept": 0, "reason": "scanning"})
        observed = lan_scan.sweep(
            addresses, progress=lambda done: _ensure_state.__setitem__("swept", done))
        open_ips = [ip for ip, state in observed.items() if state == lan_scan.OPEN]

        for device in need_scan:
            device_id = str(device["id"])
            key = str(device.get("local_key") or "")
            saved_ip, saved_version = _saved_address(device_id, results, profiles)
            candidates = []
            for ip in [saved_ip] + open_ips:
                if ip and ip not in candidates:
                    candidates.append(ip)
            versions = []
            for version in (saved_version, device.get("version"), "3.4", "3.3", "3.2", "3.5"):
                version = str(version or "").strip()
                if tuya_versions.is_supported(version) and version not in versions:
                    versions.append(version)
            for ip in candidates:
                for version in versions:
                    try:
                        outcome = lan_scan.probe(device_id, ip, key, version)
                    except lan_scan.ScannerUnavailable:
                        _ensure_state["reason"] = "scanner_unavailable"
                        return
                    if not outcome.get("match"):
                        continue
                    results[device_id] = {
                        "status": lan_scan.OK, "ip": ip, "version": version,
                        "device22": bool(outcome.get("device22")), "checked_at": time.time(),
                    }
                    _remember_success(device_id, {
                        "ip": ip, "version": version, "device22": bool(outcome.get("device22")),
                    })
                    _ensure_state["matched"] += 1
                    break
                if results.get(device_id, {}).get("ip") == ip:
                    break
        _write_cache(LAN_CACHE_FILE, {
            "results": results,
            "summary": {"matched": len(results)},
            "targets": targets,
            "changes": None,
            "changes_at": None,
        })
        _ensure_state["reason"] = "done"
    except Exception:
        _ensure_state["reason"] = "failed"
    finally:
        _ensure_state["running"] = False
        _ensure_state["finished_at"] = time.time()


def _home_assistant() -> bool:
    return bool(
        os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HASSIO_TOKEN")
        or request.headers.get("X-Ingress-Path")
    )


def _tailscale_url() -> str:
    ip = os.environ.get("TAILSCALE_IP", "").strip()
    if not ip:
        return ""
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return ""
    port = os.environ.get("PORT", "8000").strip() or "8000"
    return f"http://{ip}:{port}/local"


@bp.get("/local/")
def local_page_slash():
    """Old clients appended a slash; redirect to the canonical relative-URL base."""
    return redirect(url_for("local_control.local_page"), code=308)


@bp.get("/local")
def local_page():
    devices = _devices()
    ready = bool(devices) and any(d.get("local_key") for d in devices)
    return render_template(
        "local_control.html", ready=ready, device_count=len(devices),
        subnet_hint=_subnet_hint(devices), tailscale_url=_tailscale_url(),
        home_assistant=_home_assistant(),
    )


@bp.get("/api/local/devices")
def local_devices():
    devices = _devices()
    results = _merged_results()
    profiles = _profiles()
    prefs = _load_preferences()
    favorites = set(prefs["favorites"])
    homes = {home["id"]: home["name"] for home in prefs["homes"]}
    rows = []
    for device in devices:
        if not device.get("local_key"):
            continue
        issue = ""
        try:
            context = device_values.connection(devices, results, str(device.get("id")))
        except device_values.ReadUnavailable as error:
            context = None
            issue = str(error)
        metadata = _device_metadata(device, prefs["rooms"], homes)
        rows.append(_public(
            device, context, issue, results=results, profiles=profiles,
            favorite=str(device.get("id")) in favorites, **metadata,
        ))
    rows.sort(key=lambda row: row["name"].lower())
    return jsonify({
        "devices": rows,
        "scanned": any(
            (results.get(str(d.get("id"))) or {}).get("ip") for d in devices
        ),
        "setup_required": not bool(devices),
        "subnet_hint": _subnet_hint(devices),
        "network_warning": _network_warning(results),
        "repair": repair_state(),
    })


@bp.get("/api/local/preferences")
def local_preferences_get():
    return jsonify(_load_preferences())


@bp.post("/api/local/preferences")
def local_preferences_save():
    data = request.get_json(silent=True)
    body, error = _validate_preferences_input(data)
    if error:
        return jsonify({"error": error}), 400
    _save_preferences(body)
    return jsonify(body)


@bp.get("/api/local/scenes")
def local_scenes_get():
    return jsonify({
        "scenes": _load_scenes(),
        "scheduler": {"available": True, "note": SCHEDULER_NOTE},
    })


@bp.post("/api/local/scenes")
def local_scenes_save():
    data = request.get_json(silent=True)
    body, error = _validate_scene_input(data, _by_id(_devices()))
    if error:
        return jsonify({"error": error}), 400
    scene_id = _as_text(data.get("id")) if isinstance(data, dict) and "id" in data else ""
    now = time.time()
    with _scenes_lock:
        scenes = _load_scenes()
        if scene_id:
            if not _valid_id(scene_id):
                return jsonify({"error": "invalid_id"}), 400
            index = next((i for i, item in enumerate(scenes) if item["id"] == scene_id), None)
            if index is None:
                return jsonify({"error": "unknown_scene"}), 404
            scene = dict(scenes[index])
            scene.update(body, updated_at=now)
            scenes[index] = scene
        else:
            if len(scenes) >= MAX_LIST_ENTRIES:
                return jsonify({"error": "too_many_scenes"}), 400
            scene = dict(body, id="scene_" + uuid.uuid4().hex[:16],
                         created_at=now, updated_at=now, last_run="")
            scenes.append(scene)
        _save_scenes(scenes)
    return jsonify({"scene": scene})


@bp.post("/api/local/scenes/run")
def local_scenes_run():
    data = request.get_json(silent=True)
    scene_id = _as_text(data.get("id")) if isinstance(data, dict) else ""
    if not scene_id:
        return jsonify({"error": "invalid_request"}), 400
    scene = next((item for item in _load_scenes() if item["id"] == scene_id), None)
    if scene is None:
        return jsonify({"error": "unknown_scene"}), 404
    outcome = _execute_scene(scene)
    if outcome.get("busy"):
        return jsonify({"error": "busy"}), 409
    return jsonify({key: outcome[key] for key in ("ok", "succeeded", "failed", "results")})


@bp.delete("/api/local/scenes")
def local_scenes_delete():
    scene_id = _as_text(request.args.get("id"))
    if not scene_id:
        return jsonify({"error": "invalid_request"}), 400
    with _scenes_lock:
        scenes = _load_scenes()
        remaining = [item for item in scenes if item["id"] != scene_id]
        if len(remaining) == len(scenes):
            return jsonify({"error": "unknown_scene"}), 404
        _save_scenes(remaining)
    return jsonify({"ok": True})


@bp.post("/api/local/ensure")
def local_ensure():
    """Silently use saved LAN addresses; scan only if they stopped answering."""
    if _ensure_state["running"]:
        return jsonify({"ok": True, **repair_state()})
    devices = [d for d in _devices() if d.get("local_key") and d.get("id")]
    results = _merged_results()
    missing = []
    for device in devices:
        try:
            device_values.connection(devices, results, str(device["id"]))
        except device_values.ReadUnavailable:
            missing.append(device)
    if missing and _detected_subnet():
        _ensure_async()
    return jsonify({"ok": True, **repair_state()})


@bp.get("/api/local/status")
def local_status():
    device_id = str(request.args.get("id") or "").strip()
    with _busy_guard(device_id) as acquired:
        if not acquired:
            return jsonify({"error": "busy", "code": "busy"}), 409
        try:
            context = _context(device_id)
        except device_values.ReadUnavailable as error:
            code = str(error)
            return jsonify({"error": _message(code), "code": code}), 404
        outcome = device_values.read(context)
        if outcome.get("status") != "ok":
            code = str(outcome.get("status") or "read_failed")
            _remember_failure(device_id, context, code)
            return jsonify({"error": _message(code), "code": code, "status": code}), 502
        _remember_success(device_id, context)
        points = {item["dp"]: item for item in _points(_by_id(_devices())[device_id])}
        values = []
        for dp, value in sorted(outcome["dps"].items(), key=lambda pair: int(pair[0])):
            point = points.get(dp, {"dp": dp, "code": dp, "type": ""})
            point = dict(point, value=value)
            # Some devices have no cached DP spec. Infer the type from the live
            # read so a boolean switch still renders as a proper ON/OFF toggle.
            if not point.get("type"):
                if isinstance(value, bool):
                    point["type"] = "boolean"
                elif isinstance(value, int):
                    point["type"] = "integer"
                elif isinstance(value, str):
                    point["type"] = "string"
            values.append(point)
        return jsonify({
            "status": "ok", "verified": True,
            "read_at": outcome.get("read_at"), "values": values,
        })


@bp.post("/api/local/command")
def local_command():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "invalid_request"}), 400
    device_id = str(data.get("device_id") or "").strip()
    dp = str(data.get("dp") or "").strip()
    if not device_id or not dp.isdigit():
        return jsonify({"error": "invalid_request"}), 400
    # An interactive command has priority over background status polling. A
    # short lock wait is safe; never re-issue an uncertain ON/OFF command.
    with _busy_guard(device_id, wait_seconds=2.5) as acquired:
        if not acquired:
            return jsonify({"error": "busy", "code": "busy"}), 409
        try:
            context = _context(device_id)
        except device_values.ReadUnavailable as error:
            code = str(error)
            return jsonify({"error": _message(code), "code": code}), 404
        points = {item["dp"]: item for item in _points(_by_id(_devices())[device_id])}
        point = points.get(dp)
        if not point or "value" not in data:
            return jsonify({"error": "unknown_dp"}), 400
        value, error = _coerce(data["value"], point)
        if error:
            return jsonify({"error": error}), 400
        outcome = _send(context, dp, value)
        if not outcome["ok"]:
            # A delayed readback is NOT proof that the write failed. Do not
            # mark the device offline merely because status was not confirmed.
            if outcome.get("error") not in {"readback_failed", "readback_mismatch"}:
                _remember_failure(device_id, context, outcome.get("error", "command_failed"))
            return jsonify(outcome), 502
        _remember_success(device_id, context)
        return jsonify({"ok": True, "confirmed": True, "dp": dp, "value": value})


# --- Manual devices -----------------------------------------------------
# A user with one phone cannot always scan the Smart Life QR. These endpoints
# let a device be added with its own local key and IP, with no cloud request.

def _write_cache(path: str, body: dict) -> None:
    existing = device_cache.load(path, DEVICE_CACHE_KEY_FILE) or {}
    device_cache.save(path, DEVICE_CACHE_KEY_FILE, {
        "session_key": existing.get("session_key") or "manual",
        "cached_at": time.time(),
        "body": body,
    })


@bp.post("/api/local/device")
def local_add_device():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "invalid_request"}), 400

    name = str(data.get("name") or "").strip()[:60]
    device_id = str(data.get("id") or "").strip()
    key = str(data.get("local_key") or "").strip()
    ip = str(data.get("ip") or "").strip()
    version = str(data.get("version") or tuya_versions.AUTO_VERSION).strip()
    dp = str(data.get("dp") or "1").strip()

    if not name or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", device_id):
        return jsonify({"error": "invalid_device_details"}), 400
    # Tuya local keys are opaque ASCII strings, not necessarily hexadecimal.
    # The repo's own device fixtures contain '+', '?', '!' and '#'.
    if not re.fullmatch(r"[!-~]{16,32}", key):
        return jsonify({"error": "invalid_local_key"}), 400
    try:
        address = ipaddress.IPv4Address(ip)
    except ipaddress.AddressValueError:
        return jsonify({"error": "invalid_ip"}), 400
    if not (tuya_versions.is_supported(version) or tuya_versions.is_auto(version)):
        return jsonify({"error": "invalid_version"}), 400
    if not dp.isdigit() or not 1 <= int(dp) <= 255:
        return jsonify({"error": "invalid_dp"}), 400

    code = "switch_" + dp
    device = {
        "id": device_id,
        "name": name,
        "local_key": key,
        "ip": str(address),
        "online": False,  # unverified until the first successful local read
        "category": "manual",
        "product_name": "Manual Device",
        "status": {},
        "function": {code: {"code": code, "type": "Boolean", "values": "{}"}},
        "status_range": {},
        "local_strategy": {dp: {"status_code": code, "value_convert": "raw"}},
    }
    devices = [row for row in _devices() if str(row.get("id")) != device_id]
    devices.append(device)
    _write_cache(DEVICE_CACHE_FILE, {"devices": devices})

    results = _results()
    results[device_id] = {
        "status": "unverified", "ip": str(address), "version": version,
        "device22": False, "checked_at": time.time(),
    }
    _write_cache(LAN_CACHE_FILE, {
        "results": results,
        "summary": {"matched": len(results)},
        "targets": str(ipaddress.ip_network(f"{address}/24", strict=False)),
        "changes": None, "changes_at": None,
    })
    profiles = _profiles()
    profiles[device_id] = {
        "ip": str(address), "version": version, "device22": False,
        "subnet": _detected_subnet() or str(ipaddress.ip_network(f"{address}/24", strict=False)),
        "last_ok": 0, "checked_at": time.time(), "last_failed": 0, "fail_count": 0,
        "last_scan_at": 0,
    }
    _save_profiles(profiles)
    return jsonify({"ok": True, "id": device_id})


@bp.route("/api/local/device", methods=["PUT"])
def local_update_device():
    """Edit one saved device in place: name, address, protocol, key or DP.

    No new card is created and the stored local key is never echoed back. A
    blank local key means "keep the current one"; IP/version are written to the
    gateway when the selected device is gateway-controlled.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "invalid_request"}), 400

    device_id = str(data.get("id") or data.get("device_id") or "").strip()
    devices = _devices()
    index = next((i for i, row in enumerate(devices)
                  if str(row.get("id")) == device_id), None)
    if index is None:
        return jsonify({"error": "unknown_device"}), 404

    device = dict(devices[index])
    name = str(data.get("name") or "").strip()[:60]
    if not name:
        return jsonify({"error": "invalid_device_details"}), 400

    results = _results()
    saved = dict(results.get(device_id) or {})
    host = device
    host_id = device_id
    if lan_scan.is_sub_device(device) or saved.get("status") == lan_scan.VIA_GATEWAY:
        gateway_id = str(device.get("gateway_id") or saved.get("gateway_id") or "").strip()
        gateway = next((row for row in devices if str(row.get("id")) == gateway_id), None)
        if gateway is None:
            return jsonify({"error": "gateway_unavailable"}), 404
        host = dict(gateway)
        host_id = gateway_id
        saved = dict(results.get(host_id) or {})

    key_raw = data.get("local_key")
    if key_raw is not None and str(key_raw).strip():
        key = str(key_raw).strip()
        if not re.fullmatch(r"[!-~]{16,32}", key):
            return jsonify({"error": "invalid_local_key"}), 400
        device["local_key"] = key

    dp_raw = data.get("dp")
    if dp_raw is not None and str(dp_raw).strip():
        dp = str(dp_raw).strip()
        if not dp.isdigit() or not 1 <= int(dp) <= 255:
            return jsonify({"error": "invalid_dp"}), 400
        if str(device.get("category") or "") == "manual":
            code = "switch_" + dp
            device["function"] = {code: {"code": code, "type": "Boolean", "values": "{}"}}
            device["status_range"] = {}
            device["local_strategy"] = {dp: {"status_code": code, "value_convert": "raw"}}
            device["status"] = {}

    ip_raw = data.get("ip")
    if ip_raw is not None and str(ip_raw).strip():
        try:
            ip = str(ipaddress.IPv4Address(str(ip_raw).strip()))
        except ipaddress.AddressValueError:
            return jsonify({"error": "invalid_ip"}), 400
    else:
        ip = str(saved.get("ip") or host.get("ip") or "").strip()

    version_raw = data.get("version")
    if version_raw is not None and str(version_raw).strip():
        version = str(version_raw).strip()
    else:
        version = str(saved.get("version") or host.get("version") or "").strip()
        if not version and ip:
            version = "3.4"
    if ip and version and not (tuya_versions.is_supported(version) or tuya_versions.is_auto(version)):
        return jsonify({"error": "invalid_version"}), 400

    device["name"] = name
    device["online"] = False
    devices[index] = device
    if host_id != device_id:
        for i, row in enumerate(devices):
            if str(row.get("id")) == host_id:
                gateway_row = dict(row)
                if ip:
                    gateway_row["ip"] = ip
                gateway_row["online"] = False
                devices[i] = gateway_row
                break
    elif ip:
        device["ip"] = ip
        devices[index] = device

    _write_cache(DEVICE_CACHE_FILE, {"devices": devices})

    if ip and version:
        now = time.time()
        entry = dict(saved)
        entry.update({
            "status": "unverified", "ip": ip, "version": version,
            "device22": False, "last_ok": 0, "checked_at": now,
        })
        entry.pop("sub_online", None)
        results[host_id] = entry
        lan_body = _body(LAN_CACHE_FILE)
        lan_body["results"] = results
        summary = dict(lan_body.get("summary") or {})
        summary["matched"] = len(results)
        lan_body["summary"] = summary
        _write_cache(LAN_CACHE_FILE, lan_body)

        with _profile_lock:
            profiles = _profiles()
            profile = dict(profiles.get(host_id) or {})
            profile.update({
                "ip": ip, "version": version, "device22": False,
                "subnet": _detected_subnet() or str(ipaddress.ip_network(f"{ip}/24", strict=False)),
                "last_ok": 0, "checked_at": now, "last_failed": 0,
                "fail_count": 0, "last_scan_at": 0,
            })
            profiles[host_id] = profile
            _save_profiles(profiles)

    return jsonify({"ok": True, "id": device_id, "name": name,
                    "ip": ip, "version": version})


@bp.delete("/api/local/device")
def local_delete_device():
    device_id = str(request.args.get("id") or "").strip()
    if not device_id:
        return jsonify({"error": "invalid_request"}), 400
    devices = [row for row in _devices() if str(row.get("id")) != device_id]
    _write_cache(DEVICE_CACHE_FILE, {"devices": devices})
    results = _results()
    results.pop(device_id, None)
    _write_cache(LAN_CACHE_FILE, {"results": results, "summary": {"matched": len(results)},
                                  "targets": "", "changes": None, "changes_at": None})
    profiles = _profiles()
    profiles.pop(device_id, None)
    _save_profiles(profiles)
    return jsonify({"ok": True})


# The timer is started once at import; pytest/TESTING never starts a thread.
_start_scheduler()


# --- Additive Smart Pilot services ---------------------------------------
# Nothing above this line was changed. These callbacks expose existing,
# already-verified read/write primitives to the new module.

def _extras_read_state(device_id, dp):
    with _busy_guard(device_id) as acquired:
        if not acquired:
            return None
        try:
            context = _context(device_id)
            outcome = device_values.read(context)
            if outcome.get("status") != "ok":
                return None
            return outcome.get("dps", {}).get(str(dp))
        except Exception:
            return None


def _extras_set_value(device_id, dp, value):
    with _busy_guard(device_id, wait_seconds=2.5) as acquired:
        if not acquired:
            return {"ok": False, "error": "busy"}
        try:
            context = _context(device_id)
            device = _by_id(_devices()).get(device_id)
            point = ({item["dp"]: item for item in _points(device)}.get(str(dp))
                     if device else None)
            if not point:
                return {"ok": False, "error": "unknown_dp"}
            coerced, error = _coerce(value, point)
            if error:
                return {"ok": False, "error": error}
            outcome = _send(context, str(dp), coerced)
            if outcome.get("ok"):
                _remember_success(device_id, context)
            return outcome
        except Exception as error:
            return {"ok": False, "error": type(error).__name__}


def _extras_list_devices():
    return [dict(device, points=_points(device)) for device in _devices()]


def _extras_ac_status():
    try:
        import haier_control
        return haier_control.pilot_extras_status()
    except Exception:
        return []


def _extras_claim_scene():
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    claimed = []
    for scene in _due_scenes(_load_scenes()):
        if _set_scene_last_run(scene["id"], today):
            claimed.append(scene)
    return claimed


pilot_extras.configure(
    read_state=_extras_read_state,
    set_value=_extras_set_value,
    list_devices=_extras_list_devices,
    read_scenes=_load_scenes,
    claim_scene=_extras_claim_scene,
    execute_scene=lambda scene: _execute_scene(scene, update_last_run=False),
    ac_status=_extras_ac_status,
)


@bp.get("/api/local/scheduler")
def local_scheduler_status():
    return jsonify(pilot_extras.scheduler_info())


@bp.post("/api/local/scheduler/tick")
def local_scheduler_tick():
    return jsonify(pilot_extras.tick_scheduler())


@bp.get("/api/local/rules")
def local_rules_list():
    return jsonify({"rules": pilot_extras.list_rules()})


@bp.post("/api/local/rules")
def local_rules_save():
    rule, error = pilot_extras.save_rule(request.get_json(silent=True))
    if error:
        return jsonify({"error": error}), 400
    return jsonify({"ok": True, "rule": rule})


@bp.delete("/api/local/rules")
def local_rules_delete():
    if not pilot_extras.delete_rule(str(request.args.get("id") or "").strip()):
        return jsonify({"error": "unknown_rule"}), 404
    return jsonify({"ok": True})


@bp.get("/api/local/events")
def local_events():
    return jsonify(pilot_extras.events_since(request.args.get("since", 0)))


@bp.get("/api/local/usage")
def local_usage_summary():
    return jsonify(pilot_extras.usage_summary())


@bp.get("/api/local/backup")
def local_backup():
    try:
        payload = pilot_extras.backup_bytes()
    except Exception:
        return jsonify({"error": "backup_failed"}), 500
    return Response(payload, mimetype="application/zip", headers={
        "Content-Disposition": 'attachment; filename="smart-pilot-backup.zip"',
        "Cache-Control": "no-store",
    })


@bp.post("/api/local/restore")
def local_restore():
    upload = request.files.get("file")
    if upload is None:
        return jsonify({"error": "missing_file"}), 400
    try:
        restored = pilot_extras.restore_bytes(upload.read(25 * 1024 * 1024 + 1))
    except Exception as error:
        return jsonify({"error": str(error) or "restore_failed"}), 400
    return jsonify({"ok": True, "restored": restored})


def _extras_loop():
    while True:
        time.sleep(60)
        if _testing_mode():
            continue
        try:
            pilot_extras.evaluate_rules()
        except Exception:
            pass
        try:
            pilot_extras.record_usage()
        except Exception:
            pass


if not _testing_mode():
    threading.Thread(target=_extras_loop, name="smartpilot-extras", daemon=True).start()
