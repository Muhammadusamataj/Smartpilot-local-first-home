"""Pure protocol tests; synthetic AC only — never exercise real hardware."""
import contextlib
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
import types
from pathlib import Path

import pytest


# Flask is a dependency of the complete app, not installed in this build sandbox.
# The standalone backend codec can still be verified without installing it.
if "flask" not in sys.modules:
    try:
        import flask  # noqa
    except ImportError:
        class StubBlueprint:
            def __init__(self, *a, **kw): pass
            def __getattr__(self, key): return lambda *a, **kw: lambda f: f
        stub = types.SimpleNamespace(Blueprint=StubBlueprint, jsonify=lambda x: x, request=None)
        sys.modules["flask"] = stub

modpath = Path(__file__).resolve().parents[1] / "haier_control.py"
spec = importlib.util.spec_from_file_location("haier_codec_test", modpath)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
KEY = "c018aabbccddeeff0011223344556677"
DID = "A1B2C3D4E5F6"


def test_lan_ip_validation():
    for host in ["192.168.0.7", "10.23.4.5", "172.16.2.9"]:
        assert h._valid_ip(host) == host
    for host in ["127.0.0.1", "8.8.8.8", "172.32.1.2", "::1", "evil.test"]:
        with pytest.raises(ValueError): h._valid_ip(host)


def test_encryption_and_transport_round_trip():
    plain = b"\x00\x00\x27\x15" + bytes(range(12)) + b"\xff\xff" + b"test"
    cipher = h._crypt_out(345, plain, KEY)
    assert h._crypt_in(cipher, KEY) == plain
    with pytest.raises(h.HaierError): h._crypt_in(cipher, "0"*32)
    assert h._packet(0, 1, 0, 1, 0, DID.encode().ljust(32,b"\0")).startswith(bytes.fromhex("0000ea60"))
    assert h._epp(1, bytes.fromhex("4d01")).hex() == "ffff0a000000000000014d0159"


def test_confirmed_fields_only():
    words = bytes(12)
    changed = h._set_field(words, "target", 10)
    assert h._field(changed, "target") == 10
    assert h._field(changed, "power") == 0
    changed = h._set_field(changed,"power",1)
    assert h._field(changed,"power") == 1
    with pytest.raises(ValueError): h._encode_command("mode", "heat")
    with pytest.raises(ValueError): h._set_field(words, "eco", 7)
    with pytest.raises(ValueError): h._encode_command("temperature", 31)


def test_status_parser_classic_and_unknown():
    fake = bytearray(127)
    fake[2:4] = b"\x27\x15"
    fake[80:82] = b"\xff\xff"
    fake[90:92] = b"\x6d\x01"
    fake[92] = 10
    fake[94] = (1 << 5) | 5
    fake[97] = 1
    fake[104] = 48
    status, baseline = h._classic([bytes(fake)])
    assert baseline is not None
    assert status["target_c"] == 26 and status["room_c"] == 24
    assert status["power_on"] and status["hvac_mode"] == "cool"
    assert status["writable"]
    unknown = bytes(fake) + b"x"
    unknown_status, no_baseline = h._classic([unknown])
    assert no_baseline is None and not unknown_status["writable"]


def test_local_key_is_encrypted_on_disk(tmp_path,monkeypatch):
    monkeypatch.setattr(h, "LOCAL_FILE", tmp_path/"haier.enc")
    monkeypatch.setattr(h, "KEY_FILE", tmp_path/"haier.key")
    config=h._load()
    assert config["pro"]["mode"] == "manual"
    config["pro"] = {**h._validate_device("192.168.10.90", DID, KEY, 4),"mode":"manual"}
    h._save(config)
    assert KEY.encode() not in h.LOCAL_FILE.read_bytes()
    assert h._load()["pro"]["local_key"] == KEY
    assert h._summary("pro", config["pro"]).get("local_key") is None
    # POSIX mode bits are meaningless on Windows (chmod is a no-op there).
    # The encryption assertion above is the real safety check on every OS.
    if os.name == "posix":
        assert h.KEY_FILE.stat().st_mode & 0o077 == 0


