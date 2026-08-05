"""Placement reconciliation: when a pin may move, and when it must not.

Every test here is a claim about a pin a reader would otherwise have believed.
The bias throughout is that failing to improve a coordinate is cheap and moving
one to the wrong place is not, so most of these pin down refusals.
"""

import pytest

from backend.sources import gazetteer as gz
from backend.sources import geoverify as gv
from backend.tests.conftest import geonames_row


# --- a small real gazetteer ------------------------------------------------
#
# Coordinates are the real ones so distances in the assertions are real
# distances: Kherson->Kyiv is ~400 km, Kherson->Mykolaiv ~55 km.

_ROWS = [
    geonames_row(geonameid="703448", name="Kyiv", asciiname="Kyiv", alternatenames="Kiev",
                 country_code="UA", admin1="30", lat="50.45466", lon="30.5238",
                 feature_code="PPLC", population="2797553"),
    geonames_row(geonameid="706448", name="Kherson", asciiname="Kherson",
                 alternatenames="Херсон,Cherson", country_code="UA", admin1="65",
                 lat="46.6354", lon="32.6169", feature_code="PPLA", population="283649"),
    geonames_row(geonameid="700569", name="Mykolaiv", asciiname="Mykolaiv",
                 alternatenames="Nikolayev", country_code="UA", admin1="14",
                 lat="46.96591", lon="31.9974", feature_code="PPLA", population="480000"),
    geonames_row(geonameid="702550", name="Lviv", asciiname="Lviv", alternatenames="Lvov",
                 country_code="UA", admin1="06", lat="49.83826", lon="24.02324",
                 feature_code="PPLA", population="717803"),
    # Two Tripolis, so ambiguity is testable rather than hypothetical.
    geonames_row(geonameid="2210247", name="Tripoli", asciiname="Tripoli", alternatenames="",
                 country_code="LY", admin1="47", lat="32.87519", lon="13.18746",
                 feature_code="PPLC", population="1150989"),
    geonames_row(geonameid="273820", name="Tripoli", asciiname="Tripoli", alternatenames="",
                 country_code="LB", admin1="04", lat="34.43671", lon="35.84972",
                 feature_code="PPLA", population="229398"),
]

_ADMIN1 = "UA.65\tKhersons'ka Oblast'\tKhersonska Oblast\t706447\n"


@pytest.fixture
def index() -> gz.Gazetteer:
    places, alternates = gz.parse_cities("\n".join(_ROWS))
    return gz.build_index(places, alternates, gz.parse_admin_codes(_ADMIN1, "ADM1"), [])


def _row(**overrides) -> dict:
    """A GDELT conflict row as it reaches reconciliation.

    `geo_country_code` is FIPS 10-4, not ISO -- "UP" is Ukraine. Using the real
    code here is what exercises the crosswalk rather than assuming it away.
    """
    return {
        "lat": 46.6354, "lon": 32.6169,
        "geo_precision": "locality",
        "geo_country_code": "UP",
        "real_title": "Strike on Kherson market kills three",
        "article_excerpt": "Russian forces struck a market in Kherson on Tuesday.",
        "dateline_place": None,
        # The default row was read from an allowlisted newsroom. Rows scraped
        # from anywhere else are covered explicitly below.
        "article_trusted": True,
        **overrides,
    }


# --- candidate extraction --------------------------------------------------


def test_candidate_names_pulls_capitalised_runs_in_order():
    names = gv.candidate_names("Russian forces struck Kherson and later New York Mills.")
    assert "Kherson" in names
    assert names.index("Kherson") < names.index("New York Mills")


def test_candidate_names_drops_runs_that_are_entirely_stopwords():
    """"Israeli forces" must not be read as a report from a town called
    Israeli; "Monday" is a day far more often than a settlement."""
    names = gv.candidate_names("Monday. The Forces and The Government met.")
    assert "Monday" not in names
    assert "The Government" not in names


def test_candidate_names_keeps_runs_that_merely_start_with_a_stopword():
    assert "New York" in gv.candidate_names("Reported from New York today.")


def test_candidate_names_handles_accented_capitals():
    assert "Ḩalab" in gv.candidate_names("Fighting reached Ḩalab overnight.")


def test_candidate_names_is_capped_and_deduplicated():
    text = " ".join(f"Placename{i:03d}" for i in range(60))
    names = gv.candidate_names(text)
    assert len(names) <= gv.MAX_CANDIDATE_NAMES
    assert len(names) == len(set(names))


def test_a_place_in_the_middle_of_a_capitalised_run_is_still_found():
    """A title-cased headline puts the place between two other capitals. A scan
    that only took prefixes of a run would never ask about it -- which is the
    common case, not an edge case."""
    assert "Kherson" in gv.candidate_names("Strike On Kherson Market Kills Three")


