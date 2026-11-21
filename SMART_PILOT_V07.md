# Smart Pilot Unified v0.7 — Compact UX & LAN reliability

## Actual changes

- **Four tabs**: Home, Devices, Auto-Pilot, Settings. Full Haier controls and existing Scenes are together in Auto-Pilot; existing technical features remain in the Settings drawer.
- **Single Home view**: two Haier summary tiles plus each Tuya device only once. Detailed device controls are not duplicated on Home.
- **Customizable Home**: `Customize` enables touch-friendly Up / Down / Hide / Show controls, plus optional desktop drag-to-reorder. Order and hidden tile IDs persist in the phone WebView's localStorage; local keys, power states and credentials are NEVER stored there. Hidden devices still exist in Devices and are not deleted or disabled. Device IDs are only used for view preferences.
- **LAN without WAN**: remove `navigator.onLine` as a prerequisite for polling. Android sometimes declares Wi-Fi offline when the router lacks internet even though local Tuya/Haier IPs remain reachable.
- **Reconnect feedback**: after two failed device status reads, request the backend's existing throttled, read-only LAN ensure/reconnect routine at most once per two minutes. No commands are repeated as part of reconnect.
- **Scan protection**: do not initiate multiple simultaneous whole-LAN scans from double taps; disable the scan buttons until the current scan finishes.
- **Lower UI overhead**: reduce polling parallelism on phones from 3 to 2; avoid large mobile backdrops and extra animation. This does not fix poor Wi-Fi/router latency or slow firmware.
- **Live badge updates**: refresh compact Home online/unreachable labels after verified local status reads.
- **No device behavior rewrite**: critical Water Tank / Bore Motor / Geyser / floor breakers still use two deliberate taps. Unconfirmed writes remain blocked until a verified refresh; unsupported Haier model writes remain disabled.
- **Android branding**: app label is now Smart Pilot; `applicationId` is preserved and debug versionCode increments from 9 to 10 for update eligibility (same signing key still required).
- **Initial setup UX**: Devices and Settings tabs also exist when the device list is empty.

## Build on OpenCode

1. Unzip and open `SmartPilot_Unified_v0.7`.
2. Use the `android_offline/` module (local Flask + Python embedded on phone). Prefer `python build_offline_apk.py` to sync and build, with Android SDK/JDK configured; or run `:android_offline:assembleDebug` after source sync.
3. Use the same Android `applicationId` and signing certificate as the installed build when preserving local keys and data. Back up first. Do not uninstall v0.6 if its local credentials have not been backed up.
4. Build a debug APK and install the update. On a Vivo phone, permit LAN/Wi-Fi, enable notifications and foreground/background exceptions **only where required**; never assume background execution is guaranteed.
5. Test one **non-critical** Tuya plug/light first. Verify ON and OFF physically and in Smart Life. Next test Haier read-only status with Home Assistant polling temporarily stopped, before enabling individual writes.
6. Record button states `Sending / Confirmed / Unconfirmed`, router subnet, Android/Funtouch version and device protocol version; never share raw local keys.

## Verification performed here

- Node syntax checks for all original source JS feature modules.
- Node isolated state tests for Home tile reorder, hide/show, escaping and persistence.
- Python focused tests for Haier integration, device cache and preferences.
- Static Jinja markup inspection for four tabs and unique sections.
- Existing Python code and add-on/Android mirrored source copied without changing protocol writes.

## Remaining limits

- **No real Vivo / Haier / Tuya hardware access**, so UI latency and command reliability must be tested on-device.
- Android SDK was not available here for a verified APK compilation.
- Browser Playwright preview navigation was blocked by this environment's administrator restrictions. A separate *visual-only* HTML mock is provided; it does not send commands.
- Browser customization stored in localStorage may be reset when app data is cleared, or when opening the app on a different browser/device.
- Haier discovery and first-time local-key provisioning are not newly implemented in this UI release. Existing paired devices and saved keys are reused.
