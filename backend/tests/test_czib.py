"""EASA CZIB parsing: the fields that are lies, the fields that are two formats,
and the eighteen bulletins that are history rather than warnings.

Every record inlined below is a real one from the live export on 2026-08-06,
copied verbatim -- including the `&#039;` in the North Korea country field, the
trailing space after it, the `&nbsp;` in the valid-until prose, and the en-dash
in three of the titles. Nothing here touches the network.

The load-bearing assertion is test_the_publishers_coordinates_are_never_read:
the `coordinates` field is a CMS geocode of the *country name* (Afghanistan's is
Kabul; Pakistan's is Karachi, which is in neither province the bulletin covers),
and the module is required never to read it.
"""

import ast
import pathlib

import pytest

from backend.cache import SourceRegistry
from backend.sources import czib, gazetteer

CZIB_SOURCE = pathlib.Path(czib.__file__)


# --- the live payload, verbatim ---------------------------------------------

UKRAINE = {
    "Nid": "136057",
    "issued_date": "2022-02-24T00:00:00+0200",
    "valid_until_date": "31/01/2027",
    "field_easa_valid_until_descr": "<p>Until 31/01/2027, unless reviewed earlier.</p>\n",
    "name": "Airspace of Ukraine",
    "status": "Active",
    "country": "Ukraine",
    "coordinates": "",
    "updated": '<time datetime="2026-07-24T14:07:23+03:00">2026-07-24T14:07:23+0300</time>\n',
}

# Carries a coordinate, and the coordinate is Kabul.
AFGHANISTAN = {
    "Nid": "20574",
    "issued_date": "2017-10-17T00:00:00+0300",
    "valid_until_date": "31/01/2027",
    "field_easa_valid_until_descr": "<p>31/01/2027, unless reviewed earlier.&nbsp;</p>\n",
    "name": "Airspace of Afghanistan",
    "status": "Active",
    "country": "Afghanistan",
    "coordinates": "34.5260131, 69.1776476",
    "updated": '<time datetime="2026-07-24T14:14:41+03:00">2026-07-24T14:14:41+0300</time>\n',
}

# Carries a coordinate, and the coordinate is Karachi -- while the bulletin
# covers Baluchistan and Khyber Pakhtunkhwa, and Karachi is in neither.
PAKISTAN = {
    "Nid": "20587",
    "issued_date": "2018-01-10T00:00:00+0200",
    "valid_until_date": "31/01/2027",
    "field_easa_valid_until_descr": "<p>31/01/2027, unless reviewed earlier.&nbsp;</p>\n",
    "name": "Airspace of Pakistan – Baluchistan and Khyber Pakhtunkhwa provinces",
    "status": "Active",
    "country": "Pakistan",
    "coordinates": "25.1446897, 67.184776731573",
    "updated": '<time datetime="2026-07-24T14:09:06+03:00">2026-07-24T14:09:06+0300</time>\n',
}

# One bulletin, eleven states.
MIDDLE_EAST = {
    "Nid": "143294",
    "issued_date": "2026-02-28T00:00:00+0200",
    "valid_until_date": "08/07/2026",
    "field_easa_valid_until_descr": "<p>08/07/2026, unless reviewed earlier.&nbsp;</p>\n",
    "name": "Airspace of the Middle East and Persian Gulf",
    "status": "Withdrawn",
    "country": (
        "Bahrain, Iran, Iraq, Israel, Jordan, Kuwait, Lebanon, Oman, Qatar, "
        "United Arab Emirates, Saudi Arabia"
    ),
    "coordinates": "",
    "updated": '<time datetime="2026-07-08T10:43:13+03:00">2026-07-08T10:43:13+0300</time>\n',
}

# No country at all, and a title a scraper would be tempted by.
IRAN_NEIGHBOURING = {
    "Nid": "143048",
    "issued_date": "2026-01-16T00:00:00+0200",
    "valid_until_date": "31/03/2026",
    "field_easa_valid_until_descr": "<p>31/03/2026, unless reviewed earlier.&nbsp;</p>\n",
    "name": "Iran and neighbouring airspace",
    "status": "Withdrawn",
    "country": "",
    "coordinates": "",
    "updated": '<time datetime="2026-05-20T11:50:07+03:00">2026-05-20T11:50:07+0300</time>\n',
}