def test_longer_forms_come_before_their_own_fragments():
    """The longest window is what the text actually said; the shorter ones are
    fallbacks for a gazetteer that does not carry it."""
    names = gv.candidate_names("Fighting reached New York Mills overnight.")
    assert names.index("New York Mills") < names.index("New York")


def test_a_comma_ends_a_name():
    """"Kherson, Khersons'ka Oblast', Ukraine" is three places, not one."""
    names = gv.candidate_names("Kherson, Ukraine saw shelling.")
    assert "Kherson" in names
    assert "Kherson Ukraine" not in names


def test_a_connector_only_joins_when_a_name_follows_it():
    """"Isle of Man" is a place; "Isle of" is a dangling fragment."""
    names = gv.candidate_names("They sailed to the Isle of Man yesterday.")
    assert "Isle of Man" in names
    assert "Isle of" not in names


def test_a_fragment_of_an_already_resolved_name_is_not_resolved_again(index):
    """Otherwise "New York Mills" resolving would still leave "New York" free to
    resolve separately and compete with it for the pin."""
    resolved = gv._resolve_text_places(
        gv.candidate_names("Shelling struck Kherson overnight."), "UA", index
    )
    assert [name for name, _ in resolved] == ["Kherson"]


# --- confirmed -------------------------------------------------------------


def test_a_pin_on_the_place_the_report_names_is_confirmed(index):
    result = gv.reconcile(_row(), index)
    assert result["geo_verdict"] == gv.CONFIRMED
    assert result["geo_text_place"] == "Kherson"
    assert result["geo_confidence"] > 80
    # Confirmation must never relocate anything.
    assert "lat" not in result and "original_lat" not in result


def test_confirmation_narrows_the_uncertainty_ring_to_the_place_itself(index):
    result = gv.reconcile(_row(), index)
    assert result["geo_radius_km"] < gv._PRECISION_RADIUS_KM["locality"]


def test_a_transliteration_in_the_text_still_confirms(index):
    result = gv.reconcile(
        _row(real_title="Удар по Херсону", article_excerpt="Обстріл Херсон у вівторок."), index
    )
    assert result["geo_verdict"] == gv.CONFIRMED


# --- refined ---------------------------------------------------------------


def test_a_country_centroid_is_upgraded_to_the_locality_the_report_names(index):
    """The upgrade this whole layer exists for: 33.7% of measured rows sit on a
    national centroid, and most of their articles name a town."""
    result = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country"), index
    )
    assert result["geo_verdict"] == gv.REFINED
    assert result["geo_precision"] == "locality"
    assert result["lat"] == pytest.approx(46.6354)
    assert result["lon"] == pytest.approx(32.6169)


def test_a_refinement_records_where_the_pin_came_from(index):
    result = gv.reconcile(_row(lat=49.0, lon=32.0, geo_precision="region"), index)
    assert result["original_lat"] == 49.0
    assert result["original_lon"] == 32.0
    assert result["original_geo_precision"] == "region"


def test_a_refinement_never_crosses_a_border(index):
    """GDELT says Libya; the text names Tripoli, Lebanon. Moving the pin to
    another country on the strength of a name collision is exactly the failure
    the country scope exists to prevent."""
    result = gv.reconcile(
        _row(lat=27.0, lon=17.0, geo_precision="country", geo_country_code="LY",
             real_title="Clashes reported in Tripoli",
             article_excerpt="Fighting was reported in Tripoli on Tuesday."),
        index,
    )
    # Scoped to Libya, "Tripoli" resolves unambiguously to the Libyan one, so
    # the refinement is allowed -- but it stays in Libya.
    if result["geo_verdict"] == gv.REFINED:
        assert result["lon"] == pytest.approx(13.18746)


def test_an_ambiguous_name_never_moves_a_pin(index):
    """With no country hint, "Tripoli" is two cities. Picking one would be the
    single worst thing this module could do."""
    result = gv.reconcile(
        _row(lat=27.0, lon=17.0, geo_precision="country", geo_country_code="",
             real_title="Clashes reported in Tripoli",
             article_excerpt="Fighting was reported in Tripoli on Tuesday."),
        index,
    )
    assert result["geo_verdict"] == gv.UNVERIFIED
    assert "lat" not in result


def test_an_untrusted_article_may_still_refine_a_centroid(index):
    """Gating this on the outlet allowlist was tried and made the layer inert:
    close to zero conflict rows carry an allowlisted article, so the 30% of pins
    on national centroids simply stayed there. Whether a page named a town
    correctly is a different question from whether we vouch for its claims."""
    result = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country", article_trusted=False), index
    )
    assert result["geo_verdict"] == gv.REFINED
    assert result["lat"] == pytest.approx(46.6354)


