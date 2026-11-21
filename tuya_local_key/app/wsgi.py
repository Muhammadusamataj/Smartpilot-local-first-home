"""Production WSGI entry point with a fail-closed listener check.

When Waitress specifies --listen, validate EVERY address rather than trusting
an unrelated HOST environment variable. A missing listener is conservatively
treated as a non-loopback bind. Android's loopback service has its own guard.
"""

import re
import sys

from app import app, check_no_auth_binding


def _cli_option_values(argv, option):
    """Read both --option=value and --option value, including repeated flags."""
    found = []
    for index, arg in enumerate(argv):
        if arg.startswith(option + "="):
            found.append(arg.split("=", 1)[1])
        elif arg == option:
            found.append(argv[index + 1] if index + 1 < len(argv) else "")
    return found


def _requested_bindings(argv):
    listens = _cli_option_values(argv, "--listen")
    if listens:
        # Waitress supports multiple listen addresses in one argument.
        # Any non-loopback address must be rejected without authentication.
        values = [address for value in listens for address in re.split(r"[,\s]+", value.strip()) if address]
        return values or ["0.0.0.0"]

    hosts = _cli_option_values(argv, "--host")
    if hosts:
        return hosts

    # No trustworthy CLI declaration: do not allow an ambient HOST or
    # WAITRESS_HOST=127.0.0.1 to bypass a real wildcard/default listener.
    return ["0.0.0.0"]


for _binding in _requested_bindings(sys.argv[1:]):
    check_no_auth_binding(_binding)

# Exported for Waitress (wsgi:app) and WSGI servers.
application = app
