# Smart Pilot UI/UX Progress

**Last updated:** 2026-11-24  
**Branch:** `feature/smartpilot-premium-ui`  
**Base HEAD:** `3fc711f Reliability hardening for v1.19`  
**Overall status:** CP0 verified and pushed; Android release-channel code changes paused pending approval; Batches 1–5 verified locally; final acceptance evidence recorded; push awaiting explicit approval

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

## Lovable typed backend adapter + v1.22 preparation `[COMPLETE]`

### Planned work
- Map the Lovable typed domain (`Device`, `AcDevice`, `SwitchDevice`, `Reported<T>`, `DeviceCommand`, `CommandResult`) onto the existing `/api/local/*` Flask backend via a new presentation-layer adapter (`static/js/features/local-control/adapter.js`), byte-mirrored to the Android and add-on source copies.
- Wire `window.pilotAdapter` from `local-control/main.js` (all three mirrors kept byte-identical).
- Keep real hardware commands disabled: `isLive` flips only after a verified LAN read; preview mode returns "Preview only — Not sent to device."; `requiresApproval` devices refuse commands without explicit approval.
- Bump Android metadata to v1.22 (`versionCode 23`, `versionName '1.22'`) preserving package identity and pinned signer.
- Add `tests/test_pilot_adapter.mjs` (no network, no command POST) and update `docs/LOVABLE_ANDROID_INTEGRATION.md`.

### Evidence

New/changed source files (presentation only; no Python backend, API, protocol, key, auth or safety change):

```
static/js/features/local-control/adapter.js                 (new)
android_offline/app/src/main/python/static/js/features/local-control/adapter.js   (mirror)
tuya_local_key/app/static/js/features/local-control/adapter.js                    (mirror)
static/js/features/local-control/main.js                    (adapter import + window.pilotAdapter)
android_offline/app/src/main/python/static/js/features/local-control/main.js   (mirror)
tuya_local_key/app/static/js/features/local-control/main.js                    (mirror)
android_offline/app/build.gradle                            (versionCode 22 -> 23, versionName 1.21 -> 1.22)
tests/test_pilot_adapter.mjs                                (new)
docs/LOVABLE_ANDROID_INTEGRATION.md                         (updated)
```

Committed in CP7: the generated `pilot-next/` Lovable WebView bundle (`index.html`, `assets/index-*.js`, `assets/index-*.css`, `SOURCE_COMMIT.txt`) mirrored byte-identically to all three runtime copies (root `static/`, Android Python source, add-on source), plus the matching `tools/build_lovable_webview.py` overflow fix. Still uncommitted: temp/build noise (`.gradle-home/`, `UI_REVIEW_TEMP/`).

Verification commands and exact results:

```powershell
node tests/test_pilot_adapter.mjs
```
```text
Adapter read-only mapping, verified-only power, preview and approval gating: PASS
```

```powershell
node tests/test_pilot_home_layout.mjs
```
```text
Home layout state, reorder, hide, restore and escaping: PASS
```

```powershell
python -m pytest tests/test_pilot_v07_static.py tests/test_titanium_ui.py tests/test_packaging.py tests/test_update_dependencies.py -q
```
```text
45 passed in 50.96s
```

Mirror/source-sync guard `test_web_android_and_addon_are_source_synced` passes (all three `main.js` copies byte-identical).

Signed v1.22 APK artifact (built locally, NOT uploaded/tagged/released):

```
dist/TuyaLocalKey-Offline.apk   46,927,037 bytes
dist/SmartPilot-Local.apk       46,927,037 bytes
SHA-256: 6B6841FFC3BB4ACD5DFB8F22079A83976305F55D77EBB0D72130E8890FFB7318
package: com.example.tuyalocalkey.offline.v2.debug
versionCode: 23   versionName: 1.22
signer SHA-256: bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f (pinned, matches)
scheme v2: verified, 1 signer
```

