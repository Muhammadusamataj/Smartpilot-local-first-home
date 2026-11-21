## v0.6 (2026-11-21) — Tuya usability and reliability hotfix

- Single-click switch control with clearly visible double-tap confirmation for risky loads
- Visible pending/confirmed/unconfirmed states; never automatically repeat writes
- Short status-lock wait for interactive commands; read-only confirmation retry
- Stale or disconnected device controls fail safely rather than guessing ON/OFF
- Mobile/WebView scrolling optimization and static-file cache behavior
- No new duplicate Home cards or changes to Haier/Tuya local-key storage

# Changelog

## Unreleased

### Smart Pilot Unified v0.5 beta
- Kept Home limited to two Haier AC summaries and one Tuya summary per device, with targeted navigation to the selected AC.
- Suppressed stale Haier readings; unreported Eco/Sleep/Quiet/Strong states render disabled controls rather than guessed toggles.
- Failed explicit Haier refresh invalidates stale control permission.
- Made debug signing compatible with a missing project-local keystore, using the machine-local Gradle debug key only for debug builds.
- Updated Android source version codes; APK compilation/hardware tests still pending.


### Offline Android app
- Added an opt-in **Direct access over Tailscale** toggle with generated Basic Auth credentials. When enabled, the embedded server binds `0.0.0.0:8000` instead of loopback and displays the tailnet URL; the default localhost-only behaviour is unchanged. (Pending hardware verification.)
- Added a wrong-subnet warning and scan/auto-reconnect skip when the phone's Wi-Fi subnet does not match the saved device addresses. (Pending hardware verification.)

This section collects the current in-flight work; finer detail for the earlier part of this release is in the existing **1.1 — Premium local-first update (unreleased)** section below. Everything recorded here is a code, CI, or documentation change — real-device validation is **pending** and tracked in [docs/HARDWARE_CHECKLIST.md](docs/HARDWARE_CHECKLIST.md). No on-device test results are claimed.

### Premium local dashboard
- Added a `/local` dashboard with **Home / Devices / Scenes / Advanced** views, favorites, and homes/rooms; the key list also gained a card layout option. (Pending hardware verification.)
- LAN status is honest: verified **Online** is separated from **Address saved** and **Offline**/stale; saved IPs are not presented as live. (Pending real-device verification.)
- Status and command requests are serialized per device (HTTP 409 when busy), and commands require DP readback before success is reported; failed reads return HTTP 502. (Pending real-device verification.)
- Controls are capability-aware, rendering only the DPs a device supports. (Pending real-device verification.)

### Scenes and schedules
- Added server-side scenes and schedules. They run only while the Home Assistant add-on / Docker / PC host is awake and the app server is running; WebView timers with the phone closed are not reliable. (Pending real-device verification.)

### Home Assistant / ingress
- HA ingress is supported for remote access without router port forwarding; API calls use relative paths and CSRF origin checks do not block ingress traffic. (Pending in-HA verification.)

### Android / WebView / security
- WebViews restrict navigation to the configured origin (offline APK: embedded localhost only), block mixed content and file/content access, and guard the QR-save bridge by the current origin.
- State-changing API calls reject cross-origin `Origin` headers when Basic Auth is enabled.
- Release Gradle builds require externally supplied signing credentials; the public Android debug key is not used for release.
- Added `tools/adb_update.py` for variant-detecting `adb install -r` updates with launch and filtered logcat. Its data-preserving / signature-mismatch refusal behavior is now covered by unit tests and was observed on device (see below).
- Desktop and Android launchers now call `check_no_auth_binding(host)` immediately before setup and `serve(...)`, refusing non-loopback binds without auth unless `ALLOW_NO_AUTH=1`. (Pending real-device/EXE verification.)

