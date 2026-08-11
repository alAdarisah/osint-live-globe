"""Cargo class and laden state are both guesses -- see the module docstring on
backend/refine/vessel_profile.py. What these tests hold the line on: the
ship-type table sorts every code somewhere (including ones it has no sharper
bucket for), the laden/ballast ratios fire at their exact stated boundaries
and nowhere else, and nothing this module ever produces names a commodity.
"""

import asyncio
import copy

from backend import config
from backend.refine import vessel_profile as vp

MMSI = "244660724"


def _run(coro):
    return asyncio.run(coro)


def row(id_, ts, mmsi=MMSI, draught=None, ship_type=None, destination=None) -> dict:
    payload = {}
    if draught is not None:
        payload["draught"] = draught
    if ship_type is not None:
        payload["ship_type"] = ship_type
    if destination is not None:
        payload["destination"] = destination
    return {"id": id_, "entity_id": mmsi, "ts": ts, "lat": 1.0, "lon": 2.0, "payload": payload}


# --- cargo class: every branch, including the unmapped ones -----------------


def test_cargo_class_covers_every_declared_bucket():
    cases = {
        "tug": [31, 32, 52],
        "fishing": [30],
        "naval": [35],
        "passenger": [60, 65, 69],
        "cargo": [70, 75, 79],
        "tanker": [80, 85, 89],
    }
    for bucket, codes in cases.items():
        for code in codes:
            assert vp.cargo_class(code) == bucket, f"code {code} should be {bucket!r}"


def test_cargo_class_falls_back_to_other_for_every_unmapped_code():
    """Codes AIS itself defines but this table has no sharper bucket for --
    "not available", wing-in-ground, sailing, pleasure craft, pilot vessels,
    SAR, dredging, diving, law enforcement, high-speed craft, and the 90-99
    "other type" range itself."""
    unmapped = [0, 1, 20, 29, 33, 34, 36, 37, 38, 39, 40, 49, 50, 51, 53, 54,
                55, 56, 57, 58, 59, 90, 91, 99]
    for code in unmapped:
        assert vp.cargo_class(code) == "other", f"code {code} should fall back to other"


def test_cargo_class_is_none_when_no_ship_type_was_ever_decoded():
    """None is a different claim from "other": one says AIS sent a code this
    table buckets as miscellaneous, the other says no static block ever
    arrived for this hull at all."""
    assert vp.cargo_class(None) is None
    assert vp.cargo_class("80") is None  # a string off a malformed payload, never trusted
    assert vp.cargo_class(True) is None  # bool is an int subclass; must not smuggle in as code 1


# --- laden / ballast: the two ratios, at their exact boundaries -------------


def test_laden_verdict_fires_strictly_above_the_laden_ratio():
    max_seen = 20.0
    just_above = max_seen * config.VESSEL_DRAUGHT_LADEN_RATIO + 0.01
    at_boundary = max_seen * config.VESSEL_DRAUGHT_LADEN_RATIO

    assert vp.laden_state(just_above, max_seen, 5) == ("laden", None)
    # Exactly at the ratio is not "above" it -- the brief's own word -- so it
    # falls into the unknown band, not laden.
    assert vp.laden_state(at_boundary, max_seen, 5) == ("unknown", None)


def test_ballast_verdict_fires_strictly_below_the_ballast_ratio():
    max_seen = 20.0
    just_below = max_seen * config.VESSEL_DRAUGHT_BALLAST_RATIO - 0.01
    at_boundary = max_seen * config.VESSEL_DRAUGHT_BALLAST_RATIO

    assert vp.laden_state(just_below, max_seen, 5) == ("ballast", None)
    assert vp.laden_state(at_boundary, max_seen, 5) == ("unknown", None)


def test_between_the_two_ratios_is_unknown_with_no_reason():
    max_seen = 20.0
    midpoint = max_seen * (config.VESSEL_DRAUGHT_LADEN_RATIO + config.VESSEL_DRAUGHT_BALLAST_RATIO) / 2
    assert vp.laden_state(midpoint, max_seen, 5) == ("unknown", None)


# --- insufficient samples ----------------------------------------------------


def test_fewer_than_the_minimum_distinct_samples_is_insufficient_samples():
    # Otherwise a clean laden read (current == max_seen), but the count is one
    # short of the threshold.
    assert vp.laden_state(20.0, 20.0, config.VESSEL_DRAUGHT_MIN_SAMPLES - 1) == (
        "unknown", "insufficient_samples",
    )


def test_exactly_the_minimum_sample_count_is_enough():
    assert vp.laden_state(20.0, 20.0, config.VESSEL_DRAUGHT_MIN_SAMPLES) == ("laden", None)


