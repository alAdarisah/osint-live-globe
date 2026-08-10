"""/api/ships?callsign= -- Task 18's server-side narrowing for /api/ships.

This is deliberately *not* the same filter as the client-side vessel filter
bar (frontend/src/utils/entityFilter.js, matchesVesselFilter): that one
matches callsign, name, mmsi and imo, and is what the map's own filter bar
count is measured against. This parameter matches callsign only, and this
map's own client never sends it (see the long comment on the `ships` route in
backend/app.py) -- it exists for a caller fetching the whole global feed who
wants the server to do the narrowing first. The tests below are about that
one endpoint's own guarantees: the match rule itself, that it still respects
the region/bbox box, and that it produces a distinguishable cached body.
"""

import pytest

from backend import app as app_mod
from backend import regions


# --- the match rule ----------------------------------------------------

@pytest.mark.parametrize(
    "value, query, expected",
    [
        ("5BXY2", "5bx", True),        # case-insensitive implicit prefix
        ("5BXY2", "5BXY2", True),
        ("5BXY2", "BXY", False),       # not a prefix, and no wildcard was given
        ("5BXY2", "5BXY*", True),      # trailing wildcard
        ("5BXY2", "*XY2", True),       # leading wildcard
        ("5BXY2", "*BX*", True),       # wildcard both ends: contains
        ("5BXY2", "5BXY99", False),
        (None, "5BX", False),          # nothing to match against
        ("5BXY2", "", True),           # an empty query matches everything
    ],
)
def test_matches_callsign_query(value, query, expected):
    assert app_mod._matches_callsign_query(value, query) is expected


def test_regex_metacharacters_in_the_query_are_literal():
    # "." is not this filter's wildcard -- "*" is -- so it must not be read
    # as "any one character" the way a bare regex would.
    assert app_mod._matches_callsign_query("5B.01", "5B.01") is True
    assert app_mod._matches_callsign_query("5BX01", "5B.01") is False


# --- the endpoint's own guarantees --------------------------------------

def test_the_filter_still_applies_the_region_box():
    items = [
        {"mmsi": 1, "callsign": "5BXY2", "lat": 50.0, "lon": 30.0},
        {"mmsi": 2, "callsign": "5BXY2", "lat": -20.0, "lon": -60.0},
        {"mmsi": 3, "callsign": "OTHER", "lat": 50.0, "lon": 30.0},
    ]
    box = regions.parse_bbox("45,25,55,35")
    kept = app_mod._ships_callsign_filter("5BX")(items, box)
    assert [d["mmsi"] for d in kept] == [1]


def _seed_ais():
    from backend.cache import registry

    registry.register("ais", key_configured=True)
    state = registry.get("ais")
    state.data = [
        {"mmsi": 1, "callsign": "5BXY2", "lat": 10.0, "lon": 10.0},
        {"mmsi": 2, "callsign": "OTHER1", "lat": 10.0, "lon": 10.0},
    ]
    state.version = 7
    return state


class _Req:
    headers: dict = {}


def test_no_callsign_param_serves_the_whole_feed():
    import asyncio

    _seed_ais()
    body = asyncio.run(app_mod.ships(_Req(), callsign=None)).body
    assert b'"5BXY2"' in body
    assert b'"OTHER1"' in body


def test_a_callsign_param_narrows_it():
    import asyncio

    _seed_ais()
    body = asyncio.run(app_mod.ships(_Req(), callsign="5BX")).body
    assert b'"5BXY2"' in body
    assert b'"OTHER1"' not in body


def test_the_two_slices_are_different_bodies_and_say_so():
    """Same source, version, region and box -- the callsign query has to be
    in the ETag or a client would be told its cached body (from before it
    typed a query, or from a different query) is still the right answer."""
    from backend.cache import registry

    registry.register("ais_callsign_variant_probe", key_configured=True)
    state = registry.get("ais_callsign_variant_probe")
    state.data = [
        {"mmsi": 1, "callsign": "5BXY2", "lat": 10.0, "lon": 10.0},
        {"mmsi": 2, "callsign": "OTHER1", "lat": 10.0, "lon": 10.0},
    ]
    state.version = 4

    full = app_mod._cached_source_response(
        _Req(), "ais_callsign_variant_probe", None, regions.filter_points
    )
    narrowed = app_mod._cached_source_response(
        _Req(), "ais_callsign_variant_probe", None,
        app_mod._ships_callsign_filter("5BX"), variant="callsign:5BX",
    )
    assert full.headers["etag"] != narrowed.headers["etag"]
