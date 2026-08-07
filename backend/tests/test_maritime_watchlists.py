"""What the OpenSanctions maritime collection is allowed to claim about a hull.

The parsing is the small half. The half worth testing is the taxonomy: this
file mixes a legal designation, a port-state detention for deficient lifeboats,
and an accusation published by a belligerent state's military intelligence
service, and it mixes them in one column of semicolon-joined tokens with no
dates on anything. Presented as one "flagged" badge that is three lies at once.

So the assertions below are mostly about what must *not* happen -- a company
IMO must not become a hull annotation, an allegation must not read as a
designation, and the dataset that made a claim must survive all the way onto
the record a popup renders.
"""

from backend.sources import maritime_watchlists as mw

HEADER = "type,caption,imo,risk,countries,flag,mmsi,id,url,datasets,aliases"


def row(
    type_="VESSEL",
    caption="BOUDREAUX TIDE",
    imo="IMO9427366",
    risk="mare.detained;reg.warn",
    countries="vu",
    flag="vu",
    mmsi="",
    id_="abuja-mou-det-0059aae8",
    url="https://www.opensanctions.org/entities/abuja-mou-det-0059aae8/",
    datasets="abuja_mou_detention",
    aliases="",
) -> str:
    fields = [type_, caption, imo, risk, countries, flag, mmsi, id_, url, datasets, aliases]
    return ",".join(f'"{f}"' for f in fields)


def csv(*rows: str) -> str:
    return "\n".join((HEADER, *rows))


def index(*rows: str) -> mw.WatchlistIndex:
    return mw.WatchlistIndex(mw.parse_maritime(csv(*rows)))


# --- what gets in ----------------------------------------------------------


def test_organization_rows_are_dropped_because_their_imo_is_a_company_imo():
    """2,722 of the file's 23,050 rows. The publisher's own manifest warns that
    `imo` means a different registry on these, so keeping them would annotate a
    hull with whatever shipping company shares its seven digits."""
    entries = mw.parse_maritime(csv(
        row(type_="ORGANIZATION", caption="SOME SHIPPING LLC", imo="IMO1234567"),
        row(),
    ))
    assert [e["name"] for e in entries] == ["BOUDREAUX TIDE"]
    assert index(
        row(type_="ORGANIZATION", caption="SOME SHIPPING LLC", imo="IMO1234567"),
    ).for_vessel(imo="1234567") is None


def test_the_imo_prefix_is_normalised_off_both_sides_of_the_lookup():
    """The file writes "IMO9427366"; AIS broadcasts 9427366. A key that only
    matches when the two happen to agree on formatting never fires at all."""
    (entry,) = mw.parse_maritime(csv(row(imo="IMO9427366")))
    assert entry["imo"] == "9427366"

    hits = index(row(imo="IMO9427366"))
    assert hits.for_vessel(imo="9427366")["matched_on"] == "imo"
    assert hits.for_vessel(imo="IMO9427366")["matched_on"] == "imo"
    assert hits.for_vessel(imo=9427366)["matched_on"] == "imo"


def test_a_number_that_is_not_seven_digits_is_not_an_imo():
    assert mw.normalize_imo("IMO123456") is None
    assert mw.normalize_imo("IMO123456789") is None, "an 8+ digit number must not be truncated to 7"
    assert mw.normalize_imo("") is None
    assert mw.normalize_imo(None) is None


def test_a_row_with_no_imo_and_no_mmsi_is_dropped_as_unmatchable():
    """There is not one call sign in this file, so a row with neither number
    cannot be reached by any lookup this map can perform. Keeping it would
    inflate the hull count with entries nothing can ever match."""
    entries = mw.parse_maritime(csv(row(imo="", mmsi=""), row()))
    assert [e["name"] for e in entries] == ["BOUDREAUX TIDE"]


def test_a_row_with_only_an_mmsi_is_still_reachable_by_it():
    """~800 vessel rows carry no IMO. MMSI is the weaker key -- it is reissued
    when a ship changes flag -- and the match says so."""
    hits = index(row(caption="NO IMO HERE", imo="", mmsi="636014321"))
    hit = hits.for_vessel(mmsi="636014321")
    assert hit["listed_as"] == "NO IMO HERE"
    assert hit["matched_on"] == "mmsi"


def test_imo_wins_over_mmsi_when_a_caller_supplies_both():
    hits = index(
        row(caption="BY IMO", imo="IMO9427366", mmsi="", id_="a"),
        row(caption="BY MMSI", imo="", mmsi="636014321", id_="b"),
    )
    assert hits.for_vessel(imo="9427366", mmsi="636014321")["listed_as"] == "BY IMO"


# --- the evidence taxonomy -------------------------------------------------


def test_a_multi_token_risk_value_keeps_every_token_it_was_given():
    (entry,) = mw.parse_maritime(csv(row(risk="mare.detained;reg.warn")))
    assert entry["risk"] == ["mare.detained", "reg.warn"]


def test_a_port_state_detention_is_a_state_action_not_a_designation():
    """6,488 hulls beyond OFAC arrive this way, and most of them are lifeboat
    and crew-wage deficiencies. Drawn as a designation they would swamp the 452
    hulls that actually are one."""
    hit = index(row(risk="mare.detained;reg.warn")).for_vessel(imo="9427366")
    assert hit["evidence"] == mw.STATE_ACTION
    assert hit["evidence_classes"] == [mw.STATE_ACTION]
    assert "port state" in hit["evidence_note"].lower()


def test_a_sanction_token_is_a_designation():
    hit = index(row(risk="sanction", datasets="eu_sanctions_map")).for_vessel(imo="9427366")
    assert hit["evidence"] == mw.DESIGNATION
    assert "designated" in hit["evidence_note"].lower()


def test_a_shadow_fleet_row_is_an_allegation_and_names_who_alleges_it():
    """The single most important assertion in this file. `mare.shadow` and `poi`
    come only from ua_war_sanctions, published by Ukraine's military
    intelligence directorate -- a named and interested author accusing hulls
    belonging to the state it is at war with. That may well be correct. It is
    not a listing, and the reader has to be able to tell."""
    hit = index(row(
        caption="SHADOW HULL",
        risk="mare.shadow;poi",
        datasets="ua_war_sanctions",
        url="https://www.opensanctions.org/entities/NK-abc123/",
    )).for_vessel(imo="9427366")

    assert hit["evidence"] == mw.ALLEGATION
    assert "alleges" in hit["evidence_note"].lower()
    assert "No listing authority has acted on it." in hit["evidence_note"]

    # The raw dataset id, which is the attribution the file itself carries.
    assert hit["datasets"] == ["ua_war_sanctions"]
    (listing,) = hit["listings"]
    assert listing["datasets"] == ["ua_war_sanctions"]
    assert listing["risk"] == ["mare.shadow", "poi"]
    # And who that id belongs to, resolved for the popup.
    (publisher,) = listing["publishers"]
    assert "Ukraine" in publisher
    assert "Intelligence" in publisher


def test_the_strongest_claim_heads_a_hull_without_hiding_the_weaker_ones():
    """A tanker detained by a port state and separately accused by an
    intelligence service carries two claims from two authors. The headline is
    the stronger one; losing the other would lose which of them said what."""
    hits = index(
        row(risk="mare.detained", datasets="abuja_mou_detention", id_="a"),
        row(risk="sanction", datasets="eu_sanctions_map", id_="b"),
        row(risk="mare.shadow", datasets="ua_war_sanctions", id_="c"),
    )
    hit = hits.for_vessel(imo="9427366")
    assert hit["evidence"] == mw.DESIGNATION
    assert hit["evidence_classes"] == [mw.DESIGNATION, mw.STATE_ACTION, mw.ALLEGATION]
    assert hit["listing_count"] == 3
    assert [listing["evidence"] for listing in hit["listings"]] == [
        mw.STATE_ACTION, mw.DESIGNATION, mw.ALLEGATION
    ]
    # Each claim keeps its own author rather than being pooled into one bag.
    assert [listing["datasets"] for listing in hit["listings"]] == [
        ["abuja_mou_detention"], ["eu_sanctions_map"], ["ua_war_sanctions"]
    ]


def test_a_risk_token_this_map_does_not_know_is_labelled_rather_than_guessed():
    """OpenSanctions adds tokens between releases. An unrecognised one must not
    silently inherit the meaning of whichever class it sorts next to."""
    hit = index(row(risk="some.new.token")).for_vessel(imo="9427366")
    assert hit["evidence"] == mw.UNCLASSIFIED
    assert hit["risk"] == ["some.new.token"]
    hit_no_risk = index(row(imo="IMO9260892", risk="")).for_vessel(imo="9260892")
    assert hit_no_risk["evidence"] == mw.UNCLASSIFIED


def test_every_evidence_class_ships_a_sentence_saying_what_it_claims():
    """A badge with no sentence behind it is the failure this whole taxonomy
    exists to avoid, so the renderer cannot be handed a class it has no words
    for."""
    for cls in (mw.DESIGNATION, mw.STATE_ACTION, mw.ALLEGATION, mw.UNCLASSIFIED):
        assert mw.EVIDENCE_MEANING[cls].strip()


# --- caveats that travel with the match ------------------------------------


def test_every_match_says_the_list_does_not_date_its_entries():
    """A 2013 Paris MoU ban and a designation made this week are the same row
    here. Silence about that would let recency be assumed."""
    hit = index(row()).for_vessel(imo="9427366")
    assert hit["undated"] is True


def test_attribution_travels_on_the_match_not_only_in_a_comment():
    """CC BY-NC 4.0 makes attribution a condition, and the condition is about
    what gets shown."""
    hit = index(row()).for_vessel(imo="9427366")
    assert hit["source"] == mw.SOURCE_NAME
    assert hit["licence"] == "CC BY-NC 4.0"
    assert hit["source_url"].startswith("https://www.opensanctions.org/")


def test_a_publisher_falls_back_to_the_id_rather_than_to_a_guess():
    assert mw.publisher_for("ua_war_sanctions").startswith("War&Sanctions")
    assert mw.publisher_for("abuja_mou_detention") == "Abuja MoU on Port State Control"
    assert mw.publisher_for("black_sea_mou_inspections") == "Black Sea MoU on Port State Control"
    # Unknown, and not pretended otherwise: the id itself, made readable.
    assert mw.publisher_for("some_new_dataset") == "some new dataset"


# --- merging ---------------------------------------------------------------


def test_rows_are_merged_per_hull_because_20328_rows_describe_9150_ships():
    entries = mw.parse_maritime(csv(
        row(id_="a", datasets="abuja_mou_detention"),
        row(id_="b", datasets="tokyo_mou_detention"),
    ))
    assert len(entries) == 1
    assert entries[0]["datasets"] == ["abuja_mou_detention", "tokyo_mou_detention"]
    assert entries[0]["listing_count"] == 2


def test_a_hull_listed_under_a_second_name_keeps_the_first_as_an_alias():
    """Renaming is the whole game -- a hull that appears under two captions is
    the case worth surfacing, not a duplicate to collapse."""
    entries = mw.parse_maritime(csv(
        row(caption="BOUDREAUX TIDE", id_="a"),
        row(caption="FORMER NAME", id_="b", aliases="OLDER NAME"),
    ))
    (entry,) = entries
    assert entry["name"] == "BOUDREAUX TIDE"
    assert set(entry["aliases"]) == {"FORMER NAME", "OLDER NAME"}


def test_a_hull_with_a_long_history_reports_the_count_it_truncated_to():
    """A truncated list presented as complete is worse than a short one that
    says so."""
    rows = [row(id_=f"det-{i}", datasets=f"mou_{i}") for i in range(20)]
    (entry,) = mw.parse_maritime(csv(*rows))
    assert entry["listing_count"] == 20
    assert len(entry["listings"]) == mw.MAX_LISTINGS_PER_HULL


# --- the empty index -------------------------------------------------------


def test_an_empty_index_has_no_opinion_rather_than_raising():
    """Called on every AIS position report, including before the 5 MB file has
    downloaded and while OpenSanctions is unreachable."""
    empty = mw.WatchlistIndex()
    assert empty.for_vessel(imo="9427366") is None
    assert empty.for_vessel(mmsi="636014321") is None
    assert empty.for_vessel() is None
    assert len(empty) == 0
