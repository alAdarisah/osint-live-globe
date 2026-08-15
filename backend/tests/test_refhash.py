"""Content hashes for the whole-document reference layers.

The bug this closes: backend/app.py mints a per-process token and puts it in
front of every ETag, so two backends -- or one backend either side of a
redeploy -- disagree about the identity of bytes that never changed. Every
reader's cached copy of a 4.7 MB railways document is invalidated by a restart
that touched nothing.

A hash of the payload has the property the token was standing in for (a new
version is a new ETag) without the property that made it expensive (a new
*process* is a new ETag).
"""

import asyncio

from backend import refhash


def test_the_same_payload_hashes_the_same_across_processes():
    """The whole point. A restart re-enters at version 0 or version 7 with the
    same document, and a reader holding that document must be told so."""
    payload = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    assert refhash.content_hash("railways", 3, payload) == refhash.content_hash("railways", 3, payload)


def test_a_changed_payload_hashes_differently():
    a = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    b = {"lines": [{"source": "ne", "path": [[1.0, 2.5]]}]}
    refhash.reset()
    first = refhash.content_hash("railways", 1, a)
    refhash.reset()
    second = refhash.content_hash("railways", 1, b)
    assert first != second


def test_key_order_does_not_change_the_hash():
    """dict ordering is an artefact of how a document was built, not a fact
    about it -- and a source that starts emitting its keys in a different order
    must not invalidate every reader's copy."""
    refhash.reset()
    first = refhash.content_hash("cables", 1, {"a": 1, "b": 2})
    refhash.reset()
    second = refhash.content_hash("cables", 1, {"b": 2, "a": 1})
    assert first == second


def test_a_version_is_hashed_once_and_then_remembered(monkeypatch):
    """Railways is 20.4 MB. Re-hashing it per request would cost more than the
    ETag saves, so the digest is memoised against the version counter the
    poller already bumps (see backend/cache.py's SourceState.data setter).

    Counted by wrapping json.dumps rather than by instrumenting the payload:
    an earlier draft of this test used a dict subclass overriding __iter__,
    which json.dumps' C encoder does not reliably route through -- so it would
    have passed whether or not the memo worked, which is worse than no test."""
    refhash.reset()
    calls = []
    real_dumps = refhash.json.dumps

    def counting_dumps(*args, **kwargs):
        calls.append(1)
        return real_dumps(*args, **kwargs)

    monkeypatch.setattr(refhash.json, "dumps", counting_dumps)

    payload = {"lines": []}
    refhash.content_hash("railways", 5, payload)
    assert len(calls) == 1, "the first call should serialise exactly once"
    refhash.content_hash("railways", 5, payload)
    assert len(calls) == 1, "the second call re-serialised a payload it had already hashed"


def test_a_new_version_rehashes():
    refhash.reset()
    payload = {"lines": []}
    first = refhash.content_hash("railways", 1, payload)
    second = refhash.content_hash("railways", 2, {"lines": [{"source": "ne", "path": []}]})
    assert first != second


def test_an_unserialisable_payload_falls_back_rather_than_raising():
    """A reference document that cannot be hashed is a caching problem, not a
    serving problem. Same rule cachestore.py applies to Redis: degrade to no
    opinion, never take the endpoint down."""
    refhash.reset()
    digest = refhash.content_hash("odd", 1, {"when": object()})
    assert digest is None


def test_a_failure_other_than_type_or_value_error_still_falls_back(monkeypatch):
    """TypeError/ValueError are the documented ways json.dumps refuses a
    payload, but they are not the only way serialising one can fail -- a
    deeply nested document raises RecursionError, which is neither. The
    task's binding rule is that no failure here may propagate into the
    endpoint, so the catch has to be broader than just the two documented
    exceptions, and this pins that down against reverting by accident."""
    refhash.reset()

    def exploding_dumps(*args, **kwargs):
        raise RecursionError("maximum recursion depth exceeded (simulated)")

    monkeypatch.setattr(refhash.json, "dumps", exploding_dumps)
    digest = refhash.content_hash("odd", 1, {"lines": []})
    assert digest is None


def test_with_no_running_loop_it_hashes_inline():
    """Every test above relies on this without saying so -- pytest runs them
    outside asyncio.run, so `asyncio.get_running_loop()` raises and
    content_hash falls through to computing the digest on the spot. Made
    explicit here because it is the path every synchronous caller depends on,
    including the entire test module above this line."""
    refhash.reset()
    payload = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}
    digest = refhash.content_hash("railways", 1, payload)
    assert digest is not None
    assert digest == refhash.content_hash("railways", 1, payload)


