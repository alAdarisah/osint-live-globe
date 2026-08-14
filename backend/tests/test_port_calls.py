"""Dwell detection at its boundaries, and the incremental read it runs on.

AIS gives a position and a speed, never a berth -- see the module docstring on
backend/refine/port_calls.py. What these tests hold the line on is the two
numbers that turn "sat still" into "called at a port" (an hour, half an hour)
and the honesty of the three-tier confidence that follows from how far the
nearest port actually was, not from a guess.
"""

import asyncio
import copy

from backend.refine import port_calls as pc
from backend.sources.proximity import ProximityIndex

MMSI = "244660724"
HOUR = 3600.0

# A single charted port at a fixed point, reused across tests. 1 degree of
# latitude is ~111.32km everywhere, unlike longitude, so offsetting only
# latitude gives a great-circle distance close enough to nominal for these
# fixtures without importing a projection.
PORT_LAT, PORT_LON = 26.0, 56.0
PORT = {"id": "test-port", "name": "Test Port", "lat": PORT_LAT, "lon": PORT_LON}
PORTS = ProximityIndex([PORT])
NO_PORTS = ProximityIndex([])


def km_offset(km: float) -> float:
    return km / 111.32


def pos(id_, ts, lat=PORT_LAT, lon=PORT_LON, speed=0.1, draught=12.0, mmsi=MMSI) -> dict:
    return {
        "id": id_, "entity_id": mmsi, "ts": ts, "lat": lat, "lon": lon,
        "payload": {"speed": speed, "draught": draught},
    }


def _run(coro):
    return asyncio.run(coro)


# --- dwell detection at the boundaries --------------------------------------


def test_a_dwell_of_exactly_one_hour_opens_a_call():
    rows = [pos(1, 0.0), pos(2, HOUR)]
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert len(upserts) == 1
    call = upserts[0]
    assert call["mmsi"] == MMSI
    assert call["port_id"] == "test-port"
    assert call["arrived_at"] == 0.0
    assert call["departed_at"] is None
    assert call["confidence"] == "exact"
    assert state[MMSI]["run"]["phase"] == "open"


def test_a_dwell_of_fifty_nine_minutes_does_not_open_a_call():
    rows = [pos(1, 0.0), pos(2, HOUR - 60.0)]
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert upserts == []
    assert state[MMSI]["run"]["phase"] == "candidate"


def test_draught_in_is_the_last_position_before_the_dwell_began():
    """Not the arrival row's own draught -- the one just before it, while the
    hull was still under way (see the brief's own wording)."""
    rows = [
        pos(1, -600.0, speed=6.0, draught=14.0),  # still making way
        pos(2, 0.0, draught=13.9),                # the dwell begins
        pos(3, HOUR, draught=13.9),                # crosses the threshold
    ]
    (call,), _state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert call["draught_in"] == 14.0


def test_a_dwell_with_no_port_anywhere_near_opens_nothing():
    """An hour stationary in open water is not a port call, however sure the
    dwell itself is -- see PORT_SEARCH_RADIUS_KM."""
    rows = [pos(1, 0.0), pos(2, HOUR)]
    upserts, state, rejected = pc.apply_positions(rows, NO_PORTS, {})
    assert upserts == []
    # Nothing left to track either: the run was discarded, not parked.
    assert state.get(MMSI, {}).get("run") is None
    assert rejected == 1


# --- the departure rule ------------------------------------------------------


def test_departure_requires_thirty_sustained_minutes_above_one_knot():
    rows = [
        pos(1, 0.0), pos(2, HOUR),          # opens the call at t=3600
        pos(3, HOUR + 1800.0, speed=3.0),   # starts moving at t=5400
        pos(4, HOUR + 1800.0 + 1800.0, speed=3.0),  # sustained 30 more minutes
    ]
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert len(upserts) == 2
    opened, closed = upserts
    assert closed["arrived_at"] == opened["arrived_at"]
    assert closed["departed_at"] == HOUR + 1800.0
    assert MMSI not in state or state[MMSI].get("run") is None


def test_departure_draught_out_is_the_last_slow_reading_before_leaving():
    rows = [
        pos(1, 0.0, draught=14.0),
        pos(2, HOUR, draught=12.5),           # opens; discharged some cargo already
        pos(3, HOUR + 1800.0, speed=2.0),      # starts moving
        pos(4, HOUR + 1800.0 + 1800.0, speed=2.0),
    ]
    upserts, _state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert upserts[1]["draught_out"] == 12.5


