"""What the ingest process runs, as data rather than as code.

Every source that makes a *credentialed or metered* outbound call lives here
instead of in the backend. The reason is quota, not tidiness: ACLED is an OAuth
account on an embargoed research tier, FIRMS is a map key, OpenSky charges 4
credits per global states/all against 4000 a day, and aisstream is a
subscription that will drop a client that reconnects too eagerly. With those
pollers inside the API process, every backend restart, redeploy and local dev
run spent that budget again, and whoever happened to be running the backend was
the one spending it. One process owns them now, and the backend reads what it
produced back out of Postgres (see backend/mirror.py).

The table below is the single source of truth for that split. backend/mirror.py
builds the backend's read side *from this same table*, so a source cannot be
ingested without being mirrored, or mirrored without being ingested -- the drift
that would otherwise show up as a permanently empty map layer with a green
health light.

Deliberately dependency-free: module names are strings, imported only when a job
actually runs, and there is no apscheduler import anywhere in this file. That
keeps the table importable by the backend (which has no reason to load httpx
clients and websocket machinery) and by the tests (which run without the
scheduler installed).
"""

import importlib
import logging
from dataclasses import dataclass
from typing import Callable

from backend import config, storage

log = logging.getLogger("osint-globe.ingest")


@dataclass(frozen=True)
class Published:
    """One (registry state, entity_latest kind) pair a job produces.

    Usually one per job. ACLED is the exception: it publishes the live feed and
    the reviewed UCDP history as two separate states on purpose, so nothing
    downstream can mistake a month-old verified dataset for current events.
    """

    name: str
    kind: str
    label: str


@dataclass(frozen=True)
class Job:
    module: str
    entrypoint: str
    publishes: tuple[Published, ...]
    # None marks a job that paces itself -- see streams() below. Otherwise a
    # callable rather than an int, because two of these intervals depend on
    # credentials that are read at runtime: ACLED polls at its own rate only
    # when it has an account, and ADS-B's interval doubles when it is anonymous.
    interval: Callable[[], int] | None
    # How often a source_health row should appear for this job, which is what
    # the backend measures "overdue" against (see backend/mirror.py). Equal to
    # `interval` for scheduled jobs, so it is only given for the self-paced ones,
    # which record health on a cadence of their own. Those two values are copied
    # from the source modules rather than imported from them: importing would
    # pull websockets and httpx clients into the backend process, which is
    # precisely what this split exists to avoid. test_ingest_jobs.py asserts the
    # copies still match the originals.
    health_every: int | None = None

    @property
    def name(self) -> str:
        """The job's primary source name -- what source_health rows are keyed by."""
        return self.publishes[0].name

    def expected_every(self) -> int:
        if self.health_every is not None:
            return self.health_every
        return self.interval()


def _adsb_authenticated() -> bool:
    return bool(config.OPENSKY_CLIENT_ID and config.OPENSKY_CLIENT_SECRET)


def _adsb_interval() -> int:
    # Read from config rather than restated here: the 120s value carries a
    # comment explaining that OpenSky's budget is credits and not calls, and
    # duplicating the number would eventually let the two drift.
    return config.ADSB_POLL_INTERVAL_AUTH if _adsb_authenticated() else config.ADSB_POLL_INTERVAL_ANON


def _acled_interval() -> int:
    configured = bool(config.ACLED_EMAIL and config.ACLED_PASSWORD)
    return config.ACLED_POLL_INTERVAL if configured else config.UCDP_POLL_INTERVAL


