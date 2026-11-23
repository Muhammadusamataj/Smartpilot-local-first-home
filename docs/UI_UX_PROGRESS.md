# Smart Pilot UI/UX Progress

**Last updated:** 2026-11-24  
**Branch:** `feature/smartpilot-premium-ui`  
**Base HEAD:** `3fc711f Reliability hardening for v1.19`  
**Overall status:** CP0 verified and pushed; Android release-channel code changes paused pending approval; Batches 1–4 verified locally; Batch 5 in progress; push awaiting explicit approval

This file is updated after every implementation or testing milestone. Do not mark a milestone complete without evidence.

---

## Batch 0 — Planning, isolation and audit `[COMPLETE]`

### 0.1 Persistent instructions and planning `[COMPLETE]`

Evidence:

- Created `AGENTS.md`.
- Created `docs/UI_UX_MASTER_PLAN.md`.
- Created `docs/UI_UX_PROGRESS.md`.

No prior versions of these files existed (`glob` returned no matches), so no existing instructions were overwritten.

### 0.2 Isolated branch `[COMPLETE]`

Commands executed:

```powershell
git checkout -b dev/ui-premium-v119
git branch -m dev/ui-premium-v119 feature/smartpilot-premium-ui
```

Output:

```text
Switched to a new branch 'dev/ui-premium-v119'
feature/smartpilot-premium-ui
```

Current state:

```text
feature/smartpilot-premium-ui
3fc711f Reliability hardening for v1.19
```

Remote preflight:

```text
git ls-remote --heads origin feature/smartpilot-premium-ui dev/ui-premium-v119
# no matching refs
```

```text
gh auth status
✓ Logged in to github.com account Muhammadusamataj (keyring)
Token scopes: gist, read:org, repo, workflow
```

Notes:

- Branch was created from local v1.19 HEAD to preserve all released reliability fixes.
- The temporary `dev/ui-premium-v119` name was renamed locally to the required `feature/smartpilot-premium-ui`; no remote branch was created or deleted.
- Stable v1.18 (`ec23825`), `main`, PR #4, tags and other remotes were not modified.

### 0.3 PR #4 inspection `[COMPLETE]`

Evidence:

```text
git fetch origin pull/4/head:pr4-inspect
d6cc1e3 feat(ui): introduce clean home-inspired smart dashboard visual layer
```

Findings:

- PR #4’s own commit changes 6 files: 3 CSS files + 3 templates.
- PR #4 itself contains no Python/JS/test edits.
- However, PR #4 was branched from `19d7561`, before v1.18 hardening `1145fb1`.
- A tree-level diff `ec23825...pr4-inspect` shows deletion of 525 lines in `local_control.py`, 299 lines of reliability tests, HA diagnostics, network facts and v1.19 hardening.
- PR #4 must not be merged or snapshot-adopted.
- Its visual hierarchy is useful inspiration only; its 397-line last-layer CSS has ~210 `!important` declarations and breaks the exact body-colour assertion at `tests/test_ui.py:316-317`.

### 0.4 DOM / JS contract audit `[COMPLETE]`

Key evidence captured:

- `templates/local_control.html:25-31` — five tabs: `home`, `devices`, `autopilot`, `scenes`, `settings`.
- `static/js/features/local-control/main.js:674-694` — `setView()` toggles `.active`, `aria-selected` and `[data-view-panel]` visibility.
- `main.js:1076-1078` — tab click handler.
- `main.js:1114-1117` — `[data-jump-view]` delegated handler.
- `main.js:39-47` + `controls.js:51-116` — critical-device two-tap guard.
- `main.js:73-80,166-227` — verified-only “Online” semantics.
- `haier.js:6,30-57` — fixed slots `pro` and `ff`.
- `home-layout.js:5-92` — Home ordering/visibility in localStorage.
- No inline `<script>` or `<style>` blocks; both are test-locked.
- 51 static IDs are unique.

Accessibility gaps recorded for later batches:

- Panels lack `role="tabpanel"` / `aria-labelledby`.
- Tabs lack `aria-controls` and arrow-key roving tabindex.
- Drawer/sheet lack `role="dialog"` / `aria-modal`.
- Search input has no visible focus ring due to `outline:none`.
- Favorite and family-mode active states are not exposed with `aria-pressed`.

