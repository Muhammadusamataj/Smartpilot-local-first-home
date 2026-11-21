# Smart Pilot UI — applied to your Tuya Local Key source

This ZIP starts from the user-supplied `tuya-local-key-source.zip` and preserves the Python API, local Tuya controls, login, scans, scenes, Android launchers, and supporting files.

## Changes

- Added `static/css/pilot-theme.css` and the corresponding offline-Android asset copy.
- Applied the Haier Pilot visual language to the **existing real Tuya UI** (dark navy, turquoise/blue glass, dashboard stats, device cards, forms, and mobile bottom navigation).
- Updated **web** and **offline Android** `templates/index.html` and `templates/local_control.html` to load the theme and display the new branding / dashboard header.
- Kept existing JavaScript ids, event wiring, API paths, login and device control logic untouched. Only display markup and CSS changed.
- The project remains a Tuya local-key and device-control project. **Haier direct TCP control and Haier Auto-Pilot are NOT added to this Tuya APK in this UI-only version.**

## Run it

- **Web:** follow the original `README.md` instructions; start the Flask app. Open `/local`.
- **Android offline:** open `android_offline/` in Android Studio, build the offline APK as described in the original project docs; the UI is served by the bundled Python Flask backend.
- **Android online:** original `android/` project uses the web backend UI; launch the updated backend.

## Cautions

- No device keys, IDs or credentials have been changed or added.
- This UI version has **not** been live-tested on the user's devices or compiled as an APK.
- For real-world controls like bore motors, breakers and geysers, continue to use the original project's safeguards and verify DP mapping.
- Browser-only screenshots of the preview are illustrations, not live device statuses.
