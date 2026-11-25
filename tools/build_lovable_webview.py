#!/usr/bin/env python3
"""Export pinned Lovable React UI as an offline, live WebView SPA.

The bundle talks to the existing Flask /api/local/* and /api/haier/* routes
for reads and commands. Every hardware action keeps the backend's server-side
safety gates; nothing in this builder changes protocols, keys or API contracts.

Never changes the Android entry URL, hardware endpoints, app version or signer.
Requires Bun, Git credentials and/or a local Lovable repository checkout.
"""
from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "android_offline/app/src/main/python/static/pilot-next"
SOURCE_URL = "https://github.com/Muhammadusamataj/pixel-perfect-portrait-616.git"
SOURCE_COMMIT = "ef0f9f88a9c3621d919d25116dc4e14fa3b74f1a"

OVERLAY_DIR = ROOT / "tools" / "lovable_full_live"
_OVERLAY_FILES = {
    "lib/smartpilot/adapter.ts": "adapter.ts",
    "lib/smartpilot/store.tsx": "store.tsx",
    "lib/smartpilot/local-backend-adapter.ts": "local-backend-adapter.ts",
    "components/sp/DeviceSheet.tsx": "DeviceSheet.tsx",
    "components/sp/AcControl.tsx": "AcControl.tsx",
    "components/sp/primitives.tsx": "primitives.tsx",
    "routes/index.tsx": "index.tsx",
    "lib/smartpilot/backend-api.ts": "backend-api.ts",
    "routes/devices.tsx": "devices.tsx",
    "routes/automations.tsx": "automations.tsx",
    "routes/energy.tsx": "energy.tsx",
    "routes/activity.tsx": "activity.tsx",
    "routes/settings.tsx": "settings.tsx",
    "lib/smartpilot/assistant.ts": "assistant.ts",
    "routes/assistant.tsx": "assistant.tsx",
}

# Deterministic visible-copy patches. Anchors are pinned to the audited source
# revision; a missing anchor or unexpected count aborts the build instead of
# silently shipping stale preview claims. Tuples are (anchor, replacement, n).
_STRING_PATCHES = {
    "components/sp/AppShell.tsx": [
        (
            '<ShieldCheck className="size-3.5" aria-hidden /> {t("prototype")}',
            '<ShieldCheck className="size-3.5" aria-hidden /> Live local',
            1,
        ),
        (
            "No hardware is connected. Controls are previews and never reach your devices.",
            "Reads and commands use this app’s local backend. Critical devices still require explicit approval.",
            1,
        ),
        (
            '{t("prototype")} · {t("previewOnly")}',
            "Live local control · verified reads only",
            2,
        ),
    ],
    "routes/climate.tsx": [
        (
            'import { PageHeader, PreviewBadge } from "@/components/sp/primitives";',
            'import { LiveBadge, PageHeader } from "@/components/sp/primitives";',
            1,
        ),
        ("eyebrow={<PreviewBadge />}", "eyebrow={<LiveBadge />}", 1),
    ],
    "routes/__root.tsx": [
        (
            'content: "Smart-home control prototype for Haier ACs and Smart Life devices. Preview only.",',
            'content: "Live local control for Haier ACs and Smart Life devices.",',
            2,
        ),
    ],
    "routes/index.tsx": [
        (
            '"Home dashboard for your Haier ACs and Smart Life devices. Preview-only prototype.",',
            '"Live local dashboard for your Haier ACs and Smart Life devices.",',
            1,
        ),
    ],
}

SPA_ENTRY = """import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { getRouter } from './router';
import './styles.css';

const root = document.getElementById('pilot-next-root');
if (!root) throw new Error('Smart Pilot SPA mount missing');
createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={getRouter()} />
  </React.StrictMode>,
);
"""

SPA_HTML = """<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1220">
<title>Smart Pilot | Titanium Live</title>
<style>
html, body { margin: 0; overflow-x: hidden; }
#pilot-next-root { max-width: 100vw; overflow-x: hidden; }
.pilot-next-safety { background:#0b1220; color:#cbd5e1; font:12px/1.6 system-ui,sans-serif;
  padding:9px 14px; border-bottom:1px solid #30445d; display:flex; flex-wrap:wrap; gap:12px;
  justify-content:space-between; align-items:center; position:relative; z-index:80; }
.pilot-next-safety strong {color:#7dd3fc}
.pilot-next-safety a {color:#7dd3fc;text-decoration:underline}
/* Touch-layout target sizes for secondary text links inherited from the
   pinned Lovable UI. Device buttons already use the 44px touch size. */
@media (pointer: coarse) {
  .pilot-next-safety a, header a, main a, a.sr-only {
    display: inline-flex; align-items: center; min-height: 44px; min-width: 44px;
  }
  button { min-height: 44px; min-width: 44px; }
}
</style>
</head>
<body>
<div class="pilot-next-safety" role="status">
  <span><strong>Live local control.</strong> Verified reads only; critical devices need approval. Commands use your existing local backend.</span>
  <a href="local">Open existing live controls</a>
</div>
<div id="pilot-next-root"></div>
<script type="module" src="/src/pilot-spa.tsx"></script>
</body>
</html>
"""

