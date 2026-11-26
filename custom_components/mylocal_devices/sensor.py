"""Sensor entities for non-boolean Tuya DPs (power, readings, enums)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.const import (
    UnitOfElectricCurrent,
    UnitOfElectricPotential,
    UnitOfPower,
)
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .pure import (
    ATTR_CURRENT,
    ATTR_POWER,
    ATTR_VOLTAGE,
    decode_base64_dp,
    is_bool_point,
    is_phase_code,
    point_value,
)

_PHASE_UNITS = {
    ATTR_CURRENT: UnitOfElectricCurrent.AMPERE,
    ATTR_VOLTAGE: UnitOfElectricPotential.VOLT,
    ATTR_POWER: UnitOfPower.KILO_WATT,
}


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
            if is_phase_code(point):
                # The raw packed DP is not meaningful on its own; expose only
                # the three decoded measurements, with honest native units.
                for metric in (ATTR_VOLTAGE, ATTR_CURRENT, ATTR_POWER):
                    entities.append(
                        MyLocalPhaseSensor(coordinator, device, point, name, metric)
                    )
                continue
            entities.append(MyLocalSensor(coordinator, device, point, name))
        entities.append(MyLocalDiagnosticsSensor(coordinator, device))
    async_add_entities(entities)


class MyLocalSensor(CoordinatorEntity, SensorEntity):
    _attr_has_entity_name = False

    def __init__(self, coordinator, device: dict, point: dict, name: str) -> None:
        super().__init__(coordinator)
        self._device_id = str(device.get("id") or "")
        self._dp = str(point.get("dp") or "")
        self._code = str(point.get("code") or self._dp)
        self._attr_name = name
        raw_scale = point.get("scale")
        self._scale = raw_scale if isinstance(raw_scale, int) and 0 <= raw_scale <= 6 else 0
        unit = str(point.get("unit") or "")
        if unit:
            self._attr_native_unit_of_measurement = unit
        device_class = {"W": SensorDeviceClass.POWER, "V": SensorDeviceClass.VOLTAGE,
                        "A": SensorDeviceClass.CURRENT}.get(unit)
        if device_class and self._scale:
            self._attr_device_class = device_class
            self._attr_state_class = SensorStateClass.MEASUREMENT
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
        if self._scale and isinstance(value, (int, float)) and not isinstance(value, bool):
            return round(value / 10 ** self._scale, 6)
        return value

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"dp": self._dp, "code": self._code, "device_id": self._device_id}


class MyLocalPhaseSensor(CoordinatorEntity, SensorEntity):
    """One decoded measurement from Tuya's packed phase DP."""

    _attr_has_entity_name = False
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator, device: dict, point: dict, name: str, metric: str) -> None:
        super().__init__(coordinator)
        self._device_id = str(device.get("id") or "")
        self._dp = str(point.get("dp") or "")
        self._metric = metric
        self._attr_name = f"{name} {metric.capitalize()}"
        self._attr_unique_id = f"mylocal_devices_{self._device_id}_{self._dp}_{metric}"
        self._attr_device_class = SensorDeviceClass(metric)
        self._attr_native_unit_of_measurement = _PHASE_UNITS[metric]
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=str(device.get("name") or self._device_id),
            manufacturer="Tuya (local key)",
            model=str(device.get("product_name") or device.get("category") or ""),
        )

    def _device(self) -> dict | None:
        for device in self.coordinator.data.get("devices", []):
            if str(device.get("id")) == self._device_id:
                return device
        return None

    def _point(self) -> dict | None:
        for point in ((self._device() or {}).get("points") or []):
            if str(point.get("dp")) == self._dp:
                return point
        return None

    @property
    def available(self) -> bool:
        device = self._device()
        return super().available and bool(device and device.get("reachable"))

    @property
    def native_value(self):
        device = self._device()
        point = self._point()
        if not device or not point:
            return None
        return decode_base64_dp(point_value(device, point)).get(self._metric)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"dp": self._dp, "device_id": self._device_id, "source": "decoded phase DP"}


class MyLocalDiagnosticsSensor(CoordinatorEntity, SensorEntity):
    """Read-only LAN reachability facts for one device.

    The add-on already sanitises these values; the coordinator applies a second
    allowlist. No key, token, DP value or raw exception is ever exposed.
    """

    _attr_has_entity_name = False
    _attr_icon = "mdi:lan-connect"

    def __init__(self, coordinator, device: dict) -> None:
        super().__init__(coordinator)
        self._device_id = str(device.get("id") or "")
        self._attr_name = f"{device.get('name') or self._device_id} LAN diagnostics"
        self._attr_unique_id = f"mylocal_devices_{self._device_id}_diagnostics"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=str(device.get("name") or self._device_id),
            manufacturer="Tuya (local key)",
            model=str(device.get("product_name") or device.get("category") or ""),
        )

    def _device(self) -> dict | None:
        for device in self.coordinator.data.get("devices", []):
            if str(device.get("id")) == self._device_id:
                return device
        return None

    def _facts(self) -> dict:
        facts = (self._device() or {}).get("diagnostics")
        return facts if isinstance(facts, dict) else {}

    @property
    def native_value(self):
        return self._facts().get("confidence") or "not_collected"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return dict(self._facts())
