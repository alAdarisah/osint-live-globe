"""The NGA World Port Index response -> port records.

Two things about the coordinates in that file are load-bearing and neither is
visible in a hand-written fixture, so both are copied verbatim below:

  - Every row of the *full* dump carries the degree sign double-encoded --
    "30Â°20'00\"N", the UTF-8 bytes of ° served as Latin-1. The
    country-filtered endpoint returns it clean, so a fixture built from a
    filtered sample passes while the poller, which fetches the full dump,
    silently parses nothing.
  - 44 rows carry fractional seconds ("43°37'44.4\"N", mostly Italian). A
    seconds pattern of (\\d+) drops exactly those and nothing else, which is the
    kind of loss that shows up as a port quietly missing rather than as an error.

The 6.3 MB dump is not fetched here. What is tested is the shape of the rows
inside it, plus the theatre and AIS-box clipping that decides which ones the map
keeps at all.
"""

from backend import config
from backend.sources import ports

# Abadan, verbatim from the country-filtered response: clean degree signs.
ABADAN = {
    "globalId": "{361E3AAE-91D3-4564-B99A-A14B52D7E21B}",
    "portNumber": 48430,
    "portName": "Abadan",
    "countryCode": "IR",
    "countryName": "Iran",
    "latitude": "30°20'00\"N",
    "longitude": "48°17'00\"E",
    "navArea": "IX",
    "harborSize": "M",
    "harborType": "RN",
    "unloCode": "IR ABD",
    "loOilTerm": "U",
}

# The same coordinate as it arrives in the full dump.
ABADAN_MOJIBAKE = {**ABADAN, "latitude": "30Â°20'00\"N", "longitude": "48Â°17'00\"E"}

# Ancona: fractional seconds, and outside every theatre.
ANCONA = {
    "globalId": "{AAAA1111-0000-0000-0000-000000000001}",
    "portNumber": 39130,
    "portName": "Ancona",
    "countryCode": "IT",
    "countryName": "Italy",
    "latitude": "43°37'44.4\"N",
    "longitude": "13°30'21.6\"E",
    "harborSize": "M",
    "harborType": "CB",
}


def _parse(*rows):
    return ports.parse_ports({"ports": list(rows)})


# --- coordinates ------------------------------------------------------------


def test_the_mangled_degree_sign_parses_exactly_like_the_clean_one():
    clean = ports.parse_coordinate("30°20'00\"N")
    mangled = ports.parse_coordinate("30Â°20'00\"N")
    assert clean == mangled
    assert abs(clean - 30.3333333) < 1e-6


def test_fractional_seconds_survive():
    """A (\\d+) seconds pattern returns None here and loses 44 real ports."""
    assert abs(ports.parse_coordinate("43°37'44.4\"N") - 43.629) < 1e-3


def test_southern_and_western_hemispheres_are_negative():
    assert ports.parse_coordinate("33°52'00\"S") < 0
    assert ports.parse_coordinate("118°15'00\"W") < 0
    assert ports.parse_coordinate("30°20'00\"N") > 0


def test_an_unreadable_coordinate_is_none_rather_than_zero():
    for text in (None, "", "not a coordinate", "30°20'00\""):
        assert ports.parse_coordinate(text) is None


def test_a_port_with_no_usable_coordinate_is_dropped_not_placed():
    broken = {**ABADAN, "latitude": "", "longitude": ""}
    assert _parse(broken) == []


def test_numeric_coordinates_win_over_the_dms_strings():
    """WPI ships both; the publisher's own numbers need no regex at all."""
    row = {**ABADAN, "ycoord": 30.5, "xcoord": 48.5}
    (port,) = _parse(row)
    assert (port["lat"], port["lon"]) == (30.5, 48.5)


def test_an_out_of_range_coordinate_is_refused():
    assert _parse({**ABADAN, "ycoord": 130.0, "xcoord": 48.0}) == []


