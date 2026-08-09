"""backend/sources/water_bodies.py -- parsing, id synthesis, class mapping,
bbox/area_deg2, and coordinate thinning. No network: every fixture below is a
hand-written FeatureCollection shaped like the real Natural Earth files (see
the module docstring for the actual property keys, confirmed against the live
ne_10m_geography_marine_polys / ne_10m_lakes / ne_10m_rivers_lake_centerlines
downloads while building this module)."""

from backend.sources import water_bodies as wb

# A closed unit-ish square, scaled to 2 so 4.0 is unambiguously not 1.0 or a
# rounding artifact -- exercises _bbox_and_area on a shape whose answer can be
# checked by hand.
_CLOSED_SQUARE = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]

FIXTURE_MARINE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Testonian Sea", "featurecla": "sea", "scalerank": 2},
            "geometry": {"type": "Polygon", "coordinates": [_CLOSED_SQUARE]},
        },
        # No name -- exercises the missing-name id path (featurecla + a
        # running index, since scalerank and featurecla alone are not unique).
        {
            "type": "Feature",
            "properties": {"name": "", "featurecla": "gulf", "scalerank": 3},
            "geometry": {"type": "Polygon", "coordinates": [
                [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]
            ]},
        },
        # featurecla with no home in the shared enum -- must fall through to
        # "other" rather than being guessed at.
        {
            "type": "Feature",
            "properties": {"name": "Lagoonia", "featurecla": "lagoon", "scalerank": 4},
            "geometry": {"type": "Polygon", "coordinates": [
                [[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]
            ]},
        },
        # An unclosed ring (no repeated first/last point) around a quad whose
        # closing edge is not degenerate -- see test_thinning_preserves_ring_
        # closure_and_therefore_the_area for why this specific shape matters.
        {
            "type": "Feature",
            "properties": {"name": "Quaddington", "featurecla": "bay", "scalerank": 1},
            "geometry": {"type": "Polygon", "coordinates": [
                [[1, 1], [5, 1], [5, 4], [2, 5]]
            ]},
        },
    ],
}

FIXTURE_LAKES = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Lake Test", "featurecla": "Lake", "scalerank": 2, "admin": "Testland"},
            "geometry": {"type": "Polygon", "coordinates": [_CLOSED_SQUARE]},
        },
        # No name, and a featurecla that is not literally "Lake" -- both the
        # missing-name id path and the reservoir->lake class mapping.
        {
            "type": "Feature",
            "properties": {"name": "", "featurecla": "Reservoir", "scalerank": 5, "admin": "Testland"},
            "geometry": {"type": "Polygon", "coordinates": [
                [[30, 30], [31, 30], [31, 31], [30, 31], [30, 30]]
            ]},
        },
    ],
}

FIXTURE_RIVERS = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Test River", "featurecla": "River", "scalerank": 6},
            "geometry": {"type": "MultiLineString", "coordinates": [[[0, 0], [1, 1], [2, 2]]]},
        },
        # No name, plus the "Lake Centerline" featurecla rivers.geojson uses
        # for the segment drawn through a lake a river flows into.
        {
            "type": "Feature",
            "properties": {"name": "", "featurecla": "Lake Centerline", "scalerank": 6},
            "geometry": {"type": "LineString", "coordinates": [[5, 5], [6, 6]]},
        },
    ],
}


# --- class normalisation ----------------------------------------------------


def test_class_normalisation_covers_every_mapped_featurecla():
    # Marine values that are already the enum name, just re-cased to prove
    # the match is case-insensitive.
    for featurecla, expected in [
        ("Ocean", "ocean"), ("SEA", "sea"), ("Gulf", "gulf"), ("Bay", "bay"),
        ("Strait", "strait"), ("Channel", "channel"), ("Sound", "sound"),
    ]:
        assert wb.normalise_class(featurecla) == expected
    # The two lakes.geojson values that are not literally "Lake".
    assert wb.normalise_class("Lake") == "lake"
    assert wb.normalise_class("Reservoir") == "lake"
    assert wb.normalise_class("Alkaline Lake") == "lake"
    # rivers.geojson's two values.
    assert wb.normalise_class("River") == "river"
    assert wb.normalise_class("Lake Centerline") == "river"


def test_class_normalisation_falls_through_to_other():
    # Real marine featurecla values with no home in the shared enum -- not
    # guessed at, just bucketed.
    for featurecla in ("generic", "lagoon", "fjord", "reef", "inlet"):
        assert wb.normalise_class(featurecla) == "other"
    assert wb.normalise_class(None) == "other"
    assert wb.normalise_class("") == "other"


# --- parsing -----------------------------------------------------------------


def test_parse_marine_fixture():
    collection = wb.parse_marine(FIXTURE_MARINE)
    assert collection["type"] == "FeatureCollection"
    assert len(collection["features"]) == 4
    named = next(
        f for f in collection["features"] if f["properties"]["name"] == "Testonian Sea"
    )
    assert named["properties"]["class"] == "sea"
    assert named["properties"]["scalerank"] == 2
    # Marine features carry bbox/area_deg2; the other two datasets do not.
    assert "bbox" in named["properties"]
    assert "area_deg2" in named["properties"]


