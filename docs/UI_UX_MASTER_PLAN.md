# Smart Pilot UI/UX Master Plan

**Status:** active  
**Branch:** `feature/smartpilot-premium-ui` (pushed after verified checkpoints)  
**Base commit:** `3fc711f` — v1.19 reliability hardening, built on stable v1.18 `ec23825`  
**Scope:** UI/UX only — presentation, layout, accessibility and micro-interactions

---

## 1. Mission

Create an original premium interface for the existing Smart Pilot local-control app. The redesign must make all five screens calmer, more legible and more trustworthy on Android WebView and desktop widths while preserving every existing device, automation, safety and backend behaviour.

This is **not** a rewrite. It is a presentation layer over the existing DOM and JS contracts.

### Required outcome

- Home, Devices, Auto-Pilot, Scenes and Settings look like one coherent product.
- Dark and light modes are both complete and readable.
- Status, verification and command safety are immediately understandable.
- Long names, empty lists, slow loads, stale/offline states and narrow screens are handled without overflow or dead controls.
- Every improvement is backed by test evidence and recorded in `docs/UI_UX_PROGRESS.md`.

---

## 2. Screens and preserved contracts

### 2.1 Navigation — exact five destinations

| DOM order | `data-view` | Panel selector | Purpose |
|---:|---|---|---|
| 1 | `home` | `[data-view-panel="home"]` | Dashboard, AC overview, Tuya quick tiles, customization |
| 2 | `devices` | `[data-view-panel="devices"]` | Search, device cards, details sheet, live controls |
| 3 | `autopilot` | `[data-view-panel="autopilot"]` | Two Haier AC cards, Manual/Auto, cloud/discovery |
| 4 | `scenes` | `[data-view-panel="scenes"]` | Saved scenes, scheduler info, scene editor |
| 5 | `settings` | `[data-view-panel="settings"]` | Family Hub, network, safety, backup, updates, advanced drawer |

Legacy aliases `ac → autopilot` and `advanced → settings` must keep working in `setView()`.

### 2.2 Home

Preserve:

- `#summary` live text written by `repairLine()`.
- `[data-haier-overview]` and the two `.pilot-ac-mini` overview buttons.
- `#homeQuickDevices`, `.pilot-home-tile[data-home-key]`, `.pilot-device-mini`, `.pilot-home-inline-power`.
- `#editHomeBtn`, `#homeEditHint`, `body.pilot-home-editing`.
- Up/down/hide actions, drag reorder, favorites-independent Home layout in localStorage.
- `data-jump-view="autopilot"` and `data-jump-view="devices"`.

Design goals:

- One clear status sentence: how many devices are verified online vs merely saved.
- AC setpoints and live room temperatures are scannable, not shouting.
- Device tiles show real state, real verification, guarded inline power.
- Customization mode is visually obvious and reversible.

### 2.3 Devices

Preserve:

- `#devices`, `.grid`, `.ds-skeleton`, `#deviceEmpty`, `#deviceSearch`.
- `section.tile[data-id][data-verified][data-lan-known][data-critical]`.
- `.status`, `.status-note`, `.refresh`, `.fav`, `[data-open-details]`, `[data-fix]`.
- `.pilot-inline-power`, `renderSwitch()`, `.cap-control`, two-tap critical guard.
- `#deviceSheet`, `#deviceSheetTitle`, `#deviceSheetSubtitle`, `#deviceSheetBody`, `#closeDeviceSheet`.

Design goals:

- Card title, verified state and primary control form a single readable hierarchy.
- Long names wrap; no clipping by fixed 112/116px columns.
- Loading skeleton, empty filter result, stale/offline and unconfirmed states are distinct.
- Detail sheet is a focused bottom sheet, not a second full app.

### 2.4 Auto-Pilot

Preserve:

- `[data-haier-cloud-login]`, `[data-haier-cards]`.
- Slots `pro` = `19HFAB T3 Pro`, `ff` = `FF Haier 19HFAB T3`.
- `.haier-card[data-haier-slot]`, `.haier-status`, `.haier-mode-tabs`, `[data-haier-mode]`.
- `.haier-controls`, `[data-haier-cmd]`, `[data-haier-read]`, `[data-haier-pause]`, `.haier-config`.
- Cloud status/login/logout, discovery, set temperature, fan, eco, quiet, sleep, strong.
- “LIVE DATA ONLY” and local-network caveat copy.

