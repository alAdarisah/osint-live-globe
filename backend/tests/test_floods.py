"""GDACS flood parsing: the fields that are blank, the id that must not grow.

Four real events, trimmed from the live SEARCH response on 2026-08-06. They are
kept as they arrived rather than tidied, because the untidy parts are the point:
`eventname` and `glide` are empty strings rather than absent, `iscurrent` and
`istemporary` are the *strings* "true"/"false" rather than booleans, timestamps
carry no offset, and one event spans two countries while the flat `iso3` field
names only the first.
"""

from datetime import datetime, timezone

from backend.sources import floods, hazards


def feature(**overrides) -> dict:
    """Thailand, Green, still open. The plainest record in the feed."""
    props = {
        "eventtype": "FL",
        "eventid": 1104067,
        "episodeid": 3,
        "eventname": "",
        "glide": "",
        "name": "Flood in Thailand",
        "description": "Flood in Thailand",
        "url": {
            "geometry": "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=FL&eventid=1104067&episodeid=3",
            "report": "https://www.gdacs.org/report.aspx?eventid=1104067&episodeid=3&eventtype=FL",
            "details": "https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=FL&eventid=1104067",
        },
        "alertlevel": "Green",
        "alertscore": 1,
        "episodealertlevel": "Green",
        "episodealertscore": 0.5,
        "istemporary": "false",
        "iscurrent": "true",
        "country": "Thailand",
        "fromdate": "2026-07-30T01:00:00",
        "todate": "2026-08-05T01:00:00",
        "datemodified": "2026-08-06T07:30:19",
        "iso3": "THA",
        "source": "GLOFAS",
        "sourceid": "",
        "polygonlabel": "Centroid",
        "Class": "Point_Centroid",
        "affectedcountries": [{"iso2": "TH", "iso3": "THA", "countryname": "Thailand"}],
        "severitydata": {"severity": 0.0, "severitytext": "Magnitude 0 ", "severityunit": ""},
    }
    props.update(overrides.pop("properties", {}))
    out = {
        "type": "Feature",
        "bbox": [103.9731, 17.1904, 103.9731, 17.1904],
        "geometry": {"type": "Point", "coordinates": [103.9731, 17.1904]},
        "properties": props,
    }
    out.update(overrides)
    return out


# China, Red, closed. The one record in 100 that carried the top alert level.
RED = feature(
    geometry={"type": "Point", "coordinates": [109.3013, 35.5896]},
    properties={
        "eventid": 1104051,
        "episodeid": 5,
        "glide": "FL-2026-000136-CHN",
        "name": "Flood in China",
        "description": "Flood in China",
        "alertlevel": "Red",
        "alertscore": 3,
        "iscurrent": "false",
        "country": "China",
        "iso3": "CHN",
        "fromdate": "2026-07-25T01:00:00",
        "todate": "2026-08-02T01:00:00",
        "datemodified": "2026-08-03T12:02:11",
        "affectedcountries": [{"iso2": "CN", "iso3": "CHN", "countryname": "China"}],
    },
)

# China, Orange, closed, and on its eighteenth episode.
ORANGE = feature(
    geometry={"type": "Point", "coordinates": [103.2791, 35.7003]},
    properties={
        "eventid": 1103933,
        "episodeid": 18,
        "glide": "FL-2026-000105-CHN",
        "name": "Flood in China",
        "alertlevel": "Orange",
        "alertscore": 2,
        "iscurrent": "false",
        "country": "China",
        "iso3": "CHN",
        "fromdate": "2026-06-06T01:00:00",
        "todate": "2026-07-14T01:00:00",
        "datemodified": "2026-08-06T12:14:20",
        "affectedcountries": [{"iso2": "CN", "iso3": "CHN", "countryname": "China"}],
    },
)

# One flood, two countries. `country` is a joined string and `iso3` is only the
# first of them.
CROSS_BORDER = feature(
    geometry={"type": "Point", "coordinates": [34.0051, 44.406]},
    properties={
        "eventid": 1104048,
        "episodeid": 1,
        "name": "Flood in Russia, Ukraine",
        "country": "Russia, Ukraine",
        "iso3": "RUS",
        "iscurrent": "false",
        "fromdate": "2026-07-23T01:00:00",
        "todate": "2026-07-24T01:00:00",
        "datemodified": "2026-07-24T12:00:38",
        "affectedcountries": [
            {"iso2": "RU", "iso3": "RUS", "countryname": "Russia"},
            {"iso2": "UA", "iso3": "UKR", "countryname": "Ukraine"},
        ],
    },
)


