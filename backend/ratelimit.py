"""Small shared helpers for the on-demand upstream proxies (/api/wind and
/api/weather/tile), which differ from every polled source: they fetch when a
*client* asks, so their upstream call volume is driven by whoever is using
the map rather than by a fixed interval.

Two pieces:
  LruTtlCache  -- bounded cache that evicts the oldest entry when full.
                  The proxies previously called .clear() on overflow, which
                  threw away hot entries along with cold ones and guaranteed
                  a burst of upstream refetches right after.
  TokenBucket  -- caps how many *upstream* calls can be made per unit time.
                  Both providers meter on a hard daily quota, so the thing
                  worth limiting is cache misses reaching them, not requests
                  arriving here (a cache hit costs the quota nothing).
"""

import time
from collections import OrderedDict
from typing import Any


class LruTtlCache:
    """Insertion-ordered cache with a size cap and per-entry TTL."""

    def __init__(self, maxsize: int, ttl: float) -> None:
        self._data: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._maxsize = maxsize
        self._ttl = ttl

    def get(self, key):
        entry = self._data.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if time.time() - stored_at >= self._ttl:
            del self._data[key]
            return None
        self._data.move_to_end(key)  # mark as most recently used
        return value

    def set(self, key, value) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = (time.time(), value)
        while len(self._data) > self._maxsize:
            self._data.popitem(last=False)  # drop the least recently used

    def __len__(self) -> int:
        return len(self._data)


class TokenBucket:
    """Classic token bucket: `capacity` calls available, refilled at
    `refill_per_second`, allowing a burst up to capacity but bounding the
    sustained rate.

    Deliberately process-global rather than per-client-IP: the resource being
    protected is one shared API quota, so what matters is the total outbound
    rate, and a per-IP limiter would let N clients multiply it by N.
    """

    def __init__(self, capacity: float, refill_per_second: float) -> None:
        self._capacity = capacity
        self._tokens = capacity
        self._refill = refill_per_second
        self._last = time.monotonic()

    def take(self, tokens: float = 1.0) -> bool:
        now = time.monotonic()
        self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._refill)
        self._last = now
        if self._tokens >= tokens:
            self._tokens -= tokens
            return True
        return False
