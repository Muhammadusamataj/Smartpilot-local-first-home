# Smart Pilot Unified — v0.4 Compact Home (UI revision)

## Duplicate-free information architecture

- **Home**: exactly two compact Haier AC overview tiles and one small tile per Tuya device. No full duplicate AC cards, no favorites-and-all-devices repeat, no extra readings/scenes/filters sections.
- **Haier AC**: the only place for full Haier controls, Manual/Auto switching, temperature, Eco/Sleep/Quiet, connection setup and refresh.
- **Devices**: detailed Tuya cards and all supported data-point controls. Tapping a Tuya summary on Home opens the existing device detail sheet directly (it does not send an ON/OFF command).
- **Scenes**: scene actions and editor; **Advanced**: network, scan, setup and security.
- The bottom navigation remains fixed. A 390×844 visual fixture shows two ACs and five small Tuya tiles in one screen without vertical overflow under sample content.

## What changed

Only `templates/local_control.html`, `static/js/features/local-control/main.js`, `static/js/features/local-control/haier.js` and the new `static/css/pilot-compact.css` were changed. They are mirrored to the Home Assistant add-on and Android-offline web bundles. No API routes, local-key handling, protocol decoders, writes, or automation service were changed by this UI revision.

## Safety and limitations

- Preview is explicitly marked **sample UI**, not connected to devices.
- Device states must come from actual verified reads; no samples are injected in the installed app.
- Existing Tuya critical-device confirmation remains in the detail sheet, not bypassed by quick buttons.
- Haier writes are still limited to confirmed protocol layouts. Local control and reliable background Auto-Pilot still require hardware validation; Android APK compilation was not performed for this UI revision.
- If your Android package embeds the Python assets, rebuild/reinstall that package to pick up the revised frontend. Updating only the preview HTML changes no device.

## Verification

- Both Jinja-ready and onboarding variants include only a single Home section per rendered page.
- Both JS modules pass `node --check`.
- `tests/test_haier_pilot.py` passed (six tests). Other integration tests depend on unavailable Flask packages in the container; an unrelated old packaging assertion expects add-on version `4.6` while `tuya_local_key/config.yaml` specifies `4.7`.
- Sample 390×844 static browser screenshot verified two Haier compact tiles, five Tuya compact tiles and zero full Haier cards on Home.
