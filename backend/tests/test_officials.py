"""The Officials & Diplomacy pipeline: the gate, the CAMEO rendering, and the
cross-origin deduplication.

Three things are worth pinning here, all of which have already been wrong once:

  * the gate must admit diplomacy and reject violence, with no row landing in
    both layers;
  * a record must keep saying which origin it came from, because a government's
    own release and a machine-coded wire story are different kinds of evidence;
  * two reports of one act must collapse, including across midnight -- the
    first implementation bucketed by UTC calendar day and silently rendered
    every late-evening statement twice.
"""

from datetime import datetime, timedelta, timezone

from backend.sources import cameo, gdelt, officials
from backend.tests.conftest import gdelt_row, gdelt_row_diplomatic, gdelt_tsv


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M%S")


NOW = datetime(2026, 8, 5, 12, 0, tzinfo=timezone.utc)


def _parsed(builder=gdelt_row_diplomatic, **overrides) -> dict:
    parsed = gdelt._parse_events(gdelt_tsv(builder(**overrides)))
    assert len(parsed) == 1, "fixture row should parse to exactly one event"
    return parsed[0]


# --- the gate --------------------------------------------------------------

def test_a_state_visit_between_governments_is_admitted():
    assert gdelt._is_officials_row(_parsed()) is True


def test_violence_is_rejected_even_when_the_actors_are_governments():
    """An event belongs to exactly one of the two layers. Roots 18/19/20 are
    the conflict layer's, and admitting them here would draw the same strike as
    both a conflict pin and a diplomatic one."""
    strike = _parsed(gdelt_row, actor1_type="GOV", actor1_country="RUS", actor2_country="UKR")
    assert strike["event_root_code"] == 19
    assert gdelt._is_officials_row(strike) is False


def test_the_two_gates_never_both_accept_the_same_row():
    from backend.sources import event_fusion
    for root, code in (("04", "042"), ("13", "138"), ("19", "190"), ("18", "1831")):
        row = _parsed(root_code=root, event_code=code, base_code=code,
                      actor1_type="MIL", actor2_type="MIL")
        assert not (gdelt._is_officials_row(row) and event_fusion._is_violent_gdelt_row(row)), code


def test_a_row_with_no_official_actor_is_rejected():
    """Two companies signing a deal is not a country official doing anything."""
    assert gdelt._is_officials_row(_parsed(actor1_type="BUS", actor2_type="BUS")) is False


def test_a_row_with_no_actor_country_is_rejected():
    """Without it the layer fills with domestic politics from whichever media
    market GDELT indexed most heavily."""
    assert gdelt._is_officials_row(_parsed(actor1_country="", actor2_country="")) is False


def test_an_untrusted_domain_is_rejected():
    """Same rule the news feed applies. An unattributable claim about what a
    president said is worth less than nothing."""
    row = _parsed(source_url="https://daily-content-farm.example/story")
    assert row["source_name"] is None
    assert gdelt._is_officials_row(row) is False


def test_a_party_or_legislature_is_not_a_country_official():
    """CAMEO fills a country code for domestic actors as readily as for foreign
    ones, so admitting PTY/LEG/OPP/JUD filled the layer with national party
    politics rather than statecraft."""
    for actor_type in ("PTY", "LEG", "OPP", "JUD", "BUS", "COP"):
        row = _parsed(actor1_type=actor_type, actor2_type=actor_type)
        assert gdelt._is_officials_row(row) is False, actor_type


def test_one_country_talking_to_itself_is_domestic_politics():
    """A live window produced "Democratic Party praised Michigan (government)"
    and "Bangladesh cooperated diplomatically with Prime Minister" -- both
    coded as diplomacy, neither of them diplomacy."""
    same = _parsed(actor1_country="USA", actor2_country="USA")
    assert gdelt._is_officials_row(same) is False


def test_a_national_actor_with_no_counterpart_is_kept():
    """"Israel (government) threatened the use of force" with no target coded
    is exactly what this layer is for, so a single-actor row must survive."""
    lone = _parsed(actor2="", actor2_type="", actor2_country="",
                   event_code="138", base_code="138", root_code="13")
    assert gdelt._is_officials_row(lone) is True


def test_a_named_domestic_counterpart_is_rejected_even_with_one_country_code():
    """The other half of the same rule: one country code plus a *named* second
    actor is the domestic shape, not the lone-statement shape."""
    row = _parsed(actor1="DEMOCRATIC PARTY", actor1_type="", actor1_country="",
                  actor2="MICHIGAN", actor2_type="GOV", actor2_country="USA")
    assert gdelt._is_officials_row(row) is False


