"""Additive local services: events, safety rules, scheduler status, backup, usage.

This module is deliberately standalone. It never imports local_control or
haier_control; the host registers small callbacks at startup. Existing device
control behaviour is untouched -- every endpoint here is new and opt-in.
All state lives beside SESSION_FILE (the app-private ``files`` dir on Android).
"""

from __future__ import annotations

import datetime as _dt
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path

_SESSION = os.environ.get("SESSION_FILE", "")
_BASE = Path(os.path.dirname(_SESSION) or "." if _SESSION else ".")


def _base_dir() -> Path:
    session = os.environ.get("SESSION_FILE", "")
    if session:
        return Path(os.path.dirname(session) or ".")
    return RULES_FILE.parent

RULES_FILE = Path(os.environ.get("LOCAL_RULES_FILE", str(_BASE / "local-rules.json")))
RULE_STATE_FILE = Path(os.environ.get("LOCAL_RULE_STATE_FILE", str(_BASE / "local-rule-state.json")))
EVENTS_FILE = Path(os.environ.get("LOCAL_EVENTS_FILE", str(_BASE / "local-events.json")))
USAGE_FILE = Path(os.environ.get("LOCAL_USAGE_FILE", str(_BASE / "local-usage.json")))
BACKUP_DIR = Path(os.environ.get("LOCAL_BACKUP_DIR", str(_BASE / "backups")))

MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_BACKUP_BYTES = 25 * 1024 * 1024
MAX_MEMBER_BYTES = 8 * 1024 * 1024
MAX_EVENTS = 200
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")

# Mirrored from local_control. A safety device must never be driven by an
# unattended duration rule; kept local so this module stays standalone.
CRITICAL_DEVICE_IDS = frozenset({
    "bf069004945cef348chgdf",  # Bore Motor
    "bf8363e8618b64aa00nclo",  # First Floor Breaker
    "bfe87f1e05abf9d1acdanb",  # Ground Floor Breaker
    "bfccb1925a4b0b269dfph5",  # Water Tank
    "bf04a442f57b19789dfflz",  # Geyser
})

# Files that may be written into a backup archive and restored from one.
BACKUP_NAMES = (
    "session.json", "devices.cache", "cache.key", "lan.cache",
    "lan-profile.json", "local-preferences.json", "local-scenes.json",
    "local-rules.json", "local-rule-state.json", "local-usage.json",
    "haier-pilot.enc", "haier-pilot.key",
)

_lock = threading.RLock()
_events: list[dict] = []
_next_event_id = 1
_rules: list[dict] = []
_rule_state: dict = {}
_usage: dict = {"days": {}}
_callbacks: dict = {}


# --- persistence ---------------------------------------------------------

def _load_json(path: Path, default):
    try:
        raw = path.read_bytes()
        if len(raw) > MAX_JSON_BYTES:
            return default
        value = json.loads(raw)
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError, TypeError):
        return default


def _save_json(path: Path, value) -> None:
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=str(path.parent),
            prefix=".pilot-extras-", delete=False,
        ) as handle:
            temporary = handle.name
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def configure(*, read_state=None, set_value=None, list_devices=None,
              read_scenes=None, claim_scene=None, execute_scene=None,
              ac_status=None) -> None:
    """Register host callbacks. Safe to call more than once."""
    global RULES_FILE, RULE_STATE_FILE, EVENTS_FILE, USAGE_FILE, BACKUP_DIR
    session = os.environ.get("SESSION_FILE", "")
    base = Path(os.path.dirname(session) or "." if session else ".")
    RULES_FILE = Path(os.environ.get("LOCAL_RULES_FILE", str(base / "local-rules.json")))
    RULE_STATE_FILE = Path(os.environ.get("LOCAL_RULE_STATE_FILE", str(base / "local-rule-state.json")))
    EVENTS_FILE = Path(os.environ.get("LOCAL_EVENTS_FILE", str(base / "local-events.json")))
    USAGE_FILE = Path(os.environ.get("LOCAL_USAGE_FILE", str(base / "local-usage.json")))
    BACKUP_DIR = Path(os.environ.get("LOCAL_BACKUP_DIR", str(base / "backups")))
    # Only replace callbacks that were actually supplied. A restore reloads
    # files via configure() with no arguments and must not clear live hooks.
    for key, value in {
        "read_state": read_state, "set_value": set_value,
        "list_devices": list_devices, "read_scenes": read_scenes,
        "claim_scene": claim_scene, "execute_scene": execute_scene,
        "ac_status": ac_status,
    }.items():
        if value is not None:
            _callbacks[key] = value
    global _events, _next_event_id, _rules, _rule_state, _usage
    _events = [item for item in _load_json(EVENTS_FILE, [])
               if isinstance(item, dict) and isinstance(item.get("id"), int)]
    _next_event_id = max((item["id"] for item in _events), default=0) + 1
    _rules = [item for item in _load_json(RULES_FILE, [])
              if isinstance(item, dict) and ID_RE.fullmatch(str(item.get("id", "")) or "")]
    _rule_state = _load_json(RULE_STATE_FILE, {})
    _usage = _load_json(USAGE_FILE, {"days": {}}) or {"days": {}}
    if not isinstance(_usage.get("days"), dict):
        _usage = {"days": {}}


