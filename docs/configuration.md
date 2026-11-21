# Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_FILE` | `/data/session.json` | Path where the cached login session is stored. |
| `QR_SCHEME` | `smartlife` | QR prefix. Use `tuyaSmart` if scanning or confirmation does not work for your account. |
| `PORT` | `8000` | Port the web UI listens on, in the Docker image and in the Flask development server. |
| `AUTH_USERNAME` | _(unset)_ | Username for optional HTTP Basic Auth. Login is required only when **both** `AUTH_USERNAME` and `AUTH_PASSWORD` are set. Ignored under Home Assistant ingress. |
| `AUTH_PASSWORD` | _(unset)_ | Password for optional HTTP Basic Auth. Ignored under Home Assistant ingress. |
| `ALLOW_NO_AUTH` | _(unset)_ | Explicit opt-in to run without Basic Auth on a non-loopback bind address. Required only when `AUTH_USERNAME`/`AUTH_PASSWORD` are not set and a launcher is told to bind beyond localhost; with `ALLOW_NO_AUTH=1` a warning is printed and the start is allowed. Does not apply to Home Assistant ingress. |
| `DEVICE_CACHE` | `on` | Set to `off` to keep the device list in memory only instead of storing it. See [Device List Cache](caching-and-changes.md#device-list-cache). |
| `DEVICE_CACHE_FILE` | `devices.cache` beside `SESSION_FILE` | Path of the encrypted device-list cache. |
| `DEVICE_CACHE_KEY_FILE` | `cache.key` beside `SESSION_FILE` | Path of the key that decrypts the device-list cache and the scan results. |
| `LAN_CACHE_FILE` | `lan.cache` beside `SESSION_FILE` | Path of the encrypted network scan results. |
| `DEVICE_PREFERENCES_FILE` | `device-preferences.json` beside `SESSION_FILE` | Path of account-specific [device exclusions](caching-and-changes.md#saved-device-exclusions), kept independently of the device cache. |
| `UPDATE_CACHE_FILE` | `update-check.json` beside `SESSION_FILE` | Path of the release-check cache. |
| `CHECK_FOR_UPDATES` | `true` | Set to `false` to disable all update checks and hide update controls. |
| `LAN_SUBNET` | _(unset)_ | Your IoT VLAN or subnet, to prefill the Scan network box, e.g. `192.168.2.0/24`. Several can be comma-separated. See [Protocol Version](network-scanning.md). |
| `AUTO_SETUP` | `on` | After QR login, fetch devices and discover their LAN addresses in the background. Turn off if you prefer to scan manually. |

The Home Assistant add-on opens the **Devices** screen (`/local`) by default. The original login/device-list screen is still available from **Settings → Setup**.

## Remote access

The recommended setup is **Home Assistant ingress + Tailscale**. Install the Tailscale (or WireGuard) add-on in Home Assistant, connect your phone/PC to that tailnet, then open this add-on from the Home Assistant sidebar. Home Assistant handles authentication and Tailscale handles the encrypted tunnel; the app itself does not need to bind to a public port.

Direct Tailscale binding is an opt-in convenience for the Windows EXE (`TuyaLocalKey.exe --tailscale`) and for the offline Android APK. On the APK, open **Remote access** in the compact header, turn on **Direct access over Tailscale**, set a username/password (a random password is generated for you), and tap **Apply**. The panel closes again after applying, and the header pill changes to **Ready · Direct**. The app then binds `0.0.0.0:8000` with Basic Auth; reopen the panel to copy the displayed tailnet URL and credentials, then open `http://<phone-tailscale-ip>:8000/local` from another tailnet device. The built-in WebView keeps using `127.0.0.1` and signs in automatically. The toggle is off by default, so the normal phone setup (localhost only) is unchanged.

This changes only how you reach the app's **UI**. Tuya devices are ordinary IP devices and are not Tailscale peers, so direct control from the phone still requires the phone to be on the devices' Wi-Fi subnet. For remote control without that, keep using the Home Assistant add-on route above.

## Security

By default the web UI has no authentication, so anyone who can reach the port can see device `localKey` values. Set **both** `AUTH_USERNAME` and `AUTH_PASSWORD` to require a login. This is recommended whenever the port is reachable beyond localhost. Basic Auth sends credentials unencrypted over plain HTTP, so keep it on a trusted network or behind a TLS reverse proxy, and do not expose it directly to the internet.

The desktop EXE and the offline Android entry point now **refuse a non-loopback bind** (for example `0.0.0.0`) when no auth is configured, unless `ALLOW_NO_AUTH=1` is set as an explicit opt-in. Both default to localhost (`127.0.0.1`), so the normal out-of-the-box start is unaffected. If you deliberately need a no-auth LAN bind, set `ALLOW_NO_AUTH=1` to accept the risk; a warning is printed at startup. This setting does not change Home Assistant ingress behaviour.

On Home Assistant, ingress already authenticates access, so these credentials are **ignored for ingress requests**. Set them only if you enable the direct port access and want a separate login there.

The device list is also stored on disk, encrypted. See [Device List Cache](caching-and-changes.md#device-list-cache) for what that does and does not protect.

## Haier local devices

Open **Auto-Pilot** on the Home screen and use the ⚙ button on either Haier card. **Scan LAN** uses Haier's key-free UDISCOVERY protocol on UDP port 7083 and fills the IP and Wi-Fi module ID; you still paste the device's 32-hex local key and version. The key is encrypted with the app's own Fernet key and is never returned by a GET endpoint or shown in logs.

The app vendors the HA-free `haismart_hrdp` local protocol library. It recognises many more Haier report layouts than the original two-slot decoder, including compact and extended families, and reports an explicit localKey-rotation error when the appliance announces a newer key version. Unknown layouts are shown as **READ ONLY**; writes still require the previously confirmed 125/127-byte classic layout and the existing allowlist. No Haier cloud login, Home Assistant, or account token is used.

The extended decoder needs Python 3.11+ (Docker and the offline Android build already use 3.12). On Python 3.10 the app automatically falls back to the original classic codec. Broadcast discovery must be able to bind UDP 7083; if your network or another service blocks that port, enter the LAN address manually. Only one local session per appliance is supported, so do not run another Haier integration against the same unit at the same time.
