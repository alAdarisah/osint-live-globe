"""backend/sources/water_bodies.py -- parsing, id synthesis, class mapping,
bbox/area_deg2 (including the antimeridian wrap), and coordinate thinning.
No network: every fixture below is a hand-written FeatureCollection shaped
like the real Natural Earth files (property keys, ne_id presence/absence,
and featurecla vocabulary all confirmed against the live
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
        # The common case: named, and carries ne_id -- the live file has one
        # on every marine feature, so this is what most ids look like.
        {
            "type": "Feature",
            "properties": {
                "name": "Testonian Sea", "featurecla": "sea", "scalerank": 2, "ne_id": 1000001,
            },
            "geometry": {"type": "Polygon", "coordinates": [_CLOSED_SQUARE]},
        },
        # No name, but ne_id present -- native_id must use ne_id and never
        # reach the missing-name fallback path at all.
        {
            "type": "Feature",
            "properties": {"name": "", "featurecla": "gulf", "scalerank": 3, "ne_id": 1000002},
            "geometry": {"type": "Polygon", "coordinates": [
                [[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]
            ]},
        },
        # featurecla with no home in the shared enum -- must fall through to
        # "other" rather than being guessed at.
        {
            "type": "Feature",
            "properties": {"name": "Lagoonia", "featurecla": "lagoon", "scalerank": 4, "ne_id": 1000003},
            "geometry": {"type": "Polygon", "coordinates": [
                [[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]
            ]},
        },
        # An unclosed ring (no repeated first/last point) around a quad whose
        # closing edge is not degenerate -- see test_thinning_preserves_ring_
        # closure_and_therefore_the_area for why this specific shape matters.
        {
            "type": "Feature",
            "properties": {"name": "Quaddington", "featurecla": "bay", "scalerank": 1, "ne_id": 1000004},
            "geometry": {"type": "Polygon", "coordinates": [
                [[1, 1], [5, 1], [5, 4], [2, 5]]
            ]},
        },
        # No name AND no ne_id -- the live files never publish a marine
        # feature this bare, but native_id has to degrade rather than crash
        # if one ever shows up; exercises the fallback to feature_id.
        {
            "type": "Feature",
            "properties": {"name": "", "featurecla": "channel", "scalerank": 7},
            "geometry": {"type": "Polygon", "coordinates": [
                [[40, 40], [41, 40], [41, 41], [40, 41], [40, 40]]
            ]},
        },
        # A MultiPolygon split at the antimeridian, shaped like the real
        # Bering Sea / Chukchi Sea / Pacific features: one part just east of
        # the seam, one part just west of it (as raw longitude, "west" of
        # -180 wrapping to positive). See test_antimeridian_bbox_wraps_and_
        # is_flagged for the exact numbers this is built to produce.
        {
            "type": "Feature",
            "properties": {"name": "Dateline Sea", "featurecla": "strait", "scalerank": 5, "ne_id": 1000006},
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [[[170, 10], [179, 10], [179, 11], [170, 11], [170, 10]]],
                [[[-180, 10], [-175, 10], [-175, 11], [-180, 11], [-180, 10]]],
            ]},
        },
    ],
}

# A MultiPolygon of two disjoint pieces nowhere near the antimeridian, the
# way most of the 16 real MultiPolygon marine features look (Great Barrier
# Reef, Strait of Gibraltar, ...) -- must NOT be flagged, and its bbox must
# span both parts rather than wrap.
FIXTURE_MARINE_DISJOINT_MULTIPART = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Twin Squares", "featurecla": "sea", "scalerank": 3, "ne_id": 1000005},
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]],
                [[[25, 25], [26, 25], [26, 26], [25, 26], [25, 25]]],
            ]},
        },
    ],
}

# Two distinct features sharing one ne_id -- the real file's Great Barrier
# Reef case, minus the degenerate slivers that make the real duplicate not
# actually reach storage (see native_id's docstring). Both survive thinning
# here, so this is what proves the dedup guard actually works when a
# collision does land.
FIXTURE_MARINE_NE_ID_COLLISION = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"name": "Reef Alpha", "featurecla": "reef", "scalerank": 4, "ne_id": 5000001},
            "geometry": {"type": "Polygon", "coordinates": [
                [[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]
            ]},
        },
        {
            "type": "Feature",
            "properties": {"name": "Reef Beta", "featurecla": "reef", "scalerank": 4, "ne_id": 5000001},
            "geometry": {"type": "Polygon", "coordinates": [
                [[60, 60], [61, 60], [61, 61], [60, 61], [60, 60]]
            ]},
        },
    ],
}

FIXTURE_LAKES = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {
                "name": "Lake Test", "featurecla": "Lake", "scalerank": 2, "admin": "Testland",
                "ne_id": 2000001,
            },
            "geometry": {"type": "Polygon", "coordinates": [_CLOSED_SQUARE]},
        },
        # No name, and a featurecla that is not literally "Lake" -- the
        # reservoir->lake class mapping, plus proof ne_id is used regardless.
        {
            "type": "Feature",
            "properties": {
                "name": "", "featurecla": "Reservoir", "scalerank": 5, "admin": "Testland",
                "ne_id": 2000002,
            },
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
        # for the segment drawn through a lake a river flows into. Rivers
        # carries no ne_id at all (confirmed against the live file), so this
        # always goes through the positional scheme -- no ne_id key here is
        # deliberate, not an oversight.
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
    assert len(collection["features"]) == 6
    named = next(
        f for f in collection["features"] if f["properties"]["name"] == "Testonian Sea"
    )
    assert named["properties"]["class"] == "sea"
    assert named["properties"]["scalerank"] == 2
    # Marine features carry bbox/area_deg2/antimeridian; the other two
    # datasets do not.
    assert "bbox" in named["properties"]
    assert "area_deg2" in named["properties"]
    assert named["properties"]["antimeridian"] is False


def test_parse_lakes_and_rivers_do_not_carry_bbox_or_area():
    # bbox/area_deg2 exist only to rank nested marine polygons -- lakes and
    # river centrelines do not nest the way seas do, so they should not carry
    # fields that imply a ranking use they have no reason for.
    for feature in wb.parse_lakes(FIXTURE_LAKES)["features"]:
        assert "bbox" not in feature["properties"]
        assert "area_deg2" not in feature["properties"]
        assert "antimeridian" not in feature["properties"]
    for feature in wb.parse_rivers(FIXTURE_RIVERS)["features"]:
        assert "bbox" not in feature["properties"]
        assert "area_deg2" not in feature["properties"]
        assert "antimeridian" not in feature["properties"]


def test_parse_rivers_keeps_line_geometry():
    collection = wb.parse_rivers(FIXTURE_RIVERS)
    kinds = {f["geometry"]["type"] for f in collection["features"]}
    assert kinds == {"MultiLineString", "LineString"}


# --- id synthesis ------------------------------------------------------------


def test_marine_and_lake_ids_use_ne_id():
    """The common case for both datasets that carry Natural Earth's own id:
    every feature in the live files has one, so this is what almost every
    stored id looks like -- not the positional scheme."""
    marine = wb.parse_marine(FIXTURE_MARINE)
    named = next(f for f in marine["features"] if f["properties"]["name"] == "Testonian Sea")
    assert named["properties"]["id"] == "marine:1000001"

    lakes = wb.parse_lakes(FIXTURE_LAKES)
    named_lake = next(f for f in lakes["features"] if f["properties"]["name"] == "Lake Test")
    assert named_lake["properties"]["id"] == "lake:2000001"


def test_ne_id_based_ids_ignore_a_missing_name():
    """A marine/lakes feature missing `name` but carrying `ne_id` must still
    use ne_id -- not fall back to the featurecla+index scheme, which is only
    for the (currently theoretical) case where ne_id is also absent."""
    marine = wb.parse_marine(FIXTURE_MARINE)
    unnamed = next(f for f in marine["features"] if f["properties"]["featurecla"] == "gulf")
    assert unnamed["properties"]["id"] == "marine:1000002"

    lakes = wb.parse_lakes(FIXTURE_LAKES)
    reservoir = next(f for f in lakes["features"] if f["properties"]["featurecla"] == "Reservoir")
    assert reservoir["properties"]["id"] == "lake:2000002"


def test_native_id_falls_back_to_positional_scheme_without_ne_id():
    """The live marine/lakes files always carry ne_id, but id synthesis has
    to degrade rather than crash a poll if a future release ever omits it --
    same featurecla+running-index scheme rivers uses."""
    collection = wb.parse_marine(FIXTURE_MARINE)
    bare = next(f for f in collection["features"] if f["properties"]["featurecla"] == "channel")
    # Only one feature in this fixture takes the fallback path, so its
    # featurecla-derived running index starts at 1.
    assert bare["properties"]["id"] == "marine:7:channel-1"


def test_river_ids_use_the_positional_scheme():
    """rivers.geojson carries no ne_id at all (confirmed against the live
    file), so every river id is name/featurecla + scalerank, unlike marine
    and lakes."""
    collection = wb.parse_rivers(FIXTURE_RIVERS)
    named = next(f for f in collection["features"] if f["properties"]["name"] == "Test River")
    assert named["properties"]["id"] == "river:6:test-river"
    unnamed = next(f for f in collection["features"] if f["properties"]["name"] is None)
    assert unnamed["properties"]["id"] == "river:6:lake-centerline-1"


def test_duplicate_river_ids_are_suffixed_rather_than_collapsed():
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


def test_duplicate_ne_ids_are_suffixed_rather_than_collapsed():
    """The real file's Great Barrier Reef case: two distinct features
    published under one ne_id. Both survive here (unlike the real duplicate,
    where one is a sliver thinning discards -- see native_id's docstring),
    so this is what proves the guard works when a collision actually lands
    in the stored collection."""
    ids = [
        f["properties"]["id"]
        for f in wb.parse_marine(FIXTURE_MARINE_NE_ID_COLLISION)["features"]
    ]
    assert ids == ["marine:5000001", "marine:5000001#2"]


def test_ids_are_stable_across_two_runs():
    """A re-download of the same static file must produce the same ids, or
    every id in the layer would look "new" -- and reset any highlight or
    click state keyed on it -- on every weekly refresh even though nothing
    about the water actually changed."""
    first = [f["properties"]["id"] for f in wb.parse_marine(FIXTURE_MARINE)["features"]]
    second = [f["properties"]["id"] for f in wb.parse_marine(FIXTURE_MARINE)["features"]]
    assert first == second


# --- bbox / area_deg2 --------------------------------------------------------


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


def test_antimeridian_bbox_wraps_and_is_flagged():
    """Dateline Sea's two parts are a 9x1 rectangle just east of the seam
    (lon 170-179) and a 5x1 rectangle just west of it (lon -180 to -175). A
    flat min/max would report west=-180, east=179 -- nearly the whole globe.
    The wrapped bbox must instead read west=170 (the east part's own west
    edge) and east=-175 (the west part's own east edge), with west > east
    signalling the wrap, and area_deg2 must be the two rectangles' areas
    summed (9 + 5) rather than anything the wrap itself affects.
    """
    collection = wb.parse_marine(FIXTURE_MARINE)
    dateline = next(f for f in collection["features"] if f["properties"]["name"] == "Dateline Sea")
    props = dateline["properties"]
    assert props["antimeridian"] is True
    assert props["bbox"] == [10.0, 170.0, 11.0, -175.0]
    assert props["bbox"][1] > props["bbox"][3], "west > east is the wrap signal"
    assert props["area_deg2"] == 14.0


def test_disjoint_multipolygon_is_not_flagged_as_antimeridian():
    """Most real MultiPolygon marine features (Great Barrier Reef, Strait of
    Gibraltar, ...) are disjoint pieces nowhere near the seam, not a wrap --
    the flat bbox is already correct for them and must not be disturbed."""
    collection = wb.parse_marine(FIXTURE_MARINE_DISJOINT_MULTIPART)
    feature = collection["features"][0]
    props = feature["properties"]
    assert props["antimeridian"] is False
    assert props["bbox"] == [20.0, 20.0, 26.0, 26.0]
    assert props["bbox"][1] < props["bbox"][3], "not wrapped -- west stays less than east"
    assert props["area_deg2"] == 2.0
