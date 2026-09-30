#!/usr/bin/env bash
# Conductor archive: drops this workspace's database. Never fails the archive.
set -uo pipefail
db="ct_$(printf '%s' "${CONDUCTOR_WORKSPACE_NAME:-local}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -x code-trust-pg >/dev/null; then
  docker exec code-trust-pg dropdb -U postgres --if-exists "${db}" && echo "Dropped ${db}"
fi
exit 0