def test_a_hull_with_reports_but_no_decoded_draught_is_insufficient_samples():
    """The ruling from the module docstring: plenty of position reports, zero
    draught samples, reads exactly like "too few samples", not like a crash or
    a silently-omitted field."""
    entry = {"samples": {}, "last_seen": 100.0}  # no "current_draught" key at all
    profile = vp.build_profile(MMSI, entry, None, None, now=200.0)
    assert profile["laden_state"] == "unknown"
    assert profile["laden_state_reason"] == "insufficient_samples"
    assert profile["sample_count"] == 0
    assert profile["draught_max_seen"] is None
    assert profile["draught_current"] is None


def test_a_current_draught_older_than_the_retained_window_is_not_reported_as_current():
    """current_draught/current_ts are not pruned by apply_history the way
    `samples` are (see that function's own comment) -- build_profile is where
    a reading that old stops being called "current" instead."""
    entry = {
        "samples": {f"{v:.1f}": 0.0 for v in (10.0, 11.0, 12.0, 13.0, 14.0)},
        "current_draught": 14.0,
        "current_ts": 0.0,
    }
    now = config.HISTORY_RETENTION_SECONDS + 1.0
    profile = vp.build_profile(MMSI, entry, None, None, now=now)
    assert profile["draught_current"] is None
    # The samples themselves are untouched by build_profile -- only apply_history
    # prunes those -- so max/min still reflect what this entry was handed.
    assert profile["draught_max_seen"] == 14.0
    # No current draught to compare against, so laden_state falls into the
    # same "insufficient_samples" bucket as a hull with too few readings --
    # a stale current is not evidence, even though the samples exist.
    assert profile["laden_state"] == "unknown"
    assert profile["laden_state_reason"] == "insufficient_samples"


# --- no commodity, ever -------------------------------------------------------

# Deliberately excludes the word "commodity" itself -- the sentence is
# *supposed* to say "no commodity is asserted", and that is the guard working,
# not a violation of it. What must never appear is the name of an actual one.
_FORBIDDEN_COMMODITY_WORDS = (
    "crude", "chemical", "lng", "lpg", "product tanker", "oil cargo",
    "grain", "coal", "container cargo",
)


def _assert_no_commodity(profile: dict):
    assert profile["cargo_class"] in {
        "tanker", "cargo", "fishing", "passenger", "tug", "naval", "other", None,
    }
    assert "commodity" not in profile
    haystack = " ".join(str(v).lower() for v in profile.values() if v is not None)
    for word in _FORBIDDEN_COMMODITY_WORDS:
        assert word not in haystack, f"{word!r} leaked into a profile: {profile}"


def test_no_profile_ever_emits_a_commodity_across_every_ship_type_code():
    # Four draught pictures, chosen to land in each of laden/ballast/unknown/
    # insufficient_samples -- the commodity guard has to hold in every one.
    draught_scenarios = [
        ([20.0, 19.0, 18.0, 17.0, 16.0], 19.5),  # laden
        ([20.0, 14.0, 13.0, 12.0, 11.0], 11.5),  # ballast
        ([20.0, 14.0, 13.0, 12.0, 11.0], 15.0),  # unknown, between the ratios
        ([], None),                              # insufficient_samples
    ]
    for ship_type in list(range(0, 100)) + [None]:
        for samples, current in draught_scenarios:
            entry = {
                "samples": {f"{v:.1f}": 1.0 for v in samples},
                "current_draught": current,
                "current_ts": 1.0,  # matches `now` below -- well inside the retained window
                "ship_type": ship_type,
                "destination": "PORT OF EXAMPLE",
            }
            profile = vp.build_profile(MMSI, entry, "Example Port", "Exampleland", now=1.0)
            _assert_no_commodity(profile)


def test_implied_trade_sentence_never_asserts_a_commodity_and_shows_every_input():
    sentence = vp.implied_trade_sentence("ROTTERDAM", "Port of Rotterdam", "Netherlands")
    assert "ROTTERDAM" in sentence
    assert "Port of Rotterdam" in sentence
    assert "Netherlands" in sentence
    assert "no commodity is asserted" in sentence.lower()
    for word in _FORBIDDEN_COMMODITY_WORDS:
        assert word not in sentence.lower()


def test_implied_trade_sentence_degrades_honestly_with_nothing_known():
    sentence = vp.implied_trade_sentence(None, None, None)
    assert "no recorded port call" in sentence
    assert "no declared destination" in sentence
    assert "no commodity is asserted" in sentence.lower()


# --- the accumulator: distinct samples, current draught, the retained window -