# --- event log (Android notifications read this) -------------------------

def emit(kind: str, title: str, body: str = "") -> dict:
    global _next_event_id
    with _lock:
        event = {
            "id": _next_event_id, "kind": str(kind)[:40],
            "title": str(title)[:120], "body": str(body)[:300],
            "at": time.time(),
        }
        _next_event_id += 1
        _events.append(event)
        del _events[:-MAX_EVENTS]
        _save_json(EVENTS_FILE, _events)
        return dict(event)


def events_since(since: int = 0) -> dict:
    with _lock:
        try:
            marker = int(since)
        except (TypeError, ValueError):
            marker = 0
        return {
            "events": [dict(item) for item in _events if item["id"] > marker],
            "latest": _events[-1]["id"] if _events else 0,
            "count": len(_events),
        }


# --- safety rules --------------------------------------------------------

def list_rules() -> list[dict]:
    with _lock:
        return [dict(item) for item in _rules]


def _valid_rule(data: dict) -> tuple[dict | None, str | None]:
    if not isinstance(data, dict):
        return None, "invalid_request"
    name = str(data.get("name") or "").strip()[:60]
    if not name:
        return None, "invalid_name"
    kind = str(data.get("kind") or "on_duration")
    if kind not in {"on_duration", "off_duration"}:
        return None, "invalid_kind"
    device_id = str(data.get("device_id") or "").strip()
    if not ID_RE.fullmatch(device_id):
        return None, "invalid_device"
    if device_id in CRITICAL_DEVICE_IDS:
        return None, "critical_device_blocked"
    dp = str(data.get("dp") or "").strip()
    if not dp.isdigit():
        return None, "invalid_dp"
    try:
        minutes = int(data.get("minutes"))
    except (TypeError, ValueError):
        return None, "invalid_minutes"
    if not 1 <= minutes <= 1440:
        return None, "invalid_minutes"
    action = data.get("action")
    if not isinstance(action, bool):
        return None, "invalid_action"
    rule = {
        "id": str(data.get("id") or uuid_safe(name)).strip()[:64],
        "name": name, "kind": kind, "device_id": device_id, "dp": dp,
        "minutes": minutes, "action": action,
        "enabled": bool(data.get("enabled", True)),
    }
    if not ID_RE.fullmatch(rule["id"]):
        rule["id"] = uuid_safe(name)
    return rule, None


def uuid_safe(seed: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "-", seed)[:32] + "-" + str(int(time.time() * 1000))[-8:]


def save_rule(data: dict) -> tuple[dict | None, str | None]:
    rule, error = _valid_rule(data)
    if error:
        return None, error
    with _lock:
        replaced = False
        for index, existing in enumerate(_rules):
            if existing["id"] == rule["id"]:
                _rules[index] = rule
                replaced = True
                break
        if not replaced:
            _rules.append(rule)
        del _rules[: -MAX_EVENTS]
        _save_json(RULES_FILE, _rules)
        return dict(rule), None


def delete_rule(rule_id: str) -> bool:
    with _lock:
        remaining = [item for item in _rules if item["id"] != rule_id]
        if len(remaining) == len(_rules):
            return False
        _rules[:] = remaining
        _rule_state.pop(rule_id, None)
        _save_json(RULES_FILE, _rules)
        _save_json(RULE_STATE_FILE, _rule_state)
        return True


