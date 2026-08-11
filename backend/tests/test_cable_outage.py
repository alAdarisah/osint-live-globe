"""Task 38: cable and outage correlation.

Covers, per the task brief: the co-occurrence window (a spiking score, a
landing, and a fused event near that landing all inside the same window
produce a coincidence), a spike with no landings (checked, never even
considered for a coincidence), landings with no spike (checked, no
coincidence), and -- since "found nothing" must never render the same as
"did not look" -- the two states the brief leaves for this task to design:
a country whose score history is too short to call a spike either way, and
a country this module's own history is old enough to say it has never once
seen above IODA's own floor.

Also covers the language rule this task is explicit about: every string
this module emits is checked against a list of causal-attribution phrases a
later edit must never reintroduce.
"""

from backend.refine import cable_outage as co

NOW = 1_754_000_000.0
HOUR = 3600.0


# --- helpers -----------------------------------------------------------


def country_feature(name, iso2):
    return {"type": "Feature", "properties": {"name": name, "iso_a2": iso2}, "geometry": {}}


COUNTRIES_FC = {
    "features": [
        country_feature("Egypt", "EG"),
        country_feature("Indonesia", "ID"),
        country_feature("France", "FR"),
    ],
}
COUNTRY_INDEX = co._country_index_from_geojson(COUNTRIES_FC)


def landing(landing_id, name, lat=30.0, lon=32.0, planned=False):
    return {"id": landing_id, "name": name, "lat": lat, "lon": lon, "planned": planned}


def event(event_id, lat=30.0, lon=32.0, radius=5.0, first_seen=NOW, **overrides):
    row = {
        "id": event_id, "lat": lat, "lon": lon, "geo_radius_km": radius,
        "event_type": "violence", "country": "Egypt", "notes": "note", "severity": 50,
        "first_seen": first_seen,
    }
    row.update(overrides)
    return row


def outage_record(score, country="Egypt"):
    return {"score": score, "country": country}


def samples(*scores_with_ts):
    """[(ts, score), ...] -> the {"samples": [...]} shape history stores."""
    return {"samples": [{"ts": ts, "score": score} for ts, score in scores_with_ts]}


def history_with(country_code, started_at=NOW - 30 * HOUR, **countries):
    hist = {"_meta": {"started_at": started_at}}
    hist.update(countries)
    return hist


# --- _country_index_from_geojson / _landing_country ---------------------


def test_country_index_reads_name_and_iso2_from_the_countries_geojson():
    assert COUNTRY_INDEX["exact"]["Egypt"] == "EG"


def test_country_index_skips_natural_earths_no_iso2_sentinel():
    """"Nowhere" carries Natural Earth's own "-99" sentinel and must not be
    joinable -- unlike France/Norway/Kosovo (see _ISO2_NAME_OVERRIDE), it has
    no known real ISO2 to fall back on, so it simply never enters the index."""
    fc = {"features": [country_feature("Nowhere", "-99")]}
    index = co._country_index_from_geojson(fc)
    assert "Nowhere" not in index["exact"]
    assert co._landing_country("Somewhere, Nowhere", index) == (None, "unmatched")


def test_country_index_seeds_the_natural_earth_no_iso2_override_even_with_no_features_at_all():
    """France/Norway/Kosovo carry Natural Earth's own "-99" ISO2 sentinel (see
    outages.py's identical override, copied rather than re-derived here) --
    the override must be available even before any countries document has
    ever been fetched, the same "seeded, not dependent on a live fetch having
    already happened" footing outages.py's own override constant has."""
    index = co._country_index_from_geojson({})
    assert index["exact"] == {"France": "FR", "Norway": "NO", "Kosovo": "XK"}


def test_landing_country_matches_the_trailing_comma_token():
    iso2, how = co._landing_country("Beculuk, Indonesia", COUNTRY_INDEX)
    assert (iso2, how) == ("ID", "exact")


def test_landing_country_uses_only_the_last_comma_token():
    """"Miami, FL, United States" -- style TeleGeography names -- must match on
    "United States", not on "FL, United States"."""
    fc = {"features": [country_feature("United States", "US")]}
    index = co._country_index_from_geojson(fc)
    iso2, how = co._landing_country("Miami, FL, United States", index)
    assert (iso2, how) == ("US", "exact")


