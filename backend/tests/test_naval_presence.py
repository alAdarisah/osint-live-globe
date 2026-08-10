"""backend/refine/naval_presence.py's build_document: the trend/coverage
arithmetic, exercised on plain rows rather than a database -- the same reason
osm_infra.py's parse functions take a plain payload dict.
"""

from datetime import datetime, timedelta, timezone

import pytest

from backend import regions as regions_mod
from backend.refine import naval_presence


NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)
LATEST_DAY = NOW.date()
OLDEST_DAY = (NOW - timedelta(days=naval_presence.WINDOW_DAYS)).date()

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


def latest():
    return datetime.combine(LATEST_DAY, datetime.min.time(), tzinfo=timezone.utc)


def oldest():
    return datetime.combine(OLDEST_DAY, datetime.min.time(), tzinfo=timezone.utc)


def navy_row(day, entity_id, lat=26.2, lon=50.6):
    return {"day": day, "entity_id": entity_id, "lat": lat, "lon": lon}


def coverage(day, reports):
    # date_trunc('day', ts) on a timestamptz column comes back from asyncpg as
    # a datetime, not a bare date -- same shape navy_row's own "day" carries.
    return {"day": day, "reports": reports}


FULL_COVERAGE = [
    coverage(latest(), naval_presence.MIN_DAILY_AIS_REPORTS),
    coverage(oldest(), naval_presence.MIN_DAILY_AIS_REPORTS),
]


# --- region counts and trend -------------------------------------------------


def test_current_and_week_ago_counts_per_region():
    rows = [
        navy_row(latest(), "111111111"), navy_row(latest(), "222222222"),
        navy_row(oldest(), "333333333"),
    ]
    doc = naval_presence.build_document(rows, FULL_COVERAGE, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 2
    assert zone["week_ago"] == 1
    assert zone["trend"] == 1
    assert zone["trend_computable"] is True
    assert zone["reason"] is None


def test_a_region_with_no_navy_activity_still_appears_at_zero():
    """"Nothing here" and "not computed" are different answers -- a theatre
    stays in the document at 0/0 rather than being omitted."""
    doc = naval_presence.build_document([], FULL_COVERAGE, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 0
    assert zone["week_ago"] == 0
    assert zone["trend"] == 0


def test_a_position_outside_the_regions_bounds_is_not_counted():
    rows = [navy_row(latest(), "999999999", lat=0.0, lon=0.0)]  # nowhere near HORMUZ_BOUNDS
    doc = naval_presence.build_document(rows, FULL_COVERAGE, NOW)
    assert doc["regions"]["test_theatre"]["current"] == 0


def test_the_same_hull_seen_twice_in_a_day_counts_once():
    rows = [navy_row(latest(), "111111111"), navy_row(latest(), "111111111", lat=26.3, lon=50.7)]
    doc = naval_presence.build_document(rows, FULL_COVERAGE, NOW)
    assert doc["regions"]["test_theatre"]["current"] == 1


# --- coverage-change computability -------------------------------------------


def test_trend_is_not_computable_when_the_current_days_coverage_is_thin():
    thin_coverage = [
        coverage(latest(), naval_presence.MIN_DAILY_AIS_REPORTS - 1),
        coverage(oldest(), naval_presence.MIN_DAILY_AIS_REPORTS),
    ]
    doc = naval_presence.build_document([navy_row(latest(), "111111111")], thin_coverage, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["trend_computable"] is False
    assert zone["trend"] is None
    assert zone["reason"] and "coverage" in zone["reason"]


def test_trend_is_not_computable_when_the_week_ago_days_coverage_is_thin():
    thin_coverage = [
        coverage(latest(), naval_presence.MIN_DAILY_AIS_REPORTS),
        coverage(oldest(), naval_presence.MIN_DAILY_AIS_REPORTS - 1),
    ]
    doc = naval_presence.build_document([], thin_coverage, NOW)
    assert doc["regions"]["test_theatre"]["trend_computable"] is False


def test_trend_is_not_computable_with_no_coverage_rows_at_all():
    """A cold database, or a window shorter than WINDOW_DAYS -- either way,
    "cannot compare" rather than a division silently reading zero rows as
    zero coverage change."""
    doc = naval_presence.build_document([], [], NOW)
    assert doc["regions"]["test_theatre"]["trend_computable"] is False


def test_a_thin_coverage_day_still_reports_the_real_counts_alongside_null_trend():
    """The current/week_ago figures themselves are still measured and shown --
    only the *trend* (their difference) is withheld."""
    thin_coverage = [coverage(latest(), 1), coverage(oldest(), naval_presence.MIN_DAILY_AIS_REPORTS)]
    doc = naval_presence.build_document([navy_row(latest(), "111111111")], thin_coverage, NOW)
    zone = doc["regions"]["test_theatre"]
    assert zone["current"] == 1
    assert zone["trend"] is None


# --- ports --------------------------------------------------------------------


def test_a_navy_hull_near_a_port_is_matched_to_it():
    rows = [navy_row(latest(), "111111111", lat=26.21, lon=50.61)]  # ~1.5km from test_port
    doc = naval_presence.build_document(rows, FULL_COVERAGE, NOW)
    assert doc["ports"]["test_port"]["current"] == 1
    assert doc["ports"]["test_port"]["name"] == "Test Port"


def test_a_position_beyond_the_match_radius_is_not_matched_to_any_port():
    far = navy_row(latest(), "111111111", lat=26.2 + 1.0, lon=50.6)  # ~111km north
    doc = naval_presence.build_document([far], FULL_COVERAGE, NOW)
    assert doc["ports"] == {}


def test_a_port_with_no_navy_traffic_on_either_edge_day_is_omitted():
    """Most of the curated port list never sees a warship -- the document
    only carries a port that was actually matched, the same "carried only
    where there is something to carry" rule airfield_activity's own
    hourly_military applies."""
    doc = naval_presence.build_document([], FULL_COVERAGE, NOW)
    assert doc["ports"] == {}


def test_a_curated_site_that_is_not_a_port_is_never_matched():
    """not_a_port sits at the identical coordinates as test_port -- proving
    the type=="port" filter, not just distance, decides what can match."""
    rows = [navy_row(latest(), "111111111", lat=26.2, lon=50.6)]
    doc = naval_presence.build_document(rows, FULL_COVERAGE, NOW)
    assert set(doc["ports"]) == {"test_port"}


# --- document shape -----------------------------------------------------------


def test_the_document_carries_its_own_window_and_timestamp():
    doc = naval_presence.build_document([], FULL_COVERAGE, NOW)
    assert doc["window_days"] == naval_presence.WINDOW_DAYS
    assert isinstance(doc["as_of"], float)


def test_an_empty_input_is_not_an_error():
    doc = naval_presence.build_document([], [], NOW)
    assert doc["ports"] == {}
    assert set(doc["regions"]) == {"test_theatre"}


def test_each_region_carries_its_own_bounds():
    """So the frontend can match a country card to the theatre it sits
    inside, the same bounds-containment test it already runs against
    escalation.py's own document."""
    doc = naval_presence.build_document([], FULL_COVERAGE, NOW)
    assert doc["regions"]["test_theatre"]["bounds"] == list(HORMUZ_BOUNDS)
