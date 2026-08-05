"""Fusion tests: geographic precision, clustering, identity and severity.

Everything here is pure -- no registry, no network, no database.
"""

from backend.sources import event_fusion as ef


def _gdelt(**over) -> dict:
    base = {
        "event_id": "1", "lat": 46.6, "lon": 32.6, "date_added": "20260805101500",
        "event_root_code": 19, "event_code": "190", "mentions": 3, "goldstein": -10.0,
        "avg_tone": -6.0, "location": "Kherson, Khersons'ka Oblast', Ukraine",
        "geo_precision": "locality", "geo_feature_id": "-1041356",
        "actor1": "RUSSIA", "actor2": "AIR FORCE", "actor2_type": "MIL",
        "source_url": "https://www.reuters.com/x",
    }
    base.update(over)
    return base


def _structured(**over) -> dict:
    base = {
        "id": "SDN1234", "lat": 15.5, "lon": 32.5, "date": "2026-08-04",
        "event_type": "Battle", "sub_event_type": "Armed clash",
        "actor1": "RSF", "actor2": "SAF", "fatalities": 12,
        "country": "Sudan", "notes": "Clashes in Omdurman", "source": "acled",
    }
    base.update(over)
    return base


# --- precision propagation -------------------------------------------------

def test_gdelt_precision_survives_normalisation():
    assert ef._normalize_gdelt(_gdelt())["geo_precision"] == "locality"
    assert ef._normalize_gdelt(_gdelt(geo_precision="country"))["geo_precision"] == "country"
    # A row that predates the field must not become silently "locality".
    stripped = _gdelt()
    del stripped["geo_precision"]
    assert ef._normalize_gdelt(stripped)["geo_precision"] == "unknown"


def test_structured_sources_are_locality_precision():
    assert ef._normalize_structured("acled", _structured())["geo_precision"] == "locality"


def test_coordinate_comes_from_the_most_precise_member_not_the_richest_source():
    """ACLED outranks GDELT for prose, but not for knowing where it happened.

    The failure this pins: a country-centroid ACLED row merged with a
    city-precise GDELT row used to place the pin on the centroid, because the
    merged record took its coordinates from whichever source had priority.
    """
    imprecise_acled = ef._normalize_structured("acled", _structured(lat=12.0, lon=30.0))
    imprecise_acled["geo_precision"] = "country"
    precise_gdelt = ef._normalize_gdelt(_gdelt(lat=15.6, lon=32.5, geo_precision="locality"))

    merged = ef._merge_cluster([imprecise_acled, precise_gdelt])

    assert (merged["lat"], merged["lon"]) == (15.6, 32.5), "should take the precise coordinate"
    assert merged["geo_precision"] == "locality"
    # ...while still taking its narrative from the curated source.
    assert merged["source"] == "acled"
    assert merged["actor1"] == "RSF"
    assert merged["fatalities"] == 12


def test_merged_record_carries_precision_and_feature_id():
    merged = ef._merge_cluster([ef._normalize_gdelt(_gdelt())])
    assert merged["geo_precision"] == "locality"
    assert merged["geo_feature_id"] == "-1041356"


# --- dates -----------------------------------------------------------------

def test_event_date_comes_from_sqldate_not_ingest_time():
    """The pipeline used to date every event by when GDELT ingested it."""
    normalized = ef._normalize_gdelt(_gdelt(event_date="20260803", date_added="20260805101500"))
    assert normalized["dt"].date().isoformat() == "2026-08-03"


def test_retrospective_reports_are_rejected():
    # A story filed today about something a year ago is not a live event.
    old = _gdelt(event_date="20250805", date_added="20260805101500")
    assert ef._gdelt_event_dt(old) is None
    # Ordinary reporting lag is not retrospective.
    lagged = _gdelt(event_date="20260801", date_added="20260805101500")
    assert ef._gdelt_event_dt(lagged).date().isoformat() == "2026-08-01"


def test_missing_sqldate_falls_back_to_ingest_time():
    no_date = _gdelt(event_date=None)
    assert ef._gdelt_event_dt(no_date).date().isoformat() == "2026-08-05"


