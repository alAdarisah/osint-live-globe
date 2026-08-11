"""/api/water: seas, lakes and river centrelines read back from Postgres.

sources/water_bodies.py stores three reference_snapshots rows (water_marine,
water_lakes, water_rivers) and deliberately does not warm them into registry
state (see its NOT_WARMED entry in test_persistence_coverage.py) -- so, like
/api/district-boundaries and /api/admin1-boundaries, this endpoint reads
storage.reference() per request behind its own small cache rather than going
through _cached_source_response, which needs a registry SourceState to key an
ETag off. These tests follow test_admin1_endpoint.py's style: call the
endpoint function directly, monkeypatch storage.reference to a fake in-memory
map, and monkeypatch the module-level cache so tests don't bleed into each
other.

Every kind carries a stored bbox now (water_bodies._build_collection adds one
to marine, lakes and rivers alike -- only area_deg2, which ranks nested
polygons on a click, stays marine-only). That is the fix for a review finding
on the first pass of this endpoint: giving bbox to marine only meant lakes
and rivers filtered through regions.filter_geojson's geometry-derived bbox
instead, which walks every coordinate, and did so on *every* request because
storage.reference() never returns the same object twice (a fresh Postgres
read plus json.loads each call), so filter_geojson's identity-keyed memo
never fired for water traffic at all. The fixtures below give lakes and
rivers a stored bbox that can *disagree* with their geometry specifically so
a test can prove the endpoint reads the stored value rather than silently
falling back to a walk.
"""

import asyncio
import json

import pytest
from fastapi import HTTPException

from backend import app as app_mod
from backend.ratelimit import LruTtlCache


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    return json.loads(response.body)


def _feature(fid, bbox, geometry=None):
    return {
        "type": "Feature",
        "properties": {"id": fid, "name": fid, "bbox": bbox, "antimeridian": False},
        "geometry": geometry or {"type": "Point", "coordinates": [0.0, 0.0]},
    }


# Two marine features. One is a plain, unwrapped bbox. The other stands in for
# a real antimeridian-spanning sea (Bering Sea, Chukchi Sea, Ross Sea, Gulf of
# Anadyr', North/South Pacific -- the six water_bodies.py actually flags):
# west=170 > east=-170 means two longitude ranges, 170..180 and -180..-170,
# not an inverted box. See water_bodies._bbox's docstring, which explains why
# this endpoint must not reject that as malformed.
MARINE = {
    "type": "FeatureCollection",
    "features": [
        _feature("marine:1", [10.0, 20.0, 15.0, 25.0]),
        _feature("marine:2", [50.0, 170.0, 65.0, -170.0]),
    ],
}

# Each feature's stored bbox deliberately does NOT match where its geometry
# actually sits (geometry is a Point off at [99, 99], nowhere near either
# feature's real box) -- see test_bbox_filtering_reads_the_stored_box_not_the_
# geometry below, which only passes if the endpoint reads properties["bbox"]
# and never looks at the geometry at all.
LAKES = {
    "type": "FeatureCollection",
    "features": [
        _feature("lake:1", [0.0, 0.0, 2.0, 2.0], geometry={"type": "Point", "coordinates": [99.0, 99.0]}),
        _feature("lake:2", [40.0, 40.0, 42.0, 42.0], geometry={"type": "Point", "coordinates": [99.0, 99.0]}),
    ],
}

RIVERS = {
    "type": "FeatureCollection",
    "features": [
        _feature("river:1", [0.0, 0.0, 2.0, 2.0], geometry={"type": "Point", "coordinates": [99.0, 99.0]}),
        _feature("river:2", [40.0, 40.0, 42.0, 42.0], geometry={"type": "Point", "coordinates": [99.0, 99.0]}),
    ],
}


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    """A cache of its own per test -- the endpoint's is module-level and would
    otherwise carry one test's answers into the next."""
    monkeypatch.setattr(app_mod, "_WATER_CACHE", LruTtlCache(maxsize=64, ttl=3600))


