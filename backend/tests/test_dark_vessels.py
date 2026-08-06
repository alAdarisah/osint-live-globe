"""What counts as going dark, and -- more importantly -- what does not.

The failure mode this whole module has to survive is that a receiver outage and
a transponder switched off produce the identical signature. Half these tests are
about the guard against that, because a detector that cries "sanctions evasion"
every time our own feed hiccups is worse than no detector at all.
"""

from backend.sources import dark_vessels as dv
from backend.sources.proximity import ProximityIndex

HOUR = 3600.0
# Inside config.AIS_BBOXES' Strait of Hormuz box (24,48 -> 30,57).
HORMUZ = (26.0, 56.0)
# Mid-Atlantic: no watched-waters box anywhere near it.
ATLANTIC = (30.0, -40.0)


def gap(
    entity_id="636014321",
    from_ts=1_000_000.0,
    gap_hours=9.0,
    frm=HORMUZ,
    to=(26.05, 56.05),
) -> dict:
    return {
        "entity_id": entity_id,
        "from_ts": from_ts,
        "from_lat": frm[0],
        "from_lon": frm[1],
        "to_ts": from_ts + gap_hours * HOUR,
        "to_lat": to[0],
        "to_lon": to[1],
        "gap_seconds": gap_hours * HOUR,
    }


def healthy(start=990_000.0, end=1_100_000.0, count=800, step=600.0):
    """A source_health series with a steady item count across the window."""
    series, ts = [], start
    while ts <= end:
        series.append((ts, count, True))
        ts += step
    return series


def ship(mmsi="636014321", pos=HORMUZ, speed=0.2, still_hours=3.0, now=1_000_000.0, **extra):
    base = {
        "mmsi": mmsi,
        "name": f"VESSEL {mmsi[-3:]}",
        "lat": pos[0],
        "lon": pos[1],
        "speed": speed,
        "nav_status": 0,
        "_last_moved_at": now - still_hours * HOUR,
        "_updated_at": now,
    }
    base.update(extra)
    return base


# --- going dark ------------------------------------------------------------


def test_a_real_gap_in_watched_waters_is_reported():
    (record,) = dv.build_gap_records([gap()], {}, healthy())
    assert record["kind"] == "ais_gap"
    assert record["gap_hours"] == 9.0
    assert record["inferred"] is True
    # Drawn where it went quiet, not where it came back.
    assert (record["lat"], record["lon"]) == HORMUZ


def test_the_implied_speed_across_the_gap_is_the_tell():
    """Reappearing 400 km away after four hours implies ~54 knots, which no
    merchant vessel does -- so the track that came back is not the one that
    left."""
    (record,) = dv.build_gap_records(
        [gap(gap_hours=4.0, frm=(26.0, 56.0), to=(26.0, 52.0))], {}, healthy()
    )
    assert record["resumed_km_away"] > 350
    assert record["implied_speed_kn"] > 40


def test_a_gap_outside_watched_waters_is_ignored():
    """Our AIS coverage only exists inside config.AIS_BBOXES, so absence
    anywhere else is absence of a receiver, not of a ship."""
    assert dv.build_gap_records([gap(frm=ATLANTIC, to=(30.1, -40.1))], {}, healthy()) == []


def test_an_absurdly_long_gap_is_ignored():
    """Past GAP_MAX_HOURS the honest reading is "we lost the region for a day",
    which says nothing about any particular vessel."""
    assert dv.build_gap_records([gap(gap_hours=dv.GAP_MAX_HOURS + 1)], {}, healthy()) == []


def test_a_gap_during_an_ais_feed_outage_is_suppressed():
    """The whole detection turns on this. A dead receiver makes every ship in a
    region appear to switch its transponder off at the same moment."""
    outage = [
        (990_000.0, 800, True),
        (995_000.0, 800, True),
        (1_000_000.0, 800, True),
        # Across the gap window the feed itself collapsed.
        (1_010_000.0, 12, True),
        (1_020_000.0, 9, True),
        (1_030_000.0, 800, True),
        (1_040_000.0, 800, True),
    ]
    assert dv.build_gap_records([gap()], {}, outage) == []


def test_a_gap_spanning_a_failed_poll_is_suppressed():
    series = healthy()
    series.append((1_005_000.0, None, False))  # one poll errored mid-gap
    series.sort(key=lambda row: row[0])
    assert dv.build_gap_records([gap()], {}, series) == []


def test_a_gap_with_no_polls_recorded_at_all_is_suppressed():
    """No health rows across the window means the snapshot loop was not
    running, which is precisely the case the guard exists for."""
    series = healthy(start=900_000.0, end=990_000.0)
    assert dv.build_gap_records([gap()], {}, series) == []


def test_too_little_health_history_does_not_suppress_everything():
    """With no baseline to compare against the guard has to stand down, or a
    freshly-restarted backend would report nothing at all."""
    (record,) = dv.build_gap_records([gap()], {}, [(1_000_000.0, 800, True)])
    assert record["gap_hours"] == 9.0


def test_recorded_failures_suppress_a_gap_even_with_no_baseline_to_compare_to():
    """The case this guard was silently failing on in production. Through a
    total feed outage there are no successful counts to take a median of, so
    requiring a baseline before reading the failures meant a dead stream
    reported every vessel in every watched box as having gone dark."""
    outage = [(ts, None, False) for ts in (1_000_000.0, 1_005_000.0, 1_010_000.0, 1_030_000.0)]
    assert dv.feed_health_baseline(outage) is None  # nothing successful to measure against
    assert dv.build_gap_records([gap()], {}, outage) == []


