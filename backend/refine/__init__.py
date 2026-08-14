"""What the refine process runs: the work that derives new facts from stored ones.

Nothing here fetches. Every job reads rows the ingest process or the backend
already wrote to Postgres, derives something from them, and writes the result
back. That is the whole definition of this tier, and it is why these three moved
out of the API process: fusion in particular is ~1600 lines of clustering,
geo-reconciliation and reliability scoring running on GDELT's cadence, and it was
sharing an event loop with every request the map made.

Several jobs, most self-paced rather than scheduled:

  event_fusion    collapses ACLED + UCDP + GDELT into one record per incident
  dark_vessels    derives AIS gaps and ship-to-ship pairs from position history
  escalation      ranks regions running above their own recent baseline
  port_calls      finds vessel dwells near a port in the AIS movement log
  vessel_profile  reads cargo class and laden/ballast state off the same
                   AIS movement log port_calls reads, per hull
  flight_legs     derives departure/arrival legs from the ADS-B movement log,
                   the aviation twin of port_calls

Unlike backend/ingest, there is no scheduler here. Each of these already owns a
loop that carries real logic -- fusion waits for its inputs and rehydrates a
3-day accumulator before its first pass, dark_vessels retries sooner after a
failure than its normal 15 minutes, escalation, port_calls and vessel_profile
are a plain interval (a dwell has to run an hour before it is even a
candidate and a draught-history verdict does not get more correct by retrying
faster, so nothing about either is made more correct by a tighter loop) --
and a scheduler would only be a second, weaker copy of pacing they already do
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
    # Like escalation, this writes one keyed document to reference_snapshots
    # rather than a point layer -- the coordinates it attaches to already exist
    # on the airports layer -- so it publishes nothing for the backend to mirror
    # and app.py reads the table directly.
    Job(
        module="backend.sources.airfield_activity",
        entrypoint="derive_forever",
        publishes=(),
        health_name="airfield_activity",
        health_every=30 * 60,  # airfield_activity.REFRESH_INTERVAL
    ),
    # Writes vessel_port_calls rows rather than an entity_latest kind or a
    # keyed reference document -- port_calls_for()/port_calls_at() in
    # backend/storage.py are the read side, queried per vessel or per port
    # rather than served whole, so there is nothing here for the backend to
    # mirror either.
    Job(
        module="backend.refine.port_calls",
        entrypoint="derive_forever",
        publishes=(),
        # port_calls.HEALTH_NAME, copied rather than imported for the same
        # reason ingest's job table copies ais.py's HEALTH_INTERVAL: this
        # table has to be readable without pulling in everything a job module
        # imports (see test_ingest_jobs.py's
        # test_stream_health_cadence_matches_the_source_module).
        health_name="port_calls",
        health_every=config.PORT_CALL_INTERVAL,
    ),
    # Cargo class and laden/ballast state per hull, keyed by MMSI in
    # reference_snapshots under "vessel_profiles" -- one document per hull
    # rather than a point layer, since the coordinates already live on the
    # ais layer these attach to. Nothing here for the backend to mirror.
    Job(
        module="backend.refine.vessel_profile",
        entrypoint="derive_forever",
        publishes=(),
        # vessel_profile.HEALTH_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="vessel_profiles",
        health_every=config.VESSEL_PROFILE_INTERVAL,
    ),
    # Writes lane_cells rows -- a grid, not a point per ship -- so there is
    # nothing here for the backend to mirror either; GET /api/lanes
    # (backend/app.py) reads storage.lane_cells directly, the same shape as
    # the vessel_port_calls reads above.
    Job(
        module="backend.refine.lane_density",
        entrypoint="derive_forever",
        publishes=(),
        # lane_density.HEALTH_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="lane_density",
        health_every=config.LANE_DENSITY_INTERVAL,
    ),
    # Writes flight_legs rows -- the aviation twin of port_calls, keyed by
    # icao24 rather than mmsi. Publishes nothing either: the coordinates a
    # leg's origin/destination carry already exist on the airports layer, and
    # GET /api/aircraft/{icao24} (backend/app.py) reads flight_legs_for /
    # open_flight_leg directly, the same shape vessel_port_calls' reads take.
    Job(
        module="backend.refine.flight_legs",
        entrypoint="derive_forever",
        publishes=(),
        # flight_legs.HEALTH_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="flight_legs",
        health_every=config.FLIGHT_LEG_INTERVAL,
    ),
    # Navy-classified AIS presence per theatre and per port, with a 7-day
    # trend (Task 29). Publishes no layer of its own -- a theatre/port count
    # attaches to coordinates the regions table and the curated ports list
    # already carry -- so it writes one keyed reference document and
    # GET /api/naval-presence (backend/app.py) reads it directly.
    Job(
        module="backend.refine.naval_presence",
        entrypoint="derive_forever",
        publishes=(),
        # naval_presence.REFERENCE_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="naval_presence",
        health_every=config.NAVAL_PRESENCE_INTERVAL,
    ),
    # Task 37: which dams, power plants, cable landings, airfields and ports
    # have the most conflict events inside their own uncertainty radius, over
    # a 30-day window. Reads conflict_events plus the entity_latest rows the
    # backend and ingest processes already wrote for the five Nearby
    # categories (see the module's own docstring for why it reads Postgres
    # rather than any in-process registry) and writes one keyed reference
    # document; GET /api/infra-risk (backend/app.py) reads it directly, the
    # same shape naval_presence's own document is served.
    Job(
        module="backend.refine.infra_risk",
        entrypoint="derive_forever",
        publishes=(),
        # infra_risk.REFERENCE_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="infra_risk",
        health_every=config.INFRA_RISK_INTERVAL,
    ),
    # Task 38: does a country's IODA outage score spike at the same time as a
    # conflict event lands near one of its submarine-cable landings. Publishes
    # no layer of its own -- landings and events both already have coordinates
    # on their own layers -- so it writes one keyed reference document and
    # GET /api/cable-outage-risk (backend/app.py) reads it directly.
    Job(
        module="backend.refine.cable_outage",
        entrypoint="derive_forever",
        publishes=(),
        # cable_outage.REFERENCE_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="cable_outage",
        health_every=config.CABLE_OUTAGE_INTERVAL,
    ),
    # Task 39: aircraft whose own reported track does something physically
    # implausible while sitting inside one of gpsjam.org's currently
    # worst-affected cells -- corroboration for the jamming layer, which
    # otherwise stands alone. Publishes no layer of its own -- the cells
    # already exist on the jamming layer and the aircraft already exist on
    # the adsb one -- so it writes one keyed reference document and
    # GET /api/jam-crosscheck (backend/app.py) reads it directly, the same
    # shape naval_presence's/infra_risk's/cable_outage's own documents are
    # served; GET /api/aircraft/{icao24} reads the same document's own
    # `aircraft` slice.
    Job(
        module="backend.refine.jam_crosscheck",
        entrypoint="derive_forever",
        publishes=(),
        # jam_crosscheck.HEALTH_NAME, copied for the same reason
        # port_calls.HEALTH_NAME is copied above.
        health_name="jam_crosscheck",
        health_every=config.JAM_CROSSCHECK_INTERVAL,
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
