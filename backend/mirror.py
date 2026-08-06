"""The backend's read side for everything the ingest process collects.

The sources in backend/ingest are not polled here -- this process makes no
outbound call for any of them. It follows what the ingest process wrote to
Postgres and republishes it into the same registry states the API already serves
from, so /api/ships, /api/aircraft, /api/fires and the conflict layer keep
working exactly as before while the fetching happens somewhere else.

Two things make that affordable and honest:

**The watermark gate.** SourceState.data's setter bumps SourceState.version (see
backend/cache.py), and version *is* the HTTP ETag (see app.py's
_cached_source_response). So republishing on a timer would invalidate every
client's cached copy on every tick -- for FIRMS that is a 100k-point payload
re-downloaded several times a minute to deliver data nobody changed. Instead
each pass reads one indexed row, max(updated_at) for the kind, and only when
that moves does it read the payload at all.

**Health that names the other process.** /api/health is built from this
registry, and a mirrored source that simply reported "fine" would show a green
light over frozen data for as long as the ingest container stayed dead. So the
verdict is derived from the ingest's own source_health rows, and last_success is
*its* timestamp -- the honest answer to "when did this last come from upstream",
not "when did the backend last read a database".

Waking up is Postgres NOTIFY (storage.NOTIFY_CHANNEL), with the interval as a
fallback rather than the mechanism: a write announces itself on commit and the
mirror follows within milliseconds, which is what keeps ship positions live
rather than up to one tick stale.
"""

import asyncio
import logging
import time
from dataclasses import dataclass

import asyncpg

from backend import cachestore, config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.mirror")

# How long to wait before reopening the listener connection after it drops, and
# the ceiling for that wait. Short at the start because the usual cause is
# Postgres restarting underneath us and it comes back in seconds; capped low
# because the fallback tick already covers the gap, so there is nothing to gain
# from backing off into minutes.
_LISTEN_RETRY_START = 2
_LISTEN_RETRY_CAP = 60


@dataclass(frozen=True)
class Mirrored:
    """One registry state fed from Postgres instead of from a poller."""

    name: str
    kind: str
    label: str
    # Seconds between the producing job's writes, used only to decide when it
    # has gone quiet for too long. Not a poll interval -- nothing here polls.
    expected_every: int
    producer: str = "the ingest service"


def from_jobs(jobs, producer: str) -> tuple[Mirrored, ...]:
    """One Mirrored per state a job table publishes.

    Derived from the producing table rather than listed separately, in both
    directions: a second hand-maintained list would eventually disagree, and the
    symptom of disagreement is the worst kind -- a layer that is collected
    correctly, stored correctly, and simply never shown, with nothing in
    /api/health to say so, because a source the backend never registered has no
    state to go red.

    Takes the tables as an argument instead of importing them, so this module
    stays a dependency of both the ingest and refine packages without either of
    them becoming a dependency of it.
    """
    return tuple(
        Mirrored(
            name=pub.name,
            kind=pub.kind,
            label=pub.label,
            expected_every=job.expected_every(),
            producer=producer,
        )
        for job in jobs
        for pub in job.publishes
    )


def health_verdict(
    newest: dict | None,
    newest_ok: dict | None,
    expected_every: int,
    now: float,
    producer: str,
    stale_multiplier: float | None = None,
) -> tuple[float | None, str | None]:
    """`(last_success, last_error)` for a mirrored source, from its health rows.

    Pure, because this is the part that has to be right: every case below was a
    way for a dead collector to look alive, and none of them is reachable from a
    test that needs a database.

    `newest` is the most recent source_health row, `newest_ok` the most recent
    successful one. They are usually the same row; when they differ, both facts
    matter -- "erroring since 10:04" and "last real data 09:58" describe a
    failing source, either one alone describes a healthier or deader source than
    it is.
    """
    multiplier = config.INGEST_STALE_MULTIPLIER if stale_multiplier is None else stale_multiplier
    last_success = newest_ok["ts"].timestamp() if newest_ok else None

    if newest is None:
        # Nothing has ever been recorded for this source. On a first start that
        # is simply "not yet"; if it persists, it means the job is not running
        # at all -- which the message has to say, because the layer being empty
        # looks identical to an upstream with nothing to report.
        return None, f"no data yet -- waiting for {producer} to run for the first time"

    age = now - newest["ts"].timestamp()
    overdue = age > expected_every * multiplier

    if not newest["ok"]:
        reason = newest["error"] or "unknown error"
        message = f"{producer}: {reason}"
        if overdue:
            # The staleness of a *failure* matters as much as the staleness of a
            # success, and this is the case that hid it: a producer that writes
            # one failed row and then dies leaves that row newest forever, so
            # reporting only its message showed a live-looking error for a
            # process that had not run in hours. Observed exactly that way --
            # AIS still explaining a connection problem long after the container
            # holding the connection had stopped.
            message += f" (and has not been heard from for {int(age)}s)"
        return last_success, message

    if overdue:
        return (
            last_success,
            f"{producer} last ran {int(age)}s ago, expected every {expected_every}s"
            " -- this layer is frozen",
        )
    return last_success, None