def test_the_vessels_identity_and_designation_travel_with_the_gap():
    ships = {
        "636014321": {
            "mmsi": "636014321", "name": "EBANO", "imo": "7406784",
            "sanctions": {"program": "CUBA", "listed_as": "EBANO", "matched_on": "imo"},
        }
    }
    (record,) = dv.build_gap_records([gap()], ships, healthy())
    assert record["name"] == "EBANO"
    assert record["imo"] == "7406784"
    assert record["sanctions"]["matched_on"] == "imo"


def test_designated_hulls_sort_above_longer_gaps():
    """A designated tanker going dark is the headline case; an unlisted ship
    with a longer gap is not."""
    ships = {"111": {"mmsi": "111", "sanctions": {"program": "IRAN", "matched_on": "imo"}}}
    records = dv.build_gap_records(
        [gap(entity_id="222", gap_hours=20.0), gap(entity_id="111", gap_hours=5.0)],
        ships,
        healthy(),
    )
    assert [r["mmsi"] for r in records] == ["111", "222"]


# --- ship-to-ship transfers ------------------------------------------------


NO_PORTS = ProximityIndex([])


def test_two_stationary_vessels_alongside_each_other_are_paired():
    now = 1_000_000.0
    pair = [ship("111", pos=(26.0, 56.0), now=now), ship("222", pos=(26.001, 56.001), now=now)]
    (record,) = dv.build_sts_records(pair, NO_PORTS, now=now)
    assert record["kind"] == "sts_pair"
    assert {v["mmsi"] for v in record["vessels"]} == {"111", "222"}
    assert record["separation_m"] < 500
    assert record["inferred"] is True
    # Placed between the two, since neither one is the event.
    assert 26.0 < record["lat"] < 26.001


def test_vessels_too_far_apart_are_not_a_transfer():
    now = 1_000_000.0
    pair = [ship("111", pos=(26.0, 56.0), now=now), ship("222", pos=(26.05, 56.05), now=now)]
    assert dv.build_sts_records(pair, NO_PORTS, now=now) == []


def test_a_vessel_still_making_way_is_not_a_transfer():
    now = 1_000_000.0
    pair = [
        ship("111", pos=(26.0, 56.0), now=now),
        ship("222", pos=(26.001, 56.001), speed=8.0, now=now),
    ]
    assert dv.build_sts_records(pair, NO_PORTS, now=now) == []


def test_a_pair_that_has_only_just_stopped_is_not_a_transfer():
    """Two ships passing slowly are not two ships transferring cargo; the hour
    is what separates them."""
    now = 1_000_000.0
    pair = [
        ship("111", pos=(26.0, 56.0), still_hours=0.2, now=now),
        ship("222", pos=(26.001, 56.001), still_hours=0.2, now=now),
    ]
    assert dv.build_sts_records(pair, NO_PORTS, now=now) == []


def test_moored_vessels_are_excluded():
    """AIS status 5 is the vessel's own statement that it is alongside
    something, which is the ordinary explanation for sitting still."""
    now = 1_000_000.0
    pair = [
        ship("111", pos=(26.0, 56.0), nav_status=5, now=now),
        ship("222", pos=(26.001, 56.001), nav_status=5, now=now),
    ]
    assert dv.build_sts_records(pair, NO_PORTS, now=now) == []


def test_vessels_sitting_in_a_known_port_are_excluded():
    now = 1_000_000.0
    ports = ProximityIndex([{"lat": 26.0, "lon": 56.0, "name": "Some Port"}])
    pair = [ship("111", pos=(26.0, 56.0), now=now), ship("222", pos=(26.001, 56.001), now=now)]
    assert dv.build_sts_records(pair, ports, now=now) == []


def test_a_pair_is_reported_once_not_twice():
    now = 1_000_000.0
    pair = [ship("111", pos=(26.0, 56.0), now=now), ship("222", pos=(26.001, 56.001), now=now)]
    assert len(dv.build_sts_records(pair, NO_PORTS, now=now)) == 1


def test_three_rafted_vessels_yield_all_three_pairs():
    """Deliberately not "the closest other vessel": a raft of three is one of
    the shapes worth seeing, and collapsing it to one pair would hide it."""
    now = 1_000_000.0
    trio = [
        ship("111", pos=(26.0, 56.0), now=now),
        ship("222", pos=(26.001, 56.0), now=now),
        ship("333", pos=(26.002, 56.0), now=now),
    ]
    records = dv.build_sts_records(trio, NO_PORTS, now=now)
    assert len(records) == 3


def test_a_designated_hull_in_the_pair_is_surfaced_and_sorts_first():
    now = 1_000_000.0
    listing = {"program": "IRAN-EO13846", "listed_as": "SOME TANKER", "matched_on": "imo"}
    ships = [
        ship("111", pos=(26.0, 56.0), now=now),
        ship("222", pos=(26.001, 56.0), now=now),
        ship("333", pos=(27.0, 56.0), now=now, sanctions=listing),
        ship("444", pos=(27.001, 56.0), now=now),
    ]
    records = dv.build_sts_records(ships, NO_PORTS, now=now)
    assert records[0]["designated_count"] == 1
    assert records[0]["sanctions"]["program"] == "IRAN-EO13846"


def test_a_vessel_without_a_position_or_speed_is_skipped_rather_than_crashing():
    now = 1_000_000.0
    ships = [
        {"mmsi": "111", "lat": None, "lon": 56.0, "speed": 0.1, "_last_moved_at": now - 5 * HOUR},
        {"mmsi": "222", "lat": 26.0, "lon": 56.0, "speed": None, "_last_moved_at": now - 5 * HOUR},
        ship("333", pos=(26.0, 56.0), now=now),
        ship("444", pos=(26.001, 56.0), now=now),
    ]
    records = dv.build_sts_records(ships, NO_PORTS, now=now)
    assert [sorted(v["mmsi"] for v in r["vessels"]) for r in records] == [["333", "444"]]
