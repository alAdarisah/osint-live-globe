"""backend/alert_rules.py -- Task 42's reader-defined alert rules.

evaluate_rules is pure (no I/O, no clock), so every condition type, every
geofence kind, and the de-duplication / resolve-and-refire contract are
reachable here without a Postgres -- the same reasoning
backend/tests/test_cache_alerts.py gives for cacheworker's own evaluate().

This suite does not touch storage.record_alert/resolve_alerts themselves --
this project's test suite runs with no live database (see
backend/tests/test_admin_config.py and test_app_derived_job_health.py, which
monkeypatch the storage boundary rather than opening a real pool), and that
SQL is already exercised by the schema it runs against. What belongs here is
proof that evaluate_rules feeds that upsert exactly what its own contract
(backend/storage.py:928-990) needs: a stable (subject, condition) key for as
long as a rule stays true, and an active set each pass that omits whatever
has stopped being true. _FakeAlertsTable below is a pure-Python mirror of
that contract, used only to drive evaluate_rules through several simulated
worker ticks.
"""

from backend import regions
from backend.alert_rules import evaluate_rules, parse_rules, _entity_label, _in_geofence


# --- fixtures --------------------------------------------------------------


def ship(entity_id, lat, lon, **extra):
    return (entity_id, {"lat": lat, "lon": lon, "mmsi": entity_id, **extra})


def aircraft(entity_id, lat, lon, **extra):
    return (entity_id, {"lat": lat, "lon": lon, "icao24": entity_id, **extra})