@pytest.fixture
def stored(monkeypatch):
    """storage.reference, keyed by snapshot name, counting the reads."""
    answers = {"water_marine": MARINE, "water_lakes": LAKES, "water_rivers": RIVERS}
    reads = []

    async def reference(name):
        reads.append(name)
        return answers.get(name)

    monkeypatch.setattr(app_mod.storage, "reference", reference)
    return answers, reads


def _ids(body):
    return sorted(f["properties"]["id"] for f in body["features"])


# --- kind validation and the rivers gate -------------------------------------

def test_unknown_kind_is_400_naming_the_three_valid_values(stored):
    with pytest.raises(HTTPException) as raised:
        _run(app_mod.water_endpoint(kind="glaciers"))
    assert raised.value.status_code == 400
    assert "marine" in raised.value.detail
    assert "lakes" in raised.value.detail
    assert "rivers" in raised.value.detail


def test_rivers_without_bbox_is_400_naming_the_parameter(stored):
    # Task 4 measured the unfiltered rivers document at ~5 MB and recommended
    # gating it behind a required bbox, the same way /api/district-boundaries
    # requires a country rather than serving all 251 at once. This is that
    # gate.
    with pytest.raises(HTTPException) as raised:
        _run(app_mod.water_endpoint(kind="rivers"))
    assert raised.value.status_code == 400
    assert "bbox" in raised.value.detail
    assert "rivers" in raised.value.detail


def test_rivers_with_a_malformed_bbox_still_400s(stored):
    # regions.parse_bbox degrades a malformed box to None (the same as
    # absent) rather than raising -- for every other bbox-taking endpoint
    # that means "serve unfiltered", which is exactly what the rivers gate
    # exists to prevent. A malformed box must not be a backdoor around it, so
    # this checks the same detail content as the sibling test above, not just
    # the status code.
    with pytest.raises(HTTPException) as raised:
        _run(app_mod.water_endpoint(kind="rivers", bbox="not,a,real,bbox"))
    assert raised.value.status_code == 400
    assert "bbox" in raised.value.detail
    assert "rivers" in raised.value.detail


def test_marine_and_lakes_are_served_whole_without_a_bbox(stored):
    marine = _body(_run(app_mod.water_endpoint(kind="marine")))
    assert _ids(marine) == ["marine:1", "marine:2"]
    lakes = _body(_run(app_mod.water_endpoint(kind="lakes")))
    assert _ids(lakes) == ["lake:1", "lake:2"]


def test_kind_defaults_to_marine(stored):
    default = _body(_run(app_mod.water_endpoint()))
    marine = _body(_run(app_mod.water_endpoint(kind="marine")))
    assert default == marine


# --- bbox filtering -----------------------------------------------------------

def test_marine_bbox_keeps_only_overlapping_features(stored):
    body = _body(_run(app_mod.water_endpoint(kind="marine", bbox="12,22,14,24")))
    assert _ids(body) == ["marine:1"]


def test_lakes_bbox_keeps_only_overlapping_features(stored):
    # Every LAKES fixture feature's geometry sits at [99, 99] -- nowhere near
    # either feature's stored bbox (see the LAKES fixture above). This query
    # matches lake:1's stored bbox and must keep it; if the endpoint were
    # secretly deriving a bbox from geometry instead of reading
    # properties["bbox"] (the old regions.filter_geojson fallback this
    # replaced), it would come back empty instead.
    body = _body(_run(app_mod.water_endpoint(kind="lakes", bbox="0,0,2,2")))
    assert _ids(body) == ["lake:1"]


def test_rivers_bbox_keeps_only_overlapping_features(stored):
    # Same proof as the lakes test above, for rivers.
    body = _body(_run(app_mod.water_endpoint(kind="rivers", bbox="40,40,42,42")))
    assert _ids(body) == ["river:2"]


