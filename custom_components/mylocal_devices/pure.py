"""Pure helpers shared by the platforms. No Home Assistant imports here."""

from __future__ import annotations

import ipaddress
import math
import re

BOOL_TYPES = {"bool", "boolean"}
# Sanitised failure codes only; never forward raw exceptions or SDK strings.
_CODE = re.compile(r"^[a-z0-9][a-z0-9_.]{0,47}$")
_EXACT_SWITCH = re.compile(
    r"^(switch|switch_\d+|power|power_switch|relay|relay_\d+|onoff|on_off|main_switch)$"
)
_NUMERIC_SWITCH = re.compile(r"^(switch|power|relay)_\d+$")
_DEPRIORITISED = re.compile(
    r"prepay|prepayment|credit|balance|energy|child_lock|leak|test|alarm|fault|online"
)


def point_type(point: dict) -> str:
    dtype = str(point.get("type") or "").strip().lower()
    if dtype:
        return dtype
    value = point.get("cloud_value")
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, str):
        return "string"
    return ""


def is_bool_point(point: dict) -> bool:
    return point_type(point) in BOOL_TYPES


def find_addon(addons: list[dict], slug: str, name: str = "") -> str | None:
    """Find the installed Supervisor slug for our add-on.

    Custom repositories prefix the configured slug with a repository hash, so
    `tuya_local_key` can be installed as e.g. `a1b2c3_tuya_local_key`.
    """
    for addon in addons:
        if not isinstance(addon, dict):
            continue
        installed = str(addon.get("slug") or "").strip()
        if installed == slug or installed.endswith(f"_{slug}"):
            return installed
        if name and str(addon.get("name") or "").strip() == name:
            return installed
    return None


def main_score(point: dict) -> int:
    if not is_bool_point(point):
        return 90
    code = str(point.get("code") or "").lower()
    if _EXACT_SWITCH.match(code):
        return 0
    if _NUMERIC_SWITCH.match(code):
        return 1
    if _DEPRIORITISED.search(code):
        return 80
    if re.search(r"switch|power|relay|onoff|on_off", code):
        return 20
    return 40


def primary_point(points: list[dict]) -> dict | None:
    if not points:
        return None
    return min(points, key=lambda point: (main_score(point), str(point.get("code") or "")))


def as_bool(value) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(value)
    text = str(value).strip().lower() if value is not None else ""
    if text in {"true", "1", "on", "yes"}:
        return True
    if text in {"false", "0", "off", "no"}:
        return False
    return None


def live_values(device: dict) -> dict[str, object]:
    """DP -> value from the last successful local read."""
    values = device.get("live_values")
    return values if isinstance(values, dict) else {}


def point_value(device: dict, point: dict):
    dp = str(point.get("dp") or "")
    live = live_values(device)
    if dp in live:
        return live[dp]
    return point.get("cloud_value")


def sanitize_diagnostics(body: dict) -> dict:
    """Allowlist the add-on's read-only diagnostics for a HA sensor.

    Only connection facts and failure codes survive. Keys, tokens, raw socket
    errors, DP values, SSID/BSSID, DNS and URLs can never reach an entity.
    """
    if not isinstance(body, dict):
        return {}

    def section(name: str) -> dict:
        value = body.get(name)
        return value if isinstance(value, dict) else {}

    def text(value, limit: int = 48) -> str:
        result = str(value or "").strip()
        return result[:limit] if result else ""

    def code(value) -> str:
        result = text(value, 48)
        return result if _CODE.match(result) else ""

    def number(value) -> float | None:
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return result if math.isfinite(result) else None

    def count(value) -> int:
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError, OverflowError):
            return 0

    def strict_bool(value) -> bool:
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

    def ip(value) -> str:
        candidate = text(value, 64)
        try:
            parsed = ipaddress.ip_address(candidate)
        except ValueError:
            return ""
        return candidate if parsed.version == 4 else ""

    def ipv4_network(value) -> str:
        candidate = text(value, 64)
        try:
            network = ipaddress.ip_network(candidate, strict=False)
        except ValueError:
            return ""
        return str(network) if network.version == 4 and network.prefixlen >= 8 else ""

    network = section("network")
    wifi = network.get("wifi") if isinstance(network.get("wifi"), dict) else {}
    vpn = network.get("vpn") if isinstance(network.get("vpn"), dict) else {}
    route = (network.get("default_route")
             if isinstance(network.get("default_route"), dict) else {})
    addresses = section("addresses")
    tcp = section("tcp6668")
    protocol = section("protocol")
    handshake = (protocol.get("handshake")
                 if isinstance(protocol.get("handshake"), dict) else {})
    status = section("status")
    history = section("history")
    dp_ids = [str(dp) for dp in (status.get("dp_ids") or [])
              if str(dp).isdigit()][:64]
    return {
        "network_source": code(section("network").get("source")),
        "network_observed_at": number(section("network").get("observed_at")),
        "confidence": code(addresses.get("reachable_confidence")),
        "saved_ip": ip(addresses.get("saved_ip")),
        "reachable_ip": ip(addresses.get("reachable_ip")),
        "wifi_connected": strict_bool(wifi.get("connected")),
        "wifi_ipv4": ipv4_network(wifi.get("ipv4")),
        "vpn_connected": strict_bool(vpn.get("connected")),
        "vpn_tailscale_ip": ip(vpn.get("tailscale_ip")),
        "default_route": code(route.get("transport")),
        "default_route_active": strict_bool(route.get("is_default")),
        "tcp_state": code(tcp.get("state")),
        "tcp_ms": number(tcp.get("elapsed_ms")),
        "tcp_timeout_ms": number(tcp.get("timeout_ms")),
        "protocol_configured": code(protocol.get("configured")),
        "protocol_detected": code(protocol.get("detected")),
        "handshake_attempted": strict_bool(handshake.get("attempted")),
        "handshake_match": strict_bool(handshake.get("match")),
        "handshake_session_key": strict_bool(handshake.get("session_key_installed")),
        "handshake_error": code(handshake.get("error_kind")),
        "status_result": code(status.get("result")),
        "status_read_at": number(status.get("read_at")),
        "dp_count": len(dp_ids),
        "dp_ids": dp_ids,
        "last_ok": number(history.get("last_ok")),
        "last_failed": number(history.get("last_failed")),
        "fail_count": count(history.get("fail_count")),
        "recovery_reason": code(history.get("recovery_reason")),
    }


def merge_live_points(points: list[dict], values: list[dict]) -> list[dict]:
    """Add DPs that only appear in the live read to the cached DP spec.

    Tuya often omits power/energy DPs from the cached `local_strategy`, but the
    local status read still returns their values. Creating a synthetic point
    for those DPs lets the sensor platform expose them instead of dropping
    them silently.
    """
    merged = [dict(point) for point in points if isinstance(point, dict)]
    by_dp = {str(point.get("dp") or ""): point for point in merged}

    for item in values:
        if not isinstance(item, dict):
            continue
        dp = str(item.get("dp") or "").strip()
        if not dp:
            continue
        value = item.get("value")
        point = by_dp.get(dp)
        if point is None:
            point = {
                "dp": dp,
                "code": str(item.get("code") or f"DP {dp}"),
                "type": str(item.get("type") or ""),
            }
            by_dp[dp] = point
            merged.append(point)
        elif not point.get("type") and item.get("type"):
            point["type"] = item["type"]
        # The live value wins; point_type() can infer the DP type from it when
        # the cached spec has no type at all.
        point["cloud_value"] = value
        point["value"] = value

    return merged
