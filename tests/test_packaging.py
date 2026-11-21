import json
import re
import struct
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_home_assistant_metadata_builds_from_source():
    config = yaml.safe_load((ROOT / "tuya_local_key" / "config.yaml").read_text())
    repository = yaml.safe_load((ROOT / "repository.yaml").read_text())

    assert repository["name"] == "MY Local Devices Tuya"
    assert repository["url"] == "https://github.com/Muhammadusamataj/MYlocal-devices-tuya"
    assert config["name"] == "MY Local Devices Tuya"
    assert config["slug"] == "tuya_local_key"
    assert config["version"] == "4.7"
    assert config["url"] == repository["url"]
    # The Supervisor builds from tuya_local_key/Dockerfile; no GHCR image is
    # required, so Actions billing cannot block installation.
    assert "image" not in config
    assert "legacy" not in config
    assert config["arch"] == ["aarch64", "amd64"]
    assert config["ingress"] is True
    assert config["ingress_port"] == 8000
    assert config["ingress_entry"] == "/local"
    assert config["ports"]["8000/tcp"] is None
    assert config["environment"]["SESSION_FILE"] == "/data/session.json"
    assert config["environment"]["QR_SCHEME"] == "smartlife"
    assert config["environment"]["PORT"] == "8000"
    assert config["options"]["QR_SCHEME"] == "smartlife"
    assert config["options"]["DEVICE_CACHE"] == "on"
    assert config["options"]["CHECK_FOR_UPDATES"] is True
    assert config["options"]["AUTO_SETUP"] == "on"
    assert config["schema"]["QR_SCHEME"] == "list(smartlife|tuyaSmart)"
    assert config["schema"]["DEVICE_CACHE"] == "list(on|off)"
    assert config["schema"]["CHECK_FOR_UPDATES"] == "bool"
    assert config["schema"]["AUTO_SETUP"] == "list(on|off)"
    assert config["schema"]["AUTH_USERNAME"] == "str?"
    assert config["schema"]["AUTH_PASSWORD"] == "password?"
    assert config["schema"]["LAN_SUBNET"] == "str?"


def test_release_version_is_consistent_across_metadata():
    """config.yaml, the changelog, and the Python package must move together."""
    config = yaml.safe_load((ROOT / "tuya_local_key" / "config.yaml").read_text())
    changelog = (ROOT / "tuya_local_key" / "CHANGELOG.md").read_text()
    pyproject = (ROOT / "pyproject.toml").read_text()

    version = config["version"]
    headings = re.findall(r"^## (\d+\.\d+(?:\.\d+)?)$", changelog, re.M)

    assert headings[0] == version, "newest released changelog entry must be the app version"
    assert f"...v{version}" in changelog, "changelog needs a compare link for this release"
    assert re.search(rf'^version = "{re.escape(version)}\.\d+"$', pyproject, re.M), \
        "pyproject version must share the app's major.minor"


def test_home_assistant_app_icon_exists_and_is_square_png():
    icon = ROOT / "tuya_local_key" / "icon.png"
    data = icon.read_bytes()

    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    assert icon.name == "icon.png"
    assert struct.unpack(">II", data[16:24]) == (128, 128)


def test_dockerfile_has_home_assistant_labels_and_runtime_contract():
    dockerfile = (ROOT / "Dockerfile").read_text()

    assert 'ARG BUILD_VERSION=dev' in dockerfile
    assert 'io.hass.version="${BUILD_VERSION}"' in dockerfile
    assert 'io.hass.type="app"' in dockerfile
    assert 'io.hass.arch="aarch64|amd64"' in dockerfile
    assert "PYTHONDONTWRITEBYTECODE=1" in dockerfile
    assert "USER appuser" not in dockerfile
    assert "SESSION_FILE=/data/session.json" in dockerfile
    assert "device_cache.py" in dockerfile
    assert "device_preferences.py" in dockerfile
    assert "device_values.py" in dockerfile
    assert "support_report.py" in dockerfile
    assert "updates.py" in dockerfile
    assert "pyproject.toml" in dockerfile
    assert "lan_scan.py" in dockerfile
    assert "local_control.py" in dockerfile
    assert "COPY templates ./templates" in dockerfile
    assert "COPY static ./static" in dockerfile
    assert 'VOLUME ["/data"]' in dockerfile
    assert "waitress-serve --listen=0.0.0.0:${PORT:-8000}" in dockerfile


