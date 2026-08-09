"""/api/admin1-boundaries: what the map gets when it asks for a country's states.

The frontend asks once per country selected and remembers the answer, including
the empty one -- so the two things worth pinning are that a country with no
subdivisions answers with an empty collection rather than an error (a 404 there
would put a failed request in the console every time someone selected Monaco),
and that a covered one is read from storage once and served from the cache after.
"""

import asyncio

import pytest
from fastapi import HTTPException

from backend import app as app_mod
from backend.ratelimit import LruTtlCache

USA = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {"code": "US-TX", "name": "Texas", "country_code": "USA"},
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    }],
}


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    import json
    return json.loads(response.body)


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    """A cache of its own per test -- the endpoint's is module-level and would
    otherwise carry one test's answers into the next."""
    monkeypatch.setattr(app_mod, "_ADMIN1_BOUNDARY_CACHE", LruTtlCache(maxsize=8, ttl=3600))


@pytest.fixture
def stored(monkeypatch):
    """storage.reference, keyed by snapshot name, counting the reads."""
    answers = {}
    reads = []

    async def reference(name):
        reads.append(name)
        return answers.get(name)

    monkeypatch.setattr(app_mod.storage, "reference", reference)
    return answers, reads


def test_serves_one_country_from_storage(stored):
    answers, reads = stored
    answers["admin1_boundaries:USA"] = USA
    assert _body(_run(app_mod.admin1_boundaries_endpoint("usa"))) == USA
    assert reads == ["admin1_boundaries:USA"]


def test_a_country_with_no_stored_geometry_is_empty_not_an_error(stored):
    got = _body(_run(app_mod.admin1_boundaries_endpoint("MCO")))
    assert got == {"type": "FeatureCollection", "features": []}


def test_the_second_ask_does_not_touch_storage(stored):
    answers, reads = stored
    answers["admin1_boundaries:USA"] = USA
    _run(app_mod.admin1_boundaries_endpoint("USA"))
    _run(app_mod.admin1_boundaries_endpoint("USA"))
    assert reads == ["admin1_boundaries:USA"]


@pytest.mark.parametrize("country", ["US", "USAA", "", "US1", "../etc"])
def test_rejects_anything_that_is_not_an_iso3_code(stored, country):
    # The value goes straight into a storage key, so it is checked rather than
    # trusted -- and a two-letter code is a real mistake to make, since the
    # frontend's country selection is keyed on ISO2 everywhere else.
    with pytest.raises(HTTPException) as raised:
        _run(app_mod.admin1_boundaries_endpoint(country))
    assert raised.value.status_code == 400