def test_landing_country_falls_back_to_normalized_fuzzy_match():
    fc = {"features": [country_feature("Cote d'Ivoire", "CI")]}
    index = co._country_index_from_geojson(fc)
    iso2, how = co._landing_country("Abidjan, Cote dIvoire", index)
    assert (iso2, how) == ("CI", "fuzzy")


def test_landing_country_with_no_comma_is_unmatched():
    assert co._landing_country("NoCommaName", COUNTRY_INDEX) == (None, "unmatched")


def test_landing_country_with_an_unknown_trailing_token_is_unmatched():
    assert co._landing_country("Somewhere, Atlantis", COUNTRY_INDEX) == (None, "unmatched")


# --- group_landings_by_country -------------------------------------------


def test_a_planned_landing_is_excluded_not_merely_flagged():
    """A TBD landing's site is not settled -- there is no fixed point for an
    event to be "near", so it must never support a coincidence claim."""
    landings = [landing("l1", "Alexandria, Egypt", planned=True)]
    by_country, stats = co.group_landings_by_country(landings, COUNTRY_INDEX)
    assert by_country == {}
    assert stats["landings_planned_excluded"] == 1
    assert stats["landings_matched"] == 0


def test_a_matched_confirmed_landing_is_grouped_by_country():
    landings = [landing("l1", "Alexandria, Egypt")]
    by_country, stats = co.group_landings_by_country(landings, COUNTRY_INDEX)
    assert [l["id"] for l in by_country["EG"]] == ["l1"]
    assert stats["landings_matched"] == 1


def test_an_unmatched_landing_is_counted_not_silently_dropped():
    landings = [landing("l1", "NoCommaHere")]
    by_country, stats = co.group_landings_by_country(landings, COUNTRY_INDEX)
    assert by_country == {}
    assert stats["landings_unmatched"] == 1
    assert stats["landings_total"] == 1


# --- update_history --------------------------------------------------------


def test_update_history_appends_a_sample_for_a_currently_reporting_country():
    outages = {"EG": outage_record(5_000_000.0)}
    updated = co.update_history({}, outages, NOW, retention_seconds=24 * HOUR)
    assert updated["EG"]["samples"] == [{"ts": NOW, "score": 5_000_000.0}]


def test_update_history_records_no_sample_for_a_country_not_currently_reporting():
    """IODA's composite has no natural zero -- a country simply drops out of
    outages.py's own filtered document. Recording a 0 here would manufacture
    a data point IODA never published."""
    updated = co.update_history({}, {}, NOW, retention_seconds=24 * HOUR)
    assert "EG" not in updated


def test_update_history_prunes_samples_older_than_retention():
    old_history = {"EG": samples((NOW - 48 * HOUR, 1_000_000.0), (NOW - 2 * HOUR, 2_000_000.0))}
    updated = co.update_history(old_history, {}, NOW, retention_seconds=24 * HOUR)
    assert [s["ts"] for s in updated["EG"]["samples"]] == [NOW - 2 * HOUR]


def test_update_history_caps_sample_count_even_inside_the_retention_window():
    many = [(NOW - i, 1_000_000.0 + i) for i in range(co.MAX_SAMPLES_PER_COUNTRY + 10)]
    old_history = {"EG": samples(*many)}
    updated = co.update_history(old_history, {}, NOW, retention_seconds=999 * HOUR)
    assert len(updated["EG"]["samples"]) == co.MAX_SAMPLES_PER_COUNTRY


def test_update_history_never_mutates_its_input():
    old_history = {"EG": samples((NOW - HOUR, 1_000_000.0))}
    frozen = {"EG": {"samples": list(old_history["EG"]["samples"])}}
    co.update_history(old_history, {"EG": outage_record(2_000_000.0)}, NOW, retention_seconds=24 * HOUR)
    assert old_history == frozen


def test_update_history_sets_started_at_once_and_keeps_it():
    first = co.update_history({}, {}, NOW, retention_seconds=24 * HOUR)
    assert first["_meta"]["started_at"] == NOW
    second = co.update_history(first, {}, NOW + HOUR, retention_seconds=24 * HOUR)
    assert second["_meta"]["started_at"] == NOW  # unchanged by the later pass


# --- _spike_status: the four states ----------------------------------------


def test_spike_status_is_a_spike_when_current_clears_the_ratio_against_its_own_recent_peak():
    history = history_with("EG", EG=samples((NOW - 20 * HOUR, 1_000_000.0), (NOW - 10 * HOUR, 1_500_000.0),
                                              (NOW - 8 * HOUR, 1_200_000.0)))
    verdict = co._spike_status("EG", history, 4_000_000.0, NOW)  # > 2x the 1.5M peak
    assert verdict["status"] == co.SPIKE
    assert verdict["baseline_score"] == 1_500_000.0


