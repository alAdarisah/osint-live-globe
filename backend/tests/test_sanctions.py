"""OFAC SDN parsing, and the identifier hierarchy a match is judged on.

Two things are pinned here above all: that the headerless columns are read at
the right positions, and that a match always says *which* identifier fired. The
second matters more than it looks -- an IMO is permanent and hull-specific, an
MMSI is reissued on reflagging, and a call sign is free text a crew typed in.
Presenting all three as "sanctioned" would be presenting a guess as a fact.
"""

from backend.sources import sanctions

# The 12 headerless columns, in OFAC's order. `-0- ` (with the trailing space
# OFAC actually writes) is its null.
NULL = "-0- "


def sdn_row(
    ent_num="4243",
    name="EBANO",
    sdn_type="vessel",
    program="CUBA",
    title=NULL,
    call_sign=NULL,
    vessel_type="General Cargo",
    tonnage="2595",
    grt="1865",
    vessel_flag="Panama",
    vessel_owner=NULL,
    remarks="Vessel Registration Identification IMO 7406784; f.k.a. 'ANA I'; f.k.a. 'SAND SWAN'.",
) -> str:
    fields = [ent_num, name, sdn_type, program, title, call_sign, vessel_type,
              tonnage, grt, vessel_flag, vessel_owner, remarks]
    return ",".join(f'"{f}"' for f in fields)


def index(*rows: str) -> sanctions.SanctionsIndex:
    return sanctions.SanctionsIndex(sanctions.parse_sdn("\n".join(rows)))


# --- parsing ---------------------------------------------------------------


def test_columns_are_read_at_the_right_positions():
    (entry,) = sanctions.parse_sdn(sdn_row())
    assert entry["ent_num"] == "4243"
    assert entry["name"] == "EBANO"
    assert entry["sdn_type"] == "vessel"
    assert entry["program"] == "CUBA"
    assert entry["vessel_type"] == "General Cargo"
    assert entry["vessel_flag"] == "Panama"


def test_the_null_sentinel_becomes_none_not_the_literal_string():
    (entry,) = sanctions.parse_sdn(sdn_row(vessel_owner=NULL, call_sign=NULL))
    assert entry["vessel_owner"] is None
    assert entry["callsign"] is None
    # Written both with and without the trailing space across the real file.
    (stripped,) = sanctions.parse_sdn(sdn_row(vessel_flag="-0-"))
    assert stripped["vessel_flag"] is None


def test_imo_and_mmsi_are_pulled_out_of_the_remarks_prose():
    (entry,) = sanctions.parse_sdn(sdn_row(
        remarks="Vessel Registration Identification IMO 9260892; MMSI 636014321; Linked To: SOMEONE."
    ))
    assert entry["imo"] == "9260892"
    assert entry["mmsi"] == "636014321"


def test_a_remarks_string_carrying_no_identifier_yields_none_not_a_partial_match():
    (entry,) = sanctions.parse_sdn(sdn_row(remarks="Secondary sanctions risk: section 1(b)."))
    assert entry["imo"] is None
    assert entry["mmsi"] is None


def test_wrong_length_numbers_are_not_accepted_as_identifiers():
    """An IMO is exactly 7 digits and an MMSI exactly 9. Anything else in that
    sentence is a different number that happens to sit near the word."""
    (entry,) = sanctions.parse_sdn(sdn_row(remarks="IMO 12345; MMSI 4321."))
    assert entry["imo"] is None
    assert entry["mmsi"] is None


def test_previous_names_are_kept_because_renaming_is_the_whole_game():
    (entry,) = sanctions.parse_sdn(sdn_row())
    assert entry["aliases"] == ["ANA I", "SAND SWAN"]


def test_individuals_and_entities_are_dropped():
    """~17,000 of the file's 19,000 rows. Nothing on this map is a person."""
    rows = sanctions.parse_sdn("\n".join([
        sdn_row(name="SOME PERSON", sdn_type="individual"),
        sdn_row(name="SOME COMPANY", sdn_type=NULL),
        sdn_row(),
    ]))
    assert [r["name"] for r in rows] == ["EBANO"]


