# Smart Pilot Unified v0.5 — Safe compact dashboard (beta)

## Scope

- **Home** stays short: two Haier AC summaries and one unique tile for each Tuya device. Full climate controls remain only in **Haier AC**, and Tuya controls remain in their details drawer. This is not a second copy of the same controller.
- Tapping either Home AC summary navigates to that **specific** AC card rather than landing above the first card.
- AC summary includes Manual, Auto, or Auto Paused state, as returned by the backend.
- **No invented device states**: expired/offline Haier status is masked; missing Eco/Sleep/Quiet/Strong reports disable the corresponding toggle instead of guessing which way to switch. A failed explicit status refresh invalidates prior verified permissions.
- The already-running summer Auto rules, 2-hour manual pause, per-AC separate controls, Tuya handling and encrypted local-key storage are retained. Winter heating, autonomous power cycling and local-key cloud renewal are **not implemented**.
- Android Gradle source accepts a machine-local default debug keystore when the custom `tools/keys/debug.keystore` is absent. Keep the old keystore if you previously installed a debug APK and want an in-place update — using a new key changes the signing certificate and may require a separate installation. Never share private signing keys.

## Testing completed on mock/synthetic fixtures

- Python local Haier protocol/state tests (including expired cache and refresh-failure tests).
- Browser rendering of the actual `haier.js` card code with **fake** API responses; UI verification at 390×844.
- JavaScript syntax, Python bytecode compilation, mirrored Android/add-on source consistency.

## Not yet tested

- **Android APK compilation**: no Android SDK in this build environment. Open the `android_offline` directory in Android Studio, install Android SDK 34, JDK 17 or compatible Gradle JDK, and build Debug, or run `python build_offline_apk.py` from project root with `ANDROID_HOME` configured.
- Real Haier ACs, actual TCP key/firmware compatibility, and Tuya motor/breaker controls on hardware.
- Continuous Android background Auto-Pilot while the OS suspends the app; 24/7 reliability is NOT promised.

## Safety during testing

1. Keep the official HaiSmart app available; never block its cloud access just for this app.
2. Do not run independent Haier LAN polls concurrently with Home Assistant's HaiSmart integration during native protocol tests. Use one controller at a time.
3. Test only one AC in **Manual** mode first. Only enable Auto after read and conservative control writes are verified; make no changes to motors or breakers until their Tuya DP mapping is confirmed.
4. No actual Local Keys or LAN IPs are included in the previews; their numbers are synthetic demo values.

## Useful commands

```sh
python -m pytest -q tests/test_haier_pilot.py tests/test_packaging.py
python tools/sync_addon.py
python -c "import build_offline_apk; build_offline_apk._sync_sources()"
python tools/smoke_ui_v05.py  # requires Jinja2, Playwright, Chromium; fake local data only
python build_offline_apk.py  # requires ANDROID_HOME, SDK and Gradle dependencies
```