### 0.5 CSS architecture audit `[COMPLETE]`

Key evidence captured:

- 9 loaded stylesheets in `templates/local_control.html:8-16`.
- 416 total `!important` declarations; 405 in `pilot-theme.css`, `pilot-v07.css`, `pilot-v08.css`.
- 94 selectors are shared across two or more CSS files.
- 334/334 font-size declarations use raw px; 0/307 padding declarations use tokens.
- 16 distinct small-width breakpoints; bottom nav conflicts at 680/720/760px.
- System theme currently renders dark when no explicit `data-theme` is set.
- Light mode has hardcoded dark gaps in Haier mode tabs/status/alerts, chips and mobile tab bar.
- `#devices.grid` single-column rule at `pilot-v08.css:73` is defeated by later `pilot-v08.css:208-212`.
- No `safe-area-inset-top`, left or right handling; only bottom inset exists.
- Search input focus ring is suppressed.

### 0.6 Baseline screenshots `[COMPLETE]`

Harness created outside repo:

- `UI_REVIEW_TEMP\capture_ui.py`
- All `/api/**` calls are mocked; no device reads/writes performed.

Command:

```powershell
python -u 'UI_REVIEW_TEMP\capture_ui.py' 'UI_REVIEW_TEMP\before' before
```

Output:

```text
captured 60 shots to UI_REVIEW_TEMP\before
overflow failures: 0
page errors: 0
```

Coverage:

- 2 themes: light, dark
- 6 widths: 320, 360, 390, 412, 768, 1280
- 5 views: home, devices, autopilot, scenes, settings
- 60 PNGs plus `report.json`

Limitation:

- This model cannot visually inspect PNG content directly. Screenshots are preserved as evidence; objective computed-style/geometry metrics are used for visual validation.

### 0.7 Baseline objective metrics `[COMPLETE]`

Harness created outside repo:

- `UI_REVIEW_TEMP\metrics_ui.py`
- Output: `UI_REVIEW_TEMP\metrics_before.json`

Command output:

```text
wrote UI_REVIEW_TEMP\metrics_before.json
ISSUE light_390_home overflow 0 small 9 overlap 5
ISSUE light_390_devices overflow 0 small 11 overlap 0
ISSUE light_390_autopilot overflow 0 small 10 overlap 1
ISSUE light_390_scenes overflow 0 small 12 overlap 8
ISSUE light_390_settings overflow 0 small 6 overlap 0
ISSUE light_1280_home overflow 0 small 8 overlap 0
ISSUE light_1280_devices overflow 0 small 12 overlap 0
ISSUE light_1280_autopilot overflow 0 small 10 overlap 0
ISSUE light_1280_scenes overflow 0 small 12 overlap 8
ISSUE light_1280_settings overflow 0 small 6 overlap 0
ISSUE dark_390_home overflow 0 small 9 overlap 5
ISSUE dark_390_devices overflow 0 small 11 overlap 0
ISSUE dark_390_autopilot overflow 0 small 10 overlap 1
ISSUE dark_390_scenes overflow 0 small 12 overlap 8
ISSUE dark_390_settings overflow 0 small 6 overlap 0
ISSUE dark_1280_home overflow 0 small 8 overlap 0
ISSUE dark_1280_devices overflow 0 small 12 overlap 0
ISSUE dark_1280_autopilot overflow 0 small 10 overlap 0
ISSUE dark_1280_scenes overflow 0 small 12 overlap 8
ISSUE dark_1280_settings overflow 0 small 6 overlap 0
```

Summary command:

```powershell
python -c "import json,collections,statistics; d=json.load(open(r'UI_REVIEW_TEMP\metrics_before.json',encoding='utf-8')); print('combos',len(d)); print('overflow',sum(v['scrollWidth']>v['clientWidth']+1 for v in d.values())); print('small_total',sum(len(v['smallTargets']) for v in d.values())); print('overlap_total',sum(len(v['overlaps']) for v in d.values())); print('lowcontrast_total',sum(len(v['lowContrast']) for v in d.values())); print('min_contrast',min(v['minContrast'] for v in d.values() if v['minContrast'] is not None)); print('font_sizes',sorted(set(s for v in d.values() for s in v['fontSizes'])))"
```

