"""What the refine process derives, and what it must never do.

The defining property of this tier is negative: nothing in it fetches. That is
what makes the refine container safe to restart, starve or kill, and it is not
enforced by anything except the contents of the job table -- so it is enforced
here.
"""

import asyncio

import pytest

from backend import config, escalation, refine, storage


def _run(coro):
    return asyncio.run(coro)


def _job(module_suffix):
    return next(job for job in refine.all_jobs() if job.module.endswith(module_suffix))


def test_the_refine_tier_is_exactly_the_declared_derivations():
    """Named for the property rather than the count, which used to be in the
    name and rotted the moment a fourth derivation was added. The allowlist is
    still explicit: a job appearing here is the one place the tier's defining
    property -- that nothing in it fetches -- is decided rather than assumed."""
    assert {job.module for job in refine.all_jobs()} == {
        "backend.sources.event_fusion",
        "backend.sources.dark_vessels",
        "backend.escalation",
        # Re-derives per-airfield movement counts from the ADS-B history the
        # ingest process already stored. Publishes no layer of its own -- the
        # coordinates are on the airports layer -- so it writes one keyed
        # document and app.py reads that table directly.
        "backend.sources.airfield_activity",
        # Finds vessel dwells near a port in the AIS movement log. Publishes
        # no layer either -- it writes vessel_port_calls rows, read per
        # vessel or per port rather than served whole.
        "backend.refine.port_calls",
        # Cargo class and laden/ballast state per hull. Publishes no layer
        # either -- one reference_snapshots document keyed by MMSI, attached
        # to the ais layer's own coordinates rather than carrying its own.
        "backend.refine.vessel_profile",
        # AIS traffic grid. Publishes no layer either -- it writes lane_cells
        # rows, a grid rather than a point per ship, and GET /api/lanes reads
        # that table directly.
        "backend.refine.lane_density",
        # Departure/arrival legs derived from the ADS-B movement log, the
        # aviation twin of port_calls. Publishes no layer either -- it writes
        # flight_legs rows, read per airframe by GET /api/aircraft/{icao24}.
        "backend.refine.flight_legs",
        # Navy-classified AIS presence per theatre and per port, with a 7-day
        # trend. Publishes no layer either -- one reference_snapshots
        # document, read directly by GET /api/naval-presence.
        "backend.refine.naval_presence",
        # Which dams, power plants, cable landings, airfields and ports have
        # the most conflict events inside their own uncertainty radius, over
        # a 30-day window. Publishes no layer either -- one reference_
        # snapshots document, read directly by GET /api/infra-risk.
        "backend.refine.infra_risk",
        # Whether a country's IODA outage score spikes at the same time as a
        # conflict event lands near one of its submarine-cable landings.
        # Publishes no layer either -- one reference_snapshots document, read
        # directly by GET /api/cable-outage-risk.
        "backend.refine.cable_outage",
    }


def test_no_refine_job_makes_an_outbound_call():
    """The property the whole tier rests on.

    A refiner that reached upstream would put a second consumer on a metered
    quota without anything in the ingest table saying so -- the exact failure
    the split removed, reintroduced one import at a time.
    """
    import ast
    import importlib
    import pathlib

    for job in refine.all_jobs():
        module = importlib.import_module(job.module)
        tree = ast.parse(pathlib.Path(module.__file__).read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module.split(".")[0])
        assert not imported & {"httpx", "websockets", "urllib", "requests", "aiohttp"}, (
            f"{job.module} imports an HTTP client. Refiners read Postgres and "
            f"write Postgres; anything that fetches belongs in backend/ingest."
        )


def test_escalation_publishes_no_point_layer():
    """It writes one ranked document, which has no per-row lat/lon to mirror."""
    assert _job("escalation").publishes == ()
    assert _job("escalation").health_name == escalation.REFERENCE_NAME


def test_derived_layers_are_published_for_the_backend_to_mirror():
    assert {pub.kind for pub in refine.published()} == {"events", "dark_vessels"}


def test_every_published_kind_has_a_retention_window():
    for pub in refine.published():
        assert pub.kind in config.ENTITY_STALE_AFTER, (
            f"{pub.kind} would be evicted on the "
            f"{config.ENTITY_STALE_AFTER_DEFAULT}s default"
        )


def test_escalation_recomputes_no_faster_than_its_only_input_changes():
    """Its inputs move only when event_fusion writes; running faster re-derives
    the same answer from the same rows."""
    assert config.ESCALATION_REFRESH_INTERVAL >= config.GDELT_POLL_INTERVAL


def test_fusion_inputs_are_mirrored_rather_than_polled():
    """Fusion reads four registry states. In this process nothing fills them
    except the mirror, and a missing one degrades silently to "no opinion" --
    an unfused layer or evidence that never attaches, with no error anywhere."""
    assert {spec.kind for spec in refine.INPUTS} == {
        "acled", "firms", "gdelt_conflict", "jamming",
    }


def test_every_entrypoint_exists_on_its_module():
    import importlib

    for job in refine.all_jobs():
        module = importlib.import_module(job.module)
        assert hasattr(module, job.entrypoint), (
            f"backend/refine names {job.module}.{job.entrypoint}, which does not exist"
        )


def test_refined_modules_no_longer_expose_a_backend_poll_loop():
    """`start()` is what app.py schedules; leaving one behind would let the
    backend run fusion in the request loop again."""
    import importlib

    for job in refine.all_jobs():
        module = importlib.import_module(job.module)
        assert not hasattr(module, "start"), (
            f"{job.module} still has start(); it is refined now, not polled"
        )


class _Recorder:
    def __init__(self):
        self.rows = []

    async def record(self, source, item_count, ok, error=None):
        self.rows.append((source, item_count, ok, error))


def test_run_job_records_a_job_that_falls_over(monkeypatch):
    """These jobs are their own loops, so reaching this means the loop died --
    and a dead loop with no health row keeps the last result green forever."""
    recorder = _Recorder()
    monkeypatch.setattr(storage, "record_source_health", recorder.record)

    async def boom():
        raise RuntimeError("pool exhausted")

    module = type("M", (), {"fuse_forever": staticmethod(boom)})
    monkeypatch.setattr(refine.importlib, "import_module", lambda name: module)

    _run(refine.run_job(_job("event_fusion")))
    assert recorder.rows == [("events", None, False, "pool exhausted")]
