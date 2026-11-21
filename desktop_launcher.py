#!/usr/bin/env python3
"""Desktop entry point used by the frozen Windows build.

Starts the existing Flask app with waitress and opens it in the default browser.
All session/cache files are kept in a writable folder next to the EXE (or under
%LOCALAPPDATA% when the EXE lives in Program Files), so the app never tries to
write into a read-only install directory.

Usage (from source):
    python desktop_launcher.py
    python desktop_launcher.py --host 0.0.0.0 --port 9000 --no-browser

Usage (from the built EXE):
    TuyaLocalKey.exe --port 9000 --data-dir D:\\tuya-data
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path


def _data_dir(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
    elif getattr(sys, "frozen", False):
        install_dir = Path(sys.executable).resolve().parent
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data and "program files" in str(install_dir).lower():
            path = Path(local_app_data) / "TuyaLocalKey"
        else:
            path = install_dir / "data"
    else:
        path = Path(__file__).resolve().parent / "data"

    path.mkdir(parents=True, exist_ok=True)
    return path


def _tailscale_ipv4() -> str:
    """Tailscale's 100.x address, when the Tailscale client is installed."""
    executable = shutil.which("tailscale")
    if executable:
        try:
            output = subprocess.check_output(
                [executable, "ip", "-4"], text=True, stderr=subprocess.DEVNULL, timeout=4)
            for line in output.splitlines():
                candidate = line.strip().split()[0] if line.strip() else ""
                try:
                    address = ipaddress.ip_address(candidate)
                except ValueError:
                    continue
                if address.version == 4:
                    return str(address)
        except (OSError, subprocess.SubprocessError):
            pass
    if os.name == "nt":
        try:
            output = subprocess.check_output(
                ["ipconfig"], text=True, stderr=subprocess.DEVNULL,
                encoding="utf-8", errors="ignore", timeout=4)
            for block in re.split(r"\r?\n\r?\n", output):
                if "tailscale" not in block.lower():
                    continue
                match = re.search(r"IPv4(?: Address)?[^:]*:\s*(\d+\.\d+\.\d+\.\d+)", block)
                if match:
                    return match.group(1)
        except (OSError, subprocess.SubprocessError):
            pass
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(description="Tuya Local Key - desktop server")
    parser.add_argument("--host", default=None,
                        help="bind address (default: Tailscale IP when found, else 127.0.0.1)")
    parser.add_argument("--tailscale", action="store_true",
                        help="opt in to binding on all interfaces for direct Tailscale access")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")),
                        help="port (default: 8000)")
    parser.add_argument("--data-dir", default=None,
                        help="folder for session and cache files")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window")
    parser.add_argument("--username", default=os.environ.get("AUTH_USERNAME", ""),
                        help="optional basic-auth username")
    parser.add_argument("--password", default=os.environ.get("AUTH_PASSWORD", ""),
                        help="optional basic-auth password")
    args = parser.parse_args()

    folder = _data_dir(args.data_dir)

    # Direct Tailscale binding is opt-in. By default the app stays on localhost;
    # for remote access the cleaner path is Home Assistant ingress (which works
    # with the Tailscale add-on or any other HA remote access method).
    tailscale_ip = _tailscale_ipv4() if args.tailscale else ""
    if args.host:
        host = args.host
    elif args.tailscale:
        host = tailscale_ip or "0.0.0.0"
    else:
        host = os.environ.get("HOST", "127.0.0.1")

    # app.py reads these at import time, so set them before importing it.
    os.environ["SESSION_FILE"] = str(folder / "session.json")
    os.environ["PORT"] = str(args.port)
    os.environ["SERVER_HOST"] = host
    if tailscale_ip:
        os.environ["TAILSCALE_IP"] = tailscale_ip
    if args.username and args.password:
        os.environ["AUTH_USERNAME"] = args.username
        os.environ["AUTH_PASSWORD"] = args.password

    from app import app, auto_setup_if_needed, check_no_auth_binding
    from waitress import serve

    check_no_auth_binding(host)
    auto_setup_if_needed()

    browser_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    url = f"http://{browser_host}:{args.port}/local"

    print(f"Tuya Local Key is starting at {url}")
    print(f"Data folder: {folder}")
    if tailscale_ip:
        print(f"Tailscale access: http://{tailscale_ip}:{args.port}/local")
    elif args.tailscale:
        print(f"Tailscale IP not found; listening on all interfaces: 0.0.0.0:{args.port}")
    else:
        print("Remote access: use Home Assistant ingress + the Tailscale add-on (recommended).")
    print("Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    serve(app, host=host, port=args.port, threads=8)


if __name__ == "__main__":
    main()