Summary output:

```text
combos 20
overflow 0
small_total 192
overlap_total 44
lowcontrast_total 143
min_contrast 1
font_sizes [9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 17.55, 18, 19, 20, 21, 24, 25, 30, 32, 33]
```

Interpretation:

- Baseline has no horizontal overflow, but many small targets, overlaps, low-contrast rows and scattered font sizes.
- These are targets for improvement, not evidence of a new regression.

### 0.8 Sanitized visual report `[COMPLETE]`

- Created `docs/UI_UX_VISUAL_BASELINE.md`.
- Contains only repository-relative artifact names, aggregate metrics and mocked-fixture descriptions.
- No device keys, credentials, personal paths, sensitive logs or live hardware data are included.
- Absolute local temp paths in this progress file were replaced with the placeholder `UI_REVIEW_TEMP`.

### 0.9 CP0 regression verification `[COMPLETE]`

Commands and exact results:

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
```

```text
......                                                                   [100%]
6 passed in 0.06s
```

```powershell
node tests/test_pilot_home_layout.mjs
```

```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -m pytest tests/test_ui.py -q -k "premium_local_shell or local_small_screen_tabs or local_layout_is_reachable"
```

```text
........                                                                 [100%]
8 passed, 395 deselected in 256.65s (0:04:16)
```

Total: **15 focused checks passed**, 0 failed. No frontend source was changed in CP0; these checks verify the baseline contracts before Batch 1.

### 0.10 Android release/update audit `[COMPLETE]`

Scope correction applied: this mission is **Android-only** for UI preview releases. No Windows EXE build, packaging, publish or updater work will be performed. `build_exe.py`, `desktop_launcher.py` and other desktop sources remain untouched.

Files inspected:

```text
updates.py
static/js/features/updates.js
android_offline/app/src/main/java/com/example/tuyalocalkey/offline/UpdateManager.java
android_offline/app/src/main/java/com/example/tuyalocalkey/offline/OfflineActivity.java
build_offline_apk.py
tools/adb_update.py
tools/install_preserving_data.py
tools/ensure_signing_key.py
tools/sync_addon.py
android_offline/app/build.gradle
.github/workflows/tests.yml
.github/workflows/downloads-badge.yml
```

Findings:

- Python `updates.py` and web `updates.js` check only GitHub’s `/releases/latest`; both reject drafts and prereleases. Stable web users therefore cannot receive a prerelease automatically.
- Native Android `UpdateManager` also uses `/releases/latest` and rejects `prerelease=true`, so the installed app cannot see a prerelease today.
- Native `UpdateManager` already backs up the installed APK, opens Android’s normal install prompt, and offers rollback. It does **not** verify APK SHA-256, package identity, versionCode or signing certificate before installation, and has no download-progress callback.
- `tools/adb_update.py` checks that local `versionCode` is newer and uses `adb install -r`, but does not verify APK hash or signer; it must not be run against the Vivo device without explicit user approval.
- `tools/install_preserving_data.py` provides backup/rollback for the separate case where a signing certificate changes. Preview releases must **not** require it because the certificate will be preserved.
- `build_offline_apk.py` syncs root web sources into the Android build context and verifies the APK signer against `EXPECTED_SIGNER_SHA256`.
- `tools/ensure_signing_key.py` restores the private debug keystore from a location outside the repository and verifies its fingerprint before building.
- Current Android identity: `applicationId com.example.tuyalocalkey.offline.v2`, debug package `com.example.tuyalocalkey.offline.v2.debug`, `versionCode 20`, `versionName 1.19`.
- Published v1.19 APK audit: public asset `SmartPilot-Local.apk`, 45,202,432 bytes, signer SHA-256 `bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f`, matching `EXPECTED_SIGNER_SHA256`.
- GitHub releases contain v1.19 and older stable releases only; no prerelease exists yet.
- CI runs pytest and source-sync checks on `main`/pull requests. No release workflow exists; no workflow will be added that can publish automatically from a push.
- Android SDK, pinned keystore and Java 17 are available locally. `adb devices -l` returned no connected device, so no Vivo install or launch was attempted.

Decision:

- Keep Python/web stable update behavior unchanged.
- Add an explicit **Stable / UI Preview** preference in Android Settings, defaulting to Stable.
- Preview checks will use GitHub `/releases` metadata, accept only numbered `v1.19-ui-preview.N` prereleases, and require an APK plus `SHA256SUMS.txt`.
- Preview install will verify SHA-256, package identity, versionCode and signer before opening Android’s normal install prompt.
- Publishing will be performed only by a local, explicit release command after all required checks pass; no automatic release workflow will be created.

---

## GitHub checkpoint log

| Checkpoint | Milestone | Status |
|---|---|---|
| CP0 | Planning, isolation and audit | verified, committed `ed97a10418fa2c9ca4c7e1ee5d60d1d7555f37cc`, pushed |
| CP1 | Design system, navigation, Home | verified locally with CP2; push awaiting explicit approval |
| CP2 | Devices | verified locally; push awaiting explicit approval |
| CP3 | Auto-Pilot | verified locally; push awaiting explicit approval |
| CP4 | Scenes and Settings | verified locally; push awaiting explicit approval |
| CP5 | Micro-polish and final acceptance | not started |

### CP0 push evidence

Command:

```powershell
git push -u origin feature/smartpilot-premium-ui
```

Result:

```text
branch 'feature/smartpilot-premium-ui' set up to track 'origin/feature/smartpilot-premium-ui'.
* [new branch] feature/smartpilot-premium-ui -> feature/smartpilot-premium-ui
```

Remote verification:

```text
ed97a10418fa2c9ca4c7e1ee5d60d1d7555f37cc  refs/heads/feature/smartpilot-premium-ui
```

GitHub commit status:

```json
{"state":"pending","statuses":[],"total":0}
```

Interpretation: the branch and commit are present on GitHub. No commit statuses/CI checks are attached, so none failed. No PR was created.

### CP0 changed files

```text
AGENTS.md
docs/UI_UX_MASTER_PLAN.md
docs/UI_UX_PROGRESS.md
docs/UI_UX_VISUAL_BASELINE.md
```

4 files changed, 878 insertions.

---

## Batch 1 — Design system, navigation, Home `[COMPLETE]`

### Planned work

- [x] Add `static/css/pilot-premium-ui.css` as a single presentation layer.
- [x] Add semantic tokens and system-theme-following dark/light rules.
- [x] Refresh app bar and five-tab navigation.
- [x] Refresh Home hierarchy, AC overview and Tuya quick tiles.
- [x] Load the new CSS in all mirrored templates.
- [x] Run source/mirror guards.
- [x] Run focused UI tests.
- [x] Capture after screenshots at 320/360/390/412/768/1280 in both themes.
- [x] Compare objective metrics against baseline.
- [x] Update this progress file with exact results.

### Evidence

`static/css/pilot-premium-ui.css` was added as the final presentation layer and linked last in all three mirrored `local_control.html` files. The CSS and templates are byte-identical across web, Android and add-on mirrors. The layer preserves the locked body colours by keeping `var(--bg)` / `var(--card)` aliases and only overriding the decorative background image.

Verification commands and exact results:

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
```

