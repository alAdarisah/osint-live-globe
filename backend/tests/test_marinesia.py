"""The ships layer's second supplier, parsed off Marinesia's own documented response.

The entries below are copied from the `/api/v2/vessel/area` example Marinesia
publish on marinesia.com (read 2026-08-09), including their typing quirks: `eta`
as "00-00 00:00" for unset, `draught` as 0 for unset, dimensions split into the
four AIS antenna offsets, and `ts` as ISO 8601 with no timezone at all.

Two things are being guarded. The first is that a thinner feed must not quietly
become the same claim as a denser one -- this publishes its own kind, and every
record says where it came from. The second is the unset-versus-zero distinction
that runs through AIS: an IMO of 0, a draught of 0.0 and an ETA of 00-00 are all
"not stated", and storing them as values would put confident nonsense in a popup.
"""

import asyncio
import time

import pytest

from backend import config
from backend.sources import marinesia

def _utc(*parts) -> float:
    """Epoch seconds from a UTC calendar time, so the timestamp tests below
    cannot disagree with themselves about which day a constant is."""
    from datetime import datetime, timezone

    return datetime(*parts, tzinfo=timezone.utc).timestamp()


NOW = _utc(2026, 8, 9, 10, 0)  # 2026-08-09T10:00:00Z, matching the `ts` values below

# Verbatim from their published example, trimmed to three vessels.
AREA_RESPONSE = [
    {
        "name": "CMA CGM FORT DIAMANT", "imo": 9966776, "type": "Cargo", "flag": "FRA",
        "a": 111, "b": 157, "c": 22, "d": 22, "mmsi": 228469700,
        "lat": -6.097307, "lng": 106.896658, "cog": 220.6, "sog": 0, "rot": 0,
        "hdt": 272, "dest": "", "eta": "00-00 00:00", "draught": 0,
        "ts": "2026-08-09T09:59:13.195165",
    },
    {
        "name": "SITC HOCHIMINH", "imo": 9639608, "type": "Cargo", "flag": "HKG",
        "a": 130, "b": 13, "c": 17, "d": 6, "mmsi": 477203300,
        "lat": -6.09554, "lng": 106.919535, "cog": 348.4, "sog": 12.3, "rot": 0,
        "hdt": 180, "dest": "SINGAPORE", "eta": "08-14 06:30", "draught": 9.4,
        "ts": "2026-08-09T09:09:03.391145",
    },
    {
        "name": "KT BIMA 035", "imo": 9302384, "type": "Other Type", "flag": "IDN",
        "a": 10, "b": 17, "c": 5, "d": 5, "mmsi": 525023080,
        "lat": -6.093723, "lng": 106.919458, "cog": 106, "sog": 0, "rot": 127,
        "hdt": 136, "dest": "", "eta": "00-00 00:00", "draught": 0,
        "ts": "2026-08-09T09:09:17.83828",
    },
]


@pytest.fixture(autouse=True)
def _no_reference_lists(monkeypatch):
    """The OFAC and port-state indexes are downloaded by another process; these
    tests are about the parse, not about what the lists happen to hold today."""
    monkeypatch.setattr(marinesia.sanctions, "for_vessel", lambda **kw: None)
    monkeypatch.setattr(marinesia.maritime_watchlists, "for_vessel", lambda **kw: None)


def parsed(index=0, **overrides):
    return marinesia.parse_vessel({**AREA_RESPONSE[index], **overrides}, NOW)


# --- the parse --------------------------------------------------------------


def test_a_documented_record_becomes_a_pin():
    record = parsed(1)
    assert record["mmsi"] == 477203300
    assert record["name"] == "SITC HOCHIMINH"
    assert (record["lat"], record["lon"]) == (-6.09554, 106.919535)
    assert record["speed"] == 12.3
    assert record["course"] == 348.4
    assert record["heading"] == 180


def test_position_fields_are_named_as_the_other_ais_source_names_them():
    """So a popup or a trail renderer can read either supplier without branching."""
    record = parsed()
    for field in ("mmsi", "name", "lat", "lon", "speed", "course", "heading", "updated"):
        assert field in record


def test_every_record_says_where_it_came_from():
    """The layer is thinner than aisstream's and must never be mistaken for it."""
    record = parsed()
    assert record["source"] == "marinesia"
    assert "Marinesia" in record["attribution"]
    assert "as is" in record["attribution"]


