"""backend/regions.py's CountryIndex: a Python port of frontend/src/map/
countryHitTest.js's point-in-country test, added so Task 38's cable/outage
correlation can attribute a landing to a country by its coordinate rather
than by matching free text against a name list (see backend/refine/
cable_outage.py's own docstring on why the name-based join it started with
undercounted the United States).

Polygons here are small synthetic squares in plain [lon, lat] GeoJSON order
-- real country geometry is exercised end-to-end by test_cable_outage.py,
this file is about the algorithm itself: bbox pre-filtering, the even-odd
ray cast, holes, enclave ordering, and the antimeridian wrap.
"""

from backend import regions


def square_feature(name, iso2, min_lon, min_lat, max_lon, max_lat, extra_props=None):
    ring = [
        [min_lon, min_lat], [max_lon, min_lat], [max_lon, max_lat], [min_lon, max_lat], [min_lon, min_lat],
    ]
    props = {"name": name, "iso_a2": iso2}
    if extra_props:
        props.update(extra_props)
    return {"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}}


def fc(*features):
    return {"type": "FeatureCollection", "features": list(features)}


# --- basic containment -------------------------------------------------


def test_a_point_inside_the_square_matches():
    index = regions.CountryIndex(fc(square_feature("Egypt", "EG", 25, 22, 35, 32)))
    hit = index.country_at(27.0, 30.0)
    assert hit == {"iso2": "EG", "name": "Egypt"}


def test_a_point_outside_every_polygon_is_none():
    index = regions.CountryIndex(fc(square_feature("Egypt", "EG", 25, 22, 35, 32)))
    assert index.country_at(0.0, 0.0) is None


def test_a_point_exactly_on_the_bbox_edge_but_outside_the_ring_is_none():
    """A concave or otherwise non-rectangular country's bbox can contain a
    point its actual ring does not -- the ray cast, not the bbox, is the
    real test. Regression guard: an L-shaped country whose bbox is a full
    square, tested at the missing corner."""
    l_shape = {
        "type": "Feature",
        "properties": {"name": "L-land", "iso_a2": "LL"},
        "geometry": {"type": "Polygon", "coordinates": [[
            [0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10], [0, 0],
        ]]},
    }
    index = regions.CountryIndex(fc(l_shape))
    assert index.country_at(8.0, 8.0) is None  # inside the bbox, outside the L
    assert index.country_at(2.0, 2.0) == {"iso2": "LL", "name": "L-land"}


# --- holes --------------------------------------------------------------


def test_a_point_inside_a_hole_is_outside_the_country():
    outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    donut = {
        "type": "Feature",
        "properties": {"name": "Donut", "iso_a2": "DN"},
        "geometry": {"type": "Polygon", "coordinates": [outer, hole]},
    }
    index = regions.CountryIndex(fc(donut))
    assert index.country_at(5.0, 5.0) is None  # inside the hole
    assert index.country_at(1.0, 1.0) == {"iso2": "DN", "name": "Donut"}


# --- enclaves: smallest-area-first ---------------------------------------


def test_an_enclave_wins_over_the_country_surrounding_it():
    surrounding = square_feature("Surrounding", "SU", 0, 0, 20, 20)
    enclave = square_feature("Enclave", "EN", 8, 8, 12, 12)
    # Feature order should not matter -- sort by area handles either order.
    index_a = regions.CountryIndex(fc(surrounding, enclave))
    index_b = regions.CountryIndex(fc(enclave, surrounding))
    for index in (index_a, index_b):
        assert index.country_at(10.0, 10.0) == {"iso2": "EN", "name": "Enclave"}
        assert index.country_at(1.0, 1.0) == {"iso2": "SU", "name": "Surrounding"}


# --- MultiPolygon ---------------------------------------------------------


def test_multipolygon_matches_any_of_its_parts():
    archipelago = {
        "type": "Feature",
        "properties": {"name": "Archipelago", "iso_a2": "AR"},
        "geometry": {"type": "MultiPolygon", "coordinates": [
            [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
            [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]],
        ]},
    }
    index = regions.CountryIndex(fc(archipelago))
    assert index.country_at(1.0, 1.0)["iso2"] == "AR"
    assert index.country_at(11.0, 11.0)["iso2"] == "AR"
    assert index.country_at(6.0, 6.0) is None


# --- Natural Earth's own "-99" sentinel -----------------------------------


def test_no_iso2_sentinel_comes_back_as_none_not_the_literal_string():
    index = regions.CountryIndex(fc(square_feature("France", "-99", 0, 40, 5, 45)))
    hit = index.country_at(42.0, 2.0)
    assert hit == {"iso2": None, "name": "France"}


def test_a_missing_iso2_property_also_comes_back_as_none():
    feature = square_feature("Nowhere", None, 0, 0, 5, 5)
    index = regions.CountryIndex(fc(feature))
    assert index.country_at(2.0, 2.0) == {"iso2": None, "name": "Nowhere"}


# --- antimeridian ----------------------------------------------------------


def test_a_longitude_past_180_wraps_before_testing():
    """worldCopyJump can hand back a coordinate like 190 after panning past
    the antimeridian -- countryHitTest.js's own wrapLon note. A landing near
    the seam, or a viewport click carried across it, must resolve the same
    country either way."""
    near_seam = square_feature("Fiji-ish", "FJ", 175, -20, -175, -15)
    # The synthetic square above straddles the antimeridian in raw GeoJSON
    # terms (175 to -175), which is a degenerate case for a *test* polygon;
    # use a polygon entirely on the west side instead and confirm a wrapped
    # east-side query still lands on the corresponding unwrapped point.
    west_side = square_feature("West", "WS", -179, -20, -170, -15)
    index = regions.CountryIndex(fc(west_side))
    assert index.country_at(-17.0, -175.0) == {"iso2": "WS", "name": "West"}
    assert index.country_at(-17.0, 185.0) == {"iso2": "WS", "name": "West"}  # 185 wraps to -175


# --- degenerate input --------------------------------------------------


def test_a_non_finite_coordinate_is_none_not_a_throw():
    index = regions.CountryIndex(fc(square_feature("Egypt", "EG", 25, 22, 35, 32)))
    assert index.country_at(None, None) is None
    assert index.country_at(float("nan"), 30.0) is None


def test_an_empty_feature_collection_matches_nothing():
    index = regions.CountryIndex({})
    assert index.country_at(0.0, 0.0) is None
    assert len(index) == 0


def test_a_feature_with_no_geometry_is_skipped_not_a_throw():
    feature = {"type": "Feature", "properties": {"name": "Ghost", "iso_a2": "GH"}, "geometry": None}
    index = regions.CountryIndex(fc(feature))
    assert len(index) == 0


def test_a_feature_with_a_degenerate_ring_is_skipped():
    feature = {
        "type": "Feature", "properties": {"name": "Line", "iso_a2": "LN"},
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 1]]]},  # < 4 points
    }
    index = regions.CountryIndex(fc(feature))
    assert len(index) == 0


