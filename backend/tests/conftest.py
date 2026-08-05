"""Shared fixtures for the pure-function tests.

Nothing here touches the network or the database. The GDELT row builder below
produces real 61-column export rows so the column indices in gdelt.py are
exercised by position, not by assumption -- if an index moves, these tests
fail rather than silently reading the wrong field.
"""

import pytest

# Field name -> column index, matching the GDELT 2.0 export layout. Verified
# empirically against live data by backend/scripts/probe_gdelt.py.
_COLS = {
    "event_id": 0, "sqldate": 1, "actor1": 6, "actor1_country": 7,
    "actor1_group": 8, "actor1_type": 12, "actor2": 16, "actor2_country": 17,
    "actor2_group": 18, "actor2_type": 22, "is_root": 25, "event_code": 26,
    "base_code": 27, "root_code": 28, "quad": 29, "goldstein": 30,
    "mentions": 31, "sources": 32, "articles": 33, "tone": 34,
    "geo_type": 51, "geo_name": 52, "geo_country": 53, "lat": 56, "lon": 57,
    "feature_id": 58, "date_added": 59, "source_url": 60,
}

_DEFAULTS = {
    "event_id": "1316898062", "sqldate": "20260805", "quad": "4",
    "goldstein": "-10.0", "mentions": "2", "sources": "1", "articles": "2",
    "tone": "-6.5", "geo_type": "4", "geo_name": "Kherson, Khersons'ka Oblast', Ukraine",
    "geo_country": "UP", "lat": "46.6354", "lon": "32.6169", "feature_id": "-1041356",
    "date_added": "20260805101500", "source_url": "https://www.reuters.com/world/example",
    "event_code": "190", "base_code": "190", "root_code": "19", "is_root": "1",
    "actor1": "RUSSIA", "actor2": "AIR FORCE", "actor2_type": "MIL",
}


def gdelt_row(**overrides) -> list[str]:
    """Build one 61-column GDELT export row. Defaults describe a real event:
    a Russian air force strike on Kherson, city-precision geocode."""
    row = [""] * 61
    for name, value in {**_DEFAULTS, **overrides}.items():
        row[_COLS[name]] = value
    return row


def gdelt_tsv(*rows: list[str]) -> str:
    return "\n".join("\t".join(r) for r in rows) + "\n"


@pytest.fixture
def row():
    return gdelt_row
