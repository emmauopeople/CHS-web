#!/bin/sh
set -eu
export DATABASE_URL="$(node /app/infra/database-url.mjs)"
if [ -f /run/secrets/account_identity_client_secret ]; then
  export ACCOUNT_IDENTITY_CLIENT_SECRET="$(cat /run/secrets/account_identity_client_secret)"
fi
if [ -f /run/secrets/provider_identity_client_secret ]; then
  export PROVIDER_IDENTITY_CLIENT_SECRET="$(cat /run/secrets/provider_identity_client_secret)"
fi
exec "$@"
