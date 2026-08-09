"""The conflict-event upsert's shape, checked without a database.

record_conflict_events swallows its exceptions on purpose -- a Postgres hiccup
must never take a poller down (see backend/storage.py). That makes an arity
mistake in the INSERT invisible in production: the archive silently stops
recording and the map keeps working, so nothing looks wrong until someone
queries history that was never written. These tests are the thing that would
have caught it.
"""

import re

import pytest

from backend import storage
from backend.sources import geoverify


def _insert_columns() -> list[str]:
    body = re.search(
        r"INSERT INTO conflict_events \((.*?)\) VALUES", storage._UPSERT_CONFLICT, re.S
    ).group(1)
    return [c.strip() for c in body.replace("\n", " ").split(",") if c.strip()]


def _value_slots() -> list[str]:
    body = re.search(
        r"VALUES \((.*?)\)\s*ON CONFLICT", storage._UPSERT_CONFLICT, re.S
    ).group(1)
    return [v.strip() for v in body.replace("\n", " ").split(",") if v.strip()]


def test_the_insert_binds_one_value_per_column():
    assert len(_insert_columns()) == len(_value_slots())


def test_every_placeholder_below_the_maximum_is_actually_used():
    """A gap in the numbering means a value was dropped when a column was added,
    and asyncpg reports that as a bind error the caller then swallows."""
    used = {int(n) for n in re.findall(r"\$(\d+)", " ".join(_value_slots()))}
    assert used == set(range(1, max(used) + 1))


def test_first_seen_and_last_seen_share_the_final_placeholder():
    """Both are "now" on insert; only last_seen moves on conflict. If they ever
    bind different parameters, first_seen starts drifting and escalation.py's
    baseline windows quietly shift with it."""
    slots = _value_slots()
    assert slots[-1] == slots[-2]


def test_the_placement_columns_are_persisted():
    """A verdict the archive does not keep cannot be re-measured later, which
    would make every claim about placement accuracy unfalsifiable."""
    columns = set(_insert_columns())
    for field in ("geo_verdict", "geo_confidence", "geo_radius_km", "geo_text_place",
                  "original_lat", "original_lon", "original_geo_precision"):
        assert field in columns


def test_the_schema_declares_every_column_the_insert_writes():
    """ALTER TABLE ... ADD COLUMN IF NOT EXISTS is what upgrades an existing
    database; a column that only appears in the INSERT exists on nobody's."""
    declared = set(re.findall(r"ADD COLUMN IF NOT EXISTS (\w+)", storage._SCHEMA))
    declared |= set(re.findall(r"^\s{2}(\w+) [A-Z]", storage._SCHEMA, re.M))
    missing = set(_insert_columns()) - declared
    assert not missing, f"written but never declared: {sorted(missing)}"


def test_the_conflict_update_never_rewrites_the_pipeline_version():
    """Insert-only on purpose: escalation.py compares counts only within one
    version, and relabelling old rows as current defeats that guard."""
    update = storage._UPSERT_CONFLICT.split("DO UPDATE SET", 1)[1]
    assert "pipeline_version" not in update
    assert "first_seen" not in update


def test_the_bind_tuple_matches_the_statement():
    """The arity check that actually bites. Everything above reads the SQL; this
    builds the tuple the writer really passes and counts it."""
    from datetime import datetime, timezone

    row = storage._conflict_row(
        {"id": "x", "lat": 1.0, "lon": 2.0, "date": "2026-08-05"},
        datetime.now(timezone.utc),
    )
    assert len(row) == max(int(n) for n in re.findall(r"\$(\d+)", storage._UPSERT_CONFLICT))


def test_a_row_with_no_coordinates_is_skipped_rather_than_bound():
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    assert storage._conflict_row({"id": "x", "lat": None, "lon": 2.0}, now) is None
    assert storage._conflict_row({"id": None, "lat": 1.0, "lon": 2.0}, now) is None


def test_the_placement_verdict_reaches_the_bind_tuple():
    """A field that stops at the record and never reaches the tuple is the exact
    failure this file exists for -- silent, and only visible months later."""
    from datetime import datetime, timezone

    row = storage._conflict_row(
        {
            "id": "x", "lat": 1.0, "lon": 2.0, "date": "2026-08-05",
            "geo_verdict": "refined", "geo_confidence": 78, "geo_radius_km": 3.2,
            "geo_text_place": "Kherson", "original_lat": 49.0, "original_lon": 32.0,
            "original_geo_precision": "country",
        },
        datetime.now(timezone.utc),
    )
    assert "refined" in row and 78 in row and "Kherson" in row
    assert 49.0 in row and "country" in row


