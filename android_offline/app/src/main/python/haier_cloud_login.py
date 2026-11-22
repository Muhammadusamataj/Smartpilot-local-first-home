"""Optional Haier account sign-in, used ONLY to renew rotated local keys.

The app still controls both ACs over direct LAN with no cloud dependency. This
module is called explicitly from Settings when a key rotation is detected. It
never prints, returns or stores key values in the browser: the fresh key and
its version are written straight into the encrypted Haier config.

Protocol references: enapt/haismart-local (MIT) — device-center signed HTTP and
the SE-Asia localKey MQTT gateway. Implemented here with stdlib HTTP + TLS MQTT
so it works inside the offline Android build (no httpx / HA dependency).
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import socket
import ssl
import struct
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

try:
    from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    from cryptography.hazmat.primitives.serialization import load_der_public_key
except ImportError:  # pragma: no cover - cryptography is present in server + Chaquopy builds
    asym_padding = Cipher = algorithms = modes = PKCS7 = load_der_public_key = None

APP_ID = "MB-SHEYJDNYB-0001"
APP_KEY = "5ff4067f62705b9f205ed5277648de3a"
APP_VERSION = "5.5.0"
LOGIN_PATH = "/uplussea/accounts/v2/login"
REFRESH_PATH = "/uplussea/accounts/v1/user/refreshToken"
DEVICE_PATH = "/uplussea/devices/v2/user/devices"
PUBKEY_B64 = (
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCpBUQQP/sCtV6UK4mDD6Qr3OKMuWhVuc7OXj+YHNyTGip0jXR1"
    "PSMPshC6fql/GPMUMhZ2Ler/Yf5UihrgNkQsPK1ePu2lBntZp9B5tJza58fCKDtLeSvU6Z+VgFQsjJ9dcv0sw7P8"
    "EH5HhvXTCcckpqCGMmIBiur59U06GJIQMQIDAQAB"
)
PACKAGE = "com.haier.uhome.uplus.seasia"
GATEWAY_PORT = 58702
GATEWAY_SALT = b"haier_sdk"
HTTP_TIMEOUT = 15
HEX32 = re.compile(r"[a-fA-F0-9]{32}\Z")
_SN = int(time.time() * 1000)


class CloudLoginError(RuntimeError):
    pass


def _domains(zone: str) -> dict:
    """ Singapore is the default data centre; India (+91) has its own hosts. """
    if str(zone or "").strip().lstrip("+") == "91":
        return {"uhome": "uhome-sea.haieriot.net", "gateway": "gw-sea.haieriot.net"}
    return {"uhome": "uhome-sgp.haieriot.net", "gateway": "gw-sgp.haieriot.net"}


def _strip_ws(text: str) -> str:
    return text.replace(" ", "").replace("\t", "").replace("\r", "").replace("\n", "")


def _sign(path: str, body: str, timestamp: str) -> str:
    payload = path + _strip_ws(body) + APP_ID + APP_KEY + timestamp
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _headers(path: str, body: str, access: str, client_id: str, zone: str, ts: str) -> dict:
    return {
        "appId": APP_ID, "appVersion": APP_VERSION, "apiVersion": "v1",
        "clientId": client_id, "sequenceId": ts + "000010",
        "accessToken": access, "sign": _sign(path, body, ts),
        "timestamp": ts, "language": "en-us", "timezone": "8",
        "zoneInfo": str(zone or "0"), "Content-Type": "application/json;charset=UTF-8",
    }


def _http(method: str, url: str, payload: dict | None, headers: dict) -> dict:
    body = json.dumps(payload or {}, separators=(",", ":"), ensure_ascii=False) if payload is not None else ""
    req = Request(url, data=body.encode("utf-8") if method == "POST" else None,
                  headers=headers, method=method)
    opener = build_opener(ProxyHandler({}))  # never route appliance credentials via a system proxy
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT) as response:
            text = response.read().decode("utf-8", "replace")
    except Exception as exc:
        # Only the host and exception type are reported, never a token or body.
        raise CloudLoginError(f"{urlsplit(url).netloc}: {type(exc).__name__}") from None
    try:
        return json.loads(text) if text else {}
    except ValueError:
        raise CloudLoginError(f"{urlsplit(url).netloc}: unexpected reply") from None


def _check(resp: dict, what: str) -> dict:
    code = str(resp.get("retCode", "00000"))
    if code not in ("00000", "", "None"):
        raise CloudLoginError(f"{what}: {code} {resp.get('retInfo', '')}".strip())
    return resp


def _tokens(resp: dict) -> dict:
    data = resp.get("data") if isinstance(resp.get("data"), dict) else resp
    if isinstance(data.get("tokenInfo"), dict):
        data = data["tokenInfo"]
    return {
        "access": (data.get("uhomeAccessToken") or data.get("uhome_access_token")
                   or data.get("accountToken") or data.get("accessToken") or ""),
        "refresh": data.get("refreshToken") or data.get("refresh_token") or "",
        "zone": str(data.get("zoneInfo") or data.get("zone") or "0"),
    }


def _encrypt_password(password: str) -> tuple[str, str]:
    if load_der_public_key is None:
        raise CloudLoginError("cryptography package is required for Haier login")
    key = "".join(secrets.choice("0123456789") for _ in range(16)).encode("ascii")
    padder = PKCS7(128).padder()
    padded = padder.update(password.encode("utf-8")) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.CBC(key)).encryptor()
    password_field = base64.b64encode(enc.update(padded) + enc.finalize()).decode("ascii")
    pub = load_der_public_key(base64.b64decode(PUBKEY_B64))
    sesame = base64.b64encode(pub.encrypt(key, asym_padding.PKCS1v15())).decode("ascii")
    return password_field, sesame


def _request(host: str, path: str, payload: dict | None, access: str,
             client_id: str, zone: str, method: str = "POST") -> dict:
    url = f"https://{host}{path}"
    body = json.dumps(payload or {}, separators=(",", ":"), ensure_ascii=False) if payload is not None else ""
    ts = str(int(time.time() * 1000))
    headers = _headers(urlsplit(url).path, body, access, client_id, zone, ts)
    return _http(method, url, payload, headers)


def _login(username: str, password: str) -> dict:
    if not username or not password:
        raise CloudLoginError("Email/phone and password are required")
    client_id = secrets.token_hex(16).upper()
    password_field, sesame = _encrypt_password(password)
    resp = _request("uhome-sea.haieriot.net", LOGIN_PATH,
                    {"username": username.strip(), "password": password_field, "sesame": sesame},
                    "", client_id, "0")
    _check(resp, "login")
    tokens = _tokens(resp)
    if not (tokens["access"] or tokens["refresh"]):
        raise CloudLoginError("login: no token returned (check email/phone and password)")
    if not tokens["access"]:
        tokens["access"] = _refresh(tokens["refresh"], client_id, tokens["zone"])
    return {**tokens, "client_id": client_id}


def _refresh(refresh_token: str, client_id: str, zone: str) -> str:
    if not refresh_token:
        raise CloudLoginError("No saved login; enter your Haier account again")
    resp = _request(_domains(zone)["uhome"], REFRESH_PATH,
                    {"refreshToken": refresh_token}, "", client_id, zone)
    _check(resp, "session refresh")
    tokens = _tokens(resp)
    if not tokens["access"]:
        raise CloudLoginError("session refresh: no access token returned")
    return tokens["access"]


def _device_list(access: str, client_id: str, zone: str) -> dict:
    resp = _request(_domains(zone)["uhome"], DEVICE_PATH, None, access, client_id, zone, "GET")
    _check(resp, "device list")
    data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
    out = {}
    for item in data.get("deviceInfos") or []:
        base = item.get("baseInfo") or {}
        device_id = str(base.get("deviceId") or "")
        if device_id:
            out[device_id] = str(base.get("deviceName") or device_id)
    return out


# --- localKey MQTT gateway (stdlib TLS, one short-lived connection) ----------

def _enc_len(n: int) -> bytes:
    out = b""
    while True:
        digit = n % 128
        n //= 128
        out += bytes([digit | 0x80]) if n else bytes([digit])
        if not n:
            return out


def _mqtt_field(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def _derive_auth(client_id: str) -> tuple[str, str, str]:
    mqtt_id = hashlib.md5(f"{client_id}_{PACKAGE}".encode()).hexdigest()
    body = "".join(str(secrets.randbelow(10)) for _ in range(8))
    block = len(GATEWAY_SALT).to_bytes(2, "big") + GATEWAY_SALT
    block += b"\x00" * (-len(block) % 16)
    cipher = Cipher(algorithms.AES(hashlib.md5(body.encode()).digest()), modes.CBC(b"\x00" * 16)).encryptor()
    password = (cipher.update(block) + cipher.finalize()).hex()
    return mqtt_id, "01" + body, password


class _Gateway:
    def __init__(self, host: str, mqtt_id: str, username: str, password: str):
        self.buffer = b""
        self.publishes = []
        self.pid = 0
        self.acked = set()
        self.closed = False
        ctx = ssl.create_default_context()
        raw = socket.create_connection((host, GATEWAY_PORT), timeout=10)
        try:
            self.sock = ctx.wrap_socket(raw, server_hostname=host)
        except Exception:
            raw.close()
            raise
        try:
            header = b"\x00\x04MQTT\x04" + bytes([0xC2]) + struct.pack(">H", 60)
            payload = header + _mqtt_field(mqtt_id) + _mqtt_field(username) + _mqtt_field(password)
            self.sock.sendall(b"\x10" + _enc_len(len(payload)) + payload)
            ack = b""
            while len(ack) < 4:
                chunk = self.sock.recv(4 - len(ack))
                if not chunk:
                    raise CloudLoginError("gateway closed before CONNACK")
                ack += chunk
            if ack[3]:
                raise CloudLoginError(f"gateway refused connection ({ack[3]})")
        except Exception:
            self.close()
            raise

    def subscribe(self, topic: str):
        self.pid += 1
        payload = struct.pack(">H", self.pid) + _mqtt_field(topic) + b"\x00"
        self.sock.sendall(b"\x82" + _enc_len(len(payload)) + payload)
        deadline = time.monotonic() + 5
        while self.pid not in self.acked and time.monotonic() < deadline:
            self._drain(min(0.5, max(0.05, deadline - time.monotonic())))
        if self.pid not in self.acked:
            raise CloudLoginError("gateway did not confirm subscription")

    def publish(self, topic: str, payload: str):
        body = _mqtt_field(topic) + payload.encode("utf-8")
        self.sock.sendall(b"\x30" + _enc_len(len(body)) + body)

    def poll(self, timeout: float) -> list[bytes]:
        return self._drain(timeout)

    def _drain(self, timeout: float) -> list[bytes]:
        out = self.publishes
        self.publishes = []
        if self.closed:
            if not out:
                raise CloudLoginError("gateway closed the connection")
            return out
        self.sock.settimeout(timeout)
        try:
            data = self.sock.recv(8192)
        except (TimeoutError, socket.timeout):
            return out
        except OSError:
            self.closed = True
            return out
        if not data:
            self.closed = True
            return out
        self.buffer += data
        while len(self.buffer) >= 2:
            mult, value, index = 1, 0, 1
            while index < len(self.buffer):
                byte = self.buffer[index]
                value += (byte & 0x7F) * mult
                mult *= 128
                index += 1
                if not byte & 0x80:
                    break
            else:
                break
            total = index + value
            if len(self.buffer) < total:
                break
            kind, packet = self.buffer[0], self.buffer[index:total]
            self.buffer = self.buffer[total:]
            if kind >> 4 == 9 and len(packet) >= 2:
                self.acked.add((packet[0] << 8) | packet[1])
            elif kind >> 4 == 3:
                length = (packet[0] << 8) | packet[1]
                topic = packet[2:2 + length]
                qos = (kind >> 1) & 3
                self.publishes.append(packet[2 + length + (2 if qos else 0):])
        return out

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def _gateway_keys(access: str, client_id: str, zone: str, device_ids: list[str]) -> dict:
    global _SN
    if Cipher is None:
        raise CloudLoginError("cryptography package is required for Haier key renewal")
    mqtt_id, username, password = _derive_auth(client_id)
    conn = _Gateway(_domains(zone)["gateway"], mqtt_id, username, password)
    try:
        conn.subscribe(f"Client/{mqtt_id}/Business/Down")
        pending = {}
        for device_id in device_ids:
            _SN += 1
            sn = str(_SN)
            inner = json.dumps({"sn": sn, "dev": device_id, "flag": 0}, separators=(",", ":"))
            packet = {"type": "devLocalkey", "data": base64.b64encode(inner.encode()).decode(),
                      "tokens": [access]}
            pending[sn] = device_id
            conn.publish(f"Client/{mqtt_id}/Business/Up", json.dumps(packet, separators=(",", ":")))
        found = {}
        deadline = time.monotonic() + 10
        while pending and time.monotonic() < deadline:
            for payload in conn.poll(0.5):
                try:
                    outer = json.loads(payload)
                    inner = json.loads(base64.b64decode(outer["data"]))
                except Exception:
                    continue
                device_id = pending.get(str(inner.get("sn")))
                if not device_id:
                    continue
                pending.pop(str(inner.get("sn")), None)
                if inner.get("errNo"):
                    continue
                key = str(inner.get("key") or "")
                if HEX32.match(key):
                    found[device_id] = {"key": key, "version": int(inner.get("vers") or 0)}
        return found
    finally:
        conn.close()


# --- encrypted durable session (refresh token only, never a key) -------------

def _session_path():
    import haier_control
    return haier_control.LOCAL_FILE.with_name("haier-cloud.enc")


def _load_session() -> dict:
    import haier_control
    path = _session_path()
    if not path.exists():
        return {}
    try:
        return json.loads(haier_control._cipher().decrypt(path.read_bytes()))
    except Exception:
        return {}


def _save_session(session: dict):
    import haier_control
    haier_control._atomic_private(_session_path(), haier_control._cipher(create=True)
                                  .encrypt(json.dumps(session).encode("utf-8")))


def status() -> dict:
    session = _load_session()
    import haier_control
    try:
        current = haier_control._load()
    except Exception:
        current = {}
    return {"logged_in": bool(session.get("refresh_token")),
            "zone": session.get("zone") or None,
            "last_renew": session.get("last_renew") or None,
            "slots": [{"id": slot, "device_id": (current.get(slot) or {}).get("device_id") or None,
                       "key_version": int((current.get(slot) or {}).get("key_version") or 0)}
                      for slot in haier_control.SLOTS]}


def sign_out() -> dict:
    import haier_control
    path = _session_path()
    if path.exists():
        path.unlink()
    return {"ok": True, "logged_in": False}


def renew(username: str = "", password: str = "", remember: bool = True,
          zone: str = "") -> dict:
    """Sign in (or reuse the saved refresh token) and renew every configured AC.

    Returns only per-slot status. Key values are written directly to the
    encrypted Haier config and are never included in the response.
    """
    import haier_control

    session = _load_session()
    if username or password:
        credential = _login(username, password)
        access, client_id = credential["access"], credential["client_id"]
        refresh = credential["refresh"]
        zone = zone or credential["zone"]
    else:
        access = _refresh(session.get("refresh_token", ""),
                          session.get("client_id", ""), session.get("zone", "0"))
        client_id, refresh = session.get("client_id", ""), session.get("refresh_token", "")
        zone = zone or session.get("zone", "0")

    if remember and refresh and client_id:
        _save_session({"refresh_token": refresh, "client_id": client_id,
                       "zone": str(zone or "0"), "last_renew": session.get("last_renew")})

    config = dict(haier_control._load())
    targets = {slot: str(entry.get("device_id") or "") for slot, entry in config.items()
               if entry.get("device_id")}
    if not targets:
        raise CloudLoginError("Configure an AC (IP and Device ID) before renewing its key")

    hints = [str(zone or "0")]
    if hints[0] != "91":
        hints.append("91")
    elif "0" not in hints:
        hints.append("0")

    renewed, errors, devices = {}, {}, {}
    for candidate in dict.fromkeys(hints):
        cloud_devices = _device_list(access, client_id, candidate)
        selected = {slot: did for slot, did in targets.items() if did in cloud_devices}
        if not selected:
            errors["account"] = "Signed in, but no configured Device ID was found in this account"
            continue
        devices = {did: cloud_devices[did] for did in selected.values()}
        keys = _gateway_keys(access, client_id, candidate, list(dict.fromkeys(selected.values())))
        for slot, device_id in selected.items():
            if device_id not in keys:
                errors[slot] = "Gateway did not return a key for this device"
                continue
            key_info = keys[device_id]
            if not HEX32.match(key_info["key"]):
                errors[slot] = "Gateway returned an unexpected key format"
                continue
            entry = config[slot]
            entry["local_key"] = key_info["key"]
            entry["key_version"] = key_info["version"]
            renewed[slot] = key_info["version"]
        if renewed:
            zone = candidate
            break

    if renewed:
        with haier_control.LOCK:
            current = haier_control._load()
            for slot in renewed:
                current[slot].update({"local_key": config[slot]["local_key"],
                                      "key_version": config[slot]["key_version"]})
                haier_control._cache.pop(slot, None)
                haier_control._auto_observed.pop(slot, None)
            haier_control._save(current)
        if remember and refresh:
            saved = _load_session()
            saved.update({"zone": str(zone), "last_renew": time.strftime("%Y-%m-%d %H:%M:%S")})
            _save_session(saved)

    return {"ok": bool(renewed), "renewed": renewed, "errors": errors,
            "devices": devices, "logged_in": bool(refresh), "zone": str(zone)}
