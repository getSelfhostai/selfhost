#!/bin/sh
# Gives each workspace its own database and port.
set -eu
createdb "acme_web_${CONDUCTOR_WORKSPACE_NAME}" || true
echo "DATABASE_URL=postgres://localhost/acme_web_${CONDUCTOR_WORKSPACE_NAME}" >> .env.local
echo "PORT=$CONDUCTOR_PORT" >> .env.local
if [ "${CONDUCTOR_IS_LOCAL:-1}" = "1" ]; then
  echo "local workspace"
fi