def test_short_rows_are_skipped_rather_than_read_off_by_one():
    rows = sanctions.parse_sdn("\n".join(['"1","SHORT","vessel"', sdn_row()]))
    assert [r["name"] for r in rows] == ["EBANO"]


# --- aircraft --------------------------------------------------------------


def test_an_aircraft_is_listed_by_its_tail_number_in_the_name_column():
    hits = index(sdn_row(
        ent_num="15432", name="EP-GOL", sdn_type="aircraft", program="SDGT",
        vessel_type=NULL, tonnage=NULL, grt=NULL, vessel_flag=NULL,
        remarks="Aircraft Model IL-76TD; Aircraft Operator YAS AIR.",
    ))
    match = hits.for_aircraft("EP-GOL")
    assert match["listed_as"] == "EP-GOL"
    assert match["program"] == "SDGT"
    assert match["matched_on"] == "registration"


def test_registration_punctuation_and_case_do_not_decide_a_match():
    hits = index(sdn_row(name="EP-GOL", sdn_type="aircraft"))
    assert hits.for_aircraft("epgol") is not None
    assert hits.for_aircraft("EP-GOL") is not None
    assert hits.for_aircraft("EPGOL") is not None
    assert hits.for_aircraft("EP-GOM") is None


def test_a_tail_number_spelled_out_in_the_remarks_is_also_indexed():
    hits = index(sdn_row(
        name="SOME AIRCRAFT", sdn_type="aircraft",
        remarks="Aircraft Tail Number T7-ABC; Aircraft Model B737.",
    ))
    assert hits.for_aircraft("T7-ABC") is not None


def test_an_aircraft_lookup_with_no_registration_matches_nothing():
    hits = index(sdn_row(name="EP-GOL", sdn_type="aircraft"))
    assert hits.for_aircraft(None) is None
    assert hits.for_aircraft("") is None


# --- the identifier hierarchy ----------------------------------------------


def test_imo_wins_over_mmsi_and_call_sign():
    hits = index(sdn_row(
        call_sign="CL2192",
        remarks="Vessel Registration Identification IMO 7406784; MMSI 636014321.",
    ))
    assert hits.for_vessel(imo="7406784", mmsi="636014321", callsign="CL2192")["matched_on"] == "imo"
    assert hits.for_vessel(mmsi="636014321", callsign="CL2192")["matched_on"] == "mmsi"
    assert hits.for_vessel(callsign="CL2192")["matched_on"] == "callsign"


def test_a_match_carries_the_programme_and_the_listed_name():
    hits = index(sdn_row(program="IRAN-EO13846"))
    match = hits.for_vessel(imo="7406784")
    assert match["listed_as"] == "EBANO"
    assert match["program"] == "IRAN-EO13846"
    assert match["sdn_type"] == "vessel"
    assert match["aliases"] == ["ANA I", "SAND SWAN"]


def test_nothing_matches_on_the_vessel_name():
    """There are dozens of ships called VICTORY and a name is the easiest field
    in AIS to change; matching on it would manufacture designations."""
    hits = index(sdn_row(name="EBANO"))
    assert hits.for_vessel(callsign="EBANO") is None
    assert hits.for_vessel(imo=None, mmsi=None, callsign=None) is None


def test_a_two_character_identifier_is_ignored_as_a_coincidence():
    hits = index(sdn_row(call_sign="AB"))
    assert hits.for_vessel(callsign="AB") is None


def test_an_empty_index_has_no_opinion_rather_than_raising():
    """Called on every AIS position report, including before the 5 MB file has
    downloaded and while OFAC is unreachable."""
    empty = sanctions.SanctionsIndex()
    assert empty.for_vessel(imo="7406784") is None
    assert empty.for_aircraft("EP-GOL") is None
    assert len(empty) == 0
