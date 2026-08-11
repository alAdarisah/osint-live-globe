"""Task 37: infrastructure at risk.

Covers, per the task brief: the radius filter (an event's own
`geo_radius_km` decides what counts as "nearby", nothing wider or narrower),
an event with no uncertainty radius (never searched -- excluded from
`events_searched`, counted separately, never silently treated as "searched,
found nothing"), and the ranking, including ties (a deterministic tie-break,
since an unstable order in a ranked list is a real defect on its own).

Plus a few slices of backend/sources/proximity.py's new `within()` method
directly -- infra_risk.build_document's own radius-filter tests exercise it
end-to-end, but within() is a public method of a shared spatial index and
deserves its own coverage independent of one caller's use of it.
"""

from backend.refine import infra_risk
from backend.sources.proximity import ProximityIndex

NOW = 1_754_000_000.0  # an arbitrary fixed instant; only used as a passthrough


# ---------- ProximityIndex.within() ----------


def test_within_returns_only_points_inside_the_radius_nearest_first():
    index = ProximityIndex([
        {"lat": 50.45, "lon": 30.52, "name": "At the point"},
        {"lat": 50.46, "lon": 30.53, "name": "Near"},  # ~1.3km away
        {"lat": 10.0, "lon": 10.0, "name": "Far"},
    ])
    found = index.within(50.45, 30.52, 5.0)
    names = [p["name"] for p in found]
    assert names == ["At the point", "Near"]  # nearest first, Far excluded


def test_within_on_an_empty_index_is_empty_not_an_error():
    assert ProximityIndex([]).within(0.0, 0.0, 100.0) == []


def test_within_zero_radius_only_matches_an_exactly_coincident_point():
    index = ProximityIndex([
        {"lat": 50.45, "lon": 30.52, "name": "Exact"},
        {"lat": 50.4501, "lon": 30.52, "name": "A few metres off"},
    ])
    found = index.within(50.45, 30.52, 0.0)
    assert [p["name"] for p in found] == ["Exact"]


def test_within_negative_radius_matches_nothing():
    index = ProximityIndex([{"lat": 50.45, "lon": 30.52, "name": "Exact"}])
    assert index.within(50.45, 30.52, -5.0) == []


def test_within_does_not_disturb_nearest():
    # nearest() must keep returning a single best match, unaffected by
    # within() existing alongside it on the same index.
    index = ProximityIndex([
        {"lat": 50.46, "lon": 30.53, "name": "Near"},
        {"lat": 50.47, "lon": 30.54, "name": "Farther"},
    ])
    best = index.nearest(50.45, 30.52, 50.0)
    assert best["name"] == "Near"


# ---------- build_index ----------


def test_build_index_keeps_only_power_plant_rows_out_of_osm_infra():
    osm_infra = [
        {"id": "osm:node/1", "kind": "power_plant", "name": "Plant", "lat": 10.0, "lon": 10.0},
        {"id": "osm:node/2", "kind": "military_airfield", "name": "Base", "lat": 10.0, "lon": 10.0},
    ]
    index, counts = infra_risk.build_index([], osm_infra, [], [], [])
    assert counts["power_plant"] == 1
    found = index.within(10.0, 10.0, 1.0)
    assert [p["name"] for p in found] == ["Plant"]


def test_build_index_drops_rows_with_no_id_or_no_coordinate():
    dams = [
        {"id": "gdw:1", "name": "Has coords", "lat": 10.0, "lon": 10.0},
        {"id": "gdw:2", "name": "No coords"},
        {"name": "No id", "lat": 11.0, "lon": 11.0},
    ]
    index, counts = infra_risk.build_index(dams, [], [], [], [])
    assert counts["dam"] == 1
    assert len(index) == 1


def test_build_index_category_counts_cover_all_five_categories_even_when_empty():
    _, counts = infra_risk.build_index([], [], [], [], [])
    assert counts == {
        "dam": 0, "power_plant": 0, "cable_landing": 0, "airfield": 0, "port": 0,
    }


def test_site_ids_are_namespaced_by_category_so_ids_never_collide():
    # A dam and a port sharing the same raw id (however unlikely) must not
    # merge into one ranked entry.
    dams = [{"id": "1", "name": "Dam One", "lat": 10.0, "lon": 10.0}]
    ports = [{"id": "1", "name": "Port One", "lat": 10.0, "lon": 10.0}]
    index, _ = infra_risk.build_index(dams, [], [], [], ports)
    found = index.within(10.0, 10.0, 1.0)
    site_ids = {p["site_id"] for p in found}
    assert site_ids == {"dam:1", "port:1"}


