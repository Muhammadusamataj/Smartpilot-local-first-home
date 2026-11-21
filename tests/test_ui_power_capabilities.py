"""Regression guards for the verified inline Tuya power switches.

The capability mapper must declare its Boolean power DP before the Home and
Devices cards can use it. This is a frontend guard; it never writes to devices.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_power_capability_declaration_is_not_commented_out():
    source = (ROOT / "static/js/features/local-control/model.js").read_text(encoding="utf-8")
    assert '  const power = findPoint(points, POWER_CODE, ["bool"]);' in source.splitlines()
    assert '  if (power) remember(power, "Power", "switch");' in source
    assert r"\n  // switch unless" not in source
    assert r"\n  const power =" not in source


def test_inline_power_uses_actual_boolean_capability():
    model = (ROOT / "static/js/features/local-control/model.js").read_text(encoding="utf-8")
    js = (ROOT / "static/js/features/local-control/main.js").read_text(encoding="utf-8")
    assert "kind: control," in model
    assert "type: pointKind(point)" in model
    assert 'item.kind === "switch" && item.type === "bool"' in js
    assert "Date.now() - checkedAt > 60000" in js
    assert "renderSwitch(device.id, live.point, live.value" in js


def test_model_js_source_mirrors_are_identical():
    source = (ROOT / "static/js/features/local-control/model.js").read_bytes()
    for prefix in ("tuya_local_key/app", "android_offline/app/src/main/python"):
        assert (ROOT / prefix / "static/js/features/local-control/model.js").read_bytes() == source
