"""lane_cells, vessel_port_calls, flight_legs -- the three tables behind not
yet built refine jobs (lane density, port-call detection, flight-leg
detection). No consumer exists yet; this is what holds the storage helpers to
the behaviour their eventual callers will depend on.

There is no live Postgres in this test run (see backend/tests/conftest.py --
every existing storage test fakes the connection rather than hitting a real
database), so accumulation is exercised against small, purpose-built fakes
that model exactly the handful of statements each helper issues, backed by a
plain dict standing in for the table. That is enough to prove the Python-side
merge logic (_combine_lane_cell, the port-call/flight-leg upsert semantics)
is correct, which is the part a swallowed exception in production would hide.
"""

import asyncio
import json
import math
from datetime import datetime, timezone

import pytest

from backend import storage


def _run(coro):
    return asyncio.run(coro)


class _Txn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _Pool:
    """acquire() -> the one connection every helper under test shares."""

    def __init__(self, conn):
        self.conn = conn

    def acquire(self):
        conn = self.conn

        class _Ctx:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *exc):
                return False

        return _Ctx()


# --- lane_cells --------------------------------------------------------


class _LaneCellConn:
    """Just enough of asyncpg to drive upsert_lane_cells/lane_cells/
    decay_lane_cells, with a dict standing in for the table so accumulation
    across calls is real rather than asserted from a canned response."""

    def __init__(self, store=None):
        self.store = store if store is not None else {}

    def transaction(self):
        return _Txn()

    async def fetch(self, query, *args):
        if "lane_cells WHERE cell_key = ANY" in query:
            (keys,) = args
            return [{"cell_key": k, **self.store[k]} for k in keys if k in self.store]
        if query.startswith("SELECT cell_key, lat, lon, res, transits, positions, by_class"):
            min_transits = args[0]
            rows = [
                {"cell_key": k, **v} for k, v in self.store.items()
                if v["transits"] >= min_transits
            ]
            if len(args) > 1:
                lat_min, lat_max, lon_min, lon_max = args[1:5]
                rows = [
                    r for r in rows
                    if lat_min <= r["lat"] <= lat_max and lon_min <= r["lon"] <= lon_max
                ]
            return rows
        raise AssertionError(f"unexpected query: {query!r}")

    async def execute(self, query, *args):
        stripped = query.strip()
        if stripped.startswith("INSERT INTO lane_cells"):
            cell_keys, lats, lons, res, transits, positions, by_class, mean_sin, mean_cos, now = args
            for i, key in enumerate(cell_keys):
                self.store[key] = {
                    "lat": lats[i], "lon": lons[i], "res": res[i],
                    "transits": transits[i], "positions": positions[i],
                    "by_class": by_class[i],
                    "mean_sin": mean_sin[i], "mean_cos": mean_cos[i],
                    "updated_at": now,
                }
            return f"INSERT 0 {len(cell_keys)}"
        if stripped.startswith("UPDATE lane_cells SET"):
            (factor,) = args
            for row in self.store.values():
                row["transits"] = max(0, round(row["transits"] * factor))
                row["positions"] = max(0, round(row["positions"] * factor))
                row["mean_sin"] *= factor
                row["mean_cos"] *= factor
            return f"UPDATE {len(self.store)}"
        if stripped.startswith("DELETE FROM lane_cells WHERE transits <"):
            (floor,) = args
            dying = [k for k, v in self.store.items() if v["transits"] < floor]
            for k in dying:
                del self.store[k]
            return f"DELETE {len(dying)}"
        raise AssertionError(f"unexpected query: {query!r}")


def _lane_row(cell_key="c1", **overrides):
    row = {
        "cell_key": cell_key, "lat": 10.0, "lon": 20.0, "res": 0.5,
        "transits": 1, "positions": 1, "by_class": {"cargo": 1},
        "mean_sin": 0.1, "mean_cos": 0.9,
    }
    row.update(overrides)
    return row