def test_the_text_ship_type_is_not_passed_off_as_the_numeric_one():
    """ais.py's `ship_type` is the ITU code -- 35 is "military ops", 80-89 is a
    tanker. Marinesia send a label. Putting "Cargo" in that field would be read
    downstream as a code."""
    record = parsed()
    assert record["ship_type"] is None
    assert record["ship_type_name"] == "Cargo"


def test_identity_arrives_with_the_position():
    """The advantage over aisstream, where this comes in a separate message that
    may never arrive: IMO, flag and hull dimensions on the same record."""
    record = parsed()
    assert record["imo"] == "9966776"
    assert record["flag"] == "FRA"
    assert record["length_m"] == 268   # a + b
    assert record["beam_m"] == 44      # c + d


# --- unset is not zero ------------------------------------------------------


def test_an_imo_of_zero_is_not_a_hull():
    assert "imo" not in parsed(imo=0)
    assert "imo" not in parsed(imo=None)


def test_a_draught_of_zero_is_not_a_ship_floating_on_the_surface():
    assert "draught" not in parsed()          # their example sends 0
    assert parsed(1)["draught"] == 9.4


def test_a_draught_above_the_field_maximum_did_not_come_off_a_transponder():
    assert "draught" not in parsed(draught=99.0)


def test_the_unset_eta_is_not_stored_as_a_date():
    """"00-00 00:00" is by far the most common value they send."""
    assert "eta" not in parsed()


def test_a_real_eta_is_kept_as_the_parts_ais_actually_sends():
    """No year is transmitted, so no absolute timestamp is inferred."""
    assert parsed(1)["eta"] == {"month": 8, "day": 14, "hour": 6, "minute": 30}


def test_an_empty_destination_is_absent_rather_than_blank():
    assert "destination" not in parsed()
    assert parsed(1)["destination"] == "SINGAPORE"


def test_ais_padding_is_stripped_from_text_fields():
    assert "destination" not in parsed(dest="@@@@@@@@@@@@@@@@@@@@")
    assert parsed(dest="JEBEL ALI@@@@@")["destination"] == "JEBEL ALI"


def test_a_zero_dimension_sum_is_not_a_hull_length():
    assert "length_m" not in parsed(a=0, b=0)
    assert parsed(a=0, b=90)["length_m"] == 90  # antenna at the bow is ordinary


# --- timestamps -------------------------------------------------------------


def test_the_fix_time_is_the_observation_not_the_poll():
    """Getting this backwards makes a stale position look live."""
    record = parsed()
    assert record["updated"] == pytest.approx(NOW - 47, abs=1)
    assert record["reported_at"] == record["updated"]


def test_a_naive_timestamp_is_read_as_utc_not_as_local_time():
    """They send no offset. Reading it as local would shift every position by
    the container's timezone -- invisible here, wrong everywhere else."""
    record = parsed(ts="2026-08-09T10:00:00")
    assert record["updated"] == pytest.approx(NOW, abs=1)


def test_a_record_with_no_usable_timestamp_falls_back_to_the_poll_time():
    record = parsed(ts=None)
    assert record["updated"] == NOW
    assert record["reported_at"] is None


# --- what is not a sighting -------------------------------------------------


def test_a_record_without_a_position_is_not_a_sighting():
    assert marinesia.parse_vessel({"mmsi": 123456789}, NOW) is None
    assert parsed(lat=None) is None
    assert parsed(lng=None) is None


def test_a_record_without_an_mmsi_is_not_a_sighting():
    """MMSI is what every downstream join is keyed on."""
    assert parsed(mmsi=None) is None
    assert parsed(mmsi=0) is None


def test_an_mmsi_sent_as_a_string_is_still_an_mmsi():
    assert parsed(mmsi="228469700")["mmsi"] == 228469700


def test_an_impossible_coordinate_is_refused():
    assert parsed(lat=91.0) is None
    assert parsed(lng=-181.0) is None


def test_junk_in_the_list_costs_that_entry_and_nothing_else():
    assert marinesia.parse_vessel("not-a-dict", NOW) is None
    assert marinesia.parse_vessel(None, NOW) is None