def test_undated_rows_never_reach_the_map():
    fused = ef._fuse([], [_gdelt(event_date="20250805", date_added="20260805101500")])
    assert fused == []


# --- country and labels ----------------------------------------------------

def test_country_is_extracted_from_the_place_string():
    """This is the bug that made every country card's conflict list empty."""
    assert ef._country_from_location("Kherson, Khersons'ka Oblast', Ukraine") == "Ukraine"
    assert ef._country_from_location("Sudan") == "Sudan"
    assert ef._country_from_location("") is None
    assert ef._country_from_location(None) is None


def test_normalized_gdelt_keeps_place_and_country_separate():
    normalized = ef._normalize_gdelt(_gdelt())
    assert normalized["country"] == "Ukraine"
    assert normalized["location"] == "Kherson, Khersons'ka Oblast', Ukraine"


def test_cameo_labels_prefer_the_specific_act():
    assert ef._cameo_label("195", "195", 19) == "Aerial bombardment"
    assert ef._cameo_label("194", "194", 19) == "Artillery or armour"
    assert ef._cameo_label("1831", "183", 18) == "Suicide bombing"
    assert ef._cameo_label("202", "202", 20) == "Mass killing"
    # A 4-digit code with no entry of its own falls back to its parent...
    assert ef._cameo_label("1954", "195", 19) == "Aerial bombardment"
    # ...and an unknown code falls back to the 20-bucket root label.
    assert ef._cameo_label("199", None, 19) == "Fighting"
    assert ef._cameo_label(None, None, 19) == "Fighting"


def test_specific_label_reaches_the_fused_record():
    fused = ef._fuse([], [_gdelt(event_code="195", event_base_code="195")])
    assert fused[0]["event_type"] == "Aerial bombardment"
    assert fused[0]["event_code"] == "195"


# --- severity --------------------------------------------------------------

def _rec(**over) -> dict:
    base = {
        "event_type": "Small-arms fighting", "fatalities": 0, "outlet_count": 1,
        "corroborated_by": ["gdelt"], "goldstein": -10.0, "geo_precision": "locality",
    }
    base.update(over)
    return base


def test_imprecise_events_score_below_identical_precise_ones():
    precise = ef._severity_for(_rec(geo_precision="locality"))
    centroid = ef._severity_for(_rec(geo_precision="country"))
    assert centroid < precise, "an event we cannot place is less actionable"


def test_severity_rises_with_casualties_outlets_and_datasets():
    base = ef._severity_for(_rec())
    assert ef._severity_for(_rec(fatalities=40)) > base
    assert ef._severity_for(_rec(outlet_count=12)) > base
    assert ef._severity_for(_rec(corroborated_by=["acled", "gdelt"])) > base


def test_severity_is_bounded():
    extreme = _rec(event_type="Ethnic cleansing", fatalities=100000, outlet_count=9999,
                   corroborated_by=["acled", "ucdp", "gdelt"], jamming_nearby=0.9,
                   thermal_nearby=True)
    assert 0 <= ef._severity_for(extreme) <= 100
    assert ef._severity_for(_rec(event_type=None, goldstein=None, outlet_count=0)) >= 0


def test_a_single_unverified_report_scores_below_the_alert_threshold():
    """The calibration this pins: NotableEventsPanel's floor is 40. Under the
    old additive formula a lone unsourced row scored 25-45, so noise rendered
    orange and reached the alert panel."""
    lone = ef._severity_for(_rec(event_type="Small-arms fighting", outlet_count=1))
    assert lone < 40, f"an uncorroborated single report scored {lone}"
    # The same event carried by a dozen newsrooms is a different claim.
    well_sourced = ef._severity_for(_rec(event_type="Small-arms fighting", outlet_count=12))
    assert well_sourced > lone


