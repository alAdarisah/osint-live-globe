#!/usr/bin/env bash
# Rebuild whatever is running behind its source, on the server. Called by
# "Deploy Code to Server.bat" after it has synced the working tree here; also runnable directly
# over SSH if you have already copied files up some other way.
#
#   deploy.sh              rebuild backend, frontend, refine, cache-worker if stale
#   deploy.sh --ingest     also rebuild ingest (see below)
#   deploy.sh --force      rebuild all of the above regardless of staleness
#
# Which services are opt-in, and why
# ----------------------------------
# ingest alone is opt-in, because it alone costs money to restart: it owns every
# credentialed and metered source (ACLED, FIRMS, ADS-B, AIS, Overpass, GFW) and
# re-polls on start. Nothing it does is visible in the bundle a reader loads.
#
# refine and cache-worker are *not* opt-in, which is a deliberate change from the
# old update-link.bat. It excluded them on the grounds that the shared link does
# not depend on their code -- true, and the wrong test. They hold no credentials
# and re-polling costs nothing, so the only thing excluding them achieved was
# leaving the process that derives dark_vessels running whatever code it happened
# to start with. A collector silently running old code is exactly the failure the
# staleness check exists to prevent.
#
# Staleness is decided by comparing each image's build time against the mtime of
# the files that go into it. tar preserves mtimes, so the timestamps here are the
# ones from the machine the code was edited on, which is what makes this work at
# all after a sync.
set -euo pipefail
cd /opt/osint

REBUILD_INGEST=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --ingest) REBUILD_INGEST=1 ;;
    --force)  FORCE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# STALE or FRESH for one image against the paths that build it. A missing image
# reports as built at the epoch, so "never built" and "built too long ago" take
# the same branch rather than needing an error path of their own.
staleness() {
  local image="$1"; shift
  local created epoch count
  created=$(docker image inspect "$image" --format '{{.Created}}' 2>/dev/null || echo "1970-01-01T00:00:00Z")
  epoch=$(date -d "$created" +%s 2>/dev/null || echo 0)
  count=$(find "$@" -type f -newermt "@$epoch" \
            -not -path '*/node_modules/*' \
            -not -path '*/__pycache__/*' \
            -not -path '*/dist/*' 2>/dev/null | wc -l)
  [ "$count" -gt 0 ] && echo STALE || echo FRESH
}

PY_SOURCES=(backend requirements.txt)

echo "Checking which images are behind their source..."
S_BACKEND=$(staleness osint-backend "${PY_SOURCES[@]}")
S_FRONTEND=$(staleness osint-frontend frontend)
S_REFINE=$(staleness osint-refine "${PY_SOURCES[@]}")
S_WORKER=$(staleness osint-cache-worker "${PY_SOURCES[@]}")
S_INGEST=$(staleness osint-ingest "${PY_SOURCES[@]}")

if [ "$FORCE" = 1 ]; then
  S_BACKEND=STALE; S_FRONTEND=STALE; S_REFINE=STALE; S_WORKER=STALE
  echo "  --force given, rebuilding regardless of staleness."
fi

printf "  %-13s %s\n" backend "$S_BACKEND" frontend "$S_FRONTEND" \
                      refine "$S_REFINE" cache-worker "$S_WORKER" ingest "$S_INGEST"

SERVICES=()
[ "$S_BACKEND"  = STALE ] && SERVICES+=(backend)
[ "$S_FRONTEND" = STALE ] && SERVICES+=(frontend)
[ "$S_REFINE"   = STALE ] && SERVICES+=(refine)
[ "$S_WORKER"   = STALE ] && SERVICES+=(cache-worker)
if [ "$REBUILD_INGEST" = 1 ]; then
  SERVICES+=(ingest)
elif [ "$S_INGEST" = STALE ]; then
  INGEST_WARNING=1
fi

if [ ${#SERVICES[@]} -eq 0 ]; then
  echo
  echo "Nothing to rebuild -- every image is newer than its source."
else
  echo
  echo "Rebuilding: ${SERVICES[*]}"
  # --no-deps, or this does more than it reported. frontend depends_on backend,
  # so without it `--build frontend` rebuilds and restarts backend as well --
  # which is harmless in itself but makes the FRESH/STALE table above a lie, and
  # bounces the backend's in-memory registry for no reason (every source reads
  # empty for a minute afterwards while the mirror refills from Postgres).
  #
  # Safe because this deploys against an already-running stack: the dependencies
  # are up, and compose only needed to start them if they were not. If you ever
  # run this on a cold host, `docker compose up -d` first.
  docker compose up -d --build --no-deps "${SERVICES[@]}" 2>&1 | grep -Ei "built|started|error|warn" || true
fi

if [ "${INGEST_WARNING:-0}" = 1 ]; then
  echo
  echo "Note: ingest is running code older than backend/. Not rebuilt, because"
  echo "      restarting it re-polls every metered source. Use --ingest when that"
  echo "      is what you actually want."
fi

# ---- proof, not optimism ---------------------------------------------------
# `compose up` returns when a container has been *started*; nginx and uvicorn
# bind a moment later. A single immediate request races the thing it is testing
# and reports a failure on a deploy that worked, so this retries before
# complaining. A real failure still surfaces -- it just takes a few seconds.
echo
probe() {
  local url="$1" want="$2" code=000
  for _ in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || echo 000)
    [ "$code" = "$want" ] && break
    sleep 2
  done
  echo "$code"
}

CODE_PRIVATE=$(probe http://localhost:8080/ 200)
CODE_API=$(probe http://localhost:8080/api/health 200)
CODE_PUBLIC=$(probe http://localhost:8081/ 200)
# The boundary that matters: writes must still be refused on the public listener
# after any rebuild. A frontend rebuild that dropped the nginx include would
# reopen it silently, and nothing else here would notice.
CODE_WRITE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
              -X PUT -H 'Content-Type: application/json' --data-binary 'not json' \
              http://localhost:8081/api/admin-config || echo 000)

# Read the bundle name out of the running container rather than off the page: it
# is the one thing that proves the *new* build is what is being served.
BUNDLE=$(docker compose exec -T frontend sh -c \
          'ls /usr/share/nginx/html/assets/index-*.js 2>/dev/null' | tr -d '\r' | tail -1)
BUNDLE=$(basename "${BUNDLE:-none}")

SOURCES=$(curl -s --max-time 15 http://localhost:8080/api/health \
          | tr ',' '\n' | grep -c '"item_count":[1-9]' || echo '?')

echo "Bundle:   $BUNDLE"
echo "Private:  /  = $CODE_PRIVATE    /api/health = $CODE_API"
echo "Public:   /  = $CODE_PUBLIC    admin write = $CODE_WRITE (403 expected)"
echo "Sources:  $SOURCES collecting"

[ "$CODE_PRIVATE" = 200 ] || echo "  WARNING: the private listener is not answering 200."
[ "$CODE_API" = 200 ]     || echo "  WARNING: the API is not answering 200 -- docker compose logs backend"
[ "$CODE_PUBLIC" = 200 ]  || echo "  WARNING: the public listener is not answering 200."
[ "$CODE_WRITE" = 403 ]   || echo "  WARNING: the public listener accepted an admin write. Check frontend/nginx.conf."
