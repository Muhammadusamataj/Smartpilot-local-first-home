# Lovable Titanium UI to Smart Pilot Android: staging integration

Status: Offline WebView preview integration entry and pinned build script only.
NOT a signed Android APK or completed live hardware integration.

Lovable source is the user's private GitHub repository:
Muhammadusamataj/pixel-perfect-portrait-616
Pinned source commit: ef0f9f88a9c3621d919d25116dc4e14fa3b74f1a

## Architecture

Lovable generated React/TypeScript, Tailwind and TanStack Start SSR. The existing
Android APK uses Chaquopy Flask and a localhost WebView. Its default screen is
/local and must remain so until a full safe migration has passed device tests.

The separate builder converts the *actual Lovable source* to a client-side Vite
SPA for /pilot-next; it is not a redesign. All eight Lovable screens are
retained, and TanStack Router is patched to use hash navigation. Offline
bundling strips remote font links. The frontend keeps the Lovable PreviewAdapter
and never issues real hardware commands. A banner links back to /local.

## Bundle steps on a trusted machine

1. Clone the two repos with authorized GitHub credentials.
2. For the Lovable repository, check out the pinned SHA above.
3. Install Bun and ensure its executable is in PATH.
4. In the Android repository root, run:

    python tools/build_lovable_webview.py --source ../pixel-perfect-portrait-616

