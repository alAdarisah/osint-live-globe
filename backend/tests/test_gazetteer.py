"""Gazetteer: column positions, name folding, ranking, and uncertainty radii.

Same discipline as test_cities.py -- rows are built by column position from the
conftest fixture, so a wrong index in gazetteer.py fails here instead of
silently reading a neighbouring field.
"""

import math

import pytest

from backend.sources import gazetteer as gz
from backend.tests.conftest import geonames_row


def _index(*rows: str, admin1: str = "", admin2: str = "") -> gz.Gazetteer:
    """Build a Gazetteer straight from raw file text, no network."""
    places, alternates = gz.parse_cities("\n".join(rows))
    return gz.build_index(
        places,
        alternates,
        gz.parse_admin_codes(admin1, "ADM1"),
        gz.parse_admin_codes(admin2, "ADM2"),
    )


# --- parsing by position ---------------------------------------------------


def test_columns_are_read_by_position():
    places, _ = gz.parse_cities(geonames_row())
    assert len(places) == 1
    kyiv = places[0]
    assert kyiv.geonameid == 703448
    assert kyiv.name == "Kyiv"
    assert kyiv.country_code == "UA"
    assert kyiv.admin1 == "30"
    assert kyiv.feature_class == "P"
    assert kyiv.feature_code == "PPLC"
    assert kyiv.population == 2797553
    assert kyiv.lat == pytest.approx(50.45466)
    assert kyiv.lon == pytest.approx(30.5238)


def test_rows_without_coordinates_are_skipped():
    places, _ = gz.parse_cities(geonames_row(lat="", lon=""))
    assert places == []


def test_a_missing_population_is_zero_not_a_dropped_row():
    """cities500 carries administrative seats with no population figure.

    Dropping them would remove exactly the small villages this gazetteer exists
    to resolve.
    """
    places, _ = gz.parse_cities(geonames_row(population=""))
    assert len(places) == 1
    assert places[0].population == 0


def test_short_rows_are_skipped_rather_than_raising():
    assert gz.parse_cities("not\ta\trow")[0] == []


# --- name folding ----------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Kyiv", "kyiv"),
        # Modifier letters, not punctuation, to Unicode -- so neither NFKD nor a
        # combining-mark filter strips them. GeoNames uses all three heavily in
        # Slavic and Arabic transliterations.
        ("Lʹviv", "lviv"),      # U+02B9 modifier letter prime
        ("ʻAdrā", "adra"),      # U+02BB modifier letter turned comma
        ("Raʼs al Khaymah", "ras al khaymah"),  # U+02BC modifier letter apostrophe
        ("Khersons'ka Oblast'", "khersonska oblast"),
        ("Al-Ḥudaydah", "al hudaydah"),
        ("N'Djamena", "ndjamena"),
        ("Saint-Denis", "saint denis"),
        ("  Kharkiv  ", "kharkiv"),
        ("", ""),
    ],
)
def test_normalize_folds_diacritics_punctuation_and_case(raw, expected):
    assert gz.normalize(raw) == expected


def test_normalize_leaves_non_latin_scripts_alone():
    """There is nothing to fold in Cyrillic, and inventing a transliteration
    here would produce a key nothing else in the pipeline generates."""
    assert gz.normalize("Херсон") == "херсон"


# --- alternate names -------------------------------------------------------


def test_alternate_names_make_transliterations_resolvable():
    index = _index(
        geonames_row(
            geonameid="706448", name="Kherson", asciiname="Kherson",
            alternatenames="Херсон,Cherson,Chersón,Kherson", lat="46.6354", lon="32.6169",
            feature_code="PPLA", admin1="25", population="283649",
        )
    )
    for surface in ("Kherson", "Херсон", "Cherson"):
        assert index.resolve(surface)[0].place.geonameid == 706448


def test_short_alternate_names_are_not_indexed():
    """GeoNames lists airport and station codes in this column; a three-letter
    key collides across hundreds of unrelated places."""
    index = _index(geonames_row(alternatenames="KBP,IEV,Kiev"))
    assert index.resolve("KBP") == []
    assert index.resolve("Kiev")[0].place.name == "Kyiv"


def test_alternate_name_list_is_capped():
    many = ",".join(f"Longname{i:03d}" for i in range(50))
    _, alternates = gz.parse_cities(geonames_row(alternatenames=many))
    assert len(alternates[703448]) <= gz.MAX_ALTERNATE_NAMES