### Build / CI / documentation
- Source-sync CI verifies that the add-on and offline-APK source mirrors stay in sync.
- Added [docs/HARDWARE_CHECKLIST.md](docs/HARDWARE_CHECKLIST.md) with blank result tables for real-device testing; all applicable rows remain unverified.
- Both `android/app/build.gradle` and `android_offline/app/build.gradle` were bumped to `versionCode` 5 / `versionName` 1.4 at this stage (later builds reached code 7 / 1.6 — see the install sections below). The offline debug build installs as `com.example.tuyalocalkey.offline.v2.debug`; the rebuilt 5 / 1.4 APK was installed in place and verified on-device. The legacy `com.example.tuyalocalkey.offline.debug` package was observed absent on the device during this session; no uninstall was performed by this work.
- Full verification after the scaling change: non-UI suite `624 passed, 14 skipped`; complete browser suite `392 passed in 890.12s` (the new scaled-reading test included); packaging + local-control subset `48 passed`; `py_compile OK`; all 32 JavaScript files pass `node --check`.
- Removed the unreferenced pre-modular `static/js/features/local-control.js` after confirming no template, script, build file, or test loads it; source mirrors and both debug APKs were rebuilt from the cleaned source.
- Browser tests now use a current LAN check time for freshness assertions and assert the intentionally hidden wordmark / visible home icon at 390px instead of clicking a hidden element.
- Added regression tests that keep release builds dependent on external signing credentials and keep the ADB updater data-preserving / signature-mismatch-safe.
- Saved a stable project debug keystore at `tools/keys/debug.keystore` and wired both debug build types to it, so regeneration or deletion of `~/.android/debug.keystore` can no longer change debug APK identity.
- Fixed two overlapping-refresh flakes found in the full test suite: background auto-setup is now disabled under Flask `TESTING` (so it cannot race an explicit scan), and a device-list cache is only reused when written strictly after the request began, not at an equal timestamp.
- On-device ADB session (serial `10FF3H02QE0004Y`, V2427): observed a real signature mismatch and stopped before installing the incompatible same-package build; generated the saved key, built a separate offline package, and installed `versionCode` 4 / `versionName` 1.3 with `adb install -r`. After reconnecting, installed the rebuilt `versionCode` 5 / `versionName` 1.4 in place with `adb install -r` → `Success`; verified the new version, identical MD5 hashes for all nine session/cache/preference files before and after, PID `10129` alive with the correct top activity, the embedded server listening on `127.0.0.1:8000`, and an end-to-end `GET /api/state` over `adb forward` returning HTTP 200 `{"logged_in":true}` (the saved session survived the update). No crash, `FATAL EXCEPTION`, or `Traceback` was seen; only generic Vivo `auditd ioctl` warnings. No uninstall or clear-data was performed. Details and remaining blank rows are in [docs/HARDWARE_CHECKLIST.md](docs/HARDWARE_CHECKLIST.md).

### Sensor scaling / Smart Life comparison
- Smart Life 7.12.6 (`com.tuya.smartlife`) and Haismart 5.8.0 APKs were inspected: neither contains DP codes such as `cur_power` / `cur_current` / `add_ele`; their schemas are fetched from the Tuya cloud. An APK therefore cannot supply live readings or a sensor list — it was not used as a code source.
- The device's own cached cloud spec already contains what is needed: every integer DP carries `scale`, `unit`, `min`, `max`, and `step` in its `values` JSON. `_range()` now parses `scale` and a whitelisted `unit`, and the local-control formatter divides raw values by `10**scale` before displaying them (for example `12150` with `scale: 2` → `121.50 kWh`).
- Packed `phase_a` breaker telemetry (base64) is decoded into labelled voltage / current / active-power readings instead of showing raw base64. The voltage divisor (0.1 V) is corroborated by the cached schema and the live Smart Life picture; current (0.001 A) and power (0.1 W) follow Tuya's standard layout and still need a live ON comparison.
- Added a browser regression test (`test_local_scaled_and_packed_readings_render_with_real_units`) that asserts the `/local` card renders `121.50 kWh`, `247.5 V`, `0.000 A` and `0.0 W` from a scaled integer DP plus a packed `phase_a` value, with no raw base64 leaking into Advanced values. All six premium `/local` browser tests pass after the change.
- Verification done on the connected Vivo device over wireless ADB (`192.168.10.29:42827`): Smart Life was launched and its Water Tank panel read with Windows OCR (numbers are drawn in a React Native canvas, so they do not appear in `uiautomator` XML). Observed while the device was **Off**: `Current 0.000 A`, `Active Power 0.000 kW`, `Voltage 260.9 V`, `Total forward energy 121.69 kWh`. The app's own cache (written 10:04) held `forward_energy_total = 12150` with `scale: 2` → `121.50 kWh` and `phase_a = CasAAAAAAAA=` → `247.5 V / 0 A / 0 W`; the small differences are consistent with readings taken about four hours apart. No device was toggled.
- Live local reads from the app still fail on this phone: the phone is on `192.168.10.0/24` while the saved Tuya device IPs are on `192.168.100.0/24`, so `/api/local/status` returns 502. This is network topology, not a code defect; no live readback comparison is claimed.