```text
......                                                                   [100%]
6 passed in 0.47s
```

```powershell
node tests/test_pilot_home_layout.mjs
```

```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -u UI_REVIEW_TEMP\capture_ui.py UI_REVIEW_TEMP\after_batch1 after_batch1
```

```text
captured 60 shots to UI_REVIEW_TEMP\after_batch1
overflow failures: 0
page errors: 0
```

```powershell
python -u UI_REVIEW_TEMP\metrics_ui.py UI_REVIEW_TEMP\metrics_after_batch1.json
```

Objective totals before → after Batch 1:

```text
combinations      20 -> 20
overflow           0 -> 0
small targets    192 -> 182
overlaps          44 -> 36
low-contrast rows 143 -> 93
minimum contrast 1.0 -> 1.0
```

At 390px, Home small targets fell from 9 to 6 and Home overlaps from 5 to 1. One reported overlap remains between a Home tile and the closed device-sheet close button; it is addressed as a shared overlay concern in Batch 2.

```powershell
python -m pytest tests/test_ui.py -q -k "modular_frontend_starts or premium_local_shell or local_small_screen_tabs or local_layout_is_reachable"
```

```text
............                                                             [100%]
12 passed, 391 deselected in 269.12s (0:04:29)
```

This includes the exact body-background assertion for light `rgb(237, 245, 252)` and dark `rgb(8, 16, 35)`. No handler, API, data attribute, Python source or navigation destination was changed.

