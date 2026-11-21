"""Protocol version support is centralised and future-safe."""

import tuya_versions


def test_all_bundled_versions_are_supported():
    for version in ("3.1", "3.2", "3.3", "3.4", "3.5"):
        assert tuya_versions.is_supported(version)
        assert tuya_versions.is_supported(f" {version} ")


def test_unknown_future_versions_are_rejected():
    assert not tuya_versions.is_supported("3.6")
    assert not tuya_versions.is_supported("")
    assert not tuya_versions.is_supported(None)


def test_scan_and_device22_tables_match_supported_versions():
    assert tuya_versions.SCAN_VERSIONS == ("3.3", "3.4", "3.5")
    assert set(tuya_versions.DEVICE22_VERSIONS) == {"3.3", "3.4", "3.5"}
    assert tuya_versions.V31_VERSION in tuya_versions.TUYA_VERSIONS
