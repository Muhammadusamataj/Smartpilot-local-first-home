# Hardware validation checklist

Use this checklist when validating a build against **real Tuya devices and real client hardware** (Home Assistant add-on, Docker/PC host, Windows desktop, or Android APK/WebView).

> **Rule: never report success unless you observed the result on the target device.** Leave every Pass / Fail / Notes cell blank until you have actually run the check. Do not infer a PASS from source code, a CI run, or a log line alone. If a check cannot be run, record the reason in **Notes** and leave Pass and Fail blank.

Record the environment for each session so results are reproducible:

| Session detail | Value |
|---|---|
| Date | 2026-11-20 |
| Device model(s) / firmware | V2427 (`product:V2427 model:V2427 device:V2427`); exact firmware not read |
| App version / source or build | Installed offline v2 build after the latest in-place update: `versionCode=6`, `versionName=1.5` (`dist\TuyaLocalKey-Offline.apk`, rebuilt with the sensor-scaling fix). The previous v2 builds were `versionCode=5`, `versionName=1.4` and `versionCode=4`, `versionName=1.3`. An older legacy build (`versionCode=1`, `versionName=1.0`) had been installed earlier but was absent from the device during this session. |
| Client (HA add-on / Docker / desktop / Android) | Android offline APK (embedded Python/Flask + WebView) |
| Host OS and version | Android on V2427; exact OS version not read |
| Android package / version / signing fingerprint (if applicable) | Installed: `com.example.tuyalocalkey.offline.v2.debug`, code 6 / 1.5, SHA-256 `b86148540bdcdd8b90409f1233e41f668be2934738b8c5cfb2be13ac414bb930` (saved project debug keystore; same key as the preceding code 5 / 1.4 and code 4 / 1.3 builds). The older `com.example.tuyalocalkey.offline.debug` code 1 / 1.0 (SHA-256 `42584450ef88ef9ec24b72a1d22caa5e56fb97556ec840e9ed8a781e65f484f5`) was absent during this session. |
| Wi-Fi SSID / band / subnet | App log reported subnet hint `192.168.100.21/24`; SSID/band not read. During the Smart Life check the phone was on `192.168.10.29/24` (wireless ADB), while saved Tuya device IPs were `192.168.100.x/24` — different subnets. |
| Tester | OpenCode automated ADB session, serial `10FF3H02QE0004Y` |

## 1. Prerequisites

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Local keys are present and authorized for the devices under test (QR login or manual add); the tester is authorized to control these devices |  |  |  |
| Each device is paired to a **2.4 GHz** Wi-Fi network (not 5 GHz-only) |  |  |  |
| Devices are LAN-reachable: IP address and gateway are known and ping/scan finds them |  |  |  |
| Phone/PC used for testing is on the **same subnet**; guest Wi-Fi / client isolation is off |  | Fail | Phone was `192.168.10.29/24`, saved device IPs were `192.168.100.x/24`; live local reads from the app returned HTTP 502. This blocked the live side-by-side comparison. |
| If testing Android: USB debugging is on and `adb devices` shows the device as `device` (not `unauthorized` or `offline`) | Pass |  | `10FF3H02QE0004Y device product:V2427 model:V2427 device:V2427 transport_id:7` |
| If testing scenes/schedules: the server host (HA add-on, Docker, or PC) is awake and will stay on |  |  |  |

