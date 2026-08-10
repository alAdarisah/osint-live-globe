"""Dark-ship reachability: where a vessel could be, not just where it went
quiet -- backend/sources/dark_vessels.py's `build_reachability` and the pure
helpers around it.

Every ais_gap record this module builds already carries the resumption point
(see position_gaps in backend/storage.py: a gap is only ever returned once it
has closed), so the interesting failure modes are not "did it fetch the right
thing" -- nothing here fetches -- but "does the ellipse actually nest",
"does the land mask actually pull a vertex back into water", and "does the
model score itself honestly against the answer it already has". Those three
are the ones this file spends the most weight on.
"""

import math

from backend.sources import dark_vessels as dv
from backend.sources.proximity import haversine_km

NOW = 1_000_000.0


def base_record(**extra) -> dict:
    """A well-formed ais_gap record, as build_gap_records would hand one to
    build_reachability -- the fields the reachability model actually reads."""
    record = {
        "id": "gap:111:0",
        "kind": "ais_gap",
        "lat": 26.0, "lon": 56.0,
        "mmsi": "111",
        "went_dark_at": 0.0,
        "resumed_at": 8 * 3600.0,
        "resumed_lat": 26.3, "resumed_lon": 56.4,
        "gap_hours": 8.0,
        "last_known_speed_kn": 12.0,
        "last_known_course_deg": 45.0,
        "last_known_ship_type": 80,  # tanker range
        "declared_destination": None,
        "ship_type": 80,
    }
    record.update(extra)
    return record


EMPTY_WATER = dv.WaterMask()


# --- radius arithmetic -------------------------------------------------------


def test_reach_radius_is_vmax_times_elapsed_time():
    stats = {"p_kn": 20.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(gap_hours=10.0), stats, EMPTY_WATER, None, NOW)
    assert out["speed_basis"] == "own_history"
    assert out["reach_radius_km"] == round(20.0 * dv.KN_TO_KMH * 10.0, 1)


def test_reach_radius_scales_with_a_longer_gap():
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    short = dv.build_reachability(base_record(gap_hours=4.0), stats, EMPTY_WATER, None, NOW)
    long_ = dv.build_reachability(base_record(gap_hours=20.0), stats, EMPTY_WATER, None, NOW)
    assert short["reach_radius_km"] == round(15.0 * dv.KN_TO_KMH * 4.0, 1)
    assert long_["reach_radius_km"] == round(15.0 * dv.KN_TO_KMH * 20.0, 1)


# --- class-default fallback --------------------------------------------------


def test_too_few_speed_samples_falls_back_to_the_class_default():
    thin = {"p_kn": 40.0, "stdev_kn": 5.0, "sample_count": dv.REACH_MIN_SPEED_SAMPLES - 1}
    out = dv.build_reachability(base_record(last_known_ship_type=80), thin, EMPTY_WATER, None, NOW)
    assert out["speed_basis"] == "class_default"
    assert out["reach_radius_km"] == round(dv.CLASS_MAX_SPEED_KN["tanker"] * dv.KN_TO_KMH * 8.0, 1)


def test_no_speed_history_at_all_also_falls_back():
    out = dv.build_reachability(base_record(last_known_ship_type=None, ship_type=None), None, EMPTY_WATER, None, NOW)
    assert out["speed_basis"] == "class_default"
    assert out["reach_radius_km"] == round(dv.DEFAULT_MAX_SPEED_KN * dv.KN_TO_KMH * 8.0, 1)


def test_enough_samples_uses_the_hulls_own_measured_speed():
    stats = {"p_kn": 30.0, "stdev_kn": 2.0, "sample_count": dv.REACH_MIN_SPEED_SAMPLES}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, None, NOW)
    assert out["speed_basis"] == "own_history"
    assert out["reach_radius_km"] == round(30.0 * dv.KN_TO_KMH * 8.0, 1)


