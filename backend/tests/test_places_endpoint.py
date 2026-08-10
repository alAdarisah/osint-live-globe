"""/api/places (Task 34): type a few characters of a place name, fly to it.

gazetteer_places/gazetteer_alternates have no direct table reader in this
endpoint -- see app.py's comment above places_endpoint for why. gazetteer.py
already keeps the whole ~270k-place cities500 index resident in memory
(gazetteer.current()), rebuilt from Postgres on every refresh and warmed from
it at boot, so this endpoint runs Gazetteer.search() against that live index
rather than querying storage. These tests build a small index by hand with
gz.build_index (the same helper test_gazetteer.py uses) and gz.install() it,
following test_water_endpoint.py's style of calling the endpoint function
directly rather than standing up a real HTTP client.
"""

import asyncio
import json

import pytest

from backend import app as app_mod
from backend.sources import gazetteer as gz
from backend.tests.conftest import geonames_row


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    return json.loads(response.body)


def _index(*rows: str) -> gz.Gazetteer:
    places, alternates = gz.parse_cities("\n".join(rows))
    return gz.build_index(places, alternates, [], [])


@pytest.fixture(autouse=True)
def installed_gazetteer():
    """A fresh, empty gazetteer before and after every test, so one test's
    installed index never leaks into the next (gz.install swaps a module-level
    global -- see gazetteer.py's own "atomic swap" docstring)."""
    gz.install(gz.Gazetteer([]))
    yield
    gz.install(gz.Gazetteer([]))


def _search(q="", limit=None):
    kwargs = {"q": q}
    if limit is not None:
        kwargs["limit"] = limit
    return _body(_run(app_mod.places_endpoint(**kwargs)))


# --- empty / too-short query -------------------------------------------------


def test_empty_query_returns_no_results_not_an_error():
    gz.install(_index(geonames_row()))
    body = _search(q="")
    assert body["results"] == []
    assert body["total_matches"] == 0


def test_a_query_below_the_minimum_length_also_returns_nothing():
    # "s" alone would match a large fraction of any real gazetteer -- see
    # MIN_PLACE_QUERY_LENGTH's comment in app.py. Not an error, same as an
    # empty query: a search box mid-keystroke is the normal case.
    gz.install(_index(geonames_row(name="Springfield", asciiname="Springfield")))
    body = _search(q="s")
    assert body["results"] == []
    assert body["total_matches"] == 0


# --- basic match + response shape -------------------------------------------


def test_a_matching_query_returns_the_disambiguating_fields():
    gz.install(_index(geonames_row(
        geonameid="703448", name="Kyiv", asciiname="Kyiv", alternatenames="",
        country_code="UA", admin1="30", population="2797553",
        feature_class="P", feature_code="PPLC", lat="50.45466", lon="30.5238",
    )))
    body = _search(q="kyi")
    assert len(body["results"]) == 1
    hit = body["results"][0]
    # Country, admin-1, population and feature class must all be present --
    # the brief's honesty requirement is that a reader can tell two
    # identically-named places apart from the result alone.
    assert hit["name"] == "Kyiv"
    assert hit["country_code"] == "UA"
    assert hit["admin1"] == "30"
    assert hit["population"] == 2797553
    assert hit["feature_class"] == "P"
    assert hit["feature_code"] == "PPLC"
    assert hit["lat"] == pytest.approx(50.45466)
    assert hit["lon"] == pytest.approx(30.5238)
    assert hit["is_alternate"] is False


# --- ranking ------------------------------------------------------------------


def test_a_prefix_match_outranks_a_far_larger_substring_match():
    """Match quality decides before population does: a small place whose own
    name starts with the query beats a huge one that only matches via a
    substring inside an alternate name."""
    gz.install(_index(
        geonames_row(geonameid="1", name="Sanford", asciiname="Sanford", alternatenames="",
                     country_code="US", admin1="FL", population="5000",
                     lat="28.8", lon="-81.3", feature_code="PPL"),
        # "Ansan" contains "san" but does not start with it -- a substring
        # match on an alternate name, the worst-ranked match tier.
        geonames_row(geonameid="2", name="Los Angeles", asciiname="Los Angeles",
                     alternatenames="Ansan", country_code="US", admin1="CA",
                     population="4000000", lat="34.0", lon="-118.2", feature_code="PPLA"),
    ))
    body = _search(q="san")
    ids = [r["geonameid"] for r in body["results"]]
    assert ids.index(1) < ids.index(2)