## 2. Local control checks

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Status labels are truthful: verified **Online** only after a recent successful read; **Address saved** when an IP is known but no reply arrived; **Offline** / stale readings called out |  |  |  |
| A saved IP alone is never shown as live/Online |  |  |  |
| ON command succeeds and **DP readback matches** before the UI reports confirmed success |  |  |  |
| OFF command succeeds and DP readback matches before success is reported |  |  |  |
| A command issued while the same device is busy returns **HTTP 409** and the UI reflects busy |  |  |  |
| A failed local read returns **HTTP 502** and the tile/state does not stay green |  |  |  |
| Sensor / meter readings (temperature, power, energy, etc.) populate and are plausible |  |  |  |
| Stale readings are marked rather than presented as current |  |  |  |
| Failure / offline behavior: with a device powered off or blocked, the UI shows offline/offline-stale and no false success |  |  |  |
| Reconnection after a Wi-Fi change: change SSID or device IP, then confirm the saved LAN profile reconnects silently and status recovers |  |  |  |
| Card layout on the key list renders controls and honest status pills, and links to `/local?device=<id>` |  |  |  |

## 3. Home Assistant ingress checks

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Add-on installs and **starts** without a crash loop; startup logs are clean |  |  |  |
| Ingress load: app opens from the HA sidebar (no direct port/forwarding needed) |  |  |  |
| Relative API paths work behind ingress: `/local`, `/local?device=<id>`, and no trailing-slash breakage |  |  |  |
| Auth/proxy behavior: HA authenticates the session; the app does not prompt for a separate login behind ingress |  |  |  |
| No mixed-content or Origin/CSRF errors are produced by ingress traffic |  |  |  |
| Remote access (e.g. Tailscale/WireGuard) reaches the app through ingress only |  |  |  |

## 4. Android checks

| Check | Pass | Fail | Notes |
|---|---|---|---|
| **Before install:** package name, version, and signing identity/fingerprint match the expected release build | Pass |  | Installed app before the update was `com.example.tuyalocalkey.offline.v2.debug`, code 4 / 1.3, signed with SHA-256 `b8614854…4bb930` (saved project debug keystore). The code 5 / 1.4 APK was verified locally as the same package and the same SHA-256 `b8614854…4bb930`, so the in-place update used an identical signing identity. (This is a debug build / identity — a release-signed build remains blocked on credentials.) |
| Install via `tools/adb_update.py` (or `adb install -r`); the update uses **-r** and app data/config is preserved | Pass |  | Ran `adb -s 10FF3H02QE0004Y install -r dist\TuyaLocalKey-Offline.apk` → `Success` for the code 4 / 1.3 build (fresh package), then again → `Success` for the code 5 / 1.4 in-place update. For the in-place update, all nine captured MD5 hashes were unchanged before/after: `session.json` `5a77ce8b…`, `cache.key` `69b18984…`, `devices.cache` `02635173…`, `lan.cache` `db07a983…`, `lan-profile.json` `53b723f8…`, `local-preferences.json` `f402c2c6…`, `update-check.json` `8d04818e…`, `WebViewChromiumPrefs.xml` `bd3dcd02…`, `chaquopy.xml` `64e15e7d…`. |
| No uninstall and no `pm clear` / clear-data was performed | Pass |  | No `uninstall` or `pm clear` command was run. |
| App launches after install and opens to the expected screen | Pass |  | `am start` succeeded; `dumpsys activity activities` showed `topResumedActivity=com.example.tuyalocalkey.offline.v2.debug/...OfflineActivity`; PID `10129` was alive. `wm_on_create/start/resume` and `viewroot_draw_event` (mAppVisible=true) appeared in logcat. |
| Logcat (filtered) shows no crashes, permission errors, or WebView/network errors | Pass |  | No `FATAL EXCEPTION`, `AndroidRuntime` crash, or `Traceback` in logcat after launch. Only generic Vivo `auditd { ioctl } /proc/fas/render` SELinux warnings for the app PID appeared (not app errors). An earlier session also logged `TuyaOffline: Starting embedded Python server`. |
| Embedded server responds after the update (functional check) | Pass |  | `netstat` showed `127.0.0.1:8000` LISTEN with established connections. `adb forward tcp:18000 tcp:8000` then `GET http://127.0.0.1:18000/api/state` returned HTTP 200 `{"logged_in":true}`, confirming both the server and the preserved session. |
| Sensor-scaling build (code 6 / 1.5) installs in place without losing data | Pass |  | `adb -s 192.168.10.29:42827 install -r dist\TuyaLocalKey-Offline.apk` → `Success`; `dumpsys package` reports `versionCode=6`, `versionName=1.5`. The APK's signer SHA-256 `b8614854…4bb930` matches the previously installed identity. MD5 hashes before/after were identical for `session.json`, `cache.key`, `devices.cache`, `lan.cache`, `local-preferences.json`, `update-check.json`, `WebViewChromiumPrefs.xml` and `chaquopy.xml`. `lan-profile.json` changed only in runtime fields (`checked_at`, `fail_count`, `last_failed`); all five device records, IPs, subnets, versions and `last_ok` values were preserved. No uninstall / clear-data. |
| Sensor-scaling build launches and serves the updated schema | Pass |  | PID `30910` alive, `topResumedActivity=com.example.tuyalocalkey.offline.v2.debug/...OfflineActivity`, `127.0.0.1:8000` LISTEN, `GET /api/state` over `adb forward tcp:18000 tcp:8000` → HTTP 200 `{"logged_in":true}`, and `/api/local/devices` returns the Water Tank `forward_energy_total` point with `scale=2`, `unit="kWh"`. Logcat shows `TuyaOffline: Starting embedded Python server`; no crash markers. |
| WebView loads only the configured origin; offline APK stays on the embedded localhost origin |  |  | Not directly observed on device; source-level restriction only. |
| No mixed content or file/content access is allowed in the WebView |  |  | Not directly observed on device; source-level restriction only. |
| **Signature mismatch:** if Android reports a signing mismatch, STOP and investigate — do not force-install or bypass the check | Pass |  | A real mismatch was observed between installed v1.0 (`42584450…ef484f5`) and the first rebuilt APK (`f1fceabc…53eff0b`). Install was stopped; no force-install, uninstall or clear-data was attempted. Resolution was a new saved key plus a separate package, not a bypass. |