# --- ranking ---------------------------------------------------------------


def _tripoli_index() -> gz.Gazetteer:
    return _index(
        geonames_row(
            geonameid="2210247", name="Tripoli", asciiname="Tripoli", alternatenames="",
            lat="32.87519", lon="13.18746", feature_code="PPLC", country_code="LY",
            admin1="47", population="1150989",
        ),
        geonames_row(
            geonameid="273820", name="Tripoli", asciiname="Tripoli", alternatenames="",
            lat="34.43671", lon="35.84972", feature_code="PPLA", country_code="LB",
            admin1="04", population="229398",
        ),
    )


def test_an_ambiguous_name_returns_every_candidate():
    """Collapsing "Tripoli" to one point is the failure this module exists to
    stop -- both must come back, and the caller must be able to see the tie."""
    candidates = _tripoli_index().resolve("Tripoli")
    assert {c.place.country_code for c in candidates} == {"LY", "LB"}


def test_a_country_hint_ranks_but_does_not_filter():
    index = _tripoli_index()
    candidates = index.resolve("Tripoli", country_code="LB")
    assert candidates[0].place.country_code == "LB"
    # The wrong-country candidate is still returned: the hint under test is
    # frequently GDELT's own country code, and a filter would make the check
    # unable to disagree with the thing it is checking.
    assert "LY" in {c.place.country_code for c in candidates}


def test_a_country_hint_resolves_the_ambiguity():
    index = _tripoli_index()
    assert index.is_ambiguous(index.resolve("Tripoli")) is True
    assert index.is_ambiguous(index.resolve("Tripoli", country_code="LB")) is False


def test_population_breaks_ties_within_a_country():
    index = _index(
        geonames_row(geonameid="1", name="Springfield", asciiname="Springfield",
                     alternatenames="", country_code="US", admin1="MO",
                     lat="37.21533", lon="-93.29824", feature_code="PPLA2",
                     population="169176"),
        geonames_row(geonameid="2", name="Springfield", asciiname="Springfield",
                     alternatenames="", country_code="US", admin1="IL",
                     lat="39.80172", lon="-89.64371", feature_code="PPLA",
                     population="116565"),
    )
    assert index.resolve("Springfield", country_code="US")[0].place.geonameid == 1


def test_population_tiebreak_never_outranks_a_country_match():
    """A 10M city in the wrong country must not beat a small one in the right
    country -- otherwise the hint stops being evidence at all."""
    index = _index(
        geonames_row(geonameid="1", name="Kharkiv", asciiname="Kharkiv", alternatenames="",
                     country_code="RU", lat="50.0", lon="36.0", feature_code="PPL",
                     population="10000000"),
        geonames_row(geonameid="2", name="Kharkiv", asciiname="Kharkiv", alternatenames="",
                     country_code="UA", lat="49.98081", lon="36.25272", feature_code="PPLA",
                     population="1430885"),
    )
    assert index.resolve("Kharkiv", country_code="UA")[0].place.country_code == "UA"


def test_an_unknown_name_resolves_to_nothing_rather_than_a_guess():
    assert _tripoli_index().resolve("Nowherecity") == []
    assert _tripoli_index().resolve("") == []


def test_a_single_candidate_is_never_ambiguous():
    index = _tripoli_index()
    assert index.is_ambiguous(index.resolve("Tripoli", country_code="LY")) is False


# --- admin divisions -------------------------------------------------------

_ADMIN1_FILE = "UA.65\tKhersons'ka Oblast'\tKhersonska Oblast\t706447\n"
_ADMIN2_FILE = "UA.65.06\tBeryslavs'kyi Raion\tBeryslavskyi Raion\t706500\n"


def test_admin_divisions_become_resolvable():
    """Without the code tables an oblast-level report has no target but the
    country, which is the 400 km circle this whole layer exists to avoid."""
    index = _index(
        geonames_row(geonameid="706448", name="Kherson", asciiname="Kherson",
                     alternatenames="", country_code="UA", admin1="65", admin2="06",
                     lat="46.6354", lon="32.6169", feature_code="PPLA", population="283649"),
        admin1=_ADMIN1_FILE,
        admin2=_ADMIN2_FILE,
    )
    oblast = index.resolve("Khersons'ka Oblast'")
    assert oblast and oblast[0].place.feature_code == "ADM1"
    assert oblast[0].place.country_code == "UA"


