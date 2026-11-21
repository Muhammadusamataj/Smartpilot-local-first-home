"""MY Local Devices Tuya integration.

Reads devices from the local add-on over Supervisor's internal network and
exposes them as ordinary Home Assistant switch/sensor entities.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any
from urllib.parse import quote

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .api import ApiError, api_request
from .const import CONF_ADDON_URL, DEFAULT_SCAN_INTERVAL, DOMAIN
from .pure import merge_live_points

_LOGGER = logging.getLogger(__name__)
PLATFORMS = ["switch", "sensor"]


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

    async def _async_update_data(self) -> dict[str, Any]:
        body = await api_request(
            self.hass, self.base_url, "/api/local/devices", entry_data=self.entry_data
        )
        devices = body.get("devices") or []
        if not isinstance(devices, list):
            devices = []

        async def read(device: dict) -> dict:
            if not device.get("reachable") or not device.get("id"):
                return {}
            try:
                return await api_request(
                    self.hass,
                    self.base_url,
                    "/api/local/status?id=" + quote(str(device["id"]), safe=""),
                    entry_data=self.entry_data,
                )
            except ApiError as error:
                _LOGGER.debug("Live read failed for %s: %s", device.get("id"), error)
                return {}

        results = await asyncio.gather(*(read(device) for device in devices))
        for device, result in zip(devices, results):
            values: list[dict] = []
            if result.get("status") == "ok" and isinstance(result.get("values"), list):
                values = [point for point in result["values"] if isinstance(point, dict)]
            device["points"] = merge_live_points(device.get("points") or [], values)
            device["live_values"] = {
                str(point["dp"]): point.get("value")
                for point in values
                if point.get("dp") is not None
            }
        return {"devices": devices}


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