def test_with_a_running_loop_the_first_call_defers_and_the_second_collects_it():
    """The whole point of Step 5's fallback: an event loop must not be asked
    to serialise 20 MB inline, so the first caller after a version bump gets
    None (and the process-token ETag, at the app.py layer) while the hash
    finishes on a thread. Once it lands, a caller that asks again gets it."""
    refhash.reset()
    payload = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}

    async def scenario():
        first = refhash.content_hash("railways", 1, payload)
        assert first is None, "a request on the event loop must not block on the hash"

        for _ in range(200):
            if refhash._digests.get("railways") is not None:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the background hash never completed")

        return refhash.content_hash("railways", 1, payload)

    second = asyncio.run(scenario())
    assert second is not None


def test_two_in_flight_calls_for_the_same_version_schedule_one_computation(monkeypatch):
    """A burst of requests landing before the first digest is ready must not
    each pay for their own json.dumps of the same document."""
    refhash.reset()
    calls = []
    real_dumps = refhash.json.dumps

    def counting_dumps(*args, **kwargs):
        calls.append(1)
        return real_dumps(*args, **kwargs)

    monkeypatch.setattr(refhash.json, "dumps", counting_dumps)
    payload = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}

    async def scenario():
        first = refhash.content_hash("railways", 1, payload)
        second = refhash.content_hash("railways", 1, payload)
        assert first is None
        assert second is None, "a second call while the first is in flight must not reschedule"

        for _ in range(200):
            if refhash._digests.get("railways") is not None:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the background hash never completed")

    asyncio.run(scenario())
    assert len(calls) == 1, "two in-flight calls for the same (name, version) serialised the payload twice"


from backend import app as app_mod
from backend.cache import registry
from backend.ratelimit import LruTtlCache


class _Req:
    def __init__(self, if_none_match=None):
        self.headers = {"if-none-match": if_none_match} if if_none_match else {}


async def _warm_railways_hash():
    """Send one throwaway request through the railways endpoint and wait for
    its background hash to land -- standing in for the ordinary traffic a
    layer gets between one poll and the next, which is exactly what makes the
    deferred window (see backend/refhash.py's module docstring) a non-issue
    in practice. Returns the digest once it's ready."""
    await app_mod.railways_endpoint(_Req())  # schedules the background hash
    for _ in range(200):
        digest = refhash._digests.get("railways")
        if digest is not None:
            return digest[1]
        await asyncio.sleep(0.01)
    raise AssertionError("the background hash never completed")


def test_the_railways_etag_survives_a_process_restart(monkeypatch):
    """The bug, end to end. Two processes hold the same document; the second
    must hand a reader who already has it a 304, not 4.7 MB -- and it must
    do so because it *independently recomputed the same digest*, not because
    it happened to reuse the first process's memoised one.

    The first version of this test swapped _PROCESS_TOKEN but never called
    refhash.reset(), so "process two" was still serving out of "process
    one"'s memo -- it proved only that the If-None-Match comparison ignores
    _PROCESS_TOKEN once a digest is cached, not that a fresh process hashing
    the same bytes arrives at the same answer. This version resets the memo
    (and gives each simulated process its own LruTtlCache, since
    LruTtlCache -- see backend/ratelimit.py -- has no .clear(), and a fresh
    cache is more faithful to a real restart anyway, which inherits nothing
    in-memory from the process before it) so the second process's digest is
    computed from scratch, from the same state.data, the same way state.data
    would actually be reloaded across a real restart.
    """
    refhash.reset()
    state = registry.ensure("railways", key_configured=True)
    state.data = {"lines": [{"source": "ne", "path": [[1.0, 2.0]]}]}

    monkeypatch.setattr(app_mod, "_PROCESS_TOKEN", "aaaaaaaa")
    app_mod._FILTERED_CACHE = LruTtlCache(maxsize=256, ttl=300)

    async def first_process():
        digest = await _warm_railways_hash()
        response = await app_mod.railways_endpoint(_Req())
        return digest, response

    first_digest, first_response = asyncio.run(first_process())
    etag = first_response.headers["etag"]
    assert first_digest is not None

    # A different process: new token, fresh filtered-response cache, and a
    # reset refhash memo -- nothing survives from "process one" except the
    # bytes in state.data itself, which is the entire point.
    monkeypatch.setattr(app_mod, "_PROCESS_TOKEN", "bbbbbbbb")
    app_mod._FILTERED_CACHE = LruTtlCache(maxsize=256, ttl=300)
    refhash.reset()

    async def second_process():
        digest = await _warm_railways_hash()
        response = await app_mod.railways_endpoint(_Req(if_none_match=etag))
        return digest, response

    second_digest, second_response = asyncio.run(second_process())

    assert second_digest == first_digest, "a fresh process re-hashed the same bytes to a different digest"
    assert second_response.status_code == 304, "a restart re-sent a document that had not changed"
