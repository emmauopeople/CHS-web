#!/bin/sh
set -eu
export DATABASE_URL="$(node /app/infra/database-url.mjs)"
if [ -f /run/secrets/account_identity_client_secret ]; then
  export ACCOUNT_IDENTITY_CLIENT_SECRET="$(cat /run/secrets/account_identity_client_secret)"
fi
exec "$@"