def test_dataset_corroboration_is_not_discounted_for_being_thin():
    """A lone-outlet report that ACLED independently recorded should not be
    penalised for being lone-outlet -- evidence is added outside the discount."""
    lone = ef._severity_for(_rec(outlet_count=1, corroborated_by=["gdelt"]))
    confirmed = ef._severity_for(_rec(outlet_count=1, corroborated_by=["acled", "gdelt"]))
    assert confirmed >= lone + 20


def test_mass_violence_outranks_generic_force():
    assert ef._severity_for(_rec(event_type="Mass killing")) > \
           ef._severity_for(_rec(event_type="Use of conventional force"))
    # "Mass killing" must not be shadowed by the shorter "Killing" key.
    assert ef._severity_for(_rec(event_type="Mass killing")) > \
           ef._severity_for(_rec(event_type="Killing"))


# --- corroboration semantics ------------------------------------------------

def test_corroboration_distinguishes_outlets_from_datasets():
    _reset_identity()
    many_outlets = ef._fuse([], [_gdelt(outlet_count=9)])[0]
    assert many_outlets["corroboration"] == "multi_outlet"
    assert many_outlets["corroborated"] is True
    assert many_outlets["corroborated_by"] == ["gdelt"], "still only one dataset"

    _reset_identity()
    lone = ef._fuse([], [_gdelt(outlet_count=1)])[0]
    assert lone["corroboration"] == "single"
    assert lone["corroborated"] is False

    _reset_identity()
    two_datasets = ef._fuse([_structured(lat=46.6, lon=32.6, date="2026-08-05")],
                            [_gdelt(outlet_count=1)])[0]
    assert two_datasets["corroboration"] == "multi_dataset"


def test_verified_outlet_names_survive_the_merge():
    _reset_identity()
    fused = ef._fuse([], [_gdelt(verified_outlets=["Reuters", "BBC News"])])[0]
    assert fused["verified_outlets"] == ["BBC News", "Reuters"]


# --- who reported it --------------------------------------------------------
#
# outlet_count answers "how many"; these pin the "which ones" that the popup
# used to be unable to answer for anything off the verified-domain allowlist.

def test_outlet_names_survive_normalisation_from_either_input():
    from_gdelt = ef._normalize_gdelt(_gdelt(outlets=["Reuters", "kyivpost.com"]))
    assert from_gdelt["outlets"] == ["Reuters", "kyivpost.com"]
    # ACLED/UCDP get theirs from their own source columns (see acled.py).
    from_acled = ef._normalize_structured("acled", _structured(outlets=["Radio Dabanga"]))
    assert from_acled["outlets"] == ["Radio Dabanga"]
    # A row from before the field existed must not blow up.
    assert ef._normalize_gdelt(_gdelt())["outlets"] == []


def test_merge_names_outlets_from_every_dataset_not_just_gdelt():
    """An ACLED row merged with a GDELT row was reported by both datasets'
    sources -- naming only GDELT's would understate the coverage the outlet
    count directly above it already claims."""
    _reset_identity()
    fused = ef._fuse(
        [_structured(lat=46.6, lon=32.6, date="2026-08-05", outlets=["Radio Dabanga"])],
        [_gdelt(outlets=["Reuters"])],
    )[0]
    assert fused["corroboration"] == "multi_dataset", "fixture must actually merge"
    # Mastheads first, then the rest -- see backend/sources/outlets.py.
    assert fused["outlets"] == ["Reuters", "Radio Dabanga"]


def test_merged_outlet_list_is_capped():
    _reset_identity()
    crowded = [f"local-{i}.example" for i in range(20)]
    fused = ef._fuse([], [_gdelt(outlets=crowded, outlet_count=20)])[0]
    assert len(fused["outlets"]) == 8
    assert fused["outlet_count"] == 20, "the true total is not capped with it"


def test_naming_outlets_does_not_move_severity():
    """The names are display data. outlet_count remains the only outlet input
    to the score, so adding them cannot shift map colours or the alert ranking."""
    without = ef._severity_for(_rec(outlet_count=4))
    with_names = ef._severity_for(_rec(outlet_count=4, outlets=["Reuters", "AP News"]))
    assert with_names == without


# --- cluster identity ------------------------------------------------------