def test_a_brief_speed_blip_short_of_thirty_minutes_does_not_close_the_call():
    rows = [
        pos(1, 0.0), pos(2, HOUR),                 # opens
        pos(3, HOUR + 600.0, speed=2.0),            # 10 minutes fast
        pos(4, HOUR + 900.0),                       # back to slow before 30min
    ]
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert len(upserts) == 1  # only the opening -- no close
    assert state[MMSI]["run"]["phase"] == "open"
    assert "moving_since" not in state[MMSI]["run"]


# --- re-entry must not spawn a second call ----------------------------------


def test_reentry_within_the_same_hour_does_not_open_a_second_call():
    """A blip above departure speed that never sustains, followed by more
    dwelling well past another hour, must still be the one original call."""
    rows = [
        pos(1, 0.0), pos(2, HOUR),                   # opens at t=3600
        pos(3, HOUR + 100.0, speed=2.0),              # brief excursion
        pos(4, HOUR + 150.0),                         # back to slow
        pos(5, HOUR + 5000.0),                        # still dwelling, long after
    ]
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert len(upserts) == 1
    assert upserts[0]["departed_at"] is None
    assert state[MMSI]["run"]["phase"] == "open"


# --- confidence, each of the three tiers ------------------------------------


def test_confidence_is_exact_inside_the_ports_own_radius():
    lat = PORT_LAT + km_offset(1.0)
    rows = [pos(1, 0.0, lat=lat), pos(2, HOUR, lat=lat)]
    (call,), _state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert call["confidence"] == "exact"


def test_confidence_is_proximity_inside_the_wider_radius():
    lat = PORT_LAT + km_offset(8.0)
    rows = [pos(1, 0.0, lat=lat), pos(2, HOUR, lat=lat)]
    (call,), _state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert call["confidence"] == "proximity"


def test_confidence_is_inferred_beyond_the_proximity_radius():
    lat = PORT_LAT + km_offset(30.0)
    rows = [pos(1, 0.0, lat=lat), pos(2, HOUR, lat=lat)]
    (call,), _state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert call["confidence"] == "inferred"
    # Still attributed to the nearest port, and the card is the one that has
    # to say how far -- this module never claims more than the tier itself.
    assert call["port_id"] == "test-port"


def test_beyond_the_search_ceiling_nothing_is_attributed_at_all():
    lat = PORT_LAT + km_offset(pc.PORT_SEARCH_RADIUS_KM + 5.0)
    rows = [pos(1, 0.0, lat=lat), pos(2, HOUR, lat=lat)]
    upserts, _state, rejected = pc.apply_positions(rows, PORTS, {})
    assert upserts == []
    # Not silent, either -- see the ruling on PORT_SEARCH_RADIUS_KM: a dwell
    # rejected for having no attributable port is counted, not just dropped.
    assert rejected == 1


# --- defensive parsing --------------------------------------------------------


def test_a_row_with_no_usable_speed_is_skipped_rather_than_crashing():
    rows = [pos(1, 0.0), pos(2, HOUR / 2, speed=None), pos(3, HOUR)]
    # The unreadable sample breaks the run (treated as "not slow"), so the
    # dwell restarts from row 3 and never reaches an hour within this batch.
    upserts, state, _rejected = pc.apply_positions(rows, PORTS, {})
    assert upserts == []
    assert state[MMSI]["run"]["since"] == HOUR


# --- the cursor: advancing, and never asked twice ---------------------------


class _FakeStorage:
    """Just enough of backend.storage to drive run_once() without Postgres.

    `history` is the fake entity_history table: entity_history_since()
    answers strictly id > after_id, exactly like the real query, so a bug
    that reused an old cursor would show up as the same rows coming back
    twice rather than as a test double that was never faithful to begin with.

    `write_ok` mirrors storage.record_port_calls's own return value -- True by
    default (a healthy database), settable to False to play back the one
    failure mode run_once has to survive without losing data (see Important 1
    of the Task 15 review and run_once's docstring).

    `fail_names` fails only the named reference_snapshots writes (pre-merge
    review, Critical: record_port_calls can durably succeed while the state
    document write that follows it fails on its own -- write_ok alone can
    only fail everything together, which never exercises that interleaving --
    see test_a_failed_state_write_holds_the_cursor_back_and_does_not_double_
    the_open_call below), matching test_jam_crosscheck.py's own _FakeStorage.
    """

    def __init__(self, rows, write_ok=True, fail_names=frozenset()):
        self.history = rows
        self.docs = {}
        self.calls = []
        self.port_call_batches = []
        self.write_ok = write_ok
        self.fail_names = set(fail_names)

    async def entity_history_since(self, kind, after_id, limit):
        self.calls.append(after_id)
        return [r for r in self.history if r["id"] > after_id][:limit]

    async def reference(self, name):
        return self.docs.get(name)

    async def record_reference(self, name, payload):
        if not self.write_ok or name in self.fail_names:
            return False
        self.docs[name] = payload
        return True

    async def entity_latest(self, kind):
        return []

    async def record_port_calls(self, rows):
        self.port_call_batches.append(rows)
        return self.write_ok


