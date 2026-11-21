"""Async API client for the MY Local Devices Tuya Home Assistant add-on."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import ADDON_API_PORT, ADDON_NAME, ADDON_SLUG
from .pure import find_addon

_LOGGER = logging.getLogger(__name__)


class ApiError(Exception):
    """Raised when the add-on cannot be reached or returns an error."""


async def _supervisor_get(session: aiohttp.ClientSession, token: str, path: str) -> dict | None:
    """Return the `data` object from a successful Supervisor API call."""
    try:
        async with session.get(
            f"http://supervisor{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            if response.status != 200:
                return None
            body = await response.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
        _LOGGER.debug("Supervisor request %s failed: %s", path, error)
        return None
    if not isinstance(body, dict) or body.get("result") != "ok":
        return None
    data = body.get("data")
    return data if isinstance(data, dict) else None


async def supervisor_addon_info(hass: HomeAssistant) -> dict | None:
    """Ask Supervisor where the add-on container lives.

    Home Assistant Core and add-ons share Supervisor's internal network, so
    no host port and no router port-forwarding is needed. Custom add-on
    repositories prefix the slug, so fall back to searching the installed list.
    """
    token = os.environ.get("SUPERVISOR_TOKEN") or os.environ.get("HASSIO_TOKEN")
    if not token:
        return None
    session = async_get_clientsession(hass)

    info = await _supervisor_get(session, token, f"/addons/{ADDON_SLUG}/info")
    if info:
        return info

    listing = await _supervisor_get(session, token, "/addons")
    addons = (listing or {}).get("addons") or []
    installed = find_addon(addons, ADDON_SLUG, ADDON_NAME) if isinstance(addons, list) else None
    if not installed:
        return None
    return await _supervisor_get(session, token, f"/addons/{quote(installed, safe='')}/info")


async def resolve_base_url(hass: HomeAssistant, configured: str = "") -> str:
    """Return the add-on base URL, preferring a user override."""
    if configured:
        return configured.strip().rstrip("/")
    info = await supervisor_addon_info(hass)
    if not info:
        return ""
    host = str(info.get("ip_address") or info.get("hostname") or "").strip()
    if not host:
        return ""
    try:
        port = int(info.get("ingress_port") or info.get("port") or ADDON_API_PORT)
    except (TypeError, ValueError):
        port = ADDON_API_PORT
    return f"http://{host}:{port}"


def _auth(entry_data: dict) -> aiohttp.BasicAuth | None:
    username = str(entry_data.get("username") or "").strip()
    password = str(entry_data.get("password") or "")
    return aiohttp.BasicAuth(username, password) if username and password else None


async def api_request(
    hass: HomeAssistant,
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    entry_data: dict | None = None,
) -> Any:
    """Call one add-on JSON endpoint."""
    session = async_get_clientsession(hass)
    url = f"{base_url.rstrip('/')}{path}"
    auth = _auth(entry_data or {})
    kwargs: dict[str, Any] = {
        "auth": auth,
        "timeout": aiohttp.ClientTimeout(total=15),
    }
    if payload is not None:
        kwargs["json"] = payload
    try:
        async with session.request(method, url, **kwargs) as response:
            body = await response.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as error:
        raise ApiError(f"Cannot reach MY Local Devices add-on: {error}") from error
    if response.status >= 400:
        message = body.get("error") if isinstance(body, dict) else response.reason
        raise ApiError(str(message or f"HTTP {response.status}"))
    if isinstance(body, dict) and body.get("error"):
        raise ApiError(str(body["error"]))
    return body