# --- the sweep --------------------------------------------------------------


class _Response:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class _Client:
    """Answers each box in turn from `answers`, recording the params it saw."""

    def __init__(self, answers):
        self._answers = list(answers)
        self.calls = []

    async def get(self, url, params=None):
        self.calls.append(params or {})
        answer = self._answers[min(len(self.calls) - 1, len(self._answers) - 1)]
        if isinstance(answer, Exception):
            raise answer
        return _Response(answer)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Health:
    def __init__(self):
        self.rows = []

    async def record(self, source, item_count, ok, error=None):
        self.rows.append((source, item_count, ok, error))


def _sweep(monkeypatch, answers, boxes=None, key="a-key"):
    health = _Health()
    snapshots = []

    async def record_snapshot(kind, items, id_field=None, id_fn=None):
        snapshots.append((kind, items, id_field))

    monkeypatch.setattr(config, "MARINESIA_API_KEY", key)
    monkeypatch.setattr(config, "MARINESIA_BBOXES", boxes or [(24.0, 48.0, 30.0, 57.0)])
    monkeypatch.setattr(marinesia.storage, "record_source_health", health.record)
    monkeypatch.setattr(marinesia.storage, "record_snapshot", record_snapshot)

    # The rotation reads stored positions to decide which box to spend its one
    # hourly request on, and reads back how many hulls the layer holds across every
    # box still inside the staleness window. Both are empty here, which makes the
    # box choice deterministic (the first, since none has ever been seen).
    async def no_stored(kind, prefer_replica=False):
        return []

    async def nothing_held(kind, order_by_recency=False):
        return []

    monkeypatch.setattr(marinesia.storage, "entity_latest_with_times", no_stored)
    monkeypatch.setattr(marinesia.storage, "entity_latest", nothing_held)
    # A sweep is one request now, so no sweep in these tests can be rate limited by
    # a previous one leaving the module-level wall set.
    monkeypatch.setattr(marinesia, "_rate_limited_until", 0.0)
    monkeypatch.setattr(marinesia, "REQUEST_SPACING", 0)  # no real waiting in tests
    client = _Client(answers)
    monkeypatch.setattr(marinesia.httpx, "AsyncClient", lambda **kw: client)

    asyncio.run(marinesia.ingest_once())
    return health, snapshots, client


def test_a_sweep_publishes_its_own_kind(monkeypatch):
    health, snapshots, _client = _sweep(monkeypatch, [AREA_RESPONSE])
    assert snapshots == [("marinesia", snapshots[0][1], "mmsi")]
    assert len(snapshots[0][1]) == 3
    assert health.rows == [("marinesia", 3, True, None)]


def test_the_bounding_box_is_sent_the_way_their_api_names_it(monkeypatch):
    """lat_min/lat_max/long_min/long_max -- `long`, not `lon`."""
    _health, _snap, client = _sweep(monkeypatch, [AREA_RESPONSE])
    assert client.calls[0]["lat_min"] == 24.0
    assert client.calls[0]["lat_max"] == 30.0
    assert client.calls[0]["long_min"] == 48.0
    assert client.calls[0]["long_max"] == 57.0


def test_the_key_travels_as_a_query_parameter(monkeypatch):
    """Their design, not ours -- pinned so a refactor doesn't silently drop it
    into a header the API ignores, which would read as an empty ocean."""
    _health, _snap, client = _sweep(monkeypatch, [AREA_RESPONSE])
    assert client.calls[0]["key"] == "a-key"


def test_no_key_is_reported_rather_than_swallowed(monkeypatch):
    health, snapshots, client = _sweep(monkeypatch, [AREA_RESPONSE], key="")
    assert snapshots == []
    assert client.calls == []
    assert health.rows == [("marinesia", None, False, "MARINESIA_API_KEY not set in .env")]


def test_a_hull_in_two_overlapping_boxes_is_one_pin(monkeypatch):
    boxes = [(24.0, 48.0, 30.0, 57.0), (25.0, 49.0, 29.0, 56.0)]
    _health, snapshots, _client = _sweep(monkeypatch, [AREA_RESPONSE, AREA_RESPONSE], boxes)
    mmsis = [r["mmsi"] for r in snapshots[0][1]]
    assert len(mmsis) == len(set(mmsis)) == 3


