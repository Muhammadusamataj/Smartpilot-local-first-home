# Smart Pilot — Persistent Project Instructions

These instructions apply to every agent/session working in this repository.

## First action for any UI/UX task

1. Read `AGENTS.md`.
2. Read `docs/UI_UX_MASTER_PLAN.md`.
3. Read `docs/UI_UX_PROGRESS.md`.
4. Continue only from the first unchecked milestone. Do not repeat completed work unless a regression is suspected.

## Mission

Deliver a premium, original UI/UX redesign of the existing Smart Pilot local-control interface. The redesign is presentation-only: it must improve Home, Devices, Auto-Pilot, Scenes, Settings, navigation and micro-interactions without changing device behaviour, backend logic, security, protocols or API contracts.

## Hard safety boundaries — never violate

- Do **not** modify Python backend, device-control logic, Haier/Tuya protocols, device IDs/keys, authentication, LAN recovery, automation safety, diagnostics, backup/restore, update logic, security logic or API contracts.
- Do **not** send physical ON/OFF, actuator, temperature, scene-run or any other device command. Test with mocked `/api/**` responses only.
- Do **not** invent device data, statuses, readings, capabilities or hardware claims. “Online” must continue to mean a verified fresh LAN read; Haier “LOCAL ONLINE” must continue to require writable verified status.
- Do **not** merge, tag, release, deploy, create/update a PR, force-push, delete branches, or perform Azure activity without explicit user approval.
- Automatic commit and push are allowed **only** after a verified milestone, and **only** to `feature/smartpilot-premium-ui`.
- Do **not** touch stable v1.18 (`ec23825`), `main`, the v1.19 release commit/tag, PR #4, or any other remote branch.
- Never claim completion, test success, device verification or accessibility compliance without actual evidence in the conversation.

## Non-negotiable product contracts

- Preserve exactly five navigation destinations and their `data-view` values, in DOM order:
  `home`, `devices`, `autopilot`, `scenes`, `settings`.
- Preserve `[data-view-panel]` visibility logic, `setView()`, all existing handlers, deep links, `data-jump-view`, drawers, bottom sheet, Home customization, tile ordering, Family Hub, backup/restore, update, security, diagnostics, remote access and advanced device configuration.
- Preserve the two Haier AC slots and names: `pro` → `19HFAB T3 Pro`, `ff` → `FF Haier 19HFAB T3`.
- Preserve critical-device two-tap confirmation, busy/pending/unconfirmed/failed states, and `data-critical="true"` semantics.
- Keep mirrored files byte-identical where tests require it (`templates/local_control.html`, selected `static/js/**` and `static/css/**` files). Run mirror/source-sync tests after touching any locked file.
- Keep all features reachable. No dead controls, no hidden-forever sections, no API changes.

## Working method

- Work only on `feature/smartpilot-premium-ui`, created from v1.19 commit `3fc711f`.
- Implement in small, reviewable batches:
  1. Design system + navigation + Home
  2. Devices
  3. Auto-Pilot
  4. Scenes + Settings
  5. Micro-polish + final verification
- Prefer a single new presentation layer (`static/css/pilot-premium-ui.css`) over editing old cascade layers. Avoid large `!important` chains and specificity wars.
- Keep Android WebView compatibility: no unsupported modern CSS without fallback, no performance-heavy filters/animations, no horizontal scroll.
- Use semantic tokens and a 4px spacing rhythm. Preserve CSS custom-property names that existing code/tests rely on.
- Any inline `style="..."` cleanup must be presentation-only and must not alter ids, classes, handlers or data attributes used by JS/tests.

## GitHub checkpoint synchronization

After each successful verified milestone:

1. Update `docs/UI_UX_MASTER_PLAN.md` and `docs/UI_UX_PROGRESS.md`; update this file only if project instructions changed.
2. Stage only intended frontend sources, relevant tests, documentation and sanitized visual reports.
3. Run relevant regression tests and record exact commands/results in the progress file.
4. Create a meaningful commit.
5. Push with a normal fast-forward push to `origin feature/smartpilot-premium-ui`.
6. Report branch, commit SHA, changed files, test results and GitHub status.
7. If authentication, permissions, branch conflicts or CI checks fail, stop and report the blocker; never bypass protections.

Never commit device keys, secrets, personal data, local credentials, keystores, absolute local user paths or sensitive logs. Keep visual reports sanitized and repository-relative.

## Design standards

- Original design direction: “precision calm” — ink/graphite surfaces, teal primary, copper warning accents, border-led cards, restrained elevation, generous readable type. Do not copy PR #4 verbatim.
- Dark and light modes must both be complete. System theme must follow OS preference when no explicit theme override is stored.
- Use semantic tokens for surface, text, muted text, lines, accent, success, warning, danger, focus, radius, elevation and spacing.
- Type scale should be readable at 320px; avoid sub-11px body text. Long device names must wrap without clipping or overflow.
- Interactive targets should be at least 44×44px on touch layouts, with visible theme-aware `:focus-visible` rings and keyboard operability.
- Respect `prefers-reduced-motion`; use short, calm easing and avoid motion that obscures state changes.
- Status must be high-contrast and non-colour-only: use text + shape/icon + colour.
- Loading, empty, stale/offline, unverified, busy, pending, confirmed, unconfirmed and failed states must remain visually distinct.

## Required verification before marking anything complete

Run and record actual commands/results:

- Relevant UI tests (`pytest tests/test_ui.py ...` where feasible, or the focused local-control subset).
- Source/mirror guards (`tests/test_pilot_v07_static.py`, `tests/test_pilot_home_layout.mjs`, and any touched-file guards).
- Non-UI regression spot checks when requested or when shared files change.
- Mocked Playwright screenshots at widths `320`, `360`, `390`, `412`, `768`, `1280` in both themes.
- Programmatic checks: no horizontal overflow, no page errors, tap targets, contrast, overlap, focus visibility, theme parity.
- Manual reasoning for accessibility: tab order, Escape/back navigation, bottom sheets, keyboard, long names, empty lists, slow loading, offline/stale, critical confirmation.

Update `docs/UI_UX_PROGRESS.md` after every implementation or testing milestone with evidence paths and exact pass/fail counts.

## PR #4 note

PR #4 (`feat/home-inspired-premium-ui`) is open, unmerged and must not be merged or adopted as a snapshot. Its branch predates v1.18 hardening; adopting its tree would remove backend diagnostics and reliability tests. Its visual hierarchy may inspire an original implementation, but do not copy its heavy `!important` chain or change the exact body-background assertion in `tests/test_ui.py:316-317` unless separately approved.
