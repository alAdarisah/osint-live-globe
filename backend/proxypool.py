"""A rotating pool of public proxies, for egress a direct connection can't make.

Every collector here talks to its source directly, and that stays the default:
a direct connection is the one a service's operator can see, attribute and rate
limit, and it is the only one that keeps working when nothing is wrong. This
module is for the narrower case where the direct path fails for a reason that is
about our egress rather than about the data -- an IP a source has blocked or
throttled while the account and key are still good. aisstream is the immediate
example: it limits by account *and* by IP (aisstream/issues#253), so a client
that leans too hard during one of its outages can earn a block that outlives the
outage it was reacting to.

Four things are deliberately narrow:

  * Nothing reaches for a proxy until a direct connection has failed repeatedly,
    and a direct attempt still leads every cycle (see ais._egress_plan). The
    proxy is a fallback, never the normal path -- when the source recovers we are
    back on our own IP without anything having to notice or be reconfigured.
  * The list is fetched lazily, so a healthy stack never requests it at all.
  * A proxy is an untrusted intermediary and is treated as one. Everything
    routed through here is TLS to the origin, tunnelled by CONNECT or SOCKS, so
    the operator learns which host we reached and how much traffic there was,
    and cannot read the credential inside the tunnel or forge a frame back out
    of it. That property is the whole basis for this being acceptable, and it
    ends the moment someone routes a plain-http call through it or turns
    certificate verification off. Don't.
  * Rotating proxies does not multiply how hard we lean on the source. The
    caller's backoff still governs the cycle, and the per-cycle attempt cap is
    small -- see AIS_PROXY_ATTEMPTS.

The list is Proxifly's (github.com/proxifly/free-proxy-list), read from their
CDN on every refresh rather than vendored: they rebuild it every 5 minutes, and
a free proxy's useful life is frequently shorter than that.

One cosmetic effect worth knowing before you go looking for a bug: attempts
through dead nodes make asyncio log `EOFError: stream ended` tracebacks from
inside websockets and python-socks, on the callback handler rather than up the
stack. They are not raised, nothing is lost, and they only appear once proxying
is switched on.
"""

import asyncio
import logging
import random
import time
from dataclasses import dataclass

import httpx

from backend import config

log = logging.getLogger("osint-globe.proxypool")

_TIMEOUT = httpx.Timeout(20.0, connect=10.0)

# Which of Proxifly's per-protocol files backs each protocol we will use.
#
# Note the third entry. The folder is "https" but its records are protocol
# "http" with https: true -- Proxifly files an HTTP proxy under "https" when it
# will CONNECT to a TLS origin, which is the only kind of HTTP proxy anything
# here can use. protocols/http is the complement of that set, not a superset of
# it: those are the ones that will not tunnel, and every one of them fails at
# the CONNECT.
_LIST_FILES = {
    "socks5": "socks5",
    "socks4": "socks4",
    "http": "https",
}

# Ceiling on the per-proxy cooldown below, so a node that failed six times at
# 08:00 is not excluded for the rest of the day. Free proxies come back.
_COOLDOWN_CAP = 6 * 3600


@dataclass(frozen=True)
class Proxy:
    """One entry, in the form websockets/httpx take as their `proxy` argument."""

    url: str
    protocol: str
    country: str | None = None
    anonymity: str | None = None
    score: float = 0.0

    def __str__(self) -> str:  # what goes in a log line
        where = self.country or "??"
        return f"{self.url} ({where})"


@dataclass
class _Outcome:
    """What happened last time we used this proxy.

    `fail` is a consecutive-failure streak, not a lifetime total: it is what
    sets the cooldown, and a node that works again has earned back its place.
    `ok` is the lifetime count, and is only read as a boolean -- has this one
    ever actually carried a connection.
    """

    ok: int = 0
    fail: int = 0
    last_ok: float = 0.0
    last_fail: float = 0.0


_pool: list[Proxy] = []
_fetched_at: float = 0.0
_outcomes: dict[str, _Outcome] = {}
# Serialises refresh so a burst of failing connections doesn't fetch the list
# once per attempt. The TTL check is inside the lock for the same reason: the
# second caller through re-checks and finds the list already fresh.
_refresh_lock = asyncio.Lock()


