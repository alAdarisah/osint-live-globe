"""Submarine cable and internet-outage parsing.

The cable half is mostly about coordinate order and about *not* joining the
segments of a MultiLineString: a cable split at the antimeridian, drawn as one
path, becomes a line straight across the map through everything else.
"""

from backend.sources import cables, outages


def cable_feature(
    cable_id="ion-cable-system-1-ics1",
    name="ION Cable System-1 (ICS1)",
    color="#939597",
    geometry=None,
) -> dict:
    return {
        "type": "Feature",
        "properties": {"id": cable_id, "name": name, "color": color},
        "geometry": geometry or {
            "type": "MultiLineString",
            "coordinates": [
                [[104.0166, 1.0668], [104.1496, 0.1526]],
                [[-179.5, 10.0], [179.5, 10.5]],
            ],
        },
    }


def landing_feature(landing_id="beculuk-indonesia", name="Beculuk, Indonesia", tbd=False) -> dict:
    return {
        "type": "Feature",
        "properties": {"id": landing_id, "name": name, "is_tbd": tbd},
        "geometry": {"type": "Point", "coordinates": [114.09706, -8.61563]},
    }


# --- cables ----------------------------------------------------------------


def test_coordinates_are_flipped_from_geojson_lon_lat_to_leaflet_lat_lon():
    (cable,) = cables.parse_cables({"features": [cable_feature()]})
    assert cable["paths"][0][0] == [1.0668, 104.0166]


def test_multilinestring_segments_stay_separate():
    """Joining them draws a line straight across the map: the second segment
    here is the same cable redrawn on the other side of the antimeridian."""
    (cable,) = cables.parse_cables({"features": [cable_feature()]})
    assert len(cable["paths"]) == 2


def test_a_plain_linestring_is_accepted_as_a_single_path():
    (cable,) = cables.parse_cables({"features": [cable_feature(
        geometry={"type": "LineString", "coordinates": [[10.0, 20.0], [11.0, 21.0]]}
    )]})
    assert cable["paths"] == [[[20.0, 10.0], [21.0, 11.0]]]


def test_the_publishers_own_colour_is_kept():
    (cable,) = cables.parse_cables({"features": [cable_feature()]})
    assert cable["color"] == "#939597"


def test_a_degenerate_or_unusable_geometry_is_dropped():
    rows = cables.parse_cables({"features": [
        cable_feature(cable_id="a", geometry={"type": "Point", "coordinates": [1, 2]}),
        cable_feature(cable_id="b", geometry={"type": "MultiLineString", "coordinates": [[[1.0, 2.0]]]}),
        cable_feature(cable_id="c"),
    ]})
    assert [c["id"] for c in rows] == ["c"]


def test_a_feature_without_an_id_is_dropped():
    feature = cable_feature()
    feature["properties"] = {"name": "Nameless"}
    assert cables.parse_cables({"features": [feature]}) == []


# --- landing points --------------------------------------------------------


def test_a_landing_point_keeps_its_position_and_name():
    (landing,) = cables.parse_landings({"features": [landing_feature()]})
    assert (landing["lat"], landing["lon"]) == (-8.61563, 114.09706)
    assert landing["name"] == "Beculuk, Indonesia"
    assert landing["planned"] is False


def test_a_planned_landing_is_kept_but_flagged():
    """"A cable is about to come ashore here" is worth knowing, but it must
    never be drawn as an existing facility."""
    (landing,) = cables.parse_landings({"features": [landing_feature(tbd=True)]})
    assert landing["planned"] is True


def test_an_empty_collection_is_not_an_error():
    assert cables.parse_cables({}) == []
    assert cables.parse_landings({"features": []}) == []


# --- IODA outages ----------------------------------------------------------


def ioda_row(code="SD", name="Sudan", overall=5_000_000.0, event_cnt=2, entity_type="country") -> dict:
    return {
        "scores": {"ping-slash24.median": 109595.9, "bgp.median": 41308.5, "overall": overall},
        "event_cnt": event_cnt,
        "entity": {"code": code, "name": name, "type": entity_type, "subnames": []},
    }


def test_outages_are_keyed_by_iso2_so_the_country_shapes_can_be_joined_without_names():
    parsed = outages.parse_outages({"data": [ioda_row()]}, 1.0, 2.0)
    assert list(parsed) == ["SD"]
    assert parsed["SD"]["country"] == "Sudan"
    assert parsed["SD"]["score"] == 5_000_000.0
    assert parsed["SD"]["event_count"] == 2


def test_the_individual_signals_are_kept_apart_from_the_composite():
    """A drop visible in BGP alone is a routing change; one visible in all
    three is the network genuinely going away."""
    parsed = outages.parse_outages({"data": [ioda_row()]}, 1.0, 2.0)
    assert parsed["SD"]["signals"] == {"ping-slash24.median": 109595.9, "bgp.median": 41308.5}
    assert "overall" not in parsed["SD"]["signals"]


def test_the_routine_long_tail_is_below_the_floor():
    assert outages.parse_outages({"data": [ioda_row(overall=1000.0)]}, 1.0, 2.0) == {}


def test_non_country_entities_are_ignored():
    assert outages.parse_outages({"data": [ioda_row(entity_type="region")]}, 1.0, 2.0) == {}


def test_a_row_without_a_usable_score_is_ignored():
    row = ioda_row()
    row["scores"] = {"bgp.median": 4.0}
    assert outages.parse_outages({"data": [row]}, 1.0, 2.0) == {}


def test_the_window_travels_with_every_record():
    """None of this is instantaneous -- it describes a period, and the popup has
    to be able to say which."""
    parsed = outages.parse_outages({"data": [ioda_row()]}, 100.0, 200.0)
    assert parsed["SD"]["window_start"] == 100.0
    assert parsed["SD"]["window_end"] == 200.0


def test_an_empty_or_absent_payload_is_not_an_error():
    assert outages.parse_outages({}, 1.0, 2.0) == {}
    assert outages.parse_outages({"data": []}, 1.0, 2.0) == {}
