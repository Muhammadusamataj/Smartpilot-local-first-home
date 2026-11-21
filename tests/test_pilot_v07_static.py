"""Source-level guards for the four-tab compact Home and preserved mirrored views."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def test_only_one_home_per_device_category_and_four_tabs():
    html = (ROOT / 'templates/local_control.html').read_text(encoding="utf-8")
    tabs = re.findall(r'data-view="(home|devices|autopilot|settings)"', html)
    assert tabs == ['home', 'devices', 'autopilot', 'settings']
    assert html.count('data-view-panel="home"') == 1
    assert html.count('data-view-panel="devices"') == 1
    assert html.count('data-view-panel="autopilot"') == 1
    assert html.count('data-view-panel="settings"') == 1
    assert html.count('id="homeQuickDevices"') == 1
    assert html.count('data-haier-overview') == 1
    assert html.count('id="sceneEditor"') == 1


def test_web_android_and_addon_are_source_synced():
    for path in ('templates/local_control.html', 'static/js/features/local-control/main.js',
                 'static/js/features/local-control/home-layout.js', 'static/css/pilot-v07.css'):
        source = (ROOT / path).read_bytes()
        assert source == (ROOT / 'android_offline/app/src/main/python' / path).read_bytes()
        assert source == (ROOT / 'tuya_local_key/app' / path).read_bytes()


def test_no_duplicated_automatic_commands_in_frontend():
    main = (ROOT / 'static/js/features/local-control/main.js').read_text(encoding="utf-8")
    assert "api('/api/local/ensure', {method:'POST'" in main
    assert 'navigator.onLine !== false' not in main
    assert 'navigator.onLine === false' not in main
    assert '2 taps to confirm' in (ROOT / 'static/js/features/local-control/controls.js').read_text(encoding="utf-8")