def test_class_default_ignores_a_generous_sample_that_is_still_too_thin():
    """A hull can report a wildly implausible speed once or twice; the sample
    count gate exists precisely so that does not become v_max."""
    stats = {"p_kn": 90.0, "stdev_kn": 40.0, "sample_count": 3}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, None, NOW)
    assert out["speed_basis"] == "class_default"
    assert out["reach_radius_km"] < 90.0 * dv.KN_TO_KMH * 8.0


# --- contour nesting ----------------------------------------------------------


def _ring_points(contour):
    ring = contour["geometry"]["coordinates"][0]
    return ring[:-1]  # drop the closing duplicate of the first vertex


def test_contours_are_returned_in_ascending_percentile_order():
    stats = {"p_kn": 20.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, None, NOW)
    assert [c["properties"]["percentile"] for c in out["contours"]] == [50, 80, 95]


def test_the_50pct_band_nests_inside_80_inside_95():
    """Every vertex of a narrower band must fall inside the next-widest band's
    ring -- the whole claim CONTOUR_BANDS' shared z-per-axis scaling makes.
    Chosen with a small speed variance and a generous reach radius so the
    reach_radius_km clamp never binds and the three ellipses are pure
    same-centre, same-orientation scalings of one another."""
    stats = {"p_kn": 20.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(gap_hours=10.0), stats, EMPTY_WATER, None, NOW)
    p50, p80, p95 = out["contours"]
    for lon, lat in _ring_points(p50):
        assert dv._ring_contains(_ring_points(p80) + [_ring_points(p80)[0]], lat, lon)
    for lon, lat in _ring_points(p80):
        assert dv._ring_contains(_ring_points(p95) + [_ring_points(p95)[0]], lat, lon)


def test_a_stationary_hull_still_gets_a_contour_around_its_last_fix():
    """No course, no speed: dead reckoning adds no displacement, but the
    ellipse -- driven by v_max and the cross-track term alone -- still
    exists and still nests."""
    stats = {"p_kn": 12.0, "stdev_kn": 0.0, "sample_count": 50}
    out = dv.build_reachability(
        base_record(last_known_speed_kn=None, last_known_course_deg=None, gap_hours=6.0),
        stats, EMPTY_WATER, None, NOW,
    )
    assert (out["dr_lat"], out["dr_lon"]) == (26.0, 56.0)
    assert len(out["contours"]) == 3
    for contour in out["contours"]:
        assert len(_ring_points(contour)) == dv.CONTOUR_VERTICES


# --- reach_radius_km is an absolute bound from the last known fix -------------
#
# Regression coverage for a review finding: an earlier version of this module
# capped each band's own along/cross half-width at reach_radius_km, which
# bounds distance *from the dead-reckoned centre* -- and the centre itself
# already sits `travel_km` away from the last known fix, so a vertex could
# land at `travel_km + reach_radius_km` from where the vessel actually went
# dark. Every case below checks distance from the *last known fix*
# (record["lat"]/["lon"]), which is the promise the module docstring makes.


def _worst_vertex_km_from_origin(out, origin_lat, origin_lon):
    worst = 0.0
    for contour in out["contours"]:
        for lon, lat in _ring_points(contour):
            worst = max(worst, haversine_km(origin_lat, origin_lon, lat, lon))
    return worst


def test_no_contour_vertex_exceeds_reach_radius_km_from_the_last_known_fix():
    # The exact figures a review reproduced the bug with: v_max=20kn,
    # last_known_speed=12kn (below v_max, the ordinary case), gap_hours=20,
    # stdev=6kn -- which used to put a 95%-band vertex 18% past the ceiling.
    v_max, hours = 20.0, 20.0
    stats = {"p_kn": v_max, "stdev_kn": 6.0, "sample_count": 50}
    record = base_record(last_known_speed_kn=12.0, gap_hours=hours)
    out = dv.build_reachability(record, stats, EMPTY_WATER, None, NOW)
    worst = _worst_vertex_km_from_origin(out, record["lat"], record["lon"])
    # Checked against the exact, unrounded bound -- out["reach_radius_km"]
    # itself is rounded to 1 decimal place for display, which can sit up to
    # 0.05 below the true figure the geometry was actually built against.
    exact_radius_km = v_max * dv.KN_TO_KMH * hours
    assert worst <= exact_radius_km + 1e-6