def test_population_breaks_ties_between_equally_good_matches():
    gz.install(_index(
        geonames_row(geonameid="1", name="Springfield", asciiname="Springfield", alternatenames="",
                     country_code="US", admin1="IL", population="116565",
                     lat="39.8", lon="-89.6", feature_code="PPLA"),
        geonames_row(geonameid="2", name="Springfield", asciiname="Springfield", alternatenames="",
                     country_code="US", admin1="MO", population="169176",
                     lat="37.2", lon="-93.3", feature_code="PPLA2"),
    ))
    body = _search(q="spring")
    assert body["results"][0]["geonameid"] == 2  # the larger Springfield first


# --- alternates ---------------------------------------------------------------


def test_a_stored_alternate_name_finds_its_place():
    gz.install(_index(geonames_row(
        geonameid="706448", name="Kherson", asciiname="Kherson",
        alternatenames="Херсон,Cherson,Chersón",
        country_code="UA", admin1="65", population="283649",
        lat="46.6354", lon="32.6169", feature_code="PPLA",
    )))
    body = _search(q="cherson")
    assert len(body["results"]) == 1
    hit = body["results"][0]
    assert hit["geonameid"] == 706448
    assert hit["is_alternate"] is True
    assert hit["matched_name"] in ("Cherson", "Chersón")


# --- diacritic-insensitive matching --------------------------------------------


def test_a_query_without_diacritics_finds_a_name_that_has_them():
    gz.install(_index(geonames_row(
        geonameid="2886242", name="Köln", asciiname="Koln", alternatenames="",
        country_code="DE", admin1="07", population="1085664",
        lat="50.93333", lon="6.95", feature_code="PPLA3",
    )))
    body = _search(q="koln")
    assert [r["geonameid"] for r in body["results"]] == [2886242]


# --- the cap --------------------------------------------------------------------


def test_the_result_set_is_capped_and_the_cap_is_stated():
    rows = [
        geonames_row(geonameid=str(i), name=f"Portville{i:03d}", asciiname=f"Portville{i:03d}",
                     alternatenames="", country_code="US", admin1="TX", population=str(i * 100),
                     lat="30.0", lon="-95.0", feature_code="PPL")
        for i in range(1, 26)  # 25 places, all matching "port"
    ]
    gz.install(_index(*rows))
    body = _search(q="port")
    assert body["total_matches"] == 25
    assert len(body["results"]) == 20  # PLACE_SEARCH_LIMIT
    assert body["limit"] == 20
    # Never silently truncated: the response says there were more than shown.
    assert body["total_matches"] > len(body["results"])


def test_a_requested_limit_above_the_cap_is_clamped_not_honoured():
    rows = [
        geonames_row(geonameid=str(i), name=f"Portville{i:03d}", asciiname=f"Portville{i:03d}",
                     alternatenames="", country_code="US", admin1="TX", population=str(i * 100),
                     lat="30.0", lon="-95.0", feature_code="PPL")
        for i in range(1, 26)
    ]
    gz.install(_index(*rows))
    body = _search(q="port", limit=1000)
    assert body["limit"] == 20
    assert len(body["results"]) == 20


def test_a_requested_limit_below_the_cap_is_honoured():
    gz.install(_index(
        geonames_row(geonameid="1", name="Portville", asciiname="Portville", alternatenames="",
                     country_code="US", admin1="TX", population="100", lat="30.0", lon="-95.0"),
        geonames_row(geonameid="2", name="Portsmouth", asciiname="Portsmouth", alternatenames="",
                     country_code="GB", admin1="ENG", population="200000", lat="50.8", lon="-1.1"),
    ))
    body = _search(q="port", limit=1)
    assert body["limit"] == 1
    assert len(body["results"]) == 1
    assert body["total_matches"] == 2


# --- an unmatched query --------------------------------------------------------


def test_no_matches_is_an_empty_list_not_an_error():
    gz.install(_index(geonames_row(name="Kyiv", asciiname="Kyiv")))
    body = _search(q="nonexistentplacename")
    assert body["results"] == []
    assert body["total_matches"] == 0