def test_apply_history_counts_distinct_draught_values_not_rows():
    rows = [
        row(1, 0.0, draught=12.0),
        row(2, 10.0, draught=12.0),  # same reading again -- not a new sample
        row(3, 20.0, draught=13.5),
    ]
    new_state, touched = vp.apply_history(rows, {}, now_ts=20.0)
    assert touched == {MMSI}
    assert len(new_state[MMSI]["samples"]) == 2
    assert new_state[MMSI]["current_draught"] == 13.5  # the most recent reading


def test_apply_history_tracks_ship_type_and_destination_from_any_row():
    rows = [
        row(1, 0.0, ship_type=80),
        row(2, 10.0, destination="FUJAIRAH"),
    ]
    new_state, _touched = vp.apply_history(rows, {}, now_ts=10.0)
    assert new_state[MMSI]["ship_type"] == 80
    assert new_state[MMSI]["destination"] == "FUJAIRAH"


def test_apply_history_prunes_samples_older_than_the_retained_window():
    old = row(1, 0.0, draught=9.0)
    rows = [old]
    state, _touched = vp.apply_history(rows, {}, now_ts=0.0)
    assert len(state[MMSI]["samples"]) == 1

    # A later pass, far past HISTORY_RETENTION_SECONDS with no new draught --
    # the old sample must age out of the observed range.
    later_ts = config.HISTORY_RETENTION_SECONDS + 1.0
    state2, _touched2 = vp.apply_history([row(2, later_ts)], state, now_ts=later_ts)
    assert state2[MMSI]["samples"] == {}
    # apply_history itself never clears current_draught/current_ts -- they are
    # a separate field from the pruned samples dict -- but build_profile reads
    # `now` against current_ts and must not report a reading this stale as
    # "current" just because nothing newer ever arrived to overwrite it.
    profile = vp.build_profile(MMSI, state2[MMSI], None, None, now=later_ts)
    assert profile["laden_state_reason"] == "insufficient_samples"
    assert profile["draught_current"] is None


def test_apply_history_does_not_mutate_the_state_it_was_given():
    original = {MMSI: {"samples": {"12.0": 0.0}, "current_draught": 12.0}}
    frozen = copy.deepcopy(original)
    vp.apply_history([row(1, 100.0, draught=13.0)], original, now_ts=100.0)
    assert original == frozen


def test_apply_history_two_batches_accumulate_the_same_hull():
    state1, _t1 = vp.apply_history([row(1, 0.0, draught=10.0)], {}, now_ts=0.0)
    state2, touched2 = vp.apply_history([row(2, 100.0, draught=15.0)], state1, now_ts=100.0)
    assert touched2 == {MMSI}
    assert len(state2[MMSI]["samples"]) == 2
    assert state2[MMSI]["current_draught"] == 15.0


# --- the 20,000-hull cap: staleness, not sample richness ---------------------


def test_evict_lru_keeps_the_most_recently_seen_hulls():
    state = {
        "a": {"samples": {}, "last_seen": 10.0},
        "b": {"samples": {}, "last_seen": 30.0},
        "c": {"samples": {}, "last_seen": 20.0},
    }
    kept = vp._evict_lru(state, cap=2)
    assert set(kept) == {"b", "c"}


def test_evict_lru_is_a_no_op_under_the_cap():
    state = {"a": {"last_seen": 1.0}, "b": {"last_seen": 2.0}}
    assert vp._evict_lru(state, cap=10) == state


def test_evict_lru_keeps_a_thin_but_recent_hull_over_a_rich_but_stale_one():
    """The cap evicts by staleness, not by how much draught evidence a hull
    has accumulated -- see the module docstring's second ruling."""
    state = {
        "thin_but_recent": {"samples": {}, "last_seen": 100.0},
        "rich_but_stale": {
            "samples": {f"{v:.1f}": 0.0 for v in range(5, 25)},
            "last_seen": 1.0,
        },
    }
    kept = vp._evict_lru(state, cap=1)
    assert set(kept) == {"thin_but_recent"}


# --- run_once: the cursor and the fan-out to port_calls_for -----------------


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres,
    matching the shape of port_calls.py's own test double."""

    def __init__(self, rows, ports=None, port_calls=None, fail_names=frozenset()):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.ports = ports or []
        self.port_calls = port_calls or {}
        self.fail_names = set(fail_names)

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if name in self.fail_names:
            return False
        self.docs[name] = payload
        return True

    async def entity_latest(self, kind):
        return self.ports if kind == "ports" else []

    async def port_calls_for(self, mmsi, limit=20):
        return self.port_calls.get(mmsi, [])


