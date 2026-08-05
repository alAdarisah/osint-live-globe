"""Hazard parsing: the two feeds' field positions, and what happens without one.

Both publishers put their coordinate somewhere unusual -- USGS in the third
GeoJSON ordinate (which is depth, not elevation) and GVP in a `georss:point`
whose axis order is lat-then-lon. Neither raises when read wrongly, they just
put a pin in the sea, so both are pinned here.
"""

from xml.etree import ElementTree

import pytest

from backend.sources import hazards


def quake_feature(**overrides) -> dict:
    feature = {
        "id": "us7000abcd",
        "geometry": {"type": "Point", "coordinates": [30.5238, 50.45466, 12.4]},
        "properties": {
            "mag": 5.4,
            "place": "20 km NE of Somewhere",
            "time": 1_785_000_000_000,
            "alert": None,
            "tsunami": 0,
            "felt": 812,
            "sig": 448,
            "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
        },
    }
    feature["properties"].update(overrides.pop("properties", {}))
    feature.update(overrides)
    return feature


def gvp_feed(*items: str) -> bytes:
    body = (
        '<?xml version="1.0" encoding="ISO-8859-1"?>'
        '<rss version="2.0" xmlns:georss="http://www.georss.org/georss">'
        "<channel><title>Weekly Volcanic Activity Report</title>"
        + "".join(items)
        + "</channel></rss>"
    )
    return body.encode("utf-8")


def gvp_item(
    title="Etna (Italy) - Report for 23 July-29 July 2026 - New Eruptive Activity",
    point="37.7480 14.9990",
    guid="https://volcano.si.edu/reports_weekly.cfm#vn_211060",
    description="&lt;p&gt;Eruptive activity at the summit craters.&lt;/p&gt;",
) -> str:
    coordinate = f"<georss:point>{point}</georss:point>" if point else ""
    return (
        f"<item><title>{title}</title>"
        f"<description>{description}</description>"
        f'<guid isPermaLink="true">{guid}</guid>'
        "<pubDate>Thu, 30 Jul 2026 04:15:07 -0400</pubDate>"
        f"{coordinate}</item>"
    )


# --- USGS ------------------------------------------------------------------


def test_geojson_coordinates_are_lon_lat_depth_in_that_order():
    (quake,) = hazards.parse_earthquakes({"features": [quake_feature()]})
    assert (quake["lat"], quake["lon"]) == (50.45466, 30.5238)
    assert quake["depth_km"] == 12.4


def test_usgs_millisecond_timestamps_become_seconds():
    (quake,) = hazards.parse_earthquakes({"features": [quake_feature()]})
    assert quake["time"] == 1_785_000_000.0


def test_pager_alert_outranks_magnitude_for_severity():
    """PAGER estimates impact; magnitude only estimates energy. A shallow M5.4
    under a city is the more dangerous event and has to draw as one."""
    (plain,) = hazards.parse_earthquakes({"features": [quake_feature()]})
    (alerted,) = hazards.parse_earthquakes(
        {"features": [quake_feature(properties={"alert": "red"})]}
    )
    assert plain["severity_basis"] == "magnitude"
    assert alerted["severity_basis"] == "pager"
    assert alerted["severity"] == 95
    assert alerted["severity"] > plain["severity"]


def test_magnitude_severity_spans_the_scale_without_escaping_it():
    def severity(mag):
        (row,) = hazards.parse_earthquakes(
            {"features": [quake_feature(properties={"mag": mag})]}
        )
        return row["severity"]

    assert severity(2.5) == 0
    assert 0 < severity(5.0) < 100
    # Above the M8 top of the ramp, the score clamps instead of running past 100
    # and out of the frontend's severity bands.
    assert severity(9.5) == 100


def test_a_feature_without_a_position_is_dropped_not_placed_at_null_island():
    rows = hazards.parse_earthquakes(
        {
            "features": [
                quake_feature(geometry={"coordinates": []}),
                quake_feature(geometry={"coordinates": ["x", "y", "z"]}),
                quake_feature(),
            ]
        }
    )
    assert len(rows) == 1


def test_a_feature_missing_depth_or_magnitude_still_renders():
    (row,) = hazards.parse_earthquakes(
        {"features": [quake_feature(geometry={"coordinates": [10.0, 20.0]}, properties={"mag": None})]}
    )
    assert row["depth_km"] is None
    assert row["magnitude"] is None
    assert row["severity"] == 0


