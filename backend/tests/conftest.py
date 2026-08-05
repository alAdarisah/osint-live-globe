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


def gdelt_row_diplomatic(**overrides) -> list[str]:
    """A 61-column row describing diplomacy rather than violence.

    Defaults to CAMEO 042 (a state visit) between two governments, quad class 1
    -- the case the pipeline used to discard outright at parse time, and the
    reason the app had no view of what officials were doing.
    """
    return gdelt_row(**{
        "event_id": "1400000001", "quad": "1", "goldstein": "6.4", "tone": "2.1",
        "event_code": "042", "base_code": "042", "root_code": "04",
        "actor1": "GERMANY", "actor1_country": "DEU", "actor1_type": "GOV",
        "actor2": "UKRAINE", "actor2_country": "UKR", "actor2_type": "GOV",
        "geo_name": "Kyiv, Kyyiv, Ukraine", "geo_country": "UP",
        "lat": "50.4501", "lon": "30.5234",
        "source_url": "https://www.bbc.com/news/example-visit",
        **overrides,
    })


def gdelt_tsv(*rows: list[str]) -> str:
    return "\n".join("\t".join(r) for r in rows) + "\n"


# --- press-feed fixtures ---------------------------------------------------
#
# Real shapes, minus the bulk: RSS 2.0 as the White House and UN publish it,
# Atom as gov.uk and the Kremlin do. Both element sets appear in the wild on
# feeds declaring the other, which is why official_feeds parses them with one
# walk rather than branching on the root element -- these fixtures pin that.

RSS_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Press Office</title>
  <item>
    <title>Foreign Minister meets counterpart in Geneva</title>
    <link>https://example.gov/news/geneva-talks</link>
    <description>&lt;p&gt;The two ministers discussed &amp;amp; reviewed the ceasefire.&lt;/p&gt;</description>
    <pubDate>Wed, 05 Aug 2026 10:51:05 +0000</pubDate>
  </item>
  <item>
    <title>Statement on the situation in the region</title>
    <link>https://example.gov/news/statement</link>
    <pubDate>Wed, 05 Aug 2026 08:00:00 +0000</pubDate>
  </item>
</channel></rss>
"""

ATOM_FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Ministry</title>
  <entry>
    <title>Sanctions imposed on three individuals</title>
    <link rel="self" href="https://example.gov/atom"/>
    <link rel="alternate" href="https://example.gov/news/sanctions"/>
    <summary>Asset freezes take effect immediately.</summary>
    <published>2026-08-05T09:15:00+01:00</published>
  </entry>
</feed>
"""


@pytest.fixture
def row():
    return gdelt_row