def _reset_identity():
    ef._cluster_id_by_member = {}
    ef._cluster_minted_at = {}
    ef._superseded_ids = []


def test_a_cluster_keeps_its_id_when_it_gains_a_member():
    """The failure this pins: a re-keyed cluster inserts a new archive row with
    a fresh first_seen, and escalation.py counts first_seen -- so re-keying
    manufactured incidents out of thin air."""
    _reset_identity()
    first = ef._fuse([], [_gdelt(event_id="100")])
    original_id = first[0]["id"]

    # A second report of the same incident arrives, close in space and time.
    second = ef._fuse([], [_gdelt(event_id="100"), _gdelt(event_id="101", lat=46.61, lon=32.62)])
    assert len(second) == 1, "both reports describe one incident"
    assert second[0]["id"] == original_id, "the incident must keep its identity"


def test_a_higher_priority_source_joining_does_not_re_key():
    _reset_identity()
    first = ef._fuse([], [_gdelt(event_id="200")])
    original_id = first[0]["id"]

    # ACLED outranks GDELT and becomes the primary member...
    joined = ef._fuse([_structured(id="A1", lat=46.6, lon=32.6, date="2026-08-05")],
                      [_gdelt(event_id="200")])
    assert len(joined) == 1
    assert joined[0]["source"] == "acled", "prose comes from the richer source"
    assert joined[0]["id"] == original_id, "...but identity does not change hands"


def test_merging_two_clusters_supersedes_the_younger_id():
    _reset_identity()
    # No shared FeatureID, so distance alone decides. ~90km apart: separate.
    ef._fuse([], [_gdelt(event_id="300", lat=46.6, lon=32.6, geo_feature_id=None),
                  _gdelt(event_id="301", lat=47.4, lon=33.5, geo_feature_id=None)])
    assert len(ef._cluster_minted_at) == 2

    # A third report lands between them, bridging the two into one incident.
    bridged = ef._fuse([], [_gdelt(event_id="300", lat=46.6, lon=32.6, geo_feature_id=None),
                            _gdelt(event_id="301", lat=47.0, lon=33.0, geo_feature_id=None),
                            _gdelt(event_id="302", lat=46.8, lon=32.8, geo_feature_id=None)])
    assert len(bridged) == 1
    assert len(ef._superseded_ids) == 1, "the losing id must be deleted, not left to double-count"
    assert ef._superseded_ids[0] != bridged[0]["id"]


def test_new_ids_are_deterministic_regardless_of_input_order():
    _reset_identity()
    a = ef._fuse([], [_gdelt(event_id="400"), _gdelt(event_id="401", lat=10.0, lon=10.0)])
    _reset_identity()
    b = ef._fuse([], [_gdelt(event_id="401", lat=10.0, lon=10.0), _gdelt(event_id="400")])
    assert sorted(r["id"] for r in a) == sorted(r["id"] for r in b)


def test_ingested_at_is_the_earliest_observation_in_the_cluster():
    _reset_identity()
    fused = ef._fuse([], [_gdelt(event_id="500", _seen_at=1000.0),
                          _gdelt(event_id="501", lat=46.61, _seen_at=900.0)])
    assert fused[0]["ingested_at"] == 900.0


# --- clustering ------------------------------------------------------------

def _pt(lat, lon, **over):
    row = _gdelt(lat=lat, lon=lon, geo_feature_id=None, **over)
    return ef._normalize_gdelt(row)


def test_match_radius_is_the_same_distance_at_every_latitude():
    """The old degree box was ~55km east-west at the equator but ~28km at 60N,
    so identical events clustered in Africa and fragmented in Ukraine."""
    # 40 km apart in longitude, at the equator and at 65N. Both must cluster.
    for lat, lon_delta in ((0.0, 0.359), (65.0, 0.850)):
        near = ef._cluster([_pt(lat, 0.0), _pt(lat, lon_delta)])
        assert len(near) == 1, f"40km apart at {lat}N should be one incident"

    # ~60 km apart at both latitudes. Neither may cluster.
    for lat, lon_delta in ((0.0, 0.60), (65.0, 1.42)):
        far = ef._cluster([_pt(lat, 0.0), _pt(lat, lon_delta)])
        assert len(far) == 2, f"60km apart at {lat}N should stay separate"


