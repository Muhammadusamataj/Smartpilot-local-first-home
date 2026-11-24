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

- Build bundle from the private source and test it in an Android WebView.
- Review all static paths and network requests in actual packaged APK.
- Implement a typed read-only backend adapter with verified device mapping.
- Gradually integrate only safe, permitted commands with explicit approvals.
- Test hardware behaviors, energy readings and manual/auto override safety.
- Run full Python/Android/frontend test suites and verified signed APK build.