def test_run_once_advances_the_cursor_and_writes_a_profile(monkeypatch):
    rows = [row(1, 0.0, draught=10.0, ship_type=80), row(2, 10.0, draught=17.0)]
    fake = _FakeStorage(rows)
    monkeypatch.setattr(vp, "storage", fake)

    result = _run(vp.run_once())
    assert result == {"read": 2, "touched": 1, "profiles": 1, "ok": True}
    assert fake.docs["vessel_profile_cursor"] == {"last_id": 2}
    profile = fake.docs["vessel_profiles"][MMSI]
    assert profile["cargo_class"] == "tanker"
    assert profile["draught_current"] == 17.0

    # Nothing new: the second pass asks for everything past id 2, not the
    # same rows again.
    second = _run(vp.run_once())
    assert second == {"read": 0, "touched": 0, "profiles": 0, "ok": True}
    assert fake.calls == [0, 2]


def test_run_once_reports_not_ok_when_only_the_cursor_write_fails(monkeypatch):
    """Pre-merge review, Also fix 1: the cursor write's own bool used to be
    discarded here, so a database hiccup on just that one write still
    reported "ok": True and a healthy source_health row -- the module's own
    docstring says the state/profile writes are deliberately unverified
    (they are idempotent under replay), but the cursor write failing is not
    something a caller should be able to mistake for a normal pass: it means
    this job is about to silently re-read the same batch forever without
    ever advancing, which source_health has to be able to show."""
    rows = [row(1, 0.0, draught=10.0, ship_type=80)]
    fake = _FakeStorage(rows, fail_names={vp.CURSOR_NAME})
    monkeypatch.setattr(vp, "storage", fake)

    result = _run(vp.run_once())
    assert result["ok"] is False
    # The profile/state writes are unaffected -- only the cursor failed.
    assert vp.CURSOR_NAME not in fake.docs
    assert fake.docs["vessel_profiles"][MMSI]["cargo_class"] == "tanker"


def test_run_once_resolves_the_last_port_calls_country_into_the_sentence(monkeypatch):
    rows = [row(1, 0.0, draught=10.0, destination="ROTTERDAM")]
    fake = _FakeStorage(
        rows,
        ports=[{"id": "wpi-1", "name": "Port of Rotterdam", "country": "Netherlands", "lat": 1.0, "lon": 2.0}],
        port_calls={MMSI: [{"port_id": "wpi-1", "arrived_at": 0.0, "departed_at": None,
                             "draught_in": 10.0, "draught_out": None, "confidence": "exact"}]},
    )
    monkeypatch.setattr(vp, "storage", fake)

    _run(vp.run_once())
    sentence = fake.docs["vessel_profiles"][MMSI]["implied_trade"]
    assert "Port of Rotterdam" in sentence
    assert "Netherlands" in sentence
    assert "ROTTERDAM" in sentence


def test_run_once_is_a_no_op_when_there_is_nothing_new(monkeypatch):
    fake = _FakeStorage([])
    monkeypatch.setattr(vp, "storage", fake)
    result = _run(vp.run_once())
    assert result == {"read": 0, "touched": 0, "profiles": 0, "ok": True}
    assert fake.docs == {}


def test_a_hull_that_goes_dark_decays_instead_of_freezing_at_its_last_verdict(monkeypatch):
    """The Task 16 review's Important finding: a hull that stops reporting
    must not keep serving its last confident laden_state/draught_current
    forever just because build_profile only ever ran for it once. Other AIS
    traffic (a second, unrelated hull) keeps the cursor moving and keeps
    apply_history's pruning running against every hull in the accumulator,
    including the one that has gone quiet -- see the module docstring."""
    OTHER = "999999999"
    confident_rows = [
        row(i + 1, float(i), draught=v, ship_type=80)
        for i, v in enumerate((16.0, 17.0, 18.0, 19.0, 20.0))
    ]
    fake = _FakeStorage(confident_rows)
    monkeypatch.setattr(vp, "storage", fake)

    _run(vp.run_once())
    profile = fake.docs["vessel_profiles"][MMSI]
    assert profile["laden_state"] == "laden"
    assert profile["draught_current"] == 20.0
    assert profile["sample_count"] == 5

    # Far enough past HISTORY_RETENTION_SECONDS (from *every* one of MMSI's
    # old timestamps, not just the newest) that every sample ages out -- but
    # the batch itself only ever mentions a different hull, so MMSI is never
    # in `touched` again.
    later_ts = 2 * config.HISTORY_RETENTION_SECONDS
    fake.history.append(row(6, later_ts, mmsi=OTHER, draught=5.0))

    served = _run(vp.run_once())
    assert served["touched"] == 1  # only OTHER reported this pass
    profile = fake.docs["vessel_profiles"][MMSI]
    assert profile["laden_state"] == "unknown"
    assert profile["laden_state_reason"] == "insufficient_samples"
    assert profile["draught_current"] is None
    assert profile["sample_count"] == 0
    # The dark hull is still in the document -- it has not been evicted, its
    # verdict has simply stopped overclaiming.
    assert MMSI in fake.docs["vessel_profiles"]
