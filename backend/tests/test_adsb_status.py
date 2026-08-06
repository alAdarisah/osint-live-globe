"""Emergency squawks, display-limited programmes, and the nearest airfield.

Three things an aircraft record now carries that are not positions, and each one
is a claim with a different strength: a squawk code is broadcast by the aircraft,
a LADD/PIA tag is a fact about a registry entry, and a nearest airfield is our
own inference from proximity. They are kept in separate fields for that reason
and these pin the separation.
"""

from backend.sources import adsb, airports


def ac(**overrides) -> dict:
    """One airplanes.live aircraft object, in its own field names."""
    base = {
        "hex": "AE01CE",
        "flight": "RCH285  ",
        "lat": 52.4,
        "lon": 0.56,
        "alt_baro": 3200,
        "alt_geom": 3300,
        "gs": 240,
        "track": 91,
        "category": "A5",
        "dbFlags": 1,
        "t": "C17",
        "desc": "Boeing C-17A Globemaster III",
        "r": "07-7185",
        "ownOp": "UNITED STATES AIR FORCE",
    }
    base.update(overrides)
    return base


# --- normalisation ---------------------------------------------------------


def test_the_hex_is_lowercased_so_every_endpoint_keys_the_same_aircraft():
    """The same aircraft arrives from /mil, a point query and possibly /pia.
    A case difference would make it three aircraft on the map."""
    assert adsb.normalize_airplanes_live(ac(hex="AE01CE"))["icao24"] == "ae01ce"
    assert adsb.normalize_airplanes_live(ac(hex="ae01ce"))["icao24"] == "ae01ce"


def test_an_aircraft_without_a_position_is_dropped():
    assert adsb.normalize_airplanes_live(ac(lat=None)) is None
    assert adsb.normalize_airplanes_live(ac(hex="")) is None


def test_ground_aircraft_take_their_altitude_from_the_geometric_field():
    """alt_baro is the string "ground" for a parked aircraft, which is not a
    number and cannot be drawn as one."""
    parked = adsb.normalize_airplanes_live(ac(alt_baro="ground"))
    assert parked["on_ground"] is True
    assert parked["altitude"] == 3300


# --- when the position was last true ---------------------------------------
#
# An aircraft icon outlives its transmission: the live payload keeps whatever
# the last successful poll returned for as long as the upstream is failing, and
# every replayed contact is old by definition. `updated` is what lets the popup
# say so, and it has to mean the same thing whichever of the two feeds an
# aircraft arrived from -- readsb reports an age, OpenSky reports a timestamp.


def test_the_readsb_age_becomes_an_absolute_timestamp(monkeypatch):
    monkeypatch.setattr(adsb.time, "time", lambda: 1_786_000_000.0)
    assert adsb.normalize_airplanes_live(ac(seen_pos=4.2))["updated"] == 1_785_999_995.8


def test_the_position_age_is_preferred_over_the_message_age(monkeypatch):
    """`seen` is time since any message, `seen_pos` since the last *position*.
    The icon is drawn at a position, so it is the position that has to be dated."""
    monkeypatch.setattr(adsb.time, "time", lambda: 1_786_000_000.0)
    record = adsb.normalize_airplanes_live(ac(seen=1.0, seen_pos=30.0))
    assert record["updated"] == 1_785_999_970.0


def test_an_aircraft_reporting_no_age_at_all_carries_no_timestamp():
    """Rather than defaulting to now, which would date a stale contact as live."""
    assert adsb.normalize_airplanes_live(ac())["updated"] is None


# --- emergencies -----------------------------------------------------------


def test_an_emergency_squawk_is_read_off_the_transponder_code():
    assert adsb.normalize_airplanes_live(ac(squawk="7700"))["emergency_squawk"] == "general emergency"
    assert adsb.normalize_airplanes_live(ac(squawk="7600"))["emergency_squawk"] == "radio failure"
    assert (
        adsb.normalize_airplanes_live(ac(squawk="7500"))["emergency_squawk"]
        == "unlawful interference (hijack)"
    )


def test_an_ordinary_squawk_is_kept_but_is_not_an_emergency():
    record = adsb.normalize_airplanes_live(ac(squawk="1200"))
    assert record["squawk"] == "1200"
    assert record["emergency_squawk"] is None


def test_the_decoded_emergency_field_is_separate_from_the_squawk():
    """Only newer transponders broadcast the decoded status, so either signal
    can appear without the other and the popup has to be able to say which."""
    only_decoded = adsb.normalize_airplanes_live(ac(emergency="lifeguard", squawk="1200"))
    assert only_decoded["emergency"] == "lifeguard / medical"
    assert only_decoded["emergency_squawk"] is None

    only_squawk = adsb.normalize_airplanes_live(ac(emergency="none", squawk="7700"))
    assert only_squawk["emergency"] is None
    assert only_squawk["emergency_squawk"] == "general emergency"


def test_emergency_none_is_not_an_emergency():
    assert adsb.normalize_airplanes_live(ac(emergency="none"))["emergency"] is None
    assert adsb.normalize_airplanes_live(ac(emergency=""))["emergency"] is None


# --- the nearest airfield --------------------------------------------------


def test_a_low_aircraft_is_told_which_airfield_it_is_near():
    airports.install([
        {"lat": 52.4093, "lon": 0.561, "name": "RAF Lakenheath", "icao": "EGUL", "military_name": True},
    ])
    item = {"lat": 52.42, "lon": 0.57, "altitude": 2000, "on_ground": False}
    adsb._attach_nearest_airfield(item)
    assert item["nearest_airfield"]["name"] == "RAF Lakenheath"
    assert item["nearest_airfield"]["code"] == "EGUL"
    assert item["nearest_airfield"]["military_name"] is True
    # The distance is what lets a reader judge the inference for themselves.
    assert 0 < item["nearest_airfield"]["km"] < 5


def test_a_parked_aircraft_is_matched_however_its_altitude_reads():
    airports.install([
        {"lat": 52.4093, "lon": 0.561, "name": "RAF Lakenheath", "icao": "EGUL", "military_name": True},
    ])
    item = {"lat": 52.4093, "lon": 0.561, "altitude": 40000, "on_ground": True}
    adsb._attach_nearest_airfield(item)
    assert item["nearest_airfield"]["km"] == 0.0


def test_a_cruising_aircraft_is_not_claimed_by_whatever_it_happens_to_overfly():
    """At FL350 an airliner is within 40 km of a dozen fields and at none of
    them; naming one would be noise dressed as information."""
    airports.install([
        {"lat": 52.4093, "lon": 0.561, "name": "RAF Lakenheath", "icao": "EGUL", "military_name": True},
    ])
    item = {"lat": 52.42, "lon": 0.57, "altitude": 35000, "on_ground": False}
    adsb._attach_nearest_airfield(item)
    assert "nearest_airfield" not in item


def test_no_airfield_in_range_leaves_the_record_untouched():
    airports.install([])
    item = {"lat": 52.42, "lon": 0.57, "altitude": 2000, "on_ground": False}
    adsb._attach_nearest_airfield(item)
    assert "nearest_airfield" not in item