def test_lakes_and_rivers_bbox_filtering_never_calls_filter_geojson(stored, monkeypatch):
    # Regression guard for the review finding directly: filter_geojson walks
    # every coordinate to derive a bbox, and storage.reference() never
    # returns the same object twice, so its identity-keyed memo never
    # absorbed that cost for water traffic. The fix was giving lakes/rivers
    # a stored bbox (water_bodies.py) and dropping filter_geojson from this
    # endpoint's code path entirely -- asserted here on the code path itself,
    # not on timing, so a regression fails loudly rather than just slowly.
    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("regions.filter_geojson must not be called by /api/water")

    monkeypatch.setattr(app_mod.regions, "filter_geojson", _must_not_be_called)
    _run(app_mod.water_endpoint(kind="lakes", bbox="0,0,2,2"))
    _run(app_mod.water_endpoint(kind="rivers", bbox="40,40,42,42"))
    _run(app_mod.water_endpoint(kind="marine", bbox="12,22,14,24"))


# --- antimeridian: the case Task 4 flagged for Task 5's overlap test --------

def test_antimeridian_marine_feature_matches_a_query_on_the_western_half(stored):
    # marine:2's stored bbox is [50, 170, 65, -170] -- west (170) > east
    # (-170), the wrap signal, standing in for a real feature like Bering
    # Sea. A query box can never itself be wrapped (regions.parse_bbox
    # refuses west > east outright), so a client covering both sides of the
    # seam has to ask twice, once per half. This query, 175..179 east
    # longitude, is the western half (170..180) of the wrapped range and
    # must match -- an overlap test that only understood "west <= east" as
    # valid would flip this feature's box and get it wrong.
    body = _body(_run(app_mod.water_endpoint(kind="marine", bbox="55,175,60,179")))
    assert _ids(body) == ["marine:2"]


def test_antimeridian_marine_feature_matches_a_query_on_the_eastern_half(stored):
    # Same feature, the other half of the wrap (-180..-170).
    body = _body(_run(app_mod.water_endpoint(kind="marine", bbox="55,-179,60,-171")))
    assert _ids(body) == ["marine:2"]


def test_antimeridian_marine_feature_does_not_match_a_query_away_from_the_seam(stored):
    # Same latitude band as marine:2 (50..65), but longitude 0..10 is nowhere
    # near either half of its wrapped range (170..180 / -180..-170) -- must
    # not match. This isolates the longitude wrap logic from the (already
    # separately correct) latitude comparison.
    body = _body(_run(app_mod.water_endpoint(kind="marine", bbox="55,0,60,10")))
    assert _ids(body) == []


# --- caching --------------------------------------------------------------

def test_the_second_ask_for_the_same_kind_and_bbox_does_not_touch_storage(stored):
    answers, reads = stored
    _run(app_mod.water_endpoint(kind="marine", bbox="12,22,14,24"))
    _run(app_mod.water_endpoint(kind="marine", bbox="12,22,14,24"))
    assert reads == ["water_marine"]


def test_a_different_bbox_is_a_separate_cache_entry(stored):
    answers, reads = stored
    _run(app_mod.water_endpoint(kind="marine", bbox="12,22,14,24"))
    _run(app_mod.water_endpoint(kind="marine", bbox="0,0,5,5"))
    assert reads == ["water_marine", "water_marine"]


def test_a_kind_with_no_stored_snapshot_yet_is_an_empty_collection_not_an_error(monkeypatch):
    # Before water_bodies.py's first successful poll there is nothing in
    # reference_snapshots yet -- same "not an error" treatment
    # /api/admin1-boundaries gives a country with no stored geometry.
    async def reference(name):
        return None

    monkeypatch.setattr(app_mod.storage, "reference", reference)
    body = _body(_run(app_mod.water_endpoint(kind="lakes")))
    assert body == {"type": "FeatureCollection", "features": []}