def test_a_named_organisation_counts_as_an_official_actor():
    """CAMEO frequently leaves Type1Code blank for bodies it has a group code
    for, so requiring the type alone drops NATO and the UN."""
    row = _parsed(actor1_type="", actor2_type="", actor1_group="NAT")
    assert gdelt._is_officials_row(row) is True


# --- CAMEO rendering -------------------------------------------------------

def test_a_state_visit_becomes_a_sentence_rather_than_a_code():
    record = officials._normalize_gdelt({
        **_parsed(), "date_added": _stamp(NOW),
        "real_title": None,
    })
    assert record["kind"] == "meeting"
    assert record["label"] == "State visit"
    assert record["summary"] == "Germany (government) visited Ukraine (government)."


def test_the_meeting_family_is_what_the_layer_was_built_for():
    """CAMEO root 04 is quad class 1, which the pipeline used to discard at
    parse time -- so 'president plans to meet another president' could not
    reach the app at all."""
    for code in ("040", "041", "042", "043", "044", "046"):
        assert cameo.diplomatic_kind(code, code, 4) == "meeting"
    assert cameo.diplomatic_kind("036", "036", 3) == "meeting"  # intent to meet


def test_hostile_diplomatic_codes_keep_their_own_kinds():
    assert cameo.diplomatic_kind("138", "138", 13) == "threat"
    assert cameo.diplomatic_kind("163", "163", 16) == "rupture"
    assert cameo.diplomatic_kind("100", "100", 10) == "demand"
    assert cameo.diplomatic_kind("153", "153", 15) == "posture"
    assert cameo.diplomatic_kind("057", "057", 5) == "agreement"


def test_violence_roots_are_not_diplomacy():
    assert cameo.diplomatic_kind("190", "190", 19) is None
    assert cameo.diplomatic_kind("1831", "183", 18) is None


def test_a_dangling_preposition_is_trimmed_when_no_target_was_coded():
    record = officials._normalize_gdelt({
        **_parsed(actor2="", actor2_type="", actor2_country=""),
        "date_added": _stamp(NOW), "real_title": None,
    })
    assert record["summary"] == "Germany (government) visited."


def test_a_real_headline_is_preferred_over_the_coded_label():
    record = officials._normalize_gdelt({
        **_parsed(), "date_added": _stamp(NOW),
        "real_title": "German chancellor arrives in Kyiv for talks",
    })
    assert record["headline"] == "German chancellor arrives in Kyiv for talks"
    assert record["label"] == "State visit"  # still carried, as the fallback


def test_a_gdelt_record_names_the_news_id_it_owns():
    """This is what lets the map draw the story once without the backend having
    to delete it from /api/news."""
    record = officials._normalize_gdelt({**_parsed(), "date_added": _stamp(NOW)})
    assert record["coverage_event_ids"] == ["1400000001"]


# --- press-feed normalisation ---------------------------------------------

def _feed_record(**overrides) -> dict:
    return officials._normalize_feed({
        "id": "kremlin:https://example.gov/a", "government": "Office of the President",
        "country": "Russia", "lat": 55.75, "lon": 37.61,
        "title": "Telephone conversation with the President of Brazil",
        "summary": None, "url": "https://example.gov/a", "kind": "meeting",
        "published_at": NOW.timestamp(), **overrides,
    })


def test_a_press_release_is_marked_as_a_primary_source_at_an_institution():
    record = _feed_record()
    assert record["origin"] == "official_feed"
    # Not "locality": a press release has no location of its own, and the
    # coordinate is the seat of the institution, not the site of any event.
    assert record["geo_precision"] == "institution"


def test_a_press_release_never_counts_as_corroboration_on_its_own():
    """outlet_count is the number of independent newsrooms that carried a
    story. A government publishing its own statement is not one of those, and
    setting this to 1 would let a press release read as corroborated."""
    assert _feed_record()["outlet_count"] == 0


# --- deduplication ---------------------------------------------------------

def _pair(feed_time, gdelt_time, title="Telephone conversation with the President of Brazil"):
    feed = _feed_record(published_at=feed_time.timestamp(), title=title)
    coded = officials._normalize_gdelt({
        **_parsed(event_code="041", base_code="040"),
        "date_added": _stamp(gdelt_time), "real_title": title,
        "outlet_count": 6, "mentions": 9,
    })
    return officials._dedupe([feed, coded])


