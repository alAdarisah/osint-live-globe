"""Natural Earth's admin-0 layer -> the world in one FeatureCollection.

The country outlines moved from 1:110m to 1:50m, and the two things that move
with them are what is asserted here:

  - Coordinates are rounded to five decimals on the way in, because that is the
    lattice the frontend's border editor quantizes to. Neighbouring countries in
    Natural Earth hold byte-identical coordinates along a shared boundary, and
    the editor moves both sides of a border at once by looking a coordinate up
    by its own value. If rounding here shifted one side's numbers and not the
    other's, dragging a border would tear a gap down it. So the test is not
    "coordinates are short", it is "two countries that shared a vertex before
    rounding still share it after".

  - Rounding merges points that were distinct only below the new precision, so
    consecutive duplicates have to go with it or the ring keeps its original
    length and the size is not actually saved.

Both behaviours live in admin2_boundaries.thin_geometry, which this module
imports rather than reimplements; these assertions are here because the
countries feed is the one that would break the border editor, and a change to
COORD_PRECISION would pass that module's own tests unnoticed.
"""

from backend.sources import countries


def _feature(name: str, ring: list) -> dict:
    return {
        "type": "Feature",
        "properties": {"ADMIN": name, "ADM0_A3": name[:3].upper(), "ISO_A2": name[:2].upper()},
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }


def test_coordinates_are_rounded_to_the_editor_lattice():
    ring = [[1.123456789, 2.987654321], [3.5, 4.5], [5.5, 6.5], [1.123456789, 2.987654321]]
    (_feat, geometry), = countries.shape_features([_feature("Testland", ring)])
    assert geometry["coordinates"][0][0] == [1.12346, 2.98765]


def test_a_shared_boundary_vertex_survives_rounding_on_both_sides():
    # The same point as published by two neighbours, differing only in float
    # noise below the precision kept -- which is exactly how Natural Earth
    # writes a shared boundary after a projection round trip.
    left = [[0.0, 0.0], [10.000000000000002, 0.0], [10.0, 5.0], [0.0, 0.0]]
    right = [[10.0, 0.0], [20.0, 0.0], [10.000000000000004, 5.0], [10.0, 0.0]]
    shaped = countries.shape_features([_feature("Leftland", left), _feature("Rightland", right)])
    (_l, left_geom), (_r, right_geom) = shaped
    assert left_geom["coordinates"][0][1] == right_geom["coordinates"][0][0]
    assert left_geom["coordinates"][0][2] == right_geom["coordinates"][0][2]


def test_points_that_merge_under_rounding_are_dropped_not_repeated():
    # Four distinct published points, two of which are the same point at five
    # decimals. The ring has to come back shorter, not the same length with a
    # duplicate in it.
    ring = [
        [0.0, 0.0],
        [1.0000001, 1.0],
        [1.0000002, 1.0],
        [2.0, 2.0],
        [3.0, 0.0],
        [0.0, 0.0],
    ]
    (_feat, geometry), = countries.shape_features([_feature("Testland", ring)])
    kept = geometry["coordinates"][0]
    assert kept == [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0], [3.0, 0.0], [0.0, 0.0]]


def test_a_feature_whose_geometry_collapses_is_dropped():
    # countryHitTest and the region bbox index both walk geometry.coordinates
    # unconditionally, so a feature with nothing left is a crash rather than an
    # invisible country.
    sliver = [[0.0, 0.0], [0.000001, 0.0], [0.0, 0.000001], [0.0, 0.0]]
    assert countries.shape_features([_feature("Slivergrad", sliver)]) == []


def test_a_feature_with_no_geometry_at_all_is_dropped():
    broken = {"type": "Feature", "properties": {"ADMIN": "Nowhere"}, "geometry": None}
    assert countries.shape_features([broken]) == []