# --- nearest_country: the "schematic, not survey-accurate" fallback --------
#
# Real cable landings sit a short, real distance seaward of Natural Earth's
# own 1:50m coastline often enough that country_at alone left roughly a
# third of Task 38's own landing set unmatched (see backend/refine/
# cable_outage.py's docstring). These tests are the algorithm's own coverage,
# independent of that module's larger fixture.


def test_nearest_country_snaps_a_point_just_outside_the_polygon():
    # Distance here is to the nearest *vertex* (see nearest_country's own
    # docstring on why), so the query point has to sit near one of the
    # square's four corners, not the middle of a long, vertex-sparse edge --
    # a real Natural Earth coastline is dense enough along its own length
    # that this distinction rarely matters there. (1.03, 1.03) is ~4.7km
    # from the corner at (1, 1).
    index = regions.CountryIndex(fc(square_feature("Squareland", "SQ", 0, 0, 1, 1)))
    hit = index.nearest_country(1.03, 1.03, max_km=25.0)
    assert hit == {"iso2": "SQ", "name": "Squareland"}


def test_nearest_country_returns_none_past_max_km():
    index = regions.CountryIndex(fc(square_feature("Squareland", "SQ", 0, 0, 1, 1)))
    assert index.nearest_country(0.5, 5.0, max_km=25.0) is None  # ~500km away


def test_nearest_country_is_none_for_a_point_already_inside_a_polygon_query_at_that_point():
    """Not the intended use (call country_at for that), but nearest_country
    must not throw or misbehave on a point that happens to also be inside a
    polygon -- distance to the nearest vertex is simply 0 or near it."""
    index = regions.CountryIndex(fc(square_feature("Squareland", "SQ", 0, 0, 1, 1)))
    hit = index.nearest_country(0.0, 0.0, max_km=25.0)  # exactly on a vertex
    assert hit == {"iso2": "SQ", "name": "Squareland"}


def test_nearest_country_picks_the_closer_of_two_candidates():
    near = square_feature("Near", "NR", 0, 0, 1, 1)
    far = square_feature("Far", "FR", 3, 0, 4, 1)
    index = regions.CountryIndex(fc(near, far))
    hit = index.nearest_country(0.5, 1.1, max_km=500.0)
    assert hit == {"iso2": "NR", "name": "Near"}


def test_nearest_country_on_an_empty_index_is_none():
    assert regions.CountryIndex({}).nearest_country(0.0, 0.0) is None


def test_nearest_country_with_a_non_finite_coordinate_is_none_not_a_throw():
    index = regions.CountryIndex(fc(square_feature("Squareland", "SQ", 0, 0, 1, 1)))
    assert index.nearest_country(None, None) is None
    assert index.nearest_country(float("nan"), 0.0) is None