def collection(*features: dict) -> dict:
    return {"type": "FeatureCollection", "features": list(features or (feature(),))}


def one(*features: dict) -> dict:
    (row,) = floods.parse_floods(collection(*features))
    return row


# --- position ---------------------------------------------------------------


def test_geojson_coordinates_are_longitude_then_latitude():
    row = one()
    assert (row["lat"], row["lon"]) == (17.1904, 103.9731)


def test_a_gdacs_point_is_never_labelled_a_locality():
    """It is the centroid of an affected basin, and GDACS says so itself in
    `polygonlabel`. "region" puts it in the map's imprecise bucket, which draws
    the uncertainty ring a modelled centroid has earned."""
    row = one()
    assert row["geo_precision"] == "region"
    assert row["polygon_label"] == "Centroid"


def test_an_event_without_a_usable_position_is_dropped_not_placed_at_null_island():
    rows = floods.parse_floods(
        collection(
            feature(geometry={"type": "Point", "coordinates": []}),
            feature(geometry={"type": "Point", "coordinates": ["x", "y"]}),
            feature(),
        )
    )
    assert len(rows) == 1


# --- identity ---------------------------------------------------------------


def test_the_id_is_event_level_and_carries_no_episode():
    """GDACS revises an event by publishing a new episode. Keying on the
    episode would draw eighteen pins for the flood below instead of updating
    one, and fill entity_history with the publisher's edits."""
    row = one(ORANGE)
    assert row["id"] == "gdacs:FL:1103933"
    assert "18" not in row["id"]
    assert row["episode"] == 18
    assert row["event_id"] == "1103933"


def test_the_hazard_type_is_in_the_id_because_eventids_are_numbered_per_type():
    row = one()
    assert row["id"].startswith("gdacs:FL:")


def test_an_event_with_no_publisher_id_is_dropped_rather_than_given_one():
    """A synthesised id cannot be matched on the next poll, so it would add a
    duplicate pin every thirty minutes instead of updating in place."""
    assert floods.parse_floods(collection(feature(properties={"eventid": None}))) == []


# --- severity ---------------------------------------------------------------


def test_alert_level_maps_onto_the_shared_severity_scale():
    assert one(RED)["severity"] == 95
    assert one(ORANGE)["severity"] == 80
    assert one()["severity"] == 35
    assert one(RED)["severity_basis"] == "gdacs_alertlevel"


def test_a_red_flood_and_a_red_earthquake_draw_at_the_same_weight():
    """The two modules are separate on purpose, but the numbers are one scale.
    If a future edit retunes one of these tables, a reader comparing a red
    flood against a red quake would be reading two different claims -- so the
    agreement is pinned here rather than left to a comment in each file."""
    for level in ("red", "orange", "green"):
        assert floods._ALERT_SEVERITY[level] == hazards._PAGER_SEVERITY[level]


def test_an_unrated_event_scores_zero_rather_than_borrowing_the_alertscore():
    """`alertscore` is GDACS's own finer number on its own scale. Deriving a
    0-100 from it would be a claim GDACS has not made."""
    row = one(feature(properties={"alertlevel": "", "alertscore": 3}))
    assert row["severity"] == 0
    assert row["alert_score"] == 3


def test_the_alertscore_is_carried_not_mapped():
    row = one(RED)
    assert row["alert_score"] == 3
    assert row["alert_level"] == "Red"
    assert row["episode_alert_score"] == 0.5


def test_gdacs_own_zero_valued_flood_magnitude_is_not_carried_as_a_second_severity():
    """`severitydata.severity` is 0.0 on every flood. A second field named
    severity sitting next to the map's 0-100 one reads as contradicting it."""
    row = one(RED)
    assert row["severity"] == 95
    assert "severitydata" not in row
    assert "severitytext" not in row


# --- blank fields -----------------------------------------------------------


def test_a_blank_eventname_falls_back_to_the_generated_name():
    """`eventname` was empty on all 100 events in the sample. An empty string
    reaching the popup renders as a present-but-nameless field."""
    row = one()
    assert row["name"] == "Flood in Thailand"


def test_a_named_event_keeps_its_own_name():
    row = one(feature(properties={"eventname": "Chao Phraya basin flooding"}))
    assert row["name"] == "Chao Phraya basin flooding"


def test_an_event_with_neither_name_still_gets_one():
    row = one(feature(properties={"eventname": "", "name": ""}))
    assert row["name"] == "Flood 1104067"


