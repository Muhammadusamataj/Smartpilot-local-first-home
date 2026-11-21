"""Sensor entities for non-boolean Tuya DPs (power, readings, enums)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .pure import is_bool_point, point_value


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator = hass.data[DOMAIN][entry.entry_id]["coordinator"]
    entities: list[MyLocalSensor] = []
    for device in coordinator.data.get("devices", []):
        for point in (device.get("points") or []):
            if not isinstance(point, dict) or is_bool_point(point):
                continue
            name = f"{device.get('name') or device.get('id') or 'Device'} {point.get('code') or point.get('dp')}"
            entities.append(MyLocalSensor(coordinator, device, point, name))
    async_add_entities(entities)


class MyLocalSensor(CoordinatorEntity, SensorEntity):
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
    def native_value(self):
        device = self._device()
        point = self._point()
        if not device or not point:
            return None
        value = point_value(device, point)
        if isinstance(value, (dict, list)):
            return str(value)
        return value

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"dp": self._dp, "code": self._code, "device_id": self._device_id}
