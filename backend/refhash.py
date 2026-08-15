"""Content hashes for the whole-document reference layers.

backend/app.py's ETags lead with `_PROCESS_TOKEN`, a uuid minted at import.
That is correct but blunt: `state.version` restarts at 0 in a new process, so
without something process-scoped in front of it, version 3 in one process and
version 3 in another would claim to be the same bytes when they need not be.

The cost is that it is *also* true in the other direction, and that direction
is the expensive one. A redeploy that changed nothing about the railways
document still mints a new token, so every reader's cached 4.7 MB copy is
invalidated by a restart that touched no data at all.

A hash of the payload answers the same question properly: same bytes, same
ETag, whoever is serving and whenever. Memoised against the version counter
the pollers already bump (see backend/cache.py's SourceState.data setter), so
a 20 MB document is serialised once per refresh rather than once per request.

Measured cost for the real railways document (20.4 MB): 359 ms to serialise,
8 ms to hash -- 367 ms total. That is well past what may run inline on the
event loop, but the brief's original fix (make `_cached_source_response`
`await asyncio.to_thread(...)`) was rejected in favour of the scheme below,
because it would have meant `await` at 39 call sites for a computation that
only ever needs to happen once a day per layer. Instead, this module hides the
thread hop entirely: when there is a running event loop, `content_hash`
schedules the work in the background and returns None immediately rather than
blocking the request that happened to trigger it.

That makes None ambiguous on purpose -- it now means either "cannot be
hashed" (see below) or "being hashed, ask again shortly" -- and callers do not
need to tell the two apart, because both already have the correct fallback:
`_cached_source_response` uses the process-token ETag whenever the digest
isn't in hand. The practical effect is that the first request after a poller
bumps a version gets the process-token ETag, and every request after it -- for
the rest of that version's lifetime, which is typically hours -- gets the
stable content hash. That one-request window is the entire cost of not
threading `asyncio.to_thread` through every call site, and it is a trade this
module makes deliberately, not an oversight: do not "fix" it by blocking the
request on the background computation, which is the exact stall this design
exists to avoid.
"""

import asyncio
import hashlib
import json
import logging

log = logging.getLogger("osint-globe.refhash")

# name -> (version, digest). Bounded by the number of reference layers, which
# is a handful and fixed at import -- not a cache that needs an eviction rule.
_digests: dict[str, tuple[int, str | None]] = {}

# (name, version) pairs whose hash is currently being computed on a
# background thread. Consulted so that a burst of requests arriving before
# the first version's digest is ready don't each schedule their own
# json.dumps of a 20 MB document -- they all get None back and the digest
# lands once, for whichever of them asks next.
_in_flight: set[tuple[str, int]] = set()

# Strong references to the scheduled background tasks. asyncio.Task holds no
# reference to itself, and a fire-and-forget task created with no other
# referent can be garbage-collected mid-flight -- silently dropping the
# computation with no error anywhere. Keeping this set (and clearing entries
# via each task's done-callback) is what keeps the task alive until it
# finishes. See the asyncio.create_task docs' "Important" note.
_background_tasks: set[asyncio.Task] = set()


def reset() -> None:
    """Forget every memoised digest and in-flight computation. For tests."""
    _digests.clear()
    _in_flight.clear()


def _hash_now(name: str, version: int, payload) -> str | None:
    """The actual serialise-and-hash, run either inline or inside a thread."""
    try:
        # sort_keys because dict ordering is an artefact of how a document was
        # assembled rather than a fact about it, and a source that starts
        # emitting keys in a different order must not invalidate every reader's
        # copy. separators drops the whitespace json.dumps would otherwise put
        # in a 20 MB serialisation nobody reads.
        #
        # Deliberately no default=str, unlike backend/cachestore.py's
        # set_payload. That function serialises a payload *to serve* to a
        # reader, where a lossy repr of some odd value is harmless. This
        # function serialises a payload to compute its *identity*, where it
        # is not: str(object()) yields something like
        # '<object object at 0x7f9c1a2b3c40>', which embeds the object's
        # memory address and therefore differs between processes and even
        # between runs of the same process. A payload containing such a value
        # would silently hash differently on every restart -- destroying the
        # exact cross-process stability this module exists to provide, and
        # doing so in precisely the one case nobody would think to write a
        # test for. Raising here and falling back to the process-token ETag
        # is the honest answer; a fabricated-but-unstable digest is worse
        # than admitting the payload could not be hashed.
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    except (TypeError, ValueError) as exc:
        log.warning("Could not hash the %s document, falling back to the process ETag: %s", name, exc)
        _digests[name] = (version, None)
        return None
    # 16 hex characters is 64 bits. An ETag only has to distinguish the
    # versions of one document from each other, and a collision there would
    # need two different revisions of the same layer to agree in 64 bits.
    digest = hashlib.sha256(raw).hexdigest()[:16]
    _digests[name] = (version, digest)
    return digest


def content_hash(name: str, version: int, payload) -> str | None:
    """A short stable digest of `payload`, or None if it isn't available yet.

    None covers two different situations and callers are not meant to tell
    them apart -- both already have the same correct response, which is to
    fall back to the process-token ETag:

    - the payload cannot be hashed at all (see `_hash_now`), or
    - the payload *can* be hashed but the hash is being computed on a
      background thread right now, because computing it inline would stall
      the request that happened to trigger it (see the module docstring).

    Same degradation rule backend/cachestore.py applies to a Redis that is
    down: a caching layer that can take the site down is worse than no
    caching layer.
    """
    cached = _digests.get(name)
    if cached is not None and cached[0] == version:
        return cached[1]

    key = (name, version)
    if key in _in_flight:
        return None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No event loop means no request being held up by computing this
        # inline -- a synchronous caller, or a test running outside
        # asyncio.run. 367 ms costs nothing here because nothing is waiting
        # on it.
        return _hash_now(name, version, payload)

    _in_flight.add(key)

    async def _compute():
        try:
            await asyncio.to_thread(_hash_now, name, version, payload)
        finally:
            _in_flight.discard(key)

    task = loop.create_task(_compute())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return None
