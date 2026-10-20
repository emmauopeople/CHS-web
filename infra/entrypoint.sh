#!/bin/sh
set -eu
export DATABASE_URL="$(node /app/infra/database-url.mjs)"
exec "$@"