## 5. Schedule checks

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Server-side scene/schedule fires correctly while the host (HA add-on / Docker / PC) is **awake** and the app server is running |  |  |  |
| No scene/schedule fires while the host is asleep or the app server is stopped (documented expected behavior) |  |  |  |
| App is closed on the phone / WebView is not running, yet host-side schedules still behave per host state |  |  |  |
| **Do not claim phone-closed WebView timers are reliable**; any such behavior is unverified and must not be reported as working |  |  |  |

## 6. Security checks

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Local keys are masked in lists, cards, and `/local` UI |  |  |  |
| No secrets (keys, passwords, tokens) appear in logs or diagnostics output |  |  |  |
| Release APK is signed with the supplied **release** credentials, not the public Android debug key |  |  |  |
| State-changing API calls reject cross-origin `Origin` headers when Basic Auth is enabled |  |  |  |
| Any portable build artifact / diagnostics bundle contains no plaintext credentials |  |  |  |

## 7. Launch binding safety

All rows below are **pending/unverified**; no desktop-EXE or Android on-device results are claimed here. Leave Pass and Fail blank until the check is observed on the target.

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Windows desktop EXE: with no auth configured, a non-loopback start (e.g. `--host 0.0.0.0`) is refused before the server starts |  |  |  |
| Windows desktop EXE: loopback start (`127.0.0.1`) works without auth |  |  |  |
| Windows desktop EXE: explicit `ALLOW_NO_AUTH=1` allows the non-loopback start and prints a warning |  |  |  |
| Android offline APK: with no auth configured, a non-loopback bind is refused before the server starts |  |  |  |
| Android offline APK: loopback (`127.0.0.1`) start works without auth |  |  |  |
| Android offline APK: explicit `ALLOW_NO_AUTH=1` allows the non-loopback start and prints a warning |  |  |  |

## 8. Sensor scaling / Smart Life reference readings

