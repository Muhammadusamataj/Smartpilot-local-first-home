#!/usr/bin/env python3
"""Export pinned Lovable React UI as offline, preview-only WebView SPA.

Never changes the Android entry URL, hardware endpoints, app version or signer.
Requires Bun, Git credentials and/or a local Lovable repository checkout.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "android_offline/app/src/main/python/static/pilot-next"
SOURCE_URL = "https://github.com/Muhammadusamataj/pixel-perfect-portrait-616.git"
SOURCE_COMMIT = "ef0f9f88a9c3621d919d25116dc4e14fa3b74f1a"

SPA_ENTRY = """import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { getRouter } from './router';
import './styles.css';
const root = document.getElementById('pilot-next-root');
if (!root) throw new Error('Smart Pilot SPA mount missing');
createRoot(root).render(
  <React.StrictMode><RouterProvider router={getRouter()} /></React.StrictMode>,
);
"""

SPA_HTML = """<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1220">
<title>Smart Pilot | Titanium Preview</title>
<style>
.pilot-next-safety { background:#0b1220; color:#cbd5e1; font:12px/1.6 system-ui,sans-serif;
  padding:9px 14px; border-bottom:1px solid #30445d; display:flex; flex-wrap:wrap; gap:12px;
  justify-content:space-between; align-items:center; position:relative; z-index:80; }
.pilot-next-safety strong {color:#7dd3fc}
.pilot-next-safety a {color:#7dd3fc;text-decoration:underline}
</style>
</head>
<body>
<div class="pilot-next-safety" role="status">
  <span><strong>UI preview only.</strong> Device controls here do not reach hardware.</span>
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


def make_webview_build(folder: Path) -> None:
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
    root.write_text(content.replace(remote_font_link, ""), encoding="utf-8")

    (folder / "src/pilot-spa.tsx").write_text(SPA_ENTRY, encoding="utf-8")
    (folder / "index.html").write_text(SPA_HTML, encoding="utf-8")
    (folder / "vite.pilot.config.ts").write_text(VITE_CONFIG, encoding="utf-8")


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
        print("Offline, preview-only Titanium bundle staged in", TARGET)


if __name__ == "__main__":
    main()
