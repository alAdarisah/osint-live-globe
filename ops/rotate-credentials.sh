#!/usr/bin/env bash
# Replace the three passwords that still fall back to a built-in default:
# POSTGRES_PASSWORD (osint), REPLICATION_PASSWORD (replicator) and
# GRAFANA_ADMIN_PASSWORD (admin). See docs/security.md for what they guard.
#
#   ssh root@osint-server.tailee11c0.ts.net 'bash /opt/osint/ops/rotate-credentials.sh'
#
# Run it on the server, from anywhere -- it cd's to /opt/osint itself.
#
# Order is the whole point of this being a script. The Postgres password lives
# in the database, not in the compose file: POSTGRES_PASSWORD only has an effect
# when the volume is first initialised, and this volume was initialised long
# ago. So the password has to change in the database first and in .env second.
# Doing it the other way round leaves every service unable to authenticate, with
# the map down and the fix requiring the old password you have just overwritten.
#
# Nothing here is destructive to data. The worst case is a service that needs
# recreating a second time, and .env is backed up before it is touched.
set -euo pipefail

cd /opt/osint

if [ ! -f .env ]; then
  echo "No /opt/osint/.env -- nothing to write into. Stopping." >&2
  exit 1
fi

# openssl rather than /dev/urandom piped through tr: it is already present (the
# postgres image ships it, and so does the host), and base64 of 24 random bytes
# is 32 characters of real entropy rather than a length someone picked.
gen() { openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-28; }

PG_NEW=$(gen)
REPL_NEW=$(gen)
GRAFANA_NEW=$(gen)

# Upsert a KEY=VALUE into .env: replace the line if the key is there, append it
# if it is not. The value is written through a here-doc-free sed with | as the
# delimiter, and gen() above has already stripped the characters that would need
# escaping, so there is no quoting hazard in what gets substituted.
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

BACKUP=".env.before-rotation-$(date -u +%Y%m%dT%H%M%SZ)"
cp .env "$BACKUP"
chmod 600 "$BACKUP"
echo "Backed up .env to $BACKUP"
echo

# --- Postgres ---------------------------------------------------------------
# ALTER ROLE does not drop existing connections, so nothing is interrupted
# between here and the recreate below -- the running services keep using the
# connections they already hold and authenticate with the new password only when
# they next reconnect, which the recreate forces.
echo "Postgres: changing the role password..."
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U osint -d osint \
  -c "ALTER ROLE osint WITH PASSWORD '${PG_NEW}';" > /dev/null
set_env POSTGRES_PASSWORD "$PG_NEW"
echo "  done"

# --- Replication role -------------------------------------------------------
# Only if it exists. On a stack where the read replica has not been set up yet
# the role has never been created, and ALTER ROLE would fail the whole script
# over a credential that guards nothing.
echo "Replication role: checking whether it exists..."
if docker compose exec -T postgres psql -tAX -U osint -d osint \
     -c "SELECT 1 FROM pg_roles WHERE rolname = 'replicator';" | grep -q 1; then
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U osint -d osint \
    -c "ALTER ROLE replicator WITH PASSWORD '${REPL_NEW}';" > /dev/null
  set_env REPLICATION_PASSWORD "$REPL_NEW"
  echo "  changed"
  ROTATED_REPLICA=1
else
  echo "  not present (the read replica has not been set up) -- skipped"
  ROTATED_REPLICA=0
fi

# --- Grafana ----------------------------------------------------------------
# The only one with nothing to do inside the container: Grafana applies
# GF_SECURITY_ADMIN_PASSWORD on every start, so writing .env and recreating is
# the entire change.
echo "Grafana: setting the admin password..."
set_env GRAFANA_ADMIN_USER "${GRAFANA_ADMIN_USER:-admin}"
set_env GRAFANA_ADMIN_PASSWORD "$GRAFANA_NEW"
echo "  done"

echo
echo "Recreating the services that hold these credentials..."
SERVICES="backend ingest refine cache-worker postgres-exporter grafana"
if [ "$ROTATED_REPLICA" = 1 ]; then
  # The standby authenticates with PGPASSWORD out of its environment, so it
  # needs recreating rather than restarting -- a restart keeps the old value.
  SERVICES="$SERVICES postgres-replica postgres-exporter-replica"
fi
# shellcheck disable=SC2086
docker compose up -d $SERVICES

echo
echo "Waiting for them to settle..."
sleep 15

echo
echo "--- authentication failures since the rotation (empty is the good result) ---"
# shellcheck disable=SC2086
docker compose logs --since 60s $SERVICES 2>&1 \
  | grep -iE "password authentication failed|authentication error|FATAL:.*role" \
  || echo "  none"

echo
echo "--- backend health ---"
curl -s -o /dev/null -w "  /api/health -> %{http_code}\n" http://localhost:8000/api/health

echo
echo "--- the new values (write them down now; they are in .env and nowhere else) ---"
printf "  POSTGRES_PASSWORD      %s\n" "$PG_NEW"
if [ "$ROTATED_REPLICA" = 1 ]; then
  printf "  REPLICATION_PASSWORD   %s\n" "$REPL_NEW"
fi
printf "  GRAFANA_ADMIN_PASSWORD %s\n" "$GRAFANA_NEW"
echo
echo "Grafana is at http://localhost:3000 over the SSH tunnel, user admin."
echo "If anything above looks wrong, $BACKUP has the previous .env --"
echo "but note the database password has already changed, so rolling .env back"
echo "means changing it back in the database too."