def test_a_blank_glide_becomes_none_and_a_real_one_survives():
    assert one()["glide"] is None
    assert one(RED)["glide"] == "FL-2026-000136-CHN"


# --- time -------------------------------------------------------------------


def test_naive_timestamps_are_read_as_utc_not_as_host_local_time():
    """GDACS sends no offset. Read as local time, every flood on the map would
    shift by whatever the deployment host's zone happens to be -- so this reads
    the epoch seconds back as UTC and checks the wall clock survived, which is
    a claim the host's own zone cannot make true by accident."""
    row = one()
    assert datetime.fromtimestamp(row["time"], timezone.utc).isoformat() == "2026-07-30T01:00:00+00:00"
    assert row["time"] == 1_785_373_200.0
    assert row["from_time"] == row["time"]
    assert row["to_time"] == 1_785_891_600.0  # 2026-08-05T01:00:00Z


def test_the_event_time_and_the_revision_time_are_kept_apart():
    """`time` is when the flood began; `updated` is when GDACS last changed its
    mind about it. The Orange event below started in June and was revised
    today -- one number cannot say both."""
    row = one(ORANGE)
    assert row["time"] < row["updated"]
    assert row["updated"] == 1_786_018_460.0  # 2026-08-06T12:14:20Z


def test_an_unparseable_timestamp_leaves_the_field_empty_rather_than_the_record():
    row = one(feature(properties={"todate": "not a date", "datemodified": ""}))
    assert row["to_time"] is None
    assert row["updated"] is None
    assert row["time"] is not None


# --- countries --------------------------------------------------------------


def test_a_cross_border_flood_keeps_every_country_code_not_just_the_first():
    """The flat `iso3` names only Russia. A country-scoped panel or a downstream
    adjacency check asking "is this in Ukraine" would answer no."""
    row = one(CROSS_BORDER)
    assert row["affected_iso3"] == ["RUS", "UKR"]
    assert row["iso3"] == "RUS"
    assert row["country"] == "Russia, Ukraine"


def test_a_malformed_affectedcountries_entry_does_not_take_the_record_down():
    row = one(
        feature(properties={"affectedcountries": [None, "THA", {"iso3": ""}, {"iso3": "THA"}]})
    )
    assert row["affected_iso3"] == ["THA"]


# --- publisher's own flags --------------------------------------------------


def test_iscurrent_is_the_string_true_not_the_boolean():
    assert one()["is_current"] is True
    assert one(RED)["is_current"] is False
    assert one()["is_temporary"] is False


def test_closed_events_are_published_rather_than_dropped():
    """Most of the list is closed at any moment. Thinning that is a decision for
    the presentation; the replay timeline and the dam-adjacency check both want
    the rows."""
    rows = floods.parse_floods(collection(feature(), RED, ORANGE, CROSS_BORDER))
    assert len(rows) == 4
    assert sum(1 for r in rows if r["is_current"]) == 1


def test_open_events_sort_above_closed_ones_whatever_their_alert_level():
    """Severity alone would put a Red that ended in July above a flood happening
    today, which is the wrong answer for a "what is happening now" layer."""
    rows = floods.parse_floods(collection(RED, ORANGE, feature(), CROSS_BORDER))
    assert rows[0]["id"] == "gdacs:FL:1104067"  # the only open one, and only Green
    assert [r["id"] for r in rows[1:]] == [
        "gdacs:FL:1104051",  # Red
        "gdacs:FL:1103933",  # Orange
        "gdacs:FL:1104048",  # Green
    ]


# --- links and provenance ---------------------------------------------------


def test_the_footprint_polygon_is_linked_rather_than_fetched():
    """One request per event would be ~100 extra requests per poll for geometry
    nothing draws yet."""
    row = one()
    assert "getgeometry" in row["footprint_url"]
    assert "report.aspx" in row["url"]


def test_a_record_missing_its_url_block_still_parses():
    row = one(feature(properties={"url": None}))
    assert row["url"] is None
    assert row["footprint_url"] is None


def test_every_record_names_its_publisher_and_the_model_behind_the_alert():
    rows = floods.parse_floods(collection(feature(), RED))
    assert {r["publisher"] for r in rows} == {"GDACS (European Commission JRC / UN)"}
    assert {r["model_source"] for r in rows} == {"GLOFAS"}
    assert {r["kind"] for r in rows} == {"flood"}


def test_an_empty_or_absent_feed_is_not_an_error():
    assert floods.parse_floods({}) == []
    assert floods.parse_floods({"features": []}) == []
    assert floods.parse_floods(None) == []