def evaluate_rules() -> list[dict]:
    """Check duration rules once. One action per rule, with a 5-min cooldown."""
    reader = _callbacks.get("read_state")
    writer = _callbacks.get("set_value")
    if not callable(reader) or not callable(writer):
        return []
    fired = []
    with _lock:
        rules = [dict(item) for item in _rules if item.get("enabled")]
    for rule in rules:
        # Defence in depth for rules saved before this guard existed.
        if rule.get("device_id") in CRITICAL_DEVICE_IDS:
            continue
        key = rule["id"]
        try:
            value = reader(rule["device_id"], rule["dp"])
            matched = (value is True) if rule["kind"] == "on_duration" else (value is False)
            now = time.time()
            with _lock:
                state = dict(_rule_state.get(key) or {})
                since = float(state.get("since") or now) if matched else now
                cooldown = float(state.get("last_action") or 0)
                changed = state.get("value") != value
                state.update({"value": value, "since": since})
                if changed:
                    state.pop("last_action", None)
                    cooldown = 0
                _rule_state[key] = state
            if not matched or now - since < rule["minutes"] * 60 or now - cooldown < 300:
                continue
            outcome = writer(rule["device_id"], rule["dp"], rule["action"])
            if outcome.get("ok"):
                with _lock:
                    _rule_state.setdefault(key, {})["last_action"] = now
                    _save_json(RULE_STATE_FILE, _rule_state)
                emit("rule", rule["name"],
                     "Automatically set to %s after %s min" %
                     ("ON" if rule["action"] else "OFF", rule["minutes"]))
                fired.append({"id": key, "ok": True})
            else:
                emit("rule_error", rule["name"],
                     "Safety rule could not run: %s" % outcome.get("error", "failed"))
                fired.append({"id": key, "ok": False})
        except Exception as error:
            emit("rule_error", rule["name"], "Safety rule check failed: %s" % type(error).__name__)
    return fired


# --- scheduler status / alarm-friendly tick ------------------------------

def _next_weekday(now: _dt.datetime, days: list[int]) -> _dt.datetime | None:
    if not days:
        days = list(range(7))
    for offset in range(8):
        candidate = now + _dt.timedelta(days=offset)
        if candidate.weekday() in days:
            return candidate
    return None


def scheduler_info() -> dict:
    """Report the next scheduled scene; used by the phone status panel."""
    read_scenes = _callbacks.get("read_scenes")
    scenes = read_scenes() if callable(read_scenes) else []
    now = _dt.datetime.now()
    soonest = None
    scheduled = 0
    for scene in scenes or []:
        schedule = scene.get("schedule") or {}
        if not schedule.get("enabled") or not schedule.get("time"):
            continue
        scheduled += 1
        try:
            hour, minute = (int(part) for part in str(schedule["time"]).split(":")[:2])
        except (ValueError, TypeError):
            continue
        days = [int(day) for day in schedule.get("days", []) if str(day).isdigit()]
        allowed_days = set(days) if days else set(range(7))
        when = None
        for offset in range(8):
            candidate = (now + _dt.timedelta(days=offset)).replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            if candidate.weekday() in allowed_days and candidate > now:
                when = candidate
                break
        if when is None:
            continue
        if soonest is None or when < soonest[0]:
            soonest = (when, str(scene.get("name") or scene.get("id")))
    return {
        "active": True,
        "scenes": len(scenes or []),
        "scheduled": scheduled,
        "next_run_at": soonest[0].timestamp() if soonest else None,
        "next_run": soonest[0].strftime("%a %H:%M") if soonest else None,
        "next_scene": soonest[1] if soonest else None,
        "note": ("Schedules are also triggered by the phone alarm while the "
                 "app is in the background; an always-on host is still best."),
    }


def tick_scheduler() -> dict:
    """Run due scenes now. Android alarms call this even if the WebView is shut."""
    claim = _callbacks.get("claim_scene")
    execute = _callbacks.get("execute_scene")
    if not callable(claim) or not callable(execute):
        return {"ran": [], "error": "not_configured"}
    ran = []
    for scene in claim():
        outcome = execute(scene)
        failed = int(outcome.get("failed") or 0)
        ran.append({"id": scene.get("id"), "name": scene.get("name"),
                    "ok": bool(outcome.get("ok")), "failed": failed})
        emit("scene_error" if failed else "scene", str(scene.get("name") or "Scene"),
             "Completed with %s failed action(s)" % failed)
    return {"ran": ran}