# An HTML entity and a trailing space, in a field that is not otherwise markup.
# Also: no valid_until at all, and no descriptive blob.
NORTH_KOREA = {
    "Nid": "22434",
    "issued_date": "2018-04-25T00:00:00+0300",
    "valid_until_date": "",
    "field_easa_valid_until_descr": "",
    "name": "Airspace of North Korea – Pyongyang Flight Information Region",
    "status": "Withdrawn",
    "country": "Democratic People&#039;s Republic of Korea ",
    "coordinates": "39.0392193, 125.7625241",
    "updated": '<time datetime="2025-02-21T17:24:34+02:00">2025-02-21T17:24:34+0200</time>\n',
}

RSS_FEED = """<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>Conflict Zones Advisories</title>
    <item>
      <title>Airspace of Ukraine</title>
      <link>https://www.easa.europa.eu/domains/air-operations/czibs/czib-2022-01r14</link>
      <pubDate>Thu, 24 Feb 2022 00:00:00 +0200</pubDate>
      <guid isPermaLink="false">136057 on Thu, 24 Feb 2022 00:00:00 +0200</guid>
    </item>
    <item>
      <title>Airspace of Pakistan</title>
      <link>https://www.easa.europa.eu/domains/air-operations/czibs/czib-2018-02r21</link>
      <guid isPermaLink="false">20587 on Wed, 10 Jan 2018 00:00:00 +0200</guid>
    </item>
    <item>
      <title>Airspace of Eastern Ukraine</title>
      <link>https://www.easa.europa.eu/domains/air-operations/czibs/sib-2014-21r1</link>
      <guid isPermaLink="false">20600 on Fri, 19 Feb 2016 00:00:00 +0200</guid>
    </item>
  </channel>
</rss>
"""


def payload(*rows) -> dict:
    return {"conflict_zones": list(rows)}


# --- a gazetteer to place against -------------------------------------------
#
# One real town per country, so a centroid is a number a test can name. The
# towns are deliberately not the cities EASA's `coordinates` field points at.

_TOWNS = [
    # (geonameid, name, ISO2, lat, lon, population)
    (1140026, "Herat", "AF", 34.34817, 62.19967, 272806),
    (703448, "Kyiv", "UA", 50.45466, 30.5238, 2797553),
    (1174872, "Quetta", "PK", 30.18414, 66.99647, 733675),
    (1871859, "Pyongyang", "KP", 39.03385, 125.75432, 3222000),
    (290030, "Dubai", "AE", 25.07725, 55.30927, 2502715),
    (290340, "Manama", "BH", 26.22787, 50.58565, 147074),
    (112931, "Tehran", "IR", 35.69439, 51.42151, 7153309),
    (98182, "Baghdad", "IQ", 33.34058, 44.40088, 5672513),
    (281184, "Jerusalem", "IL", 31.76904, 35.21633, 801000),
    (250441, "Amman", "JO", 31.95522, 35.94503, 1275857),
    (285787, "Kuwait City", "KW", 29.36972, 47.97833, 60064),
    (276781, "Beirut", "LB", 33.88894, 35.49442, 1916100),
    (287286, "Muscat", "OM", 23.58413, 58.40778, 797000),
    (290030 + 1, "Doha", "QA", 25.28545, 51.53096, 344939),
    (108410, "Riyadh", "SA", 24.68773, 46.72185, 4205961),
]


def _place(geonameid, name, country_code, lat, lon, population, **kw) -> gazetteer.Place:
    return gazetteer.Place(
        geonameid=geonameid,
        name=name,
        country_code=country_code,
        admin1=kw.get("admin1", "00"),
        admin2="",
        feature_class=kw.get("feature_class", "P"),
        feature_code=kw.get("feature_code", "PPLC"),
        population=population,
        lat=lat,
        lon=lon,
    )


def _index(extra: list[gazetteer.Place] | None = None) -> gazetteer.Gazetteer:
    return gazetteer.Gazetteer([_place(*t) for t in _TOWNS] + list(extra or []))


@pytest.fixture(autouse=True)
def gazetteer_loaded():
    """Install a small index for the duration of each test, then put it back.

    czib caches its centroids against the *identity* of the installed index, so
    swapping it here is exactly the event that invalidates the cache -- no
    private state has to be reset by hand.
    """
    previous = gazetteer.current()
    gazetteer.install(_index())
    yield
    gazetteer.install(previous)


