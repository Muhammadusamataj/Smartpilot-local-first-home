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
type CachedDevice = {
  name: string;
  ecosystem: string;
  connection: "online" | "unknown";
  controlMode?: "manual" | "auto" | "unknown";
};

const DEVICE_NAMES = [
  "19HFAB T3 Pro", "FF Haier 19HFAB T3", "Water Tank",
  "First Floor Breaker", "Ground Floor", "Bore Motor", "Geyser",
] as const;

function VerifiedCachedSummary() {
  const [devices, setDevices] = React.useState<CachedDevice[] | null>(null);
  const [error, setError] = React.useState("Cached connection status unavailable");

  React.useEffect(() => {
    const controller = new AbortController();
    // Cache-only GET. No network reads to devices and no hardware commands.
    fetch("api/pilot-next/snapshot", {
      method: "GET", cache: "no-store", credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Snapshot unavailable");
        return response.json();
      })
      .then((snapshot) => {
        if (
          snapshot?.read_only !== true ||
          snapshot?.hardware_commands_enabled !== false ||
          !Array.isArray(snapshot.devices) ||
          snapshot.devices.length !== DEVICE_NAMES.length
        ) throw new Error("Invalid read-only snapshot");
        const rows: CachedDevice[] = DEVICE_NAMES.map((name) => {
          const matches = snapshot.devices.filter((item: unknown) =>
            typeof item === "object" && item !== null &&
            (item as { name?: unknown }).name === name);
          if (matches.length !== 1) throw new Error("Ambiguous cached device");
          const item = matches[0] as Partial<CachedDevice>;
          return {
            name,
            ecosystem: name.includes("Haier") || name === "19HFAB T3 Pro" ? "Haier" : "Tuya",
            connection: item.connection === "online" ? "online" : "unknown",
            controlMode: item.controlMode === "auto" || item.controlMode === "manual"
              ? item.controlMode : "unknown",
          };
        });
        setDevices(rows);
        setError("");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Cached connection status unavailable");
      });
    return () => controller.abort();
  }, []);

  const verified = devices?.filter((device) => device.connection === "online").length ?? 0;
  return (
    <section aria-label="Real local cache status (read-only)" style={{
      background: "#101a2c", color: "#bdcce2", padding: "8px 14px",
      fontFamily: "system-ui, sans-serif", fontSize: 12,
      borderBottom: "1px solid #29405a",
    }}>
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600, lineHeight: 1.6 }}>
          {devices ? verified + "/7 verified in backend cache" : error}
          <span style={{ color: "#8d9fb8", marginLeft: 8, fontWeight: 400 }}>
            Read-only · Device cards below are demo only · Tap for details
          </span>
        </summary>
        {devices ? (
          <ul style={{ padding: 0, margin: "8px 0 2px", listStyle: "none",
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))",
            gap: 6 }}>
            {devices.map((device) => (
              <li key={device.name} style={{ border: "1px solid #2a4058",
                borderRadius: 9, padding: "7px 9px",
                background: "rgba(255,255,255,.02)" }}>
                <strong>{device.name}</strong>
                <div style={{ color: device.connection === "online" ? "#88d9c3" : "#9dabc1",
                  marginTop: 3 }}>
                  {device.connection === "online" ? "Cache verified" : "Unknown / unverified"}
                  {device.ecosystem === "Haier" && device.controlMode &&
                    device.controlMode !== "unknown"
                    ? " · " + (device.controlMode === "auto" ? "Auto" : "Manual") : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: "8px 0 0" }}>
            No device status claimed. Existing local controls remain available.
          </p>
        )}
      </details>
    </section>
  );
}

const root = document.getElementById('pilot-next-root');
if (!root) throw new Error('Smart Pilot SPA mount missing');
createRoot(root).render(
  <React.StrictMode>
    <VerifiedCachedSummary />
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
<title>Smart Pilot | Titanium Preview</title>
<style>
html, body { margin: 0; overflow-x: hidden; }
#pilot-next-root { max-width: 100vw; overflow-x: hidden; }
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
