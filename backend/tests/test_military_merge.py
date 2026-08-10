"""backend/infrastructure.py's merge_military_bases: the curated MILITARY_BASES
list beside osm_infra.py's own military=* sweep, provenance kept apart per Task
28's pattern (see osm_infra.py's module docstring) -- and, unlike the
refinery/storage merge that pattern was built for, not double-counted when the
same physical installation shows up in both.

Pure functions over plain dicts, so no network and no database are needed --
same discipline test_osm_infra.py already holds its own parsing to.
"""

import pytest

from backend import infrastructure


def curated(id_="al_udeid_ab", lat=25.12, lon=51.32, **extra):
    return {
        "id": id_, "name": "Al Udeid Air Base", "type": "military", "subtype": "air",
        "lat": lat, "lon": lon, "region_keys": ["persian_gulf_hormuz"],
        "note": "Largest US military installation in the Middle East.",
        **extra,
    }


def osm_site(kind="military_airfield", lat=25.12, lon=51.32, id_="osm:way/1", **extra):
    return {
        "id": id_, "osm_type": "way", "osm_id": 1, "kind": kind,
        "lat": lat, "lon": lon, "name": "Al Udeid", "named": True,
        "operator": None, "region_key": "persian_gulf_hormuz",
        **extra,
    }


# --- provenance is kept, never blended -------------------------------------


def test_every_curated_site_passes_through_stamped_curated():
    merged = infrastructure.merge_military_bases([curated()], [])
    assert len(merged) == 1
    assert merged[0]["source"] == "curated"
    # The curated record's own fields survive untouched -- this is a stamp,
    # not a rewrite.
    assert merged[0]["name"] == "Al Udeid Air Base"
    assert merged[0]["subtype"] == "air"


def test_a_matching_osm_site_is_kept_as_its_own_record_stamped_osm():
    """The whole point of "presentation-level pairing, never a data-model
    merge": an OSM site within range of a curated one is not folded into the
    curated record, it is a second, independently-sourced record that happens
    to name the first."""
    merged = infrastructure.merge_military_bases([curated()], [osm_site()])
    assert len(merged) == 2
    curated_rec, osm_rec = merged
    assert curated_rec["source"] == "curated"
    assert osm_rec["source"] == "osm"
    # The OSM record's own fields (its own name, its own OSM id) are untouched.
    assert osm_rec["name"] == "Al Udeid"
    assert osm_rec["id"] == "osm:way/1"


def test_a_matching_osm_site_is_flagged_with_the_curated_id_it_pairs():
    merged = infrastructure.merge_military_bases([curated(id_="al_udeid_ab")], [osm_site()])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert osm_rec["matched_curated_id"] == "al_udeid_ab"


def test_an_osm_site_with_no_nearby_curated_entry_carries_no_match_flag():
    far_away = osm_site(lat=10.0, lon=10.0)
    merged = infrastructure.merge_military_bases([curated()], [far_away])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert "matched_curated_id" not in osm_rec


# --- the match radius --------------------------------------------------------


def test_an_osm_centre_a_couple_of_kilometres_off_still_matches():
    """An OSM way's `out center` is a computed centroid of whatever polygon a
    mapper traced, which can land a couple of km from a hand-placed curated
    pin for the very same installation -- see BASE_MATCH_RADIUS_KM's own note."""
    nearby = osm_site(lat=25.14, lon=51.34)  # roughly 2.7km from 25.12,51.32
    merged = infrastructure.merge_military_bases([curated()], [nearby])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert osm_rec.get("matched_curated_id") == "al_udeid_ab"


def test_a_genuinely_separate_nearby_facility_does_not_match():
    beyond_radius = osm_site(lat=25.12 + 0.1, lon=51.32)  # ~11km north
    merged = infrastructure.merge_military_bases([curated()], [beyond_radius])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert "matched_curated_id" not in osm_rec


# --- only installation-comparable OSM kinds are considered ------------------


def test_a_landuse_military_area_is_not_pulled_into_the_bases_merge():
    """military_area (landuse=military) is the broader, fragment-heavy class
    osm_infra.py already keeps on the plain OSM infrastructure layer -- not a
    comparable claim to a curated installation, so it is left out here."""
    area = osm_site(kind="military_area")
    merged = infrastructure.merge_military_bases([curated()], [area])
    assert merged == [{**curated(), "source": "curated"}]


def test_a_power_plant_or_other_unrelated_osm_kind_is_ignored():
    other = osm_site(kind="power_plant")
    merged = infrastructure.merge_military_bases([], [other])
    assert merged == []


def test_every_task_29_installation_kind_is_accepted():
    for kind in [
        "military_airfield", "military_base", "military_naval_base",
        "military_training_area", "military_barracks", "military_danger_area",
    ]:
        merged = infrastructure.merge_military_bases([], [osm_site(kind=kind, lat=1.0, lon=1.0)])
        assert len(merged) == 1, kind
        assert merged[0]["source"] == "osm"


def test_the_air_defence_kinds_are_not_installation_kinds():
    """radar_station/military_bunker/military_checkpoint ride a separate,
    default-off layer with its own completeness caveat (Task 29 item 4) --
    they are not a claim comparable to a curated MILITARY_BASES entry and must
    not silently inflate a bases count."""
    for kind in infrastructure.AIR_DEFENSE_OSM_KINDS:
        assert kind not in infrastructure.MILITARY_OSM_KINDS