def test_clustering_is_transitive():
    """A near B, B near C, A far from C must yield one incident, not two or
    three. The old seed-only loop compared everything against the seed alone."""
    clusters = ef._cluster([_pt(0.0, 0.0), _pt(0.0, 0.40), _pt(0.0, 0.80)])
    assert len(clusters) == 1
    assert len(clusters[0]) == 3


def test_events_across_the_antimeridian_cluster():
    clusters = ef._cluster([_pt(0.0, 179.9), _pt(0.0, -179.9)])
    assert len(clusters) == 1, "+180 and -180 are 22km apart, not 40,000km"


def test_shared_feature_id_clusters_without_a_distance_test():
    # Same GDELT place id, coordinates that differ more than _MATCH_KM.
    a = ef._normalize_gdelt(_gdelt(event_id="1", lat=46.6, lon=32.6, geo_feature_id="-1041356"))
    b = ef._normalize_gdelt(_gdelt(event_id="2", lat=47.9, lon=33.9, geo_feature_id="-1041356"))
    assert len(ef._cluster([a, b])) == 1


def test_shared_place_but_different_act_does_not_cluster():
    """An abduction (root 18) and an airstrike (root 19) in one city on one day
    are two incidents that happen to share a geocode."""
    a = ef._normalize_gdelt(_gdelt(event_id="1", lat=46.6, lon=32.6,
                                   geo_feature_id="-1041356", event_root_code=18,
                                   event_code="181"))
    b = ef._normalize_gdelt(_gdelt(event_id="2", lat=47.9, lon=33.9,
                                   geo_feature_id="-1041356", event_root_code=19,
                                   event_code="195"))
    assert len(ef._cluster([a, b])) == 2


def test_events_more_than_the_match_window_apart_stay_separate():
    a = _pt(46.6, 32.6, event_date="20260801", date_added="20260801101500")
    b = _pt(46.6, 32.6, event_date="20260805", date_added="20260805101500")
    assert len(ef._cluster([a, b])) == 2


def test_clustering_scales(benchmark_size=3000):
    """Guard against reintroducing the O(n^2) scan. 3000 rows is well above
    the measured steady-state volume (~200 violent rows/day)."""
    import time as _time
    items = [_pt(20.0 + (i % 400) * 0.1, 30.0 + (i % 397) * 0.1) for i in range(benchmark_size)]
    started = _time.perf_counter()
    ef._cluster(items)
    assert _time.perf_counter() - started < 5.0


# --- precision policy ------------------------------------------------------

def test_drop_policy_removes_only_country_precision(monkeypatch):
    records = [
        {"geo_precision": "country", "id": "a"},
        {"geo_precision": "locality", "id": "b"},
        {"geo_precision": "region", "id": "c"},
    ]
    monkeypatch.setattr(ef, "COUNTRY_CENTROID_POLICY", "drop")
    assert [r["id"] for r in ef._apply_precision_policy(records)] == ["b", "c"]


def test_keep_and_demote_policies_pass_every_record_through(monkeypatch):
    records = [{"geo_precision": "country", "id": "a"}, {"geo_precision": "locality", "id": "b"}]
    for policy in ("keep", "demote"):
        monkeypatch.setattr(ef, "COUNTRY_CENTROID_POLICY", policy)
        assert len(ef._apply_precision_policy(records)) == 2


