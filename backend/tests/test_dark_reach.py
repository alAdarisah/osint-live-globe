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
    assert out["speed_basis"] == "measured"
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
    assert out["speed_basis"] == "measured"
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


def test_a_vertex_inside_the_sea_box_is_left_alone():
    mask = dv.WaterMask(_sea_box(20.0, 50.0, 30.0, 60.0))
    lat, lon, moved = dv._pull_to_water(26.0, 56.0, 26.0, 56.0, mask)
    assert (lat, lon, moved) == (26.0, 56.0, False)


def test_a_vertex_outside_the_sea_box_is_pulled_back_toward_the_centre():
    mask = dv.WaterMask(_sea_box(20.0, 50.0, 30.0, 60.0))
    # 70E is well outside the box; the centre (56E) is well inside it.
    lat, lon, moved = dv._pull_to_water(26.0, 70.0, 26.0, 56.0, mask)
    assert moved is True
    assert mask.covers(lat, lon)
    # Pulled *toward* the centre, not to some unrelated point.
    assert 56.0 <= lon < 70.0


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
    assert out[0]["mmsi"] == "111" and out[0]["speed_basis"] == "measured"
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
