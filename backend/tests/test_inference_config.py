"""backend/inference_config.py's describe() -- the one place every threshold
behind an inferred product is named for Admin Mode's read-only Inference
section (see that module's own docstring for why read-only).

The point of this module is "reads the real constant, not a copy of its
value", so these tests assert that relationship directly: change one of the
source constants (monkeypatch) and the described value must move with it.
A test that only checked describe() against a hand-typed 0.85 would still
pass if inference_config.py had quietly drifted to its own stale copy.
"""

from backend import config, inference_config
from backend.refine import port_calls


def test_every_product_is_named_and_governs_a_real_module():
    doc = inference_config.describe()
    assert set(doc) == {
        "laden_ballast", "cargo_class", "dark_ship", "port_calls",
        "lane_density", "flight_legs", "military_bases",
    }
    for key, product in doc.items():
        assert product["label"], key
        assert product["governs"], key
        assert isinstance(product["fields"], list), key


def test_cargo_class_carries_no_numeric_threshold():
    """A lookup table keyed by AIS ship-type code, not a percentage or a
    radius -- named for context, nothing to expose as a field."""
    assert inference_config.describe()["cargo_class"]["fields"] == []


def test_laden_ballast_reads_the_live_config_values(monkeypatch):
    monkeypatch.setattr(config, "VESSEL_DRAUGHT_LADEN_RATIO", 0.7)
    doc = inference_config.describe()
    fields = {f["key"]: f["value"] for f in doc["laden_ballast"]["fields"]}
    assert fields["laden_ratio"] == 0.7


def test_port_calls_reads_the_live_module_constant(monkeypatch):
    """DWELL_MAX_SPEED_KN lives in refine/port_calls.py, imported by name into
    inference_config.py -- monkeypatching the source module's attribute has to
    reach the describe() output, or the import silently copied the value
    instead of the name."""
    monkeypatch.setattr(port_calls, "DWELL_MAX_SPEED_KN", 9.9)
    doc = inference_config.describe()
    fields = {f["key"]: f["value"] for f in doc["port_calls"]["fields"]}
    assert fields["dwell_max_speed_kn"] == 9.9


def test_every_field_has_a_unit_and_a_plain_language_note():
    doc = inference_config.describe()
    for product in doc.values():
        for field in product["fields"]:
            assert field["unit"], field["key"]
            assert len(field["note"]) > 10, field["key"]


def test_lane_density_decay_factor_is_derived_not_restated():
    """DECAY_FACTOR is itself derived from LANE_DENSITY_INTERVAL (see
    lane_density.py's own module docstring) -- both numbers are exposed so a
    reader can see the derivation rather than just its result."""
    doc = inference_config.describe()
    fields = {f["key"]: f["value"] for f in doc["lane_density"]["fields"]}
    assert 0 < fields["decay_factor"] < 1
    assert fields["interval_seconds"] == config.LANE_DENSITY_INTERVAL
