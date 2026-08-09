"""AIS disabling events from Global Fishing Watch, parsed off a real response.

The entries below are trimmed copies of live `/v3/events` responses for
`public-global-gaps-events:latest` (2026-08-07) -- same keys, same mixed
string/float typing, same nesting.

Two things are being guarded. The first is attribution: every claim in a record
here belongs to GFW, including the one about intent, and a field name that read
like a finding of ours would undo the whole point of having a second source.
The second is the prior/corroboration distinction, which is not a matter of
wording -- GFW's batch is five days behind and dark_vessels reads three days of
history, so a record that said "confirmed" would be asserting something the
timestamps rule out.
"""

import asyncio
import time

import httpx
import pytest

from backend.sources import dark_vessels, gfw_gaps

CREDIT = "Copyright 2026, Global Fishing Watch, Inc. Accessed on 2026-08-07."
NOW = 1786060000.0  # 2026-08-06T21:06:40Z

# Note the typing: durationHours is a float, distanceKm and impliedSpeedKnots
# beside it are strings, offPosition's coordinates are floats and onPosition's
# are strings. All four are as GFW served them.
GAP_ENTRY = {
    "id": "c1da86cd494666aed06f0b0704c59042",
    "type": "gap",
    "start": "2026-08-02T11:13:50.000Z",
    "end": "2026-08-02T23:58:16.000Z",
    "position": {"lat": 26.2601, "lon": 52.0313},
    "distances": {
        "startDistanceFromShoreKm": 44,
        "endDistanceFromShoreKm": 51,
        "startDistanceFromPortKm": 88.5,
        "endDistanceFromPortKm": 120.25,
    },
    "vessel": {
        "id": "df642ab7d-d9ad-9308-c7fa-dd83da786e4e",
        "name": "FPMC C LORD",
        "ssvid": "636014909",
        "flag": "LBR",
        "type": "other",
    },
    "gap": {
        "intentionalDisabling": True,
        "distanceKm": "112.4",
        "durationHours": 12.733333333333333,
        "impliedSpeedKnots": "4.77",
        "positionsPerDaySatReception": 87.55937793481364,
        "offPosition": {"lat": 26.2601, "lon": 52.0313},
        "onPosition": {"lat": "26.9014", "lon": "53.1102"},
    },
}


def parsed(entry=None, now=NOW):
    return gfw_gaps.parse_gap(entry if entry is not None else GAP_ENTRY, now, CREDIT)


# --- every claim in the record is GFW's ------------------------------------


def test_the_intent_claim_stays_named_as_gfws_inference():
    """The one field a reader could mistake for a finding of this project's.

    dark_vessels.py is forbidden its own docstring's word "detected" for exactly
    this reason; the equivalent here is that nothing may read as though we
    decided the disabling was deliberate."""
    record = parsed()
    assert record["intentional_disabling"] is True
    assert record["publisher"] == "Global Fishing Watch"
    assert record["source"] == "gfw"
    assert record["inferred"] is True
    assert "detected" not in record


def test_the_reception_model_behind_the_claim_travels_with_it():
    """A vessel GFW hears 88 times a day going silent is a different fact from
    one it hears twice, and that is the whole basis of their inference."""
    assert parsed()["positions_per_day_sat"] == pytest.approx(87.559, abs=0.001)


def test_the_attribution_is_dated_and_on_every_record():
    record = parsed()
    assert record["attribution"] == CREDIT
    assert record["license"] == "CC BY-NC 4.0"


def test_the_required_attribution_is_built_from_the_date_not_hardcoded():
    from datetime import date

    assert gfw_gaps.attribution(date(2027, 3, 4)) == (
        "Copyright 2027, Global Fishing Watch, Inc. Accessed on 2027-03-04."
    )


# --- parsing ----------------------------------------------------------------


def test_the_record_is_placed_where_the_vessel_went_dark():
    """The last known position is the fact; the reappearance is the consequence.
    Same convention as dark_vessels, so the two layers can be read together."""
    record = parsed()
    assert (record["lat"], record["lon"]) == (26.2601, 52.0313)
    assert (record["resumed_lat"], record["resumed_lon"]) == (26.9014, 53.1102)