def test_no_contour_vertex_exceeds_reach_radius_km_across_a_spread_of_cases():
    origin_lat, origin_lon = 26.0, 56.0
    cases = [
        # (last_known_speed_kn, v_max_kn, stdev_kn, gap_hours)
        (0.0, 15.0, 1.0, 4.0),      # stationary hull, short gap
        (12.0, 20.0, 6.0, 20.0),    # the review's own repro
        (5.0, 30.0, 15.0, 36.0),    # huge variance, the longest gap allowed
        (18.0, 18.0, 0.5, 4.0),     # last-known speed at v_max, short gap
        (30.0, 16.0, 4.0, 12.0),    # last-known speed *above* v_max (edge case)
        (0.5, 32.0, 20.0, 36.0),    # naval-class ceiling, near-stationary last fix
    ]
    for last_speed, v_max, stdev, hours in cases:
        stats = {"p_kn": v_max, "stdev_kn": stdev, "sample_count": 50}
        record = base_record(
            lat=origin_lat, lon=origin_lon,
            last_known_speed_kn=last_speed, gap_hours=hours,
        )
        out = dv.build_reachability(record, stats, EMPTY_WATER, None, NOW)
        worst = _worst_vertex_km_from_origin(out, origin_lat, origin_lon)
        exact_radius_km = v_max * dv.KN_TO_KMH * hours
        assert worst <= exact_radius_km + 1e-6, (last_speed, v_max, stdev, hours)
        # The dead-reckoned point itself is part of the same promise.
        dr_km = haversine_km(origin_lat, origin_lon, out["dr_lat"], out["dr_lon"])
        assert dr_km <= exact_radius_km + 1e-6, (last_speed, v_max, stdev, hours)


# --- land masking against a hand-built coastline ------------------------------


def _sea_box(south, west, north, east):
    """One rectangular "sea" feature in the shape WaterMask reads -- a Task 4
    reference_snapshots document with a single water_marine-style feature."""
    ring = [[west, south], [east, south], [east, north], [west, north], [west, south]]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": {"bbox": [south, west, north, east], "antimeridian": False},
        }],
    }


def test_a_whole_ray_of_water_needs_no_pull_back():
    mask = dv.WaterMask(_sea_box(20.0, 50.0, 30.0, 60.0))
    bound_km, moved = dv._ray_water_bound(26.0, 56.0, 26.0, 56.0, 10.0, mask)
    assert (bound_km, moved) == (10.0, False)


def test_land_at_the_outer_point_is_pulled_back_toward_the_centre():
    """_ray_water_bound is what replaced _pull_to_water -- run once per
    bearing against the outermost band's own vertex rather than once per
    band, which is the fix for the nesting failure below."""
    mask = dv.WaterMask(_sea_box(20.0, 50.0, 30.0, 60.0))
    # 70E is well outside the box; the centre (56E) is well inside it.
    bound_km, moved = dv._ray_water_bound(26.0, 56.0, 26.0, 70.0, 1400.0, mask)
    assert moved is True
    assert 0.0 < bound_km < 1400.0
    # The bound is honest: walking that fraction of the way *from* the
    # centre really does stop in water, not already on land.
    frac_from_centre = bound_km / 1400.0
    test_lon = 56.0 + (70.0 - 56.0) * frac_from_centre
    assert mask.covers(26.0, test_lon)