def test_lane_cell_upsert_accumulates_across_two_calls(monkeypatch):
    monkeypatch.setattr(storage, "_pool", _Pool(_LaneCellConn()))

    _run(storage.upsert_lane_cells([
        _lane_row(transits=3, positions=30, by_class={"cargo": 2, "tanker": 1},
                  mean_sin=0.5, mean_cos=0.5),
    ]))
    _run(storage.upsert_lane_cells([
        _lane_row(transits=2, positions=10, by_class={"cargo": 1, "fishing": 4},
                  mean_sin=0.1, mean_cos=-0.2),
    ]))

    rows = _run(storage.lane_cells(min_transits=1))
    assert len(rows) == 1
    row = rows[0]
    assert row["transits"] == 5
    assert row["positions"] == 40
    assert row["by_class"] == {"cargo": 3, "tanker": 1, "fishing": 4}
    assert row["mean_sin"] == pytest.approx(0.6)
    assert row["mean_cos"] == pytest.approx(0.3)


def test_lane_cell_upsert_merges_duplicate_cell_keys_within_one_call(monkeypatch):
    """Two rows sharing a cell_key in the same sweep must combine before the
    write reaches Postgres: ON CONFLICT rejects a statement that touches the
    same key twice, the same reason _rows_for dedups entity_latest batches."""
    monkeypatch.setattr(storage, "_pool", _Pool(_LaneCellConn()))

    _run(storage.upsert_lane_cells([
        _lane_row(transits=1, positions=1, by_class={"cargo": 1}),
        _lane_row(transits=1, positions=1, by_class={"cargo": 1}),
    ]))

    rows = _run(storage.lane_cells(min_transits=1))
    assert len(rows) == 1
    assert rows[0]["transits"] == 2
    assert rows[0]["by_class"] == {"cargo": 2}


def test_mean_sin_cos_round_trips_to_a_circular_mean(monkeypatch):
    """Two transits at 359deg and 1deg should average to ~0deg (due north),
    not 180deg -- the whole reason mean_sin/mean_cos exist instead of a mean
    bearing column (see the schema comment on lane_cells)."""
    monkeypatch.setattr(storage, "_pool", _Pool(_LaneCellConn()))

    def unit(course_deg):
        rad = math.radians(course_deg)
        return math.sin(rad), math.cos(rad)

    s1, c1 = unit(359)
    s2, c2 = unit(1)
    _run(storage.upsert_lane_cells([
        _lane_row(transits=1, positions=1, by_class={}, mean_sin=s1, mean_cos=c1),
        _lane_row(transits=1, positions=1, by_class={}, mean_sin=s2, mean_cos=c2),
    ]))

    row = _run(storage.lane_cells(min_transits=1))[0]
    mean_course = math.degrees(math.atan2(row["mean_sin"], row["mean_cos"])) % 360
    # 360 and 0 are the same heading; take the short way round the seam
    # rather than asserting a single raw value that floating point drift
    # could push to either side of it.
    assert min(mean_course, 360.0 - mean_course) == pytest.approx(0.0, abs=1e-6)


def test_decay_removes_a_cell_that_falls_below_the_floor(monkeypatch):
    conn = _LaneCellConn(store={
        "busy": {"lat": 1.0, "lon": 2.0, "res": 0.5, "transits": 10, "positions": 20,
                 "by_class": json.dumps({"cargo": 10}), "mean_sin": 1.0, "mean_cos": 1.0,
                 "updated_at": datetime.now(timezone.utc)},
        "quiet": {"lat": 1.0, "lon": 2.0, "res": 0.5, "transits": 2, "positions": 4,
                  "by_class": json.dumps({"cargo": 2}), "mean_sin": 1.0, "mean_cos": 1.0,
                  "updated_at": datetime.now(timezone.utc)},
    })
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    deleted = _run(storage.decay_lane_cells(factor=0.5, floor=3))

    assert deleted == 1
    assert "quiet" not in conn.store  # 2 * 0.5 = 1, below floor 3
    assert "busy" in conn.store       # 10 * 0.5 = 5, still >= floor 3
    assert conn.store["busy"]["transits"] == 5


def test_lane_cell_helpers_are_no_ops_without_a_pool(monkeypatch):
    monkeypatch.setattr(storage, "_pool", None)
    _run(storage.upsert_lane_cells([_lane_row()]))  # must not raise
    assert _run(storage.lane_cells()) == []
    assert _run(storage.decay_lane_cells(0.5, 1)) == 0


# --- vessel_port_calls ---------------------------------------------------