def test_figures_are_read_leniently_because_gfw_mixes_strings_and_numbers():
    record = parsed()
    assert record["distance_km"] == 112.4
    assert record["implied_speed_kn"] == 4.77
    assert record["gap_hours"] == 12.7
    assert isinstance(record["resumed_lat"], float), "onPosition arrives as strings"


def test_the_mmsi_is_the_join_key_dark_vessels_uses():
    """GFW calls it ssvid. dark_vessels keys its own gaps on the MMSI, and the
    prior is worthless if the two are not the same string."""
    assert parsed()["mmsi"] == "636014909"


def test_the_age_is_measured_rather_than_left_to_the_reader():
    """The failure this layer risks is a five-day-old gap drawn like a live one."""
    record = parsed()
    assert record["age_days"] == pytest.approx(4.4, abs=0.1)


def test_a_multi_year_gap_is_not_a_vessel_going_dark_and_is_dropped():
    """The unsorted feed leads with these -- one observed gap ran 54,574 hours,
    from 2020. They are navigation aids leaving the feed, not ships."""
    entry = {**GAP_ENTRY, "gap": {**GAP_ENTRY["gap"], "durationHours": 54574.58}}
    assert gfw_gaps.parse_gap(entry, NOW, CREDIT) is None


def test_a_gap_with_no_position_anywhere_is_dropped_rather_than_placed_at_zero():
    entry = {**GAP_ENTRY, "position": {}, "gap": {**GAP_ENTRY["gap"], "offPosition": {}}}
    assert gfw_gaps.parse_gap(entry, NOW, CREDIT) is None


def test_the_event_position_stands_in_when_the_off_position_is_missing():
    entry = {**GAP_ENTRY, "gap": {**GAP_ENTRY["gap"], "offPosition": {}}}
    record = gfw_gaps.parse_gap(entry, NOW, CREDIT)
    assert (record["lat"], record["lon"]) == (26.2601, 52.0313)


def test_malformed_entries_yield_nothing_rather_than_a_blank_pin():
    assert gfw_gaps.parse_gap(None, NOW, CREDIT) is None
    assert gfw_gaps.parse_gap({}, NOW, CREDIT) is None
    assert gfw_gaps.parse_gap({"id": "x"}, NOW, CREDIT) is None


# --- the per-hull prior -----------------------------------------------------


def test_priors_count_events_per_hull_and_keep_the_most_recent():
    older = {**parsed(), "id": "gfw:gap:older", "went_dark_at": NOW - 20 * 86400,
             "gap_hours": 6.0, "intentional_disabling": False}
    priors = gfw_gaps.vessel_priors([parsed(), older])
    prior = priors["636014909"]
    assert prior["events"] == 2
    assert prior["intentional_events"] == 1, "only GFW's intentional ones are counted as such"
    assert prior["last_gap_hours"] == 12.7, "the newer event wins regardless of input order"
    assert prior["publisher"] == "Global Fishing Watch"


def test_nothing_depends_on_the_intentional_flag_varying():
    """Measured on the first full sweep: all 19,976 stored events carried
    `intentionalDisabling: true`, because that is the dataset's inclusion
    criterion rather than a judgement between events. A hull whose every event
    is flagged -- which is every hull today -- must still produce a usable
    prior, and the count must be the event count rather than a filter that
    happens to pass everything."""
    all_intentional = [
        {**parsed(), "id": "gfw:gap:a"},
        {**parsed(), "id": "gfw:gap:b", "went_dark_at": NOW - 9 * 86400},
    ]
    prior = gfw_gaps.vessel_priors(all_intentional)["636014909"]
    assert prior["events"] == 2
    assert prior["intentional_events"] == 2


def test_the_stored_window_is_not_silently_truncated_by_the_cap():
    """The API reported 23,667 events for a 30-day window on 2026-08-07. A cap
    below that trims the oldest end with nothing anywhere saying so -- which is
    exactly what a first value of 20,000 did."""
    assert gfw_gaps.MAX_RECORDS > 23_667
    assert gfw_gaps.MAX_PAGES * gfw_gaps.PAGE_SIZE > 23_667, (
        "the page ceiling would truncate before the record cap did"
    )