def test_land_partway_along_the_ray_is_caught_even_though_the_outer_point_is_water():
    """The regression this module's own review caught: a first version of
    _ray_water_bound tested only the outer (95%-band) vertex and returned
    immediately once that alone was water, so an island sitting between the
    centre and that vertex -- open water on both sides of it -- went
    undetected. Walking every sample from the centre outward, not just the
    endpoint, is what this test pins down: land at a third of the way out
    must still shorten the bound, even though the outer point itself is
    fine.
    """
    # A sea box with a hole (an island) between 51.7E and 52.7E -- the
    # centre (50E) is well west of it, the outer point (56E) is well east.
    # outer_km=600 over 6 degrees of longitude puts each of the
    # LAND_MASK_STEPS samples 0.5 degrees (~50 km) apart, which is what
    # keeps the island (a full degree wide) from being straddled by a
    # single step and gives the assertion below real headroom either side.
    outer_ring = [[40.0, 20.0], [70.0, 20.0], [70.0, 32.0], [40.0, 32.0], [40.0, 20.0]]
    island_hole = [[51.7, 24.0], [52.7, 24.0], [52.7, 28.0], [51.7, 28.0], [51.7, 24.0]]
    mask = dv.WaterMask({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [outer_ring, island_hole]},
            "properties": {"bbox": [20.0, 40.0, 32.0, 70.0], "antimeridian": False},
        }],
    })
    outer_km = 600.0
    bound_km, moved = dv._ray_water_bound(26.0, 50.0, 26.0, 56.0, outer_km, mask)
    assert moved is True
    # The island's near edge sits ~190 km east of the centre at this
    # latitude -- the bound must stop well short of the outer point's full
    # 600 km, in the neighbourhood of that shore, not near it.
    assert 100.0 < bound_km < 250.0
    frac_from_centre = bound_km / outer_km
    test_lon = 50.0 + (56.0 - 50.0) * frac_from_centre
    assert mask.covers(26.0, test_lon)
    # And the outer point itself really was water all along -- the whole
    # point of this test is that an endpoint-only check would have missed
    # the island entirely.
    assert mask.covers(26.0, 56.0)


def test_land_masking_changes_a_contour_that_pokes_past_the_coastline():
    """The sea box's east edge sits ~50 km from the ellipse centre; a wide
    enough cross-track term pushes the 95% band's easternmost vertices past
    it, into "land" (everything outside the box), and every vertex that comes
    back out of build_reachability must be back inside the box."""
    sea = _sea_box(25.0, 55.0, 27.0, 56.5)
    mask = dv.WaterMask(sea)
    stats = {"p_kn": 25.0, "stdev_kn": 3.0, "sample_count": 50}
    # No last-known speed, so dead reckoning adds no displacement and the
    # ellipse's own centre stays at the last fix (26, 56), safely inside the
    # box -- otherwise this would also be exercising dead reckoning, which is
    # a different claim from the one this test makes.
    record = base_record(gap_hours=10.0, last_known_speed_kn=0.0)
    out = dv.build_reachability(record, stats, mask, None, NOW)
    assert out["masked_by_land"] is True
    for contour in out["contours"]:
        for lon, lat in _ring_points(contour):
            assert mask.covers(lat, lon)


def test_masking_is_skipped_rather_than_treating_the_world_as_land():
    """An empty WaterMask (no water_marine/water_lakes document landed yet --
    see the module docstring) must not read as "everywhere is land": every
    vertex would otherwise be walked all the way back to the centre and every
    contour would collapse to a point."""
    stats = {"p_kn": 25.0, "stdev_kn": 3.0, "sample_count": 50}
    out = dv.build_reachability(base_record(gap_hours=10.0), stats, dv.WaterMask(), None, NOW)
    assert out["masked_by_land"] is False
    # A real (non-degenerate) ellipse: not every vertex collapsed to dr_lat/dr_lon.
    p95 = out["contours"][-1]
    assert any((lat, lon) != (out["dr_lat"], out["dr_lon"]) for lon, lat in _ring_points(p95))


def test_a_contour_entirely_inside_the_sea_box_is_never_flagged_masked():
    sea = _sea_box(20.0, 40.0, 32.0, 70.0)  # generous box, nothing pokes out
    mask = dv.WaterMask(sea)
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(gap_hours=6.0), stats, mask, None, NOW)
    assert out["masked_by_land"] is False