These rows record an **observed comparison of reference values**, not a validated live local read. The Smart Life screen was opened on the phone and its numbers were extracted with Windows OCR because they are drawn in a React Native canvas (absent from `uiautomator` XML). The app's values came from its own preserved encrypted cache (written 10:04), decrypted locally without printing any key. No device was toggled.

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Smart Life APK contains reusable DP code / scaling tables |  | Fail | `SmartLife_7.12.6.apk` (157 MB, `com.tuya.smartlife`) and `Haismart_5.8.0.apk` contain no `cur_power` / `cur_current` / `cur_voltage` / `add_ele` strings; their schemas come from the cloud. No APK code was copied. |
| Device's cached cloud spec supplies DP scale and unit | Pass |  | `Water Tank` (`category: dlq`, `product_name: Breaker`) has `forward_energy_total` with `values` = `{"unit":"kW·h",...,"scale":2,"step":1}` and `phase_a` as a Raw DP. |
| Energy reading scale confirmed against Smart Life | Pass |  | App cache: `forward_energy_total = 12150`, `scale = 2` → `121.50 kWh`. Smart Life at 14:44 showed `Total forward energy(kWh) = 121.69`. The 0.19 kWh difference is consistent with ~4 hours of accumulation between the two samples. |
| Voltage reading scale corroborated | Pass |  | Cached `phase_a = CasAAAAAAAA=` decodes to bytes `09ab000000000000` → `247.5 V` using the 0.1 V divisor; Smart Life showed `Voltage (V) = 260.9` at 14:44. Mains variation over the interval is plausible, but an exact simultaneous match was not captured. |
| Current / power divisors confirmed with the device **ON** |  |  | Device was `Off` during the check: Smart Life showed `Current (A) = 0.000` and `Active Power (kW) = 0.000`, and the cached `phase_a` words after voltage are all zero. 0 A / 0 W cannot distinguish ÷1000 A / ÷10 W from other divisors — live ON comparison still required. |
| Live app read matches Smart Life (same instant) |  |  | Blocked by network topology: phone `192.168.10.29/24` vs saved device IPs `192.168.100.x/24`; `/api/local/status?id=…` returned HTTP 502. No live comparison is claimed. |
| Live-device retry (2026-11-20): reachability confirmed unreachable |  | Fail | Reconnected wireless ADB at `192.168.10.29:41049`; phone `wlan0 = 192.168.10.29/24`, kernel route to `192.168.100.5` goes via gateway `192.168.10.1` but `ping -c 2 192.168.100.5` = 100% loss and `nc -z -w 2 192.168.100.12 6668` timed out. From the PC, `Test-NetConnection 192.168.100.5` = False. No route exists to the device subnet from either host. Saved networks on both phone and PC include `Manticore 2.4Ghz` (the network associated with the earlier `192.168.100.21/24` hint); switching to it requires the Wi-Fi passphrase/manual step. During the attempt the phone's DHCP address changed to `192.168.10.11` and wireless ADB stopped advertising, so on-device work is now blocked until Wireless debugging is re-enabled or USB is connected. No device was toggled. |
| No device was toggled during this check | Pass |  | Only Smart Life was launched and screens were read; no ON/OFF command was sent. |

## 9. Live local reads on the device subnet (2026-11-20)

PC joined `Manticore 2.4Ghz`: `Wi-Fi = 192.168.100.34/24`. `ping 192.168.100.5` → 0% packet loss; TCP `192.168.100.5:6668` → open. A Flask server was started from **copies** of the preserved encrypted cache (`AUTO_SETUP=off`, `CHECK_FOR_UPDATES=off`, port 8001); `GET /api/state` → `{"logged_in":true}` and `/api/local/devices` listed all five known devices. The five saved IPs observed earlier on the phone were written into `lan-profile.json` (IP/version only, no keys), and `/api/local/status` then performed genuine TinyTuya reads.