def _stub_ports(monkeypatch):
    """run_once() builds its port index from real curated infrastructure data
    (see _load_ports), which these tests must not depend on -- whether (26,
    56) happens to fall within 50km of some real curated harbour is not a
    thing a cursor/write-ordering test should care about, and relying on it
    would make the test's outcome a coincidence of that list's contents."""
    async def load():
        return PORTS
    monkeypatch.setattr(pc, "_load_ports", load)


def test_the_cursor_advances_and_a_second_pass_does_not_reprocess(monkeypatch):
    rows = [pos(1, 0.0), pos(2, HOUR), pos(3, HOUR + 10000.0, speed=5.0)]
    fake = _FakeStorage(rows)
    monkeypatch.setattr(pc, "storage", fake)
    _stub_ports(monkeypatch)

    first = _run(pc.run_once())
    assert first["read"] == 3
    assert first["ok"] is True
    assert first["calls"] == 1  # the dwell at t=0..HOUR opens one call
    assert fake.calls == [0]  # no cursor stored yet -- starts from id 0
    assert fake.docs["port_calls_cursor"] == {"last_id": 3}

    # Nothing new since the last pass: the second call must ask for
    # everything past id 3, not repeat the first request.
    second = _run(pc.run_once())
    assert second["read"] == 0
    assert fake.calls == [0, 3]


def test_a_pass_with_nothing_new_leaves_the_cursor_untouched(monkeypatch):
    """run_once() returns early on an empty batch -- see the module docstring
    on why the cursor is only ever advanced past rows actually read."""
    fake = _FakeStorage([pos(1, 0.0), pos(2, HOUR)])
    monkeypatch.setattr(pc, "storage", fake)
    _stub_ports(monkeypatch)

    _run(pc.run_once())
    stored_after_first = dict(fake.docs)
    result = _run(pc.run_once())
    assert result == {"read": 0, "calls": 0, "rejected": 0, "ok": True}
    assert fake.docs == stored_after_first


def test_a_failed_write_holds_the_cursor_back_for_a_retry(monkeypatch):
    """Important 1 of the Task 15 review: record_port_calls logging and
    returning on a Postgres hiccup must not read as "succeeded" here, because
    unlike a snapshot source this job never revisits an entity_history id it
    has already passed -- entity_history is pruned at three days, so a batch
    whose calls were never durably written would otherwise be gone for good."""
    rows = [pos(1, 0.0), pos(2, HOUR)]  # opens a call
    fake = _FakeStorage(rows, write_ok=False)
    monkeypatch.setattr(pc, "storage", fake)
    _stub_ports(monkeypatch)

    result = _run(pc.run_once())
    assert result["ok"] is False
    assert result["read"] == 2
    # Nothing durable happened: no cursor, no state document.
    assert fake.docs == {}

    # The database recovers; the same batch is offered again, not skipped.
    fake.write_ok = True
    retry = _run(pc.run_once())
    assert retry["ok"] is True
    assert retry["calls"] == 1
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs["port_calls_cursor"] == {"last_id": 2}


def test_a_failed_state_write_holds_the_cursor_back_and_does_not_double_the_open_call(monkeypatch):
    """Pre-merge review, Critical: record_port_calls durably wrote the open
    call, but the state document write that follows it failed on its own --
    the old code discarded that bool and wrote the cursor anyway, which lost
    the only durable record that this hull already has an open call here.
    The vessel's *next* dwell at the same port would then open a second,
    unrelated call rather than ever closing the first one.

    Unlike test_a_failed_write_holds_the_cursor_back_for_a_retry above (which
    fails record_port_calls itself, via write_ok=False), this fails *only*
    the state write -- record_port_calls succeeds and is durably recorded --
    which is the one interleaving that test never exercised."""
    rows = [pos(1, 0.0), pos(2, HOUR)]  # opens a call
    fake = _FakeStorage(rows, fail_names={pc.STATE_NAME})
    monkeypatch.setattr(pc, "storage", fake)
    _stub_ports(monkeypatch)

    first = _run(pc.run_once())
    assert first["ok"] is False
    assert first["calls"] == 0
    # The call itself did land durably (record_port_calls is idempotent and
    # ran first) -- what's missing is the state that would stop it being
    # opened a second time.
    assert len(fake.port_call_batches) == 1
    assert fake.port_call_batches[0][0]["arrived_at"] == 0.0
    # Nothing else is durable: neither the state document nor the cursor.
    assert pc.STATE_NAME not in fake.docs
    assert pc.CURSOR_NAME not in fake.docs

    # The database recovers; the same batch -- read from the same
    # untouched cursor, against the same (still-empty) state -- is replayed.
    fake.fail_names.clear()
    retry = _run(pc.run_once())
    assert retry["ok"] is True
    assert retry["calls"] == 1
    assert fake.calls == [0, 0]  # both passes started from the same cursor
    assert fake.docs[pc.CURSOR_NAME] == {"last_id": 2}

    # Idempotent replay, not a second call: the retry's own batch is exactly
    # the first attempt's batch, not a second dwell opened alongside it.
    assert len(fake.port_call_batches) == 2
    assert fake.port_call_batches[0] == fake.port_call_batches[1]
    assert fake.docs[pc.STATE_NAME]["entities"][MMSI]["run"]["phase"] == "open"