def test_output_is_ordered_most_severe_first():
    rows = hazards.parse_earthquakes(
        {
            "features": [
                quake_feature(id="small", properties={"mag": 2.6}),
                quake_feature(id="big", properties={"mag": 7.8}),
            ]
        }
    )
    assert [r["id"] for r in rows] == ["usgs:big", "usgs:small"]


def test_an_empty_or_absent_feed_is_not_an_error():
    assert hazards.parse_earthquakes({}) == []
    assert hazards.parse_earthquakes({"features": []}) == []


# --- Smithsonian GVP -------------------------------------------------------


def test_georss_point_is_latitude_then_longitude():
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item()))
    assert (volcano["lat"], volcano["lon"]) == (37.7480, 14.9990)


def test_the_title_splits_into_volcano_country_period_and_headline():
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item()))
    assert volcano["name"] == "Etna"
    assert volcano["country"] == "Italy"
    assert volcano["report_period"] == "23 July-29 July 2026"
    assert volcano["headline"] == "New Eruptive Activity"


def test_the_id_comes_from_the_stable_gvp_volcano_number():
    """The link is the same weekly-report URL for every item, so the guid's
    `#vn_` fragment is the only per-volcano identifier the feed carries."""
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item()))
    assert volcano["id"] == "gvp:211060"
    assert volcano["volcano_number"] == "211060"


def test_new_activity_outranks_ongoing_activity():
    (new,) = hazards.parse_volcanoes(gvp_feed(gvp_item()))
    (ongoing,) = hazards.parse_volcanoes(
        gvp_feed(gvp_item(title="Krakatau (Indonesia) - Report for 23 July-29 July 2026 - Ongoing Activity"))
    )
    assert new["severity"] > ongoing["severity"]
    assert new["severity_basis"] == "gvp_report_type"


def test_an_item_without_a_coordinate_is_dropped_when_nothing_can_place_it():
    """The gazetteer is built from populated places, so a volcano name usually
    misses. A miss must drop the report rather than place it somewhere."""
    rows = hazards.parse_volcanoes(gvp_feed(gvp_item(point="")))
    assert rows == []


def test_a_gazetteer_placed_item_is_marked_as_the_weaker_evidence(monkeypatch):
    class _Place:
        lat, lon = 1.5, 2.5

    class _Candidate:
        place = _Place()

    monkeypatch.setattr(hazards.gazetteer, "resolve", lambda *a, **k: [_Candidate()])
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item(point="")))
    assert (volcano["lat"], volcano["lon"]) == (1.5, 2.5)
    assert volcano["geo_precision"] == "region"


def test_description_html_is_unescaped_and_stripped():
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item()))
    assert volcano["summary"] == "Eruptive activity at the summit craters."


def test_the_feed_is_decoded_as_windows_1252_not_the_iso_8859_1_it_claims():
    """GVP's prose is full of curly apostrophes sent as 0x92. Trusting the
    declaration maps those to a C1 control character, which is what turned
    every summary into "Etna?s summit craters"."""
    body = (
        '<?xml version="1.0" encoding="ISO-8859-1"?>'
        '<rss version="2.0" xmlns:georss="http://www.georss.org/georss"><channel>'
        # Encoded to cp1252 below, so these become the raw 0x92/0x96 bytes GVP
        # actually sends.
        + gvp_item(description="Etna’s summit craters, 20–26 July.")
        + "</channel></rss>"
    ).encode("cp1252")
    (volcano,) = hazards.parse_volcanoes(body)
    assert volcano["summary"] == "Etna’s summit craters, 20–26 July."


def test_a_title_that_does_not_match_the_house_format_still_yields_a_record():
    (volcano,) = hazards.parse_volcanoes(gvp_feed(gvp_item(title="Something unexpected")))
    assert volcano["name"] == "Something unexpected"
    assert volcano["country"] is None
    # No "New" prefix to read, so it takes the lower of the two scores rather
    # than guessing.
    assert volcano["severity"] == 45


def test_malformed_xml_raises_rather_than_returning_a_half_feed():
    """The caller treats an exception as a failed poll and keeps the previous
    copy; silently returning the items parsed before the break would publish a
    truncated report as if it were complete."""
    with pytest.raises(ElementTree.ParseError):
        hazards.parse_volcanoes(b"<rss><channel><item><title>x</title>")


# --- both ------------------------------------------------------------------


def test_every_record_names_its_publisher_and_kind():
    rows = hazards.parse_earthquakes({"features": [quake_feature()]}) + hazards.parse_volcanoes(
        gvp_feed(gvp_item())
    )
    assert {r["kind"] for r in rows} == {"earthquake", "volcano"}
    assert all(r["publisher"] for r in rows)
    assert all(r["url"] for r in rows)
