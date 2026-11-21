# Smart Pilot Unified v0.3 (experimental)

A working-source update to your **existing Tuya offline Android / Flask / HA add-on project**. This update preserves existing Tuya QR login, local keys, verified DPS, scenes, two-step confirmation for high-risk switches, and the existing app/navigation. It introduces a second independent **Haier Direct LAN** backend and matching premium glass UI. No fictitious 'connected' statuses are reported.

## What changed

- Home now shows two configurable Haier AC cards above the existing Tuya devices.
- Added dedicated **Haier AC** tab on the bottom navigation bar.
- Names pre-filled only: `19HFAB T3 Pro`, `FF Haier 19HFAB T3`.
- New `haier_control.py`: stand-alone Python encrypted TCP/56800 handshake, status and guarded writes; no Home Assistant dependency.
- Connection screen: private IPv4, Wi-Fi-module Device ID (not product model number), 32-hex Local Key, optional key version. Settings are encrypted with Fernet in app-private storage / add-on storage (local `haier-pilot.enc` + key file); keys never returned over APIs or written to browser localStorage.
- Independent per-AC Manual/Auto modes. Manual never autonomously sends commands. Auto in v0.3 checks at most every 5 minutes and adjusts only an **already-running compatible cooling AC**: target 26°C day or 27°C 23:00–07:00 (Asia/Karachi), Eco level 1 daytime, Sleep at night. At most one change per interval.
- External manual changes in supported reported settings trigger a 2-hour Auto pause after detection; manual commands in Auto pause for two hours immediately. Each AC has its own pause.
- Auto NEVER starts or powers off an AC in this early, unverified release, and heating writes are disabled. This is intentional for compressor safety.
- Optional power/current/frequency readings, when a compatible extended-status frame returns them. Unknown or missing readings are displayed as unavailable (never invented).
- For writes, only 125/127-byte hardware-confirmed classic status layouts are allowed; all other Haier model layouts remain **read-only**. If a fresh in-session control baseline is missing, commands are refused, never guessed.

## How to use

1. Build or serve this **source** as you previously did for Tuya. In the offline Android WebView app, the Python backend already runs on the phone; in the HA add-on or Docker version, it runs wherever you host it. A rebuilt APK is needed for Android deployment; no APK is provided.
2. In the app open **Home** or **Haier AC**. Both cards initially read **SETUP NEEDED** — not fake connections.
3. Tap the **gear** on the AC you own. Enter its LAN IPv4, 12–32-char module device ID, 32-hex Haier Local Key, and optionally key version. Never send your key in a public chat or screenshot.
4. Save, then tap **Refresh**. It makes a verified local network request. If `READ ONLY` appears, your hardware's report layout is not yet safely write-supported by this implementation.
5. Only if confirmed `LOCAL ONLINE`/writable, use Manual controls to test a single setpoint change, then verify the result with the official HaiSmart app. After manual testing, optionally enable Auto; it will adjust temperature only when already cooling and on.
6. Existing Tuya devices still display through their normal logged-in/saved-key workflow. The dashboard does not infer that a device is online from a stored IP.

## Important limitations

- **Not an APK** and **not field-tested** on your two Haier ACs. Android APK build needs an Android SDK/JDK/Gradle environment and physical LAN test. Backend codec was tested against a **synthetic protocol fixture** only.
- Haier local protocol supports one simultaneous TCP session; Home Assistant's existing HaiSmart Local integration may contend with this standalone app. For direct-LAN testing, disable the *particular HA integration* temporarily. Keep official HaiSmart cloud connection untouched so remote access stays usable.
- The Local Key can rotate. This v0.3 cannot refresh it from Haier's cloud: update the saved key manually if needed.
- **Auto runs only while the hosting server process runs.** On Android, the OS may pause/kill the background process; there is no 24/7 uptime guarantee. A dedicated always-on computer/controller is better for continuous automation.
- The Auto mode only adjusts setpoints, Eco/Sleep on supported cooling units. Heating, automatic power on/off, 24/7 background guarantees, verified savings and kWh billing are **not** implemented yet.
- Existing Tuya Bore Motor, Breakers and Geyser two-step confirmation remains. Haier writes require valid configuration and confirmation from status to report success.
- The app is **private-LAN only** for native Haier connection, not a cloud relay; no guarantee it functions on every firmware/model.

## Sync and build commands

```sh
python tools/sync_addon.py
python -c "import build_offline_apk; build_offline_apk._sync_sources()"
python build_offline_apk.py            # requires Android SDK/JDK 17 and Gradle wrapper
```

Changed files: `haier_control.py`, `app.py`, `templates/local_control.html`, `static/css/haier.css`, `static/js/features/local-control/haier.js`, `tools/sync_addon.py`, `build_offline_apk.py`, `Dockerfile`; mirrored in `tuya_local_key/app/` and `android_offline/app/src/main/python/`.

### Attribution

Haier protocol interoperable implementation informed by [enapt/haismart-local](https://github.com/enapt/haismart-local), whose original project publishes its sources under MIT license. This local controller is experimental, not endorsed by Haier. The original Tuya project's license and upstream notices remain intact.
