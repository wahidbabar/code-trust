#!/usr/bin/env bash
# Conductor setup: runs once when a workspace is created. Safe to re-run.
set -euo pipefail
cd "${CONDUCTOR_WORKSPACE_PATH:-$(pwd)}"

# Dependencies. pnpm's global store hard-links packages, so each worktree installs in seconds.
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile
  else
    pnpm install
  fi
fi

# A private Postgres database per workspace, inside one shared container (OrbStack or Docker).
# The container is shared, so it keeps running after a workspace is archived. Stop it whenever
# you like with `docker stop code-trust-pg`; the next setup starts it again.
# Skipped with a note when Docker isn't running.
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if ! docker ps -a --format '{{.Names}}' | grep -x code-trust-pg >/dev/null; then
    docker run -d --name code-trust-pg --restart unless-stopped \
      -v code-trust-pg-data:/var/lib/postgresql/data \
      -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:54329:5432 postgres:17-alpine >/dev/null
  fi
  docker start code-trust-pg >/dev/null
  for _ in $(seq 1 30); do
    if docker exec code-trust-pg pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done

  # Reuse the database this workspace already has, so renaming a workspace never orphans one.
  db="$(sed -n 's#^DATABASE_URL=postgres://[^/]*/\(ct_[a-z0-9_]*\)$#\1#p' .env.workspace 2>/dev/null | head -n 1 || true)"
  if [ -z "${db}" ]; then
    db="ct_$(printf '%s' "${CONDUCTOR_WORKSPACE_NAME:-local}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '_')"
  fi
  if ! docker exec code-trust-pg psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -x 1 >/dev/null; then
    docker exec code-trust-pg createdb -U postgres "${db}"
  fi
  printf 'DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/%s\n' "${db}" > .env.workspace
  echo "Workspace database: ${db}"
else
  echo "Docker isn't running, so no workspace database was created. Start OrbStack, then run: bash scripts/conductor/setup.sh"
fi
