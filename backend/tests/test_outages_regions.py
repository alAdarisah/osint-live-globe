"""Sub-national IODA parsing: the three match qualities, the unmatched-stays-
in-the-payload rule, and the per-country ASN pass.

Fixtures are trimmed shapes of the real `entityType=region`/`entityType=asn`
responses (see the task's own probe of the live API) rather than full
captures -- IODA's `scores`/`entity` shape is what these functions read, and
nothing else in the payload matters to them.
"""

import logging

import pytest

from backend.sources import outages


def region_row(code, name, country_code, overall=5_000_000, **score_overrides):
    scores = {"overall": overall, "bgp.median": overall * 0.4}
    scores.update(score_overrides)
    return {
        "scores": scores,
        "event_cnt": 2,
        "entity": {
            "code": code,
            "name": name,
            "type": "region",
            "attrs": {"country_code": country_code, "country_name": "Testland"},
        },
    }


def asn_row(asn, name, org, overall=5_000_000):
    return {
        "scores": {"overall": overall},
        "event_cnt": 1,
        "entity": {
            "code": str(asn),
            "name": f"AS{asn} ({name})",
            "type": "asn",
            "attrs": {"name": name, "org": org},
        },
    }


def admin1_feature(code, name):
    return {"type": "Feature", "properties": {"code": code, "name": name}}


class TestRegionLookup:
    def test_exact_and_fuzzy_buckets(self):
        features = [
            admin1_feature("DZ-23", "Annaba"),
            admin1_feature("MD-TE", "Telenești"),
        ]
        lookup = outages.region_lookup_for_country(features)
        assert lookup["exact"]["Annaba"] == "DZ-23"
        # The fuzzy bucket is keyed by the *normalised* name, so an ASCII
        # respelling of the same place is not present verbatim.
        assert "Telenesti" not in lookup["exact"]
        assert lookup["fuzzy"][outages.normalize("Telenesti")] == "MD-TE"

    def test_an_exact_name_collision_keeps_the_first_code_and_logs_it(self, caplog):
        # Natural Earth's own duplicate-code case (see admin1_boundaries.py's
        # _assign_keys): two features, same published name, different codes --
        # the one real path in this matcher that could attribute a region to
        # the wrong boundary rather than to none at all.
        features = [
            admin1_feature("PE-LIM", "Lima"),  # the province
            admin1_feature("PE-CIT", "Lima"),  # Lima the city, cut out of it
        ]
        with caplog.at_level(logging.DEBUG, logger="osint-globe.outages"):
            lookup = outages.region_lookup_for_country(features)
        assert lookup["exact"]["Lima"] == "PE-LIM"
        assert any("Lima" in record.message and "PE-CIT" in record.message for record in caplog.records)

    def test_a_fuzzy_name_collision_keeps_the_first_code_and_logs_it(self, caplog):
        # Two differently-spelled names that fold to the same normalised key.
        features = [
            admin1_feature("MD-CS", "Căușeni"),
            admin1_feature("MD-XX", "Causeni"),
        ]
        with caplog.at_level(logging.DEBUG, logger="osint-globe.outages"):
            lookup = outages.region_lookup_for_country(features)
        assert lookup["fuzzy"][outages.normalize("Causeni")] == "MD-CS"
        assert any("MD-XX" in record.message for record in caplog.records)

    def test_no_collision_means_no_log_line(self, caplog):
        features = [admin1_feature("DZ-23", "Annaba"), admin1_feature("DZ-07", "Sirdaryo")]
        with caplog.at_level(logging.DEBUG, logger="osint-globe.outages"):
            outages.region_lookup_for_country(features)
        assert caplog.records == []

    def test_features_missing_a_code_or_name_are_skipped(self):
        features = [
            {"type": "Feature", "properties": {"code": "", "name": "No Code"}},
            {"type": "Feature", "properties": {"code": "XX-01", "name": ""}},
        ]
        lookup = outages.region_lookup_for_country(features)
        assert lookup == {"exact": {}, "fuzzy": {}}