Design goals:

- Manual and Auto are equally clear; active mode unmistakable.
- Room temperature is the anchor; target, draw and writable state are secondary but legible.
- Unknown values disable controls and say why.
- Pause/auto-error alerts use text + icon + contrast, not colour alone.

### 2.5 Scenes

Preserve:

- `#sceneList`, `.scene-card`, Run/Delete handlers.
- `#sceneEditor`, lazy mount on first visit.
- Schedule display, partial-failure toasts, “No scenes yet” empty state.
- Only real DPs from saved devices.

Design goals:

- Scene list and editor are visually separated.
- Disabled schedules and one-off runs are easy to distinguish.
- Empty state points to a real next action without dead buttons.

### 2.6 Settings

Preserve:

- `[data-family-hub]` and all family-mode handlers.
- `[data-open-drawer="network|appearance|add"]`.
- `#schedulerInfo`, `#schedulerTick`, `[data-rule-preset="motor|geyser"]`, `#rulesInfo`, `#usageInfo`, `#eventsInfo`.
- `#backupDownload`, `#restoreFile`, `#updateCard`, `#updateInfo`, `#updateCheck`, `#updateInstall`, `#updateRollback`, `#updatePermission`.
- Advanced drawer groups: add device, organize, network/scan, IP list, appearance, behaviour, remote access, setup.
- Theme/palette buttons, auto-refresh, refresh all.

Design goals:

- Shortcut tiles are usable tap targets.
- Safety & Automation is grouped by consequence.
- Backup/update/security/diagnostics remain visible and reachable.
- Drawer sections read as a vertical checklist, not a wall of controls.

---

## 3. Design system

### 3.1 Direction

Original “precision calm” language:

- Ink/graphite primary surfaces with a teal primary action.
- Copper/amber for warning, coral for danger, mint for verified OK.
- Border-led cards with restrained elevation; no glass overload.
- 4px spacing rhythm, 8px/12px/16px/24px common steps.
- Calm 120–180ms easing; no bouncy motion.

This takes inspiration from modern smart-home clarity but must not reproduce PR #4 tokens, banner markup or `!important` chain.

### 3.2 Tokens to introduce in `pilot-premium-ui.css`

Semantic aliases only; preserve legacy, `--ds-*`, `--lum-*`, `--lc-*` token names for compatibility.

- Surfaces: canvas, raised, sunken, interactive, overlay, scrim.
- Text: primary, secondary, muted, inverse, focus.
- Lines: subtle, strong, focus.
- Status: ok, warning, danger, info, pending.
- Shape: 4px radius steps from 4–20px; pill.
- Elevation: 0/1/2/3.
- Space: 4/8/12/16/24/32/48.
- Type: 11/12/13/14/16/20/28/36 with weights 500/600/700.
- Motion: `--pm-ease`, `--pm-fast`, `--pm-normal`.

### 3.3 Theme rules

- `html[data-theme="dark"]` → explicit dark.
- `html[data-theme="light"]` → explicit light.
- No `data-theme` → follow `@media (prefers-color-scheme: light/dark)`.
- Keep `tests/test_ui.py:316-317` exact body colours in mind; do not silently break the locked values.
- Every status colour must have a text label and accessible contrast in both themes.

### 3.4 Component rules

- Touch targets ≥44×44px on ≤720px; never less than 32px on desktop.
- Visible theme-aware `:focus-visible` on all buttons, inputs, tabs, cards and switches.
- Long text wraps with `overflow-wrap: anywhere` / `min-width: 0`; no ellipsis-only critical names.
- No horizontal overflow at 320px.
- Bottom tab bar uses one breakpoint (recommend ≤720px) and safe-area insets.
- `prefers-reduced-motion` disables decorative motion but preserves state changes.

---

## 4. Audit conclusions to address

### CSS architecture

- 9 stylesheets load in order: base, local-control, design-system, lumen, pilot-theme, haier, pilot-compact, pilot-v07, pilot-v08.
- 416 `!important` declarations exist; 405 are in pilot-theme / pilot-v07 / pilot-v08.
- 334/334 font-size declarations use raw px; 0/307 padding declarations use tokens.
- 16 inconsistent small-width breakpoints; bottom nav switches at 680/720/760px.
- System theme currently forces dark because `:root:not([data-theme="light"])` matches absent theme.
- Search input `outline:none` beats generic focus rules.
- Light mode has hardcoded dark gaps in Haier tabs/status/alerts, chips and mobile tab bar.
- `#devices.grid` ≤355 single-column rule is cancelled by later ≤720 two-column rule.