| Device | Saved IP | Live read | Key observed values (raw → displayed) |
|---|---|---|---|
| Water Tank | `192.168.100.5` | `status=ok`, `verified=true`, fresh `read_at` | `forward_energy_total 12173`, `scale=2`, `unit=kWh` → **121.73 kWh**; `switch=false`; `phase_a` absent in this reply |
| Bore Motor | `192.168.100.12` | `status=ok`, `verified=true` | `cur_voltage 2396` (`scale=1`, V) → **239.6 V**; `cur_current 0` (`scale=0`, mA); `cur_power 0` (`scale=1`, W); `switch_1=false` |
| First Floor Breaker | `192.168.100.7` | `status=ok`, `verified=true` | `forward_energy_total 256248` → **2562.48 kWh**; `balance_energy 22334` → **223.34 kWh**; `switch=true` |
| Ground Floor | `192.168.100.9` | `status=ok`, `verified=true` | `forward_energy_total 319580` → **3195.80 kWh**; `switch=true` |
| Geyser | `192.168.100.25` | `status=ok`, `verified=true` | `cur_voltage 2368` → **236.8 V**; `cur_current 0` mA; `cur_power 0` W; `switch_1=false` |

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Real LAN read succeeds for all five devices from a host on the device subnet | Pass |  | `/api/local/status?id=…` returned `status:"ok"`, `verified:true`, fresh `read_at`; no cloud call. |
| Device schema confirms energy scale/unit | Pass |  | `scale=2`, `unit=kWh` returned live with each energy DP; earlier Smart Life OCR `121.69 kWh` (14:44) vs live `121.73 kWh` (~19:05) is a small plausible increase, but not simultaneous. |
| Device schema confirms voltage/power/current conversion | Pass |  | `cur_voltage scale=1 unit=V`, `cur_power scale=1 unit=W`, `cur_current scale=0 unit=mA` (1000 mA = 1 A). These come from the device's own live schema, not Smart Life. |
| Current/power confirmed with a nonzero ON load |  |  | Devices with `cur_*` DPs were Off (`0 mA`, `0 W`), so the divisors are schema-confirmed but not load-confirmed. No device was toggled. |
| Packed `phase_a` decoded from a live reply |  |  | Water Tank's live reply did not include `phase_a` while Off; decoding remains validated from the cached `CasAAAAAAAA=` sample only. |
| Same-instant Smart Life screen comparison |  |  | Phone appeared at `192.168.100.21:38947` with mDNS + TCP port open and ping OK, but `adb connect` failed (`failed to connect`) even after restarting the ADB server. No new Smart Life capture; requires ADB re-pairing or a manual reading. |

## 10. Same-instant Smart Life comparison + safety incident (2026-11-20)

Phone reconnected over **USB debugging** (`10FF3H02QE0004Y`), IP `192.168.100.21/24`, `ping 192.168.100.5` 0% loss. Installed app code 6 / 1.5, `GET /api/state` → `{"logged_in":true}` over `adb forward tcp:18000 tcp:8000`.

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Same-instant energy reading matches Smart Life | Pass |  | At 20:42, Smart Life OCR (Water Tank detail) = `121.82 kWh`; direct read-only TinyTuya status `dp1=12182`, `scale=2`, `unit=kWh` → `121.82 kWh`. Exact match. |
| Current / power values match while device is Off | Pass |  | Smart Life `Current 0.000 A`, `Active Power 0.000 kW`, `Device Off`; live local DP `switch=false` and no nonzero current/power reported. Agreement at zero only — nonzero load still untested. |
| Voltage reference agrees with cached packed telemetry |  |  | Smart Life showed `239.7 V` at 20:42; cached `phase_a` sample decoded to `247.5 V`, but that sample was hours old and `phase_a` was absent from the live reply. No simultaneous packed-voltage comparison claimed. |
| No unintended device state changes during navigation |  | Fail | A coordinate tap meant to open Bore Motor details hit its `switch_1` tile and turned the device ON (`dp1=true`, 20:43). Detected by read-only status, reverted with `set_value(1, False)`, readback `False`. Final sweep: Bore Motor Off, Water Tank Off, First Floor Breaker On, Ground Floor On, Geyser Off — all original states restored. Screen timeout restored from temporary `600000` to original `30000` ms. No other toggles occurred. |
| Current/power divisors confirmed under nonzero ON load |  |  | Still pending; the Off-state agreement above does not prove the divisors under load. |

