"""Natural Earth railroad clipping.

The whole job of this module is a static file turned into theatre-clipped
[lat, lon] linework, so these tests are about exactly two things: that the clip
keeps only what falls inside a theatre box, and that the coordinates come out in
Leaflet's order rather than GeoJSON's. No network -- every payload is inline.
"""

from backend import regions
from backend.sources import railways

# One real theatre box, so "clipped to the theatres" is asserted against the
# same bounds the sweep actually uses rather than a hand-made one.
ISRAEL = regions.REGIONS["israel_gaza_lebanon"]["bounds"]  # (29.0, 34.0, 34.5, 37.0)
BOXES = [ISRAEL]

# GeoJSON is [lon, lat]. These two sit inside the Israel box; the third is in
# central Europe, outside every theatre.
INSIDE_A = [35.0, 31.0]
INSIDE_B = [35.5, 32.0]
OUTSIDE = [10.0, 50.0]


def _fc(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def _line(coords, gtype="LineString"):
    return {"type": "Feature", "properties": {}, "geometry": {"type": gtype, "coordinates": coords}}


def test_coordinates_come_out_as_leaflet_lat_lon_not_geojson_lon_lat():
    (path,) = railways.clip_railroads(_fc(_line([INSIDE_A, INSIDE_B])), BOXES)
    # Input was [lon, lat]; output must be [lat, lon].
    assert path == [[31.0, 35.0], [32.0, 35.5]]


def test_points_outside_every_theatre_are_clipped_away():
    """A line that leaves the box ends at its last in-box point."""
    (path,) = railways.clip_railroads(_fc(_line([INSIDE_A, INSIDE_B, OUTSIDE])), BOXES)
    assert path == [[31.0, 35.0], [32.0, 35.5]]


def test_a_line_entirely_outside_the_theatres_is_dropped():
    assert railways.clip_railroads(_fc(_line([OUTSIDE, [11.0, 51.0]])), BOXES) == []


def test_a_lone_in_box_point_is_not_a_line():
    """A single point between two outside ones is a run of length one, dropped."""
    assert railways.clip_railroads(_fc(_line([OUTSIDE, INSIDE_A, [11.0, 51.0]])), BOXES) == []


def test_a_line_that_re_enters_the_box_yields_two_separate_runs():
    coords = [INSIDE_A, INSIDE_B, OUTSIDE, [11.0, 51.0], [35.2, 31.5], [35.3, 31.6]]
    runs = railways.clip_railroads(_fc(_line(coords)), BOXES)
    assert runs == [[[31.0, 35.0], [32.0, 35.5]], [[31.5, 35.2], [31.6, 35.3]]]


def test_multilinestrings_are_split_into_their_segments():
    fc = _fc(_line([[INSIDE_A, INSIDE_B], [[35.2, 31.5], [35.3, 31.6]]], gtype="MultiLineString"))
    runs = railways.clip_railroads(fc, BOXES)
    assert runs == [[[31.0, 35.0], [32.0, 35.5]], [[31.5, 35.2], [31.6, 35.3]]]


def test_non_line_geometry_is_skipped():
    point = {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": INSIDE_A}}
    assert railways.clip_railroads(_fc(point), BOXES) == []


def test_an_empty_collection_is_not_an_error():
    assert railways.clip_railroads({}, BOXES) == []
    assert railways.clip_railroads({"features": []}, BOXES) == []


def test_the_stored_document_states_its_coarse_static_provenance():
    """The popup reads this string; it must say what the data is and is not."""
    doc = railways.serialize([[[31.0, 35.0], [32.0, 35.5]]])
    assert doc["attribution"] == "Natural Earth"
    assert doc["provenance"] == "Natural Earth 1:10m, 2021, coarse basemap linework, unnamed"
    assert doc["lines"] == [[[31.0, 35.0], [32.0, 35.5]]]