---

## Batch 2 — Devices `[COMPLETE]`

### Checklist

- [x] Refresh device cards, skeleton, empty state, status pills and detail sheet.
- [x] Remove fixed-column title clipping and enlarge card actions to 44px.
- [x] Keep two-tap critical guard and all command-state copy visible.
- [x] Reuse one bottom-dock breakpoint and hide closed overlays from focus.
- [x] Re-run source guards, Home layout guard, device/critical browser tests, screenshots and metrics.

### Evidence

The shared presentation layer now styles `#devices` cards as flexible wrapped cards; long names use `overflow-wrap: anywhere`. Favourite and refresh controls are 44×44px. Verified, stale and offline states remain text-labelled and gain distinct border/pill treatments. The device detail sheet is a true bottom sheet at phone widths, and closed drawers are explicitly inert. The two-tap guard and `.pilot-command-note` copy were not modified.

The objective harness was corrected to ignore `visibility:hidden` controls and to composite `color-mix()` backgrounds correctly. All before/after numbers below use the corrected harness.

Commands and exact results:

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
```

```text
......                                                                   [100%]
6 passed in 0.56s
```

```powershell
node tests/test_pilot_home_layout.mjs
```

```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -u UI_REVIEW_TEMP\capture_ui.py UI_REVIEW_TEMP\after_batch2 after_batch2
```

```text
captured 60 shots to UI_REVIEW_TEMP\after_batch2
overflow failures: 0
page errors: 0
```

```powershell
python -u UI_REVIEW_TEMP\metrics_ui.py UI_REVIEW_TEMP\metrics_after_batch2.json
```

Corrected objective totals, Batch 1 → Batch 2:

```text
combinations      20 -> 20
overflow           0 -> 0
small targets     66 -> 36
visible overlaps   0 -> 0
low-contrast rows 37 -> 27
minimum contrast 1.24 -> 1.24
```

```powershell
python -m pytest tests/test_ui.py -q -k "premium_local_shell or local_small_screen_tabs or local_layout_is_reachable or local_card_tap or local_favorite or local_capability_control or local_critical_switch or local_scaled_and_packed or local_line_current or local_cold_start or modular_frontend_starts"
```

```text
...................                                                      [100%]
19 passed, 384 deselected in 491.64s (0:08:11)
```

The selection includes `test_local_critical_switch_requires_two_deliberate_taps`, `test_local_card_tap_opens_device_details_sheet`, the locked body-colour assertion, responsive tab checks and real reading/command-state rendering. No Python, API, protocol or handler file was changed.

## Batch 3 — Auto-Pilot `[COMPLETE]`

### Checklist

- [x] Refresh Haier cards, mode tabs, temperature hierarchy, alerts, verification pill and cloud/discovery panel.
- [x] Keep fixed slots, names, commands, polling, verification gating and cloud-key handling untouched functionally.
- [x] Enlarge Haier actions, icon buttons, mode tabs, cloud fields and checkbox to touch-friendly sizes.
- [x] Re-run source guards, Home layout guard, screenshots, metrics, Haier tests and locked shell/body-colour checks.

### Evidence

The shared presentation layer now renders both Haier cards as border-led cards with wrapping names, 44×44px icon/action controls, distinct verified/unverified pills and high-contrast status text. Mode tabs, temperature buttons, quick actions and cloud-login inputs were enlarged without changing any `data-haier-*` attribute, command payload, polling interval or safety guard. The global eyebrow token was strengthened for light mode.

Commands and exact results:

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
```

```text
......                                                                   [100%]
6 passed in 0.48s
```

```powershell
node tests/test_pilot_home_layout.mjs
```

```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -u UI_REVIEW_TEMP\capture_ui.py UI_REVIEW_TEMP\after_batch3 after_batch3
```