### DOM / JS

- No inline `<script>` or `<style>` blocks; tests assert zero of both.
- 19 inline `style="..."` attributes exist and may be cleaned presentation-only.
- Static IDs are unique; duplicate datalist ID risk exists only when the device-sheet clone renders enum DPs.
- Panels lack `role="tabpanel"` / `aria-labelledby`; tabs lack `aria-controls` and roving tabindex.
- Drawer and sheet lack `role="dialog"` / `aria-modal`; no focus trap.
- Favorite button lacks `aria-pressed`; family mode active state is class-only.

### Baseline metrics before changes

- 60 mocked screenshots captured: 2 themes × 6 widths × 5 views.
- Horizontal overflow failures: **0**.
- Page/console errors: **0**.
- Objective metric sample (20 theme/width/view combinations): **192 small tap targets**, **44 overlaps**, **143 low-contrast text rows**, minimum contrast ratio **1.0**, 22 distinct font sizes from 9px to 33px.
- These are baseline problems to reduce, not regressions caused by the redesign.

### PR #4

- Do not merge or snapshot-adopt PR #4.
- Its branch predates v1.18 hardening; adopting its tree would remove `/api/local/diagnostics`, recovery logic, HA diagnostics and `tests/test_reliability.py`.
- Its full visual layer is a last-file `!important` override chain and breaks exact body-colour assertions.
- Keep only broad hierarchy ideas: status banner → section head → card grid → bottom dock.

---

## 5. Work batches

Each batch is implementation + tests + progress update before the next batch starts.

### Batch 0 — Planning and audit `[DONE]`

- [x] Create persistent instructions.
- [x] Create master plan and progress tracker.
- [x] Inspect CSS architecture, DOM/JS contracts and PR #4.
- [x] Capture before screenshots and objective baseline metrics.

### Batch 1 — Design system, navigation, Home `[DONE]`

- [x] Add `static/css/pilot-premium-ui.css` and load it last in the three mirrored templates.
- [x] Add semantic tokens, theme-following system mode, focus rings, 4px spacing and type scale.
- [x] Refresh app bar and five-tab navigation with a single bottom-dock breakpoint.
- [x] Refresh Home hierarchy, AC overview cards and Tuya quick tiles.
- [x] Keep `#summary`, AC overview, Home customization and guarded inline power untouched functionally.
- [x] Run mirror/source guards, focused UI tests, screenshots at all widths/themes, metrics comparison.

### Batch 2 — Devices `[DONE]`

- [x] Refresh device cards, skeleton, empty state, status pills and detail sheet.
- [x] Fix fixed-column title clipping and small tap targets.
- [x] Preserve two-tap critical guard and all command-state copy.
- [x] Re-run Batch 1 checks plus critical-guard and device-sheet UI tests.

### Batch 3 — Auto-Pilot `[DONE]`

- [x] Refresh Haier cards, mode tabs, temperature hierarchy, alerts and cloud/discovery panel.
- [x] Preserve slot names, commands, polling and verification gating.
- [x] Re-run all prior checks plus Haier-focused UI tests.

### Batch 4 — Scenes and Settings `[DONE]`

- [x] Refresh scene list/editor, Family Hub, shortcut tiles, Safety & Automation and advanced drawer.
- [x] Preserve all ids, handlers, backup/update/security/diagnostics/remote access.
- [x] Re-run focused UI suite, safety-contract tests, source guards and source/mirror checks.

### Batch 5 — Micro-polish and final acceptance `[DONE]`

- [x] Shared toast/sheet surfaces, reduced motion, high-contrast and non-colour-only status verified.
- [x] Keyboard focus, Escape/back, deep links, long names, empty/stale and critical two-tap guard verified with mocked APIs (38/38 checks).
- [x] System-theme following and theme parity verified (4/4 checks).
- [x] Final 60-shot screenshot matrix, objective metrics and full evidence package recorded.

---

## 6. Acceptance criteria

A batch or the full sprint is complete only when all applicable criteria pass with recorded evidence.

### Functional preservation