class _PortCallConn:
    """Models the (mmsi, port_id, arrived_at) upsert: a second write for the
    same key updates the stored row, matching vessel_port_calls' ON CONFLICT."""

    def __init__(self):
        self.store: dict[tuple, dict] = {}

    def transaction(self):
        return _Txn()

    async def executemany(self, query, tuples):
        for mmsi, port_id, arrived_at, departed_at, draught_in, draught_out, confidence in tuples:
            key = (mmsi, port_id, arrived_at)
            existing = self.store.get(key)
            kept_draught_in = (
                existing["draught_in"]
                if existing is not None and existing["draught_in"] is not None
                else draught_in
            )
            self.store[key] = {
                "mmsi": mmsi, "port_id": port_id, "arrived_at": arrived_at,
                "departed_at": departed_at, "draught_in": kept_draught_in,
                "draught_out": draught_out, "confidence": confidence,
            }

    async def fetch(self, query, *args):
        if "WHERE mmsi = $1" in query:
            key, limit = args[0], args[1]
            rows = [r for r in self.store.values() if r["mmsi"] == key]
        elif "WHERE port_id = $1" in query:
            key, limit = args[0], args[1]
            rows = [r for r in self.store.values() if r["port_id"] == key]
        else:
            raise AssertionError(f"unexpected query: {query!r}")
        rows.sort(key=lambda r: r["arrived_at"], reverse=True)
        return rows[:limit]

    async def fetchrow(self, query, *args):
        (mmsi,) = args
        rows = [r for r in self.store.values() if r["mmsi"] == mmsi and r["departed_at"] is None]
        rows.sort(key=lambda r: r["arrived_at"], reverse=True)
        return rows[0] if rows else None


def test_port_call_open_then_close(monkeypatch):
    conn = _PortCallConn()
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    arrived = datetime(2026, 8, 1, 10, 0, tzinfo=timezone.utc).timestamp()
    _run(storage.record_port_calls([
        {"mmsi": "123456789", "port_id": "USNYC", "arrived_at": arrived,
         "draught_in": 12.5, "confidence": "measured"},
    ]))

    open_call = _run(storage.open_port_call("123456789"))
    assert open_call is not None
    assert open_call["departed_at"] is None
    assert open_call["draught_in"] == 12.5

    departed = datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc).timestamp()
    _run(storage.record_port_calls([
        {"mmsi": "123456789", "port_id": "USNYC", "arrived_at": arrived,
         "departed_at": departed, "draught_out": 10.0, "confidence": "measured"},
    ]))

    assert _run(storage.open_port_call("123456789")) is None
    calls = _run(storage.port_calls_for("123456789"))
    assert len(calls) == 1
    assert calls[0]["departed_at"] == departed
    assert calls[0]["draught_in"] == 12.5, "the arrival draught must survive the closing write"
    assert calls[0]["draught_out"] == 10.0

    at_port = _run(storage.port_calls_at("USNYC"))
    assert len(at_port) == 1
    assert at_port[0]["mmsi"] == "123456789"


def test_port_call_rows_missing_a_required_field_are_skipped(monkeypatch):
    conn = _PortCallConn()
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    _run(storage.record_port_calls([
        {"mmsi": None, "port_id": "P", "arrived_at": 0, "confidence": "measured"},
        {"mmsi": "1", "port_id": "P", "arrived_at": 0, "confidence": None},
    ]))

    assert conn.store == {}


def test_port_call_helpers_are_no_ops_without_a_pool(monkeypatch):
    monkeypatch.setattr(storage, "_pool", None)
    _run(storage.record_port_calls([
        {"mmsi": "1", "port_id": "P", "arrived_at": 0, "confidence": "measured"},
    ]))  # must not raise
    assert _run(storage.port_calls_for("1")) == []
    assert _run(storage.port_calls_at("P")) == []
    assert _run(storage.open_port_call("1")) is None


# --- flight_legs -----------------------------------------------------------