def test_socket_handshake_with_synthetic_device(monkeypatch):
    """Fake LAN socket accepts HELLO, HELLO_DONE, then read-only extended query."""
    a,b = socket.socketpair()
    def receive(sock):
        first = sock.recv(6)
        length = struct.unpack(">H",first[4:6])[0]
        other=b""
        while len(other)<length:
            other+=sock.recv(length-len(other))
        return first+other
    synthetic = bytearray(127)
    synthetic[2:4]=b"\x27\x15"
    synthetic[80:82]=b"\xff\xff"
    synthetic[90:92]=b"\x6d\x01"
    synthetic[92]=10
    synthetic[94]=37
    synthetic[97]=1
    synthetic[104]=50
    def server():
        try:
            hello = receive(b)
            assert hello[0:4] == bytes.fromhex("0000ea60")
            b.sendall(h._packet(1,1,0x1234,1,0,struct.pack(">II",1,4)))
            done = receive(b)
            assert done[0:4] == bytes.fromhex("0000ea62")
            b.sendall(h._packet(3,2,0x1234,1,0,h._crypt_out(2,struct.pack(">I",555),KEY)))
            b.sendall(h._packet(0x64,0,0x1234,1,1,h._crypt_out(555,bytes(synthetic),KEY)))
            op = receive(b)
            assert op[:4] == bytes.fromhex("0000eac4")
            # Echo status when read-only query is sent.
            b.sendall(h._packet(0x64,0,0x1234,1,1,h._crypt_out(555,bytes(synthetic),KEY)))
        finally:
            b.close()
    th=threading.Thread(target=server,daemon=True)
    th.start()
    monkeypatch.setattr(h.socket, "create_connection",lambda *args,**kw:a)
    entry=h._validate_device("192.168.1.2",DID,KEY,4)
    with h._Session(entry) as session:
        session.op(h._epp(1,b"\x4d\xfe"))
        blobs=session.collect()
    state, baseline=h._classic(blobs)
    assert baseline is not None and state["target_c"]==26
    th.join(timeout=2)


def test_stale_cache_never_exposes_live_controls(monkeypatch):
    """An expired LAN reading must not be returned as an actionable status."""
    monkeypatch.setattr(h.time, "time", lambda: 3000.0)
    monkeypatch.setitem(h._cache, "pro", {"verified": True, "read_at": 2800.0,
                                         "data": {"writable": True, "power_on": True,
                                                  "room_c": 24, "power_w": 700}})
    state = h._summary("pro", {"mode": "manual", "ip": "192.168.1.9", "local_key": KEY})
    assert state["verified"] is False
    assert state["status"] is None
    assert state["last_read"] == 2800.0
    h._cache.pop("pro", None)


def test_failed_refresh_revokes_cached_verification(monkeypatch):
    """A failed user refresh cannot leave previous ONLINE control permissions."""
    monkeypatch.setattr(h, "_body", lambda: {"slot": "pro"})
    monkeypatch.setattr(h, "_load", lambda: {"pro": {"mode": "manual", "ip": "192.168.1.9", "local_key": KEY}})
    monkeypatch.setattr(h, "_read_device", lambda entry: (_ for _ in ()).throw(h.HaierError("offline")))
    monkeypatch.setitem(h._cache, "pro", {"verified": True, "read_at": 3000.0,
                                         "data": {"writable": True, "power_on": True}})
    # A Flask view needs an application context for jsonify. In production the
    # framework always provides one; the direct unit call must do the same.
    try:
        import flask
    except ImportError:
        context = contextlib.nullcontext()
    else:
        context = flask.Flask("test").app_context()
    with context:
        result, code = h.haier_read()
    payload = result.get_json() if hasattr(result, "get_json") else result
    assert code == 503 and "offline" in payload["error"]
    assert h._cache["pro"]["verified"] is False
    assert h._cache["pro"]["data"] is None
    h._cache.pop("pro", None)