### Installed build with the scaling fix
- Bumped both APK variants to `versionCode` 6 / `versionName` 1.5 and rebuilt both `dist\TuyaLocalKey-Offline.apk` (`com.example.tuyalocalkey.offline.v2.debug`) and `dist\TuyaLocalKey.apk` (`com.example.tuyalocalkey.debug`) with the saved project debug key (offline signer SHA-256 `b86148540bdcdd8b90409f1233e41f668be2934738b8c5cfb2be13ac414bb930`, unchanged from the code 5 build).
- Installed in place on the connected Vivo over wireless ADB (`192.168.10.29:42827`) with `adb install -r` → `Success`; `dumpsys package` now reports code 6 / 1.5. Before/after MD5 hashes were identical for 8 of the 9 preserved files; `lan-profile.json` changed only in runtime fields (`checked_at`, `fail_count`, `last_failed`) while all five device entries, IPs, subnets, versions and `last_ok` values were retained. No uninstall or clear-data was performed.
- Relaunched the app: PID `30910` alive, `topResumedActivity=com.example.tuyalocalkey.offline.v2.debug/...OfflineActivity`, `127.0.0.1:8000` LISTEN, `GET /api/state` over `adb forward` → HTTP 200 `{"logged_in":true}`, and `/api/local/devices` now returns the Water Tank energy point with `scale: 2` and `unit: "kWh"`. Logcat shows `TuyaOffline: Starting embedded Python server` and no crash markers.

### Live local reads confirmed on real devices (2026-11-20)
- Switched the PC to the Tuya device network (`Manticore 2.4Ghz`): `Wi-Fi = 192.168.100.34/24`, route to `192.168.100.5` via the same interface, `ping 192.168.100.5` 0% loss, and TCP `192.168.100.5:6668` open. A Flask app started from the preserved encrypted cache copies (`SESSION_FILE`/`DEVICE_CACHE_*` pointing at the copied `~/.config/tuya-smartlife` data, `AUTO_SETUP=off`, port 8001) reported `GET /api/state` → `{"logged_in":true}` and five devices.
- Restored the five previously observed LAN addresses from the phone's `lan-profile.json` (IPs only, no keys) into the app's profile file and performed **real local reads**. All five devices answered with `status: "ok"`, `verified: true`, and fresh `read_at` timestamps: Water Tank `192.168.100.5`, Bore Motor `192.168.100.12`, First Floor Breaker `192.168.100.7`, Ground Floor `192.168.100.9`, Geyser `192.168.100.25`. This is genuine TinyTuya LAN communication, not a cached value or a saved-IP inference.
- The live replies **confirm the schema-based scaling** independently of Smart Life: `forward_energy_total` `scale: 2`, `unit: kWh` (Water Tank `12173` → `121.73 kWh`; First Floor Breaker `256248` → `2562.48 kWh`; Ground Floor `319580` → `3195.80 kWh`); `cur_voltage` `scale: 1`, `unit: V` (`2396` → `239.6 V`, `2368` → `236.8 V`); `cur_power` `scale: 1`, `unit: W`; `cur_current` `scale: 0`, `unit: mA` (so 1000 raw mA = 1 A, matching the assumed ÷1000 A conversion). The Water Tank live reply did not include `phase_a` while the device was Off, so packed-telemetry decoding remains validated from the cached sample only.
- Cross-check against the earlier Smart Life OCR remains time-separated, not simultaneous: Smart Life showed `121.69 kWh` at 14:44, the live local read showed `121.73 kWh` at ~19:05 — a small plausible increase. Current/power were `0` on both because those devices were Off, so a nonzero ON comparison is still outstanding. No device was toggled.
- The phone later appeared on `192.168.100.21:38947` (mDNS advertised, TCP port open, ping OK), but ADB TLS connect failed (`failed to connect`, even after `adb kill-server`), so no new Smart Life screen capture was possible from the phone in this session. The side-by-side same-instant comparison is therefore still blocked on ADB re-pairing or a manual reading; the local side is now confirmed working.