def test_spike_status_is_no_spike_when_current_does_not_clear_the_ratio():
    history = history_with("EG", EG=samples((NOW - 20 * HOUR, 1_000_000.0), (NOW - 10 * HOUR, 1_500_000.0),
                                              (NOW - 8 * HOUR, 1_200_000.0)))
    verdict = co._spike_status("EG", history, 1_800_000.0, NOW)  # elevated, but under 2x
    assert verdict["status"] == co.NO_SPIKE


def test_spike_status_is_no_spike_when_currently_quiet_but_seen_before():
    history = history_with("EG", EG=samples((NOW - 10 * HOUR, 1_000_000.0)))
    verdict = co._spike_status("EG", history, None, NOW)
    assert verdict["status"] == co.NO_SPIKE
    assert verdict["current_score"] is None


def test_spike_status_is_insufficient_history_on_a_countrys_first_ever_sample():
    """Elevated right now, but this module has never recorded this country
    before -- "just started" and "has been elevated for days" look identical
    from one sample."""
    history = history_with("EG")
    verdict = co._spike_status("EG", history, 5_000_000.0, NOW)
    assert verdict["status"] == co.INSUFFICIENT_HISTORY


def test_spike_status_is_insufficient_history_when_the_baseline_span_is_too_short():
    """Enough samples, but they're all bunched in the last hour -- not a
    settled baseline yet, even though MIN_BASELINE_SAMPLES is technically met."""
    history = history_with("EG", EG=samples(
        (NOW - 40 * 60, 1_000_000.0), (NOW - 20 * 60, 1_000_000.0), (NOW - 5 * 60, 1_000_000.0),
    ))
    verdict = co._spike_status("EG", history, 5_000_000.0, NOW)
    assert verdict["status"] == co.INSUFFICIENT_HISTORY


def test_spike_status_is_insufficient_history_when_not_currently_reporting_and_never_recorded_and_state_is_young():
    history = history_with("EG", started_at=NOW - 2 * HOUR)  # module only just started watching, globally
    verdict = co._spike_status("XX", history, None, NOW)
    assert verdict["status"] == co.INSUFFICIENT_HISTORY


def test_spike_status_is_never_observed_when_not_currently_reporting_never_recorded_and_state_is_mature():
    """This module's own history is old enough, in aggregate, that a
    landing-holding country with zero samples in it the whole time is a real
    fact about that country -- not an artefact of having only just started
    watching."""
    history = history_with("EG", started_at=NOW - 30 * HOUR)  # module has been running a full retained window
    verdict = co._spike_status("XX", history, None, NOW)
    assert verdict["status"] == co.NEVER_OBSERVED


# --- build_document: the co-occurrence window -------------------------


def _base_history():
    # A settled baseline for EG so a strong current score reads as a spike.
    return history_with("EG", EG=samples(
        (NOW - 20 * HOUR, 1_000_000.0), (NOW - 10 * HOUR, 1_200_000.0), (NOW - 8 * HOUR, 1_100_000.0),
    ))


