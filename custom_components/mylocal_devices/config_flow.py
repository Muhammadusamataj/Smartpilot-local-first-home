"""Config flow for MY Local Devices Tuya."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.const import CONF_PASSWORD, CONF_USERNAME
from homeassistant.data_entry_flow import FlowResult

from .api import ApiError, api_request, resolve_base_url
from .const import CONF_ADDON_URL, DOMAIN

_LOGGER = logging.getLogger(__name__)


class ConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            base_url = await resolve_base_url(self.hass, user_input.get(CONF_ADDON_URL, ""))
            if not base_url:
                errors["base"] = "addon_not_found"
            else:
                try:
                    await api_request(
                        self.hass,
                        base_url,
                        "/api/local/devices",
                        entry_data=user_input,
                    )
                except ApiError as error:
                    _LOGGER.debug("Validation failed: %s", error)
                    errors["base"] = "cannot_connect"
                else:
                    await self.async_set_unique_id(DOMAIN)
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title="MY Local Devices Tuya",
                        data={
                            CONF_ADDON_URL: base_url,
                            CONF_USERNAME: user_input.get(CONF_USERNAME, ""),
                            CONF_PASSWORD: user_input.get(CONF_PASSWORD, ""),
                        },
                    )

        schema = vol.Schema({
            vol.Optional(CONF_ADDON_URL, description={"suggested_value": ""}): str,
            vol.Optional(CONF_USERNAME): str,
            vol.Optional(CONF_PASSWORD): str,
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