class TestParseOutageRegions:
    def test_exact_match(self):
        payload = {"data": [region_row("906", "Annaba", "DZ")]}
        lookup = {"DZ": outages.region_lookup_for_country([admin1_feature("DZ-23", "Annaba")])}
        out = outages.parse_outage_regions(payload, lookup, 0.0, 86400.0)
        record = out["DZ"]["DZ-23"]
        assert record["matched"] == "exact"
        assert record["region_code"] == "DZ-23"
        assert record["entity_code"] == "906"
        assert record["country_code"] == "DZ"
        assert record["name"] == "Annaba"
        assert record["publisher"] == "IODA (Georgia Tech)"
        # The composite, not the raw signal breakdown, is what "overall" means --
        # and it must not leak into the per-signal dict a reader is shown.
        assert record["score"] == 5_000_000.0
        assert "overall" not in record["signals"]
        assert record["signals"]["bgp.median"] == pytest.approx(2_000_000.0)

    def test_fuzzy_match_folds_diacritics(self):
        # IODA spells it without the diacritic; Natural Earth spells it with one.
        payload = {"data": [region_row("2502", "Telenesti", "MD")]}
        lookup = {"MD": outages.region_lookup_for_country([admin1_feature("MD-TE", "Telenești")])}
        out = outages.parse_outage_regions(payload, lookup, 0.0, 86400.0)
        record = out["MD"]["MD-TE"]
        assert record["matched"] == "fuzzy"
        assert record["region_code"] == "MD-TE"

    def test_unmatched_region_survives_in_the_payload(self):
        # No admin-1 lookup at all for this country -- e.g. it has no stored
        # boundaries yet -- so every one of its regions must come back
        # unmatched rather than vanish.
        payload = {"data": [region_row("1286", "Camden", "GB")]}
        out = outages.parse_outage_regions(payload, {}, 0.0, 86400.0)
        record = out["GB"]["1286"]
        assert record["matched"] == "unmatched"
        assert record["region_code"] is None
        # Keyed by IODA's own entity code, since there is no resolved code to
        # key it by -- and that key must never collide with a real ISO 3166-2
        # code, which always contains a hyphen.
        assert "-" not in "1286"

    def test_a_country_with_a_lookup_can_still_have_unmatched_regions(self):
        # The lookup exists (this country has boundaries) but does not contain
        # this particular region -- IODA's "Unknown Region in X" bucket is
        # exactly this case, and it must not be confused with "no lookup at all".
        payload = {"data": [region_row("999", "Unknown Region in Testland", "DZ")]}
        lookup = {"DZ": outages.region_lookup_for_country([admin1_feature("DZ-23", "Annaba")])}
        out = outages.parse_outage_regions(payload, lookup, 0.0, 86400.0)
        assert out["DZ"]["999"]["matched"] == "unmatched"
        # And the exact match from a sibling row in the same batch still lands
        # in the same country's dict, keyed by its own resolved code.
        payload["data"].append(region_row("906", "Annaba", "DZ"))
        out = outages.parse_outage_regions(payload, lookup, 0.0, 86400.0)
        assert set(out["DZ"]) == {"999", "DZ-23"}

    def test_below_the_score_floor_is_dropped_not_unmatched(self):
        payload = {"data": [region_row("906", "Annaba", "DZ", overall=1000)]}
        lookup = {"DZ": outages.region_lookup_for_country([admin1_feature("DZ-23", "Annaba")])}
        out = outages.parse_outage_regions(payload, lookup, 0.0, 86400.0)
        assert out == {}

    def test_non_region_rows_are_ignored(self):
        payload = {"data": [
            {"scores": {"overall": 9e9}, "entity": {"code": "DZ", "name": "Algeria", "type": "country"}},
        ]}
        assert outages.parse_outage_regions(payload, {}, 0.0, 86400.0) == {}


class TestParseOutageAsns:
    def test_sorted_and_capped_at_top_n(self):
        rows = [asn_row(100 + i, f"isp{i}", f"Org {i}", overall=1_000_000 * (i + 1)) for i in range(8)]
        payload = {"data": rows}
        out = outages.parse_outage_asns(payload, "CI", 0.0, 86400.0)
        assert len(out) == outages.ASN_TOP_N
        # Highest score first.
        scores = [r["score"] for r in out]
        assert scores == sorted(scores, reverse=True)
        assert scores[0] == 8_000_000.0

    def test_country_code_is_the_fetch_scope_not_ioda_data(self):
        payload = {"data": [asn_row(36974, "MTNCI-AS", "MTN COTE D'IVOIRE S.A")]}
        out = outages.parse_outage_asns(payload, "CI", 0.0, 86400.0)
        assert out[0]["country_code"] == "CI"
        assert out[0]["asn"] == "36974"
        assert out[0]["name"] == "MTNCI-AS"
        assert out[0]["org"] == "MTN COTE D'IVOIRE S.A"
        assert out[0]["publisher"] == "IODA (Georgia Tech)"

    def test_below_floor_asns_are_excluded(self):
        payload = {"data": [asn_row(1, "tiny", "Tiny ISP", overall=10)]}
        assert outages.parse_outage_asns(payload, "CI", 0.0, 86400.0) == []

    def test_non_asn_rows_are_ignored(self):
        payload = {"data": [region_row("906", "Annaba", "DZ")]}
        assert outages.parse_outage_asns(payload, "DZ", 0.0, 86400.0) == []


class TestParseOutagesUnchanged:
    """The country pass is untouched by this task -- a quick guard that the
    region/ASN additions did not change its own behaviour."""

    def test_country_pass_still_keys_by_iso2(self):
        payload = {"data": [
            {"scores": {"overall": 9e9, "bgp.median": 1e9}, "event_cnt": 3,
             "entity": {"code": "ci", "name": "Cote D Ivoire", "type": "country"}},
        ]}
        out = outages.parse_outages(payload, 0.0, 86400.0)
        assert set(out) == {"CI"}
        assert out["CI"]["country"] == "Cote D Ivoire"