def test_a_record_with_no_mmsi_contributes_no_prior():
    """There is nothing to key it on, and a prior under a null MMSI would attach
    itself to every vessel that also lacks one."""
    assert gfw_gaps.vessel_priors([{**parsed(), "mmsi": None}]) == {}


def test_a_malformed_ssvid_is_not_a_hull_and_gets_no_prior():
    """GFW's ssvid is not clean: a real sweep keyed priors on "2", "11", "14",
    "15" and "25" among 6,950 vessels. Each of those is a bucket any record
    carrying the same junk would join to, which is how an unrelated ship
    silently acquires somebody else's record of going dark."""
    junk = [{**parsed(), "mmsi": m} for m in ("2", "11", "25", "12345", "63601490912")]
    assert gfw_gaps.vessel_priors(junk) == {}
    assert gfw_gaps.is_ship_mmsi("636014909")
    assert not gfw_gaps.is_ship_mmsi("63601490")
    assert not gfw_gaps.is_ship_mmsi("6360149O9"), "letter O, not zero"


# --- prior is not corroboration ---------------------------------------------
#
# GFW's gaps batch runs five or more days behind wall clock (a four-day window
# returned zero events on 2026-08-07) and dark_vessels reads
# HISTORY_RETENTION_SECONDS of AIS history, which is three days. The windows are
# disjoint by construction, so nothing may present the prior as confirmation of
# the gap it is attached to.


HEALTH = [(NOW - 3600 * i, 500, True) for i in range(48, 0, -1)]


def gap_row(mmsi="636014909", hours=6.0):
    went_dark = NOW - hours * 3600
    return {
        "entity_id": mmsi,
        "gap_seconds": hours * 3600,
        "from_ts": went_dark,
        "to_ts": NOW,
        # Inside WATCHED_WATERS' Persian Gulf box, so REQUIRE_CHOKEPOINT is satisfied.
        "from_lat": 26.26, "from_lon": 52.03,
        "to_lat": 26.90, "to_lon": 53.11,
    }


def test_a_gap_record_carries_the_prior_under_a_name_that_is_not_a_verdict():
    priors = gfw_gaps.vessel_priors([parsed()])
    records = dark_vessels.build_gap_records([gap_row()], {}, HEALTH, priors)
    assert len(records) == 1
    record = records[0]
    assert record["gfw_prior"]["intentional_events"] == 1
    assert record["inferred"] is True
    assert not any("corroborat" in key or "confirm" in key for key in record), (
        "a prior is about the hull, not about this gap -- no field may imply otherwise"
    )


def test_a_hull_with_no_gfw_history_simply_has_no_prior():
    records = dark_vessels.build_gap_records(
        [gap_row(mmsi="999999999")], {}, HEALTH, gfw_gaps.vessel_priors([parsed()])
    )
    assert records[0]["gfw_prior"] is None


def test_missing_priors_entirely_is_a_normal_state_not_an_error():
    """No token, or a first ingest run that has not landed yet."""
    records = dark_vessels.build_gap_records([gap_row()], {}, HEALTH, None)
    assert records[0]["gfw_prior"] is None


def test_a_flagged_hull_survives_the_cap_that_a_longer_gap_would_take():
    """What the sort is for, and the only thing it is for.

    It is not a reading order -- the backend serves these out of Postgres in
    entity_id order, so a reader sees them by MMSI and this arrangement is gone
    by then. It decides which records the MAX_GAP_RECORDS cut keeps, and a hull
    GFW has recorded deliberately disabling should outrank a longer gap by an
    unremarkable one when something has to go.
    """
    priors = gfw_gaps.vessel_priors([parsed()])
    rows = [gap_row(mmsi=str(900000000 + i), hours=20.0)
            for i in range(dark_vessels.MAX_GAP_RECORDS)]
    rows.append(gap_row(mmsi="636014909", hours=5.0))

    records = dark_vessels.build_gap_records(rows, {}, HEALTH, priors)
    assert len(records) == dark_vessels.MAX_GAP_RECORDS
    kept = {r["mmsi"] for r in records}
    assert "636014909" in kept, "the flagged hull was discarded for a longer, plainer gap"
    # Surviving the cut is not evidence. The record is the same inference it was.
    flagged = next(r for r in records if r["mmsi"] == "636014909")
    assert flagged["inferred"] is True
    assert flagged["gap_hours"] == 5.0