def test_a_press_release_and_the_wire_story_about_it_become_one_record():
    merged = _pair(NOW, NOW + timedelta(minutes=90))
    assert len(merged) == 1
    kept = merged[0]
    # The primary source wins: it is the one whose attribution is certain.
    assert kept["origin"] == "official_feed"
    # ...but it absorbs the reach of the report it displaced, rather than
    # discarding it.
    assert kept["outlet_count"] == 6
    assert kept["mentions"] == 9
    assert kept["corroborated_by_primary_source"] is True
    # And it inherits the suppressed news id, or the headline reappears as its
    # own News pin.
    assert kept["coverage_event_ids"] == ["1400000001"]


def test_the_merge_survives_midnight():
    """The first implementation bucketed by UTC calendar day, so a call
    published at 23:50 and filed at 00:10 fell on two days and rendered
    twice."""
    late = datetime(2026, 8, 5, 23, 50, tzinfo=timezone.utc)
    assert len(_pair(late, late + timedelta(minutes=20))) == 1


def test_reports_far_enough_apart_in_time_stay_separate():
    """Two calls to the same counterpart on different days are two events."""
    assert len(_pair(NOW, NOW + timedelta(hours=20))) == 2


def test_different_kinds_never_merge_however_similar_the_wording():
    merged = officials._dedupe([
        _feed_record(kind="meeting", title="Minister holds talks on the border crisis"),
        _feed_record(id="x:2", kind="threat", title="Minister holds talks on the border crisis"),
    ])
    assert len(merged) == 2


def test_short_headlines_are_never_merged_on_overlap_alone():
    """"Meeting with the President" and "Meeting with the Chancellor" are 0.67
    similar and describe two different meetings."""
    merged = officials._dedupe([
        _feed_record(title="Meeting with the President"),
        _feed_record(id="x:2", title="Meeting with the Chancellor"),
    ])
    assert len(merged) == 2


def test_unrelated_statements_are_not_collapsed():
    merged = officials._dedupe([
        _feed_record(kind="statement", title="Remarks by the Commissioner on the migration pact"),
        _feed_record(id="x:2", kind="statement",
                     title="Statement on the humanitarian situation in the Sahel"),
    ])
    assert len(merged) == 2


def test_working_state_never_reaches_the_payload():
    """_dedupe caches a token set per record to avoid re-tokenising the same
    headline for every comparison. It is not something the browser should
    receive."""
    for record in officials._dedupe([_feed_record()]):
        assert "_tokens" not in record


# --- ranking ---------------------------------------------------------------

def test_a_governments_own_release_outranks_an_equally_old_single_outlet_report():
    """A press release carries no outlet count by construction, so a rank built
    on reach alone would cut primary sources first -- often precisely when no
    newsroom has picked the statement up yet."""
    now = NOW.timestamp()
    feed = _feed_record(published_at=now)
    coded = officials._normalize_gdelt({
        **_parsed(), "date_added": _stamp(NOW), "outlet_count": 1,
    })
    assert officials._rank(feed, now) > officials._rank(coded, now)


def test_recency_beats_reach_within_the_window():
    now = NOW.timestamp()
    fresh = _feed_record(published_at=now)
    old_and_big = officials._normalize_gdelt({
        **_parsed(), "date_added": _stamp(NOW - timedelta(hours=18)), "outlet_count": 20,
    })
    assert officials._rank(fresh, now) > officials._rank(old_and_big, now)


# --- capital snapping -------------------------------------------------------
#
# Roughly a third of GDELT's diplomatic rows are geocoded only to a country
# centroid -- a point in the geometric middle of a landmass, which is an
# artifact of the geocoder rather than a location. Diplomacy happens in
# capitals, so those rows go there. These pin what must and must not move.

KYIV = {"name": "Kyiv", "country_code": "UA", "lat": 50.4501, "lon": 30.5234,
        "population": 2797553, "geonameid": 703448, "is_capital": True}


def _with_capital(monkeypatch, capital=KYIV):
    monkeypatch.setattr(officials.capitals, "capital_for_fips",
                        lambda code: capital if code == "UP" else None)


def _snapped(monkeypatch, **overrides) -> dict:
    _with_capital(monkeypatch)
    return officials._normalize_gdelt({
        **_parsed(**overrides), "date_added": _stamp(NOW),
    })


def test_a_country_centroid_row_moves_to_the_capital(monkeypatch):
    record = _snapped(monkeypatch, geo_type="1", geo_name="Ukraine",
                      lat="49.0", lon="32.0")
    assert (record["lat"], record["lon"]) == (KYIV["lat"], KYIV["lon"])
    assert record["geo_precision"] == "capital"