def test_provenance_is_priced_into_confidence_rather_than_vetoing_the_move(index):
    trusted = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country", article_trusted=True), index
    )
    untrusted = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country", article_trusted=False), index
    )
    assert trusted["geo_verdict"] == untrusted["geo_verdict"] == gv.REFINED
    assert untrusted["geo_confidence"] < trusted["geo_confidence"]


def test_an_untrusted_article_may_still_cast_doubt(index):
    """Doubt is the recoverable direction. A confident pin in the wrong place is
    not, which is why only the first is open to any newsroom."""
    result = gv.reconcile(
        _row(lat=49.83826, lon=24.02324, article_trusted=False), index
    )
    assert result["geo_verdict"] == gv.CONTESTED
    assert result["geo_confidence"] < 40


def test_a_locality_pin_is_never_refined_by_a_distant_name(index):
    """Precision may only go up. A pin GDELT already placed on a town is not
    relocated because the article also mentions Lviv."""
    result = gv.reconcile(
        _row(real_title="Kherson strike prompts response",
             article_excerpt="Officials in Lviv condemned the attack."),
        index,
    )
    assert "lat" not in result
    assert result["geo_verdict"] in (gv.CONFIRMED, gv.CONTESTED)


# --- contested -------------------------------------------------------------


def test_a_pin_far_from_the_named_place_is_contested_not_moved(index):
    """We know the geocode is doubtful. We do not know what is right -- the
    article names one place and GDELT chose another, and neither is evidence
    enough to relocate a locality-precision pin."""
    result = gv.reconcile(
        _row(lat=49.83826, lon=24.02324,  # the pin is on Lviv
             real_title="Strike on Kherson market kills three",
             article_excerpt="Russian forces struck a market in Kherson on Tuesday."),
        index,
    )
    assert result["geo_verdict"] == gv.CONTESTED
    assert "lat" not in result
    assert result["geo_confidence"] < 40


def test_an_article_naming_scattered_places_contradicts_nothing(index):
    """A round-up or an analysis piece names somewhere in six provinces. Read as
    a claim about location it makes every pin look wrong -- measured, that alone
    put two thirds of all rows into "contested"."""
    result = gv.reconcile(
        _row(lat=46.6354, lon=32.6169,
             real_title="A year of the war",
             article_excerpt=("Fighting has touched Lviv, Kyiv and Mykolaiv "
                              "at different points in the campaign.")),
        index,
    )
    assert result["geo_verdict"] == gv.UNVERIFIED
    assert "lat" not in result


def test_naming_the_pins_own_city_confirms_even_alongside_others(index):
    """A piece that names both the pin's city and somewhere else is
    corroborating the pin, not contradicting itself."""
    result = gv.reconcile(
        _row(real_title="Strike on Kherson market kills three",
             article_excerpt=("Officials in Lviv condemned the strike on "
                              "Kherson that killed three people.")),
        index,
    )
    assert result["geo_verdict"] == gv.CONFIRMED
    assert result["geo_text_place"] == "Kherson"


def test_the_first_place_named_is_the_articles_claim_not_the_smallest(index):
    """Ranking by specificity was the first thing tried here and was wrong: a
    passing mention of a small village outranked the city the piece was about,
    purely because the village is smaller."""
    result = gv.reconcile(
        _row(lat=50.45466, lon=30.5238,  # pin on Kyiv
             real_title="Mykolaiv shelled overnight",
             article_excerpt="Shelling struck Mykolaiv overnight, officials said."),
        index,
    )
    assert result["geo_text_place"] == "Mykolaiv"


def test_a_contested_ring_covers_both_claims(index):
    result = gv.reconcile(
        _row(lat=49.83826, lon=24.02324,
             article_excerpt="Russian forces struck a market in Kherson on Tuesday."),
        index,
    )
    assert result["geo_radius_km"] > gv.CONTEST_KM


# --- dateline --------------------------------------------------------------


def test_an_article_naming_only_its_dateline_is_suspect(index):
    """"KYIV (Reuters) - Officials said..." geocoded to Kyiv is a pin on the
    reporter's desk."""
    result = gv.reconcile(
        _row(lat=50.45466, lon=30.5238, geo_precision="locality",
             real_title="Officials condemn overnight attacks",
             article_excerpt="KYIV, Aug 5 (Reuters) - Officials condemned the attacks.",
             dateline_place="KYIV"),
        index,
    )
    assert result["geo_verdict"] == gv.DATELINE_SUSPECT
    assert result["geo_confidence"] < 20
    assert "lat" not in result