def test_an_island_between_the_centre_and_the_outer_band_pulls_the_inner_band_back():
    """build_reachability-level regression for the same finding: a hole in
    the sea polygon (the island) sits on the model's own east-pointing
    bearing (theta=0, since the last known course is due east and the hull
    is stationary), close enough in that the 50% band's own raw vertex
    would have landed on it while the 80%/95% bands' raw vertices already
    reach open water beyond it. The whole ray is capped at the island's
    near shore for every band (see _ray_water_bound's docstring on why a
    shared per-bearing bound cannot try to detect "clear again beyond the
    island" from a handful of samples), so what this pins down is narrower
    and more directly testable: the 50% band's vertex on that bearing is
    strictly closer to the centre than its own raw (unmasked) radius would
    have put it, and it lands in water.
    """
    outer_ring = [[40.0, 20.0], [70.0, 20.0], [70.0, 32.0], [40.0, 32.0], [40.0, 20.0]]
    island_hole = [[51.5, 24.0], [52.5, 24.0], [52.5, 28.0], [51.5, 28.0], [51.5, 24.0]]
    mask = dv.WaterMask({
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [outer_ring, island_hole]},
            "properties": {"bbox": [20.0, 40.0, 32.0, 70.0], "antimeridian": False},
        }],
    })
    stats = {"p_kn": 25.0, "stdev_kn": 8.0, "sample_count": 50}
    record = base_record(
        lat=26.0, lon=50.0, last_known_speed_kn=0.0, last_known_course_deg=90.0, gap_hours=20.0,
    )
    out = dv.build_reachability(record, stats, mask, None, NOW)
    assert out["masked_by_land"] is True

    dr_lat, dr_lon = out["dr_lat"], out["dr_lon"]
    p50 = out["contours"][0]
    assert p50["properties"]["percentile"] == 50
    lon50, lat50 = _ring_points(p50)[0]  # vertex 0 is theta == 0, the due-east bearing
    masked_d50 = haversine_km(dr_lat, dr_lon, lat50, lon50)

    # The raw (unmasked) radius on this bearing, recomputed independently of
    # build_reachability's own internals so this is a real check and not a
    # tautology: along-track half-width at the 50% band, capped by the same
    # reach_radius_km rule Critical 1 added (harmless here -- nowhere near
    # binding at these numbers, but included so the two fixes are checked
    # together rather than one silently assuming the other never fires).
    hours = record["gap_hours"]
    along_base_km = stats["stdev_kn"] * dv.KN_TO_KMH * hours
    z_50 = dv.CONTOUR_BANDS[0][1]
    raw_d50 = min(z_50 * along_base_km, out["reach_radius_km"])

    assert masked_d50 < raw_d50 - 1.0  # pulled back by a real margin, not a rounding wobble
    assert mask.covers(lat50, lon50)


def _touches_or_is_inside(outer_ring_closed, lat, lon):
    """Point-in-polygon, tolerant of a point that lands exactly on the outer
    ring's own boundary -- which happens routinely once masking is involved:
    two bands can both get pulled back to the *same* shared water crossing
    (see _ray_water_bound, run once per bearing for every band), landing a
    smaller band's vertex exactly on top of the larger band's own vertex at
    that bearing. Ray casting has no defined answer for a point exactly on an
    edge or vertex; an exact coincidence is checked directly rather than left
    to an algorithm that is not obliged to say yes to it.
    """
    if dv._ring_contains(outer_ring_closed, lat, lon):
        return True
    return any(math.isclose(lat, y, abs_tol=1e-9) and math.isclose(lon, x, abs_tol=1e-9)
               for x, y in outer_ring_closed)


def _strait_mask():
    """Two water bodies with a land gap between them -- an ordinary strait
    shape, not a single convex "sea" -- which is what a review used to catch
    the earlier per-band land-masking search inverting contour nesting."""
    west_sea = _sea_box(20.0, 40.0, 32.0, 55.0)["features"][0]
    east_sea = _sea_box(20.0, 57.0, 32.0, 90.0)["features"][0]
    return {"type": "FeatureCollection", "features": [west_sea, east_sea]}


