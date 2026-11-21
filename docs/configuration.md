# Configuration

| Environment variable | Default | Description |
|---|---|---|
| `SESSION_FILE` | `/data/session.json` | Path where the cached login session is stored. |
| `QR_SCHEME` | `smartlife` | QR prefix. Use `tuyaSmart` if scanning or confirmation does not work for your account. |
| `PORT` | `8000` | Port the web UI listens on, in the Docker image and in the Flask development server. |
| `AUTH_USERNAME` | _(unset)_ | Username for optional HTTP Basic Auth. Login is required only when **both** `AUTH_USERNAME` and `AUTH_PASSWORD` are set. Ignored under Home Assistant ingress. |
| `AUTH_PASSWORD` | _(unset)_ | Password for optional HTTP Basic Auth. Ignored under Home Assistant ingress. |
| `ALLOW_NO_AUTH` | _(unset)_ | Explicit opt-in to run without Basic Auth on a non-loopback bind address. Required only when `AUTH_USERNAME`/`AUTH_PASSWORD` are not set and a launcher is told to bind beyond localhost; with `ALLOW_NO_AUTH=1` a warning is printed and the start is allowed. Does not apply to Home Assistant ingress. |
| `INGRESS_ONLY` | _(unset)_ | Safe no-password exception for the Home Assistant add-on. Set to `1`/`true` by the add-on: the Supervisor proxy is the only accepted request source, so a published direct port cannot expose device keys. |
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

Every production server startup now **refuses a non-loopback bind** (for example `0.0.0.0`) when no authentication is configured. The Docker images use the `wsgi:app` entry point, which runs this check before Waitress opens the socket. The desktop EXE and the offline Android entry point call the same guard. Loopback-only starts (including the Android app's default `127.0.0.1` server) are unchanged. If you deliberately need a no-auth LAN bind, set `ALLOW_NO_AUTH=1` to accept the risk; a warning is printed at startup.

On Home Assistant, ingress already authenticates access, so these credentials are **ignored for ingress requests**. The add-on sets `INGRESS_ONLY=true`: startup on the internal network is allowed without a password, but only requests from the Supervisor proxy (`172.30.32.2` with `X-Ingress-Path`) are accepted. Direct requests to a published port receive HTTP 403 unless you also set `AUTH_USERNAME`/`AUTH_PASSWORD`. This is an intentional behavior change: add-on users who relied on unauthenticated direct-port access must now set credentials or use ingress.

The device list is also stored on disk, encrypted. See [Device List Cache](caching-and-changes.md#device-list-cache) for what that does and does not protect.
