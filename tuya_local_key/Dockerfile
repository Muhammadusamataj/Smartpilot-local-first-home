FROM python:3.12-slim

ARG BUILD_VERSION=dev

LABEL \
    org.opencontainers.image.licenses="Apache-2.0" \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="aarch64|amd64"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SESSION_FILE=/data/session.json \
    PORT=8000

WORKDIR /app

# Dependencies first for better layer caching. The pinned wheels support
# aarch64 and amd64, so no build toolchain is needed on slim.
COPY app/requirements.txt app/requirements-web.txt ./
RUN pip install -r requirements-web.txt

# `tools/sync_addon.py` keeps this copy in sync with the repository root.
COPY app/ ./

RUN mkdir -p /data

EXPOSE 8000
VOLUME ["/data"]

CMD ["sh", "-c", "exec waitress-serve --listen=0.0.0.0:${PORT:-8000} --threads=8 app:app"]