@pytest.mark.parametrize("field", geoverify.GEO_FIELDS)
def test_geo_fields_are_either_persisted_or_deliberately_derived(field):
    """geoverify.GEO_FIELDS is the contract between the pipeline and everything
    downstream. Anything in it that is neither stored nor explicitly derived at
    serve time is a field the frontend can read and the archive cannot."""
    derived_at_serve_time = {"geo_place_id", "geo_reason"}
    assert field in set(_insert_columns()) or field in derived_at_serve_time


# --- the three derived-product tables (schema only, no consumer yet) -------
#
# lane_cells, vessel_port_calls and flight_legs exist so three future refine
# jobs (lane density, port-call detection, flight-leg detection) land on a
# settled schema. These tests just hold the DDL to its own stated shape --
# table, primary key and every index the module's helpers rely on.


@pytest.mark.parametrize(
    "table,columns",
    [
        (
            "lane_cells",
            ["cell_key", "lat", "lon", "res", "transits", "positions",
             "by_class", "mean_sin", "mean_cos", "updated_at"],
        ),
        (
            "vessel_port_calls",
            ["mmsi", "port_id", "arrived_at", "departed_at", "draught_in",
             "draught_out", "confidence"],
        ),
        (
            "flight_legs",
            ["icao24", "departed_at", "arrived_at", "origin_code", "dest_code",
             "callsign", "max_alt_ft", "distance_km", "confidence"],
        ),
    ],
)
def test_the_derived_tables_declare_every_column_their_helpers_use(table, columns):
    match = re.search(rf"CREATE TABLE IF NOT EXISTS {table} \((.*?)\n\);", storage._SCHEMA, re.S)
    assert match, f"{table} is not in the schema"
    body = match.group(1)
    for column in columns:
        assert re.search(rf"^\s*{column} ", body, re.M), f"{table} is missing column {column!r}"


def test_lane_cells_is_keyed_on_cell_key():
    """A synthetic PK here would let the same grid cell exist twice, which is
    exactly what upsert_lane_cells's accumulation depends on not happening."""
    match = re.search(r"CREATE TABLE IF NOT EXISTS lane_cells \((.*?)\n\);", storage._SCHEMA, re.S)
    assert "cell_key    TEXT PRIMARY KEY" in match.group(1)


def test_port_calls_and_flight_legs_are_keyed_so_a_second_write_updates_in_place():
    """(mmsi, port_id, arrived_at) and (icao24, departed_at) are what make
    record_port_calls/record_flight_legs's ON CONFLICT upserts -- a departure
    or arrival observed later closing out the same row -- possible at all."""
    assert "PRIMARY KEY (mmsi, port_id, arrived_at)" in storage._SCHEMA
    assert "PRIMARY KEY (icao24, departed_at)" in storage._SCHEMA


@pytest.mark.parametrize(
    "index,table",
    [
        ("idx_lane_cells_bbox", "lane_cells"),
        ("idx_lane_cells_updated", "lane_cells"),
        ("idx_port_calls_mmsi", "vessel_port_calls"),
        ("idx_port_calls_port", "vessel_port_calls"),
        ("idx_flight_legs_icao", "flight_legs"),
    ],
)
def test_the_derived_tables_carry_their_documented_indexes(index, table):
    match = re.search(
        rf"CREATE INDEX IF NOT EXISTS {index} ON {table} \(([^)]*)\);", storage._SCHEMA
    )
    assert match, f"{index} on {table} is missing"


def test_every_index_on_the_derived_tables_has_a_comment_above_it():
    """The house rule (see backend/storage.py and CLAUDE.md): every index names
    the query it serves, right above the CREATE INDEX line."""
    for index in (
        "idx_lane_cells_bbox", "idx_lane_cells_updated",
        "idx_port_calls_mmsi", "idx_port_calls_port", "idx_flight_legs_icao",
    ):
        before = storage._SCHEMA.split(f"CREATE INDEX IF NOT EXISTS {index}")[0]
        last_lines = [line.strip() for line in before.strip().splitlines()[-3:]]
        assert any(line.startswith("--") for line in last_lines), (
            f"{index} has no comment explaining what it serves"
        )