def square_feature(name, iso2, south, west, north, east):
    return {
        "type": "Feature",
        "properties": {"name": name, "iso_a2": iso2},
        "geometry": {
            "type": "Polygon",
            "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
    }


def fc(*features):
    return {"type": "FeatureCollection", "features": list(features)}


IRAN_FC = fc(square_feature("Iran", "IR", 25.0, 44.0, 40.0, 63.0))
IRAN_INDEX = regions.CountryIndex(IRAN_FC)

HORMUZ_RULE_RAW = {
    "id": "r1", "name": "Ships near Hormuz", "layer": "ais", "enabled": True,
    "geofence": {"type": "region", "key": "persian_gulf_hormuz"},
    "condition": {"type": "enter"},
}


class _FakeAlertsTable:
    """A pure-Python mirror of storage.record_alert/resolve_alerts's own
    upsert contract, for driving evaluate_rules through several simulated
    cache-worker ticks without a Postgres. See this file's own module
    docstring for why the real SQL is not re-exercised here.
    """

    def __init__(self):
        self.rows = {}  # (subject, condition) -> {"resolved": bool}

    def _record(self, alert) -> bool:
        key = alert.key()
        row = self.rows.get(key)
        if row is None or row["resolved"]:
            self.rows[key] = {"resolved": False}
            return True  # newly firing, same meaning as storage.record_alert's bool
        return False

    def tick(self, alerts):
        """One worker pass. Returns (newly_firing_keys, resolved_keys)."""
        newly = {a.key() for a in alerts if self._record(a)}
        active = {a.key() for a in alerts}
        resolved = []
        for key, row in self.rows.items():
            if not row["resolved"] and key not in active:
                row["resolved"] = True
                resolved.append(key)
        return newly, set(resolved)


# --- parse_rules -------------------------------------------------------


def test_parse_rules_round_trips_a_well_formed_rule():
    rules = parse_rules([HORMUZ_RULE_RAW])
    assert len(rules) == 1
    assert rules[0].id == "r1"
    assert rules[0].layer == "ais"
    assert rules[0].condition == {"type": "enter"}
    assert rules[0].geofence == {"type": "region", "key": "persian_gulf_hormuz", "name": None}


def test_parse_rules_drops_a_rule_missing_a_name():
    raw = {**HORMUZ_RULE_RAW, "name": None}
    assert parse_rules([raw]) == []


def test_parse_rules_drops_a_rule_with_no_condition():
    raw = {k: v for k, v in HORMUZ_RULE_RAW.items() if k != "condition"}
    assert parse_rules([raw]) == []


def test_parse_rules_drops_a_duplicate_id_keeping_the_first():
    raw = [
        {**HORMUZ_RULE_RAW, "name": "first"},
        {**HORMUZ_RULE_RAW, "name": "second"},
    ]
    rules = parse_rules(raw)
    assert len(rules) == 1
    assert rules[0].name == "first"


def test_parse_rules_drops_squawk_equals_against_a_non_adsb_layer():
    raw = {**HORMUZ_RULE_RAW, "condition": {"type": "squawk_equals", "code": "7700"}}
    assert parse_rules([raw]) == []


def test_parse_rules_keeps_squawk_equals_against_adsb():
    raw = {
        "id": "r2", "name": "Hijack code", "layer": "adsb",
        "condition": {"type": "squawk_equals", "code": "7500"},
    }
    rules = parse_rules([raw])
    assert len(rules) == 1
    assert rules[0].condition == {"type": "squawk_equals", "code": "7500"}


def test_parse_rules_drops_the_whole_rule_when_its_geofence_does_not_parse():
    """A broken geofence must not silently widen to "anywhere" -- see
    parse_rules' own note on why this drops the rule rather than the
    geofence alone."""
    raw = {**HORMUZ_RULE_RAW, "geofence": {"type": "region", "key": "does-not-exist"}}
    assert parse_rules([raw]) == []


def test_parse_rules_accepts_no_geofence_as_the_whole_world():
    raw = {k: v for k, v in HORMUZ_RULE_RAW.items() if k != "geofence"}
    rules = parse_rules([raw])
    assert rules[0].geofence is None


def test_parse_rules_rejects_a_negative_count_threshold():
    raw = {**HORMUZ_RULE_RAW, "condition": {"type": "count_exceeds", "n": -1}}
    assert parse_rules([raw]) == []


def test_parse_rules_disabled_rule_still_parses():
    raw = {**HORMUZ_RULE_RAW, "enabled": False}
    rules = parse_rules([raw])
    assert len(rules) == 1
    assert rules[0].enabled is False


# --- geofence containment -----------------------------------------------


def test_country_geofence_matches_inside_the_polygon():
    geofence = {"type": "country", "iso2": "IR", "name": "Iran"}
    assert _in_geofence(30.0, 50.0, geofence, IRAN_INDEX) is True


def test_country_geofence_rejects_outside_the_polygon():
    geofence = {"type": "country", "iso2": "IR", "name": "Iran"}
    assert _in_geofence(30.0, 10.0, geofence, IRAN_INDEX) is False


def test_country_geofence_rejects_the_wrong_country_at_the_same_point():
    """A point inside *some* country that is not the one named must not match --
    country_at's own iso2 has to agree, not just "found something"."""
    geofence = {"type": "country", "iso2": "EG", "name": "Egypt"}
    assert _in_geofence(30.0, 50.0, geofence, IRAN_INDEX) is False


def test_country_geofence_with_no_index_is_never_satisfied():
    """A rule with a country geofence but no CountryIndex built (the "no rule
    needs one this pass" fast path in gather_and_evaluate) must fail closed,
    not match everything."""
    geofence = {"type": "country", "iso2": "IR", "name": "Iran"}
    assert _in_geofence(30.0, 50.0, geofence, None) is False


def test_region_geofence_uses_the_shared_regions_table():
    bounds = regions.bounds_for("persian_gulf_hormuz")
    south, west, north, east = bounds
    mid_lat, mid_lon = (south + north) / 2, (west + east) / 2
    geofence = {"type": "region", "key": "persian_gulf_hormuz", "name": None}
    assert _in_geofence(mid_lat, mid_lon, geofence, None) is True
    assert _in_geofence(0.0, 0.0, geofence, None) is False


def test_water_geofence_is_a_plain_bbox_test():
    geofence = {"type": "water", "id": "marine:5:strait-of-hormuz", "name": None, "bbox": [24.0, 54.0, 27.0, 58.0]}
    assert _in_geofence(25.5, 56.0, geofence, None) is True
    assert _in_geofence(10.0, 10.0, geofence, None) is False


def test_water_geofence_handles_an_antimeridian_wrapping_bbox():
    """west > east means the box wraps -180/180 (water_bodies.py's own
    convention for e.g. the Bering Sea) -- a point just past 180 or just
    past -180 both have to match."""
    geofence = {"type": "water", "id": "marine:1:bering-sea", "name": None, "bbox": [50.0, 162.76, 66.0, -161.44]}
    assert _in_geofence(58.0, 179.0, geofence, None) is True
    assert _in_geofence(58.0, -179.0, geofence, None) is True
    assert _in_geofence(58.0, 0.0, geofence, None) is False


def test_rect_geofence_is_a_plain_bbox_test():
    geofence = {"type": "rect", "bounds": [10.0, 10.0, 20.0, 20.0]}
    assert _in_geofence(15.0, 15.0, geofence, None) is True
    assert _in_geofence(25.0, 25.0, geofence, None) is False


def test_no_geofence_matches_anywhere():
    assert _in_geofence(89.0, 179.0, None, None) is True


def test_geofence_rejects_a_non_numeric_position():
    geofence = {"type": "rect", "bounds": [10.0, 10.0, 20.0, 20.0]}
    assert _in_geofence(None, None, geofence, None) is False


# --- entity labelling -----------------------------------------------------


def test_entity_label_prefers_name_then_callsign_then_registration_then_id():
    assert _entity_label("111", {"name": "MV Example"}) == "MV Example"
    assert _entity_label("111", {"callsign": "RCH123"}) == "RCH123"
    assert _entity_label("111", {"registration": "N12345"}) == "N12345"
    assert _entity_label("111", {}) == "111"


# --- condition types, via evaluate_rules ----------------------------------


def test_enter_condition_fires_once_per_matching_entity():
    rules = parse_rules([HORMUZ_RULE_RAW])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    entities = {"ais": [ship("111", *inside, name="MV Alpha"), ship("222", 0.0, 0.0)]}
    alerts = evaluate_rules(rules, entities)
    assert {a.condition for a in alerts} == {"entity:111"}
    assert alerts[0].subject == "rule:r1"
    assert "MV Alpha" in alerts[0].detail


def test_count_exceeds_fires_once_for_the_whole_rule_not_per_entity():
    raw = {
        "id": "r3", "name": "Busy strait", "layer": "ais", "enabled": True,
        "geofence": {"type": "region", "key": "persian_gulf_hormuz"},
        "condition": {"type": "count_exceeds", "n": 1},
    }
    rules = parse_rules([raw])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    entities = {"ais": [ship("1", *inside), ship("2", *inside), ship("3", *inside)]}
    alerts = evaluate_rules(rules, entities)
    assert len(alerts) == 1
    assert alerts[0].subject == "rule:r3"
    assert alerts[0].condition == "count"
    assert "3" in alerts[0].detail


def test_count_exceeds_is_quiet_at_or_under_the_threshold():
    raw = {
        "id": "r3", "name": "Busy strait", "layer": "ais", "enabled": True,
        "geofence": {"type": "region", "key": "persian_gulf_hormuz"},
        "condition": {"type": "count_exceeds", "n": 3},
    }
    rules = parse_rules([raw])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    entities = {"ais": [ship("1", *inside), ship("2", *inside), ship("3", *inside)]}
    assert evaluate_rules(rules, entities) == []


def test_score_above_reads_the_configured_field():
    raw = {
        "id": "r4", "name": "High severity", "layer": "gdelt_conflict", "enabled": True,
        "condition": {"type": "score_above", "field": "severity", "threshold": 70},
    }
    rules = parse_rules([raw])
    entities = {"gdelt_conflict": [
        ("e1", {"lat": 10.0, "lon": 10.0, "severity": 85}),
        ("e2", {"lat": 11.0, "lon": 11.0, "severity": 40}),
        ("e3", {"lat": 12.0, "lon": 12.0}),  # no severity at all -- must not crash or match
    ]}
    alerts = evaluate_rules(rules, entities)
    assert {a.condition for a in alerts} == {"entity:e1"}


def test_squawk_equals_matches_the_exact_code_only():
    raw = {
        "id": "r5", "name": "Hijack code", "layer": "adsb", "enabled": True,
        "condition": {"type": "squawk_equals", "code": "7500"},
    }
    rules = parse_rules([raw])
    entities = {"adsb": [
        aircraft("a1", 10.0, 10.0, squawk="7500"),
        aircraft("a2", 11.0, 11.0, squawk="7600"),
        aircraft("a3", 12.0, 12.0, squawk=None),
    ]}
    alerts = evaluate_rules(rules, entities)
    assert {a.condition for a in alerts} == {"entity:a1"}


def test_a_disabled_rule_never_fires():
    raw = {**HORMUZ_RULE_RAW, "enabled": False}
    rules = parse_rules([raw])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    entities = {"ais": [ship("1", *inside)]}
    assert evaluate_rules(rules, entities) == []


def test_a_layer_with_no_fetched_entities_is_quiet_not_broken():
    rules = parse_rules([HORMUZ_RULE_RAW])
    assert evaluate_rules(rules, {}) == []


# --- de-duplication and resolve-then-refire --------------------------------


def test_a_rule_that_stays_true_fires_only_once():
    rules = parse_rules([HORMUZ_RULE_RAW])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    entities = {"ais": [ship("111", *inside)]}
    table = _FakeAlertsTable()

    newly_1, resolved_1 = table.tick(evaluate_rules(rules, entities))
    newly_2, resolved_2 = table.tick(evaluate_rules(rules, entities))
    newly_3, resolved_3 = table.tick(evaluate_rules(rules, entities))

    assert newly_1 == {("rule:r1", "entity:111")}
    assert newly_2 == set()  # still true, not a new notification
    assert newly_3 == set()
    assert resolved_1 == resolved_2 == resolved_3 == set()


def test_a_rule_that_resolves_and_later_becomes_true_again_fires_again():
    """The brief's own required test: a condition that clears and returns is
    genuinely new information, and must not stay silenced by the first
    firing's de-duplication."""
    rules = parse_rules([HORMUZ_RULE_RAW])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    outside = (0.0, 0.0)
    table = _FakeAlertsTable()

    newly_1, _ = table.tick(evaluate_rules(rules, {"ais": [ship("111", *inside)]}))
    assert newly_1 == {("rule:r1", "entity:111")}

    # The ship leaves the geofence -- evaluate_rules produces no alert for it,
    # and the fake table's tick() resolves whatever dropped out of the active
    # set, exactly as storage.resolve_alerts does for the real table.
    newly_2, resolved_2 = table.tick(evaluate_rules(rules, {"ais": [ship("111", *outside)]}))
    assert newly_2 == set()
    assert resolved_2 == {("rule:r1", "entity:111")}

    # And back in -- a fresh episode, so this must fire again.
    newly_3, _ = table.tick(evaluate_rules(rules, {"ais": [ship("111", *inside)]}))
    assert newly_3 == {("rule:r1", "entity:111")}


def test_two_different_entities_inside_the_same_rule_dedupe_independently():
    rules = parse_rules([HORMUZ_RULE_RAW])
    south, west, north, east = regions.bounds_for("persian_gulf_hormuz")
    inside = ((south + north) / 2, (west + east) / 2)
    table = _FakeAlertsTable()

    newly_1, _ = table.tick(evaluate_rules(rules, {"ais": [ship("111", *inside), ship("222", *inside)]}))
    assert newly_1 == {("rule:r1", "entity:111"), ("rule:r1", "entity:222")}

    # 111 leaves, 222 stays -- only 111's alert should resolve, and 222 must
    # not re-fire merely because a sibling entity's state changed.
    newly_2, resolved_2 = table.tick(evaluate_rules(rules, {"ais": [ship("222", *inside)]}))
    assert newly_2 == set()
    assert resolved_2 == {("rule:r1", "entity:111")}