def test_aggregate_policy_collapses_a_country_day_into_one_record(monkeypatch):
    records = [
        {"geo_precision": "country", "country": "Sudan", "date": "2026-08-05",
         "event_type": "Fighting", "severity": 30, "fatalities": 2, "id": "a"},
        {"geo_precision": "country", "country": "Sudan", "date": "2026-08-05",
         "event_type": "Fighting", "severity": 55, "fatalities": 9, "id": "b"},
        {"geo_precision": "locality", "country": "Ukraine", "date": "2026-08-05",
         "event_type": "Fighting", "severity": 40, "fatalities": 0, "id": "c"},
    ]
    monkeypatch.setattr(ef, "COUNTRY_CENTROID_POLICY", "aggregate")
    out = ef._apply_precision_policy(records)

    assert len(out) == 2, "the two Sudan centroid rows collapse, Ukraine is untouched"
    sudan = next(r for r in out if r["country"] == "Sudan")
    assert sudan["id"] == "b", "the highest-severity member represents the group"
    assert sudan["cluster_size"] == 2
    assert sudan["fatalities"] == 9


# --- plain-language summaries ---------------------------------------------
#
# The generated sentence is a rendering of coded fields, never an extra claim,
# so these assert the mapping is faithful -- including that it stays silent
# rather than inventing a subject or a verb it does not have.

def test_summary_reads_as_a_sentence_with_both_actors():
    record = {
        "event_code": "195", "event_base_code": "195", "event_root_code": 19,
        "actor1": "RUSSIA", "actor1_type": "MIL", "actor1_group": None,
        "actor2": "UKRAINE", "actor2_type": None, "actor2_group": None,
        "location": "Kherson, Khersons'ka Oblast', Ukraine", "country": "Ukraine",
    }
    assert ef._build_summary(record) == (
        "Russia (armed forces) carried out an air strike on Ukraine "
        "in Kherson, Khersons'ka Oblast', Ukraine."
    )


def test_summary_drops_the_dangling_preposition_when_no_target_is_coded():
    record = {
        "event_code": "195", "event_base_code": "195", "event_root_code": 19,
        "actor1": "MILITARY", "actor1_type": "MIL", "actor2": None,
        "location": "Kherson", "country": "Ukraine",
    }
    summary = ef._build_summary(record)
    # No "(armed forces)" -- the actor's own name already says that, see
    # _ROLE_REDUNDANT.
    assert summary == "Military carried out an air strike in Kherson."
    assert " on in " not in summary


def test_summary_prefers_a_named_group_over_the_generic_actor_name():
    record = {
        "event_code": "183", "event_base_code": "183", "event_root_code": 18,
        "actor1": "PALESTINIAN", "actor1_group": "HAMAS", "actor1_type": "REB",
        "actor2": "ISRAEL", "location": "Gaza", "country": "Israel",
    }
    assert ef._build_summary(record).startswith("Hamas (rebel group) bombed Israel")


def test_summary_is_none_when_no_actor_was_coded():
    record = {"event_code": "190", "event_root_code": 19, "actor1": None, "actor2": None}
    assert ef._build_summary(record) is None


def test_summary_is_none_for_a_non_violent_code():
    record = {"event_code": "042", "event_root_code": 4, "actor1": "RUSSIA", "actor2": "UKRAINE"}
    assert ef._build_summary(record) is None


def test_clean_location_drops_the_repeated_country_and_general_suffix():
    assert ef._clean_location("Jerusalem, Israel (general), Israel") == "Jerusalem, Israel"
    assert ef._clean_location("Kherson, Khersons'ka Oblast', Ukraine") == (
        "Kherson, Khersons'ka Oblast', Ukraine"
    )
    assert ef._clean_location("Ukraine") == "Ukraine"
    assert ef._clean_location(None) is None


# --- reported vs. absent casualty counts -----------------------------------

def test_gdelt_row_without_a_headline_reports_no_casualty_figure():
    normalized = ef._normalize_gdelt({
        "event_id": "1", "lat": 1.0, "lon": 2.0, "real_title": None,
        "location": "Kherson, Ukraine", "event_code": "195", "event_root_code": 19,
    })
    assert normalized["fatalities"] == 0
    assert normalized["fatalities_reported"] is False, (
        "0 here means nobody counted, not that nobody was hurt"
    )


def test_structured_sources_always_report_their_count():
    normalized = ef._normalize_structured("ucdp", {"id": "x", "fatalities": 0, "date": "2026-08-05"})
    assert normalized["fatalities_reported"] is True