# ---------- build_document: the radius filter ----------


def _index_with(*points):
    return ProximityIndex(list(points))


def _counts(**overrides):
    base = {"dam": 0, "power_plant": 0, "cable_landing": 0, "airfield": 0, "port": 0}
    base.update(overrides)
    return base


def test_an_event_with_a_site_inside_its_radius_counts_it():
    index = _index_with({"lat": 50.46, "lon": 30.53, "site_id": "dam:1", "category": "dam", "name": "Near Dam"})
    events = [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0}]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["events_searched"] == 1
    assert doc["events_without_radius"] == 0
    assert [s["site_id"] for s in doc["top"]] == ["dam:1"]
    assert doc["top"][0]["event_count"] == 1


def test_a_site_outside_the_events_radius_is_not_counted():
    index = _index_with({"lat": 10.0, "lon": 10.0, "site_id": "dam:far", "category": "dam", "name": "Far Dam"})
    events = [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0}]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["top"] == []
    assert doc["events_searched"] == 1  # searched, just found nothing -- not "did not look"


def test_a_wider_radius_reaches_a_site_a_narrower_one_would_miss():
    site = {"lat": 50.9, "lon": 30.52, "site_id": "dam:1", "category": "dam", "name": "Dam"}  # ~50km north
    index = _index_with(site)
    narrow = infra_risk.build_document(
        [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0}], index, _counts(dam=1), NOW,
    )
    wide = infra_risk.build_document(
        [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 100.0}], index, _counts(dam=1), NOW,
    )
    assert narrow["top"] == []
    assert [s["site_id"] for s in wide["top"]] == ["dam:1"]


# ---------- build_document: no uncertainty radius ----------