## 11. v7 / 1.6 amp-normalised-current build install (2026-11-20)

Installed over **USB debugging** (`10FF3H02QE0004Y`) with `adb install -r` → `Success`. Both APKs rebuilt with the unchanged project debug key; offline signer SHA-256 still `b86148540bdcdd8b90409f1233e41f668be2934738b8c5cfb2be13ac414bb930`. This build carries the `cur_current` mA→A display fix.

| Check | Pass | Fail | Notes |
|---|---|---|---|
| In-place update preserves app data | Pass |  | `dumpsys package` code 6/1.5 → 7/1.6. All nine preserved file MD5s identical before/after (session.json, cache.key, devices.cache, lan.cache, lan-profile.json, local-preferences.json, update-check.json, WebViewChromiumPrefs.xml, chaquopy.xml). No uninstall/clear-data. |
| Embedded server starts after update | Pass |  | Fresh launch → `127.0.0.1:8000` LISTEN, `GET /api/state` over `adb forward` → HTTP 200 `{"logged_in":true}`. An earlier attempt showed no LISTEN; a force-stop + relaunch resolved it — startup timing artifact, not a code defect. |
| Live read works on updated build | Pass |  | `/api/local/status?id=bfccb1925a4b0b269dfph5` → `status=ok`, `verified=true`, fresh `read_at`; `forward_energy_total=12182`, `scale=2`, `unit=kWh` → `121.82 kWh`, matching the same-instant Smart Life reading. Water Tank switch still `False` (no toggle). |
| mA→A normalization present on-device | Pass |  | Served `static/js/features/local-control/api.js` (HTTP 200) contains `isAmpNormalisedCurrent`; browser test asserts `cur_current=1500 mA` renders `1.500 A` while `leakage_current` stays mA. |
| Nonzero ON-load current/power comparison |  |  | Still pending — requires explicit DP-level approval before toggling any device. |

## 12. Production release signing (2026-11-20)

| Check | Pass | Fail | Notes |
|---|---|---|---|
| Release key is not the public debug key | Pass |  | Fresh RSA-2048 key outside repo, random alias/password, user-only ACL. Release signer SHA-256 `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` ≠ debug `b8614854…4bb930`. |
| Both release variants build and verify | Pass |  | `assembleRelease` for both Gradle projects → `dist\TuyaLocalKey-Offline-release.apk` (`com.example.tuyalocalkey.offline.v2`) and `dist\TuyaLocalKey-release.apk` (`com.example.tuyalocalkey`), code 7 / 1.6. `apksigner verify --print-certs` shows the production signer on both. |
| Release can be installed without touching debug data | Pass |  | Release package IDs omit `.debug`, so they are distinct packages from the installed debug builds. (Not installed on-device in this session; identity verified from APK metadata.) |
| Keystore backed up by user |  |  | Credentials saved in `C:\Users\abc\.tuya-local-key-release\` with a documented reload command, but the user must still copy keystore + `credentials.txt` into a password manager/offline backup. Until then this row is open. |

## Results and sign-off

Only tick Pass for a row when you personally observed the expected result on the hardware listed in the session details. Tick Fail for a reproducible unexpected result and describe it in Notes. Leave both blank if not tested. A checklist is **not complete** while any applicable row is blank.

| Overall | Value |
|---|---|
| All applicable checks observed and recorded |  |
| Blocking issues found (describe in Notes above) |  |
| Verified by / date |  |
