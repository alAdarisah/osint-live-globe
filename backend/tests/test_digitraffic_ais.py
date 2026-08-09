"""Digitraffic AIS parsing: the ETA bit-unpack, the join, and the source split.

Three things about this feed are easy to get wrong in ways nothing would raise
on, so each is pinned here against payloads shaped like the live responses:

  - Digitraffic hands over the AIS ETA as one packed 20-bit integer, not the
    already-split dict aisstream sends. Unpacking it by decimal digits (which the
    "MMDDHHMM" shorthand invites) rather than by bit-shifting reads it as garbage.
  - Position and metadata come from two endpoints joined by MMSI, and ~122 of
    ~974 positions have no metadata yet. Dropping those would blank live hulls.
  - Every record must carry source="digitraffic": the whole reason this is kind
    "ais_digitraffic" and not "ais" is that the two networks stay distinguishable.
"""

from backend.sources import digitraffic_ais as ais


# ETA month=8, day=15, hour=18, minute=30 packed the way AIS message 5 carries
# it: month<<16 | day<<11 | hour<<6 | minute.
ETA_AUG_15_1830 = (8 << 16) | (15 << 11) | (18 << 6) | 30
# The same date with hour 24 and minute 60 -- M.1371's per-field "not available".
ETA_AUG_15_NO_TIME = (8 << 16) | (15 << 11) | (24 << 6) | 60


def location(mmsi=230123456, coordinates=(24.9384, 60.1699), **props):
    """One /locations GeoJSON feature. `coordinates` is GeoJSON order [lon, lat]."""
    base = {
        "sog": 12.3,
        "cog": 210.5,
        "navStat": 0,
        "rot": 0,
        "posAcc": True,
        "raim": False,
        "heading": 208,
        "timestamp": 45,
        "timestampExternal": 1754740800000,  # epoch ms
    }
    base.update(props)
    return {
        "mmsi": mmsi,
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": list(coordinates)},
        "properties": base,
    }


def collection(*features):
    return {"type": "FeatureCollection", "features": list(features)}


def vessel(mmsi=230123456, **fields):
    """One /vessels metadata row."""
    base = {
        "name": "SILJA SERENADE",
        "callSign": "OJBR",
        "imo": 8830402,
        "destination": "HELSINKI",
        "draught": 71,  # tenths of a metre -> 7.1 m
        "eta": ETA_AUG_15_1830,
        "shipType": 60,
        "referencePointA": 100,
        "referencePointB": 103,
        "referencePointC": 15,
        "referencePointD": 12,
        "timestamp": 1754740800000,
    }
    base.update(fields)
    base["mmsi"] = mmsi
    return base


# --- the ETA bit-unpack -----------------------------------------------------


def test_eta_unpacks_by_bits_not_decimal_digits():
    assert ais.unpack_eta(ETA_AUG_15_1830) == {"month": 8, "day": 15, "hour": 18, "minute": 30}


def test_eta_zero_is_not_available_and_returns_none():
    """The all-zeros sentinel: month 0, day 0 -> no date -> not an ETA."""
    assert ais.unpack_eta(0) is None


def test_eta_keeps_a_date_but_drops_the_not_available_hour_and_minute():
    """Hour 24 and minute 60 are M.1371's per-field 'not available'."""
    assert ais.unpack_eta(ETA_AUG_15_NO_TIME) == {"month": 8, "day": 15}


def test_eta_midnight_on_the_hour_is_kept_not_mistaken_for_unset():
    """Hour 0 is midnight and minute 0 is on the hour -- both real values."""
    packed = (8 << 16) | (15 << 11) | (0 << 6) | 0
    assert ais.unpack_eta(packed) == {"month": 8, "day": 15, "hour": 0, "minute": 0}


def test_eta_rejects_non_integers():
    for bad in (None, "556190", 5.5, True):
        assert ais.unpack_eta(bad) is None


# --- vessel metadata --------------------------------------------------------


def test_draught_is_tenths_of_a_metre_divided_to_metres():
    (_mmsi, static) = ais.parse_vessel(vessel(draught=95))
    assert static["draught"] == 9.5


def test_a_zero_draught_is_dropped_not_stored_as_afloat_on_the_surface():
    (_mmsi, static) = ais.parse_vessel(vessel(draught=0))
    assert "draught" not in static


def test_an_imo_of_zero_is_not_a_hull():
    (_mmsi, static) = ais.parse_vessel(vessel(imo=0))
    assert "imo" not in static


def test_imo_is_carried_as_a_string_when_set():
    (_mmsi, static) = ais.parse_vessel(vessel(imo=8830402))
    assert static["imo"] == "8830402"


def test_dimensions_sum_to_length_and_beam():
    (_mmsi, static) = ais.parse_vessel(
        vessel(referencePointA=100, referencePointB=103, referencePointC=15, referencePointD=12)
    )
    assert static["length_m"] == 203
    assert static["beam_m"] == 27


def test_vessel_fields_are_labelled_like_aisstream():
    (mmsi, static) = ais.parse_vessel(vessel())
    assert mmsi == 230123456
    assert static["name"] == "SILJA SERENADE"
    assert static["callsign"] == "OJBR"
    assert static["destination"] == "HELSINKI"
    assert static["eta"] == {"month": 8, "day": 15, "hour": 18, "minute": 30}


# --- location reports -------------------------------------------------------


def test_coordinates_are_lon_lat_in_that_order():
    (rec,) = ais.build_records(collection(location()), [])
    # [lon, lat] in, lat/lon out -- swapping puts every hull in the wrong place.
    assert (rec["lat"], rec["lon"]) == (60.1699, 24.9384)


def test_the_observation_time_comes_from_timestamp_external_in_seconds():
    (rec,) = ais.build_records(collection(location(timestampExternal=1754740800000)), [])
    assert rec["time"] == 1754740800.0


def test_pos_acc_and_raim_are_read_as_plain_booleans():
    """The vendor OpenAPI wrongly declares these enum:[false,false]."""
    (rec,) = ais.build_records(collection(location(posAcc=True, raim=True)), [])
    assert rec["pos_accuracy"] is True
    assert rec["raim"] is True


def test_a_location_with_no_coordinate_is_dropped_not_placed():
    broken = location()
    broken["geometry"]["coordinates"] = []
    assert ais.build_records(collection(broken), []) == []


# --- the join ---------------------------------------------------------------


def test_metadata_is_joined_onto_the_position_by_mmsi():
    (rec,) = ais.build_records(collection(location(mmsi=1)), [vessel(mmsi=1)])
    assert rec["name"] == "SILJA SERENADE"
    assert rec["draught"] == 7.1
    assert rec["length_m"] == 203


def test_a_position_with_no_metadata_yet_is_emitted_position_only():
    """~122 of ~974 hulls have no static frame yet -- never drop them."""
    (rec,) = ais.build_records(collection(location(mmsi=999)), [vessel(mmsi=1)])
    assert rec["mmsi"] == 999
    assert "name" not in rec
    assert rec["lat"] and rec["lon"]


def test_every_record_carries_the_digitraffic_source_and_licence():
    records = ais.build_records(
        collection(location(mmsi=1), location(mmsi=2)), [vessel(mmsi=1)]
    )
    assert len(records) == 2
    for rec in records:
        assert rec["source"] == "digitraffic"
        assert rec["license"] == "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY"


def test_the_join_survives_empty_and_missing_payloads():
    assert ais.build_records(None, None) == []
    assert ais.build_records({}, []) == []
    assert ais.build_records({"features": []}, [vessel()]) == []
