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


def test_protocol_version_offers_auto_in_add_and_edit_forms():
    """Users should not have to guess a Tuya protocol version by hand."""
    html = (ROOT / 'templates/local_control.html').read_text(encoding='utf-8')
    assert '<option value="auto" selected>Auto (detect)</option>' in html
    source = (ROOT / 'static/js/features/local-control/main.js').read_text(encoding='utf-8')
    assert '<option value="auto"' in source
    assert 'Auto (detect)' in source
    assert 'const currentVersion = String(device.version || "auto");' in source


def test_bulk_status_refreshes_are_queued_not_dropped():
    """Mobile concurrency stays 2; extra reads wait in one bounded FIFO."""
    source = (ROOT / 'static/js/features/local-control/main.js').read_text(encoding='utf-8')
    assert 'limiter.run(' not in source
    assert 'new LimitedConcurrency(mobile ? 2 : 3)' in source
    assert source.count('limiter.queue(') == 1
    assert 'function queueRefresh(' in source
    assert 'function refreshAllDevices(' in source
    assert 'refreshAllDevices(true)' in source  # cold start + foreground resume
    api = (ROOT / 'static/js/features/local-control/api.js').read_text(encoding='utf-8')
    assert 'queue(task)' in api and 'this.waiting.push(task)' in api
    assert 'maxWaiting' in api  # bounded, not unbounded
    assert 'drain()' in api


def test_haier_local_library_and_adapter_are_source_synced():
    files = (
        'haier_control.py', 'haier_hrdp_adapter.py',
        'static/js/features/local-control/haier.js', 'static/css/haier.css',
    )
    for path in files:
        source = (ROOT / path).read_bytes()
        assert source == (ROOT / 'android_offline/app/src/main/python' / path).read_bytes()
        assert source == (ROOT / 'tuya_local_key/app' / path).read_bytes()

    vendor = ROOT / 'haismart_hrdp'
    assert (vendor / 'LICENSE').is_file()
    assert 'MIT License' in (vendor / 'LICENSE').read_text(encoding='utf-8')
    for name in ('uss.py', 'udiscovery.py', '__init__.py', 'device_models.json.gz'):
        assert (vendor / name).is_file()
    def _files(folder):
        return {
            p.relative_to(folder): p.read_bytes()
            for p in folder.rglob('*') if p.is_file() and '__pycache__' not in p.parts
        }

    for mirror in (ROOT / 'android_offline/app/src/main/python/haismart_hrdp',
                   ROOT / 'tuya_local_key/app/haismart_hrdp'):
        assert _files(vendor) == _files(mirror)
    for source in vendor.glob('*.py'):
        assert not re.search(r'^\s*(?:from|import)\s+homeassistant\b', source.read_text(encoding='utf-8'), re.M)


def test_no_duplicated_automatic_commands_in_frontend():
    main = (ROOT / 'static/js/features/local-control/main.js').read_text(encoding="utf-8")
    assert "api('/api/local/ensure', {method:'POST'" in main
    assert 'navigator.onLine !== false' not in main
    assert 'navigator.onLine === false' not in main
    assert '2 taps to confirm' in (ROOT / 'static/js/features/local-control/controls.js').read_text(encoding="utf-8")
