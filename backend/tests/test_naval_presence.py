"""backend/refine/naval_presence.py's build_document: the trend/coverage
arithmetic, exercised on plain rows rather than a database -- the same reason
osm_infra.py's parse functions take a plain payload dict.
"""

from datetime import datetime, timedelta, timezone

import pytest

from backend import regions as regions_mod
from backend.refine import naval_presence


NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)

HORMUZ_BOUNDS = (23.0, 47.0, 31.0, 58.0)


@pytest.fixture(autouse=True)
def small_region_table(monkeypatch):
    """A one-region table, independent of whatever conflict theatres
    backend/regions.py happens to carry -- so this test never has to change
    when a theatre is added or renamed."""
    monkeypatch.setattr(regions_mod, "REGIONS", {
        "world": {"label": "World", "group": "world", "bounds": None},
        "test_theatre": {"label": "Test Theatre", "group": "conflict", "bounds": HORMUZ_BOUNDS},
    })


@pytest.fixture(autouse=True)
def small_port_table(monkeypatch):
    """A two-port table, same reasoning: independent of the real curated
    list, which is free to gain or lose entries without breaking this test."""
    from backend import infrastructure
    monkeypatch.setattr(infrastructure, "INFRA_SITES", [
        {"id": "test_port", "name": "Test Port", "type": "port", "lat": 26.2, "lon": 50.6},
        {"id": "not_a_port", "name": "Not A Port", "type": "refinery", "lat": 26.2, "lon": 50.6},
    ])


# A timestamp inside the "current" 24h window (ending at NOW) and one inside
# the "baseline" 24h window (ending WINDOW_DAYS before NOW) -- the two
# windows build_document actually compares, replacing the old calendar-day
# buckets a Task 29 review finding (Important 3) rejected: "right now" has to
# mean the same trailing-24h thing regardless of what hour a pass runs at.
def in_current_window():
    return NOW - timedelta(hours=1)


def in_baseline_window():
    return NOW - timedelta(days=naval_presence.WINDOW_DAYS, hours=1)


def navy_row(ts, entity_id, lat=26.2, lon=50.6):
    return {"ts": ts, "entity_id": entity_id, "lat": lat, "lon": lon}


def full_coverage():
    return {
        "current_reports": naval_presence.MIN_WINDOW_AIS_REPORTS,
        "baseline_reports": naval_presence.MIN_WINDOW_AIS_REPORTS,
    }


# --- region counts and trend -------------------------------------------------