def test_nesting_survives_land_masking_on_a_strait():
    """The dead-reckoned centre sits just inside the west sea, close enough
    to its own shore that a wide cross-track spread pokes into the land gap
    and, for the outermost band, out the far side into the east sea --
    forcing a real correction, not a no-op."""
    mask = dv.WaterMask(_strait_mask())
    stats = {"p_kn": 25.0, "stdev_kn": 8.0, "sample_count": 50}
    record = base_record(
        lat=26.0, lon=54.5, last_known_speed_kn=0.0, last_known_course_deg=90.0, gap_hours=20.0,
    )
    out = dv.build_reachability(record, stats, mask, None, NOW)
    assert out["masked_by_land"] is True

    p50, p80, p95 = out["contours"]
    r80_closed = _ring_points(p80) + [_ring_points(p80)[0]]
    r95_closed = _ring_points(p95) + [_ring_points(p95)[0]]
    for lon, lat in _ring_points(p50):
        assert _touches_or_is_inside(r80_closed, lat, lon)
    for lon, lat in _ring_points(p80):
        assert _touches_or_is_inside(r95_closed, lat, lon)

    # The invariant the containment check above rests on, checked directly:
    # at every one of the CONTOUR_VERTICES shared bearings, the masked
    # distance from the centre is non-decreasing across the three bands.
    dr_lat, dr_lon = out["dr_lat"], out["dr_lon"]
    r50, r80, r95 = (_ring_points(c) for c in out["contours"])
    for (lon50, lat50), (lon80, lat80), (lon95, lat95) in zip(r50, r80, r95):
        d50 = haversine_km(dr_lat, dr_lon, lat50, lon50)
        d80 = haversine_km(dr_lat, dr_lon, lat80, lon80)
        d95 = haversine_km(dr_lat, dr_lon, lat95, lon95)
        assert d50 <= d80 + 1e-6
        assert d80 <= d95 + 1e-6


def test_bbox_hit_handles_an_antimeridian_wrapping_box():
    """west > east means the box wraps the seam (see the Task 4 convention
    documented in backend/sources/water_bodies.py's _bbox) -- tested directly
    since it is the one geometry rule most likely to be got wrong twice."""
    # A wrapping bbox: west=170, east=-170, so the box covers [170,180] U
    # [-180,-170].
    assert dv._bbox_hits([-10.0, 170.0, 10.0, -170.0], True, 0.0, 179.0) is True
    assert dv._bbox_hits([-10.0, 170.0, 10.0, -170.0], True, 0.0, -175.0) is True
    assert dv._bbox_hits([-10.0, 170.0, 10.0, -170.0], True, 0.0, 0.0) is False


# --- destination prior: effect and weight bound -------------------------------


def test_a_resolved_destination_records_the_port_and_the_weight():
    port = {"id": "port-a", "name": "Bandar Abbas", "lat": 27.15, "lon": 56.25}
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, port, NOW)
    assert out["destination_prior_used"] == {"port": "Bandar Abbas", "weight": dv.DESTINATION_PRIOR_WEIGHT}


def test_no_resolved_destination_leaves_the_prior_unset():
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, None, NOW)
    assert out["destination_prior_used"] is None


def test_the_destination_prior_visibly_reorients_the_contour():
    """A destination due south of the dead-reckoned point, against a hull
    holding a due-east course, has to visibly rotate the ellipse -- otherwise
    the "bias" is not actually doing anything."""
    stats = {"p_kn": 20.0, "stdev_kn": 1.0, "sample_count": 50}
    unbiased = dv.build_reachability(
        base_record(last_known_course_deg=90.0, gap_hours=10.0), stats, EMPTY_WATER, None, NOW
    )
    port = {"id": "p", "name": "Southport", "lat": unbiased["dr_lat"] - 10.0, "lon": unbiased["dr_lon"]}
    biased = dv.build_reachability(
        base_record(last_known_course_deg=90.0, gap_hours=10.0), stats, EMPTY_WATER, port, NOW
    )
    # Same dead-reckoned point (the prior only ever nudges the lobe's
    # orientation, never the point estimate itself) but a different shape.
    assert (unbiased["dr_lat"], unbiased["dr_lon"]) == (biased["dr_lat"], biased["dr_lon"])
    assert unbiased["contours"][0] != biased["contours"][0]