class _FlightLegConn:
    """Models the (icao24, departed_at) upsert, including max_alt_ft's
    running-maximum behaviour (GREATEST ignoring a NULL side)."""

    def __init__(self):
        self.store: dict[tuple, dict] = {}

    def transaction(self):
        return _Txn()

    @staticmethod
    def _greatest(a, b):
        if a is None:
            return b
        if b is None:
            return a
        return max(a, b)

    async def executemany(self, query, tuples):
        for icao24, departed_at, arrived_at, origin_code, dest_code, callsign, max_alt_ft, distance_km, confidence in tuples:
            key = (icao24, departed_at)
            existing = self.store.get(key)
            if existing is None:
                merged_max_alt, merged_origin, merged_callsign = max_alt_ft, origin_code, callsign
            else:
                merged_max_alt = self._greatest(max_alt_ft, existing["max_alt_ft"])
                merged_origin = origin_code if origin_code is not None else existing["origin_code"]
                merged_callsign = callsign if callsign is not None else existing["callsign"]
            self.store[key] = {
                "icao24": icao24, "departed_at": departed_at, "arrived_at": arrived_at,
                "origin_code": merged_origin, "dest_code": dest_code, "callsign": merged_callsign,
                "max_alt_ft": merged_max_alt, "distance_km": distance_km, "confidence": confidence,
            }

    async def fetch(self, query, *args):
        icao24, limit = args
        rows = [r for r in self.store.values() if r["icao24"] == icao24]
        rows.sort(key=lambda r: r["departed_at"], reverse=True)
        return rows[:limit]

    async def fetchrow(self, query, *args):
        (icao24,) = args
        rows = [r for r in self.store.values() if r["icao24"] == icao24 and r["arrived_at"] is None]
        rows.sort(key=lambda r: r["departed_at"], reverse=True)
        return rows[0] if rows else None


def test_flight_legs_for_orders_newest_departure_first(monkeypatch):
    conn = _FlightLegConn()
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    t1 = datetime(2026, 8, 1, 6, 0, tzinfo=timezone.utc).timestamp()
    t2 = datetime(2026, 8, 2, 6, 0, tzinfo=timezone.utc).timestamp()
    t3 = datetime(2026, 8, 3, 6, 0, tzinfo=timezone.utc).timestamp()
    _run(storage.record_flight_legs([
        {"icao24": "abc123", "departed_at": t1, "confidence": "derived"},
        {"icao24": "abc123", "departed_at": t3, "confidence": "derived"},
        {"icao24": "abc123", "departed_at": t2, "confidence": "derived"},
    ]))

    legs = _run(storage.flight_legs_for("abc123"))
    assert [leg["departed_at"] for leg in legs] == [t3, t2, t1]


def test_open_flight_leg_and_max_alt_ft_is_a_running_maximum(monkeypatch):
    conn = _FlightLegConn()
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    t1 = datetime(2026, 8, 1, 6, 0, tzinfo=timezone.utc).timestamp()
    _run(storage.record_flight_legs([
        {"icao24": "abc123", "departed_at": t1, "max_alt_ft": 20000, "confidence": "derived"},
    ]))
    assert _run(storage.open_flight_leg("abc123"))["max_alt_ft"] == 20000

    # A later write reporting a higher altitude raises the stored maximum...
    _run(storage.record_flight_legs([
        {"icao24": "abc123", "departed_at": t1, "max_alt_ft": 35000, "confidence": "derived"},
    ]))
    assert _run(storage.open_flight_leg("abc123"))["max_alt_ft"] == 35000

    # ...and a write with no altitude at all (e.g. the closing arrival) must
    # not erase what was already recorded.
    arrived = datetime(2026, 8, 1, 9, 0, tzinfo=timezone.utc).timestamp()
    _run(storage.record_flight_legs([
        {"icao24": "abc123", "departed_at": t1, "arrived_at": arrived, "confidence": "derived"},
    ]))
    assert _run(storage.open_flight_leg("abc123")) is None
    legs = _run(storage.flight_legs_for("abc123"))
    assert legs[0]["max_alt_ft"] == 35000
    assert legs[0]["arrived_at"] == arrived


def test_flight_leg_rows_missing_a_required_field_are_skipped(monkeypatch):
    conn = _FlightLegConn()
    monkeypatch.setattr(storage, "_pool", _Pool(conn))

    _run(storage.record_flight_legs([
        {"icao24": None, "departed_at": 0, "confidence": "derived"},
        {"icao24": "abc123", "departed_at": 0, "confidence": None},
    ]))

    assert conn.store == {}


def test_flight_leg_helpers_are_no_ops_without_a_pool(monkeypatch):
    monkeypatch.setattr(storage, "_pool", None)
    _run(storage.record_flight_legs([
        {"icao24": "a", "departed_at": 0, "confidence": "derived"},
    ]))  # must not raise
    assert _run(storage.flight_legs_for("a")) == []
    assert _run(storage.open_flight_leg("a")) is None