5. Inspect generated assets under:
   android_offline/app/src/main/python/static/pilot-next/
   - index.html
   - assets/*.js and assets/*.css
   - SOURCE_COMMIT.txt
6. In development, open http://127.0.0.1:8000/pilot-next. The original
   http://127.0.0.1:8000/local remains the default live control UI.
7. Run python -m pytest -q tests/test_titanium_ui.py
8. Validate *inside Android WebView* at 360/390/768/1280 widths, all 8 pages,
   dark/light and English/Roman Urdu, back navigation, reload and offline mode.
9. Rebuild Android only after generated assets are reviewed and placed
   in the source tree. This staging branch deliberately does not commit the
   generated JS/CSS until an actual build succeeds and passes review.

## Safety gates

- The Android Activity's WebView default URL stays /local.
- No remote Lovable website is embedded.
- No local keys, signing keystores or authentication secrets are committed.
- `/api/pilot-next/snapshot` is read-only and returns only seven exact device names, cached verification flags and saved Haier Manual/Auto modes. It does not return IPs, keys, DP controls or IDs. Unknown, stale and ambiguous readings remain `unknown`. Cached verification is not a fresh hardware read; cards in Lovable remain demo-only.
- This stage has no device-write API. `/api/pilot-next/meta` and `/api/pilot-next/snapshot` are GET-only; the full backend's existing authentication guard applies.
- Lovable state is still demonstration data. It must never be presented as
  real device readback, power metering or connectivity.
- High-risk motors, breakers and geyser require real backend-enforced approval
  and verified readback in any future live adapter.
- Each Haier AC needs independent Manual/Auto modes, real capability checks,
  manual override pause and anti-short-cycle protection.
- Both official HaiSmart functionality and existing Android Tuya/Haier routes
  must remain usable, including backups and the in-app updater.
- Keep the original offline app package identity and signing SHA-256
  bbe14afd137fa6617ade862ea53d6ab0c34ddbf23e1f582bd602651dd7adf00f.
- v1.22 must use versionCode higher than v1.21's 22, with the same certificate.
- Do not merge this draft or publish a release until tests and signing pass.

## Remaining work blocking v1.22

- [x] Implement a typed read-only backend adapter with verified device mapping
  (`static/js/features/local-control/adapter.js`, mirrored byte-identically to
  `android_offline/app/src/main/python/static/...` and `tuya_local_key/app/...`).
  Maps `/api/local/devices` + `/api/local/status` onto the Lovable domain
  (`Device`, `AcDevice`, `SwitchDevice`, `Reported<T>`), keeps the two Haier
  slots first in fixed pro -> ff order, sets `isLive` only after a verified
  read, reports power only from the genuine boolean switch DP (`"1"`) and never
  from a numeric meter DP, and refuses commands in preview mode or without
  explicit approval for non-climate categories. Exposed as `window.pilotAdapter`
  from `main.js` for the UI to consume; presentation-only, no backend change.
  Verified: `node tests/test_pilot_adapter.mjs` PASS (no command POST issued),
  `node tests/test_pilot_home_layout.mjs` PASS, `node --check` clean on all six
  mirrored files, `pytest tests/test_pilot_v07_static.py tests/test_titanium_ui.py
  tests/test_packaging.py tests/test_update_dependencies.py` -> 45 passed.
- [x] Build bundle from the private source and stage it for WebView review.
  Built locally with Bun 1.4.5 from the pinned source
  `ef0f9f88a9c3621d919d25116dc4e14fa3b74f1a` via
  `python tools/build_lovable_webview.py --source <checkout>`. Output staged at
  `android_offline/app/src/main/python/static/pilot-next/` (index.html +
  assets/index-*.js + assets/index-*.css + SOURCE_COMMIT.txt). All eight screens
  compiled in (index, devices, climate, automations, energy, activity, assistant,
  settings). Read-only wiring verified in the bundle: fetches
  `api/pilot-next/snapshot` (GET), contains no command POST path, and keeps the
  "UI preview only" banner + link back to `local`. Flask smoke test:
  `/pilot-next` -> 200 (no-store, has `pilot-next-root`), `/api/pilot-next/meta`
  -> `bundle_ready: true, hardware_commands_enabled: false, mode: preview`,
  `/api/pilot-next/snapshot` -> 200, `read_only: true`, 7 devices.
  `pytest tests/test_titanium_ui.py` -> 7 passed; source/mirror/packaging guards
  -> 38 passed. NOT yet committed (awaiting explicit authorization) and NOT yet
  validated inside a packaged Android APK.
- [x] Validate the staged bundle inside an actual Android WebView (read-only).
  Built signed v1.22 (versionCode 23) with the original pinned keystore
  (signer SHA-256 `bbe14afd…d7adf00f`) and installed in-place on the connected
  device (`adb install -r`, data-preserving: `firstInstallTime` unchanged
  2026-11-22, `lastUpdateTime` advanced, package
  `com.example.tuyalocalkey.offline.v2.debug`). App boots on `/local` (live
  controls intact). On-device loopback: `/pilot-next` 200, JS/CSS assets 200,
  `/api/pilot-next/meta` bundle_ready true, `/api/pilot-next/snapshot` read_only
  true with 7 devices and both Haier ACs independently `manual`; no Chromium
  console errors. Headless Chromium against the identical bundle at
  320/360/390/412/768/1280: all 8 routes mount, **0 horizontal overflow, 0 page
  errors** (added an `overflow-x:hidden` guard to the offline SPA shell in
  `tools/build_lovable_webview.py` to fix a 17px overflow at 320px; rebuilt).
- [x] Review all static paths and network requests in actual packaged APK.
  `app.imy` inside the APK contains `static/pilot-next/index.html`,
  `assets/index-*.js` (1,019,800 B), `assets/index-*.css` (96,104 B),
  `SOURCE_COMMIT.txt`, and `static/js/features/local-control/adapter.js`. The
  bundle issues only same-origin GETs (`api/pilot-next/snapshot`,
  `static/pilot-next/assets/*`); no command POST path exists. APK v1.22 SHA-256
  `6B6841FFC3BB4ACD5DFB8F22079A83976305F55D77EBB0D72130E8890FFB7318`,
  46,927,037 bytes, signer verified = pinned certificate.
- [ ] Publish v1.22 release (tag + APK asset). BLOCKED: requires explicit user
  authorization. The signed APK is built and verified locally but NOT uploaded,
  NOT tagged, NOT merged. The original updater reads `/releases/latest` and
  rejects prereleases, so publishing must be a normal stable release with the
  single signed APK asset and its SHA-256.
- [ ] Full manual QA sign-off on hardware: TalkBack, Android Back across all 8
  pages, English/Roman Urdu, reload and airplane-mode offline, energy readings
  and manual/auto override safety (no physical commands during development).


## GitHub CI workaround for blocked private-repo runner

The private Lovable repository currently has GitHub Actions jobs failing before
runner setup. To build with the Android repository's working GitHub Actions
runner, the staging branch contains
.github/workflows/titanium-private-source-build.yml.

An owner must configure ONE secret (do not paste tokens into chat or commits):

1. On GitHub create a **fine-grained, short-lived personal access token**,
   restricted to ONLY the private repository
   Muhammadusamataj/pixel-perfect-portrait-616, with Contents: Read.
   No write, Actions, admin, or other repository permission is needed.
2. In the Android repository Smartpilot-local-first-home, open:
   Settings > Secrets and variables > Actions > New repository secret.
   Name it LOVABLE_SOURCE_READ_TOKEN and save the token value there.
3. Re-run the workflow
   "Titanium private Lovable source offline build" on the staging branch,
   or trigger a safe branch push. The workflow then checks out the EXACT
   pinned Lovable source commit, runs frontend tests, bundles the full UI,
   tests the read-only Flask integration, and compiles a debug APK.
4. Verify the workflow steps and full CI are green. The CI APK remains
   compile-only and is NEVER uploaded or treated as an installable v1.22
   upgrade because the original pinned signer is absent in GitHub Actions.
5. Revoke or rotate the read-only token when the integration is finished.

Without this secret, the preflight intentionally FAILS with a clear blocker
rather than incorrectly reporting the offline bundle as tested.
