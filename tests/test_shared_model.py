"""Direct unit coverage for the shared model, without a browser or DOM."""
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODEL_URL = (ROOT / "static" / "js" / "shared" / "model.js").as_uri()
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not NODE, reason="Node.js is needed to load the ES module")

_EVAL = """
const { isOnline } = await import(process.env.MODEL_URL);
if (process.env.NOW_MS) Date.now = () => Number(process.env.NOW_MS);
process.stdout.write(isOnline(JSON.parse(process.env.DEVICE)) ? "true" : "false");
"""


def is_online(device, now_ms=None):
    env = dict(os.environ, MODEL_URL=MODEL_URL, DEVICE=json.dumps(device))
    if now_ms is not None:
        env["NOW_MS"] = str(now_ms)
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", _EVAL],
        cwd=ROOT, env=env, capture_output=True, text=True, check=True,
    )
    return result.stdout.strip() == "true"


NOW_MS = 1_800_000_000_000
FRESH_AT = (NOW_MS - 5 * 60_000) / 1000
STALE_AT = (NOW_MS - 16 * 60_000) / 1000


def _device(status, online=False, **fields):
    return dict(lan_status=status, online=online, **fields)


def _checked(epoch):
    return {"epochs": {"lan_checked_at": epoch}}


def _sub(**fields):
    return dict(_device("via_gateway", local_ip="192.168.1.61"), **fields)


def test_legacy_results_without_a_timestamp_keep_their_old_meaning():
    assert is_online(_device("ok"))
    assert is_online(_device("busy"))
    assert not is_online(_device("unreachable", online=True))
    assert not is_online({"online": False})


def test_a_key_mismatch_is_never_online():
    assert not is_online(_device("key_mismatch", online=True))


@pytest.mark.parametrize("status", ["ok", "busy"])
def test_a_recent_lan_answer_counts_as_online(status):
    assert is_online(dict(_device(status), **_checked(FRESH_AT)), now_ms=NOW_MS)


@pytest.mark.parametrize("status", ["ok", "busy"])
def test_an_old_lan_answer_needs_the_cloud_to_agree(status):
    stale = dict(_device(status), **_checked(STALE_AT))
    assert not is_online(stale, now_ms=NOW_MS)
    assert is_online(dict(stale, online=True), now_ms=NOW_MS)


def test_a_string_timestamp_from_the_server_is_understood():
    checked = "2025-07-08 18:40:00 UTC"
    checked_ms = int(datetime(2025, 7, 8, 18, 40, tzinfo=timezone.utc).timestamp() * 1000)
    device = dict(_device("ok"), lan_checked_at=checked)
    assert is_online(device, now_ms=checked_ms + 5 * 60_000)
    assert not is_online(device, now_ms=checked_ms + 16 * 60_000)
    assert is_online(dict(device, online=True), now_ms=checked_ms + 16 * 60_000)


@pytest.mark.parametrize("status", ["key_mismatch", "unreachable", "not_found"])
def test_explicit_lan_evidence_still_contradicts_a_cloud_online_report(status):
    device = dict(_device(status, online=True), **_checked(STALE_AT))
    assert not is_online(device, now_ms=NOW_MS)


def test_a_gateway_answer_alone_does_not_mark_its_sub_device_online():
    assert not is_online(_sub(**_checked(FRESH_AT)), now_ms=NOW_MS)
    assert not is_online(_sub(online=True, **_checked(FRESH_AT)), now_ms=NOW_MS)


def test_a_sub_device_needs_its_gateway_report_and_a_found_gateway():
    reported = dict(_sub(lan_sub_online=True), **_checked(FRESH_AT))
    assert is_online(reported, now_ms=NOW_MS)
    assert not is_online(dict(reported, local_ip=""), now_ms=NOW_MS)
    assert not is_online(dict(reported, lan_sub_online=False, online=True), now_ms=NOW_MS)


def test_an_explicit_sub_device_report_survives_an_old_scan():
    reported = dict(_sub(lan_sub_online=True), **_checked(STALE_AT))
    assert is_online(reported, now_ms=NOW_MS)
    assert is_online(dict(reported, online=True), now_ms=NOW_MS)
    assert not is_online(dict(reported, lan_sub_online=False, online=True), now_ms=NOW_MS)
    assert not is_online(dict(reported, lan_sub_online=None), now_ms=NOW_MS)
