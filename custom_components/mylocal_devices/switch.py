"""Switch entities for boolean Tuya DPs."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import ApiError, api_request
from .const import DOMAIN
from .pure import as_bool, is_bool_point, point_value, primary_point


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    stored = hass.data[DOMAIN][entry.entry_id]
    coordinator = stored["coordinator"]
    entities: list[MyLocalSwitch] = []
    for device in coordinator.data.get("devices", []):
        points = [p for p in (device.get("points") or []) if isinstance(p, dict)]
        primary = primary_point(points)
        for point in points:
            if not is_bool_point(point):
                continue
            name = str(device.get("name") or device.get("id") or "Device")
            if point is not primary:
                name = f"{name} {point.get('code') or point.get('dp')}"
            entities.append(MyLocalSwitch(coordinator, device, point, name))
    async_add_entities(entities)


class MyLocalSwitch(CoordinatorEntity, SwitchEntity):
    _attr_has_entity_name = False

    def __init__(self, coordinator, device: dict, point: dict, name: str) -> None:
        super().__init__(coordinator)
        self._device_id = str(device.get("id") or "")
        self._dp = str(point.get("dp") or "")
        self._code = str(point.get("code") or self._dp)
        self._attr_name = name
        self._attr_unique_id = f"mylocal_devices_{self._device_id}_{self._dp}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=str(device.get("name") or self._device_id),
            manufacturer="Tuya (local key)",
            model=str(device.get("product_name") or device.get("category") or ""),
        )

    @property
    def available(self) -> bool:
        device = self._device()
        return super().available and bool(device and device.get("reachable"))

    def _device(self) -> dict | None:
        for device in self.coordinator.data.get("devices", []):
            if str(device.get("id")) == self._device_id:
                return device
        return None

    def _point(self) -> dict | None:
        device = self._device()
        for point in (device or {}).get("points") or []:
            if str(point.get("dp")) == self._dp:
                return point
        return None

    @property
    def is_on(self) -> bool:
        device = self._device()
        point = self._point()
        if not device or not point:
            return False
        return bool(as_bool(point_value(device, point)))

    async def _async_set(self, value: bool) -> None:
        try:
            await api_request(
                self.hass,
                self.coordinator.base_url,
                "/api/local/command",
                method="POST",
                payload={"device_id": self._device_id, "dp": self._dp, "value": value},
                entry_data=self.coordinator.entry_data,
            )
        except ApiError:
            self.async_write_ha_state()
            raise
        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._async_set(False)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"dp": self._dp, "code": self._code, "device_id": self._device_id}