def test_severity_reasons_name_the_factors_that_moved_the_score():
    reasons: list[str] = []
    ef._severity_for(
        {"event_type": "Aerial bombardment", "fatalities": 0, "fatalities_reported": False,
         "outlet_count": 1, "corroborated_by": ["gdelt"], "geo_precision": "country",
         "notes": None},
        reasons,
    )
    assert "no casualty figure reported" in reasons
    assert "reported by a single outlet" in reasons
    assert "location known only approximately" in reasons
    assert "no article text, coded fields only" in reasons


def test_severity_reasons_do_not_repeat_the_outlet_count():
    # corroborationLine in the frontend already states it; saying it twice made
    # the reason list read as padding.
    reasons: list[str] = []
    ef._severity_for(
        {"event_type": "Small-arms fighting", "fatalities": 0, "fatalities_reported": False,
         "outlet_count": 4, "corroborated_by": ["gdelt"], "geo_precision": "locality",
         "notes": None},
        reasons,
    )
    assert not any("outlet" in r for r in reasons)


def test_actor_acronyms_survive_title_casing():
    assert ef._pretty_actor("UNO", None, "IGO") == "UN (international organisation)"
    assert ef._pretty_actor("NATO", None, "MIL") == "NATO (armed forces)"


def test_role_is_not_repeated_when_the_name_already_says_it():
    assert ef._pretty_actor("MILITARY", None, "MIL") == "Military"
    assert ef._pretty_actor("POLICE", None, "COP") == "Police"
    assert ef._pretty_actor("ISRAELI", None, "MIL") == "Israeli (armed forces)"


def test_actor_is_none_when_cameo_coded_nothing():
    assert ef._pretty_actor(None, None, "MIL") is None
    assert ef._pretty_actor("  ", None, None) is None


def test_a_raw_known_group_code_never_reaches_the_screen():
    """GDELT ships Actor1KnownGroupCode as a bare three-letter CAMEO code, so
    preferring the group unconditionally rendered "Tal (insurgents)" for the
    Taliban -- a word-shaped string that reads as somebody's name."""
    # Codes we can expand, expand.
    assert ef._pretty_actor("TALIBAN", "TAL", "INS") == "Taliban (insurgents)"
    assert ef._pretty_actor("SAUDI", "ALQ", "REB") == "al-Qaeda (rebel group)"
    # One we cannot falls back to the name, which GDELT fills in legibly.
    assert ef._pretty_actor("TALIBAN", "XYZ", "INS") == "Taliban (insurgents)"
    # A group that is already a readable name is still preferred over the
    # coder's bucket -- that is the behaviour this must not regress.
    assert ef._pretty_actor("PALESTINIAN", "HAMAS", "REB") == "Hamas (rebel group)"
    # A short group that is a recognised acronym is a name, not an opaque code.
    assert ef._pretty_actor("TURKISH", "PKK", "SEP") == "PKK (separatists)"


# --- commentary and retrospectives are not live events ----------------------

def test_a_magazine_retrospective_is_not_a_conflict_event():
    """The bug this pins: GDELT stamps a magazine feature about a 2002 bombing
    with *today's* SQLDATE, so _gdelt_event_dt's report-lag gate sees zero lag
    and lets it through. One Atlantic essay put a suicide bombing on the map in
    Tunisia, dated today, actors "Tunisian (rebel group)" and "Tal"."""
    essay = {
        "event_root_code": 18, "event_code": "1831", "actor1_type": "REB",
        "actor2_group": "TAL",
        "source_url": "https://www.theatlantic.com/magazine/2026/09/al-qaeda-25-years-post-9-11/687965/",
    }
    assert ef._is_violent_gdelt_row(essay) is False
    # The same coded event from a news dispatch is exactly what the layer is for.
    dispatch = {**essay, "source_url": "https://www.reuters.com/world/africa/tunis-blast-2026-08-05/"}
    assert ef._is_violent_gdelt_row(dispatch) is True