VITE_CONFIG = """import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  build: { outDir: 'android-spa-dist', emptyOutDir: true, assetsDir: 'assets' },
});
"""


def run(*args: str, cwd: Path | None = None) -> None:
    # npm installs `bun` as a .cmd shim on Windows; CreateProcess cannot run
    # that directly, so route it through cmd.exe while keeping args explicit.
    executable = shutil.which(args[0])
    if os.name == "nt" and executable and executable.lower().endswith((".cmd", ".bat")):
        subprocess.run([executable, *args[1:]], cwd=cwd, check=True, shell=True)
        return
    subprocess.run(args, cwd=cwd, check=True)


def prepare_source(folder: Path, source: Path | None) -> None:
    if source:
        if not (source / "src/router.tsx").is_file():
            raise SystemExit("Source path is not a Lovable application checkout.")
        try:
            revision = subprocess.check_output(
                ["git", "-C", str(source), "rev-parse", "HEAD"], text=True,
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            raise SystemExit("A verifiable Git checkout is required for --source.") from None
        if revision != SOURCE_COMMIT:
            raise SystemExit(
                "Lovable source revision does not match pinned SHA. "
                "Re-audit a newer revision before using it."
            )
        shutil.copytree(
            source, folder, dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("node_modules", ".git", "dist", ".output", ".tanstack"),
        )
    else:
        # Git credentials configured externally; do not put tokens in process args.
        run("git", "clone", "--no-checkout", SOURCE_URL, str(folder))
        run("git", "fetch", "--depth", "1", "origin", SOURCE_COMMIT, cwd=folder)
        run("git", "checkout", "--detach", SOURCE_COMMIT, cwd=folder)
    if not (folder / "bun.lock").is_file():
        raise SystemExit("Missing Lovable bun.lock: refusing unpinned dependency install.")


def apply_overlay(folder: Path) -> None:
    """Copy the live-command patched Lovable source files into the checkout.

    The pinned upstream source stays untouched; only the temp build copy is
    patched so the exported WebView bundle uses the real local adapter.
    """
    if not OVERLAY_DIR.is_dir():
        raise SystemExit(f"Missing live overlay source directory: {OVERLAY_DIR}")
    for dest_rel, overlay_name in _OVERLAY_FILES.items():
        src = OVERLAY_DIR / overlay_name
        dst = folder / "src" / dest_rel
        if not src.is_file():
            raise SystemExit(f"Missing overlay source file: {src}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


def apply_string_patches(folder: Path) -> None:
    """Replace preview-only UI copy in the temp build copy with live wording."""
    for rel_path, patches in _STRING_PATCHES.items():
        target = folder / "src" / rel_path
        if not target.is_file():
            raise SystemExit(f"Missing source file for copy patch: {target}")
        content = target.read_text(encoding="utf-8")
        for anchor, replacement, expected in patches:
            found = content.count(anchor)
            if found != expected:
                raise SystemExit(
                    f"Copy patch anchor mismatch in {rel_path}: "
                    f"expected {expected}, found {found}: {anchor[:60]}"
                )
            content = content.replace(anchor, replacement)
        target.write_text(content, encoding="utf-8")


def make_webview_build(folder: Path) -> None:
    apply_overlay(folder)
    apply_string_patches(folder)
    # Hash routing keeps navigation under /pilot-next in the WebView.
    router = folder / "src/router.tsx"
    content = router.read_text(encoding="utf-8")
    anchor = 'import { createRouter } from "@tanstack/react-router";'
    if anchor not in content or "history: createHashHistory()," in content:
        raise SystemExit("Unexpected Lovable router; re-audit before patching.")
    content = content.replace(anchor, 'import { createRouter, createHashHistory } from "@tanstack/react-router";')
    content = content.replace("    routeTree,\n", "    routeTree,\n    history: createHashHistory(),\n", 1)
    router.write_text(content, encoding="utf-8")

    # No Google Font requests when running as an offline Android page.
    root = folder / "src/routes/__root.tsx"
    content = root.read_text(encoding="utf-8")
    content = content.replace('      { rel: "preconnect", href: "https://fonts.googleapis.com" },\n', "")
    content = content.replace('      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },\n', "")
    remote_font_link = '''      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&family=Sora:wght@500;600;700&display=swap",
      },
'''
    if remote_font_link not in content:
        raise SystemExit("Unknown remote font reference. Re-audit offline resources.")
    content = content.replace(remote_font_link, "")
    # The original SSR shell renders html/head/body. The offline SPA already
    # has those tags in index.html and must not nest a second document.
    shell = "  shellComponent: RootShell,"
    if shell not in content:
        raise SystemExit("Unknown SSR shell structure: re-audit before bundling.")
    content = content.replace(shell, "  shellComponent: undefined,")
    css_import = 'import appCss from "../styles.css?url";' + "\n"
    css_link = ('      {\n        rel: "stylesheet",\n        href: appCss,\n      },\n')
    if css_import not in content or css_link not in content:
        raise SystemExit("Unknown root stylesheet HEAD entry: re-audit before bundling.")
    # CSS is imported in src/pilot-spa.tsx, so avoid a second root-relative
    # stylesheet URL which would not resolve at /pilot-next.
    content = content.replace(css_import, "").replace(css_link, "")
    content = content.replace('href: "/favicon.ico"', 'href: "icon.png"')
    root.write_text(content, encoding="utf-8")

    (folder / "src/pilot-spa.tsx").write_text(SPA_ENTRY, encoding="utf-8")
    (folder / "index.html").write_text(SPA_HTML, encoding="utf-8")
    (folder / "vite.pilot.config.ts").write_text(VITE_CONFIG, encoding="utf-8")


def write_local_template(html: str) -> None:
    """Regenerate the `/local` shell with the current asset hashes and mirrors."""
    js_match = re.search(r'src="static/pilot-next/assets/([^"]+\.js)"', html)
    css_match = re.search(r'href="static/pilot-next/assets/([^"]+\.css)"', html)
    if not js_match or not css_match:
        raise SystemExit("Built HTML has no local JS/CSS asset references.")
    source = OVERLAY_DIR / "local_control.template.html"
    if not source.is_file():
        raise SystemExit(f"Missing local template source: {source}")
    content = (source.read_text(encoding="utf-8")
               .replace("__JS_ASSET__", js_match.group(1))
               .replace("__CSS_ASSET__", css_match.group(1)))
    destinations = [
        ROOT / "templates" / "local_control.html",
        ROOT / "android_offline/app/src/main/python/templates/local_control.html",
        ROOT / "tuya_local_key/app/templates/local_control.html",
    ]
    for target in destinations:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    print("Updated /local template and mirrors with", js_match.group(1), css_match.group(1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=None,
                        help="Locally checked out Lovable repository")
    args = parser.parse_args()
    if not shutil.which("bun"):
        raise SystemExit("Bun required to build the Lovable WebView bundle.")
    with tempfile.TemporaryDirectory(prefix="smartpilot-lovable-") as tmp:
        folder = Path(tmp) / "lovable"
        folder.mkdir()
        prepare_source(folder, args.source.resolve() if args.source else None)
        make_webview_build(folder)
        run("bun", "install", "--frozen-lockfile", cwd=folder)
        run("bun", "run", "vite", "build", "--config", "vite.pilot.config.ts", cwd=folder)
        built = folder / "android-spa-dist"
        html_file, assets = built / "index.html", built / "assets"
        if not html_file.is_file() or not assets.is_dir() or not list(assets.glob("*.js")):
            raise SystemExit("Frontend build incomplete: refusing export.")
        html = html_file.read_text(encoding="utf-8")
        for prefix in ('"./assets/', "'./assets/", '"/assets/', "'/assets/"):
            html = html.replace(prefix, prefix[:1] + "static/pilot-next/assets/")
        if 'src="static/pilot-next/assets/' not in html:
            raise SystemExit("Built script URL is not relative to the local Flask origin.")
        staging = TARGET.parent / (TARGET.name + "-staging")
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        shutil.copytree(assets, staging / "assets")
        (staging / "index.html").write_text(html, encoding="utf-8")
        (staging / "SOURCE_COMMIT.txt").write_text(
            SOURCE_COMMIT + "\n" + SOURCE_URL + "\n", encoding="utf-8")
        if TARGET.exists():
            shutil.rmtree(TARGET)
        staging.rename(TARGET)
        write_local_template(html)
        print("Offline, live Titanium bundle staged in", TARGET)


if __name__ == "__main__":
    main()