```text
captured 60 shots to UI_REVIEW_TEMP\after_batch3
overflow failures: 0
page errors: 0
```

```powershell
python -u UI_REVIEW_TEMP\metrics_ui.py UI_REVIEW_TEMP\metrics_after_batch3.json
```

Corrected objective totals, Batch 2 → Batch 3:

```text
combinations      20 -> 20
overflow           0 -> 0
small targets     36 -> 10
visible overlaps   0 -> 0
low-contrast rows 27 -> 14
minimum contrast 1.24 -> 1.53
```

```powershell
python -m pytest tests/test_haier_pilot.py tests/test_haier_cloud_login.py -q
```

```text
..................                                                       [100%]
18 passed in 0.74s
```

```powershell
python -m pytest tests/test_ui.py -q -k "premium_local_shell or local_small_screen_tabs or local_layout_is_reachable or modular_frontend_starts"
```

```text
............                                                             [100%]
12 passed, 391 deselected in 262.16s (0:04:22)
```

The Haier selection covers LAN IP validation, stale-cache verification revocation, failed-refresh handling, confirmed-fields-only writes, per-slot locks, compressor/manual-override safety and cloud-key secrecy. No Python, API, protocol, key, auth, polling or handler file was changed.

## Batch 4 — Scenes and Settings `[COMPLETE]`

### Checklist

- [x] Refresh scene note, empty state, cards, editor fields, action builder and schedule controls.
- [x] Refresh Settings shortcuts, Family Hub, Safety & Automation cards and shared toast styling.
- [x] Keep scene ids, handlers, editor mounting, backup/restore, update, diagnostics, security and remote-access controls unchanged.
- [x] Re-run source guards, Home layout guard, screenshots, metrics, Scenes/Settings UI tests and safety-contract tests.

### Evidence

The Scenes editor inputs and selects now meet the 44px touch minimum. Scene cards, empty state and editor use the same border-led card language as the rest of the app; all text remains text-labelled and wraps. Settings helper text uses the stronger light-mode token so notes and shortcut captions stay readable. Family Hub, Safety & Automation and toast surfaces were restyled without touching their ids, handlers or API calls.

Commands and exact results:

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
```

```text
......                                                                   [100%]
6 passed in 0.13s
```

```powershell
node tests/test_pilot_home_layout.mjs
```

```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -u UI_REVIEW_TEMP\capture_ui.py UI_REVIEW_TEMP\after_batch4 after_batch4
```

```text
captured 60 shots to UI_REVIEW_TEMP\after_batch4
overflow failures: 0
page errors: 0
```

```powershell
python -u UI_REVIEW_TEMP\metrics_ui.py UI_REVIEW_TEMP\metrics_after_batch4.json
```

Corrected objective totals, Batch 3 → Batch 4:

```text
combinations      20 -> 20
overflow           0 -> 0
small targets     10 -> 0
visible overlaps   0 -> 0
low-contrast rows 14 -> 0
minimum contrast 1.53 -> 3.23
```

```powershell
python -m pytest tests/test_ui.py -q -k "premium_local_shell or local_scene_run or local_palette or local_small_screen_tabs or local_layout_is_reachable or modular_frontend_starts"
```

```text
..............                                                           [100%]
14 passed, 389 deselected in 329.40s (0:05:29)
```

```powershell
python -m pytest tests/test_pilot_extras.py -q -k "new_endpoints or safety_rules or backup_and_restore or restore_rejects_non_zip"
python -m pytest tests/test_critical_safety.py -q -k "critical_rule or scene_never"
```

```text
4 passed in 1.19s
2 passed, 5 deselected in 1.00s
```

No Python, API, protocol, key, auth, safety, backup, update, diagnostics or handler file was changed.

## Batch 5 — Micro-polish and final acceptance `[NOT STARTED]`

Evidence and checklist pending.

---

## Safety log

- Physical device commands sent: **0**
- Fake device data committed: **0**
- Backend/security/API files modified: **0**
- Pushes to `feature/smartpilot-premium-ui`: allowed CP0 documentation checkpoints only
- Merge/tag/release/deploy/PR/Azure actions: **0**
- Hardware verification claims: **0**
