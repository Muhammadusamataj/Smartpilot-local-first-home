"""Production WSGI entry point with a fail-closed bind check.

``waitress-serve --listen=0.0.0.0:${PORT:-8000} --threads=8 wsgi:app`` imports
this module before opening the listening socket. If no authentication is
configured and the bind is not loopback, the guard aborts startup instead of
exposing device keys. Home Assistant's ingress-only mode is an explicit,
documented exception; the Android localhost server calls the same guard from
android_entry.py.
"""

from app import app, check_no_auth_binding

check_no_auth_binding()

# Exposed for waitress-serve (wsgi:app) and generic WSGI servers.
application = app