def test_current_and_week_ago_counts_per_region():
    rows = [
        navy_row(in_current_window(), "111111111"), navy_row(in_current_window(), "222222222"),
        navy_row(in_baseline_window(), "333333333"),
    ]
    doc = naval_presence.build_document(rows, full_coverage(), NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 2
    assert zone["week_ago"] == 1
    assert zone["trend"] == 1
    assert zone["trend_computable"] is True
    assert zone["reason"] is None


def test_a_region_with_no_navy_activity_still_appears_at_zero():
    """"Nothing here" and "not computed" are different answers -- a theatre
    stays in the document at 0/0 rather than being omitted."""
    doc = naval_presence.build_document([], full_coverage(), NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 0
    assert zone["week_ago"] == 0
    assert zone["trend"] == 0


def test_a_position_outside_the_regions_bounds_is_not_counted():
    rows = [navy_row(in_current_window(), "999999999", lat=0.0, lon=0.0)]  # nowhere near HORMUZ_BOUNDS
    doc = naval_presence.build_document(rows, full_coverage(), NOW)
    assert doc["regions"]["test_theatre"]["current"] == 0


def test_the_same_hull_seen_twice_in_the_window_counts_once():
    rows = [
        navy_row(in_current_window(), "111111111"),
        navy_row(in_current_window(), "111111111", lat=26.3, lon=50.7),
    ]
    doc = naval_presence.build_document(rows, full_coverage(), NOW)
    assert doc["regions"]["test_theatre"]["current"] == 1


def test_a_position_just_outside_the_current_window_does_not_count_as_current():
    """The rolling-window fix itself, pinned: a fix from 25 hours ago is
    outside the trailing 24h "current" window and must not be counted as
    happening right now, the exact miscount date_trunc('day', ts) allowed."""
    just_before = NOW - timedelta(hours=25)
    doc = naval_presence.build_document([navy_row(just_before, "111111111")], full_coverage(), NOW)
    assert doc["regions"]["test_theatre"]["current"] == 0


def test_a_position_from_earlier_today_still_counts_as_current():
    """The old calendar-day version undercounted "right now" whenever a pass
    ran early in the UTC day -- a fix from three hours ago, safely inside the
    trailing 24h window, must count regardless of what the calendar date
    happens to be."""
    three_hours_ago = NOW - timedelta(hours=3)
    doc = naval_presence.build_document([navy_row(three_hours_ago, "111111111")], full_coverage(), NOW)
    assert doc["regions"]["test_theatre"]["current"] == 1


# --- coverage-change computability -------------------------------------------


def test_trend_is_not_computable_when_the_current_windows_coverage_is_thin():
    thin = {"current_reports": naval_presence.MIN_WINDOW_AIS_REPORTS - 1,
            "baseline_reports": naval_presence.MIN_WINDOW_AIS_REPORTS}
    doc = naval_presence.build_document([navy_row(in_current_window(), "111111111")], thin, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["trend_computable"] is False
    assert zone["trend"] is None
    assert zone["reason"] and "coverage" in zone["reason"]


def test_trend_is_not_computable_when_the_baseline_windows_coverage_is_thin():
    thin = {"current_reports": naval_presence.MIN_WINDOW_AIS_REPORTS,
            "baseline_reports": naval_presence.MIN_WINDOW_AIS_REPORTS - 1}
    doc = naval_presence.build_document([], thin, NOW)
    assert doc["regions"]["test_theatre"]["trend_computable"] is False


def test_trend_is_not_computable_with_no_coverage_data_at_all():
    """A cold database, or a window shorter than WINDOW_DAYS -- either way,
    "cannot compare" rather than a division silently reading a missing key as
    zero coverage."""
    doc = naval_presence.build_document([], {}, NOW)
    assert doc["regions"]["test_theatre"]["trend_computable"] is False


def test_a_thin_coverage_window_still_reports_the_real_counts_alongside_null_trend():
    """The current/week_ago figures themselves are still measured and shown --
    only the *trend* (their difference) is withheld."""
    thin = {"current_reports": 1, "baseline_reports": naval_presence.MIN_WINDOW_AIS_REPORTS}
    doc = naval_presence.build_document([navy_row(in_current_window(), "111111111")], thin, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 1
    assert zone["trend"] is None


# --- ports --------------------------------------------------------------------


def test_a_navy_hull_near_a_port_is_matched_to_it():
    rows = [navy_row(in_current_window(), "111111111", lat=26.21, lon=50.61)]  # ~1.5km from test_port
    doc = naval_presence.build_document(rows, full_coverage(), NOW)
    assert doc["ports"]["test_port"]["current"] == 1
    assert doc["ports"]["test_port"]["name"] == "Test Port"


def test_a_position_beyond_the_match_radius_is_not_matched_to_any_port():
    far = navy_row(in_current_window(), "111111111", lat=26.2 + 1.0, lon=50.6)  # ~111km north
    doc = naval_presence.build_document([far], full_coverage(), NOW)
    assert doc["ports"] == {}


def test_a_port_with_no_navy_traffic_in_either_window_is_omitted():
    """Most of the curated port list never sees a warship -- the document
    only carries a port that was actually matched, the same "carried only
    where there is something to carry" rule airfield_activity's own
    hourly_military applies."""
    doc = naval_presence.build_document([], full_coverage(), NOW)
    assert doc["ports"] == {}


def test_a_curated_site_that_is_not_a_port_is_never_matched():
    """not_a_port sits at the identical coordinates as test_port -- proving
    the type=="port" filter, not just distance, decides what can match."""
    rows = [navy_row(in_current_window(), "111111111", lat=26.2, lon=50.6)]
    doc = naval_presence.build_document(rows, full_coverage(), NOW)
    assert set(doc["ports"]) == {"test_port"}


# --- document shape -----------------------------------------------------------


def test_the_document_carries_its_own_window_and_timestamp():
    doc = naval_presence.build_document([], full_coverage(), NOW)
    assert doc["window_days"] == naval_presence.WINDOW_DAYS
    assert doc["current_window_hours"] == naval_presence.CURRENT_WINDOW_HOURS
    assert isinstance(doc["as_of"], float)


def test_an_empty_input_is_not_an_error():
    doc = naval_presence.build_document([], {}, NOW)
    assert doc["ports"] == {}
    assert set(doc["regions"]) == {"test_theatre"}


def test_each_region_carries_its_own_bounds():
    """So the frontend can match a country card to the theatre it sits
    inside, the same bounds-containment test it already runs against
    escalation.py's own document."""
    doc = naval_presence.build_document([], full_coverage(), NOW)
    assert doc["regions"]["test_theatre"]["bounds"] == list(HORMUZ_BOUNDS)


def test_the_baseline_window_stays_inside_what_history_retention_actually_keeps():
    """The regression that made this job's trend dead on arrival.

    The baseline used to end WINDOW_DAYS=7 before now, so its far edge sat at
    (7 days + 24h) back while entity_history is pruned at
    config.HISTORY_RETENTION_SECONDS (3 days). Every query for it came back
    empty, trend_computable was False on every pass forever, and the job still
    paid two range scans to produce nothing -- a whole feature quietly dead,
    with the document honest about it and nobody looking.

    The rest of this file is parameterised on naval_presence.WINDOW_DAYS, so a
    regression to 7 would leave every other test green. This is the one that
    pins the constant against the retention it has to fit inside, rather than
    against itself.
    """
    from backend import config

    retention_hours = config.HISTORY_RETENTION_SECONDS / 3600.0
    # The oldest instant the baseline query reaches back to.
    oldest_needed_hours = naval_presence.WINDOW_DAYS * 24 + naval_presence.CURRENT_WINDOW_HOURS

    assert oldest_needed_hours < retention_hours, (
        f"the baseline reaches {oldest_needed_hours}h back but entity_history only keeps "
        f"{retention_hours}h -- baseline_rows would be empty on every pass and the trend "
        f"could never be computed"
    )
    # Not merely inside it: far enough inside that a late-running pass, or a
    # prune that fires early, does not silently start returning nothing.
    assert retention_hours - oldest_needed_hours >= naval_presence.CURRENT_WINDOW_HOURS, (
        "the baseline fits inside retention but with less than one full window of margin; "
        "a delayed pass could start reading a partially pruned baseline without any signal"
    )