def test_local_control_api_calls_work_behind_home_assistant_ingress():
    page = (ROOT / "templates" / "local_control.html").read_text(encoding="utf-8")
    api_js = (ROOT / "static" / "js" / "features" / "local-control" / "api.js").read_text(encoding="utf-8")

    # The template stays a thin shell; URL normalisation lives in the module.
    assert '<script type="module" src="static/js/features/local-control/main.js"></script>' in page

    # Absolute /api/... URLs resolve against Home Assistant, not the add-on,
    # and show up as HTTP 404 when "Auto scan" is pressed in ingress.
    assert 'url.replace(/^\\/+/, "")' in api_js
    assert "await fetch(url, options)" not in api_js


def test_auto_refresh_does_not_rebuild_device_cards():
    main_js = (ROOT / "static" / "js" / "features" / "local-control" / "main.js").read_text()
    controls_js = (ROOT / "static" / "js" / "features" / "local-control" / "controls.js").read_text()

    # On phones the 10s/30s poll used to clear .tile-body every time, which
    # looked like the whole page was refreshing and could swallow a switch tap.
    assert "export function updatePoints(" in controls_js
    assert "updatePoints(item, data.values || [])" in main_js
    assert "refresh(card.dataset.id, card, true)" in main_js


def test_home_assistant_addon_has_its_own_build_context():
    addon = ROOT / "tuya_local_key"
    dockerfile = (addon / "Dockerfile").read_text()

    assert "COPY app/requirements.txt app/requirements-web.txt" in dockerfile
    assert "COPY app/ ./" in dockerfile
    assert (addon / "app" / "requirements.txt").is_file()
    # Must work even with an older cached Dockerfile that copies only this file.
    assert "-r " not in (addon / "app" / "requirements-web.txt").read_text()
    assert (addon / "app" / "local_control.py").is_file()
    assert (addon / "app" / "templates" / "local_control.html").is_file()
    assert (addon / "app" / "static" / "css" / "base.css").is_file()
    assert (addon / "app" / "tuya_local_key" / "icon.png").is_file()


def test_github_workflow_is_optional_for_tagged_releases():
    workflow = yaml.safe_load(
        (ROOT / ".github" / "workflows" / "docker-publish.yml").read_text()
    )

    assert workflow[True]["push"] == {"tags": ["v*"]}
    assert "branches" not in workflow[True]["push"]
    assert workflow[True]["pull_request"] == {"branches": ["main"]}

    text = (ROOT / ".github" / "workflows" / "docker-publish.yml").read_text()
    assert "pytest" in text
    assert "value=${GITHUB_REF_NAME#v}" in text
    assert "type=raw,value=${{ steps.version.outputs.value }}" in text
    assert "BUILD_VERSION=${{ steps.version.outputs.value }}" in text
    assert "push: false" in text
    assert "push: true" in text


def test_custom_integration_files_are_shipped():
    integration = ROOT / "custom_components" / "mylocal_devices"
    manifest = json.loads((integration / "manifest.json").read_text())

    assert manifest["domain"] == "mylocal_devices"
    assert manifest["config_flow"] is True
    assert manifest["iot_class"] == "local_polling"
    assert (integration / "__init__.py").is_file()
    assert (integration / "config_flow.py").is_file()
    assert (integration / "switch.py").is_file()
    assert (integration / "sensor.py").is_file()
    assert (ROOT / "docs" / "custom-integration.md").is_file()
    assert (ROOT / "hacs.json").is_file()
    assert json.loads((ROOT / "hacs.json").read_text())["name"] == "MY Local Devices Tuya"
    assert "custom integration" in (ROOT / "README.md").read_text().lower()