@pytest.fixture(autouse=True)
def no_countries_layer(monkeypatch):
    """No boundaries layer, so the name crosswalk is exercised on its own.

    The Natural Earth fallback has its own test, which registers one.
    """
    monkeypatch.setattr(czib, "registry", SourceRegistry())
    monkeypatch.setattr(czib, "_ne_names", None)


def records_for(*rows, links=None):
    return czib.to_records(czib.parse_bulletins(payload(*rows)), links)


# --- the coordinate field ----------------------------------------------------


def test_the_publishers_coordinates_are_never_read():
    """Statically, so nobody can restore it in a refactor and pass the suite.

    `coordinates` is the CMS geocoding the country *name*. Fourteen of the
    thirty-three records carry one and every one of them is a city -- Kabul for
    Afghanistan, Karachi for a bulletin about Baluchistan and Khyber
    Pakhtunkhwa. There is no correct way to read this field, so the test is that
    the string never appears as a value the module could subscript by.
    """
    tree = ast.parse(CZIB_SOURCE.read_text(encoding="utf-8"))
    offenders = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and node.value == "coordinates"
    ]
    assert not offenders, (
        "czib.py reads the `coordinates` field. It is a geocode of the country "
        "name, not of the airspace -- see the module docstring."
    )


def test_a_bulletin_is_not_drawn_at_the_city_the_feed_names():
    (record,) = records_for(AFGHANISTAN)[0]
    assert (round(record["lat"], 5), round(record["lon"], 5)) == (34.34817, 62.19967)
    assert record["lon"] != 69.1776476  # Kabul, which is what the field says


def test_every_record_says_it_is_only_a_country(monkeypatch):
    records, _ = records_for(AFGHANISTAN, PAKISTAN, MIDDLE_EAST)
    assert {r["geo_precision"] for r in records} == {"country"}
    assert all(r["geo_radius_km"] > 0 for r in records)


# --- one bulletin, many countries -------------------------------------------


def test_an_eleven_country_bulletin_becomes_eleven_records():
    records, unplaced = records_for(MIDDLE_EAST)
    assert len(records) == 11
    assert unplaced == []
    assert {r["country_code"] for r in records} == {
        "BH", "IR", "IQ", "IL", "JO", "KW", "LB", "OM", "QA", "AE", "SA"
    }
    # Each pin carries the whole bulletin, not just its own share of it.
    assert all(r["country_count"] == 11 for r in records)
    assert all(len(r["bulletin_countries"]) == 11 for r in records)
    assert all(r["bulletin_id"] == "143294" for r in records)


def test_each_record_of_one_bulletin_gets_its_own_stable_id():
    records, _ = records_for(MIDDLE_EAST)
    ids = [r["id"] for r in records]
    assert len(set(ids)) == 11
    assert "czib:143294:IQ" in ids
    # Same input, same ids -- nothing is synthesised from a clock or a position.
    assert ids == [r["id"] for r in records_for(MIDDLE_EAST)[0]]


def test_a_bulletin_naming_no_country_is_reported_rather_than_dropped():
    """"Iran and neighbouring airspace" has an empty country field.

    The title names Iran and a title scraper would place it. It is not placed:
    the neighbours are unstated, and a rule that reads "Airspace of Kenya"
    correctly and this one wrongly is worse than no rule when the output is a
    pin. What it must not do is vanish, so it comes back in `unplaced`.
    """
    records, unplaced = records_for(IRAN_NEIGHBOURING)
    assert records == []
    assert unplaced == [
        {
            "nid": "143048",
            "name": "Iran and neighbouring airspace",
            "country": None,
            "reason": "no country named",
        }
    ]


def test_a_country_name_nothing_recognises_is_reported_not_swallowed():
    row = {**UKRAINE, "Nid": "999", "country": "Freedonia"}
    records, unplaced = records_for(row)
    assert records == []
    assert unplaced[0]["reason"] == "unknown country name"
    assert unplaced[0]["country"] == "Freedonia"


def test_a_country_with_no_gazetteer_places_is_reported_not_placed_at_zero():
    gazetteer.install(gazetteer.Gazetteer([]))
    records, unplaced = records_for(UKRAINE)
    assert records == []
    assert "UA" in unplaced[0]["reason"]


