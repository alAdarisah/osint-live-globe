"""Redis in front of Postgres, for the payloads the backend serves.

What this saves is the *large read*, not the small one. The mirror already
answers "did anything change?" with one indexed row (storage.kind_watermark), so
the steady state costs nothing either way. The expensive case is the other one:
a backend restart, or any moment the watermark moves, pulls every row of a kind
out of entity_latest -- 175k rows for FIRMS -- and rebuilds the payload. This
keeps the last built payload where a second backend, or the same one after a
restart, can pick it up without going back to the table.

**The backend is the only writer.** Ingest and refine know nothing about Redis;
they write Postgres and announce on NOTIFY, exactly as before. That is what
makes this a read-through cache rather than a second, parallel write path that
could disagree with the database. Postgres stays the system of record and Redis
holds only what was derived from it.

**Redis being down is not an error.** Every function here degrades to "no
opinion" -- a miss on read, a no-op on write -- so the map keeps serving
straight from Postgres. Same rule storage.py applies to its own pool: a caching
layer that can take the site down is worse than no caching layer.
"""

import json
import logging

from backend import config

log = logging.getLogger("osint-globe.cachestore")

_client = None
_unavailable_logged = False

# Key layout. Namespaced so a Redis shared with anything else stays legible, and
# so the cache worker can enumerate what the backend has cached without knowing
# the list of kinds (see backend/cacheworker).
PREFIX = "osint"


def payload_key(kind: str) -> str:
    return f"{PREFIX}:payload:{kind}"


def watermark_key(kind: str) -> str:
    return f"{PREFIX}:watermark:{kind}"


async def connect() -> None:
    """Open the client. Safe to call when Redis is absent or misconfigured.

    Not awaited for a connection: redis-py connects lazily on first command, so
    a Redis that is still booting costs a few misses rather than blocking
    startup -- the same trade storage.init_pool makes for Postgres.
    """
    global _client
    if not config.REDIS_URL:
        log.info("No REDIS_URL set; serving straight from Postgres")
        return
    try:
        import redis.asyncio as redis

        _client = redis.from_url(config.REDIS_URL, decode_responses=False)
        log.info("Cache configured at %s", config.REDIS_URL)
    except Exception as exc:  # noqa: BLE001 - a cache that fails to configure is not fatal
        log.warning("Could not configure the cache, serving from Postgres only: %s", exc)
        _client = None


async def close() -> None:
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception:  # noqa: BLE001
            pass
        _client = None


def get_client():
    """The raw client, or None. For the cache worker's INFO probes."""
    return _client


def _degrade(action: str, exc: Exception) -> None:
    """Log the first failure at WARNING and the rest at DEBUG.

    A Redis that is down fails on every single call, and at WARNING that is one
    log line per kind per mirror tick -- which buries the actual problem in the
    noise it generates.
    """
    global _unavailable_logged
    if not _unavailable_logged:
        _unavailable_logged = True
        log.warning("Cache unavailable (%s), serving from Postgres: %s", action, exc)
    else:
        log.debug("Cache %s failed: %s", action, exc)


def _recovered() -> None:
    global _unavailable_logged
    if _unavailable_logged:
        _unavailable_logged = False
        log.info("Cache is answering again")


async def get_payload(kind: str, watermark: str | None):
    """The cached payload for `kind`, but only if it was built from `watermark`.

    Returns None on a miss, on a stale entry, or on any Redis failure -- all
    three mean the same thing to the caller: go and read Postgres.

    The watermark check is what makes this safe to share between processes. Two
    backends can hold different ideas of what is current, and serving a payload
    whose watermark does not match the one just read from Postgres would show
    data older than the database itself reported a moment earlier.
    """
    if _client is None or watermark is None:
        return None
    try:
        cached_watermark, raw = await _client.mget(watermark_key(kind), payload_key(kind))
        _recovered()
    except Exception as exc:  # noqa: BLE001
        _degrade("read", exc)
        return None
    if raw is None or cached_watermark is None:
        return None
    if cached_watermark.decode() != watermark:
        return None
    try:
        return json.loads(raw)
    except Exception as exc:  # noqa: BLE001 - a corrupt entry is a miss, not a crash
        log.warning("Discarding an unreadable cache entry for %s: %s", kind, exc)
        return None


async def set_payload(kind: str, watermark: str | None, payload) -> None:
    """Store a payload and the watermark it was built from, together.

    Written in one transaction so a reader can never see a new watermark against
    an old payload -- which is the one interleaving that would serve stale data
    while claiming to be current.
    """
    if _client is None or watermark is None:
        return
    try:
        raw = json.dumps(payload, default=str).encode()
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not serialize %s for the cache: %s", kind, exc)
        return
    if len(raw) > config.CACHE_MAX_PAYLOAD_BYTES:
        # FIRMS runs to 175k points, and a payload large enough to push Redis
        # past maxmemory would evict every *other* kind to hold one. Skipping is
        # the cheaper failure: that kind is read from Postgres, everything else
        # stays cached. The cache worker reports this rather than leaving it to
        # be inferred from a hit ratio.
        log.debug("Not caching %s: %d bytes exceeds the payload ceiling", kind, len(raw))
        return
    try:
        async with _client.pipeline(transaction=True) as pipe:
            pipe.set(payload_key(kind), raw, ex=config.CACHE_TTL)
            pipe.set(watermark_key(kind), watermark, ex=config.CACHE_TTL)
            await pipe.execute()
        _recovered()
    except Exception as exc:  # noqa: BLE001
        _degrade("write", exc)
