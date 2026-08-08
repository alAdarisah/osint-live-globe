"""The viewport bbox: parsing it, intersecting it, and what it must not widen.

A bbox is an optimisation the client offers rather than a request it makes, so
almost everything here is about failing safe. A malformed box has to fall back
to the full region rather than error; a box outside the selected region has to
return nothing rather than everything; and -- the one that would be genuinely
dangerous -- passing a box must never lift the world-view row ceilings, which
key on whether a region was selected and not on whether bounds happen to exist.
"""

import pytest

from backend import app as app_mod
from backend import regions


# --- parse_bbox -----------------------------------------------------------

@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "1,2,3",                    # too few
        "1,2,3,4,5",                # too many
        "a,b,c,d",                  # not numbers
        "nan,0,10,10",              # NaN fails every comparison, including its own
        "-100,0,10,10",             # latitude out of range
        "0,-200,10,10",             # longitude out of range
        "50,0,10,10",               # south above north
        "0,170,10,-170",            # crosses the antimeridian
    ],
)
def test_a_box_that_cannot_be_trusted_is_no_box_at_all(raw):
    # None means "no viewport filter", which is what an absent parameter means
    # too -- so a bad box degrades to a slower correct answer, never an error
    # and never an empty layer.
    assert regions.parse_bbox(raw) is None


def test_a_well_formed_box_parses_to_south_west_north_east():
    assert regions.parse_bbox("44,21,56,41") == (44.0, 21.0, 56.0, 41.0)


def test_a_degenerate_but_valid_box_is_accepted():
    # Zero-area is legitimate (the /api/wind snapping can produce one) and is
    # not the same thing as malformed.
    assert regions.parse_bbox("10,10,10,10") == (10.0, 10.0, 10.0, 10.0)


# --- intersect ------------------------------------------------------------

def test_intersect_returns_the_other_when_either_side_is_absent():
    box = (0.0, 0.0, 10.0, 10.0)
    assert regions.intersect(None, box) == box
    assert regions.intersect(box, None) == box
    assert regions.intersect(None, None) is None


def test_intersect_clips_a_viewport_to_the_selected_region():
    region = (44.0, 21.0, 56.0, 41.0)      # russia_ukraine
    viewport = (40.0, 30.0, 50.0, 60.0)
    assert regions.intersect(region, viewport) == (44.0, 30.0, 50.0, 41.0)


def test_a_viewport_outside_the_region_yields_nothing_not_everything():
    # The important one. None means "no filter" in this codebase, so returning
    # it for two boxes that do not overlap would hand back the whole world --
    # the exact opposite of what was asked.
    region = (44.0, 21.0, 56.0, 41.0)
    elsewhere = (-40.0, -70.0, -30.0, -60.0)
    overlap = regions.intersect(region, elsewhere)

    assert overlap is not None
    points = [{"lat": 50.0, "lon": 30.0}, {"lat": -35.0, "lon": -65.0}]
    assert regions.filter_points(points, overlap) == []


def test_a_viewport_can_never_widen_a_region():
    region = (44.0, 21.0, 56.0, 41.0)
    whole_world = (-90.0, -180.0, 90.0, 180.0)
    assert regions.intersect(region, whole_world) == region


# --- the world ceilings ---------------------------------------------------

def _events(n: int) -> list[dict]:
    # All on one point so any plausible bbox contains all of them -- what is
    # under test is the ceiling, not the geometry. Severities are distinct and
    # ascending, so "which ones survived" has an exact answer rather than a
    # bucketed one.
    return [{"lat": 10.0, "lon": 10.0, "severity": i} for i in range(n)]


def test_the_world_ceiling_applies_with_no_region_and_no_box():
    kept = app_mod._events_filter_for(None)(_events(4000), None)
    assert len(kept) == app_mod.EVENTS_MAX_ITEMS


def test_a_bbox_does_not_lift_the_world_ceiling():
    # The trap this refactor exists to close. The ceiling used to key on
    # `bounds is None`, which stopped meaning "the world view" the moment a
    # viewport box could produce bounds -- so a box covering a third of the
    # planet would have silently returned the full uncapped feed.
    huge = regions.parse_bbox("-80,-170,80,170")
    kept = app_mod._events_filter_for(None)(_events(4000), huge)
    assert len(kept) == app_mod.EVENTS_MAX_ITEMS


def test_the_ceiling_keeps_the_most_severe():
    # 4000 events with severities 0..3999, capped to 2500: the survivors are
    # exactly the top 2500, so the least severe kept is 1500.
    kept = app_mod._events_filter_for(None)(_events(4000), None)
    assert min(d["severity"] for d in kept) == 4000 - app_mod.EVENTS_MAX_ITEMS


def test_a_selected_region_is_never_capped():
    # If you have asked to look at Sudan you should see all of Sudan.
    kept = app_mod._events_filter_for("sudan")(_events(4000), None)
    assert len(kept) == 4000


def test_officials_follows_the_same_rule():
    items = [{"lat": 10.0, "lon": 10.0} for _ in range(2000)]
    assert len(app_mod._officials_filter_for(None)(items, None)) == app_mod.OFFICIALS_MAX_ITEMS
    huge = regions.parse_bbox("-80,-170,80,170")
    assert len(app_mod._officials_filter_for(None)(items, huge)) == app_mod.OFFICIALS_MAX_ITEMS
    assert len(app_mod._officials_filter_for("sudan")(items, None)) == 2000


# --- the ETag ---------------------------------------------------------------

def test_two_boxes_on_one_source_and_version_are_different_bodies():
    """Two readers on the same source and version but different cells hold
    genuinely different payloads, so the box has to be in the ETag -- otherwise
    the second is told its stale copy is still good."""
    from backend.cache import registry

    registry.register("bbox_etag_probe", key_configured=True)
    state = registry.get("bbox_etag_probe")
    state.data = [{"lat": 10.0, "lon": 10.0}, {"lat": 60.0, "lon": 60.0}]
    state.version = 7

    class _Req:
        headers: dict = {}

    a = app_mod._cached_source_response(
        _Req(), "bbox_etag_probe", None, regions.filter_points, bbox="0,0,20,20"
    )
    b = app_mod._cached_source_response(
        _Req(), "bbox_etag_probe", None, regions.filter_points, bbox="50,50,70,70"
    )
    assert a.headers["etag"] != b.headers["etag"]
