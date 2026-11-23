"""MY Local Devices Tuya integration.

Reads devices from the local add-on over Supervisor's internal network and
exposes them as ordinary Home Assistant switch/sensor entities.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .api import ApiError, api_request
from .const import CONF_ADDON_URL, DEFAULT_SCAN_INTERVAL, DOMAIN
from .pure import merge_live_points, sanitize_diagnostics

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["switch", "sensor"]
# Diagnostics do a TCP probe, a handshake and a DP read; only collect them for
# devices that failed a normal read, and no more often than this.
DIAGNOSTICS_INTERVAL = 300
# Keep one last failure snapshot while the device is still failing, but never
# present an old failure as current if HA can no longer reach the add-on.
DIAGNOSTICS_MAX_AGE = 900


class MyLocalCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    def __init__(self, hass: HomeAssistant, base_url: str, entry_data: dict[str, Any]) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL),
        )
        self.base_url = base_url
        self.entry_data = entry_data
        self._diagnostics_cache: dict[str, tuple[float, dict]] = {}

    async def _async_update_data(self) -> dict[str, Any]:
        body = await api_request(
            self.hass, self.base_url, "/api/local/devices", entry_data=self.entry_data
        )
        devices = body.get("devices") or []
        if not isinstance(devices, list):
            devices = []

        async def read(device: dict) -> tuple[dict, bool]:
            device_id = str(device.get("id") or "")
            if not device_id:
                return {}, False
            if not device.get("reachable"):
                return {}, True
            try:
                result = await api_request(
                    self.hass,
                    self.base_url,
                    "/api/local/status?id=" + quote(device_id, safe=""),
                    entry_data=self.entry_data,
                )
            except ApiError as error:
                _LOGGER.debug("Live read failed for %s: %s", device_id, error)
                return {}, True
            return result, result.get("status") != "ok"

        results = await asyncio.gather(*(read(device) for device in devices))
        for device, (result, failed) in zip(devices, results):
            values: list[dict] = []
            if result.get("status") == "ok" and isinstance(result.get("values"), list):
                values = [point for point in result["values"] if isinstance(point, dict)]
            device["points"] = merge_live_points(device.get("points") or [], values)
            device["live_values"] = {
                str(point["dp"]): point.get("value")
                for point in values
                if point.get("dp") is not None
            }
            device["diagnostics"] = await self._async_diagnostics(device, failed)
        return {"devices": devices}

    async def _async_diagnostics(self, device: dict, failed: bool) -> dict:
        """Read-only failure facts, throttled and sanitised for the sensor."""
        device_id = str(device.get("id") or "")
        cached = self._diagnostics_cache.get(device_id)
        previous = cached[1] if cached else {}
        if not device_id:
            return {}
        if not failed:
            # A healthy read must clear the old failure immediately; otherwise
            # the diagnostics sensor keeps reporting stale failure codes.
            self._diagnostics_cache.pop(device_id, None)
            return {}
        now = time.monotonic()
        if cached and now - cached[0] < DIAGNOSTICS_INTERVAL:
            return previous
        try:
            body = await api_request(
                self.hass,
                self.base_url,
                "/api/local/diagnostics?id=" + quote(device_id, safe=""),
                entry_data=self.entry_data,
            )
        except ApiError as error:
            _LOGGER.debug("Diagnostics unavailable for %s: %s", device_id, error)
            if cached and now - cached[0] >= DIAGNOSTICS_MAX_AGE:
                self._diagnostics_cache.pop(device_id, None)
                return {}
            return previous
        facts = sanitize_diagnostics(body)
        self._diagnostics_cache[device_id] = (time.monotonic(), facts)
        return facts


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    base_url = str(entry.data.get(CONF_ADDON_URL) or "").rstrip("/")
    if not base_url:
        raise ConfigEntryNotReady("Add-on URL is not configured")

    coordinator = MyLocalCoordinator(hass, base_url, dict(entry.data))
    try:
        await coordinator.async_config_entry_first_refresh()
    except ApiError as error:
        raise ConfigEntryNotReady(str(error)) from error

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {
        "coordinator": coordinator,
        "base_url": base_url,
        "entry_data": dict(entry.data),
    }
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded
