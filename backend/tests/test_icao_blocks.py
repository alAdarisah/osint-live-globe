"""The ICAO 24-bit allocation table: the BOM, and the overlap rule.

Two failures are pinned here above all, because neither one raises:

- The file is UTF-8 **with a BOM**, so a parser that decodes it as plain UTF-8
  sees a first column called "\\ufeffStart" and either explodes on a KeyError or
  -- worse -- reads None for every row and produces an empty table that looks
  like a quiet upstream.
- The blocks **overlap on purpose**, three deep in places, and the rule is
  smallest-containing-range, not first-hit. Getting it wrong returns the
  enclosing country-wide block, which turns an Egyptian military address into a
  civil one and a San Marino registration into "unallocated".

Every CSV row below is copied verbatim from code-blocks.csv as published on
2026-08-06.
"""

import json

from backend.sources import icao_blocks

BOM = "\ufeff"

# The BOM sits on the first header field, exactly as the file ships it.
HEADER = BOM + "Start,Finish,Count,Bitmask,SignificantBitmask,IsMilitary,CountryISO2"

# Egypt, three deep: a two-address block inside the military block inside the
# national allocation. All three contain 010070 and they disagree on IsMilitary.
EG_PAIR = "010070,010071,2,010070,FFFFFE,0,EG"
EG_MIL = "010070,01007F,16,010070,FFFFF0,1,EG"
EG_ALL = "010000,017FFF,32768,010000,FF8000,0,EG"

# Libya: one specifically-assigned military address inside a civil allocation.
LY_ONE = "0183EB,0183EB,1,0183EB,FFFFFF,1,LY"
LY_ALL = "018000,01FFFF,32768,018000,FF8000,0,LY"

# The UK military sub-block, and the allocation it sits at the top of.
GB_MIL = "43C000,43FFFF,16384,43C000,FFC000,1,GB"
GB_ALL = "400000,43FFFF,262144,400000,FC0000,0,GB"

# A plain civil allocation with nothing nested in it.
DE_ALL = "3C0000,3FFFFF,262144,3C0000,FC0000,0,DE"

# San Marino, whose range is not power-of-two aligned: SignificantBitmask comes
# out non-contiguous (FFFB00) and the bitmask search misses most of the range.
SM_ALL = "500000,5004FF,1280,500000,FFFB00,0,SM"

# The two catch-all rows: the whole address space, in halves, as "ZZ".
ZZ_LOW = "000000,7FFFFF,8388608,000000,800000,0,ZZ"
ZZ_HIGH = "800000,FFFFFF,8388608,800000,800000,0,ZZ"

ALL_ROWS = [EG_PAIR, EG_MIL, EG_ALL, LY_ONE, LY_ALL, GB_MIL, GB_ALL,
            DE_ALL, SM_ALL, ZZ_LOW, ZZ_HIGH]


def parse(*rows: str) -> list[dict]:
    return icao_blocks.parse_code_blocks("\n".join([HEADER, *rows]) + "\n")


def table(*rows: str) -> icao_blocks.CodeBlockTable:
    return icao_blocks.CodeBlockTable(parse(*rows))


# --- the BOM ---------------------------------------------------------------


def test_the_byte_order_mark_does_not_rename_the_first_column():
    """Decoded as plain UTF-8, `Start` arrives as "\\ufeffStart" and every row
    parses to nothing while the fetch reports a perfectly successful poll."""
    assert HEADER.startswith(BOM), "the fixture has to carry the trap to pin it"
    (block,) = parse(DE_ALL)
    assert block["start"] == 0x3C0000
    assert block["finish"] == 0x3FFFFF
    assert block["country"] == "DE"


def test_a_bomless_copy_parses_identically():
    """The stored copy comes back from Postgres as decoded text, and a caller
    that already stripped the BOM must not be punished for it."""
    with_bom = icao_blocks.parse_code_blocks("\n".join([HEADER, DE_ALL]))
    without = icao_blocks.parse_code_blocks("\n".join([HEADER.lstrip(BOM), DE_ALL]))
    assert with_bom == without


# --- the overlap rule ------------------------------------------------------


def test_the_smallest_containing_range_wins_not_the_first_row():
    """010070 sits in three Egyptian blocks at once. The two-address one is the
    answer; the 32768-address one would call the same aircraft something else."""
    hits = table(*ALL_ROWS)
    assert hits.lookup("010070") == {
        "country": "EG", "military": False, "block": "010070-010071",
    }
    # One address further on, the smallest containing block is the military one.
    assert hits.lookup("010072") == {
        "country": "EG", "military": True, "block": "010070-01007F",
    }
    # Outside both sub-blocks, the national allocation is all there is to say.
    assert hits.lookup("010500") == {
        "country": "EG", "military": False, "block": "010000-017FFF",
    }


def test_the_rule_does_not_depend_on_the_order_rows_arrive_in():
    """The whole failure mode this guards is a lookup that is really 'first hit
    in dict order' and happens to be right because the file is sorted."""
    forward = table(*ALL_ROWS)
    reversed_ = table(*reversed(ALL_ROWS))
    for hexid in ("010070", "010072", "010500", "0183EB", "0183EC", "43C001", "400100"):
        assert forward.lookup(hexid) == reversed_.lookup(hexid), hexid


def test_a_single_address_military_block_beats_its_civil_parent():
    hits = table(*ALL_ROWS)
    assert hits.lookup("0183EB") == {
        "country": "LY", "military": True, "block": "0183EB-0183EB",
    }
    # The neighbouring address is inside the civil allocation only.
    assert hits.lookup("0183EC") == {
        "country": "LY", "military": False, "block": "018000-01FFFF",
    }


def test_a_civil_block_reports_military_false_rather_than_nothing():
    hits = table(*ALL_ROWS)
    assert hits.lookup("3C6444") == {
        "country": "DE", "military": False, "block": "3C0000-3FFFFF",
    }


def test_a_military_sub_block_at_the_top_of_a_national_allocation():
    """43C000-43FFFF shares its Finish with the whole UK allocation, so the two
    rows are distinguished only by how wide they are."""
    hits = table(*ALL_ROWS)
    assert hits.lookup("43C123")["military"] is True
    assert hits.lookup("400100")["military"] is False
    assert hits.lookup("400100")["block"] == "400000-43FFFF"


def test_the_range_rule_wins_where_the_bitmask_rule_would_lose_the_country():
    """500000-5004FF is not power-of-two aligned, so its derived
    SignificantBitmask (FFFB00) is non-contiguous and `addr & mask == bitmask`
    rejects 768 of the 1280 addresses the range covers -- sending them to the ZZ
    catch-all instead of to San Marino. The schema's primary rule is the range,
    and it is also the one that does not throw aircraft away."""
    hits = table(*ALL_ROWS)
    assert 0x500200 & 0xFFFB00 != 0x500000, "the fixture has to be a real disagreement"
    assert hits.lookup("500200") == {
        "country": "SM", "military": False, "block": "500000-5004FF",
    }


# --- what must never be attributed ------------------------------------------


def test_the_unallocated_catch_all_is_kept_but_never_named_as_a_country():
    """ZZ is ISO 3166-1's user-assigned space, and here it is the fallback row
    that makes a bitmask search terminate. It stays in the parsed document
    because it is in the file, and it can never reach an aircraft."""
    blocks = parse(*ALL_ROWS)
    assert len(blocks) == len(ALL_ROWS), "the stored document mirrors the file"
    catch_all = [b for b in blocks if b["start"] == 0 and b["finish"] == 0x7FFFFF]
    assert catch_all and catch_all[0]["country"] is None


def test_a_hex_covered_only_by_the_catch_all_gets_no_country():
    """The one thing worse than an unknown nationality is a made-up one."""
    hits = table(*ALL_ROWS)
    assert hits.lookup("7C0123") is None  # inside ZZ_LOW and nothing else


def test_a_hex_matching_nothing_at_all_returns_none():
    hits = table(DE_ALL, GB_ALL)
    assert hits.lookup("ADFEB8") is None


def test_a_row_with_an_empty_country_parses_and_attributes_nothing():
    """No such row exists today, and the schema permits one. It must not crash
    the parse, and it must not become the empty-string 'country' either -- the
    lookup falls through to the enclosing block, which is the honest answer."""
    blank = "43C000,43FFFF,16384,43C000,FFC000,1,"
    blocks = parse(GB_ALL, blank)
    assert len(blocks) == 2
    assert [b["country"] for b in blocks] == ["GB", None]

    hits = icao_blocks.CodeBlockTable(blocks)
    assert hits.lookup("43C123") == {
        "country": "GB", "military": False, "block": "400000-43FFFF",
    }


# --- addresses that are not addresses ---------------------------------------


def test_a_tis_b_track_identifier_is_not_an_icao_address():
    """readsb prefixes rebroadcast TIS-B/ADS-R targets with "~". The digits
    after it are a ground station's tracking number, not an allocation, and
    giving one a nationality would invent a fact about a contact that has
    none."""
    hits = table(*ALL_ROWS)
    assert hits.lookup("~3C6444") is None


def test_case_and_whitespace_do_not_decide_a_match():
    """OpenSky sends lowercase icao24, airplanes.live sends lowercase `hex`,
    and the table is written uppercase."""
    hits = table(*ALL_ROWS)
    assert hits.lookup("3c6444") == hits.lookup("3C6444") == hits.lookup(" 3C6444 ")


def test_a_missing_or_unparseable_address_has_no_opinion_rather_than_raising():
    hits = table(*ALL_ROWS)
    for value in (None, "", "   ", "not-a-hex", "1000000", -1):
        assert hits.lookup(value) is None, value


def test_an_empty_table_has_no_opinion_rather_than_raising():
    """Called on every aircraft in every poll, including before the file has
    downloaded and while GitHub is unreachable."""
    empty = icao_blocks.CodeBlockTable()
    assert empty.lookup("3C6444") is None
    assert len(empty) == 0
    assert empty.allocated == 0


# --- malformed rows ---------------------------------------------------------


def test_unreadable_rows_are_dropped_rather_than_guessed_at():
    """A block with a broken range would claim addresses it has no business
    claiming, and because it would probably be a *narrow* one it would win."""
    rows = parse(
        "ZZZZZZ,3FFFFF,1,000000,FFFFFF,0,XX",   # Start is not hex
        "3FFFFF,3C0000,1,000000,FFFFFF,0,XX",   # Finish before Start
        "1000000,1000000,1,000000,FFFFFF,0,XX",  # outside 24 bits
        ",,,,,,",                                # blank
        DE_ALL,
    )
    assert [b["country"] for b in rows] == ["DE"]


def test_a_truncated_row_loses_its_country_rather_than_reading_a_neighbour():
    """Reading by header name is what makes this safe: DictReader leaves the
    absent fields None, so the row attributes nothing. Read by position it
    would have taken whatever column happened to be at index 6."""
    rows = parse("3C0000,3FFFFF", DE_ALL)
    assert [b["country"] for b in rows] == [None, "DE"]


# --- storage round trip -----------------------------------------------------


def test_the_parsed_document_survives_the_json_round_trip_to_postgres():
    """record_reference serialises to jsonb and warm_reference reads it back, so
    a table rebuilt from storage has to answer exactly as the live one does --
    this is the path a whole day runs on when the boot fetch fails."""
    blocks = parse(*ALL_ROWS)
    restored = icao_blocks.CodeBlockTable(json.loads(json.dumps(blocks)))
    live = icao_blocks.CodeBlockTable(blocks)
    for hexid in ("010070", "010072", "0183EB", "43C123", "500200", "7C0123"):
        assert restored.lookup(hexid) == live.lookup(hexid), hexid


# --- the module-level lookup ------------------------------------------------


def test_install_swaps_the_whole_table_and_lookup_reads_the_current_one():
    original = icao_blocks.current()
    try:
        icao_blocks.install([])
        assert icao_blocks.lookup("0183EB") is None
        icao_blocks.install(parse(*ALL_ROWS))
        assert icao_blocks.lookup("0183EB")["country"] == "LY"
        assert icao_blocks.current().allocated == len(ALL_ROWS) - 2  # the two ZZ rows
    finally:
        icao_blocks.install(original.blocks)
