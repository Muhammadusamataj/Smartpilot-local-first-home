"""Local-only adapter for the vendored ``haismart_hrdp`` Haier protocol library.

The Flask app keeps its own encrypted storage, two-slot UI, Auto-Pilot and
conservative write allowlist. This module only adds what the older built-in
codec lacks: key-free LAN discovery, a much larger report-layout catalogue and
an explicit localKey-rotation diagnosis. It never imports Home Assistant,
contacts Haier's cloud, logs keys, or returns secrets.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Any

MODULE = "haismart_hrdp"
KEY_VERSION_NOTE = "Set the current 32-hex key and its version; the key value is never shown."

_MODE_CODES = {"0": "auto", "1": "cool", "2": "dry", "6": "fan"}
_FAN_CODES = {"1": "high", "2": "medium", "3": "low", "5": "auto"}
_ALLOWED_NETWORKS = [ipaddress.ip_network(cidr) for cidr in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
)]

_HRDP = None
_HRDP_TRIED = False


class AdapterUnavailable(RuntimeError):
    """The vendored local library cannot be imported on this interpreter."""


class AdapterDecodeError(RuntimeError):
    """The device answered but no trustworthy status could be decoded."""


class LocalKeyRotation(RuntimeError):
    """The appliance is using a newer localKey than the one stored."""

    def __init__(self, device_version: int, held_version: int):
        super().__init__(
            f"Haier local key rotated: the appliance uses v{device_version} but the saved key is "
            f"v{held_version or 0}. {KEY_VERSION_NOTE}"
        )
        self.device_version = device_version
        self.held_version = held_version


def _hrdp():
    """Import the vendored library lazily so Python 3.10 can still use the old codec."""
    global _HRDP, _HRDP_TRIED
    if _HRDP_TRIED:
        if _HRDP is None:
            raise AdapterUnavailable(
                "Haier extended LAN decoding needs Python 3.11+; the basic codec is still available"
            )
        return _HRDP
    _HRDP_TRIED = True
    try:
        import haismart_hrdp as module  # type: ignore
    except ImportError as exc:
        raise AdapterUnavailable(
            "Haier extended LAN decoding is unavailable; the basic codec is still in use"
        ) from exc
    _HRDP = module
    return module


def available() -> bool:
    try:
        _hrdp()
        return True
    except AdapterUnavailable:
        return False


def _valid_ip(host: Any) -> str:
    try:
        addr = ipaddress.ip_address(str(host).strip())
    except ValueError as exc:
        raise ValueError("Only numeric RFC1918 LAN IPv4 addresses are allowed") from exc
    if addr.version != 4 or not any(addr in net for net in _ALLOWED_NETWORKS):
        raise ValueError("Only RFC1918 private IPv4 LAN addresses are allowed")
    return str(addr)


def _profile(h, entry: dict):
    type_id = str(entry.get("product_code") or "").strip()
    if not type_id:
        return None
    try:
        return h.profile_for(type_id)
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def _layout_label(h, blob: bytes, decoded: dict) -> tuple[str, bool]:
    """Return (human label, write permission). Only confirmed classic layouts are writable."""
    confirmed = h.status_layout(blob)
    if confirmed is not None:
        return f"classic-{confirmed.words}", True
    family = decoded.get("layout")
    if family and str(family).lower() != "unknown":
        return f"{family} (read-only)", False
    derived = h.derive_status_layout(blob)
    if derived is not None:
        return f"derived-{derived.words} (read-only)", False
    return "unknown (read-only)", False


def _map_status(h, blob: bytes, decoded: dict, entry: dict) -> dict:
    layout, writable = _layout_label(h, blob, decoded)
    target = decoded.get("target_temperature")
    mode_code = str(decoded.get("operation_mode") or "")
    fan_code = str(decoded.get("wind_speed") or "")
    product = str(entry.get("product_code") or entry.get("uplus_id") or "").strip()
    return {
        "power_on": bool(decoded.get("power", False)),
        "target_c": float(target) if isinstance(target, (int, float)) else None,
        "room_c": decoded.get("current_temperature"),
        "outdoor_c": decoded.get("outdoor_temperature"),
        "hvac_mode": _MODE_CODES.get(mode_code, decoded.get("mode") or "unknown"),
        "fan": _FAN_CODES.get(fan_code, decoded.get("fan_mode") or "unknown"),
        "quiet": bool(decoded.get("quiet", False)),
        "sleep": bool(decoded.get("sleep", False)),
        "strong": bool(decoded.get("strong", False)),
        "eco_level": 5 if decoded.get("eco") else 0,
        "swing_vertical": bool(decoded.get("swing_vertical", False)),
        "swing_horizontal": bool(decoded.get("swing_horizontal", False)),
        "heat_capable": decoded.get("heat_capable"),
        "error_code": decoded.get("error_code"),
        "energy_wh": decoded.get("energy_wh"),
        "layout": layout,
        "adapter": "haismart-hrdp",
        "model": product or None,
        "partial": bool(decoded.get("partial", False)),
        "writable": writable,
    }


def _confirm_key_version(h, entry: dict, host: str, device_id: str) -> None:
    """Probe key-free only after a decode failure, to distinguish rotation from a new layout."""
    held = int(entry.get("key_version") or 0)
    try:
        actual = int(h.probe_localkey_version(host, device_id, timeout=4.0))
    except (OSError, RuntimeError, ValueError) as exc:
        raise AdapterDecodeError("Could not confirm the appliance's localKey version") from exc
    if held and actual and held != actual:
        raise LocalKeyRotation(actual, held)
    if actual:
        raise AdapterDecodeError(
            f"No recognised local status report (appliance key version v{actual}); "
            f"the model layout may be new. {KEY_VERSION_NOTE}"
        )
    raise AdapterDecodeError(f"No decodable local status. {KEY_VERSION_NOTE}")


def read_status(entry: dict) -> dict:
    """Read and decode one local status burst without changing device behaviour."""
    h = _hrdp()
    host = _valid_ip(entry.get("ip"))
    device_id = str(entry.get("device_id") or "").strip()
    local_key = str(entry.get("local_key") or "").strip()
    if not device_id or not local_key:
        raise AdapterDecodeError("Incomplete saved Haier connection")
    profile = _profile(h, entry)
    uplus_id = str(entry.get("uplus_id") or "").strip() or None
    try:
        blobs = h.read_status(host, device_id, local_key, timeout=4.0)
    except h.LocalKeyRotated as exc:
        raise LocalKeyRotation(exc.device_version, int(entry.get("key_version") or 0)) from exc
    except OSError as exc:
        raise AdapterDecodeError("Haier appliance did not answer the local status read") from exc

    for blob in reversed(blobs or []):
        try:
            decoded = h.parse_full_status(blob, profile, uplus_id=uplus_id)
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
        if decoded:
            return _map_status(h, blob, decoded, entry)
    _confirm_key_version(h, entry, host, device_id)
    raise AdapterDecodeError("No decodable local status")  # pragma: no cover


def discover(*, host: str | None = None, timeout: float = 3.0,
             broadcast: str = "255.255.255.255") -> list[dict]:
    """Key-free UDISCOVERY scan. Returns identity fields only — never credentials."""
    h = _hrdp()
    if host:
        target = _valid_ip(host)
        reply = h.query(target, timeout=timeout)
        replies = [reply] if reply is not None else []
    else:
        replies = h.discover(broadcast=broadcast, timeout=timeout)

    found: list[dict] = []
    seen: set[str] = set()
    for info in replies:
        device_id = str(getattr(info, "device_id", "") or "").strip()
        if not re.fullmatch(r"[a-zA-Z0-9]{12,32}", device_id) or device_id in seen:
            continue
        try:
            ip = _valid_ip(getattr(info, "host", ""))
        except ValueError:
            continue
        seen.add(device_id)
        cloud_state = getattr(info, "cloud_state", None)
        try:
            cloud_state = int(cloud_state) if cloud_state is not None else None
        except (TypeError, ValueError):
            cloud_state = None
        firmware = getattr(info, "firmware", ()) or ()
        found.append({
            "ip": ip,
            "device_id": device_id,
            "uplus_id": str(getattr(info, "uplus_id", "") or ""),
            "port": int(getattr(info, "port", 0) or 56800),
            "sdk_version": str(getattr(info, "sdk_version", "") or ""),
            "firmware": [str(item) for item in firmware],
            "cloud_state": cloud_state,
            "cloud_state_name": getattr(info, "cloud_state_name", None),
            "cloud_connected": getattr(info, "cloud_connected", None),
        })
    return found