def test_the_section_filter_does_not_thin_ordinary_reporting():
    for url in (
        "https://www.reuters.com/world/europe/strike-on-kherson-2026-08-05/",
        "https://apnews.com/article/sudan-rsf-omdurman-abc123",
        None,
    ):
        row = _gdelt(event_root_code=19, event_code="195", actor1_type="MIL", source_url=url)
        assert ef._is_violent_gdelt_row(row) is True, url


# --- coverage: merged headlines are relocated, not deleted ------------------
#
# The old behaviour deduplicated the map by deleting the article: any GDELT
# headline folded into a fused record was dropped from /api/news, so it then
# appeared nowhere -- not in the news feed, not in the country card, and not on
# the pin that had absorbed it. The record carries the headlines now, plus the
# news ids behind them so the frontend can suppress just the redundant marker.

def _titled(event_id, title, url, outlet="Reuters", added="20260805101500", **over):
    return _gdelt(event_id=event_id, real_title=title, source_url=url,
                  source_name=outlet, date_added=added, **over)


def test_a_merged_headline_survives_on_the_record():
    record = ef._merge_cluster([
        ef._normalize_gdelt(_titled("1", "Strike hits Kherson apartment block",
                                    "https://www.reuters.com/a", "Reuters")),
    ])
    assert record["coverage"] == [{
        "event_id": "1",
        "title": "Strike hits Kherson apartment block",
        "url": "https://www.reuters.com/a",
        "outlet": "Reuters",
        "published": "20260805101500",
    }]


def test_every_gdelt_member_is_named_for_marker_suppression():
    """Including members with no headline of their own: an untitled row still
    owns a news id, and leaving it out puts a bare News pin back on top of the
    conflict pin it belongs to."""
    record = ef._merge_cluster([
        ef._normalize_gdelt(_titled("1", "A headline", "https://www.reuters.com/a", "Reuters")),
        ef._normalize_gdelt(_gdelt(event_id="2", real_title=None)),
    ])
    assert sorted(record["coverage_event_ids"]) == ["1", "2"]
    assert len(record["coverage"]) == 1


def test_an_acled_only_cluster_carries_no_coverage():
    record = ef._merge_cluster([ef._normalize_structured("acled", _structured())])
    assert record["coverage"] == []
    assert record["coverage_event_ids"] == []


def test_a_singleton_gdelt_cluster_still_owns_its_headline():
    """This is the case the old len(sources) > 1 condition excluded, and it is
    the common one: most conflict pins are GDELT-only, so most headlines were
    rendering twice -- once as a News pin and once as the pin's own notes."""
    record = ef._merge_cluster([
        ef._normalize_gdelt(_titled("7", "Shelling reported", "https://apnews.com/x", "AP News")),
    ])
    assert record["coverage_event_ids"] == ["7"]


def test_two_rows_citing_one_article_are_one_piece_of_coverage():
    """GDELT codes different actor pairs out of the same article as separate
    rows. That is two ids and one report."""
    record = ef._merge_cluster([
        ef._normalize_gdelt(_titled("1", "Same story", "https://www.reuters.com/same")),
        ef._normalize_gdelt(_titled("2", "Same story", "https://www.reuters.com/same")),
    ])
    assert len(record["coverage"]) == 1
    assert sorted(record["coverage_event_ids"]) == ["1", "2"]


def test_coverage_is_newest_first_and_bounded():
    members = [
        ef._normalize_gdelt(_titled(str(i), f"Report {i}", f"https://www.reuters.com/{i}",
                                    "Reuters", added=f"202608051{i:02d}00"))
        for i in range(12)
    ]
    record = ef._merge_cluster(members)
    assert len(record["coverage"]) == ef.MAX_COVERAGE_ITEMS
    published = [c["published"] for c in record["coverage"]]
    assert published == sorted(published, reverse=True)


def test_the_outlet_falls_back_to_the_domain_when_gdelt_named_none():
    record = ef._merge_cluster([
        ef._normalize_gdelt(_titled("1", "A headline", "https://www.bbc.com/news/x", None)),
    ])
    assert record["coverage"][0]["outlet"] == "BBC News"
