# Smart Pilot v0.8 — compact UI/UX review

Scope: frontend-only visual/layout improvements. Tuya and Haier transport, HTTP APIs, write confirmation, device states, credentials, and automations unchanged.

## Changes
- Settings drawer: 8 touch-friendly category buttons; only one advanced section visible at once. Add Device / Network / Appearance shortcuts select the corresponding section automatically. Local key entry is masked.
- Devices: mobile cards show verified status and the primary control/read-only row; secondary capabilities and advanced DP values remain in the dedicated device-detail sheet, reducing tall-card scrolling without deleting controls.
- Auto-Pilot: mobile AC picker shows one of the two existing Haier controllers at a time, honoring Home tile focus; desktop still shows both. Scenes and editor sit in an optional disclosure, collapsed by default.
- Responsive containment: mobile grid/flex layouts, Device IP editing, settings inputs, settings chips, scene editor fields and footer are constrained to the viewport. Page-level horizontal scrolling clipped as a final guard, not as the primary layout fix.
- Home structure, card order, hide/show preferences and visual density retained.

## Testing before merge
1. At viewport widths 320, 360, 390, 412, 768 and desktop 1280, check `document.documentElement.scrollWidth <= innerWidth` on all 4 tabs with Settings drawer and Device detail sheet open/closed.
2. Confirm no vertical mega-scroll in Settings (selected section only), Devices cards (details in sheet), or Auto-Pilot (one AC and collapsed Scenes).
3. Device detail sheet must show every existing secondary toggle/DP; ON/OFF remains subject to existing confirmation and readback behaviour.
4. Switch AC picker both ways and navigate from each Home AC tile; retain independent Manual/Auto behavior.
5. Check no horizontal clipping of network/IP editing controls on narrow Vivo, mobile keyboard open, and light/dark theme.
6. Run Playwright `tests/test_ui.py`, Python backend tests, source sync check, and physical Vivo smoke test. CI may have unrelated pre-existing failures.

This PR does not build or install an APK and does not fix backend latency or LAN discovery.
