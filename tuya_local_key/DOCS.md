# Tuya Local Key

Retrieve Smart Life / Tuya device local keys using QR-code login. No Tuya IoT developer account or cloud project is needed.

## Usage

1. Start the app and open it from the Home Assistant sidebar. It opens directly on the **Devices** screen.
2. If keys are not loaded yet, open **Settings → Setup / Smart Life login** in the drawer.
3. Enter your Smart Life user code from **Me > Settings > Account and Security > User Code**.
4. In Smart Life, tap **+ > Scan**, scan the QR code, and confirm login. Keys, IPs and protocol versions are then saved automatically.
5. Use the big ON/OFF switch on each device card for daily control. Advanced DPs are under **More controls**.
6. The old login/device-list screen is still available from **Settings → Setup** for export, filters and manual rescans.

**Note:** The device list is cached for 3 days and kept across restarts. Click **Refresh** to fetch the latest list from Tuya.

## Configuration

Set these options on the app's Configuration page:

| Option | Default | Purpose |
|---|---|---|
| `QR_SCHEME` | `smartlife` | Use `tuyaSmart` if QR login fails. |
| `DEVICE_CACHE` | `on` | Keep devices across restarts. Set to `off` to keep the list in memory only. |
| `CHECK_FOR_UPDATES` | `on` | Turn off **Check for updates** to disable all update checks and notifications. |
| `LAN_SUBNET` | _(unset)_ | Prefill Scan network with your IoT subnet. Separate multiple subnets with commas. |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | _(unset)_ | Optional login for direct port access. Set both. |
| `AUTO_SETUP` | `on` | Automatically fetch devices and discover LAN addresses after QR login. |

## Home Assistant entities / automations

This add-on is the web UI. To use the same devices in automations or dashboards, install the optional custom integration included in this repository:

1. Copy `custom_components/mylocal_devices` into `/config/custom_components/`.
2. Restart Home Assistant.
3. Go to **Settings → Devices & Services → Add Integration** and choose **MY Local Devices Tuya**.
4. Leave the fields blank; the add-on URL is detected from Supervisor automatically.

It creates `switch.*` and `sensor.*` entities from the saved devices and talks to the add-on over the internal Supervisor network. See [the integration guide](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/custom-integration.md) for details and an automation example.

## Remote access

Install the **Tailscale** (or WireGuard) add-on in Home Assistant and open this add-on through the Home Assistant sidebar. Ingress + the VPN tunnel give secure remote access without exposing this app on the internet or opening extra router ports.

## Security

Ingress access uses Home Assistant authentication. The direct `8000/tcp` port is disabled by default. If you enable it, set both `AUTH_USERNAME` and `AUTH_PASSWORD`. These credentials apply only to direct access and are **ignored through Home Assistant ingress**.

Login data and cached device keys are stored in `/data`. Treat app backups as sensitive and restrict access to trusted Home Assistant users.

## Documentation

Detailed guides are in the [docs folder](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/tree/main/docs):

- [Device details, local integrations, and Bluetooth](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/usage.md)
- [Network scanning, VLANs, gateways, and scan statuses](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/network-scanning.md)
- [Caching, offline snapshots, and change detection](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/caching-and-changes.md)
- [Configuration and security](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/configuration.md)
- [Troubleshooting](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/troubleshooting.md)
- [Screenshots](https://github.com/Muhammadusamataj/MYlocal-devices-tuya/blob/main/docs/screenshots.md)