# --- the country crosswalk ---------------------------------------------------


def test_an_html_entity_and_a_trailing_space_still_resolve():
    """The live field is "Democratic People&#039;s Republic of Korea " -- an
    entity and a trailing space, in a plain text field."""
    (record,) = records_for(NORTH_KOREA)[0]
    assert record["country_code"] == "KP"
    assert record["country"] == "Democratic People's Republic of Korea"


def test_the_boundaries_layer_covers_a_country_the_table_has_never_seen(monkeypatch):
    """A new bulletin for a country nobody wrote a line for still places.

    countries.py already downloads Natural Earth every day, so its ADMIN ->
    ISO_A2 pairs are a free second opinion. Without it a first-ever bulletin for
    Niger would be a WARNING in a log nobody is reading.
    """
    registry = SourceRegistry()
    state = registry.register("countries", key_configured=True)
    state.data = {
        "type": "FeatureCollection",
        "features": [
            {"properties": {"name": "Niger", "iso_a2": "NE"}},
            # Natural Earth's own "no code" marker must not become a country.
            {"properties": {"name": "Somewhere", "iso_a2": "-99"}},
        ],
    }
    monkeypatch.setattr(czib, "registry", registry)
    monkeypatch.setattr(czib, "_ne_names", None)
    gazetteer.install(_index([_place(2440485, "Niamey", "NE", 13.51366, 2.1098, 774235)]))

    (record,) = records_for({**UKRAINE, "Nid": "998", "country": "Niger"})[0]
    assert record["country_code"] == "NE"
    assert czib.iso2_for("Somewhere") is None


# --- dates -------------------------------------------------------------------


def test_the_two_date_formats_in_one_record_are_parsed_separately():
    (bulletin,) = czib.parse_bulletins(payload(UKRAINE))
    # 2022-02-24T00:00:00+0200 -- ISO 8601 with a compact offset.
    assert bulletin["issued"] == 1645653600.0
    # 31/01/2027 -- day first, and a different format in the same record.
    assert bulletin["valid_until"] == 1801353600.0  # 2027-01-31T00:00:00Z
    assert bulletin["valid_until_text"] == "31/01/2027"


def test_a_day_first_date_is_not_read_month_first():
    """The failure this catches is silent for eleven months of the year."""
    (bulletin,) = czib.parse_bulletins(
        payload({**UKRAINE, "valid_until_date": "01/02/2027"})
    )
    from datetime import datetime, timezone

    assert datetime.fromtimestamp(bulletin["valid_until"], timezone.utc).month == 2


def test_a_missing_valid_until_is_none_rather_than_an_error():
    (bulletin,) = czib.parse_bulletins(payload(NORTH_KOREA))
    assert bulletin["valid_until"] is None
    assert bulletin["valid_until_text"] is None
    assert bulletin["valid_until_note"] is None


def test_updated_comes_from_the_time_elements_attribute_not_its_text():
    """`updated` is HTML. The attribute is the machine-readable value; the
    visible text is whatever the CMS template renders today."""
    row = {
        **UKRAINE,
        "updated": '<time datetime="2026-07-24T14:07:23+03:00">24 July 2026</time>\n',
    }
    (bulletin,) = czib.parse_bulletins(payload(row))
    assert bulletin["updated"] == 1784891243.0


def test_the_observation_time_is_the_last_thing_the_publisher_did():
    (record,) = records_for(UKRAINE)[0]
    assert record["time"] == record["updated"] == 1784891243.0


def test_nbsp_is_stripped_out_of_the_valid_until_prose():
    (bulletin,) = czib.parse_bulletins(payload(AFGHANISTAN))
    assert bulletin["valid_until_note"] == "31/01/2027, unless reviewed earlier."


# --- active vs withdrawn -----------------------------------------------------


def test_a_withdrawn_bulletin_cannot_be_mistaken_for_a_current_warning():
    """Three independent ways to filter it, because one is a single mistake."""
    (record,) = records_for(NORTH_KOREA)[0]
    assert record["kind"] == "czib_withdrawn"
    assert record["active"] is False
    assert record["severity"] == 0
    assert record["status"] == "Withdrawn"


