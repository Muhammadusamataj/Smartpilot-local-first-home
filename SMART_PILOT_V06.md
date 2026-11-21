# Smart Pilot v0.6 — Tuya command reliability hotfix

This is a **source fix**, not a verified Vivo hardware APK.

- Critical power switches now explicitly say **2 taps to confirm** and show the second-tap intent (ON vs OFF). Each tap is a single native button click, not combined pointerdown/label/checkbox events.
- One write at a time per device, command state visibly pending, and no automatic repeat of an uncertain ON/OFF write.
- Interactive writes can wait 2.5 seconds for an existing status read rather than being immediately rejected with `busy`.
- Readback performs a second **read-only** check after 550ms for eventual-consistency devices. It never sends the command twice.
- After uncertain result, button remains disabled until a **verified** fresh read; a message says to refresh/check the device.
- Never render actionable switches from cached DP metadata before a live status read. Disable controls after lost connectivity.
- Canonical web, Android offline, and HA add-on mirrored code updated.
- On phones, large-area backdrop blur is reduced to avoid costly repaint during scrolling.
- Embedded Android WebView caches static assets, while live status API requests use `no-store`.
- Critical detection also includes geyser, water tank, pumps and heaters.
- Live control UI is blocked unless device status has been refreshed successfully within the last minute.

## Vivo manual validation checklist

1. Back up app data first if you intend to uninstall, because uninstall may delete stored Tuya credentials/keys. Prefer installing update with matching applicationId/signing key.
2. Test on **one non-critical light or plug**, with Smart Life open separately for actual physical state.
3. First tap a critical device only arms it, second deliberate tap within 4.5 s sends exactly one command. It says this under the switch.
4. Expect **Sending...** until the command readback. The switch changes only if confirmed.
5. If **Unconfirmed**, do not repeatedly tap. Refresh once and check physical device/Smart Life.
6. Report phone model, Android version, device name, protocol version and whether status is `busy`, `unreachable`, `readback_mismatch`, or timeout; never post a local key.

## Remaining limits

- Needs Android compilation by OpenCode/Android Studio and testing with actual Tuya hardware.
- Router reachability, wrong DP mappings, device version 3.5 and poor Wi-Fi remain possible causes of non-response.
- Battery optimizations/background process and local phone-host server performance may still require profiling.
- Do not use alpha builds to control breakers, bore motors or geysers unattended.
