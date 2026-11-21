"""Haier Pilot direct-LAN (experimental) add-on for the Smart Pilot Flask app.

Independent Python implementation of the documented Haier uSS transport. Only
capture-confirmed classic 125/127-byte EPP reports are permitted for WRITES.
Unrecognised models are read-only. No Haier cloud / Home Assistant dependency.

Source for protocol: https://github.com/enapt/haismart-local (MIT licensed).
Hardware verification with the owner's units is still required.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import struct
import tempfile
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pathlib import Path
from urllib.parse import urlparse

from flask import Blueprint, jsonify, request

try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:  # Required in Android Chaquopy and normal server builds.
    Fernet = Cipher = algorithms = modes = None

bp = Blueprint("haier_pilot", __name__)
SLOTS = {"pro": "19HFAB T3 Pro", "ff": "FF Haier 19HFAB T3"}
PORT = 56800
LOCK = threading.RLock()
MAX_FRAME = 16384
LOCAL_FILE = Path(os.environ.get("HAIER_PILOT_FILE", str(Path(os.environ.get(
    "SESSION_FILE", os.path.expanduser("~/.config/tuya-smartlife/session.json"))).parent / "haier-pilot.enc")))
KEY_FILE = LOCAL_FILE.with_suffix(".key")
MODES = {"auto": 0, "cool": 1, "dry": 2, "heat": 4, "fan": 6}
FANS = {"high": 1, "medium": 2, "low": 3, "auto": 5}
# Word number, shift, bits. From observed canonical Haier EPP group-set map.
FIELDS = {
    "target": (1, 8, 8), "hvac": (2, 13, 3), "fan": (2, 8, 3),
    "power": (3, 0, 1), "strong": (3, 3, 1), "quiet": (3, 4, 1),
    "sleep": (3, 5, 1), "eco": (4, 3, 3),
}
# No unverified native features or arbitrary raw DP writes.
ALLOWED = {
    "power": {0, 1}, "target": set(range(0, 15)), "hvac": {0, 1, 2, 6},
    "fan": {1, 2, 3, 5}, "strong": {0, 1}, "quiet": {0, 1},
    "sleep": {0, 1}, "eco": {0, 5},
}
# Heat is NOT in safe writes until the owner verifies heat support explicitly.
_cache: dict[str, dict] = {}
_last_off: dict[str, float] = {}
_last_write: dict[str, float] = {}
_auto_observed: dict[str, tuple] = {}
_auto_last: dict[str, float] = {}
_auto_errors: dict[str, str] = {}
_auto_checked: dict[str, float] = {}
_auto_started = False
_auto_lock = threading.Lock()


class HaierError(RuntimeError):
    pass


def _valid_ip(host: str) -> str:
    try:
        addr = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("Enter a numeric LAN IPv4 address") from exc
    # RFC1918 explicitly, not broad is_private (which includes special-purpose ranges).
    allowed_networks = [ipaddress.ip_network(x) for x in (
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
    if addr.version != 4 or not any(addr in net for net in allowed_networks):
        raise ValueError("Only RFC1918 private IPv4 LAN addresses are allowed")
    return str(addr)


def _validate_device(host, device_id, local_key, key_version=0):
    host = _valid_ip(str(host))
    device_id, local_key = str(device_id).strip(), str(local_key).strip()
    if not re.fullmatch(r"[a-zA-Z0-9]{12,32}", device_id):
        raise ValueError("Device ID should be the 12–32 character Wi-Fi module ID")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", local_key):
        raise ValueError("Haier Local Key must contain exactly 32 hex characters")
    if isinstance(key_version, bool) or not str(key_version).isdigit() or not 0 <= int(key_version) <= 65535:
        raise ValueError("Key version must be 0–65535")
    return {"ip": host, "device_id": device_id, "local_key": local_key,
            "key_version": int(key_version)}


def _atomic_private(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".haier-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _cipher(create=False):
    if Fernet is None:
        raise HaierError("cryptography package is missing")
    try:
        return Fernet(KEY_FILE.read_bytes().strip())
    except (ValueError, OSError):
        if not create:
            return None
    key = Fernet.generate_key()
    _atomic_private(KEY_FILE, key)
    return Fernet(key)


def _load() -> dict:
    with LOCK:
        if not LOCAL_FILE.exists():
            return {slot: {"mode": "manual", "pause_until": 0, "auto_power_on": False}
                    for slot in SLOTS}
        cipher = _cipher()
        if cipher is None:
            raise HaierError("Saved encryption key unavailable; reconfigure Haier connection")
        try:
            raw = json.loads(cipher.decrypt(LOCAL_FILE.read_bytes()))
        except Exception as exc:
            raise HaierError("Saved Haier settings could not be decrypted") from exc
        if not isinstance(raw, dict):
            raise HaierError("Invalid saved Haier settings")
        return {slot: {"mode": "manual", "pause_until": 0, "auto_power_on": False,
                       **(raw.get(slot) if isinstance(raw.get(slot), dict) else {})}
                for slot in SLOTS}


def _save(config: dict):
    # Secrets are NEVER saved in plaintext or returned from an API.
    with LOCK:
        _atomic_private(LOCAL_FILE, _cipher(create=True).encrypt(json.dumps(config).encode()))


def _summary(slot: str, entry: dict) -> dict:
    c = _cache.get(slot) or {}
    # Never expose stale cached measurements as live readings. Once the last
    # successful LAN response ages out, the UI must disable controls until a
    # new response verifies the device, even when we still know its name/IP.
    fresh = bool(c.get("verified") and time.time() - c.get("read_at", 0) < 120)
    result = {"id": slot, "name": SLOTS[slot], "configured": bool(entry.get("ip") and entry.get("local_key")),
              "ip": entry.get("ip"), "mode": entry.get("mode", "manual"),
              "pause_until": float(entry.get("pause_until") or 0),
              "auto_power_on": False,  # intentionally unsupported in this safe version
              "verified": fresh,
              "last_read": c.get("read_at"), "status": c.get("data") if fresh else None,
              "auto_last_check": _auto_checked.get(slot), "auto_error": _auto_errors.get(slot)}
    return result


def _md5(data: bytes) -> bytes:
    return hashlib.md5(data).digest()


def _aes(payload: bytes, local_key: str, encrypt: bool) -> bytes:
    key = _md5(local_key.encode("ascii"))
    engine = Cipher(algorithms.AES(key), modes.CBC(b"\x00" * 16))
    transform = engine.encryptor() if encrypt else engine.decryptor()
    return transform.update(payload) + transform.finalize()


def _crypt_out(sn: int, data: bytes, key: str) -> bytes:
    nonce = str(secrets.randbelow(90000) + 10000).encode("ascii")
    rawlen = 40 + len(data)
    p = struct.pack(">HI", rawlen, sn) + _md5(nonce[:4] + data) + b"\0" * 16 + nonce[:4] + data
    p += b"\x00" * (-len(p) % 16)
    return _aes(p, key, True) + nonce


def _destuff(data: bytes) -> bytes:
    at = data.find(b"\xff\xff")
    if at < 0:
        return data
    return data[:at+2] + data[at+2:].replace(b"\xff\x55", b"\xff")


def _crypt_in(data: bytes, key: str) -> bytes:
    n = len(data) // 16 * 16
    if n < 48:
        raise HaierError("Encrypted response too short")
    p = _aes(data[:n], key, False)
    rawlen = struct.unpack_from(">H", p)[0]
    size = rawlen - 40
    if not 40 < rawlen <= min(len(data)-2, 0xE028) or 42 + size > len(p):
        raise HaierError("Encrypted reply invalid; local key may have rotated")
    if _md5(p[38:42+size]) != p[6:22]:
        raise HaierError("Wrong or rotated Haier local key")
    return _destuff(p[42:42+size])


def _packet(typ: int, seq: int, session: int, version: int, flag: int, payload: bytes) -> bytes:
    return struct.pack(">IHBBIHH", 0xEA60 + typ, len(payload) + 10,
                       version, flag, seq, 0, session) + payload


def _recv(sock) -> tuple:
    def exact(count):
        result = bytearray()
        while len(result) < count:
            chunk = sock.recv(count - len(result))
            if not chunk:
                raise HaierError("AC closed the local TCP connection")
            result.extend(chunk)
        return bytes(result)
    first = exact(6)
    size = struct.unpack_from(">H", first, 4)[0]
    if size < 10 or size > MAX_FRAME:
        raise HaierError("Malformed Haier LAN frame")
    raw = first + exact(size)
    code, _len, version, flag, sn, _code2, session = struct.unpack(">IHBBIHH", raw[:16])
    return code - 0xEA60, version, flag, session, raw[16:]


def _epp(typ: int, command: bytes, data=b"") -> bytes:
    if len(command) != 2:
        raise ValueError("Invalid EPP command")
    body = bytes([10 + len(data)]) + b"\0" * 6 + bytes([typ]) + command + data
    checksum = (sum(body) + body.count(0xff) * 0x55) & 255
    return b"\xff\xff" + body + bytes([checksum])


def _op_payload(epp: bytes, device_id: str, counter: int = 1) -> bytes:
    # Stuff only EPP body, not the initial frame markers.
    stuffed = b"\xff\xff" + epp[2:].replace(b"\xff", b"\xff\x55")
    did = device_id.encode("ascii").ljust(32, b"\x00")
    return struct.pack(">I", 0x2714) + b"\0" * 36 + did + struct.pack(">II", counter, len(stuffed)) + stuffed


def _collect(sock, key: str, timeout=1.0) -> list[bytes]:
    result = []
    sock.settimeout(timeout)
    for _ in range(18):
        try:
            _typ, _ver, _flag, _session, payload = _recv(sock)
        except (socket.timeout, HaierError):
            break
        if len(payload) < 48:
            continue
        try:
            result.append(_crypt_in(payload, key))
        except HaierError:
            continue
        sock.settimeout(0.5)
    return result


class _Session:
    def __init__(self, entry: dict):
        self.entry = entry
        self.sock = socket.create_connection((entry["ip"], PORT), timeout=3.5)
        self.sock.settimeout(3.5)
        try:
            self.sock.sendall(_packet(0, 1, 0, 1, 0, entry["device_id"].encode("ascii").ljust(32, b"\0")))
            typ, version, _flag, session, payload = _recv(self.sock)
            if typ != 1 or len(payload) < 8 or struct.unpack_from(">I", payload)[0] != 1:
                raise HaierError("Haier handshake rejected; check IP and Wi-Fi module ID")
            device_key_version = struct.unpack_from(">I", payload, 4)[0]
            expected = entry.get("key_version", 0)
            if expected and device_key_version and expected != device_key_version:
                raise HaierError(f"Haier local key rotated (device key v{device_key_version})")
            self.version = version or 1
            self.session = session
            self.sock.sendall(_packet(2, 2, session, self.version, 0, b""))
            for _ in range(5):
                typ, _v, _f, _sid, payload = _recv(self.sock)
                if typ == 3:
                    done = _crypt_in(payload, entry["local_key"])
                    if len(done) < 4:
                        raise HaierError("Haier handshake lacks sequence number")
                    self.seq = struct.unpack_from(">I", done)[0]
                    break
            else:
                raise HaierError("Haier handshake incomplete")
        except Exception:
            self.sock.close()
            raise

    def __enter__(self): return self

    def __exit__(self, *_): self.sock.close()

    def op(self, frame: bytes):
        payload = _op_payload(frame, self.entry["device_id"])
        self.sock.sendall(_packet(0x64, 0, self.session, self.version, 1,
                                  _crypt_out(self.seq, payload, self.entry["local_key"])))

    def collect(self, timeout=1.2):
        return _collect(self.sock, self.entry["local_key"], timeout=timeout)


def _classic(blobs: list[bytes]) -> tuple[dict, bytes | None]:
    state, baseline = {}, None
    for blob in blobs:
        if len(blob) < 100 or blob[2:4] != b"\x27\x15":
            continue
        at = blob.find(b"\xff\xff")
        if at < 0 or len(blob) < at + 12:
            continue
        epp_cmd = blob[at+10:at+12]
        if epp_cmd == b"\x7d\x01":
            if len(blob) == 141:
                watt = struct.unpack_from(">H", blob, 126)[0]
                amps10 = struct.unpack_from(">H", blob, 134)[0]
                if watt <= 20000: state["power_w"] = watt
                if amps10 != 0x1ff and amps10 <= 1000: state["current_a"] = amps10 / 10
                state["frequency_hz"] = blob[133]
            continue
        if epp_cmd == b"\x0f\x5a":
            continue
        # Refuse writes unless a confirmed, complete classic status report arrives.
        if len(blob) not in (125, 127) or epp_cmd not in (b"\x6d\x01", b"\x6d\x5f"):
            state.setdefault("layout", f"unsupported ({len(blob)} bytes)")
            continue
        words = (len(blob) - 115) // 2
        raw = blob[92:92 + 2*words]
        if len(raw) != 2 * words or not 0 <= blob[92] <= 14:
            continue
        baseline = blob
        state.update({"layout": f"classic-{words}", "writable": True,
                      "power_on": bool(blob[97] & 1), "target_c": blob[92] + 16,
                      "room_c": None if blob[92 + 2*words] in (0, 255) else blob[92 + 2*words] / 2,
                      "hvac_mode": {v:k for k,v in MODES.items()}.get(blob[94] >> 5, "unknown"),
                      "fan": {v:k for k,v in FANS.items()}.get(blob[94] & 7, "unknown"),
                      "quiet": bool(blob[97] & 0x10), "sleep": bool(blob[97] & 0x20),
                      "strong": bool(blob[97] & 0x08), "eco_level": _field(raw, "eco")})
    if baseline is None:
        state.setdefault("writable", False)
        state.setdefault("layout", "unverified")
    return state, baseline


def _field(raw: bytes, name: str) -> int:
    word, shift, bits = FIELDS[name]
    off = (word - 1) * 2
    if off+2 > len(raw):
        raise HaierError(f"Layout lacks {name} field")
    value = struct.unpack_from(">H", raw, off)[0]
    return (value >> shift) & ((1 << bits) - 1)


def _set_field(raw: bytes, name: str, value: int) -> bytes:
    if name not in ALLOWED or value not in ALLOWED[name]:
        raise ValueError("Unverified Haier control/value refused")
    word, shift, bits = FIELDS[name]
    off = (word - 1) * 2
    if off + 2 > len(raw):
        raise HaierError("Field outside confirmed status words")
    existing = struct.unpack_from(">H", raw, off)[0]
    mask = ((1 << bits)-1) << shift
    updated = (existing & ~mask) | (value << shift)
    data = bytearray(raw)
    struct.pack_into(">H", data, off, updated)
    return bytes(data)


def _read_device(entry: dict) -> dict:
    # ONE operation per session, sending read-only extended-status query.
    # It normally returns a current-status frame as well; fallback is get-all.
    with _Session(entry) as session:
        session.op(_epp(0x01, b"\x4d\xfe"))
        blobs = session.collect()
    data, baseline = _classic(blobs)
    if baseline is None:
        with _Session(entry) as session:
            session.op(_epp(0x01, b"\x4d\x01"))
            more = session.collect()
        data2, baseline = _classic(more)
        data.update(data2)
    if not data or (not baseline and data.get("layout") == "unverified"):
        raise HaierError("AC replied but no supported local status was decoded")
    data["writable"] = bool(baseline is not None)
    return data


def _write_device(entry: dict, name: str, value: int) -> dict:
    if name not in ALLOWED or value not in ALLOWED[name]:
        raise ValueError("Unsupported or unverified write value")
    with _Session(entry) as session:
        # In-session fresh status seed so no other controls are accidentally reset.
        pushed = session.collect(timeout=1.2)
        status, baseline = _classic(pushed)
        if baseline is None:
            raise HaierError("No fresh confirmed 125/127-byte baseline; command NOT sent")
        raw = baseline[92:92 + 2 * ((len(baseline)-115)//2)]
        words = _set_field(raw, name, value)
        if words == raw:
            return {"confirmed": True, "unchanged": True, "status": status}
        session.op(_epp(1, b"\x60\x01", words))
        echo = session.collect(timeout=1.5)
    checked, checked_blob = _classic(echo)
    if checked_blob:
        raw2 = checked_blob[92:92+2*((len(checked_blob)-115)//2)]
        if _field(raw2, name) == value:
            return {"confirmed": True, "status": checked}
    return {"confirmed": False, "status": checked or status,
            "warning": "Command sent but no matching status confirmation; do not retry rapidly"}


def _encode_command(command, value):
    if command == "temperature":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value or not 16 <= value <= 30:
            raise ValueError("Temperature must be an integer between 16 and 30 C")
        return "target", int(value) - 16
    if command == "mode":
        if value not in ("auto", "cool", "dry", "fan"):
            raise ValueError("Heat mode needs device-specific verification")
        return "hvac", MODES[value]
    if command == "fan":
        if value not in FANS:
            raise ValueError("Unsupported fan setting")
        return "fan", FANS[value]
    if command == "eco":
        if type(value) is not bool:
            raise ValueError("Eco must be true/false")
        return "eco", 5 if value else 0
    if command in ("power", "strong", "quiet", "sleep"):
        if type(value) is not bool:
            raise ValueError("Boolean control required")
        return command, int(value)
    raise ValueError("Unknown Haier control")


def _write(slot: str, command: str, value, *, automatic=False) -> dict:
    name, encoded = _encode_command(command, value)
    now = time.time()
    with LOCK:
        config = _load()
        entry = config.get(slot)
        if not entry or not entry.get("ip"):
            raise ValueError("Configure this Haier AC first")
        if automatic and (entry.get("mode") != "auto" or entry.get("pause_until", 0) > now):
            raise HaierError("Auto-Pilot is paused or disabled")
        if name == "power" and encoded == 1 and now - _last_off.get(slot, 0) < 180:
            raise HaierError("Compressor protection: wait 3 minutes after power-off")
        if automatic and now - _auto_last.get(slot, 0) < 300:
            raise HaierError("Auto-Pilot command cooldown")
        result = _write_device(entry, name, encoded)
        _last_write[slot] = time.time()
        if name == "power" and encoded == 0:
            _last_off[slot] = time.time()
        if not automatic and entry.get("mode") == "auto":
            entry["pause_until"] = now + 7200
            config[slot] = entry
            _save(config)
        if automatic:
            _auto_last[slot] = now
        if result.get("confirmed"):
            _cache[slot] = {"verified": True, "read_at": time.time(), "data": result.get("status", {})}
        return result


def _auto_tick(slot: str, entry: dict):
    if entry.get("mode") != "auto" or entry.get("pause_until", 0) > time.time() or not entry.get("ip"):
        return
    with LOCK:
        _auto_checked[slot] = time.time()
        data = _read_device(entry)
        _auto_errors.pop(slot, None)
        _cache[slot] = {"verified": True, "read_at": time.time(), "data": data}
        if not data.get("writable") or not data.get("power_on"):
            return  # Never start or stop compressor automatically in v0.3.
        signature = (data.get("target_c"), data.get("hvac_mode"), data.get("eco_level"),
                     data.get("quiet"), data.get("sleep"), data.get("strong"))
        previous = _auto_observed.get(slot)
        if previous is not None and previous != signature and time.time() - _last_write.get(slot, 0) > 40:
            config = _load()
            config[slot]["pause_until"] = time.time() + 7200
            _save(config)
            _auto_observed[slot] = signature
            return  # A user / official HaiSmart app changed settings.
        _auto_observed[slot] = signature
        if time.time() - _auto_last.get(slot, 0) < 300:
            return
        try:
            hour = datetime.now(ZoneInfo(os.environ.get("HAIER_PILOT_TZ", "Asia/Karachi"))).hour
        except ZoneInfoNotFoundError:
            hour = datetime.now().hour
        night = hour >= 23 or hour < 7
        # Only one conservative change per run, keeping it reversible.
        if data.get("hvac_mode") == "cool":
            target = 27 if night else 26
            action = None
            if data.get("target_c") != target:
                action = ("temperature", target)
            elif night and not data.get("sleep"):
                action = ("sleep", True)
            elif not night and data.get("sleep"):
                action = ("sleep", False)
            elif not night and data.get("eco_level") == 0:
                action = ("eco", True)
            if action is not None:
                result = _write(slot, *action, automatic=True)
                if result.get("confirmed"):
                    s = result["status"]
                    _auto_observed[slot] = (s.get("target_c"), s.get("hvac_mode"), s.get("eco_level"),
                                            s.get("quiet"), s.get("sleep"), s.get("strong"))


def _run_auto_loop():
    while True:
        try:
            config = _load()
            for slot in SLOTS:
                try:
                    _auto_tick(slot, config[slot])
                except Exception as exc:
                    _auto_errors[slot] = f"{type(exc).__name__}: {str(exc)[:140]}"
                    # Missing Wi-Fi must never crash the server or command other devices.
        except Exception:
            pass
        time.sleep(300)


def _ensure_auto_loop():
    global _auto_started
    with _auto_lock:
        if not _auto_started:
            worker = threading.Thread(target=_run_auto_loop, name="haier-pilot-auto", daemon=True)
            worker.start()
            _auto_started = True


def _body():
    if request.content_length and request.content_length > 8192:
        raise ValueError("Request too large")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("JSON object required")
    if len(request.get_data(cache=True)) > 8192:
        raise ValueError("Request too large")
    return data


def _slot(value):
    if not isinstance(value, str) or value not in SLOTS:
        raise ValueError("Unknown Haier AC")
    return value


def _auth_origin_guard():
    # Supplement the app's Basic Auth guard: even loopback WebView mode must
    # reject cross-origin browser mutation (incl. unauthenticated localhost).
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc.lower() != request.host.lower():
        return False
    return True


@bp.before_request
def _safe_origin():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not _auth_origin_guard():
        return jsonify({"error": "Cross-origin request refused"}), 403


@bp.get("/api/haier/devices")
def haier_devices():
    try:
        current = _load()
        if any(row.get("mode") == "auto" for row in current.values()):
            _ensure_auto_loop()
        return jsonify({"devices": [_summary(s, current[s]) for s in SLOTS],
                        "notes": "Direct LAN only; unknown layouts read-only; no HA dependency"})
    except HaierError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/api/haier/config")
def haier_config():
    try:
        data = _body()
        slot = _slot(data.get("slot"))
        new = _validate_device(data.get("ip"), data.get("device_id"),
                               data.get("local_key"), data.get("key_version", 0))
        with LOCK:
            config = _load()
            config[slot] = {**new, "mode": "manual", "pause_until": 0, "auto_power_on": False}
            _save(config)
            _cache.pop(slot, None)
            _auto_observed.pop(slot, None)
        return jsonify({"ok": True, "device": _summary(slot, config[slot])})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except HaierError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/api/haier/mode")
def haier_mode():
    try:
        data = _body()
        slot = _slot(data.get("slot"))
        mode = data.get("mode")
        if mode not in ("manual", "auto"):
            raise ValueError("Mode must be manual or auto")
        with LOCK:
            config = _load()
            if mode == "auto" and not config[slot].get("ip"):
                raise ValueError("Configure the AC before enabling Auto")
            config[slot]["mode"] = mode
            config[slot]["pause_until"] = 0
            _auto_observed.pop(slot, None)
            _save(config)
        if mode == "auto":
            _ensure_auto_loop()
        return jsonify({"ok": True, "device": _summary(slot, config[slot])})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except HaierError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/api/haier/pause")
def haier_pause():
    try:
        slot = _slot(_body().get("slot"))
        with LOCK:
            config = _load()
            config[slot]["pause_until"] = time.time() + 7200
            _save(config)
        return jsonify({"ok": True, "pause_until": config[slot]["pause_until"]})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except HaierError as exc:
        return jsonify({"error": str(exc)}), 503


@bp.post("/api/haier/read")
def haier_read():
    try:
        slot = _slot(_body().get("slot"))
        with LOCK:
            entry = _load()[slot]
            if not entry.get("ip"):
                raise ValueError("Configure this Haier AC first")
            data = _read_device(entry)
            _cache[slot] = {"verified": True, "read_at": time.time(), "data": data}
            return jsonify({"ok": True, "status": data, "device": _summary(slot, entry)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except (HaierError, OSError) as exc:
        # A failed explicit refresh is evidence that our old cache must not
        # enable further commands. Keep timestamps for diagnostics only.
        with LOCK:
            old = _cache.get(slot) if 'slot' in locals() else None
            if old is not None:
                _cache[slot] = {"verified": False, "read_at": old.get("read_at"), "data": None}
        return jsonify({"error": str(exc)}), 503


@bp.post("/api/haier/command")
def haier_command():
    try:
        data = _body()
        slot = _slot(data.get("slot"))
        if data.get("command") not in ("power", "temperature", "mode", "fan", "eco", "quiet", "sleep", "strong"):
            raise ValueError("Unsupported command")
        result = _write(slot, data["command"], data.get("value"))
        return jsonify({"ok": True, **result, "device": _summary(slot, _load()[slot])})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except (HaierError, OSError) as exc:
        return jsonify({"error": str(exc)}), 503


# Restore a previously opted-in Auto mode on server restart, if its encrypted
# settings are available. Actual changes are still limited to already-ON ACs.
try:
    if os.environ.get("HAIER_AUTOPILOT", "on").lower() not in {"off", "0", "false"}:
        if any(entry.get("mode") == "auto" for entry in _load().values()):
            _ensure_auto_loop()
except (HaierError, OSError):
    pass  # No credentials is a normal fresh-install state.