# --- usage + freshness ---------------------------------------------------

def record_usage(interval_seconds: int = 60) -> None:
    """Sample live watt readings and accumulate watt-seconds per local day."""
    reader = _callbacks.get("read_state")
    lister = _callbacks.get("list_devices")
    if not callable(reader) or not callable(lister):
        return
    day = _dt.datetime.now().strftime("%Y-%m-%d")
    try:
        devices = lister() or []
    except Exception:
        return
    with _lock:
        bucket = _usage["days"].setdefault(day, {})
    for device in devices:
        if not isinstance(device, dict) or not device.get("local_key"):
            continue
        watts = None
        for point in device.get("points") or device.get("dps") or []:
            code = str(point.get("code") or "")
            unit = str(point.get("unit") or "")
            if re.search(r"power|watt", code, re.I) or unit.lower() in {"w", "kw"}:
                try:
                    watts = float(reader(str(device["id"]), str(point["dp"])) or 0)
                except (TypeError, ValueError):
                    watts = None
                if watts is not None:
                    if unit.lower() == "kw":
                        watts *= 1000
                    break
        if watts is None or watts <= 0:
            continue
        with _lock:
            bucket[str(device["id"])] = round(bucket.get(str(device["id"]), 0) + watts * interval_seconds, 3)
    with _lock:
        _save_json(USAGE_FILE, _usage)


def usage_summary() -> dict:
    ac = _callbacks.get("ac_status")
    ac_status = ac() if callable(ac) else []
    with _lock:
        day = _dt.datetime.now().strftime("%Y-%m-%d")
        bucket = _usage["days"].get(day, {})
        devices = [{
            "id": key, "kwh": round(value / 3_600_000, 4),
        } for key, value in sorted(bucket.items())]
    return {
        "today": day,
        "total_kwh": round(sum(item["kwh"] for item in devices), 4),
        "devices": devices,
        "ac": ac_status,
    }


def ac_last_verified() -> list[dict]:
    ac = _callbacks.get("ac_status")
    result = ac() if callable(ac) else []
    return result if isinstance(result, list) else []


# --- backup / restore ----------------------------------------------------

def backup_bytes() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        base = _base_dir()
        for name in BACKUP_NAMES:
            path = base / name
            try:
                if path.is_file() and path.stat().st_size <= MAX_MEMBER_BYTES:
                    archive.write(path, name)
            except OSError:
                continue
    payload = stream.getvalue()
    if len(payload) > MAX_BACKUP_BYTES:
        raise ValueError("backup_too_large")
    return payload


def restore_bytes(payload: bytes) -> list[str]:
    if not isinstance(payload, (bytes, bytearray)) or len(payload) > MAX_BACKUP_BYTES:
        raise ValueError("invalid_backup")
    restored = []
    base = _base_dir()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        for info in archive.infolist():
            if info.filename not in BACKUP_NAMES or info.file_size > MAX_MEMBER_BYTES:
                raise ValueError("invalid_member")
            with archive.open(info, "r") as handle:
                data = handle.read(MAX_MEMBER_BYTES + 1)
            if len(data) > MAX_MEMBER_BYTES:
                raise ValueError("invalid_member")
            target = base / info.filename
            temporary = None
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=str(target.parent), delete=False) as handle:
                    temporary = handle.name
                    handle.write(data)
                os.replace(temporary, target)
                restored.append(info.filename)
            except OSError:
                raise ValueError("restore_failed")
            finally:
                if temporary:
                    try:
                        os.unlink(temporary)
                    except OSError:
                        pass
    configure()  # reload in-memory state from the restored files
    app_mod = sys.modules.get("app")
    if app_mod is not None:
        try:
            with app_mod._devices_cache_lock:
                app_mod._devices_cache = None
                app_mod._devices_cache_loaded = False
            with app_mod._lan_lock:
                app_mod._lan_cache = None
                app_mod._lan_cache_loaded = False
        except Exception:
            pass
    haier_mod = sys.modules.get("haier_control")
    if haier_mod is not None:
        try:
            with haier_mod.LOCK:
                haier_mod._cache.clear()
                haier_mod._auto_observed.clear()
        except Exception:
            pass
    emit("backup", "Backup restored", "%s file(s) restored" % len(restored))
    return restored
