#!/bin/bash
set -euo pipefail
export KC_DB_PASSWORD="$(cat /run/secrets/identity_database_password)"
export KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/secrets/identity_admin_password)"
export CHS_REVIEWER_INITIAL_PASSWORD="$(cat /run/secrets/reviewer_password)"
exec /opt/keycloak/bin/kc.sh start --import-realm