Explicit exclusions honored:
- No physical device command sent (adapter returns `delivered: false` in preview; no command POST in tests).
- No fake device state committed (Reported<T> is known only from real reads).
- No push, merge, tag, release, deploy, PR or Azure action performed yet (this milestone's push is the next step).
- `pilot-next/` generated bundle now committed in CP7 (all three mirrors byte-identical); still preview-only and reached through the existing ✦ header link, not the default screen.

## CP7 — Apply the Lovable UI bundle to the repository `[COMPLETE]`

### What was actually missing
The Lovable "Titanium Control" UI was staged as untracked files in the Android
source tree only. The Flask route `/pilot-next`, the read-only snapshot API and
the ✦ header link were already committed, but a fresh clone had **no bundle** —
so the ✦ link would have served an empty page. The built v1.22 APK did contain
the bundle inside Chaquopy `assets/chaquopy/app.imy` (6 `static/pilot-next/*`
entries), but that artifact was built from the working tree, not from committed
source.

### Applied changes
- Copied the pinned Lovable bundle (`SOURCE_COMMIT.txt` = `ef0f9f88…`) byte-identically to all three runtime copies: root `static/pilot-next/`, `android_offline/app/src/main/python/static/pilot-next/`, `tuya_local_key/app/static/pilot-next/`.
- Committed the matching `tools/build_lovable_webview.py` overflow fix (`html,body{margin:0;overflow-x:hidden}` and `#pilot-next-root{max-width:100vw;overflow-x:hidden}`) so regeneration reproduces the committed `index.html`.
- No Python backend, API, protocol, auth, device-command or template change.

### Evidence
Mirror verification (SHA-256 first 16 hex, all three copies identical):
```
index.html                 3E42570B5AEF7A2F | 3E42570B5AEF7A2F | 3E42570B5AEF7A2F
SOURCE_COMMIT.txt          2E014F2CD63CE897 | 2E014F2CD63CE897 | 2E014F2CD63CE897
assets/index-Gc5PqH-j.js    5C73C8F4D579EE5C | 5C73C8F4D579EE5C | 5C73C8F4D579EE5C
assets/index-lhkNRLjW.css   0BF288E03DB80B47 | 0BF288E03DB80B47 | 0BF288E03DB80B47
```

```powershell
python -m pytest tests/test_titanium_ui.py tests/test_pilot_v07_static.py -q
```
```text
13 passed in 0.98s
```

Read-only mocked-browser check (`UI_REVIEW_TEMP/shot_compare.py`, local launcher,
no hardware commands), 390px and 1280px:

```
[/local @ 390]       status=200 title='Smart Pilot · Local Devices'  overflow=False
[/pilot-next @ 390]  status=200 title='Smart Pilot | Titanium Preview'
                     rootChildren=3 safety=True overflow=False pageerrors=[]
[/local @ 1280]      status=200 overflow=False
[/pilot-next @ 1280] status=200 body starts 'Smart Pilot / Titanium Control / Overview / Devices …'
                     overflow=False pageerrors=[]
```

APK archive proof (built v1.22, `dist/TuyaLocalKey-Offline.apk`):
```
assets/chaquopy/app.imy -> static/pilot-next/ (6 entries, incl. index.html,
index-Gc5PqH-j.js, index-lhkNRLjW.css, SOURCE_COMMIT.txt)
```

### Scope boundary
The Lovable UI remains a **preview-only** page at `/pilot-next` reached via the
existing ✦ header link. It deliberately issues no hardware commands and the app
still opens `/local` by default, per the safety contract. Making `/pilot-next`
the default screen requires an explicit decision and a safe migration of the
real command path; it is **not** done here.

## CP8 — Lovable Titanium design ported onto /local `[VERIFIED]`

### Applied
Added section 10 to `static/css/pilot-premium-ui.css` (byte-mirrored to the
Android and add-on source copies): a token-only reskin that maps the pinned
Lovable "Midnight Titanium" design system onto the existing local-control DOM.
No template, JS, backend, API, auth, protocol, device-command or data-attribute
change. `--bg` is deliberately untouched.

- Dark: cyan `#7dd3fc` primary, cobalt `#8b7cf6`, emerald `#5eead4`, amber `#fbbf24`, coral `#fb7185`; glass surface/border tokens and 14-20px radii.
- Light and system-light: `#2563eb` primary with matching emerald/amber/danger tokens.
- Token-only approach adds no new `!important` chains; existing rules read the overridden variables.
- WebView-safe hex/rgba only — no `oklch()`, `color-mix()` or heavy blur.
- Icon buttons no longer flex-shrink below 44px at tablet widths.

### Evidence
```powershell
python -m pytest tests/test_ui.py -q -k "modular_frontend"
```
```text
4 passed, 412 deselected in 9.08s   (includes exact body-background assertion in both themes)
```

```powershell
python -m pytest tests/test_pilot_v07_static.py tests/test_titanium_ui.py tests/test_ui_power_capabilities.py tests/test_android_entry.py -q
```
```text
18 passed in 0.41s
```

```powershell
python -m pytest tests/test_ui.py -q -k "brand_exits_selection or setup_card_layouts or menu_button_is_as_tall" --tb=short
```
```text
20 passed, 396 deselected in 75.09s
```

```powershell
node tests/test_pilot_home_layout.mjs
```
```text
Home layout state, reorder, hide, restore and escaping: PASS
```

Mocked read-only browser metrics (`UI_REVIEW_TEMP/check_titanium.py`), 320/390/768/1280 × dark/light:

| theme | accent | ok | warn | body bg | overflow | page errors | small targets |
|---|---|---|---|---|---|---|---|
| dark | `#7dd3fc` | `#5eead4` | `#fbbf24` | `rgb(8,16,35)` | false | 0 | 0 |
| light | `#2563eb` | `#0f9d76` | `#b45309` | `rgb(237,245,252)` | false | 0 | 0 |

Five nav destinations remain exactly `home, devices, autopilot, scenes, settings`.

Rebuilt signed v1.22 APK (contains the new CSS, verified by reading
`assets/chaquopy/app.imy` → `static/css/pilot-premium-ui.css`; `#7dd3fc` and
the Titanium header are present; the 6 `pilot-next` bundle entries are preserved):

```text
dist/SmartPilot-Local.apk   46,928,494 bytes
SHA-256: 3D472C4321FED64E5782D269821C456B90D115780E6CAEE6576DFB72989A4B5E
package: com.example.tuyalocalkey.offline.v2.debug
versionCode: 23   versionName: 1.22
signer SHA-256: bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f
APK Signature Scheme v2: Verified, 1 signer
```

Git: committed `9370425` and pushed to `origin/feature/smartpilot-premium-ui`.

## GitHub checkpoint log

| Checkpoint | Milestone | Status |
|---|---|---|
| CP0 | Planning, isolation and audit | verified, committed `ed97a10418fa2c9ca4c7e1ee5d60d1d7555f37cc`, pushed |
| CP1 | Design system, navigation, Home | verified; committed `322dd66`, pushed |
| CP2 | Devices | verified; committed `322dd66`, pushed |
| CP3 | Auto-Pilot | verified; committed `c276b7c`, pushed |
| CP4 | Scenes and Settings | verified; committed `4993f25`, pushed |
| CP5 | Micro-polish and final acceptance | verified; committed `27a1deb`, pushed |
| CP6 | Lovable typed backend adapter + v1.22 preparation | verified; committed `b1a854f3aee0d884491f3bdd3de093b76388d7b7`, pushed to `feature/smartpilot-premium-ui` |
| CP7 | Apply Lovable UI bundle to repository (3 mirrors) | verified; committed `957cafc11e36caa9a1bb410f14154da0da41208f`, pushed |
| CP8 | Lovable Titanium design ported onto /local | verified; committed `9370425`, pushed; APK rebuilt and verified |

All five UI batches plus CP6 are on `feature/smartpilot-premium-ui`. Normal fast-forward push to `origin feature/smartpilot-premium-ui` is the next step. No PR, merge, tag, release or deploy performed.

### Final push evidence

Command:

```powershell
git push origin feature/smartpilot-premium-ui
```

Result:

```text
To https://github.com/Muhammadusamataj/Smartpilot-local-first-home.git
   9cd99b3..27a1deb  feature/smartpilot-premium-ui -> feature/smartpilot-premium-ui
```

Remote verification:

```text
local HEAD:   27a1debd3441f234db05fa120539bf37e8550e97
origin HEAD:  27a1debd3441f234db05fa120539bf37e8550e97
ls-remote:    27a1debd3441f234db05fa120539bf37e8550e97  refs/heads/feature/smartpilot-premium-ui
```

Branch is in sync (`## feature/smartpilot-premium-ui...origin/feature/smartpilot-premium-ui`, no ahead/behind). No PR, merge, tag, release or deploy was performed.

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

## Batch 5 — Micro-polish and final acceptance `[COMPLETE]`

### Checklist

- [x] Shared toast/sheet surfaces, reduced motion, focus rings, high-contrast and non-colour-only status verified.
- [x] Five-view contract, deep links, `data-jump-view`, drawers, sheets, Escape/back, long names, empty/stale and critical two-tap guard verified with mocked APIs.
- [x] Full 60-shot screenshot matrix and objective metrics clean in both themes at all six widths.
- [x] System-theme following, theme parity and no-device-command assertion verified.
- [x] Full UI suite and source/mirror guards run against the frozen tree.

### Evidence

A dedicated mocked acceptance harness (`acceptance_ui.py`, all `/api/**` fulfilled from fixtures) exercised every theme and recorded any command call. The final run passed **40/40** checks: exact five-view order and `aria-selected`/panel consistency, deep-link device filtering **including the visible tile count**, `data-jump-view`, visible keyboard focus rings, Escape closing both drawers/sheet and clearing the scrim, critical-device two-tap arming with **zero command calls** on the first tap, long-name wrapping and no horizontal overflow at 320px, empty-list rendering, no page errors, and reduced-motion transition suppression. A separate theme harness passed 4/4: no stored override follows the OS in both directions, and explicit light/dark overrides win regardless of OS scheme. A state harness passed 3/3: exact Haier slot names, distinct text status for online vs unreachable, and non-colour-only status class/text.

### Regression found and fixed during final acceptance

The first full-suite run exposed `test_control_link_opens_the_local_page_focused_on_that_device` failing with `3` visible tiles where `1` was expected. Root cause: this presentation layer's `#devices .tile { display: flex !important }` overrode the HTML `hidden` attribute that `applyFilter()` uses, so filtered-out tiles stayed visible. The original 38-check harness had only asserted the search input value, not tile visibility, so it missed this. A dedicated `hidden` diagnostic confirmed exactly two filtered-out tiles had a computed `display` of `flex` despite `[hidden]`.

Fix: added a scoped hidden-attribute preservation rule (section 8b of `pilot-premium-ui.css`) covering tiles, room groups, home mini tiles, view panels, scene editors, Haier config, device-empty and update controls. No handler, id, class or API was changed. Verification after the fix: `hidden` diagnostic `0` violations; the previously failing UI test `1 passed in 35.16s`; acceptance harness strengthened to assert visible tile count, now `40/40`.

Commands and exact results:

```powershell
python -u UI_REVIEW_TEMP\acceptance_ui.py UI_REVIEW_TEMP\acceptance_report_final.json
```

```text
acceptance checks: 40 / 40 passed
```

```powershell
python -u UI_REVIEW_TEMP\hidden_check.py
```

```text
elements with [hidden] but non-none display: 0
```

```powershell
python -m pytest "tests/test_ui.py::test_control_link_opens_the_local_page_focused_on_that_device" -q
```

```text
.                                                                        [100%]
1 passed in 35.16s
```

```powershell
python -u UI_REVIEW_TEMP\theme_check.py
```

```text
theme checks: 4 / 4 passed
  OK   light OS, no override -> light -> {'themeAttr': None, 'bg': 'rgb(237, 245, 252)'}
  OK   dark OS, no override -> dark -> {'themeAttr': None, 'bg': 'rgb(8, 16, 35)'}
  OK   light OS, explicit dark -> dark -> {'themeAttr': 'dark', 'bg': 'rgb(8, 16, 35)'}
  OK   dark OS, explicit light -> light -> {'themeAttr': 'light', 'bg': 'rgb(237, 245, 252)'}
```

```powershell
python -u UI_REVIEW_TEMP\state_check.py
```

```text
state checks: 3 / 3 passed
  OK   two Haier slots named exactly -> ['19HFAB T3 Pro', 'FF Haier 19HFAB T3']
  OK   online and stale statuses shown as distinct text -> Online / Unreachable
  OK   status is not colour-only (text + class)
```

```powershell
python -m pytest tests/test_pilot_v07_static.py -q
node tests/test_pilot_home_layout.mjs
```

```text
6 passed in 0.17s
Home layout state, reorder, hide, restore and escaping: PASS
```

Source and mirror parity against the final corrected tree:

```text
templates/local_control.html + both mirrors: SHA-256 95A2E8C1...FEDD9E0D6 (identical)
pilot-premium-ui.css + both mirrors: SHA-256 F8755219...D4615F656 (identical)
Only template change vs base: one <link rel="stylesheet" href="static/css/pilot-premium-ui.css"> line
```

Mocked screenshots and objective metrics were re-run after the hidden-attribute fix (`after_fix`): 60 shots, `overflow failures: 0`, `page errors: 0`, and 20/20 combinations with `overflow 0`, `small targets 0`, `visible overlaps 0`, `low-contrast rows 0`, minimum contrast `3.23`. Totals were unchanged from Batch 4 (`20, 0, 0, 0, 0, 3.23`), confirming the fix was presentation-neutral for visible states.

Non-UI diff scope (`git diff 3fc711f..HEAD`) contains only the three mirrored premium CSS files, the three mirrored templates (CSS link only), `AGENTS.md` (CP0 project instructions) and the UI/UX docs. No Python backend, API, protocol, key, auth, safety, backup, update, diagnostics or security file was changed.

Full UI suite re-run against the final corrected CSS (hidden-attribute fix included):

```powershell
python -m pytest tests/test_ui.py -q
```

```text
UI screenshots: test-results/ui/index.html  (generated, gitignored)
403 passed in 1451.54s (0:24:11)
```

This is the complete `tests/test_ui.py` suite, not a subset. It supersedes the earlier stale run that found the single `hidden`-attribute regression before the fix. With all 403 UI tests plus the source guards, Home layout guard, 40/40 acceptance harness, 4/4 theme checks, 3/3 state checks, 60 mocked screenshots and clean objective metrics, the UI acceptance checklist is verified.

---

## v1.20 release — premium UI APK `[PUBLISHED]`

The user explicitly authorized a full release, overriding the presentation-only pause for the Android release channel. Only Android version metadata changed for the release: `android_offline/app/build.gradle` `versionCode 20 -> 21`, `versionName 1.19 -> 1.20`. `pyproject.toml` (pip package version `4.7.0`) was deliberately not changed — that is a different product/update path. No Python backend, device, protocol, auth, safety, diagnostics, backup, update-logic, security or API file was changed.

Commit `17c8b58c154b25410a207b34e6616b1967f311ec` ("release(ui): bump offline APK to v1.20") was pushed to `feature/smartpilot-premium-ui`. Pre-release guards `tests/test_packaging.py tests/test_update_dependencies.py`: `32 passed in 0.50s`.

Build and verification:

```text
+ signing key OK: bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f
BUILD SUCCESSFUL in 29s
+ verified signer SHA-256 bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f
```

- APK manifest (aapt2): `versionCode='21' versionName='1.20'`, package `com.example.tuyalocalkey.offline.v2.debug`.
- APK SHA-256 `EF52191ED50BD418E82F53A05AFFA33533BE03A24B299959066BE204188CB00C`, 45,218,820 bytes.
- The premium CSS is byte-identical inside the APK's Chaquopy `app.imy` (SHA-256 `F8755219...D4615F656`); bundled template keeps the five views in order `home, devices, autopilot, scenes, settings` and the hidden-attribute preservation rule.
- Source mirrors stayed byte-identical after the build's source sync; working tree clean.

GitHub release:

```text
https://github.com/Muhammadusamataj/Smartpilot-local-first-home/releases/tag/v1.20
tag v1.20 -> 17c8b58c154b25410a207b34e6616b1967f311ec
isDraft=false  isPrerelease=false  Latest
asset SmartPilot-Local.apk: downloaded 45,218,820 bytes, SHA-256 matches the built APK
```

No device install was performed; install is left to the user. PR #4 and PR #5 were not touched.

---

## Safety log

- Physical device commands sent: **0**
- Fake device data committed: **0**
- Backend/security/API files modified: **0**
- Pushes to `feature/smartpilot-premium-ui`: all milestones plus the v1.20 release commit and evidence
- Merge/tag/release/deploy/PR/Azure actions: GitHub Release `v1.20` published with explicit user approval; no merge, PR, deploy or Azure action
- Hardware verification claims: **0**

## Independent Android re-audit

The isolated audit branch starts at `0712e315dd11b6a7ef332bbfb4d4941f6cc36dfe`.
Main and v1.18 point to `ec2382547c50378ffaff4884a07f25d9b19c536e`.
PR #5 contains v1.19 hardening and is an ancestor of the premium branch.
Draft PR #4 adds six presentation files on an older base. Its snapshot was not adopted.

The first checkpoint links all five tabs to their named panels and adds roving
keyboard focus with Left, Right, Home and End. Existing selection, deep links,
visibility and view handlers remain in place. The canonical template and module
are synchronized to both packaging mirrors.

- Source, packaging and dependency guards: `python -m pytest --basetemp ../pytest-guards tests/test_pilot_v07_static.py tests/test_packaging.py tests/test_update_dependencies.py -q --tb=short` passed 38 tests.
- `node tests/test_pilot_home_layout.mjs` passed.
- `python build_offline_apk.py` stopped at SDK discovery because ANDROID_HOME and ANDROID_SDK_ROOT were unset. No new APK or signing verification.
- The previous 403-test result predates this change. Historical screenshots and custom acceptance scripts referenced as UI_REVIEW_TEMP are outside Git.
- The native updater fetches releases/latest and explicitly rejects prereleases. The Python update path also uses releases/latest and rejects prereleases. Preview detection requires a separate opt-in Android channel with version, digest and signer validation.
- Final mocked Chromium capture: 60 PNGs across six viewport widths, light and dark modes, and all five tabs. No document-width overflow, hidden active panel, or uncaught page error was observed. The fixtures cover a long Tuya label and two climate slots with different verification states. Physical requests were intercepted.
- Visual inspection of the light Devices/Settings and dark Auto-Pilot screenshots found empty amber warning outlines on the Family sharing and Haier cloud forms. Empty warning regions now collapse their margin, padding and border while retaining live status semantics. Source CSS hashes match in all three trees.
- A separate mocked Chromium keyboard check passed all four transitions, including wrapping from Home to Settings and back. Each transition verified the focused tab, selected state, named panel, and single tab stop.

### Auto-Pilot layout checkpoint

Moved the local climate cards ahead of the optional cloud key renewal form in
document order. Both Haier slots, configuration controls, form handlers and API
calls are preserved. The 390px dark capture shows the first local card in the
initial viewport. The refreshed 60-shot matrix reported zero width-overflow or
panel failures and zero uncaught page errors.

- `python -m pytest --basetemp ../pytest-final-mirrors tests/test_pilot_v07_static.py -q --tb=short`: 6 passed.
- `python -m pytest --basetemp ../pytest-climate-elevated tests/test_haier_pilot.py tests/test_haier_cloud_login.py -q --tb=short`: 18 passed, including the synthetic loopback handshake. The sandboxed attempt stalled at the loopback test.
- GitHub's latest release endpoint returned v1.20 with draft and prerelease both false.
- Focused browser regression run started at the first checkpoint: `python -m pytest --basetemp ../pytest-browser-verified tests/test_ui.py -q -k 'local_tabs_support or local_layout_is_reachable or local_card_tap or local_critical_switch or local_scene_run or premium_local_shell' --tb=short`: 11 passed, 393 deselected in 355.61s. The later climate-order change was covered by the refreshed screenshot matrix and the Haier and mirror guards above.

## Android v1.21 finalization — in progress

- Preserved audit commits 8273881 and 64398ec on codex/android-ui-audit.
  `git merge --ff-only codex/android-ui-audit` fast-forwarded local
  feature/smartpilot-premium-ui. GitHub compare confirmed the remote remains at
  0712e31. `git push origin feature/smartpilot-premium-ui` failed at DNS
  (getaddrinfo). Sandbox escalation was automatically rejected. No remote ref changed.
- Mirrored the modal markup and interaction changes. Device details and Advanced
  settings have accessible dialog names, focus entry, an inert background,
  Tab and Shift+Tab wrapping, and focus return on dismissal. Android Back
  queries the same dismissal handler before WebView history or Activity exit.
  The Playwright tests include drawer and sheet regression cases.
- `python -m pytest --basetemp ../final-guards-after tests/test_pilot_v07_static.py tests/test_packaging.py tests/test_update_dependencies.py -q --tb=short`: 38 passed.
  `node tests/test_pilot_home_layout.mjs` and JS syntax check passed.
- `python -m pytest --collect-only -q tests/test_ui.py`: 405 collected.
  Full Playwright, targeted modal checks and the screenshot recapture did not
  produce a pass/fail result in this session. A loopback TCP connectivity probe
  returned WinError 10013. Prior screenshots are baseline evidence only.
- Located the installed Android SDK with platform 34, build-tools 34.0.0,
  platform-tools and command-line tools. Exported ANDROID_HOME and ANDROID_SDK_ROOT
  to the same SDK for the build. The prospective configuration uses v1.21,
  versionCode 22 and the existing debug package ID.
- `python build_offline_apk.py` verified the source signing key fingerprint
  bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f, then failed
  on the Gradle wrapper lock outside the workspace. Retried with a workspace
  Gradle home and the installed Gradle 8.7 runner. Offline assembleDebug
  could not connect to the Gradle daemon. APK hash and signer remain unverified.
- Stable/Beta implementation is proposed in the master plan. The native and
  Python update paths remain stable-only. No tag, prerelease, install or
  hardware action was performed.

### Autonomous continuation checkpoint

- The local feature branch preserves both audit commits and adds CI checkpoint
  093871477949288efcac392225cd7b8df81db36f. The original audit branch still
  points to 64398ec. The CI YAML was parsed and checked for the authorized
  feature push trigger, full pytest command and screenshot artifact path.
- The previous CI workflow ran on main pushes or pull requests. The checkpoint
  adds the authorized branch to the existing push trigger and scopes screenshot
  upload to that branch. GitHub confirmed 64398ec is absent and the remote
  feature ref is still at 0712e31. Normal push continues to fail at DNS.
  The connector can update a ref to an existing remote object, but the local
  objects must first be uploaded with their commit identities intact.
- Working-tree changes preserve the modal/Android Back work, pass real opener
  elements to restore focus, remove redundant keyboard stops inside the sheet,
  and contain overlay scroll chaining. Device-list failures clear aria-busy
  and report an unavailable list. An empty inventory is distinguished from
  a filter with no matches.
- Added mocked Playwright cases for loading, empty, error, pending, busy,
  uncertain and rejected requests. Expanded the layout test to exercise and
  capture all five views across two system colour schemes and all six widths.
- The focused safety, source and packaging run passed 66 tests with the
  synthetic loopback handshake deselected due to the demonstrated socket
  restriction. Command:
  `python -m pytest --basetemp ../mission-final-checks tests/test_pilot_v07_static.py tests/test_packaging.py tests/test_update_dependencies.py tests/test_critical_safety.py tests/test_pilot_extras.py tests/test_haier_pilot.py tests/test_haier_cloud_login.py -q --tb=short -k 'not socket_handshake_with_synthetic_device'`.
  Node Home layout, module syntax check and git diff whitespace check passed.
- The browser suite collects 416 cases. The new browser tests, screenshot
  matrix and native behavior still require execution. Candidate source stays
  outside the verified CI commit. A portable bundle preserves the committed
  history and a separate patch preserves the browser/build candidate changes.
- Android build and release remain gated on an actual APK and full test evidence.
  A runner for signing must have the existing key under private control. The
  repository's update-logic restriction remains in force. No Beta logic was
  changed or published.

## Codex recovery integration — verified checkpoint `[IN PROGRESS]`

- Recovered the missing history from `smart-pilot-verified-checkpoints.bundle`.
  `git bundle verify` reported: 1 ref (`093871477949288efcac392225cd7b8df81db36f`),
  requires `0712e315dd11b6a7ef332bbfb4d4941f6cc36dfe`, bundle is okay. Created
  backup ref `backup/pre-codex-recovery-0712e31` at the pre-recovery HEAD.
- Fetched the bundle into isolated ref `codex-recovery/premium-ui`. Both reported
  commits exist: `64398ec6a2a5035a673908c12315654aa1ca401f` (local climate before
  optional cloud setup) and `093871477949288efcac392225cd7b8df81db36f` (feature-branch
  regression CI). A third recovered commit `8273881a12f747b073fc17411231b1ebfea68e97`
  adds ARIA tablist semantics and keyboard tab navigation. Ancestry verified:
  bundle head descends directly from `0712e315` with 3 commits.
- Audited `smart-pilot-android-candidate.patch` before applying: 57,071 bytes,
  valid UTF-8, zero replacement characters, no secrets/credentials, no weakened
  assertions. `git apply --check` failed against `0712e315` but passed cleanly
  against the bundle head in an isolated worktree. The patch contains modal focus
  management, Android Back dismissal, strengthened mocked tests, Android v1.21
  metadata (versionCode 22) and evidence docs.
- Fast-forwarded `feature/smartpilot-premium-ui` from `0712e315` to bundle head
  `0938714` with `git merge --ff-only codex-recovery/premium-ui` (exit 0), then
  applied the candidate patch (`git apply --check` exit 0, `git apply` exit 0).
- Verified all three mirrored presentation files are byte-identical across
  `static/`, `android_offline/app/src/main/python/` and `tuya_local_key/app/`:
  `pilot-premium-ui.css` SHA-256 `6ABBCB95…76656`, `main.js` SHA-256
  `0C9D0980…8905`, `local_control.html` SHA-256 `48BCB2A6…E031D`.
- Commands and results in this environment:
  `python -m pytest --basetemp ../codex-mission-guards tests/test_pilot_v07_static.py tests/test_packaging.py tests/test_update_dependencies.py -q --tb=short` → **38 passed in 1.05s**;
  `node tests/test_pilot_home_layout.mjs` → `Home layout state, reorder, hide, restore and escaping: PASS`;
  `python -m pytest --collect-only -q tests/test_ui.py` → **416 tests collected in 2.31s**.
- Previously pending gates are now executed and recorded in the final section below.
  Release mode changed from prerelease to **normal stable release** by explicit user
  instruction: the installed in-app updater only reads `/releases/latest` and
  rejects drafts/prereleases.

## Android v1.21 — final verification and stable release `[IN PROGRESS]`

- Full local browser suite:
  `python -m pytest --basetemp ../codex-full-ui tests/test_ui.py -q --tb=short`
  → **416 passed in 2041.91s (0:34:01)**. `test-results/ui/index.html` generated.
- GitHub Actions run `45345487223` on this branch: **both jobs success**;
  `pytest -q` → **1174 passed in 679.55s (0:11:19)**; mocked Android screenshot
  artifact uploaded. URL:
  `https://github.com/Muhammadusamataj/Smartpilot-local-first-home/actions/runs/45345487223`.
- Dedicated mocked harnesses: `acceptance_ui.py` **40/40**, `theme_check.py`
  **4/4**, `state_check.py` **3/3** (exact Haier slot names and distinct
  stale/offline text), `metrics_ui.py` **20 combos / 0 overflow / 0 small targets /
  0 overlaps / 0 low-contrast / min contrast 3.23**.
- Safety/packaging:
  `python -m pytest --basetemp ../codex-final-safety tests/test_pilot_v07_static.py tests/test_packaging.py tests/test_update_dependencies.py tests/test_critical_safety.py tests/test_pilot_extras.py tests/test_haier_pilot.py tests/test_haier_cloud_login.py -q --tb=short -k 'not socket_handshake_with_synthetic_device'`
  → **66 passed, 1 deselected in 6.68s**. Home layout guard PASS; `node --check`
  passed on all three mirrored JS files.
- Screenshot matrix: `check_v121_screenshots.py` → **60/60** PNGs, widths
  320/360/390/412/768/1280, both themes, five views, all 844px tall, zero invalid
  or missing files. The producing tests asserted zero page errors and zero
  horizontal overflow.
- APK: `python -u build_offline_apk.py --sdk-root 'C:\Users\abc\AppData\Local\Android\Sdk'`
  → **BUILD SUCCESSFUL in 1m 4s** with pinned signer
  `bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f`.
  `verify_v121.py` → package `com.example.tuyalocalkey.offline.v2.debug`,
  `versionCode 22`, `versionName 1.21`, size **45,218,820** bytes, SHA-256
  `25918E1864E8F3B80B57B5B863AC8A7E30D120E1F521B379FD7D6AC58414EEEA`; bundled
  CSS SHA-256 `6ABBCB9570C70CCABDF4ADB02BB1A47A71248B2F4241E64BBD679D60DEC76656`
  matches source; five-view order and Android Back hook confirmed inside `app.imy`.
- Installer compatibility checked read-only on the user's Vivo over wireless
  debugging `192.168.10.38:42039`: installed package is currently **v1.20 /
  versionCode 21**. No install, uninstall or data clear was performed.
- Updater contract verified read-only in `UpdateManager.java`: `/releases/latest`,
  requires `draft=false` and `prerelease=false`, parses numeric `tag_name`, and
  prefers an APK asset whose filename contains `smartpilot`. Therefore this
  checkpoint publishes a **stable** `v1.21` tag with exactly one APK asset.
- Physical device commands sent: **0**. No credentials, keystores or private data
  staged. No merge, force-push, stable-tag overwrite or remote branch deletion.
- Stable release published: `v1.21`, `isDraft=false`, `isPrerelease=false`,
  URL `https://github.com/Muhammadusamataj/Smartpilot-local-first-home/releases/tag/v1.21`.
  `/releases/latest` returns `v1.21` with exactly four assets: the signed APK,
  its SHA-256 checksum, `CHANGELOG-v1.21.md` and `TEST_RESULTS-v1.21.md`; no EXE.
  Downloaded APK re-verified: 45,218,820 bytes, SHA-256
  `25918e1864e8f3b80b57b5b863ac8a7e30d120e1f521b379fd7d6ac58414eeea`,
  package `com.example.tuyalocalkey.offline.v2.debug`, `versionCode 22`,
  signer `bbe14afd…d7adf00f`. The existing updater can now detect v1.21 because
  it reads `/releases/latest` and rejects drafts/prereleases.
- On-device update confirmed by the user and verified read-only over wireless
  debugging: the installed package changed from **v1.20 / versionCode 21** to
  **v1.21 / versionCode 22** (`lastUpdateTime=2026-11-24 12:52:47`) while
  `firstInstallTime` remained `2026-11-22 18:08:15`, proving an in-place upgrade
  with no uninstall or data clear. The wireless debugging connection went offline
  immediately afterwards, so a full installed-APK pull/signer dump was not
  completed; the successful in-place install itself confirms signing-certificate
  compatibility, and the published APK signer was independently verified above.
- Milestone status: **software gates complete, stable release published, and
  user-side update to v1.21 confirmed on the Vivo**. TalkBack/touch/Back hardware
  acceptance remains a separately approved activity; no physical device command
  was sent by this workflow.
