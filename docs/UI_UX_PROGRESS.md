# Smart Pilot UI/UX Progress

**Last updated:** 2026-11-24  
**Branch:** `feature/smartpilot-premium-ui`  
**Base HEAD:** `3fc711f Reliability hardening for v1.19`  
**Overall status:** Batch 0 verified; CP0 commit/push pending; Batch 1 not started

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

---

## GitHub checkpoint log

| Checkpoint | Milestone | Status |
|---|---|---|
| CP0 | Planning, isolation and audit | verified, committed `ed97a10418fa2c9ca4c7e1ee5d60d1d7555f37cc`, pushed |
| CP1 | Design system, navigation, Home | not started |
| CP2 | Devices | not started |
| CP3 | Auto-Pilot | not started |
| CP4 | Scenes and Settings | not started |
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

## Batch 1 — Design system, navigation, Home `[NOT STARTED]`

### Planned work

- [ ] Add `static/css/pilot-premium-ui.css` as a single presentation layer.
- [ ] Add semantic tokens and system-theme-following dark/light rules.
- [ ] Refresh app bar and five-tab navigation.
- [ ] Refresh Home hierarchy, AC overview and Tuya quick tiles.
- [ ] Load the new CSS in all mirrored templates.
- [ ] Run source/mirror guards.
- [ ] Run focused UI tests.
- [ ] Capture after screenshots at 320/360/390/412/768/1280 in both themes.
- [ ] Compare objective metrics against baseline.
- [ ] Update this progress file with exact results.

### Evidence

Pending.

---

## Batch 2 — Devices `[NOT STARTED]`

Evidence and checklist pending.

## Batch 3 — Auto-Pilot `[NOT STARTED]`

Evidence and checklist pending.

## Batch 4 — Scenes and Settings `[NOT STARTED]`

Evidence and checklist pending.

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