# --- not double-counting a site present in both -----------------------------


def test_count_distinct_bases_does_not_double_count_a_matched_pair():
    merged = infrastructure.merge_military_bases([curated()], [osm_site()])
    assert len(merged) == 2  # both records still present, provenance intact
    assert infrastructure.count_distinct_bases(merged) == 1  # one installation


def test_count_distinct_bases_counts_an_unmatched_osm_site_as_its_own_installation():
    far_away = osm_site(lat=-10.0, lon=100.0)
    merged = infrastructure.merge_military_bases([curated()], [far_away])
    assert infrastructure.count_distinct_bases(merged) == 2


def test_count_distinct_bases_on_an_empty_merge_is_zero():
    assert infrastructure.count_distinct_bases([]) == 0


def test_count_distinct_bases_with_only_curated_sites_counts_them_all():
    merged = infrastructure.merge_military_bases([curated(id_="a"), curated(id_="b", lat=1, lon=1)], [])
    assert infrastructure.count_distinct_bases(merged) == 2


def test_real_military_bases_list_merges_without_error():
    """A smoke test against the real, ~100-entry curated list rather than only
    small fixtures -- merge_military_bases must not assume a particular
    ordering or a particular field set beyond lat/lon/id."""
    merged = infrastructure.merge_military_bases(infrastructure.MILITARY_BASES, [])
    assert len(merged) == len(infrastructure.MILITARY_BASES)
    assert all(s["source"] == "curated" for s in merged)
    assert infrastructure.count_distinct_bases(merged) == len(infrastructure.MILITARY_BASES)


# --- Task 29 review (Important 1): ambiguous matches are refused, not guessed


def _real_base(base_id):
    return next(b for b in infrastructure.MILITARY_BASES if b["id"] == base_id)


def test_camp_lemonnier_and_jsdf_djibouti_are_the_real_failing_case():
    """The distance the review computed and the earlier docstring got wrong:
    these two are 1.56km apart, well inside BASE_MATCH_RADIUS_KM (5km) of a
    point near either one -- not "the closest case checked" and outside it,
    as this file's comment used to claim before anyone measured it."""
    lemonnier = _real_base("camp_lemonnier")
    jsdf = _real_base("jsdf_djibouti")
    from backend.sources.proximity import haversine_km
    distance = haversine_km(lemonnier["lat"], lemonnier["lon"], jsdf["lat"], jsdf["lon"])
    assert distance < infrastructure.BASE_MATCH_RADIUS_KM
    assert distance == pytest.approx(1.56, abs=0.05)


def test_an_osm_site_near_the_djibouti_cluster_is_not_matched_to_either():
    """An OSM centroid landing near Camp Lemonnier (documented drift of a
    couple of km is exactly what would put it here) must not be matched to
    Camp Lemonnier OR to JSDF Djibouti -- both curated points are within
    range, and claiming either as the match would be a coin flip stated as a
    fact, on the one layer where that fact is "which country's base this
    is"."""
    lemonnier = _real_base("camp_lemonnier")
    near_lemonnier = osm_site(kind="military_base", lat=lemonnier["lat"] + 0.005, lon=lemonnier["lon"])
    merged = infrastructure.merge_military_bases(infrastructure.MILITARY_BASES, [near_lemonnier])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert "matched_curated_id" not in osm_rec


def test_an_osm_site_far_from_any_cluster_still_matches_its_one_curated_neighbour():
    """The refusal is specific to ambiguity, not a blanket "never match near
    the real list" regression -- a curated site with no other curated
    installation nearby still gets a genuine, unambiguous match. Uses
    Pituffik/Thule (Greenland) rather than Camp Lemonnier for this: the whole
    Djibouti cluster (Camp Lemonnier, JSDF, Doraleh) sits close enough
    together that almost anywhere within range of one is within range of a
    second, which is the point of the two tests above, not this one."""
    thule = _real_base("thule_ab")
    near_thule_only = osm_site(kind="military_base", lat=thule["lat"] - 0.02, lon=thule["lon"] - 0.02)
    merged = infrastructure.merge_military_bases(infrastructure.MILITARY_BASES, [near_thule_only])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert osm_rec.get("matched_curated_id") == "thule_ab"


def test_two_curated_sites_within_radius_of_each_other_synthetic_case():
    """The same ambiguity rule, isolated from the real list's own noise (a
    third nearby curated site elsewhere would change which ones are "within
    radius" of the probe point) -- two curated sites 1.5km apart, an OSM site
    exactly between them, refused."""
    a = curated(id_="a", lat=10.0, lon=10.0)
    b = curated(id_="b", lat=10.0135, lon=10.0)  # ~1.5km north of a
    midpoint = osm_site(lat=10.007, lon=10.0)  # ~0.75km from each
    merged = infrastructure.merge_military_bases([a, b], [midpoint])
    osm_rec = next(s for s in merged if s["source"] == "osm")
    assert "matched_curated_id" not in osm_rec
    # Distinct-count arithmetic still holds: the unmatched OSM site is its
    # own installation, on top of the two curated ones.
    assert infrastructure.count_distinct_bases(merged) == 3