def test_an_active_bulletin_is_high_but_not_critical():
    (record,) = records_for(UKRAINE)[0]
    assert record["kind"] == "czib"
    assert record["active"] is True
    assert record["severity"] == czib.ACTIVE_SEVERITY == 70
    assert record["severity_basis"] == "czib_status"


def test_withdrawn_bulletins_are_kept_but_sorted_behind_the_active_ones():
    records, _ = records_for(MIDDLE_EAST, UKRAINE, AFGHANISTAN)
    assert [r["active"] for r in records[:2]] == [True, True]
    assert len(records) == 13  # 2 active + the 11-country withdrawn bulletin


# --- the RSS join ------------------------------------------------------------


def test_the_feed_joins_on_the_guids_node_id_not_on_the_title():
    """Five live bulletins share the title "Airspace of Iran"; the guid's
    leading token is the same Nid the JSON is keyed on."""
    links = czib.parse_feed(RSS_FEED)
    assert set(links) == {"136057", "20587", "20600"}
    assert links["136057"]["url"].endswith("/czib-2022-01r14")


def test_the_bulletin_reference_comes_out_of_the_url_slug():
    links = czib.parse_feed(RSS_FEED)
    assert links["20587"]["reference"] == "CZIB-2018-02R21"
    # Not every document in the feed is a CZIB, and the slug is not tidied into
    # pretending otherwise.
    assert links["20600"]["reference"] == "SIB-2014-21R1"


def test_a_record_carries_the_publishers_own_identifiers():
    (record,) = records_for(UKRAINE, links=czib.parse_feed(RSS_FEED))[0]
    assert record["publisher"] == "EASA"
    assert record["bulletin_id"] == "136057"
    assert record["reference"] == "CZIB-2022-01R14"
    assert record["url"].endswith("/czib-2022-01r14")
    assert record["issued"] and record["valid_until"] and record["updated"]


def test_a_bulletin_the_feed_has_no_link_for_still_publishes():
    """The RSS half is fetched in its own try -- a feed outage must cost the
    reference and the deep link, not the bulletin."""
    (record,) = records_for(AFGHANISTAN, links={})[0]
    assert record["reference"] is None
    assert record["url"] == czib.INDEX_URL


# --- the parse itself --------------------------------------------------------


def test_a_record_with_no_node_id_is_skipped_rather_than_given_a_fake_one():
    assert czib.parse_bulletins(payload({**UKRAINE, "Nid": ""})) == []


def test_an_empty_or_absent_payload_is_not_an_error():
    assert czib.parse_bulletins({}) == []
    assert czib.parse_bulletins({"conflict_zones": []}) == []
    assert czib.to_records([]) == ([], [])


def test_malformed_feed_xml_raises_rather_than_returning_half_a_join():
    """The caller treats it as a failed feed fetch and publishes unreferenced;
    silently returning the items parsed before the break would attach the wrong
    bulletin numbers to whatever came after it."""
    from xml.etree import ElementTree

    with pytest.raises(ElementTree.ParseError):
        czib.parse_feed("<rss><channel><item><guid>1 on x</guid>")


# --- the country centroid ----------------------------------------------------


def test_administrative_divisions_do_not_get_a_vote_in_the_centroid():
    """The gazetteer index also holds ADM1/ADM2 rows whose population is the sum
    of their members'. Counting those weighs every town two or three extra times
    and drags the centre towards the most finely subdivided part of a country."""
    plain = czib.country_centroids()["UA"]
    gazetteer.install(
        _index([
            _place(
                694422, "Odes'ka Oblast'", "UA", 46.48, 30.72, 2380308,
                feature_class="A", feature_code="ADM1",
            )
        ])
    )
    assert czib.country_centroids()["UA"] == plain


def test_a_country_spanning_the_antimeridian_is_not_averaged_into_the_pacific():
    gazetteer.install(
        gazetteer.Gazetteer([
            _place(1, "West", "XX", 10.0, 179.0, 1000),
            _place(2, "East", "XX", 10.0, -179.0, 1000),
        ])
    )
    lat, lon = czib.country_centroids()["XX"]
    assert lat == pytest.approx(10.0)
    assert abs(lon) == pytest.approx(180.0, abs=1e-6)


def test_the_centroid_cache_follows_the_installed_index():
    first = czib.country_centroids()
    assert czib.country_centroids() is first  # same index, same object
    gazetteer.install(_index())
    assert czib.country_centroids() is not first
