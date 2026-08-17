"""A hand-drawn pipeline is only worth keeping where OpenStreetMap plots nothing.

`PIPELINE_ROUTES` is schematic by construction -- four waypoints for a 1,200km
pipeline -- and `/api/infrastructure` merges it with real `man_made=pipeline`
geometry from the Overpass sweep. Where both exist the reader gets two lines for one
pipeline, and the hand-drawn one is the less accurate of the two: not a fallback, a
competing claim.

So the rule is: a route whose corridor the sweep covers does not belong in the
curated list. This holds the list to it, because the failure is silent -- a
re-added route just draws a second line, and nobody reads a map thinking "is this
one line or two".
"""

from backend import infrastructure, regions

# The routes removed when this rule was applied, by id. Named so a re-add fails
# with the reason rather than with a count.
REMOVED_BECAUSE_OSM_PLOTS_THEM = {
    "druzhba",
    "petroline_east_west",
    "habshan_fujairah_pipeline",
    "turkstream",
}


def _swept_boxes():
    """The theatres osm_infra.py actually sweeps: every region with bounds."""
    return [r["bounds"] for r in regions.REGIONS.values() if r.get("bounds")]


def _waypoints_in_swept_boxes(coords):
    """How many of a route's waypoints fall inside any swept theatre."""
    inside = 0
    for lat, lon in coords:
        for south, west, north, east in _swept_boxes():
            if south <= lat <= north and west <= lon <= east:
                inside += 1
                break
    return inside


def test_the_sweep_covers_somewhere():
    """Guards the guard: if REGIONS lost its bounds this whole file would pass
    vacuously by concluding OSM covers nothing."""
    boxes = _swept_boxes()
    assert len(boxes) >= 10, f"only {len(boxes)} swept theatres; the scan is broken"


def test_no_curated_route_is_one_openstreetmap_already_plots():
    """The rule itself.

    A waypoint inside a swept box means Overpass returns `man_made=pipeline` ways
    for that corridor, so the curated line is drawn over real geometry.
    """
    offenders = []
    for route in infrastructure.PIPELINE_ROUTES:
        inside = _waypoints_in_swept_boxes(route["coords"])
        if inside:
            offenders.append(
                f'{route["id"]}: {inside} of {len(route["coords"])} waypoints are inside a swept '
                "theatre, so OpenStreetMap plots this corridor and the schematic duplicates it"
            )
    assert offenders == [], "\n".join(offenders)


def test_the_routes_removed_for_that_reason_stay_removed():
    """By name, so re-adding one fails with the argument rather than a diff."""
    present = {route["id"] for route in infrastructure.PIPELINE_ROUTES}
    back = present & REMOVED_BECAUSE_OSM_PLOTS_THEM
    assert not back, (
        f"{sorted(back)} were removed because the Overpass sweep plots them with real geometry. "
        "See the note above PIPELINE_ROUTES -- re-adding one draws a second, less accurate line "
        "over the first."
    )


def test_the_routes_outside_the_sweep_are_still_there():
    """The other half, and the reason this list still exists.

    Nothing plots these, so the schematic is the only line a reader gets. A future
    tidy-up that removed the whole list because "OSM has pipelines" would take six
    corridors off the map with it.
    """
    kept = {route["id"] for route in infrastructure.PIPELINE_ROUTES}
    for route_id in (
        "trans_alaska",
        "keystone",
        "btc_pipeline",
        "iraq_turkey_pipeline",
        "power_of_siberia",
        "transmed",
    ):
        assert route_id in kept, f"{route_id} is outside every swept theatre -- nothing else draws it"


def test_every_kept_route_still_has_drawable_geometry():
    """A line needs two points, and the frontend silently skips a route with fewer
    (renderPipelines' `route.path.length < 2` guard), so a malformed entry would
    vanish rather than error."""
    for route in infrastructure.PIPELINE_ROUTES:
        assert len(route["coords"]) >= 2, route["id"]
        for lat, lon in route["coords"]:
            assert -90 <= lat <= 90 and -180 <= lon <= 180, route["id"]