def test_config_saves_discovery_identity_without_returning_the_key(tmp_path, monkeypatch):
    monkeypatch.setattr(h, "LOCAL_FILE", tmp_path / "haier.enc")
    monkeypatch.setattr(h, "KEY_FILE", tmp_path / "haier.key")
    monkeypatch.setattr(h, "jsonify", lambda value: value)
    monkeypatch.setattr(h, "_body", lambda: {
        "slot": "pro", "ip": "192.168.1.50", "device_id": DID, "local_key": KEY,
        "key_version": 4, "uplus_id": "AABBCCDD", "product_code": "AAC1UKZ01",
    })

    result = h.haier_config()

    assert result["ok"] is True
    saved = h._load()["pro"]
    assert saved["uplus_id"] == "AABBCCDD"
    assert saved["product_code"] == "AAC1UKZ01"
    assert "local_key" not in result["device"]


def test_bad_discovery_identity_is_rejected():
    with pytest.raises(ValueError):
        h._validate_model_id("bad;id", "uPlus ID")


def test_discover_route_returns_identity_fields_only(monkeypatch):
    monkeypatch.setattr(h, "jsonify", lambda value: value)
    monkeypatch.setattr(h, "request", types.SimpleNamespace(args={}))
    monkeypatch.setattr(h.hrdp, "discover", lambda **kwargs: [{
        "ip": "192.168.1.50", "device_id": DID, "uplus_id": "AABBCCDD",
        "cloud_state_name": "disconnected", "cloud_connected": False,
    }])

    result = h.haier_discover()

    assert result["ok"] is True
    assert result["devices"][0]["device_id"] == DID
    assert "local_key" not in result
    assert "local_key" not in result["devices"][0]


def test_io_locks_are_reused_per_slot(monkeypatch):
    monkeypatch.setattr(h, "_IO_LOCKS", {})

    assert h._io_lock("pro") is h._io_lock("pro")
    assert h._io_lock("pro") is not h._io_lock("max")


def test_failed_power_off_persists_guard_and_manual_override(tmp_path, monkeypatch):
    """An unacknowledged OFF must still block ON and pause Auto after restart."""
    monkeypatch.setattr(h, "LOCAL_FILE", tmp_path / "haier.enc")
    monkeypatch.setattr(h, "KEY_FILE", tmp_path / "haier.key")
    monkeypatch.setattr(h.time, "time", lambda: 1000.0)
    entry = {**h._validate_device("192.168.10.90", DID, KEY, 4), "mode": "auto"}
    h._save({"pro": entry})
    monkeypatch.setattr(h, "_write_device",
                        lambda *args: (_ for _ in ()).throw(h.HaierError("offline")))

    with pytest.raises(h.HaierError, match="offline"):
        h._write("pro", "power", False)

    saved = h._load()["pro"]
    assert saved["power_off_at"] == 1000.0
    assert saved["pause_until"] == 8200.0

    # Simulate a process restart: only the encrypted file remains.
    monkeypatch.setattr(h, "_last_off", {})
    monkeypatch.setattr(h, "_last_write", {})

    with pytest.raises(h.HaierError, match="Compressor protection"):
        h._write("pro", "power", True)


def test_fan_change_detects_external_override_and_pauses_auto(tmp_path, monkeypatch):
    monkeypatch.setattr(h, "LOCAL_FILE", tmp_path / "haier.enc")
    monkeypatch.setattr(h, "KEY_FILE", tmp_path / "haier.key")
    monkeypatch.setattr(h.time, "time", lambda: 1000.0)
    monkeypatch.setattr(h, "_IO_LOCKS", {})
    monkeypatch.setattr(h, "_last_write", {})
    monkeypatch.setattr(h, "_auto_last", {})
    monkeypatch.setattr(h, "_auto_observed", {})
    h._save({"pro": {**h._validate_device("192.168.10.90", DID, KEY, 4), "mode": "auto"}})
    h._auto_observed["pro"] = (26, "heat", 0, "low", False, False, False)
    monkeypatch.setattr(h, "_read_device", lambda entry: {
        "writable": True, "power_on": True, "target_c": 26, "hvac_mode": "heat",
        "eco_level": 0, "fan": "high", "quiet": False, "sleep": False, "strong": False,
    })

    h._auto_tick("pro", {"mode": "auto", "ip": "192.168.10.90", "pause_until": 0})

    assert h._load()["pro"]["pause_until"] > 1000.0
