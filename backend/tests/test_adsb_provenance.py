"""Which upstream fed each merged aircraft record.

adsb._fetch() merges OpenSky and airplanes.live into one dict per icao24, with
airplanes.live winning field-by-field on conflict (see its own comment). That
merge is silent about which feed(s) actually contributed once it's done --
these pin the `data_sources` tag added alongside it, and specifically that the
tag is looked up against the two source dicts rather than guessed from which
fields are present (an airplanes.live aircraft with no reference data on file
sets none of the fields a guess would key on, which is exactly the case a
guess would get wrong).

Monkeypatches the two feed fetchers directly rather than mocking httpx: the
merge is what's under test, not either fetcher's own HTTP handling (which
their own normalisation tests already cover).
"""

import asyncio

from backend.sources import adsb


def _record(icao24: str, **overrides) -> dict:
    base = {"icao24": icao24, "lat": 51.0, "lon": 0.0, "altitude": 1000, "updated": 1_786_000_000.0}
    base.update(overrides)
    return base


def _patch_feeds(monkeypatch, opensky: dict, airplanes_live: dict):
    async def fake_opensky():
        return opensky

    async def fake_airplanes_live():
        return airplanes_live

    monkeypatch.setattr(adsb, "_fetch_opensky", fake_opensky)
    monkeypatch.setattr(adsb, "_fetch_airplanes_live", fake_airplanes_live)


def _by_icao(merged: list[dict]) -> dict:
    return {item["icao24"]: item for item in merged}


def test_an_opensky_only_aircraft_is_tagged_opensky_alone(monkeypatch):
    _patch_feeds(monkeypatch, {"aaaaaa": _record("aaaaaa")}, {})
    merged = _by_icao(asyncio.run(adsb._fetch()))
    assert merged["aaaaaa"]["data_sources"] == ["OpenSky"]


def test_an_airplanes_live_only_aircraft_is_tagged_airplanes_live_alone(monkeypatch):
    _patch_feeds(monkeypatch, {}, {"bbbbbb": _record("bbbbbb")})
    merged = _by_icao(asyncio.run(adsb._fetch()))
    assert merged["bbbbbb"]["data_sources"] == ["airplanes.live"]


def test_an_aircraft_seen_by_both_feeds_carries_both_names(monkeypatch):
    _patch_feeds(
        monkeypatch,
        {"cccccc": _record("cccccc", origin_country="United Kingdom")},
        {"cccccc": _record("cccccc", registration="G-TEST")},
    )
    merged = _by_icao(asyncio.run(adsb._fetch()))
    assert merged["cccccc"]["data_sources"] == ["OpenSky", "airplanes.live"]


def test_the_tag_is_not_guessed_from_which_fields_happen_to_be_set(monkeypatch):
    """An airplanes.live aircraft with no reference data on file (no
    registration, no type, no operator) still has to be tagged correctly --
    a guess keyed on those fields would silently miss it."""
    _patch_feeds(monkeypatch, {}, {"dddddd": _record("dddddd")})
    merged = _by_icao(asyncio.run(adsb._fetch()))
    assert merged["dddddd"]["data_sources"] == ["airplanes.live"]