def _documentation_screenshot_paths():
    documents = [ROOT / "README.md", ROOT / "docs" / "screenshots.md"]
    return {
        document.parent / path
        for document in documents
        for path in re.findall(r'(?:src|srcset)="([^"]+)"', document.read_text())
        if not path.startswith(("http://", "https://"))
    }


def test_documentation_screenshot_paths_exist():
    paths = _documentation_screenshot_paths()

    assert paths
    for path in paths:
        assert path.is_file(), path


def test_every_documentation_screenshot_can_be_regenerated():
    embedded = {
        re.sub(r"-(light|dark)$", "", path.stem)
        for path in _documentation_screenshot_paths()
    }
    script = (ROOT / "tools" / "screenshots.py").read_text()
    shots = set(re.findall(r'^    "([\w-]+)": shot_\w+,$', script, re.MULTILINE))

    assert shots, "SHOTS table not found in tools/screenshots.py"
    assert embedded == shots


def test_downloads_badge_workflow_feeds_the_readme_badge():
    path = ROOT / ".github" / "workflows" / "downloads-badge.yml"
    workflow = yaml.safe_load(path.read_text())
    text = path.read_text()
    readme = (ROOT / "README.md").read_text()

    assert workflow[True]["schedule"] and "workflow_dispatch" in workflow[True]
    assert workflow["permissions"] == {"contents": "write"}
    # It writes to the badges branch only, never to main.
    pushes = re.findall(r"git push[^\n]*", text)
    assert pushes == [
        'git push -q --force-with-lease="refs/heads/badges:$previous" origin "$commit:refs/heads/badges"'
    ]
    # It refuses to overwrite a good badge when the count can't be read.
    assert 'if [ -z "$count" ]' in text and "exit 1" in text
    assert "badges%2Fdownloads.json" in readme


def test_android_release_builds_require_external_signing_credentials():
    for relative in ("android/app/build.gradle", "android_offline/app/build.gradle"):
        gradle = (ROOT / relative).read_text()
        assert "if (!releaseStoreFile) {" in gradle
        assert "Release build requires RELEASE_STORE_FILE" in gradle
        assert "if (releaseStoreFile) signingConfig signingConfigs.release" in gradle
        for credential in ("RELEASE_STORE_PASSWORD", "RELEASE_KEY_ALIAS", "RELEASE_KEY_PASSWORD"):
            assert credential in gradle
        # A release build must never silently fall back to the debug key. The
        # debug build type may (and does) use the saved project-local key.
        build_types = re.search(r"buildTypes\s*\{(.*?)\n    \}", gradle, re.S).group(1)
        release_block = re.search(r"release\s*\{(.*?)\n        \}", build_types, re.S).group(1)
        assert "signingConfig signingConfigs.debug" not in release_block
        assert "signingConfig signingConfigs.debug" in build_types
        assert "tools/keys/debug.keystore" in gradle


def test_adb_update_preserves_data_and_stops_on_signature_mismatch():
    script = (ROOT / "tools" / "adb_update.py").read_text()

    assert '"install", "-r", str(apk)' in script, "updates must be in-place"
    assert "No authorized device found" in script
    assert "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in script
    assert "the existing app used a different signing key" in script
    # The message is split across literals, so assert its meaningful fragments.
    assert "do not " in script and "uninstall or clear data without explicit permission" in script
    assert '"pm", "clear"' not in script
    assert '"uninstall"' not in script
    # Refusing to guess prevents updating the wrong variant on a shared device.
    assert "Both variants are installed; pass --variant explicitly." in script
    assert "Local versionCode" in script and "is not newer than installed" in script