class _Follower:
    """One mirrored source's loop state. Split out so refresh() is testable."""

    def __init__(self, spec: Mirrored) -> None:
        self.spec = spec
        self.state = registry.ensure(spec.name, key_configured=True)
        self.watermark = None

    async def refresh(self) -> None:
        spec = self.spec
        if storage.get_pool() is None:
            # Deliberately keeps whatever is already published. A database
            # outage is not evidence that the world emptied, and blanking the
            # map on one is both wrong and alarming.
            self.state.last_error = (
                f"no database connection -- showing the last {spec.label} data read"
            )
            return

        try:
            current = await storage.kind_watermark(spec.kind)
        except Exception as exc:  # noqa: BLE001 - a read failure must not end the loop
            self.state.last_error = f"could not check {spec.label} for changes: {exc}"
            log.warning("Watermark read failed for %s: %s", spec.kind, exc)
            return

        if current != self.watermark:
            # The cache is consulted only here, inside the watermark gate, and
            # keyed by that same watermark -- so a hit is by construction the
            # payload built from exactly the rows Postgres just reported as
            # current. A miss costs one extra round trip against a read that
            # runs to 175k rows, which is the trade this is for.
            stamp = current.isoformat() if current is not None else None
            rows = await cachestore.get_payload(spec.kind, stamp)
            if rows is None:
                try:
                    rows = await storage.entity_latest(spec.kind)
                except Exception as exc:  # noqa: BLE001
                    self.state.last_error = f"could not read {spec.label}: {exc}"
                    log.warning("Mirror read failed for %s: %s", spec.kind, exc)
                    return
                await cachestore.set_payload(spec.kind, stamp, rows)
            # Assigned even when empty: reaching here means the watermark moved,
            # so an empty result is the ingest having genuinely nothing to show
            # (or everything having aged out), not a failed read. The pool check
            # above is what separates those two.
            self.state.data = rows
            self.watermark = current

        try:
            newest, newest_ok = await storage.source_health_latest(spec.name)
        except Exception:  # noqa: BLE001 - health is advisory; the data still stands
            return
        last_success, last_error = health_verdict(
            newest, newest_ok, spec.expected_every, time.time(), spec.producer
        )
        self.state.last_success = last_success
        self.state.last_error = last_error


_wakeups: dict[str, asyncio.Event] = {}


def _wake(kind: str) -> None:
    event = _wakeups.get(kind)
    if event is not None:
        event.set()


async def _listen_forever() -> None:
    """Hold one connection open on storage.NOTIFY_CHANNEL, reconnecting forever.

    Its own connection rather than one from the pool: a listener is checked out
    for the life of the process, and taking a pool slot permanently would shrink
    the pool the API shares. asyncpg dispatches the callback on this loop, so it
    only sets an Event -- doing the read here would block the connection that is
    supposed to be receiving the next notification.
    """
    delay = _LISTEN_RETRY_START
    while True:
        conn = None
        try:
            conn = await asyncpg.connect(config.DATABASE_URL)
            await conn.add_listener(
                storage.NOTIFY_CHANNEL, lambda _c, _pid, _ch, payload: _wake(payload)
            )
            log.info("Listening for ingest notifications on %r", storage.NOTIFY_CHANNEL)
            delay = _LISTEN_RETRY_START
            # A dropped TCP connection does not raise on an idle listener -- it
            # just stops delivering, which is indistinguishable from a quiet
            # world. The ping is what turns that silence into an exception and
            # gets the connection rebuilt.
            while True:
                await asyncio.sleep(30)
                await conn.fetchval("SELECT 1")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reconnect forever
            log.warning("Ingest notification listener dropped (%s); retrying in %ds", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, _LISTEN_RETRY_CAP)
        finally:
            if conn is not None:
                await conn.close()


async def _follow_one(spec: Mirrored) -> None:
    follower = _Follower(spec)
    event = _wakeups.setdefault(spec.kind, asyncio.Event())
    while True:
        # Cleared *before* the read, not after: a notification that arrives
        # while the read is in flight describes a write the read may have
        # missed, and clearing afterwards would discard it.
        event.clear()
        await follower.refresh()
        try:
            await asyncio.wait_for(event.wait(), timeout=config.INGEST_MIRROR_INTERVAL)
        except asyncio.TimeoutError:
            pass


def register(specs) -> None:
    """Create every mirrored source's registry state, synchronously.

    Called from app.py's lifespan *before* the follower tasks are scheduled,
    because app.py's endpoints do registry.get(name) and that raises KeyError on
    a name nobody registered yet -- a 500 on /api/ships for the moment between
    the server accepting connections and the first follower task getting a turn.
    Idempotent, so follow() calling it again costs nothing.
    """
    for spec in specs:
        registry.ensure(spec.name, key_configured=True)


async def follow(specs) -> None:
    """Start the listener and one follower per mirrored source.

    The first read of every source happens immediately rather than after a tick.
    That matters in both processes that call this: in the backend, gdelt.py and
    /api/replay read registry.get("acled").data directly, and in the refine
    process the fusion pass reads the same state -- so a first read deferred by
    one interval is an empty conflict layer after every restart.
    """
    specs = tuple(specs)
    register(specs)
    tasks = [asyncio.create_task(_listen_forever())]
    tasks += [asyncio.create_task(_follow_one(spec)) for spec in specs]
    log.info("Mirroring %d sources from Postgres: %s", len(specs), ", ".join(s.name for s in specs))
    await asyncio.gather(*tasks)
