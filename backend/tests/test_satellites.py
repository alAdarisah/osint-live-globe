"""backend/sources/satellites.py -- Task 24's server-side half of "more
satellites, propagated in the browser".

Three things this task's own brief calls for tests on: the group registry
(and that "active" is nowhere in it), the elements endpoint's group filter,
and the per-group cadence selection. A fourth block below checks the GP
fields the collector used to discard (international designator, inclination,
period, apogee, perigee, epoch, launch year) actually make it into both the
server-propagated positions and the stored client-propagated element sets --
that carrying-through is the whole point of Task 25's card being able to
open later.

No live network anywhere here, per this repo's test discipline: a single
hand-built OMM record (ISS-shaped, but with a fixed epoch so a re-run next
year can't silently start seeing a different derived age) stands in for a
CelesTrak response.
"""

import asyncio
import json

import pytest

from backend import app as app_mod
from backend.sources import satellites


# A structurally real CelesTrak GP JSON record (same field set fetched from
# https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json,
# confirmed live while this task was written), values changed only enough to
# fix the epoch so tests are reproducible. `_group` is added the same way
# _fetch_group does it to a live response, since the functions under test
# read it off already-tagged records rather than doing the tagging
# themselves.
_ISS_OMM = {
    "OBJECT_NAME": "ISS (ZARYA)",
    "OBJECT_ID": "1998-067A",
    "EPOCH": "2026-08-09T20:37:29.985312",
    "MEAN_MOTION": 15.49397757,
    "ECCENTRICITY": 0.0007373,
    "INCLINATION": 51.6326,
    "RA_OF_ASC_NODE": 34.4681,
    "ARG_OF_PERICENTER": 30.2451,
    "MEAN_ANOMALY": 329.8962,
    "EPHEMERIS_TYPE": 0,
    "CLASSIFICATION_TYPE": "U",
    "NORAD_CAT_ID": 25544,
    "ELEMENT_SET_NO": 999,
    "REV_AT_EPOCH": 58007,
    "BSTAR": 0.000083247,
    "MEAN_MOTION_DOT": 0.000042010,
    "MEAN_MOTION_DDOT": 0,
    "_group": "stations",
}


# --- the group registry --------------------------------------------------

def test_active_is_offered_nowhere():
    # 11,000 objects and no view of this map it would help -- the one group
    # the brief explicitly says must never be reachable through this layer.
    assert "active" not in satellites.ELEMENT_LAYER_GROUPS
    assert "active" not in satellites.GROUPS
    for ct_groups in satellites.ELEMENT_LAYER_GROUPS.values():
        assert "active" not in ct_groups


def test_server_propagated_groups_are_unchanged():
    # stations/military stay SGP4'd here, exactly as before this task --
    # nothing in the brief asked this list to grow.
    assert satellites.GROUPS == ["stations", "military"]


def test_every_brief_toggle_is_registered_with_its_celestrak_groups():
    assert satellites.ELEMENT_LAYER_GROUPS == {
        "navigation": ["gps-ops", "galileo", "glo-ops", "beidou"],
        "weather": ["weather", "goes"],
        "imaging": ["resource", "sarsat", "spire", "planet"],
        "science": ["science"],
        "geo": ["geo"],
        "starlink": ["starlink"],
        "oneweb": ["oneweb"],
    }


def test_noaa_is_deliberately_absent():
    # CelesTrak has no "noaa" group (confirmed live -- GROUP=noaa 404s with
    # "not found"), unlike every other group named in the task brief, which
    # all resolved. NOAA's weather satellites are already inside "weather".
    for ct_groups in satellites.ELEMENT_LAYER_GROUPS.values():
        assert "noaa" not in ct_groups


def test_no_celestrak_group_is_claimed_by_two_toggles():
    seen = set()
    for ct_groups in satellites.ELEMENT_LAYER_GROUPS.values():
        for ct_group in ct_groups:
            assert ct_group not in seen, f"{ct_group!r} listed under more than one layer toggle"
            seen.add(ct_group)


# --- per-group cadence selection -----------------------------------------

@pytest.mark.parametrize(
    "layer_key, expected_seconds",
    [
        ("navigation", 10),
        ("weather", 10),
        ("science", 10),
        ("imaging", 60),
        ("geo", 60),
        ("starlink", 60),
        ("oneweb", 60),
        # An unrecognised key gets the conservative cadence, not the cheap
        # one -- see cadence_seconds' own docstring.
        ("something-new", 60),
    ],
)
def test_cadence_seconds(layer_key, expected_seconds):
    assert satellites.cadence_seconds(layer_key) == expected_seconds


def test_large_layer_groups_is_a_subset_of_the_registered_toggles():
    assert satellites._LARGE_LAYER_GROUPS <= set(satellites.ELEMENT_LAYER_GROUPS)


# --- the elements endpoint's group filter --------------------------------

def _tagged(layer, norad_id):
    return {**_ISS_OMM, "NORAD_CAT_ID": norad_id, "_layer": layer}


def test_filter_elements_by_layer_narrows_to_the_requested_groups():
    elements = [_tagged("navigation", 1), _tagged("weather", 2), _tagged("imaging", 3)]
    kept = satellites.filter_elements_by_layer(elements, {"navigation", "imaging"})
    assert [e["NORAD_CAT_ID"] for e in kept] == [1, 3]