_JOBS = (
    Job(
        module="acled",
        entrypoint="ingest_once",
        publishes=(
            Published("acled", "acled", "Conflict events"),
            Published("conflict_history", "conflict_history", "Verified conflict history"),
        ),
        interval=_acled_interval,
    ),
    Job(
        module="firms",
        entrypoint="ingest_once",
        publishes=(Published("firms", "firms", "FIRMS"),),
        interval=lambda: config.FIRMS_POLL_INTERVAL,
    ),
    Job(
        module="adsb",
        entrypoint="ingest_once",
        publishes=(Published("adsb", "adsb", "Aircraft"),),
        interval=_adsb_interval,
    ),
    # Credentialed and metered, so it belongs here rather than in the backend --
    # but note that quota is not what makes it metered enough to matter (a sweep
    # is 0.5% of the daily allowance). Payload is: 46 vector tiles and several
    # megabytes per pass, which no backend restart should be spending again.
    Job(
        module="gfw_detections",
        entrypoint="ingest_once",
        publishes=(
            Published("gfw_detections", "gfw_detections", "Satellite vessel detections"),
        ),
        interval=lambda: config.GFW_POLL_INTERVAL,
    ),
    # The second opinion on dark_vessels' central inference, and the reason it
    # is credentialed rather than derived: unlike that module, this one fetches.
    # It is here rather than in refine for the ordinary reason -- a token -- and
    # it matters more than usual that only one process holds it, because the
    # sweep pages a 30-day window and a backend restart would re-page all of it.
    Job(
        module="gfw_gaps",
        entrypoint="ingest_once",
        publishes=(Published("gfw_gaps", "gfw_gaps", "AIS disabling (GFW)"),),
        interval=lambda: config.GFW_GAPS_POLL_INTERVAL,
    ),
    # The ships layer's second supplier (see backend/sources/marinesia.py). A
    # scheduled job rather than a stream, and registered as its own kind rather
    # than as another producer of "ais": the two feeds have very different
    # density, and merging them would make that layer mean something different
    # depending on which supplier happened to be up -- including to
    # dark_vessels.py, which reads the AIS movement log to decide whether a hull
    # went quiet.
    Job(
        module="marinesia",
        entrypoint="ingest_once",
        publishes=(Published("marinesia", "marinesia", "Ships (Marinesia)"),),
        interval=lambda: config.MARINESIA_POLL_INTERVAL,
    ),
    # Both of these pace themselves and are run as long-lived tasks, not on an
    # interval. AIS is a persistent websocket subscription whose reconnect
    # backoff (BACKOFF_CAP=900, jittered) exists precisely to avoid hammering
    # aisstream during a multi-hour outage -- re-entering it on a timer would
    # defeat that. The Overpass sweep takes ~20 minutes, publishes each theatre
    # as it lands rather than at the end, and lengthens its own retry after a
    # failed pass; a fixed interval would either overlap sweeps or throw that
    # adaptive retry away.
    Job(
        module="ais",
        entrypoint="stream_forever",
        publishes=(Published("ais", "ais", "Ships"),),
        interval=None,
        health_every=60,  # ais.HEALTH_INTERVAL
    ),
    Job(
        module="osm_infra",
        entrypoint="sweep_forever",
        publishes=(Published("osm_infra", "osm_infra", "OSM infrastructure"),),
        interval=None,
        health_every=24 * 3600,  # osm_infra.REFRESH_INTERVAL
    ),
)


def jobs() -> tuple[Job, ...]:
    """Jobs the scheduler runs on a fixed interval."""
    return tuple(job for job in _JOBS if job.interval is not None)


def streams() -> tuple[Job, ...]:
    """Jobs that run once, forever, and pace themselves."""
    return tuple(job for job in _JOBS if job.interval is None)


def all_jobs() -> tuple[Job, ...]:
    return _JOBS


def published() -> tuple[Published, ...]:
    return tuple(p for job in _JOBS for p in job.publishes)


async def run_job(job: Job) -> None:
    """Run one job's step, swallowing anything it raises.

    A scheduler is not a supervisor: APScheduler logs a raising job and moves on,
    but the failure would be invisible to /api/health, which reads source_health
    rows rather than the scheduler's log. So a crash is recorded as a failed poll
    for every state the job publishes -- which is what makes the backend's mirror
    turn that layer red with the real reason on it, instead of showing the last
    good data under a green light forever.
    """
    module = importlib.import_module(f"backend.sources.{job.module}")
    try:
        await getattr(module, job.entrypoint)()
    except Exception as exc:  # noqa: BLE001 - one bad job must not stop the rest
        log.exception("Ingest job %r failed", job.module)
        for pub in job.publishes:
            await storage.record_source_health(pub.name, None, False, str(exc))
