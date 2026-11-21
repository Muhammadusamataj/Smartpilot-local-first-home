"""Single source of truth for Tuya LAN protocol versions.

The bundled tinytuya (1.21.1, also the latest release) implements 3.1 through
3.5. There is no 3.6 wire implementation to enable yet; unknown versions are
rejected early instead of reaching the device driver.
"""

from __future__ import annotations

TUYA_VERSIONS = ("3.1", "3.2", "3.3", "3.4", "3.5")
SUPPORTED_VERSIONS = frozenset(TUYA_VERSIONS)

# 3.3/3.4/3.5 are tried in that order by the scanner: a wrong guess fails
# quickly on the newer versions, while 3.5 on an older device is the slow case.
SCAN_VERSIONS = ("3.3", "3.4", "3.5")
V31_VERSION = "3.1"

# tuya-local's display names for a device22 quirk at each version.
DEVICE22_VERSIONS = {"3.3": "3.22", "3.4": "3.42", "3.5": "3.52"}


def normalize(value) -> str:
    """Return a stripped version string, or an empty string."""
    return str(value or "").strip()


def is_supported(value) -> bool:
    """Whether the bundled driver can talk this protocol version."""
    return normalize(value) in SUPPORTED_VERSIONS
