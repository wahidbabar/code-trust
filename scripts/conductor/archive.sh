#!/usr/bin/env bash
# Conductor archive: drops this workspace's database. Never fails the archive. Outside Conductor,
# run it by hand in a worktree before removing it: the database is named after the worktree's folder.
# The shared code-trust-pg container keeps running for other workspaces.
set -uo pipefail
cd "${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}" 2>/dev/null || true

# The database recorded at setup, plus the one the current name points to, in case the
# workspace was renamed. Only ct_* databases are ever dropped.
dbs=("ct_$(printf '%s' "${CONDUCTOR_WORKSPACE_NAME:-$(basename "$PWD")}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')")
recorded="$(sed -n 's#^DATABASE_URL=postgres://[^/]*/\(ct_[a-z0-9_]*\)$#\1#p' .env.workspace 2>/dev/null | head -n 1)"
if [ -n "${recorded}" ] && [ "${recorded}" != "${dbs[0]}" ]; then
  dbs+=("${recorded}")
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -x code-trust-pg >/dev/null; then
  for db in "${dbs[@]}"; do
    case "${db}" in
      ct_*) docker exec code-trust-pg dropdb -U postgres --if-exists "${db}" && echo "Dropped ${db}" ;;
      *) echo "Refusing to drop ${db}: not a workspace database" ;;
    esac
  done
fi
exit 0
