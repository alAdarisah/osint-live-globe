"""OurAirports parsing, and the name-based military inference.

The military flag is the only field here that is a guess rather than a column,
so most of these pin the guess: what it must catch, and -- more importantly --
what it must not. An unanchored "NAS" matches Nassau and an unanchored "RAF"
matches Rafael, and either one would put a military marker on a holiday airport.
"""

from backend.sources import airports

HEADER = (
    '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft",'
    '"continent","iso_country","iso_region","municipality","scheduled_service",'
    '"icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"'
)


def airport_row(
    ident="EGUL",
    kind="large_airport",
    name="RAF Lakenheath",
    lat="52.409302",
    lon="0.561",
    country="GB",
    municipality="Lakenheath",
    scheduled="no",
    icao="EGUL",
    iata="",
) -> str:
    return (
        f'1,"{ident}","{kind}","{name}",{lat},{lon},99,'
        f'"EU","{country}","GB-ENG","{municipality}","{scheduled}",'
        f'"{icao}","{iata}","{ident}","","","",""'
    )


def parse(*rows: str) -> list[dict]:
    return airports.parse_airports("\n".join([HEADER, *rows]))


def test_columns_are_read_by_header_name():
    (field,) = parse(airport_row())
    assert field["id"] == "EGUL"
    assert field["name"] == "RAF Lakenheath"
    assert field["type"] == "large_airport"
    assert (field["lat"], field["lon"]) == (52.409302, 0.561)
    assert field["country"] == "GB"
    assert field["municipality"] == "Lakenheath"
    assert field["icao"] == "EGUL"
    assert field["iata"] is None
    assert field["scheduled_service"] is False


def test_closed_fields_are_dropped_from_both_the_index_and_the_map():
    """An aircraft cannot have come from a closed airfield, so naming one as
    the nearest would be worse than naming nothing."""
    assert parse(airport_row(ident="XXXX", kind="closed", name="Old Field")) == []


def test_heliports_are_indexed_but_not_served_to_the_map():
    rows = parse(airport_row(ident="H1", kind="heliport", name="City Heliport"))
    assert [r["type"] for r in rows] == ["heliport"]
    # SERVED_TYPES is what start() filters state.data down to; INDEXED_TYPES is
    # the wider set parse_airports keeps for proximity lookups.
    assert "heliport" in airports.INDEXED_TYPES
    assert "heliport" not in airports.SERVED_TYPES


def test_rows_without_a_usable_position_or_name_are_skipped():
    rows = airports.parse_airports(
        "\n".join([
            HEADER,
            '1,"AAAA","small_airport","No position",,,99,"EU","GB","GB-ENG","x","no","","","","","","",""',
            '2,"BBBB","small_airport","",10.0,20.0,99,"EU","GB","GB-ENG","x","no","","","","","","",""',
            airport_row(),
        ])
    )
    assert [r["name"] for r in rows] == ["RAF Lakenheath"]


# --- the military-name inference -------------------------------------------


def test_service_prefixes_are_anchored_to_the_start_of_the_name():
    assert airports.is_military_name("RAF Lakenheath") is True
    assert airports.is_military_name("NAS Sigonella") is True
    assert airports.is_military_name("CFB Trenton") is True
    # The trap: substrings of ordinary place names.
    assert airports.is_military_name("Nassau Paradise Island Airport") is False
    assert airports.is_military_name("Rafael Hernandez Airport") is False
    assert airports.is_military_name("Piaf Regional") is False


def test_the_common_english_forms_are_matched_anywhere_in_the_name():
    for name in (
        "Ramstein Air Base",
        "Marine Corps Air Station Miramar",
        "Joint Base Andrews",
        "Wright-Patterson AFB",
        "Fort Campbell Army Airfield",
        "Kubinka Military Airfield",
    ):
        assert airports.is_military_name(name) is True, name


def test_two_letter_abbreviations_are_left_alone():
    """"AB" is a real abbreviation for Air Base and also two letters that occur
    everywhere. The spelled-out forms carry the match instead."""
    assert airports.is_military_name("Kadena AB") is False
    assert airports.is_military_name("Kadena Air Base") is True


def test_the_flag_travels_on_the_parsed_row():
    (military,) = parse(airport_row(name="Ramstein Air Base"))
    (civil,) = parse(airport_row(name="London Heathrow Airport"))
    assert military["military_name"] is True
    assert civil["military_name"] is False


def test_an_empty_name_is_not_military():
    assert airports.is_military_name(None) is False
    assert airports.is_military_name("") is False


# --- the proximity index ---------------------------------------------------


def test_nearest_finds_a_field_inside_the_radius_and_nothing_outside_it():
    airports.install([
        {"lat": 52.4093, "lon": 0.561, "name": "RAF Lakenheath", "icao": "EGUL"},
    ])
    close = airports.nearest(52.42, 0.57)
    assert close and close["name"] == "RAF Lakenheath"
    # Roughly 500 km away -- well outside NEAREST_RADIUS_KM.
    assert airports.nearest(48.0, 2.0) is None


def test_an_unbuilt_index_has_no_opinion_rather_than_raising():
    """ADS-B calls this on every aircraft on every poll, including before the
    12 MB airfield file has finished downloading."""
    airports.install([])
    assert airports.nearest(52.42, 0.57) is None