def test_blend_bearing_weight_is_clamped_to_the_documented_ceiling():
    course, dest = 0.0, 90.0
    at_cap = dv._blend_bearing(course, dest, dv.MAX_DESTINATION_PRIOR_WEIGHT)
    over_cap = dv._blend_bearing(course, dest, dv.MAX_DESTINATION_PRIOR_WEIGHT + 5.0)
    assert over_cap == at_cap


def test_blend_bearing_at_zero_weight_is_the_unmodified_course():
    assert dv._blend_bearing(37.0, 200.0, 0.0) == 37.0


def test_blend_bearing_moves_toward_the_destination_as_weight_grows():
    """Not asserting an exact value (that would just restate the trig) -- only
    that more weight means more movement toward the destination bearing,
    which is what "bias...weighted low" has to actually do."""
    course, dest = 0.0, 90.0
    small = dv._blend_bearing(course, dest, 0.05)
    large = dv._blend_bearing(course, dest, dv.MAX_DESTINATION_PRIOR_WEIGHT)
    assert 0.0 < small < large < 90.0


# --- destination resolution: exact match only ---------------------------------


def test_destination_resolves_on_an_exact_normalised_name_match():
    index = dv.destination_index([{"id": "x", "name": "Rotterdam", "lat": 51.9, "lon": 4.5}])
    assert dv.resolve_destination("rotterdam", index)["id"] == "x"
    assert dv.resolve_destination("ROTTERDAM", index)["id"] == "x"


def test_destination_does_not_fuzzy_match_a_routing_chain():
    index = dv.destination_index([{"id": "x", "name": "Rotterdam", "lat": 51.9, "lon": 4.5}])
    assert dv.resolve_destination("USNYC>NLRTM", index) is None
    assert dv.resolve_destination("FOR ORDERS", index) is None
    assert dv.resolve_destination(None, index) is None


def test_destination_matches_on_the_wpi_unlo_code_too():
    index = dv.destination_index([{"id": "x", "name": "Rotterdam", "unlo_code": "NLRTM", "lat": 51.9, "lon": 4.5}])
    assert dv.resolve_destination("NLRTM", index)["id"] == "x"


# --- self-scoring --------------------------------------------------------------


def test_prediction_error_is_the_distance_from_dead_reckoning_to_the_real_resume_point():
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(base_record(), stats, EMPTY_WATER, None, NOW)
    expected = round(haversine_km(out["dr_lat"], out["dr_lon"], 26.3, 56.4), 1)
    assert out["prediction_error_km"] == expected
    assert out["prediction_scored_at"] == NOW


def test_a_perfect_dead_reckoning_scores_zero():
    """Speed and course chosen so the dead-reckoned point lands exactly on the
    resumption point: the model should report (near) zero error rather than
    some minimum floor."""
    # 8 hours at 10 kn due east covers 10 * 1.852 * 8 ~= 148.16 km.
    from backend.sources.proximity import destination_point
    dr_lat, dr_lon = destination_point(26.0, 56.0, 90.0, 10.0 * dv.KN_TO_KMH * 8.0)
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(
        base_record(last_known_speed_kn=10.0, last_known_course_deg=90.0, resumed_lat=dr_lat, resumed_lon=dr_lon),
        stats, EMPTY_WATER, None, NOW,
    )
    assert out["prediction_error_km"] < 0.01


