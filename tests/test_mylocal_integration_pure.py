"""Pure helpers for the HA mylocal_devices integration (no HA required)."""
from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components" / "mylocal_devices"))

import pure  # noqa: E402


def _packed(voltage_word: int, current_word: int, power_word: int) -> str:
    raw = bytes([
        (voltage_word >> 8) & 0xFF, voltage_word & 0xFF,  # bytes 0-1
        0,                                               # byte 2 (unused)
        (current_word >> 8) & 0xFF, current_word & 0xFF,  # bytes 3-4
        0,                                               # byte 5 (unused)
        (power_word >> 8) & 0xFF, power_word & 0xFF,      # bytes 6-7
    ])
    return base64.b64encode(raw).decode("ascii")


def test_decode_phase_dp_uses_localtuya_formula():
    value = _packed(2396, 1500, 2500)
    assert pure.is_base64_dp(value)
    decoded = pure.decode_base64_dp(value)
    assert decoded["voltage"] == pytest.approx(239.6)
    assert decoded["current"] == pytest.approx(1.5)
    assert decoded["power"] == pytest.approx(2.5)


def test_decode_ignores_non_phase_values():
    assert pure.decode_base64_dp("on") == {}
    assert pure.decode_base64_dp("") == {}
    assert pure.is_phase_code({"code": "phase_a"})
    assert not pure.is_phase_code({"code": "switch_1"})
