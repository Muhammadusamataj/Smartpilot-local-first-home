# Installation

Choose Home Assistant, Docker, or a local source checkout. For terminal use, see the [CLI guide](cli.md).

## Home Assistant App

Home Assistant OS users can install MY Local Devices Tuya as a Home Assistant add-on. The Supervisor builds it locally from the committed `tuya_local_key/app/` sources; no registry image is required.

1. Go to Settings > Apps > App Store.
2. Open the menu in the top-right and choose Repositories.
3. Add this repository URL:

```text
https://github.com/Muhammadusamataj/MYlocal-devices-tuya
```

4. Install **MY Local Devices Tuya** from the app store and open it from the sidebar. It opens on the Devices screen.

The app uses Home Assistant ingress by default. The direct `8000/tcp` port is disabled unless you explicitly enable it in the app network settings. For remote access, install the Tailscale or WireGuard add-on and open this add-on through the Home Assistant sidebar.

## Web UI with Docker Compose

The included [docker-compose.yml](../docker-compose.yml) builds the image from this repository and stores the cached login session and device list in a named Docker volume.

Start the app:

```bash
docker compose up -d --build
```

Open the web UI:

```text
http://localhost:8000
```

If you prefer the `tuyaSmart` QR scheme instead of `smartlife`, edit `QR_SCHEME` in [docker-compose.yml](../docker-compose.yml).

## Web UI with Docker

Build and run locally:

```bash
docker build -t mylocal-devices-tuya .
docker run -d --name mylocal-devices-tuya -p 8000:8000 -v mylocal-session:/data mylocal-devices-tuya
```

Then open `http://localhost:8000`.

## Web UI from Source

Python 3.10 or newer is required by TinyTuya 1.21.1. Home Assistant and Docker installations already use Python 3.12.

Set up the local environment, then add the web dependencies:

```bash
./setup.sh
.venv/bin/python -m pip install -r requirements-web.txt
```

Serve it with waitress, the same server the Docker image uses:

```bash
.venv/bin/waitress-serve --listen=127.0.0.1:8000 app:app
```

Then open `http://localhost:8000`. It shares the CLI's saved login in `~/.config/tuya-smartlife/session.json`. To reach it from other devices, listen on `0.0.0.0:8000` instead, and read the security note under [Configuration](configuration.md) first.
