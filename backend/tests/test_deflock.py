"""DeFlock ALPR parsing: coordinate order, OSM identity, and the two traps.

Two things about this feed are easy to get wrong in ways nothing would raise on:
the coordinate is GeoJSON [lon, lat] (read backwards, every US camera lands in
the Indian Ocean), and `osmTimestamp` is an OSM *edit* time rather than an
observation -- storing it as a plain `time` would dress an edit up as a sighting.
Both are pinned here, along with the way-type features that carry no point and
the worldwide (unclipped) retention the module's geography depends on.
"""

from backend.sources import deflock


def feature(
    osm_type="node",
    osm_id=31431226,
    coordinates=(-101.9201859, 35.1616409),
    geometry_type="Point",
    **props,
) -> dict:
    """One GeoJSON feature. `coordinates` is GeoJSON order: [lon, lat]."""
    base = {
        "operator": "Amarillo Police Department",
        "brand": "Flock Safety",
        "direction": 270,
        "surveillanceZone": "traffic",
        "mountType": "pole",
        "osmTimestamp": "2024-12-27T22:33:51Z",
        "osmVersion": 6,
    }
    base.update(props)
    base["osmType"] = osm_type
    base["osmId"] = osm_id
    geometry = {"type": geometry_type}
    if coordinates is not None:
        geometry["coordinates"] = list(coordinates)
    return {"type": "Feature", "geometry": geometry, "properties": base}


def collection(*features) -> dict:
    return {"type": "FeatureCollection", "features": list(features)}


def test_coordinates_are_lon_lat_in_that_order():
    (cam,) = deflock.parse_cameras(collection(feature()))
    # [lon, lat] in, lat/lon out -- swapping these is the silent Indian Ocean bug.
    assert (cam["lat"], cam["lon"]) == (35.1616409, -101.9201859)


def test_id_reuses_the_osm_scheme_so_it_cannot_collide_with_osm_infra():
    (cam,) = deflock.parse_cameras(collection(feature(osm_type="node", osm_id=42)))
    assert cam["id"] == "osm:node/42"
    assert cam["osm_type"] == "node"
    assert cam["osm_id"] == 42


def test_the_edit_time_is_named_as_one_never_as_an_observation():
    """osmTimestamp is when the OSM object was last edited, not when the camera
    was seen. It must land under osm_edited_at, and there must be no plain time
    field for a reader to mistake for a sighting."""
    (cam,) = deflock.parse_cameras(collection(feature()))
    assert cam["osm_edited_at"] == "2024-12-27T22:33:51Z"
    assert "time" not in cam
    assert "observed_at" not in cam


def test_the_documented_fields_are_carried_through():
    (cam,) = deflock.parse_cameras(collection(feature()))
    assert cam["brand"] == "Flock Safety"
    assert cam["direction_deg"] == 270
    assert cam["zone"] == "traffic"
    assert cam["mount"] == "pole"
    assert cam["osm_version"] == 6


def test_attribution_reaches_the_record():
    (cam,) = deflock.parse_cameras(collection(feature(osm_type="node", osm_id=7)))
    assert cam["source"] == "OpenStreetMap contributors (via DeFlock)"
    assert cam["licence"] == "ODbL"
    assert cam["source_url"] == "https://www.openstreetmap.org/node/7"


def test_a_missing_operator_is_left_none_not_faked():
    """Only ~17.6% of records carry an operator; the rest must not be backfilled."""
    (cam,) = deflock.parse_cameras(collection(feature(operator=None)))
    assert cam["operator"] is None


def test_a_way_type_feature_with_no_point_is_dropped_not_placed_at_null():
    """~18 features are ways (a line/area in OSM) with no coordinate of their own.
    Requiring a Point drops them rather than landing them at null island."""
    rows = deflock.parse_cameras(
        collection(
            feature(),  # a normal node, kept
            feature(osm_type="way", osm_id=999, geometry_type="LineString", coordinates=None),
            feature(osm_type="way", osm_id=1000, geometry_type="Point", coordinates=None),
        )
    )
    assert [r["id"] for r in rows] == ["osm:node/31431226"]


def test_data_is_retained_worldwide_with_no_theatre_clip():
    """The feed is 99.78% US and regions.py has no US theatre, so clipping would
    store zero. Parsing keeps every placed camera wherever it is."""
    rows = deflock.parse_cameras(
        collection(
            feature(osm_id=1, coordinates=(-101.92, 35.16)),   # Texas
            feature(osm_id=2, coordinates=(2.3522, 48.8566)),  # Paris
            feature(osm_id=3, coordinates=(151.2093, -33.8688)),  # Sydney
        )
    )
    assert {r["id"] for r in rows} == {"osm:node/1", "osm:node/2", "osm:node/3"}


def test_a_non_numeric_direction_is_dropped_rather_than_stored_as_a_bearing():
    """OSM's `direction` is occasionally a compass letter; direction_deg means
    degrees, so a value that is not a number is left out."""
    (cam,) = deflock.parse_cameras(collection(feature(direction="N")))
    assert cam["direction_deg"] is None


def test_a_feature_without_an_osm_identity_is_dropped():
    rows = deflock.parse_cameras(
        collection(
            feature(),
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [1.0, 2.0]},
             "properties": {"brand": "Flock Safety"}},  # no osmType/osmId
        )
    )
    assert [r["id"] for r in rows] == ["osm:node/31431226"]


def test_an_empty_or_absent_collection_is_not_an_error():
    assert deflock.parse_cameras({}) == []
    assert deflock.parse_cameras({"type": "FeatureCollection", "features": []}) == []
    assert deflock.parse_cameras(None) == []