# --- Task 52: recovering from an old-shaped state document -----------------


def test_run_once_recovers_from_the_pre_wrap_state_shape(monkeypatch, caplog):
    """Every port_calls_state document on disk before Task 52 is a bare
    {mmsi: entry} map -- no "entities" key, no "schema_version" key. Handed
    straight to apply_positions via a naive _load_state, this would work fine
    today, but it is exactly the shape a future entry-level change (like
    jam_crosscheck.py's own real incident, see that module's docstring) could
    break in a way _advance's own dict access would raise on, permanently
    freezing the cursor with source_health merely red. This drives the whole
    stack through run_once() itself -- _load_state, apply_positions, both
    writes -- not just the version check in isolation, matching Task 39
    review's own instruction for jam_crosscheck's identical test.
    """
    old_shaped_state = {MMSI: {"run": {"phase": "candidate", "since": 0.0, "lat": PORT_LAT, "lon": PORT_LON}}}
    rows = [pos(1, 0.0), pos(2, HOUR)]  # would otherwise complete the dwell begun in `old_shaped_state`
    fake = _FakeStorage(rows)
    fake.docs[pc.STATE_NAME] = old_shaped_state
    monkeypatch.setattr(pc, "storage", fake)
    _stub_ports(monkeypatch)

    with caplog.at_level("WARNING", logger="osint-globe.refine"):
        result = _run(pc.run_once())
    assert result["ok"] is True  # did not raise
    assert any("schema_version" in r.message for r in caplog.records)  # logged, not silent

    # The old candidate run is gone -- state was discarded wholesale, not
    # selectively repaired -- so this pass's own hour-long dwell opens fresh
    # from row 1, exactly as it would against a genuinely empty state.
    assert result["calls"] == 1
    assert fake.docs[pc.STATE_NAME]["schema_version"] == pc.STATE_SCHEMA_VERSION
    assert fake.docs[pc.STATE_NAME]["entities"][MMSI]["run"]["phase"] == "open"
    # The cursor still advanced past this pass's own rows -- a state reset
    # must never rewind or stall the cursor (see the module docstring).
    assert fake.docs[pc.CURSOR_NAME] == {"last_id": 2}


def test_apply_positions_does_not_mutate_the_state_it_was_given():
    """Minor 3 of the Task 15 review: _advance used to be handed a shallow
    copy of a vessel's entry, so its nested "run"/"last" dicts were the same
    objects as the caller's -- harmless while run_once discarded `state`
    immediately, but exactly the trap a caller that retries on the same
    `state` (see the write-failure test above) would fall into."""
    original = {MMSI: {"run": {"phase": "candidate", "since": 0.0, "lat": PORT_LAT, "lon": PORT_LON}}}
    frozen = copy.deepcopy(original)

    rows = [pos(1, HOUR)]  # crosses the threshold, mutating a "run" in place if shared
    pc.apply_positions(rows, PORTS, original)

    assert original == frozen


def test_a_dwell_spanning_two_batches_still_opens_a_call():
    """The two-pass path Minor 4 of the Task 15 review asked to be driven
    directly: a candidate opened in one apply_positions call must still cross
    the hour mark in a later call fed the first call's own returned state."""
    first_rows = [pos(1, 0.0)]
    upserts_1, state_1, _rejected_1 = pc.apply_positions(first_rows, PORTS, {})
    assert upserts_1 == []
    assert state_1[MMSI]["run"]["phase"] == "candidate"

    second_rows = [pos(2, HOUR)]
    upserts_2, state_2, _rejected_2 = pc.apply_positions(second_rows, PORTS, state_1)
    assert len(upserts_2) == 1
    assert upserts_2[0]["arrived_at"] == 0.0
    assert state_2[MMSI]["run"]["phase"] == "open"