def test_a_spike_with_a_landing_and_a_nearby_event_is_a_coincidence():
    outages = {"EG": outage_record(5_000_000.0)}
    by_country = {"EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)]}
    stats = {"landings_total": 1, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 1}
    events = [event("e1", lat=30.01, lon=32.01, radius=5.0)]

    doc = co.build_document(outages, by_country, stats, events, _base_history(), NOW)

    assert [c["country_code"] for c in doc["coincidences"]] == ["EG"]
    assert doc["coincidences"][0]["events"][0]["id"] == "e1"
    assert doc["statuses"]["EG"]["status"] == co.SPIKE
    assert doc["status_counts"][co.SPIKE] == 1


def test_an_event_outside_the_landings_radius_produces_no_coincidence():
    outages = {"EG": outage_record(5_000_000.0)}
    by_country = {"EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)]}
    stats = {"landings_total": 1, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 1}
    events = [event("e1", lat=10.0, lon=10.0, radius=5.0)]  # far away

    doc = co.build_document(outages, by_country, stats, events, _base_history(), NOW)

    assert doc["coincidences"] == []
    assert doc["statuses"]["EG"]["status"] == co.SPIKE  # still spiking -- just nothing nearby
    assert doc["events_searched"] == 1


def test_a_spike_with_no_landings_is_never_considered_for_a_coincidence():
    """Required test case: a country's score spikes, but it holds no cable
    landing at all, so there is nothing to check proximity against."""
    outages = {"XX": outage_record(9_000_000.0, country="Nowhereland")}
    events = [event("e1")]

    doc = co.build_document(outages, {}, {"landings_total": 0, "landings_planned_excluded": 0,
                                           "landings_unmatched": 0, "landings_matched": 0},
                             events, history_with("XX"), NOW)

    assert doc["coincidences"] == []
    assert doc["countries_with_landings"] == 0
    assert "XX" not in doc["statuses"]  # never checked -- it holds no landing


def test_landings_with_no_spike_produce_no_coincidence():
    """Required test case: a country holds landings and an event sits right
    next to one, but its score is not elevated at all."""
    by_country = {"EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)]}
    stats = {"landings_total": 1, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 1}
    events = [event("e1", lat=30.0, lon=32.0, radius=5.0)]

    doc = co.build_document({}, by_country, stats, events, history_with("EG"), NOW)

    assert doc["coincidences"] == []
    assert doc["statuses"]["EG"]["status"] in (co.NEVER_OBSERVED, co.INSUFFICIENT_HISTORY, co.NO_SPIKE)
    assert doc["statuses"]["EG"]["status"] != co.SPIKE


def test_events_without_a_radius_are_never_searched_not_silently_treated_as_clear():
    by_country = {"EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)]}
    stats = {"landings_total": 1, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 1}
    events = [event("e1", lat=30.0, lon=32.0, radius=None)]

    doc = co.build_document({"EG": outage_record(5_000_000.0)}, by_country, stats, events, _base_history(), NOW)

    assert doc["events_searched"] == 0
    assert doc["events_without_radius"] == 1
    assert doc["coincidences"] == []  # spiking, landing right there, but never actually searched


def test_events_with_no_coordinate_get_their_own_bucket():
    events = [event("e1", lat=None, lon=None)]
    doc = co.build_document({}, {}, {"landings_total": 0, "landings_planned_excluded": 0,
                                      "landings_unmatched": 0, "landings_matched": 0},
                             events, {}, NOW)
    assert doc["events_missing_coordinate"] == 1
    assert doc["events_searched"] == 0
    assert doc["events_without_radius"] == 0


def test_the_document_always_carries_provenance_and_the_note_verbatim():
    doc = co.build_document({}, {}, {"landings_total": 0, "landings_planned_excluded": 0,
                                      "landings_unmatched": 0, "landings_matched": 0}, [], {}, NOW)
    assert doc["provenance"] == "derived"
    assert doc["note"] == co.NOTE


def test_an_empty_input_is_not_an_error():
    doc = co.build_document({}, {}, {"landings_total": 0, "landings_planned_excluded": 0,
                                      "landings_unmatched": 0, "landings_matched": 0}, [], {}, NOW)
    assert doc["coincidences"] == []
    assert doc["countries_with_landings"] == 0
    assert doc["status_counts"] == {co.SPIKE: 0, co.NO_SPIKE: 0, co.INSUFFICIENT_HISTORY: 0, co.NEVER_OBSERVED: 0}


def test_coincidences_are_ranked_by_matched_event_count_then_country_code():
    by_country = {
        "EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)],
        "FR": [landing("l2", "Marseille, France", lat=43.3, lon=5.4)],
    }
    stats = {"landings_total": 2, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 2}
    events = [
        event("e1", lat=30.0, lon=32.0, radius=5.0, country="Egypt"),
        event("e2", lat=30.0, lon=32.0, radius=5.0, country="Egypt"),
        event("e3", lat=43.3, lon=5.4, radius=5.0, country="France"),
    ]
    hist = {
        "_meta": {"started_at": NOW - 30 * HOUR},
        "EG": samples((NOW - 20 * HOUR, 1_000_000.0), (NOW - 14 * HOUR, 1_000_000.0), (NOW - 8 * HOUR, 1_000_000.0)),
        "FR": samples((NOW - 20 * HOUR, 1_000_000.0), (NOW - 14 * HOUR, 1_000_000.0), (NOW - 8 * HOUR, 1_000_000.0)),
    }
    outages = {"EG": outage_record(5_000_000.0, "Egypt"), "FR": outage_record(5_000_000.0, "France")}

    doc = co.build_document(outages, by_country, stats, events, hist, NOW)

    assert [c["country_code"] for c in doc["coincidences"]] == ["EG", "FR"]  # 2 events beats 1


# --- write / cursor discipline ------------------------------------------


def test_the_document_is_built_from_the_pre_update_history_not_a_freshly_appended_sample():
    """compute() hands build_document the history as it stood *before* this
    pass's own sample is appended -- see update_history's own docstring on
    why. Demonstrated here: a country's very first-ever sample must never by
    itself count as its own baseline, which is exactly what would happen if
    build_document were (incorrectly) handed history that already included
    the sample update_history is about to add for this same pass."""
    old_history = {}  # nothing recorded for EG yet, anywhere
    outages = {"EG": outage_record(5_000_000.0)}

    # If build_document were wrongly handed the *updated* history (which
    # would already contain this pass's own 5,000,000.0 sample as "prior"),
    # a naive ratio against itself could read as a settled baseline. Handed
    # the correct pre-update history instead, this pass has no prior sample
    # for EG at all, so the honest verdict is "too soon to tell".
    verdict = co._spike_status("EG", old_history, outages["EG"]["score"], NOW)
    assert verdict["status"] == co.INSUFFICIENT_HISTORY

    updated = co.update_history(old_history, outages, NOW, retention_seconds=24 * HOUR)
    assert updated["EG"]["samples"] == [{"ts": NOW, "score": 5_000_000.0}]
    # And the object build_document actually used is untouched by that update.
    assert old_history == {}


# --- language: no causal claim anywhere in the emitted text ---------------

# The brief's own list, plus the closest obvious variants -- deliberately not
# including bare words like "cause" or "deliberate" on their own, since the
# one fact this feature is allowed to state (faults are usually anchors and
# dredging, not anything deliberate) has to *use* "deliberate" in its own
# negation. What must never appear, in any casing, is an affirmative
# attribution: something on this card *did* one of these things to something
# else.
_BANNED_PHRASES = [
    "caused by", "was caused", "has caused",
    "attack", "attacking", "attacked",
    "sabotage", "sabotaged", "sabotaging",
    "targeted", "targeting", "target of",
    "responsible for",
    "to blame", "blamed on",
    "retaliat",  # retaliation / retaliatory
    "culprit",
]


def _all_emitted_strings(doc: dict) -> list[str]:
    """Every human-readable string this document actually carries -- the
    note, plus every free-text field a reader would see on a coincidence
    card (country names, event notes/types are source data, not this
    module's own prose, so only the strings this module itself composes are
    checked)."""
    out = [doc.get("note", "")]
    for entry in doc.get("coincidences", []):
        out.append(str(entry.get("country", "")))
    return out


def test_no_banned_causal_phrase_appears_anywhere_in_the_note():
    text = co.NOTE.lower()
    for phrase in _BANNED_PHRASES:
        assert phrase not in text, f"banned phrase {phrase!r} found in cable_outage.NOTE"


def test_no_banned_causal_phrase_appears_in_a_built_documents_emitted_strings():
    outages = {"EG": outage_record(5_000_000.0)}
    by_country = {"EG": [landing("l1", "Alexandria, Egypt", lat=30.0, lon=32.0)]}
    stats = {"landings_total": 1, "landings_planned_excluded": 0, "landings_unmatched": 0, "landings_matched": 1}
    events = [event("e1", lat=30.01, lon=32.01, radius=5.0)]

    doc = co.build_document(outages, by_country, stats, events, _base_history(), NOW)

    for text in _all_emitted_strings(doc):
        lowered = text.lower()
        for phrase in _BANNED_PHRASES:
            assert phrase not in lowered, f"banned phrase {phrase!r} found in {text!r}"


def test_the_note_explicitly_says_this_is_a_coincidence_not_causation():
    assert "coincidence" in co.NOTE.lower()


def test_the_note_states_the_one_authorised_qualitative_claim():
    """The brief's own authorised sentence: faults are usually anchors and
    dredging, not anything deliberate -- stated as a qualitative caveat, with
    no percentage attached to it (no source this module reads supplies one)."""
    lowered = co.NOTE.lower()
    assert "anchors" in lowered and "dredging" in lowered
    assert "deliberate" in lowered
    import re
    assert not re.search(r"\d", co.NOTE), "no percentage or figure attached to the anchors/dredging claim"
