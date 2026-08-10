"""Digitraffic rail parsing: the synthetic identity, and stations as reference.

The one trap that has to be pinned is identity. ``trainNumber`` is reused every
day, so the entity id is the composite ``departureDate:trainNumber`` -- key on
the number alone and yesterday's IC 1 and today's IC 1 become one entity_history
track that teleports across Finland at midnight. Coordinate order ([lon, lat])
and the ISO timestamp -> unix seconds conversion are pinned alongside it, plus
the station gazetteer's own defensive parse.
"""

from backend.sources import digitraffic_rail as rail


def train(train_number=1, departure_date="2026-08-09", coordinates=(24.9, 60.2), **fields):
    """One /train-locations row. `coordinates` is GeoJSON order [lon, lat]."""
    base = {
        "speed": 120,
        "accuracy": 10,
        "timestamp": "2026-08-09T12:34:56.000Z",
    }
    base.update(fields)
    base["trainNumber"] = train_number
    base["departureDate"] = departure_date
    base["location"] = {"type": "Point", "coordinates": list(coordinates)}
    return base


def station(short="HKI", **fields):
    base = {
        "stationName": "Helsinki asema",
        "stationUICCode": 1,
        "countryCode": "FI",
        "latitude": 60.172097,
        "longitude": 24.941249,
        "passengerTraffic": True,
        "type": "STATION",
    }
    base.update(fields)
    base["stationShortCode"] = short
    return base


# --- the synthetic identity -------------------------------------------------


def test_identity_is_departure_date_and_train_number_not_the_number_alone():
    (rec,) = rail.parse_trains([train(train_number=1, departure_date="2026-08-09")])
    assert rec["id"] == "2026-08-09:1"
    assert rec["train_number"] == 1
    assert rec["departure_date"] == "2026-08-09"


def test_the_same_train_number_on_two_dates_is_two_distinct_entities():
    a, b = rail.parse_trains([
        train(train_number=1, departure_date="2026-08-09"),
        train(train_number=1, departure_date="2026-08-10"),
    ])
    assert a["id"] != b["id"]


def test_a_row_missing_the_departure_date_is_dropped_not_mis_keyed():
    assert rail.parse_trains([train(departure_date=None)]) == []


# --- coordinates and time ---------------------------------------------------


def test_coordinates_are_lon_lat_in_that_order():
    (rec,) = rail.parse_trains([train(coordinates=(24.9384, 60.1699))])
    assert (rec["lat"], rec["lon"]) == (60.1699, 24.9384)


def test_a_train_with_no_location_is_dropped_not_placed_at_null():
    row = train()
    row["location"] = None
    assert rail.parse_trains([row]) == []


def test_the_iso_timestamp_becomes_unix_seconds():
    (rec,) = rail.parse_trains([train(timestamp="2026-08-09T12:34:56.000Z")])
    # 2026-08-09T12:34:56Z is a fixed instant; just assert it round-tripped to a
    # plausible unix-seconds float rather than a string.
    assert isinstance(rec["time"], float)
    assert rec["time"] > 1_700_000_000


def test_an_unparseable_timestamp_is_none_rather_than_raising():
    (rec,) = rail.parse_trains([train(timestamp="not a time")])
    assert rec["time"] is None


def test_attribution_rides_on_every_train_record():
    (rec,) = rail.parse_trains([train()])
    assert rec["source"] == "digitraffic"
    assert rec["license"] == "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"


# --- stations (reference document) ------------------------------------------


def test_a_station_keeps_its_short_code_as_id_and_carries_the_uic_join_key():
    (rec,) = rail.parse_stations([station(short="HKI", stationUICCode=1)])
    assert rec["id"] == "HKI"
    assert rec["short_code"] == "HKI"
    assert rec["uic_code"] == 1


def test_a_station_with_no_coordinate_or_no_code_is_dropped():
    assert rail.parse_stations([station(latitude=None, longitude=None)]) == []
    assert rail.parse_stations([station(short="  ")]) == []


def test_stations_carry_their_coordinates_and_passenger_flag():
    (rec,) = rail.parse_stations([station(latitude=60.172097, longitude=24.941249)])
    assert (rec["lat"], rec["lon"]) == (60.172097, 24.941249)
    assert rec["passenger_traffic"] is True


def test_empty_and_missing_payloads_are_not_errors():
    assert rail.parse_trains(None) == []
    assert rail.parse_stations(None) == []