def _parse(entries, protocol: str) -> list[Proxy]:
    """Proxifly's JSON for one protocol, as Proxy records.

    Skips anything malformed rather than raising: this is a free list rebuilt by
    a scraper every five minutes, and one bad record is not a reason to have no
    proxies at all.
    """
    out: list[Proxy] = []
    if not isinstance(entries, list):
        return out
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        url = entry.get("proxy")
        if not isinstance(url, str) or entry.get("protocol") != protocol:
            continue
        if not url.startswith(f"{protocol}://"):
            continue
        # Only meaningful for HTTP proxies, where it is Proxifly's record of
        # whether the node will CONNECT to a TLS origin. SOCKS carries whatever
        # bytes it is given, so the flag says nothing there and is not read --
        # requiring it would discard the entire SOCKS5 list, which reports
        # https: false almost universally.
        if protocol == "http" and entry.get("https") is not True:
            continue
        geo = entry.get("geolocation")
        score = entry.get("score")
        out.append(
            Proxy(
                url=url,
                protocol=protocol,
                country=(geo or {}).get("country") if isinstance(geo, dict) else None,
                anonymity=entry.get("anonymity") if isinstance(entry.get("anonymity"), str) else None,
                score=float(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else 0.0,
            )
        )
    return out


async def refresh(force: bool = False) -> int:
    """Re-read the lists if the cached copy has aged out. Returns the pool size.

    Never raises and never empties the pool on a failed fetch: a stale list of
    proxies that worked an hour ago is worth more than no list, and the caller
    is already in a failure path when it gets here.
    """
    global _pool, _fetched_at
    async with _refresh_lock:
        if not force and _pool and time.time() - _fetched_at < config.PROXY_LIST_TTL:
            return len(_pool)

        fetched: dict[str, Proxy] = {}
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            for protocol in config.PROXY_PROTOCOLS:
                filename = _LIST_FILES.get(protocol)
                if filename is None:
                    log.warning(
                        "PROXY_PROTOCOLS lists %r, which has no Proxifly file -- known: %s",
                        protocol, ", ".join(sorted(_LIST_FILES)),
                    )
                    continue
                url = f"{config.PROXY_LIST_BASE}/{filename}/data.json"
                try:
                    response = await client.get(url)
                    response.raise_for_status()
                    entries = response.json()
                except Exception as exc:  # noqa: BLE001 - a missing list is not fatal
                    log.warning("proxy list %s unavailable: %s", url, exc)
                    continue
                for proxy in _parse(entries, protocol):
                    fetched.setdefault(proxy.url, proxy)

        if not fetched:
            log.warning("proxy list refresh produced nothing; keeping %d cached", len(_pool))
            return len(_pool)

        pool = list(fetched.values())
        # Shuffled before the cap, not sorted. Every client of this list reads
        # the same file in the same order, so capping off the front would point
        # every one of them at the same few hundred nodes.
        random.shuffle(pool)
        _pool = pool[: config.PROXY_POOL_MAX]
        _fetched_at = time.time()
        _prune_outcomes()
        log.info(
            "proxy pool refreshed: %d usable of %d listed (%s)",
            len(_pool), len(fetched),
            ", ".join(f"{p}={sum(1 for x in _pool if x.protocol == p)}" for p in config.PROXY_PROTOCOLS),
        )
        return len(_pool)


def _prune_outcomes() -> None:
    """Forget nodes that have dropped off the list, so this can't grow forever."""
    live = {p.url for p in _pool}
    for url in [u for u in _outcomes if u not in live]:
        del _outcomes[url]


def _cooldown_over(proxy: Proxy, now: float) -> bool:
    outcome = _outcomes.get(proxy.url)
    if outcome is None or not outcome.fail:
        return True
    cooldown = min(config.PROXY_FAILURE_COOLDOWN * outcome.fail, _COOLDOWN_CAP)
    return now - outcome.last_fail >= cooldown


def _tier(proxy: Proxy, now: float) -> int:
    """0 = carried a connection recently, 1 = untried, 2 = tried and failed.

    Recency matters more than the list's own score, which is 1 for essentially
    every free entry: a node that worked ten minutes ago is the best evidence
    available about what will work now.
    """
    outcome = _outcomes.get(proxy.url)
    if outcome is None or not (outcome.ok or outcome.fail):
        return 1
    if outcome.ok and now - outcome.last_ok <= config.PROXY_SUCCESS_MEMORY:
        return 0
    return 2


async def candidates(limit: int | None = None) -> list[Proxy]:
    """Proxies worth trying now, best first. Refreshes the list if it has aged out."""
    await refresh()
    now = time.time()
    usable = [p for p in _pool if _cooldown_over(p, now)]
    # Shuffle first, then a stable sort by tier: equal-tier nodes come out in a
    # different order every call, so a run of failures walks the list instead of
    # retrying the same head of it.
    random.shuffle(usable)
    usable.sort(key=lambda p: (_tier(p, now), -p.score))
    return usable[:limit] if limit is not None else usable


def record(url: str, ok: bool) -> None:
    """Log how a proxy behaved, which is what ranks it next time.

    `ok` means the node carried a connection to the origin -- not that the
    origin was pleased to receive it. A proxy that tunnels cleanly to a service
    which then refuses us has done its job perfectly and is exactly the node to
    try first next time; what it has told us is that our own IP was never the
    problem. Only failing to reach the origin at all counts against a node.
    """
    outcome = _outcomes.setdefault(url, _Outcome())
    now = time.time()
    if ok:
        outcome.ok += 1
        outcome.fail = 0
        outcome.last_ok = now
    else:
        outcome.fail += 1
        outcome.last_fail = now


def stats() -> dict:
    """Pool state, for a log line or a health payload."""
    now = time.time()
    return {
        "size": len(_pool),
        "age_seconds": round(now - _fetched_at) if _fetched_at else None,
        "known_good": sum(1 for p in _pool if _tier(p, now) == 0),
        "cooling_off": sum(1 for p in _pool if not _cooldown_over(p, now)),
        "by_protocol": {
            protocol: sum(1 for p in _pool if p.protocol == protocol)
            for protocol in config.PROXY_PROTOCOLS
        },
    }


def reset() -> None:
    """Drop all state. For tests, and for a config change that invalidates the pool."""
    global _pool, _fetched_at
    _pool = []
    _fetched_at = 0.0
    _outcomes.clear()