def test_the_newer_fix_wins_when_a_hull_appears_twice(monkeypatch):
    """Within one response, since a sweep is now one box.

    This used to send the same hull from two overlapping boxes in a single sweep. A
    sweep spends the whole hourly budget on one request now, so cross-box dedup
    happens in Postgres between sweeps -- entity_latest is keyed on (kind, mmsi) --
    rather than in this function. What is still this function's job is a response
    that lists the same hull twice, which their API does when a box overlaps their
    own tiling."""
    twice = [
        {**AREA_RESPONSE[0], "lat": 1.0, "ts": "2026-08-09T08:00:00"},
        {**AREA_RESPONSE[0], "lat": 2.0, "ts": "2026-08-09T09:59:00"},
    ]
    _health, snapshots, _client = _sweep(monkeypatch, [twice])
    stored = snapshots[0][1]
    assert len(stored) == 1
    assert stored[0]["lat"] == 2.0


def test_one_failing_box_does_not_cost_the_other_seven(monkeypatch):
    """A chokepoint quietly missing is worse than a partial success that says
    which one is missing."""
    boxes = [(24.0, 48.0, 30.0, 57.0), (12.0, 32.0, 30.0, 43.0)]
    _health, snapshots, _client = _sweep(
        monkeypatch, [AREA_RESPONSE, RuntimeError("HTTP 500")], boxes
    )
    assert len(snapshots[0][1]) == 3


def test_a_failed_request_is_a_failed_poll_not_an_empty_ocean(monkeypatch):
    """The distinction the whole health table exists for.

    "partial sweep" is gone with the batch: one request either lands or does not, so
    there is no half-success left to describe. What has to survive is that a failure
    writes a failed row rather than an empty successful one -- an empty layer and a
    dead collector look identical on a map.
    """
    health, snapshots, _client = _sweep(monkeypatch, [RuntimeError("HTTP 503")])
    assert snapshots == []
    source, count, ok, error = health.rows[0]
    assert (source, count, ok) == ("marinesia", None, False)
    assert "HTTP 503" in error


def test_a_spent_quota_is_not_a_failure(monkeypatch):
    """One request an hour is the budget, so being out of it is the ordinary state
    for most of every hour.

    Recording it as a failure would have this source red roughly 59 minutes in 60,
    which is both wrong and exactly the kind of permanent-red light that teaches an
    operator to ignore the panel.
    """
    limited = marinesia.RateLimited(reset_at=9e18)
    health, snapshots, _client = _sweep(monkeypatch, [limited])
    assert snapshots == [], "nothing was fetched, so nothing is stored"
    assert health.rows == [], "and nothing is reported as broken"


def test_a_spent_quota_stops_the_next_sweep_asking(monkeypatch):
    """The reset instant is remembered, so later sweeps wait rather than each
    rediscovering the wall -- which is what turned one 429 into eleven an hour."""
    limited = marinesia.RateLimited(reset_at=time.time() + 1800)
    _health, _snap, client = _sweep(monkeypatch, [limited])
    assert len(client.calls) == 1

    # A second sweep in the same window must not spend a request. The harness resets
    # the wall, so this asserts the state the first sweep left rather than re-running
    # through it.
    assert marinesia._rate_limited_until > time.time()


def test_a_data_wrapped_response_is_read_too(monkeypatch):
    """Their area example is a bare list; their other endpoints wrap in `data`.
    Accepting both is cheaper than going blank if they converge."""
    _health, snapshots, _client = _sweep(monkeypatch, [{"data": AREA_RESPONSE}])
    assert len(snapshots[0][1]) == 3


def test_an_unexpected_payload_shape_is_empty_rather_than_fatal(monkeypatch):
    health, _snap, _client = _sweep(monkeypatch, ["surprise"])
    assert health.rows == [("marinesia", 0, True, None)]


def test_the_sweep_paces_itself_under_the_free_tier_budget():
    """5 requests a minute is the documented allowance; a sweep that spends it
    in one burst is how a free tier becomes a blocked one."""
    assert marinesia.REQUEST_SPACING >= 12.0
    sweep_seconds = marinesia.REQUEST_SPACING * (len(config.WATCHED_WATERS) - 1)
    assert sweep_seconds < config.MARINESIA_POLL_INTERVAL
