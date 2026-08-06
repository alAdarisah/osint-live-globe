"""What the refine process runs: the work that derives new facts from stored ones.

Nothing here fetches. Every job reads rows the ingest process or the backend
already wrote to Postgres, derives something from them, and writes the result
back. That is the whole definition of this tier, and it is why these three moved
out of the API process: fusion in particular is ~1600 lines of clustering,
geo-reconciliation and reliability scoring running on GDELT's cadence, and it was
sharing an event loop with every request the map made.

Three jobs, all self-paced rather than scheduled:

  event_fusion  collapses ACLED + UCDP + GDELT into one record per incident
  dark_vessels  derives AIS gaps and ship-to-ship pairs from position history
  escalation    ranks regions running above their own recent baseline

Unlike backend/ingest, there is no scheduler here. Each of these already owns a
loop that carries real logic -- fusion waits for its inputs and rehydrates a
3-day accumulator before its first pass, dark_vessels retries sooner after a
failure than its normal 15 minutes, escalation is a plain interval -- and a
scheduler would only be a second, weaker copy of pacing they already do
correctly. APScheduler earns its place in the ingest process, where the
intervals are fixed metered budgets; it would earn nothing here.

Fusion reads its inputs from the registry, so this process mirrors them from
Postgres first (see INPUTS below and backend/mirror.py) exactly as the backend
does. That is the same machinery, pointed at a different set of kinds.
"""

import importlib
import logging
from dataclasses import dataclass

from backend import config, mirror, storage
from backend.ingest import Published

log = logging.getLogger("osint-globe.refine")


@dataclass(frozen=True)
class Job:
    module: str
    entrypoint: str
    # Empty for a job whose output is not a point layer. escalation writes a
    # single ranked document to reference_snapshots, which has no per-row
    # lat/lon and so nothing for the backend to mirror into a registry state --
    # app.py reads it straight out of the table instead.
    publishes: tuple[Published, ...]
    # The source_health name, and how often a row should appear under it. Given
    # explicitly rather than derived from publishes, because escalation has a
    # health row without publishing a layer.
    health_name: str
    health_every: int

    def expected_every(self) -> int:
        return self.health_every


_JOBS = (
    Job(
        module="backend.sources.event_fusion",
        entrypoint="fuse_forever",
        publishes=(Published("events", "events", "Fused conflict events"),),
        health_name="events",
        health_every=config.GDELT_POLL_INTERVAL,
    ),
    Job(
        module="backend.sources.dark_vessels",
        entrypoint="derive_forever",
        publishes=(Published("dark_vessels", "dark_vessels", "Dark vessels"),),
        health_name="dark_vessels",
        health_every=15 * 60,  # dark_vessels.REFRESH_INTERVAL
    ),
    Job(
        module="backend.escalation",
        entrypoint="rank_forever",
        publishes=(),
        health_name="escalation",
        health_every=config.ESCALATION_REFRESH_INTERVAL,
    ),
)


# What fusion needs in its registry before it can fuse anything, and where each
# one comes from. Two are produced by the ingest process and two by the backend,
# which is exactly why this list is written out rather than derived from either
# job table -- the refine process is downstream of both.
#
# The expected_every values are only used to decide when an input has gone
# quiet; nothing here polls.
INPUTS = (
    mirror.Mirrored(
        name="acled", kind="acled", label="Conflict events",
        expected_every=config.ACLED_POLL_INTERVAL, producer="the ingest service",
    ),
    mirror.Mirrored(
        name="firms", kind="firms", label="FIRMS",
        expected_every=config.FIRMS_POLL_INTERVAL, producer="the ingest service",
    ),
    mirror.Mirrored(
        name="gdelt_conflict", kind="gdelt_conflict", label="GDELT conflict events",
        expected_every=config.GDELT_POLL_INTERVAL, producer="the backend",
    ),
    mirror.Mirrored(
        name="jamming", kind="jamming", label="GPS jamming",
        expected_every=6 * 3600, producer="the backend",  # jamming.REFRESH_INTERVAL
    ),
)


def all_jobs() -> tuple[Job, ...]:
    return _JOBS


def published() -> tuple[Published, ...]:
    return tuple(p for job in _JOBS for p in job.publishes)


async def run_job(job: Job) -> None:
    """Run one job forever, recording a crash rather than dying silently.

    These jobs are their own loops, so reaching the except means the loop itself
    fell over -- not one bad pass, which each of them already handles. Recorded
    to source_health so the backend's mirror turns the layer red with the reason
    on it; without that the map would keep serving the last fused result under a
    green light for as long as the container stayed up.
    """
    module = importlib.import_module(job.module)
    try:
        await getattr(module, job.entrypoint)()
    except Exception as exc:  # noqa: BLE001 - one dead job must not stop the rest
        log.exception("Refine job %r stopped", job.module)
        await storage.record_source_health(job.health_name, None, False, str(exc))