def test_a_locality_precision_row_is_left_where_it_is(monkeypatch):
    """Beijing is a real place and strictly better than "the capital of China".
    A summit in Geneva must not be redrawn in Bern."""
    record = _snapped(monkeypatch)  # the fixture geocodes to Kyiv city, type 4
    assert record["geo_precision"] == "locality"
    assert record.get("snapped_to_capital") is None
    assert record.get("anchor") is None


def test_a_snapped_record_says_it_was_moved(monkeypatch):
    """This codebase never asserts a precision it does not have. The popup
    prints "shown at Kyiv, the capital, not where the act took place" off
    exactly these fields."""
    record = _snapped(monkeypatch, geo_type="1", geo_name="Ukraine",
                      lat="49.0", lon="32.0")
    assert record["snapped_to_capital"] is True
    assert record["original_geo_precision"] == "country"
    assert (record["original_lat"], record["original_lon"]) == (49.0, 32.0)
    assert record["anchor"]["id"] == "capital:UA"
    assert record["anchor"]["name"] == "Kyiv"


def test_an_ungeocoded_row_is_snapped_too(monkeypatch):
    record = _snapped(monkeypatch, geo_type="0", geo_name="Ukraine",
                      lat="49.0", lon="32.0")
    assert record["original_geo_precision"] == "unknown"
    assert record["geo_precision"] == "capital"


def test_a_region_precision_row_is_not_snapped_by_default(monkeypatch):
    """GDELT did match an ADM1 here. "Khersons'ka Oblast'" moved to Kyiv is
    worse than the oblast centroid, which is at least inside the place the
    reporting named -- so this is behind OFFICIALS_SNAP_REGION, default off."""
    record = _snapped(monkeypatch, geo_type="5", geo_name="Khersons'ka Oblast', Ukraine",
                      lat="46.9", lon="33.3")
    assert record["geo_precision"] == "region"
    assert (record["lat"], record["lon"]) == (46.9, 33.3)


def test_a_missing_capital_leaves_the_record_alone(monkeypatch):
    """Microstate capitals below GeoNames' own 15,000 floor are not in the
    source file at all. Degrade, never drop."""
    monkeypatch.setattr(officials.capitals, "capital_for_fips", lambda code: None)
    record = officials._normalize_gdelt({
        **_parsed(geo_type="1", geo_name="Ukraine", lat="49.0", lon="32.0"),
        "date_added": _stamp(NOW),
    })
    assert (record["lat"], record["lon"]) == (49.0, 32.0)
    assert record["geo_precision"] == "country"
    assert record.get("anchor") is None


def test_snapping_never_mutates_the_incoming_gdelt_row(monkeypatch):
    """gdelt._fetch routes the SAME dict objects into _ACCUMULATED and
    _ACCUMULATED_OFFICIALS, so a row here can be the very row event_fusion is
    about to read. Writing to it would silently move conflict pins as a side
    effect of a diplomacy fix."""
    _with_capital(monkeypatch)
    row = {**_parsed(geo_type="1", geo_name="Ukraine", lat="49.0", lon="32.0"),
           "date_added": _stamp(NOW)}
    before = dict(row)
    officials._normalize_gdelt(row)
    assert row == before


def test_records_sharing_a_capital_share_an_anchor_id(monkeypatch):
    """The frontend's capital hub groups on this exact string."""
    _with_capital(monkeypatch)
    first = officials._normalize_gdelt({
        **_parsed(event_id="1", geo_type="1", geo_name="Ukraine", lat="49.0", lon="32.0"),
        "date_added": _stamp(NOW),
    })
    second = officials._normalize_gdelt({
        **_parsed(event_id="2", event_code="046", base_code="046",
                  geo_type="1", geo_name="Ukraine", lat="48.0", lon="31.0"),
        "date_added": _stamp(NOW),
    })
    assert first["anchor"]["id"] == second["anchor"]["id"] == "capital:UA"
    assert (first["lat"], first["lon"]) == (second["lat"], second["lon"])


def test_an_official_feed_record_is_never_moved(monkeypatch):
    """Press releases already sit at the seat of the issuing institution, which
    is both correct and a different claim from "this is where it happened"."""
    _with_capital(monkeypatch)
    record = _feed_record()
    assert (record["lat"], record["lon"]) == (55.75, 37.61)
    assert record["geo_precision"] == "institution"
    assert record.get("snapped_to_capital") is None


def test_a_press_release_still_carries_an_anchor_for_the_hub():
    """Every White House statement shares one coordinate by construction. The
    same anchor shape lets the frontend group them without knowing which kind
    of anchor it is looking at."""
    record = _feed_record(feed_key="kremlin")
    assert record["anchor"]["kind"] == "institution"
    assert record["anchor"]["id"] == "institution:kremlin"
