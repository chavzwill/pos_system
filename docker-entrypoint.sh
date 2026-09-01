#!/bin/sh
set -e

# ./data and ./uploads are bind-mounted from the host and may not exist yet
# on a fresh deploy — Docker auto-creates them owned by root, which the
# non-root `app` user can't write to (SQLITE_CANTOPEN on pos.db). Fix
# ownership here, while still root, then drop to `app` for the real process.
chown -R app:app /app/data /app/uploads

# Production must never come online with the legacy/demo admin credential.
# Run the credential preflight as the same non-root application identity,
# against the same configured database, before starting the HTTP server.
if [ "${NODE_ENV:-}" = "production" ]; then
  su-exec app node --require ./lib/local-sqlite-runtime.js scripts/production-credential-preflight.js
fi

exec su-exec app "$@"
