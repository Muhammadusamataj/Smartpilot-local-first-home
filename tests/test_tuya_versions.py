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


def test_auto_is_distinct_from_a_concrete_version():
    assert tuya_versions.is_auto("auto")
    assert tuya_versions.is_auto(" AUTO ")
    assert not tuya_versions.is_auto("3.4")
    assert not tuya_versions.is_auto("")
    assert not tuya_versions.is_supported(tuya_versions.AUTO_VERSION)
    # Auto detection covers every version the bundled driver can actually talk.
    assert set(tuya_versions.AUTO_DETECT_VERSIONS) == set(tuya_versions.TUYA_VERSIONS)
    assert tuya_versions.AUTO_DETECT_VERSIONS[:3] == tuya_versions.SCAN_VERSIONS