def test_filter_elements_by_layer_empty_request_is_empty_not_everything():
    elements = [_tagged("navigation", 1), _tagged("starlink", 2)]
    # Nothing requested must never quietly mean "every group" -- starlink
    # alone is thousands of element sets, and turning that on by omission
    # would be exactly the mistake the hard gate in the control panel exists
    # to prevent.
    assert satellites.filter_elements_by_layer(elements, set()) == []


def test_filter_elements_by_layer_drops_unknown_keys_rather_than_erroring():
    elements = [_tagged("navigation", 1)]
    assert satellites.filter_elements_by_layer(elements, {"not-a-real-layer"}) == []
    assert satellites.filter_elements_by_layer(elements, {"navigation", "not-a-real-layer"}) == elements


def _seed_satellite_elements():
    from backend.cache import registry

    registry.register("satellite_elements", key_configured=True)
    state = registry.get("satellite_elements")
    state.data = [_tagged("navigation", 1), _tagged("starlink", 2)]
    state.version = 3
    return state


class _Req:
    headers: dict = {}


def test_endpoint_with_no_groups_param_serves_nothing():
    _seed_satellite_elements()
    body = asyncio.run(app_mod.satellite_elements(_Req(), groups=None)).body
    assert body == b"[]"


def test_endpoint_groups_param_narrows_to_the_requested_layer():
    _seed_satellite_elements()
    body = asyncio.run(app_mod.satellite_elements(_Req(), groups="navigation")).body
    ids = [e["NORAD_CAT_ID"] for e in json.loads(body)]
    assert ids == [1]


def test_endpoint_never_offers_active_through_the_groups_param():
    _seed_satellite_elements()
    # "active" is not a registered layer key at all, so asking for it is the
    # same as asking for nothing -- filter_elements_by_layer drops it rather
    # than erroring, and the response is empty either way.
    body = asyncio.run(app_mod.satellite_elements(_Req(), groups="active")).body
    assert body == b"[]"


def test_different_groups_params_are_different_cached_bodies():
    """Same source/version/region/box -- the groups query has to be in the
    ETag, or a client would be told its cached body from a different groups
    request is still the right answer. Mirrors test_ships_callsign_filter's
    equivalent check for the ?callsign= parameter."""
    from backend import regions

    _seed_satellite_elements()
    state = app_mod.registry.get("satellite_elements")

    navigation = app_mod._cached_source_response(
        _Req(), "satellite_elements", None,
        app_mod._satellite_elements_filter({"navigation"}), variant="groups:navigation",
    )
    starlink = app_mod._cached_source_response(
        _Req(), "satellite_elements", None,
        app_mod._satellite_elements_filter({"starlink"}), variant="groups:starlink",
    )
    assert navigation.headers["etag"] != starlink.headers["etag"]
    assert state.version == 3  # reading the endpoint never mutates the source


# --- carrying the GP fields the collector used to discard -----------------

def test_positions_carries_the_previously_discarded_gp_fields():
    [pos] = satellites._positions([_ISS_OMM])
    assert pos["norad_id"] == 25544
    assert pos["intl_designator"] == "1998-067A"
    assert pos["launch_year"] == 1998
    assert pos["inclination_deg"] == pytest.approx(51.6326)
    assert pos["epoch"] == "2026-08-09T20:37:29.985312"
    # period/apogee/perigee are derived, not restated from a table -- just
    # check they land in a physically sane band for a station in low Earth
    # orbit rather than pin exact numbers this test would then be the only
    # "source" for.
    assert 88 < pos["period_min"] < 96
    assert 300 < pos["perigee_km"] < 500
    assert 300 < pos["apogee_km"] < 500
    assert pos["apogee_km"] >= pos["perigee_km"]


def test_decorate_element_tags_the_layer_and_carries_the_same_fields():
    tagged = {**_ISS_OMM, "_group": "gps-ops"}
    decorated = satellites._decorate_element(tagged)
    assert decorated["_layer"] == "navigation"  # gps-ops rolls up to the navigation toggle
    assert decorated["intl_designator"] == "1998-067A"
    assert decorated["launch_year"] == 1998
    assert decorated["period_min"] is not None
    # The raw OMM fields satellite.js needs to propagate this in the browser
    # are still present, untouched, alongside the summary fields.
    assert decorated["MEAN_MOTION"] == _ISS_OMM["MEAN_MOTION"]
    assert decorated["ECCENTRICITY"] == _ISS_OMM["ECCENTRICITY"]


def test_decorate_element_survives_an_unparsable_element_set():
    broken = {**_ISS_OMM, "_group": "science", "MEAN_MOTION": "not-a-number"}
    decorated = satellites._decorate_element(broken)
    # Still tagged with its layer -- a browser gets its own chance at
    # propagating it -- but no summary fields it cannot honestly derive.
    assert decorated["_layer"] == "science"
    assert "period_min" not in decorated


def test_launch_year_is_absent_when_the_international_designator_is_missing():
    no_id = {**_ISS_OMM, "OBJECT_ID": ""}
    [pos] = satellites._positions([no_id])
    assert pos["launch_year"] is None