def test_an_event_with_no_radius_is_never_searched():
    index = _index_with({"lat": 50.45, "lon": 30.52, "site_id": "dam:1", "category": "dam", "name": "Dam"})
    events = [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": None}]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["events_searched"] == 0
    assert doc["events_without_radius"] == 1
    # A site sitting exactly on the event's own coordinate is still not
    # counted -- "no radius" means "not searched", not "searched at radius 0".
    assert doc["top"] == []


def test_a_non_positive_radius_is_treated_the_same_as_missing():
    index = _index_with({"lat": 50.45, "lon": 30.52, "site_id": "dam:1", "category": "dam", "name": "Dam"})
    events = [{"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 0.0}]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["events_without_radius"] == 1
    assert doc["events_searched"] == 0


def test_mixed_events_split_correctly_between_searched_and_without_radius():
    index = _index_with({"lat": 50.45, "lon": 30.52, "site_id": "dam:1", "category": "dam", "name": "Dam"})
    events = [
        {"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0},
        {"id": "e2", "lat": 50.45, "lon": 30.52, "geo_radius_km": None},
        {"id": "e3", "lat": 12.0, "lon": 12.0, "geo_radius_km": 400.0},  # country-centroid-style radius
    ]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["events_searched"] == 2
    assert doc["events_without_radius"] == 1
    assert doc["top"][0]["event_count"] == 1  # only e1 actually reached the dam


# ---------- build_document: ranking, including ties ----------


def test_sites_are_ranked_by_event_count_descending():
    index = _index_with(
        {"lat": 50.45, "lon": 30.52, "site_id": "dam:busy", "category": "dam", "name": "Busy Dam"},
        {"lat": 20.0, "lon": 20.0, "site_id": "port:quiet", "category": "port", "name": "Quiet Port"},
    )
    events = [
        {"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0},
        {"id": "e2", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0},
        {"id": "e3", "lat": 20.0, "lon": 20.0, "geo_radius_km": 5.0},
    ]
    doc = infra_risk.build_document(events, index, _counts(dam=1, port=1), NOW)
    assert [s["site_id"] for s in doc["top"]] == ["dam:busy", "port:quiet"]
    assert doc["top"][0]["event_count"] == 2
    assert doc["top"][1]["event_count"] == 1


def test_tied_sites_break_deterministically_on_site_id_regardless_of_scan_order():
    """Two sites with the same event_count must always come out in the same
    relative order -- an unstable order in a ranked list is a real defect on
    its own, per the task brief. The tie-break is site_id ascending; this is
    pinned by running the same tie with the event list in both orders and
    checking the ranked output is identical either way."""
    index = _index_with(
        {"lat": 50.45, "lon": 30.52, "site_id": "port:zzz_last", "category": "port", "name": "Z Port"},
        {"lat": 60.0, "lon": 60.0, "site_id": "dam:aaa_first", "category": "dam", "name": "A Dam"},
    )
    forward = [
        {"id": "e1", "lat": 50.45, "lon": 30.52, "geo_radius_km": 5.0},
        {"id": "e2", "lat": 60.0, "lon": 60.0, "geo_radius_km": 5.0},
    ]
    reversed_events = list(reversed(forward))

    doc_forward = infra_risk.build_document(forward, index, _counts(dam=1, port=1), NOW)
    doc_reversed = infra_risk.build_document(reversed_events, index, _counts(dam=1, port=1), NOW)

    expected = ["dam:aaa_first", "port:zzz_last"]  # site_id ascending
    assert [s["site_id"] for s in doc_forward["top"]] == expected
    assert [s["site_id"] for s in doc_reversed["top"]] == expected


def test_top_n_caps_the_ranked_list():
    sites = [
        {"lat": 10.0, "lon": float(i), "site_id": f"dam:{i:03d}", "category": "dam", "name": f"Dam {i}"}
        for i in range(infra_risk.TOP_N + 5)
    ]
    index = _index_with(*sites)
    events = [
        {"id": f"e{i}", "lat": 10.0, "lon": float(i), "geo_radius_km": 1.0}
        for i in range(infra_risk.TOP_N + 5)
    ]
    doc = infra_risk.build_document(events, index, _counts(dam=len(sites)), NOW)
    assert len(doc["top"]) == infra_risk.TOP_N


# ---------- document shape ----------


def test_the_document_carries_its_own_window_timestamp_and_causation_caveat():
    doc = infra_risk.build_document([], ProximityIndex([]), _counts(), NOW)
    assert doc["window_days"] == infra_risk.WINDOW_DAYS
    assert doc["as_of"] == NOW
    assert "not causation" in doc["note"]


def test_category_counts_pass_through_unchanged():
    counts = _counts(dam=3, power_plant=1, cable_landing=0, airfield=12, port=7)
    doc = infra_risk.build_document([], ProximityIndex([]), counts, NOW)
    assert doc["category_counts"] == counts


def test_an_empty_input_is_not_an_error():
    doc = infra_risk.build_document([], ProximityIndex([]), _counts(), NOW)
    assert doc["top"] == []
    assert doc["events_searched"] == 0
    assert doc["events_without_radius"] == 0


def test_an_event_with_no_coordinate_is_counted_under_its_own_bucket_not_dropped():
    """conflict_events.lat/lon are nullable at the schema level even though
    the only writer refuses to insert a row without them (see storage.py).
    A coordinate-less row cannot be searched at all -- there is no point to
    draw a circle around -- and it must not vanish from every count: it is
    neither `events_searched` (nothing was searched) nor
    `events_without_radius` (that bucket means "we know where this
    happened, just not how sure we are") -- it gets its own
    `events_missing_coordinate` bucket instead."""
    index = ProximityIndex([{"lat": 10.0, "lon": 10.0, "site_id": "dam:1", "category": "dam", "name": "Dam"}])
    events = [{"id": "e1", "lat": None, "lon": None, "geo_radius_km": 5.0}]
    doc = infra_risk.build_document(events, index, _counts(dam=1), NOW)
    assert doc["events_searched"] == 0
    assert doc["events_without_radius"] == 0
    assert doc["events_missing_coordinate"] == 1
    assert doc["top"] == []


def test_a_missing_coordinate_and_a_missing_radius_are_counted_in_different_buckets():
    events = [
        {"id": "e1", "lat": None, "lon": None, "geo_radius_km": 5.0},  # no coordinate at all
        {"id": "e2", "lat": 10.0, "lon": 10.0, "geo_radius_km": None},  # a real place, just no radius
    ]
    doc = infra_risk.build_document(events, ProximityIndex([]), _counts(), NOW)
    assert doc["events_missing_coordinate"] == 1
    assert doc["events_without_radius"] == 1
    assert doc["events_searched"] == 0


def test_missing_coordinate_count_defaults_to_zero_and_is_always_present():
    doc = infra_risk.build_document([], ProximityIndex([]), _counts(), NOW)
    assert doc["events_missing_coordinate"] == 0
    assert "events_missing_coordinate" in doc
