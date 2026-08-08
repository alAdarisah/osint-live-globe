"""/api/aircraft?civilian=0 -- the slice a zoomed-out reader can actually draw.

The aircraft feed is the largest payload this API serves (~17,000 aircraft,
~6.6 MB) and below zoom 9 the map draws only a few hundred of them: military,
emergency and OFAC-designated. This filter is what lets a client ask for that
slice instead of the whole feed.

Everything here is about the one direction that fails silently. An aircraft
wrongly *kept* costs bytes and a reader can see it. An aircraft wrongly
*dropped* is simply absent from a map whose purpose is showing military
aircraft, with no error, no empty layer and nothing to notice -- so the
predicate is asserted field by field, and the callsign heuristic is asserted to
still live in exactly one place.
"""

import pytest

from backend import app as app_mod
from backend import regions
from backend.sources import adsb


# --- the predicate, one signal at a time ------------------------------------

@pytest.mark.parametrize(
    "field, value",
    [
        ("military", True),           # airplanes.live dbFlags bit 1
        ("callsign_military", True),  # a mission callsign (see adsb.py)
        ("hex_military", True),       # the ICAO hex block is a military allocation
        ("military_role", "tanker"),  # inferred role implies a military airframe
        ("emergency", "general emergency"),
        ("emergency_squawk", "7500 unlawful interference"),
        ("sanctions", [{"programme": "UKRAINE-EO13662"}]),
    ],
)
def test_every_signal_the_map_draws_on_survives_the_filter(field, value):
    # The client decides "military" from military/callsign_military, and puts an
    # aircraft in the always-on flagged bucket for an emergency or a
    # designation. If any one of those stopped surviving here, that aircraft
    # would vanish from the world view with nothing to indicate it had.
    assert app_mod._aircraft_priority({"icao24": "abc123", field: value}) is True


def test_an_ordinary_airliner_does_not_survive():
    assert (
        app_mod._aircraft_priority(
            {"icao24": "abc123", "callsign": "DLH400", "category": 4, "military": False}
        )
        is False
    )


def test_display_limited_alone_does_not_survive():
    """The whole point of the filter, and the largest single group it removes.

    A LADD or PIA listing is a fact about a registry entry rather than about a
    flight, and the map gates it at the same zoom as ordinary traffic (see
    adsbDisplayLimited in frontend/src/map/scene.js). Measured on the live feed:
    638 of ~17,000 aircraft, and zero of them emergencies.
    """
    assert app_mod._aircraft_priority({"icao24": "abc123", "display_limited": True}) is False
    # ...but a display-limited aircraft that is *also* military still survives,
    # because the military signal is what is being asked about.
    assert app_mod._aircraft_priority(
        {"icao24": "abc123", "display_limited": True, "military": True}
    ) is True


def test_falsy_values_are_not_treated_as_signals():
    # An explicit False or None means "we looked and it is not", not "unknown".
    assert (
        app_mod._aircraft_priority(
            {
                "military": False,
                "callsign_military": False,
                "hex_military": False,
                "military_role": None,
                "emergency": None,
                "emergency_squawk": None,
                "sanctions": [],
            }
        )
        is False
    )


# --- the callsign heuristic -------------------------------------------------

@pytest.mark.parametrize(
    "callsign",
    ["RCH271", "reach271", "  NATO01  ", "ASCOT4321", "USAF1", "NAVY22"],
)
def test_mission_callsigns_are_recognised_however_they_arrive(callsign):
    # Trimmed and upper-cased, because the two feeds disagree about both: OpenSky
    # pads its callsign field and airplanes.live does not.
    assert adsb._callsign_military(callsign) is True


@pytest.mark.parametrize("callsign", [None, "", "   ", "DLH400", "BAW117", "N512JT"])
def test_civil_callsigns_are_not(callsign):
    assert adsb._callsign_military(callsign) is False


def test_the_prefix_list_lives_only_on_the_server():
    """One list, on the side that filters.

    This heuristic used to live in the frontend's classifyAircraft. If both
    sides kept a copy and they drifted apart, a client with the *wider* list
    would classify as military an aircraft the server had already dropped -- and
    the failure would be an aircraft missing from the map, not an error. So the
    record carries the answer (`callsign_military`) rather than the rule.
    """
    frontend = (
        __file__.rsplit("backend", 1)[0] + "frontend/src/map/decorators.js"
    )
    with open(frontend, encoding="utf-8") as fh:
        source = fh.read()
    assert "MILITARY_CALLSIGN_PREFIXES" not in source
    assert "callsign_military" in source