def test_an_sts_pair_carries_the_prior_per_vessel_since_only_one_may_have_one():
    ships = [
        {"mmsi": "636014909", "name": "FPMC C LORD", "lat": 26.26, "lon": 52.03,
         "speed": 0.0, "_last_moved_at": NOW - 4 * 3600},
        {"mmsi": "111111111", "name": "OTHER", "lat": 26.2601, "lon": 52.0301,
         "speed": 0.0, "_last_moved_at": NOW - 4 * 3600},
    ]
    from backend.sources.proximity import ProximityIndex

    records = dark_vessels.build_sts_records(
        ships, ProximityIndex([]), now=NOW, priors=gfw_gaps.vessel_priors([parsed()])
    )
    assert len(records) == 1
    by_mmsi = {v["mmsi"]: v for v in records[0]["vessels"]}
    assert by_mmsi["636014909"]["gfw_prior"]["events"] == 1
    assert by_mmsi["111111111"]["gfw_prior"] is None


# --- paging -----------------------------------------------------------------
#
# The API requires `offset` whenever `limit` is sent (a 422 otherwise), accepts
# limit=1000, and answers with its own `nextOffset` -- which is followed rather
# than computed, because the two are not required to agree.


REQUEST = httpx.Request("GET", "https://gateway.api.globalfishingwatch.org/v3/events")


def page(entries, next_offset, version="public-global-gaps-events:v4.0"):
    return httpx.Response(200, request=REQUEST, json={
        "metadata": {"datasets": [version]},
        "entries": entries,
        "nextOffset": next_offset,
        "total": 9999,
    })


class _PagingClient:
    def __init__(self, *pages):
        self.pages = list(pages)
        self.offsets = []

    async def get(self, url, params=None):
        self.offsets.append((params or {}).get("offset"))
        return self.pages.pop(0)


@pytest.fixture
def no_waiting(monkeypatch):
    async def fake_sleep(seconds):
        pass

    monkeypatch.setattr(gfw_gaps.asyncio, "sleep", fake_sleep)


def fetch(client):
    from datetime import date

    return asyncio.run(gfw_gaps._fetch_all(client, date(2026, 7, 8), date(2026, 8, 7)))


def test_paging_follows_the_apis_own_next_offset(no_waiting):
    client = _PagingClient(
        page([GAP_ENTRY], 1000),
        page([GAP_ENTRY], 1750),   # deliberately not offset + page size
        page([GAP_ENTRY], None),
    )
    entries, version = fetch(client)
    assert len(entries) == 3
    assert client.offsets == [0, 1000, 1750]
    assert version == "public-global-gaps-events:v4.0"


def test_paging_stops_when_the_offset_stops_advancing(no_waiting):
    """Otherwise a next_offset that repeats itself re-requests one page against
    a metered API until the page ceiling."""
    client = _PagingClient(page([GAP_ENTRY], 1000), page([GAP_ENTRY], 1000))
    entries, _ = fetch(client)
    assert len(entries) == 2
    assert client.offsets == [0, 1000]


def test_paging_stops_on_an_empty_page(no_waiting):
    client = _PagingClient(page([GAP_ENTRY], 1000), page([], 2000))
    entries, _ = fetch(client)
    assert len(entries) == 1


def test_the_page_ceiling_is_a_stop_not_an_expectation(no_waiting):
    """Newest-first sorting is what makes this safe: hitting the ceiling drops
    the oldest end of the window, which is the end that matters least."""
    client = _PagingClient(*[page([GAP_ENTRY], i * 1000 + 1000) for i in range(gfw_gaps.MAX_PAGES)])
    entries, _ = fetch(client)
    assert len(entries) == gfw_gaps.MAX_PAGES
    assert gfw_gaps.SORT == "-start"


def test_the_dataset_version_is_read_from_the_response_not_pinned():
    """`:latest` resolves server-side, so a GFW version bump should show up in
    the log rather than as a 404 on a pinned id."""
    assert gfw_gaps.DATASET.endswith(":latest")