def test_no_resumption_point_leaves_the_score_unset():
    """Defensive path: every ais_gap record this module actually builds does
    carry a resumption point (see the module docstring on why position_gaps
    only ever returns a closed gap), but build_reachability itself must not
    assume the key is present."""
    record = base_record()
    del record["resumed_lat"]
    del record["resumed_lon"]
    stats = {"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}
    out = dv.build_reachability(record, stats, EMPTY_WATER, None, NOW)
    assert out["prediction_error_km"] is None
    assert out["prediction_scored_at"] is None


# --- add_reachability: orchestration across a batch ----------------------------


def test_add_reachability_zips_each_records_own_speed_stats_by_position():
    records = [base_record(mmsi="111", gap_hours=4.0), base_record(mmsi="222", gap_hours=4.0)]
    stats_list = [
        {"p_kn": 40.0, "stdev_kn": 1.0, "sample_count": 50},  # fast hull
        {"p_kn": 10.0, "stdev_kn": 1.0, "sample_count": 50},  # slow hull
    ]
    out = dv.add_reachability(records, stats_list, EMPTY_WATER, {}, NOW)
    assert out[0]["mmsi"] == "111" and out[0]["speed_basis"] == "own_history"
    assert out[0]["reach_radius_km"] > out[1]["reach_radius_km"]
    # Originals untouched.
    assert "reach_radius_km" not in records[0]


def test_add_reachability_resolves_each_records_own_declared_destination():
    port = {"id": "p", "name": "Rotterdam", "lat": 51.9, "lon": 4.5}
    index = dv.destination_index([port])
    records = [
        base_record(mmsi="111", declared_destination="Rotterdam"),
        base_record(mmsi="222", declared_destination="FOR ORDERS"),
    ]
    stats_list = [{"p_kn": 15.0, "stdev_kn": 1.0, "sample_count": 50}] * 2
    out = dv.add_reachability(records, stats_list, EMPTY_WATER, index, NOW)
    assert out[0]["destination_prior_used"]["port"] == "Rotterdam"
    assert out[1]["destination_prior_used"] is None


# --- what build_gap_records itself now carries forward -------------------------


def test_build_gap_records_reads_last_known_state_off_the_pre_gap_fix():
    """The reachability model's inputs come from the AIS row immediately
    *before* the gap (from_payload), never from entity_latest's current
    state, which by the time a gap record exists already reflects whatever
    happened after the hull reappeared."""
    gaps = [{
        "entity_id": "111", "from_ts": 1_000_000.0, "from_lat": 26.0, "from_lon": 56.0,
        "from_payload": {"speed": 11.4, "course": 271.0, "ship_type": 80, "destination": "Rotterdam"},
        "to_ts": 1_000_000.0 + 9 * 3600.0, "to_lat": 26.05, "to_lon": 56.05,
        "gap_seconds": 9 * 3600.0,
    }]
    healthy = [(ts, 800, True) for ts in (990_000.0, 1_000_000.0, 1_030_000.0)]
    (record,) = dv.build_gap_records(gaps, {}, healthy)
    assert record["last_known_speed_kn"] == 11.4
    assert record["last_known_course_deg"] == 271.0
    assert record["last_known_ship_type"] == 80
    assert record["declared_destination"] == "Rotterdam"


def test_ais_sentinel_values_are_read_as_unavailable_not_as_real_readings():
    """SOG's raw all-ones value (102.3 kn) and COG's raw 3600 (360.0 degrees)
    are AIS's own "not available" markers, not real speed or course."""
    gaps = [{
        "entity_id": "111", "from_ts": 1_000_000.0, "from_lat": 26.0, "from_lon": 56.0,
        "from_payload": {"speed": 102.3, "course": 360.0},
        "to_ts": 1_000_000.0 + 9 * 3600.0, "to_lat": 26.05, "to_lon": 56.05,
        "gap_seconds": 9 * 3600.0,
    }]
    healthy = [(ts, 800, True) for ts in (990_000.0, 1_000_000.0, 1_030_000.0)]
    (record,) = dv.build_gap_records(gaps, {}, healthy)
    assert record["last_known_speed_kn"] is None
    assert record["last_known_course_deg"] is None