# --- normalising ------------------------------------------------------------

def test_both_feeds_annotate_the_flag():
    """Two normalisers, and a record missing the field would read as civil.

    airplanes.live and OpenSky produce the same record shape from different
    payloads, and the filter above trusts the field rather than recomputing it,
    so a normaliser that forgot it would quietly drop that feed's mission
    aircraft from the world view.
    """
    record = adsb.normalize_airplanes_live(
        {"hex": "AE1234", "lat": 50.0, "lon": 8.0, "flight": "RCH271 ", "seen_pos": 1}
    )
    assert record["callsign_military"] is True
    assert record["military"] is False, "a mission callsign is not a database flag"

    civil = adsb.normalize_airplanes_live(
        {"hex": "3C1234", "lat": 50.0, "lon": 8.0, "flight": "DLH400", "seen_pos": 1}
    )
    assert civil["callsign_military"] is False


# --- the endpoint's own guarantees ------------------------------------------

def test_the_filter_still_applies_the_region_box():
    # civilian=0 narrows *which* aircraft, never *where*: a region or viewport
    # box has to keep applying on top of it, or a scoped client would get
    # military aircraft from outside the zone it selected.
    items = [
        {"icao24": "a", "lat": 50.0, "lon": 30.0, "military": True},
        {"icao24": "b", "lat": -20.0, "lon": -60.0, "military": True},
        {"icao24": "c", "lat": 50.0, "lon": 30.0, "callsign": "DLH400"},
    ]
    box = regions.parse_bbox("45,25,55,35")
    kept = app_mod._aircraft_priority_filter(items, box)
    assert [d["icao24"] for d in kept] == ["a"]


def _seed_adsb():
    """Two aircraft in the live source: one military, one airliner."""
    from backend.cache import registry

    registry.register("adsb", key_configured=True)
    state = registry.get("adsb")
    state.data = [
        {"icao24": "a", "lat": 10.0, "lon": 10.0, "military": True},
        {"icao24": "b", "lat": 10.0, "lon": 10.0, "callsign": "DLH400"},
    ]
    state.version = 11
    return state


class _Req:
    headers: dict = {}


@pytest.mark.parametrize("value", [None, "", "1", "nope", "0.0", "false", "00", "-0"])
def test_anything_but_an_exact_zero_asks_for_the_whole_feed(value):
    """A typo costs a larger correct answer, never a 422 and never a thin one.

    This is a browser query parameter, and it follows parse_bbox's rule rather
    than FastAPI's: declared an `int`, `?civilian=nope` would 422 and the map
    would lose its aircraft layer over a malformed URL. Failing toward *more*
    data is the only safe direction here.
    """
    import asyncio

    _seed_adsb()
    body = asyncio.run(app_mod.aircraft(_Req(), civilian=value)).body
    assert b'"b"' in body, f"civilian={value!r} should not have thinned the feed"


def test_an_exact_zero_is_the_only_thing_that_thins_it():
    import asyncio

    _seed_adsb()
    body = asyncio.run(app_mod.aircraft(_Req(), civilian="0")).body
    assert b'"a"' in body, "the military aircraft must survive"
    assert b'"b"' not in body, "the airliner must not"


def test_the_two_slices_are_different_bodies_and_say_so():
    """Same source, same version, same region, same box -- different payloads.

    Without the variant in the ETag a client that had the thin slice cached and
    then asked for the full feed would be handed a 304 telling it the thin one
    was the answer, and the civilian aircraft would never arrive.
    """
    from backend.cache import registry

    registry.register("adsb_variant_probe", key_configured=True)
    state = registry.get("adsb_variant_probe")
    state.data = [
        {"icao24": "a", "lat": 10.0, "lon": 10.0, "military": True},
        {"icao24": "b", "lat": 10.0, "lon": 10.0, "callsign": "DLH400"},
    ]
    state.version = 3

    class _Req:
        headers: dict = {}

    full = app_mod._cached_source_response(
        _Req(), "adsb_variant_probe", None, regions.filter_points
    )
    thin = app_mod._cached_source_response(
        _Req(), "adsb_variant_probe", None, app_mod._aircraft_priority_filter, variant="nocivil"
    )
    assert full.headers["etag"] != thin.headers["etag"]