def test_a_division_takes_the_population_weighted_centroid_of_its_members():
    index = _index(
        geonames_row(geonameid="1", name="Big", asciiname="Big", alternatenames="",
                     country_code="UA", admin1="65", lat="46.0", lon="32.0",
                     feature_code="PPL", population="900000"),
        geonames_row(geonameid="2", name="Small", asciiname="Small", alternatenames="",
                     country_code="UA", admin1="65", lat="47.0", lon="33.0",
                     feature_code="PPL", population="100000"),
        admin1=_ADMIN1_FILE,
    )
    oblast = index.resolve("Khersons'ka Oblast'")[0].place
    # 0.9 * 46.0 + 0.1 * 47.0
    assert oblast.lat == pytest.approx(46.1)
    assert oblast.lon == pytest.approx(32.1)
    assert oblast.population == 1_000_000


def test_a_division_with_no_member_places_is_dropped_not_placed_at_null_island():
    index = _index(geonames_row(), admin1="ZZ.99\tEmptyland\tEmptyland\t999999\n")
    assert index.resolve("Emptyland") == []


def test_admin_code_rows_that_are_too_short_are_skipped():
    assert gz.parse_admin_codes("UA.65\tKherson\n", "ADM1") == []


# --- uncertainty radii -----------------------------------------------------


def test_radius_grows_with_settlement_size_but_sublinearly():
    small = gz.radius_km_for("PPL", 10_000)
    big = gz.radius_km_for("PPL", 10_000_000)
    assert small < big
    assert big < 1000 * small  # a 1000x population is nothing like a 1000x radius


def test_radius_is_clamped_at_both_ends():
    assert gz.radius_km_for("PPL", 1) >= gz._POP_RADIUS_MIN_KM
    assert gz.radius_km_for("PPL", 40_000_000) <= gz._POP_RADIUS_MAX_KM


def test_a_populated_place_with_no_population_still_gets_a_small_radius():
    assert 0 < gz.radius_km_for("PPL", 0) < 10


def test_administrative_and_country_radii_are_ordered_by_containment():
    """A pin is only as precise as the smallest thing that certainly contains
    it, so these must never invert."""
    assert (
        gz.radius_km_for("PPLA", 250_000)
        < gz.radius_km_for("ADM2")
        < gz.radius_km_for("ADM1")
        < gz.radius_km_for("PCLI")
    )


def test_an_unknown_feature_code_is_treated_as_imprecise_not_precise():
    assert gz.radius_km_for("XYZ") >= gz.radius_km_for("ADM2")


def test_country_radius_falls_back_to_the_constant_with_no_countries_loaded():
    assert gz.country_radius_km("UA") == gz._COUNTRY_RADIUS_KM
    assert gz.country_radius_km("") == gz._COUNTRY_RADIUS_KM


def test_country_radius_reads_natural_earth_geometry_when_present(monkeypatch):
    from backend.cache import SourceState

    state = SourceState(name="countries", key_configured=True)
    state.data = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {"ISO_A2": "UA"},
            "geometry": {"type": "Polygon", "coordinates": [[
                [22.0, 44.0], [40.0, 44.0], [40.0, 52.0], [22.0, 52.0], [22.0, 44.0],
            ]]},
        }],
    }
    monkeypatch.setattr(gz.registry, "has", lambda name: name == "countries")
    monkeypatch.setattr(gz.registry, "get", lambda name: state)

    radius = gz.country_radius_km("UA")
    # Ukraine's bbox is roughly 890 km tall and 1440 km wide at mid-latitude;
    # half that diagonal is ~845 km, and far more than the blunt default.
    assert radius > gz._COUNTRY_RADIUS_KM
    assert math.isfinite(radius)


# --- cold start ------------------------------------------------------------


def test_a_cold_gazetteer_has_no_opinion_rather_than_raising():
    """Before the first refresh every caller must get "no candidates", never an
    exception -- placement degrades to leaving the upstream coordinate alone."""
    empty = gz.Gazetteer([])
    assert len(empty) == 0
    assert empty.resolve("Kherson") == []
    assert empty.is_ambiguous([]) is False