def test_a_dateline_is_ignored_when_the_article_names_somewhere_else(index):
    """A dispatch filed from Kyiv about Kherson is the normal case, and must
    still confirm a Kherson pin."""
    result = gv.reconcile(
        _row(real_title="Strike on Kherson market kills three",
             article_excerpt="KYIV, Aug 5 (Reuters) - Forces struck a market in Kherson.",
             dateline_place="KYIV"),
        index,
    )
    assert result["geo_verdict"] == gv.CONFIRMED
    assert result["geo_text_place"] == "Kherson"


def test_a_dateline_only_article_never_refines_an_imprecise_pin(index):
    """Upgrading a country centroid to the filing city would manufacture
    precision out of the newsroom's address."""
    result = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country",
             real_title="Officials condemn overnight attacks",
             article_excerpt="KYIV, Aug 5 (Reuters) - Officials condemned the attacks.",
             dateline_place="KYIV"),
        index,
    )
    assert result["geo_verdict"] == gv.DATELINE_SUSPECT
    assert "lat" not in result


# --- unverified ------------------------------------------------------------


def test_a_row_that_was_never_scraped_is_unverified(index):
    """Today's behaviour, unchanged: no text, no opinion."""
    row = _row()
    del row["article_excerpt"]
    result = gv.reconcile(row, index)
    assert result["geo_verdict"] == gv.UNVERIFIED
    assert "lat" not in result


def test_a_scraped_row_with_no_body_is_still_unverified(index):
    result = gv.reconcile(_row(real_title=None, article_excerpt=None), index)
    assert result["geo_verdict"] == gv.UNVERIFIED


def test_text_naming_only_a_country_confirms_nothing(index):
    """Agreeing about "Ukraine" says exactly what geo_precision already said."""
    result = gv.reconcile(
        _row(lat=49.0, lon=32.0, geo_precision="country",
             real_title="Fighting continues", article_excerpt="Fighting continued across Ukraine."),
        index,
    )
    assert result["geo_verdict"] == gv.UNVERIFIED
    assert "lat" not in result


def test_an_unverified_country_row_still_reports_a_country_sized_ring(index):
    result = gv.reconcile(
        _row(geo_precision="country", real_title=None, article_excerpt=None), index
    )
    assert result["geo_radius_km"] == gv._PRECISION_RADIUS_KM["country"]
    assert result["geo_confidence"] == gv._PRECISION_CONFIDENCE["country"]


def test_a_row_with_no_coordinates_is_handled_rather_than_raising(index):
    assert gv.reconcile(_row(lat=None, lon=None), index)["geo_verdict"] == gv.UNVERIFIED


def test_a_cold_gazetteer_leaves_every_pin_alone():
    """Before the first refresh there is nothing to check against, and "no
    opinion" is the only honest verdict."""
    result = gv.reconcile(_row(), gz.Gazetteer([]))
    assert result["geo_verdict"] == gv.UNVERIFIED
    assert "lat" not in result


# --- the invariants everything else rests on -------------------------------


def test_reconcile_never_mutates_the_row_it_is_given(index):
    """The dict handed in is the same object gdelt.py holds in its accumulator;
    mutating it would rewrite the archive's record of what GDELT said."""
    row = _row(lat=49.0, lon=32.0, geo_precision="country")
    before = dict(row)
    gv.reconcile(row, index)
    assert row == before


def test_every_verdict_carries_a_confidence_a_radius_and_a_reason(index):
    """A missing key cannot distinguish "not checked" from "checked, nothing
    found", so every path returns the full set."""
    rows = [
        _row(),
        _row(lat=49.0, lon=32.0, geo_precision="country"),
        _row(lat=49.83826, lon=24.02324),
        _row(real_title=None, article_excerpt=None),
        _row(lat=50.45466, lon=30.5238, article_excerpt="KYIV — Officials spoke.",
             real_title="Officials spoke", dateline_place="KYIV"),
    ]
    for row in rows:
        result = gv.reconcile(row, index)
        assert set(result) >= {"geo_verdict", "geo_confidence", "geo_radius_km", "geo_reason"}
        assert 0 <= result["geo_confidence"] <= 100
        assert result["geo_radius_km"] > 0


def test_precision_only_ever_improves(index):
    """No verdict may replace a locality coordinate with a coarser one."""
    for verdict_row in (
        _row(),
        _row(real_title="Kherson strike", article_excerpt="Officials in Lviv condemned it."),
        _row(article_excerpt="Fighting continued across Ukraine."),
    ):
        result = gv.reconcile(verdict_row, index)
        assert result.get("geo_precision", "locality") == "locality"