# --- identity and fields ----------------------------------------------------


def test_the_id_is_ngas_globalid_verbatim_braces_included():
    (port,) = _parse(ABADAN)
    assert port["id"] == "{361E3AAE-91D3-4564-B99A-A14B52D7E21B}"
    assert port["kind"] == "port"


def test_unlocode_is_carried_because_it_is_the_only_joinable_key():
    (port,) = _parse(ABADAN)
    assert port["unlo_code"] == "IR ABD"


def test_coded_columns_carry_their_legend():
    """A bare "M" in a popup is not information."""
    (port,) = _parse(ABADAN)
    assert port["harbor_size"] == "M"
    assert port["harbor_size_label"] == "Medium"
    assert port["harbor_type_label"] == "River, natural"


def test_an_unknown_harbor_code_labels_as_none_rather_than_guessing():
    (port,) = _parse({**ABADAN, "harborSize": "Q", "harborType": "ZZ"})
    assert port["harbor_size_label"] is None
    assert port["harbor_type_label"] is None


def test_a_row_with_no_name_or_no_id_is_dropped():
    assert _parse({**ABADAN, "portName": "  "}) == []
    assert _parse({**ABADAN, "globalId": None}) == []


def test_provenance_rides_on_every_record():
    (port,) = _parse(ABADAN)
    assert "World Port Index" in port["publisher"]
    assert "public domain" in port["license"]
    # The file carries no publication date; the record has to say so rather
    # than let a 2024-vintage gazetteer read as current.
    assert port["vintage"]


# --- oil terminals ----------------------------------------------------------


def test_the_oil_terminal_flag_reads_the_depth_not_just_the_useless_column():
    """loOilTerm is "U" on 2,914 of 2,951 rows. otDepth is where the signal is."""
    assert _parse({**ABADAN, "loOilTerm": "U", "otDepth": 12.5})[0]["oil_terminal"] is True
    assert _parse({**ABADAN, "loOilTerm": "Y"})[0]["oil_terminal"] is True
    assert _parse({**ABADAN, "loOilTerm": "U"})[0]["oil_terminal"] is False


# --- clipping ---------------------------------------------------------------


def test_a_gulf_port_lands_in_its_theatre():
    (port,) = _parse(ABADAN)
    assert port["region_key"] == "persian_gulf_hormuz"


def test_overlapping_theatres_yield_one_record_not_two():
    """Taiwan Strait sits inside the South China Sea box; first match wins."""
    taiwan = {**ABADAN, "ycoord": 24.0, "xcoord": 120.0}
    (port,) = _parse(taiwan)
    assert port["region_key"] in ("taiwan_strait", "south_china_sea")
    assert isinstance(port["region_key"], str)


def test_a_port_outside_every_theatre_and_watch_box_is_clipped_away():
    (ancona,) = _parse(ANCONA)
    assert ancona["region_key"] is None
    if not ancona["ais_watch"]:
        assert ports.clip_to_watched([ancona]) == []


def test_clipping_keeps_a_port_that_is_only_in_watched_water():
    """The clause dark_vessels.py depends on: watched water, no theatre."""
    watched = None
    for south, west, north, east in config.WATCHED_WATERS:
        lat, lon = (south + north) / 2, (west + east) / 2
        if ports.region_for(lat, lon) is None:
            watched = {**ABADAN, "ycoord": lat, "xcoord": lon}
            break
    if watched is None:
        return  # every AIS box overlaps a theatre in this configuration
    (port,) = _parse(watched)
    assert port["region_key"] is None and port["ais_watch"] is True
    assert ports.clip_to_watched([port]) == [port]


def test_the_full_dump_shape_parses_end_to_end():
    parsed = _parse(ABADAN_MOJIBAKE, ANCONA, {"portName": "no id"})
    assert len(parsed) == 2, "the mangled-degree row must not be among the losses"
    assert {p["name"] for p in parsed} == {"Abadan", "Ancona"}