### Same-instant Smart Life comparison over USB ADB (2026-11-20)
- The phone was reconnected with **USB debugging** (`10FF3H02QE0004Y`), putting it on `192.168.100.21/24` alongside the devices (`ping 192.168.100.5` → 0% loss). The installed app (code 6 / 1.5) served `GET /api/state` → `{"logged_in":true}` over `adb forward tcp:18000 tcp:8000`.
- Water Tank detail screen was opened in Smart Life 7.12.6; its numbers were read with Windows OCR (they are canvas-drawn and absent from `uiautomator` XML). At **20:42**, Smart Life showed `Total forward energy = 121.82 kWh`, `Current 0.000 A`, `Active Power 0.000 kW`, `Voltage 239.7 V`, `Device Off`. A direct read-only TinyTuya status call at the same moment returned `dp1 = 12182` with `scale=2`, `unit=kWh` → **121.82 kWh — an exact same-instant match**. This confirms the scaling implementation against the reference app, not just against the device schema.
- Current and power were `0` in both because the device was Off, so a nonzero ON-load comparison is still outstanding. The live reply did not contain `phase_a`; the earlier cached sample decoded to `247.5 V`, while Smart Life showed `239.7 V` at 20:42 — consistent with the cached sample being several hours old, not with a wrong divisor.
- **Safety incident, fully disclosed:** while navigating Smart Life's home screen by coordinates, a tap intended to open the Bore Motor detail screen landed on its `switch_1` tile and toggled that device ON (`dp1=true`, timestamp `20:43`). This was an unintended state change without DP-level approval. It was detected immediately via a read-only TinyTuya status call, reverted with `set_value(1, False)` on the same local DP, and verified by readback (`before=True` → `after=False`). A final sweep confirmed all five devices were back to their original states: Bore Motor Off, Water Tank Off, First Floor Breaker On, Ground Floor On, Geyser Off. The temporary screen-timeout change made for navigation was restored to its original `30000` ms. No other device was toggled.

### Amp-normalised line current (from live schema finding)
- Live reads showed `cur_current` published as `scale=0`, `unit=mA`, so a raw `1500` would have rendered as `1500 mA` while Smart Life and our own packed `phase_a` decoder show amperes. `currentText()` now converts only `cur_current` to A (`1500` → `1.500 A`); `leakage_current` and other genuinely-mA DPs keep their unit. Added browser test `test_local_line_current_is_shown_in_amps_but_leakage_stays_in_ma`; all seven premium `/local` browser tests pass, JS syntax 32/0, mirrors synced.

### Installed build v7 / 1.6 (amp-normalised current fix deployed)
- Bumped both APKs to `versionCode` 7 / `versionName` 1.6 and rebuilt `dist\TuyaLocalKey-Offline.apk` (`com.example.tuyalocalkey.offline.v2.debug`) and `dist\TuyaLocalKey.apk` (`com.example.tuyalocalkey.debug`) with the unchanged saved debug key (offline signer SHA-256 still `b86148540bdcdd8b90409f1233e41f668be2934738b8c5cfb2be13ac414bb930`).
- Installed the offline build in place over USB ADB with `adb install -r` → `Success`; `dumpsys package` now reports code 7 / 1.6. All nine preserved session/cache/preference files had **identical MD5 hashes before and after** (session.json, cache.key, devices.cache, lan.cache, lan-profile.json, local-preferences.json, update-check.json, WebViewChromiumPrefs.xml, chaquopy.xml) — full data preservation. No uninstall or clear-data.
- After a fresh launch: embedded server `127.0.0.1:8000` LISTEN, `GET /api/state` over `adb forward` → HTTP 200 `{"logged_in":true}`, and `/api/local/status?id=…` → `status=ok`, `verified=true`, fresh `read_at`, `forward_energy_total=12182`, `scale=2`, `unit=kWh` (→ `121.82 kWh`). The served `static/js/features/local-control/api.js` contains `isAmpNormalisedCurrent`, confirming the fix is on-device and not only in source. The earlier slow-start observation was a startup timing artifact, not a code defect.