def test_parse_lakes_and_rivers_do_not_carry_bbox_or_area():
    # bbox/area_deg2 exist only to rank nested marine polygons -- lakes and
    # river centrelines do not nest the way seas do, so they should not carry
    # fields that imply a ranking use they have no reason for.
    for feature in wb.parse_lakes(FIXTURE_LAKES)["features"]:
        assert "bbox" not in feature["properties"]
        assert "area_deg2" not in feature["properties"]
    for feature in wb.parse_rivers(FIXTURE_RIVERS)["features"]:
        assert "bbox" not in feature["properties"]
        assert "area_deg2" not in feature["properties"]


def test_parse_rivers_keeps_line_geometry():
    collection = wb.parse_rivers(FIXTURE_RIVERS)
    kinds = {f["geometry"]["type"] for f in collection["features"]}
    assert kinds == {"MultiLineString", "LineString"}


# --- id synthesis --------------------------------------------------------


def test_id_synthesis_named_feature():
    collection = wb.parse_marine(FIXTURE_MARINE)
    named = next(
        f for f in collection["features"] if f["properties"]["name"] == "Testonian Sea"
    )
    assert named["properties"]["id"] == "marine:2:testonian-sea"


def test_id_synthesis_missing_name_uses_featurecla_and_a_running_index():
    collection = wb.parse_marine(FIXTURE_MARINE)
    unnamed = next(f for f in collection["features"] if f["properties"]["name"] is None)
    # Only one unnamed feature in this fixture, so the running index starts
    # at 1 -- featurecla "gulf" slugged, plus that index.
    assert unnamed["properties"]["id"] == "marine:3:gulf-1"


def test_id_synthesis_uses_the_dataset_prefix():
    lake_ids = [f["properties"]["id"] for f in wb.parse_lakes(FIXTURE_LAKES)["features"]]
    river_ids = [f["properties"]["id"] for f in wb.parse_rivers(FIXTURE_RIVERS)["features"]]
    assert all(i.startswith("lake:") for i in lake_ids)
    assert all(i.startswith("river:") for i in river_ids)
    # The unnamed reservoir gets the same featurecla+index treatment marine
    # does, under the lake: prefix.
    assert "lake:5:reservoir-1" in lake_ids


def test_duplicate_ids_are_suffixed_rather_than_collapsed():
    """Real Natural Earth data collides on name+scalerank: two same-named
    same-scalerank rivers.geojson segments for one watercourse (a "River" and
    the "Lake Centerline" piece where it crosses a lake) is the common case,
    at 243 pairs. Both features must survive with distinct ids, not silently
    overwrite each other under one id."""
    fixture = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": "Vorma", "featurecla": "River", "scalerank": 9},
                "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]},
            },
            {
                "type": "Feature",
                "properties": {"name": "Vorma", "featurecla": "Lake Centerline", "scalerank": 9},
                "geometry": {"type": "LineString", "coordinates": [[1, 1], [2, 2]]},
            },
        ],
    }
    ids = [f["properties"]["id"] for f in wb.parse_rivers(fixture)["features"]]
    assert ids == ["river:9:vorma", "river:9:vorma#2"]
    assert len(set(ids)) == 2


def test_ids_are_stable_across_two_runs():
    """A re-download of the same static file must produce the same ids, or
    every id in the layer would look "new" -- and reset any highlight or
    click state keyed on it -- on every weekly refresh even though nothing
    about the water actually changed."""
    first = [f["properties"]["id"] for f in wb.parse_marine(FIXTURE_MARINE)["features"]]
    second = [f["properties"]["id"] for f in wb.parse_marine(FIXTURE_MARINE)["features"]]
    assert first == second


# --- bbox / area_deg2 ------------------------------------------------------


def test_bbox_and_area_on_a_known_square():
    collection = wb.parse_marine(FIXTURE_MARINE)
    square = next(
        f for f in collection["features"] if f["properties"]["name"] == "Testonian Sea"
    )
    # south, west, north, east
    assert square["properties"]["bbox"] == [0.0, 0.0, 2.0, 2.0]
    # A 2x2 square is 4 square degrees by the shoelace formula -- not a real
    # area, just arithmetic this test can check by hand.
    assert square["properties"]["area_deg2"] == 4.0


def test_thinning_preserves_ring_closure_and_therefore_the_area():
    """Quaddington's fixture ring is deliberately unclosed (no point repeats
    the first). If thin_geometry did not force the ring shut before area_deg2
    is computed, the shoelace sum would silently drop the closing edge and
    under-report the area -- for this exact quad, 14.0 square degrees instead
    of the correct 12.5. The stored geometry closing is what makes the area
    right, not incidental to it.
    """
    collection = wb.parse_marine(FIXTURE_MARINE)
    quad = next(f for f in collection["features"] if f["properties"]["name"] == "Quaddington")
    ring = quad["geometry"]["coordinates"][0]
    assert ring[0] == ring[-1], "thin_geometry must close a ring that arrived open"
    assert quad["properties"]["bbox"] == [1.0, 1.0, 5.0, 5.0]
    assert quad["properties"]["area_deg2"] == 12.5
