# Smart Pilot UI/UX Sanitized Visual Baseline

**Captured:** 2026-11-24  
**Branch:** `feature/smartpilot-premium-ui`  
**Base:** `3fc711f`  
**Status:** before redesign, Batch 0 complete

This report contains only sanitized, aggregate visual evidence. Screenshot binaries and raw harness output remain outside the repository and are referenced with the placeholder `UI_REVIEW_TEMP`. No device keys, credentials, personal paths, sensitive logs or live hardware readings are included.

---

## 1. Capture method

Two local Playwright harnesses were used against a temporary static server rendering `templates/local_control.html` with Jinja defaults.

- `UI_REVIEW_TEMP/capture_ui.py` — screenshots and overflow/page-error report.
- `UI_REVIEW_TEMP/metrics_ui.py` — computed-style and geometry metrics.

All `/api/**` requests were fulfilled from in-memory fixtures. The harness never contacted a real device, cloud service or Tuya/Haier endpoint. No ON/OFF, actuator, scene-run or configuration command was sent.

### Mock fixture shape

- Five mock Tuya devices with verified, saved-address and long-name variants.
- Four mock critical entries using generated IDs and generic labels.
- Two mock Haier slots (`pro`, `ff`) with verified writable status.
- One mock scene and one mock preference payload.
- No real device IDs, keys, IPs from user networks, credentials or account data.

---

## 2. Screenshot coverage

| Dimension | Values |
|---|---|
| Themes | `light`, `dark` |
| Widths | `320`, `360`, `390`, `412`, `768`, `1280` |
| Views | `home`, `devices`, `autopilot`, `scenes`, `settings` |
| Total images | 60 |

Filename convention:

```text
{theme}_{width}_{view}.png
```

Example:

```text
dark_390_autopilot.png
```

Aggregate capture result:

```text
captured 60 shots
overflow failures: 0
page errors: 0
```

The raw images are not committed. They are retained in the local review workspace as `UI_REVIEW_TEMP/before/`.

---

## 3. Objective metrics

20 combinations were measured: light/dark × 390/1280 × five views.

| Metric | Baseline |
|---|---:|
| Combinations measured | 20 |
| Horizontal-overflow failures | 0 |
| Small interactive targets (<32px) | 192 |
| Overlapping interactive controls | 44 |
| Low-contrast text rows | 143 |
| Minimum computed contrast ratio | 1.0 |
| Distinct font sizes | 22 |
| Font-size range | 9px – 33px |

Observed font sizes:

```text
9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 17.55, 18, 19, 20, 21, 24, 25, 30, 32, 33
```

### Representative per-view findings

| Theme | Width | View | Small targets | Overlaps |
|---|---:|---|---:|---:|
| light | 390 | home | 9 | 5 |
| light | 390 | devices | 11 | 0 |
| light | 390 | autopilot | 10 | 1 |
| light | 390 | scenes | 12 | 8 |
| light | 390 | settings | 6 | 0 |
| dark | 390 | home | 9 | 5 |
| dark | 390 | devices | 11 | 0 |
| dark | 390 | autopilot | 10 | 1 |
| dark | 390 | scenes | 12 | 8 |
| dark | 390 | settings | 6 | 0 |

The 1280px rows show the same small-target/overlap pattern for scenes and similar small-target counts for other views; horizontal overflow remains zero.

---

## 4. Visual baseline interpretation

- The current layout is dense and uses many ad-hoc font sizes and raw pixel values.
- Navigation remains reachable and no view horizontally overflows.
- The main opportunities are tap-target size, focus visibility, contrast, type-scale consistency and overlap reduction.
- Scenes has the highest overlap count at both sampled widths.
- Home and Auto-Pilot have moderate overlap counts around compact controls and status rows.
- These findings define the redesign targets; they are not new regressions.

---

## 5. Known audit constraints for the redesign

- Existing exact body-colour assertions must remain satisfied.
- No inline `<script>` or `<style>` blocks are allowed.
- Five `data-view` values and panel selectors must remain unchanged.
- Two-tap critical confirmation, verified-only status and Haier writable-status gating must remain unchanged.
- Avoid a new large `!important` override chain; prefer scoped selectors in one final presentation layer.
- Keep all screenshot/report artifacts sanitized and repository-relative.

---

## 6. Limitation

The reviewing model cannot visually inspect PNG pixel content directly in this session. Visual validation therefore combines:

1. Preserved screenshot binaries for human review.
2. Computed-style and geometry metrics for objective comparison.
3. Source-level contract checks and browser tests for behavioural preservation.

No claim of visual perfection or hardware verification is made from these artifacts alone.

---

## 7. Final before/after comparison

The same capture and corrected objective-metrics harnesses were re-run against the frozen Batch 4 presentation layer. Both the baseline and final raw image sets are retained outside the repository under `UI_REVIEW_TEMP/before/` and `UI_REVIEW_TEMP/after_batch4/`.

| Metric | Baseline | Final | Change |
|---|---:|---:|---:|
| Screenshots (2 themes × 6 widths × 5 views) | 60 | 60 | unchanged coverage |
| Combinations measured | 20 | 20 | unchanged |
| Horizontal-overflow failures | 0 | 0 | held |
| Page errors | 0 | 0 | held |
| Small interactive targets (<32px, visible) | 192 | 0 | −192 |
| Visible overlapping controls | 44 | 0 | −44 |
| Low-contrast text rows | 143 | 0 | −143 |
| Minimum computed contrast ratio | 1.0 | 3.23 | +2.23 |

Interim corrected measurements after Batches 1–3 were `small 66 → 36 → 10` and `low-contrast 37 → 27 → 14`, with minimum contrast `1.24 → 1.53`; Batch 4 closed the remaining Scenes field heights and Settings note contrast. The 60 final screenshots cover `320`, `360`, `390`, `412`, `768` and `1280` in both light and dark themes for every view.

Final mocked acceptance checks (38/38) additionally verified the five-view contract, deep links, jump links, focus rings, Escape/overlay behaviour, long-name wrapping, empty/stale states, reduced motion and a zero-command critical two-tap first press. Theme-following checks (4/4) verified OS preference with no override and explicit override precedence.

These are objective computed-style/geometry and behavioural results, not a claim of manual pixel inspection or hardware verification.