- [x] Five tabs in exact order with correct `aria-selected` (acceptance harness, both themes).
- [x] All panels show/hide correctly; deep links and `data-jump-view` still work (acceptance harness).
- [x] Existing buttons open the correct drawer/sheet/editor (Escape and overlay checks; focused UI tests).
- [x] Two Haier cards remain present and correctly named (Batch 3 Haier UI tests, 18 passed).
- [x] Home customization, favorites and ordering still work (`test_pilot_home_layout.mjs`: PASS).
- [x] Critical two-tap guard still arms then confirms; no command on first tap (acceptance harness, 0 calls).
- [x] No backend, API, protocol, key, auth or safety file changed (`git diff 3fc711f..HEAD` scope check).

### Visual and responsive

- [x] Screenshots exist for 320/360/390/412/768/1280 in light and dark for all five views (60 shots).
- [x] No horizontal scroll at any tested width/theme/view (0 overflow failures, 0 bad combinations).
- [x] No overlapping interactive controls (0 visible overlaps across 20 combinations).
- [x] Long names wrap and remain readable at 320px (acceptance harness).
- [x] One consistent bottom-nav breakpoint and safe-area handling.
- [x] Before/after differences documented with file paths (progress file, Batch 1–5 evidence).

### Accessibility and interaction

- [x] Focus visible on keyboard navigation, including search and hidden-input proxies (acceptance harness).
- [x] Touch targets ≥44px in touch layout (0 small targets across 20 combinations).
- [x] No low-contrast essential text (0 low-contrast rows, minimum ratio 3.23); status uses text + shape/icon + colour.
- [x] Reduced motion respected (acceptance harness).
- [x] Escape closes sheets/drawers and clears the scrim (acceptance harness).
- [x] No dead controls (all views/shortcuts reachable; focused UI tests).

### Tests and evidence

- [x] Focused UI tests pass (14 Scenes/Settings UI + 12 shell + 18 Haier + 4 extras + 2 critical safety).
- [x] `pytest tests/test_pilot_v07_static.py` passes (6 passed).
- [x] `node tests/test_pilot_home_layout.mjs` passes.
- [x] Full `pytest tests/test_ui.py` re-run against the final corrected CSS passes: `403 passed in 1451.54s (0:24:11)` (a first run found and fixed one `hidden`-attribute regression).
- [x] Non-UI regression spot check passes if shared files changed (no shared non-UI files changed; scope check).
- [x] Progress file updated after each milestone.

### Explicit exclusions

- [x] No physical device command sent (all `/api/**` mocked; 0 command calls recorded).
- [x] No fake device state committed (fixtures live outside the repository).
- [x] No push, merge, tag, release, deploy, PR or Azure action performed.
- [x] No hardware verification claimed.

---

## 7. GitHub checkpoint synchronization

- Work only on `feature/smartpilot-premium-ui`, based on v1.19 commit `3fc711f`.
- After each verified milestone, update this plan, `docs/UI_UX_PROGRESS.md`, changed frontend sources, relevant tests and sanitized visual reports.
- Run relevant regression tests before every commit; record exact commands and results.
- Commit with a meaningful message and push normally to the same feature branch.
- Never force-push, merge, delete branches, modify release tags, publish releases or auto-create a PR.
- Prepare a reviewable PR only after the full UI/UX mission passes acceptance.
- Never commit device keys, secrets, personal data, credentials, keystores, absolute local user paths or sensitive logs.
- If GitHub auth, permissions, branch conflicts or CI checks fail, stop and report the blocker.

### Checkpoint log

| Checkpoint | Milestone | Commit | Push status |
|---|---|---|---|
| CP0 | Planning, isolation and audit | `ed97a10418fa2c9ca4c7e1ee5d60d1d7555f37cc` | pushed to `origin/feature/smartpilot-premium-ui` |
| CP1 | Design system, navigation, Home | verified locally with CP2 | push awaiting explicit approval |
| CP2 | Devices | verified locally | push awaiting explicit approval |
| CP3 | Auto-Pilot | verified locally | push awaiting explicit approval |
| CP4 | Scenes and Settings | verified locally | push awaiting explicit approval |
| CP5 | Micro-polish and final acceptance | verified locally | push awaiting explicit approval |

---

## 8. Final report requirements

The final UI report must include:

1. Files changed.
2. Screens improved.
3. Before/after differences.
4. Tests actually executed with counts.
5. Accessibility and responsive results.
6. Remaining gaps.
7. Hardware-only verification risks.