### Production release signing (2026-11-20)
- Generated a dedicated release keystore (RSA 2048, 10,000-day validity, random alias and 48-character password) stored **outside the repo** at `C:\Users\abc\.tuya-local-key-release\` with user-only ACLs; the public debug key was deliberately not reused. Signer SHA-256 `092024131e8d4f49fe557a23c3942743e131d4b5e9dfdedf46ea739e6c2aa003` is distinct from the debug key `b8614854…4bb930`.
- Built both `assembleRelease` variants successfully with the saved credentials loaded from the protected file. Outputs copied to `dist\TuyaLocalKey-Offline-release.apk` (`com.example.tuyalocalkey.offline.v2`, code 7 / 1.6) and `dist\TuyaLocalKey-release.apk` (`com.example.tuyalocalkey`, code 7 / 1.6); `apksigner verify --print-certs` confirms the production signer on both. Release package IDs omit the `.debug` suffix, so they install alongside the debug builds without touching their data.
- Added [docs/RELEASE_SIGNING.md](docs/RELEASE_SIGNING.md) covering keystore location, backup requirement (must be backed up in a password manager/offline storage or future updates cannot be signed), and the build commands. No credential values were written into the repo or printed in the build log. A Chaquopy network warning while downloading Pillow was transient; the offline release APK completed successfully.

## 1.1 — Premium local-first update (unreleased)

### UI / UX
- Added a **Table / Cards** layout switch on the device screen. The table remains the default, so existing workflows and CSV-oriented tests are unchanged.
- Cards show a compact device icon, primary control, masked local key, and an honest connection pill. They link to the existing `/local` control page instead of duplicating command logic.
- `/local?device=<id>` focuses the requested device from a card.
- `/local` now distinguishes **Online** (recent successful local read) from **Address saved** (IP known but not verified) and **Offline**. Silent poll failures update the tile instead of leaving a stale green badge.
- Layout switching, search, bulk selection, keyboard focus, and key masking are covered by browser tests.

### Reliability / correctness
- Saved IPs are no longer presented as live online status.
- Consecutive failures invalidate stale success profiles; fresh gateway / unreachable scan results are no longer overwritten by old cached data.
- Commands require a successful DP readback before reporting confirmed success; mismatches are surfaced to the UI.
- Status and command requests are serialized per device and return HTTP 409 when busy.
- Failed local reads return HTTP 502 instead of a success response.
- A transient encrypted-cache read error no longer deletes the only copy of the cache.
- Manual device keys accept real Tuya ASCII keys (for example `5vps+n4FwxR2?df;`), not just hexadecimal strings. Manual devices remain unverified until their first successful read.

### Security
- Cross-origin `Origin` headers are rejected on state-changing API calls when Basic Auth is enabled. HA ingress behavior is unchanged.
- Android server URL handling no longer appends a trailing slash (which broke `/local` relative API calls). `/local/` now redirects to `/local` for old clients.
- WebViews allow navigation only to the configured server origin (offline APK: embedded localhost only), block mixed content and file/content access, and guard the QR-save bridge by current origin.
- Release Gradle builds no longer use the public Android debug signing key; they require externally supplied signing credentials.
- `build_apk.py --install` now finds `adb` through `ANDROID_HOME` even when it is not on `PATH`.
- Added `tools/adb_update.py` for safe, variant-detecting `adb install -r` updates with version checks, launch and filtered logcat.

### Build / quality
- Added `tests/test_local_control.py` with API regression coverage for keys, state truthfulness, gateway results, readback and error codes.
- Added CSRF and encrypted-cache regression tests.
- Added `.github/workflows/tests.yml` with pytest, Playwright, and add-on/offline source-sync drift checks.
- Added a card-view UI test suite; all default table behavior remains intact.
- Android `versionCode` was bumped to 2 and `versionName` to 1.1 for the 1.1 release (historical; current builds use `versionCode` 3 / `versionName` 1.2 — see Unreleased).

### Setup notes
- Existing users need no migration: caches and local keys remain encrypted and unchanged.
- For release APKs, set `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`, and `RELEASE_KEY_PASSWORD` in `gradle.properties` (not committed) or the environment. Debug builds are unchanged.
- Only expose the web app beyond localhost behind authentication plus TLS/VPN (Home Assistant ingress + Tailscale/WireGuard is the recommended path).
