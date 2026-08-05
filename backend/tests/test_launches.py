"""Launch Library parsing: the pad coordinate, the T-0, and how firm it is.

`net` is "no earlier than", not a launch time, and for a launch two months out
it can be accurate only to the month. Carrying that precision through is the
difference between a countdown and a lie.
"""

from backend.sources import launches


def launch_row(
    launch_id="d46cab82-dcf5-4d70-b698-d7bead7f638c",
    name="Smart Dragon 3 | OSE HS-01 & 02",
    net="2026-08-05T02:38:00Z",
    precision="MIN",
    status_name="Go for Launch",
    lat=36.631333,
    lon=121.198361,
    **overrides,
) -> dict:
    row = {
        "id": launch_id,
        "name": name,
        "net": net,
        "net_precision": {"abbrev": precision, "name": "Minute"},
        "window_start": "2026-08-05T02:27:00Z",
        "window_end": "2026-08-05T02:48:00Z",
        "status": {"name": status_name, "abbrev": "Go"},
        "launch_service_provider": {"name": "China Rocket Co. Ltd."},
        "rocket": {"configuration": {"full_name": "Smart Dragon 3"}},
        "mission": {
            "name": "OSE HS-01 & 02",
            "type": "Earth Science",
            "orbit": {"name": "Sun-Synchronous Orbit", "abbrev": "SSO"},
        },
        "pad": {
            "name": "Haiyang offshore launch location",
            "latitude": lat,
            "longitude": lon,
            "location": {"name": "Haiyang Oriental Spaceport"},
        },
        "url": "https://ll.thespacedevs.com/2.3.0/launches/d46cab82/",
    }
    row.update(overrides)
    return row


def test_a_launch_is_placed_at_its_pad():
    (record,) = launches.parse_launches({"results": [launch_row()]}, upcoming=True)
    assert (record["lat"], record["lon"]) == (36.631333, 121.198361)
    assert record["pad"] == "Haiyang offshore launch location"
    assert record["site"] == "Haiyang Oriental Spaceport"


def test_the_mission_rocket_and_orbit_come_through():
    (record,) = launches.parse_launches({"results": [launch_row()]}, upcoming=True)
    assert record["rocket"] == "Smart Dragon 3"
    assert record["mission"] == "OSE HS-01 & 02"
    assert record["mission_type"] == "Earth Science"
    assert record["orbit"] == "Sun-Synchronous Orbit"
    assert record["provider"] == "China Rocket Co. Ltd."


def test_timestamps_become_unix_seconds():
    (record,) = launches.parse_launches({"results": [launch_row()]}, upcoming=True)
    assert record["net"] == 1_785_897_480.0
    assert record["window_start"] < record["net"] < record["window_end"]


def test_how_firm_the_t_zero_is_travels_with_it():
    """A launch scheduled to the month must not be drawn with a live countdown
    to the second."""
    (minute,) = launches.parse_launches({"results": [launch_row(precision="MIN")]}, upcoming=True)
    (month,) = launches.parse_launches({"results": [launch_row(precision="MO")]}, upcoming=True)
    assert minute["net_precision"] == "MIN"
    assert month["net_precision"] == "MO"


def test_the_upcoming_flag_is_set_by_the_window_it_came_from():
    (upcoming,) = launches.parse_launches({"results": [launch_row()]}, upcoming=True)
    (previous,) = launches.parse_launches({"results": [launch_row()]}, upcoming=False)
    assert upcoming["upcoming"] is True
    assert previous["upcoming"] is False


def test_a_launch_with_no_pad_coordinate_is_dropped():
    """"Roughly China" is not a launch site, and a provider's country centroid
    would be exactly that."""
    rows = launches.parse_launches({"results": [
        launch_row(launch_id="a", pad={"name": "Unknown", "location": {}}),
        launch_row(launch_id="b", pad={"name": "x", "latitude": None, "longitude": 1.0}),
        launch_row(launch_id="c"),
    ]}, upcoming=True)
    assert [r["id"] for r in rows] == ["c"]


def test_a_missing_mission_or_rocket_does_not_break_the_record():
    (record,) = launches.parse_launches(
        {"results": [launch_row(mission=None, rocket=None)]}, upcoming=True
    )
    assert record["mission"] is None
    assert record["orbit"] is None
    assert record["rocket"] is None
    assert record["lat"] == 36.631333


def test_a_malformed_or_missing_timestamp_yields_none_rather_than_now():
    (record,) = launches.parse_launches(
        {"results": [launch_row(net="not-a-date", window_start=None)]}, upcoming=True
    )
    assert record["net"] is None
    assert record["window_start"] is None


def test_an_empty_payload_is_not_an_error():
    assert launches.parse_launches({}, upcoming=True) == []
    assert launches.parse_launches({"results": []}, upcoming=True) == []
