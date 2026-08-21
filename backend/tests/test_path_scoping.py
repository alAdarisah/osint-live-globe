"""Linework narrowed to the viewport, and the one way that can go wrong quietly.

/api/power-lines served all 44,984 lines to every client -- 9.8 MB gzipped after
rounding, the largest response this API produces -- on the reasoning that a line is
one object rather than a set of points to clip to a region. True of a *region*
filter and the wrong conclusion for a viewport: a reader looking at one city was
being handed the grid of eleven conflict theatres and then drawing it.

The failure this file mostly guards is not size but omission. A line can cross the
whole viewport with both endpoints outside it, and the obvious filter -- "keep the
lines with a vertex in view" -- drops exactly the long transmission runs a reader
most wants to see, silently, leaving a map that lies about the grid.
"""

from backend import regions


VIEW = (10.0, 10.0, 20.0, 20.0)  # south, west, north, east


def test_a_line_crossing_the_view_with_both_ends_outside_is_kept():
    """The case a vertex test loses. This is the whole reason the filter compares
    extents rather than points."""
    crossing = {"id": "long-haul", "path": [[0.0, 15.0], [40.0, 15.0]]}
    assert regions.filter_paths([crossing], VIEW) == [crossing]


def test_a_line_wholly_outside_is_dropped():
    away = {"id": "elsewhere", "path": [[50.0, 50.0], [51.0, 51.0]]}
    assert regions.filter_paths([away], VIEW) == []


def test_a_line_wholly_inside_is_kept():
    inside = {"id": "local", "path": [[12.0, 12.0], [13.0, 13.0]]}
    assert regions.filter_paths([inside], VIEW) == [inside]


def test_a_line_merely_touching_the_edge_is_kept():
    """Inclusive on the boundary, deliberately: a line ending exactly on the edge of
    the requested box is visible at that edge, and the box is padded and snapped by
    the client anyway."""
    touching = {"id": "edge", "path": [[20.0, 20.0], [30.0, 30.0]]}
    assert regions.filter_paths([touching], VIEW) == [touching]


def test_no_bounds_means_no_filtering():
    """An unscoped client -- curl, a stale bundle -- still gets everything. Asking
    for less is an opt-in, the same rule the ADS-B `civilian=0` parameter follows."""
    lines = [{"path": [[0.0, 0.0], [1.0, 1.0]]}, {"path": [[80.0, 80.0], [81.0, 81.0]]}]
    assert regions.filter_paths(lines, None) == lines


def test_records_with_no_usable_path_are_skipped_rather_than_crashing():
    """A malformed record must not take the whole layer down with it."""
    messy = [
        {"id": "no-path"},
        {"id": "empty", "path": []},
        {"id": "ragged", "path": [[12.0], "nonsense", None]},
        {"id": "good", "path": [[12.0, 12.0], [13.0, 13.0]]},
    ]
    assert [r["id"] for r in regions.filter_paths(messy, VIEW)] == ["good"]


def test_the_filter_over_includes_rather_than_clipping():
    """Stated as a test because it is a deliberate inaccuracy, not an oversight.

    A line whose extent spans the view but whose geometry stays outside it is
    returned. Clipping the geometry would be smaller still and is refused: a
    clipped line is a different claim from the one OpenStreetMap made.
    """
    # An L-shape whose bounding box covers the view while the line itself runs
    # along two far edges of it.
    l_shape = {"id": "elbow", "path": [[0.0, 0.0], [0.0, 30.0], [30.0, 30.0]]}
    assert regions.filter_paths([l_shape], VIEW) == [l_shape]


def test_the_envelope_survives_the_clip():
    """`attribution`, `provenance` and `truncated_regions` are claims about how the
    sweep was made. A reader who has panned somewhere quiet still has to be told
    this layer covers eleven theatres rather than the world -- so the fields must
    ride along with whichever lines survive."""
    from backend import app as app_mod
    doc = {
        "attribution": "OpenStreetMap contributors",
        "provenance": "swept daily across this map's eleven conflict theatres, not worldwide.",
        "truncated_regions": ["russia_ukraine"],
        "lines": [
            {"id": "in", "path": [[12.0, 12.0], [13.0, 13.0]]},
            {"id": "out", "path": [[60.0, 60.0], [61.0, 61.0]]},
        ],
    }
    clipped = app_mod._clip_lines(doc, VIEW)
    assert [line["id"] for line in clipped["lines"]] == ["in"]
    assert clipped["attribution"] == doc["attribution"]
    assert clipped["provenance"] == doc["provenance"]
    assert clipped["truncated_regions"] == ["russia_ukraine"]
    # And the stored document is not mutated -- it is the registry's live copy, and
    # clipping it in place would narrow the layer for every later client.
    assert len(doc["lines"]) == 2


def test_an_unscoped_request_gets_the_whole_document_back_unchanged():
    from backend import app as app_mod
    doc = {"attribution": "x", "lines": [{"id": "a", "path": [[1.0, 1.0], [2.0, 2.0]]}]}
    assert app_mod._clip_lines(doc, None) is doc
