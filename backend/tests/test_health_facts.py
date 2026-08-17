"""The two facts /api/health could not work out for itself: how often a source
actually reports, and how many items it recorded.

Both fed one user-visible failure. The frontend judged all 57 sources against a
single flat 1800-second staleness threshold, because that was the only yardstick it
had, and only 24 of them poll that fast -- so the HUD read "Sources 26/57" on a
deployment where essentially one source was broken, and the admin drawer described a
weekly reference set as "failing" three hours after a successful fetch.

The fix is not to declare each source's interval at forty-six registration sites
(see storage.observed_cadence on why that is forty-six chances to state a cadence a
source does not keep) but to measure it from the health table the sources already
write, and to read back the item count they already record.
"""

import time

from backend.cache import SourceRegistry, SourceState
from backend.mirror import credential_missing


def test_to_health_publishes_the_measured_cadence():
    state = SourceState(name="railways", key_configured=True)
    assert state.to_health()["expected_every"] is None, "nothing measured yet says nothing"

    state.expected_every = 7 * 24 * 3600.0
    assert state.to_health()["expected_every"] == 7 * 24 * 3600.0


def test_the_recorded_count_beats_the_shape_guess():
    """_item_count() inspects whatever `data` happens to be, and for a source that
    publishes a *document* it counts the wrong thing entirely.

    gazetteer.py stores [{"places": 272803}] and got 1. water_bodies.py stores
    {"marine": n, "lakes": n, "rivers": n} and got 3 -- its key count. railways.py
    and power_lines.py store a four-key serialisation and got 4. Every one of those
    modules already computes the real number and passes it to record_source_health,
    so the true figure was sitting in the database while /api/health published the
    artefact, and five fully healthy layers read as nearly empty.
    """
    gazetteer = SourceState(name="gazetteer", key_configured=True)
    gazetteer.data = [{"places": 272803}]
    assert gazetteer.to_health()["item_count"] == 1, "the shape guess, for comparison"

    gazetteer.recorded_item_count = 272803
    assert gazetteer.to_health()["item_count"] == 272803

    water = SourceState(name="water_bodies", key_configured=True)
    water.data = {"marine": 303, "lakes": 1500, "rivers": 1306}
    assert water.to_health()["item_count"] == 3, "counted its keys"
    water.recorded_item_count = 3109
    assert water.to_health()["item_count"] == 3109


def test_a_recorded_zero_is_a_real_zero():
    """`or`-style fallbacks would treat a recorded 0 as "nothing recorded" and fall
    back to the guess. A source that genuinely has no items right now -- alert_rules
    when no rule is firing, acled while its account's embargo covers the window --
    must be able to say 0 and be believed."""
    state = SourceState(name="alert_rules", key_configured=True)
    state.data = [1, 2, 3]
    state.recorded_item_count = 0
    assert state.to_health()["item_count"] == 0


def test_a_source_that_has_published_but_not_recorded_still_counts():
    """The fallback direction. A source whose first health row has not landed yet
    has published data this process, and reporting 0 for it would be the same
    confident-zero-over-a-live-feed failure in the other direction."""
    state = SourceState(name="hazards", key_configured=True)
    state.data = [{"id": 1}, {"id": 2}]
    assert state.recorded_item_count is None
    assert state.to_health()["item_count"] == 2


def test_registry_all_exposes_the_live_states():
    """The periodic pass mutates these in place, so it needs the real objects and a
    mapping it can iterate while a source registers mid-loop."""
    registry = SourceRegistry()
    first = registry.register("gdelt", key_configured=True)
    snapshot = registry.all()
    registry.register("acled", key_configured=True)

    assert "acled" not in snapshot, "the mapping is a copy"
    assert snapshot["gdelt"] is first, "the states are not"

    snapshot["gdelt"].expected_every = 900
    assert registry.get("gdelt").to_health()["expected_every"] == 900


def test_credential_missing_recognises_the_collectors_own_wording():
    """key_configured does not cross the process boundary: the credentials all
    belong to the ingest process, which sets the flag on its own registry, while the
    backend keeps a separate state per mirrored source and hardcoded True. So the
    frontend's amber "not configured on this deployment" state was unreachable for
    every mirrored source and marinesia rendered red -- the same colour as a
    collector that had actually failed.

    The error text is the one signal that does cross, via source_health.error.
    """
    for message in (
        "the ingest service: MARINESIA_API_KEY not set in .env",
        "the ingest service: AISSTREAM_API_KEY not set in .env",
        "the ingest service: GFW_API_TOKEN not set in .env",
        "ACLED_EMAIL / ACLED_PASSWORD not set -- showing UCDP only",
    ):
        assert credential_missing(message), message


def test_credential_missing_does_not_claim_a_real_outage_is_a_config_choice():
    """The direction that matters. Painting a broken collector amber would tell an
    operator there is nothing to fix."""
    for message in (
        None,
        "",
        "the ingest service: no AIS frames received since this process started",
        "the ingest service: aisstream closed the connection before sending anything",
        "1 of 76 requests failed: cbpf/ie: Server error '500 Internal Server Error'",
        "the refine service last ran 9000s ago, expected every 900s -- this layer is frozen",
    ):
        assert not credential_missing(message), repr(message)


def test_seconds_since_success_still_tracks_real_time():
    """Guards the arithmetic the whole staleness question rests on."""
    state = SourceState(name="gdelt", key_configured=True)
    state.last_success = time.time() - 42
    assert 40 <= state.to_health()["seconds_since_success"] <= 45
