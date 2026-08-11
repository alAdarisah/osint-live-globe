"""GET /api/lanes -- the one endpoint in Task 19 that isn't covered by
test_lane_density.py, added for Task 19 review Minor 2: `_lane_course_deg`
and the route itself had no test at all, including the zero-vector branch.

Follows test_water_endpoint.py's style: call the endpoint function directly
and monkeypatch storage.lane_cells to a fixed fake, rather than standing up
Postgres.
"""

import asyncio
import json

from backend import app as app_mod


def _run(coro):
    return asyncio.run(coro)


def _body(response):
    return json.loads(response.body)


# --- _lane_course_deg, in isolation -----------------------------------------


def test_lane_course_deg_is_the_circular_mean_of_the_stored_vector():
    # A cell whose every course pointed due east (90deg) sums to (1.0, 0.0).
    assert app_mod._lane_course_deg(1.0, 0.0) == 90.0


def test_lane_course_deg_is_none_for_a_cell_with_no_directional_evidence():
    # Both components exactly zero -- no course was ever decoded here, or
    # what was decoded cancelled out exactly. Either way, no arbitrary due
    # north should come back.
    assert app_mod._lane_course_deg(0.0, 0.0) is None


# --- the route ---------------------------------------------------------------


CELL_WITH_COURSE = {
    "cell_key": "0.05:200:400", "lat": 10.0, "lon": 20.0, "res": 0.05,
    "transits": 5, "positions": 40, "by_class": {"cargo": 5},
    "mean_sin": 0.0, "mean_cos": 1.0, "updated_at": 1_700_000_000.0,
}

CELL_WITH_NO_COURSE = {
    "cell_key": "0.02:9:9", "lat": 41.0, "lon": 30.0, "res": 0.02,
    "transits": 1, "positions": 1, "by_class": {},
    "mean_sin": 0.0, "mean_cos": 0.0, "updated_at": 1_700_000_000.0,
}


def test_lanes_endpoint_renames_transits_to_sightings_and_adds_course_deg(monkeypatch):
    """Task 19 review, Important: `transits` accumulates hull-visits across
    sweeps, not distinct-ever hulls (see the column's comment on lane_cells
    in backend/storage.py), so the response must not call it `transits`."""
    calls = []

    async def lane_cells(bbox, min_transits=1):
        calls.append((bbox, min_transits))
        return [dict(CELL_WITH_COURSE), dict(CELL_WITH_NO_COURSE)]

    monkeypatch.setattr(app_mod.storage, "lane_cells", lane_cells)

    body = _body(_run(app_mod.lanes_endpoint(bbox=None, min_transits=2)))

    assert body["note"] == app_mod.lane_density.NOTE
    assert calls == [(None, 2)]

    with_course, without_course = body["cells"]
    assert "transits" not in with_course
    assert with_course["sightings"] == 5
    assert with_course["course_deg"] == 0.0  # (mean_sin=0, mean_cos=1) -> due north

    assert "transits" not in without_course
    assert without_course["sightings"] == 1
    assert without_course["course_deg"] is None


def test_lanes_endpoint_parses_bbox_and_floors_min_transits_at_one(monkeypatch):
    captured = {}

    async def lane_cells(bbox, min_transits=1):
        captured["bbox"] = bbox
        captured["min_transits"] = min_transits
        return []

    monkeypatch.setattr(app_mod.storage, "lane_cells", lane_cells)

    body = _body(_run(app_mod.lanes_endpoint(bbox="10,20,15,25", min_transits=0)))

    assert captured["bbox"] == (10.0, 20.0, 15.0, 25.0)
    # A client sending 0 (or a negative number) must not disable the filter
    # entirely -- storage.lane_cells treats any positive floor as "at least
    # one sighting", and 0 would ask for cells that cannot exist.
    assert captured["min_transits"] == 1
    assert body["cells"] == []
