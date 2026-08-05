"""The FIPS/ISO crosswalk and the one-capital-per-country rule.

The crosswalk is the highest-risk table in this change: one wrong row teleports
an entire country's diplomacy, silently and plausibly. These pin the codes that
are actively dangerous -- the pairs where a naive join produces a real but wrong
country rather than no country at all.
"""

from backend.sources import capitals

from .conftest import geonames_row


def _index(*rows: str) -> dict:
    """Build the capital index directly from parsed GeoNames rows.

    Bypasses the registry: this is a pure-function test and capitals.py's own
    caching is keyed on a registry version it must not need here.
    """
    from backend.sources.cities import _parse_cities
    return capitals._build_index(_parse_cities("\n".join(rows)))


# --- the crosswalk ---------------------------------------------------------

def test_fips_and_iso2_disagree_for_the_countries_that_matter():
    """AU is Austria in FIPS 10-4 and Australia in ISO 3166-1.

    A join that assumes the two-letter codes match does not fail loudly -- it
    files Vienna's diplomacy in Canberra, forever, for every Austrian event.
    Every pair below is one where the wrong answer is a real country.
    """
    assert capitals.to_iso2("AU") == "AT"   # Austria, NOT Australia
    assert capitals.to_iso2("AS") == "AU"   # Australia, NOT American Samoa
    assert capitals.to_iso2("GM") == "DE"   # Germany, NOT Gambia
    assert capitals.to_iso2("GA") == "GM"   # Gambia
    assert capitals.to_iso2("UK") == "GB"   # United Kingdom
    assert capitals.to_iso2("UP") == "UA"   # Ukraine
    assert capitals.to_iso2("RS") == "RU"   # Russia, NOT Serbia
    assert capitals.to_iso2("RI") == "RS"   # Serbia
    assert capitals.to_iso2("IS") == "IL"   # Israel, NOT Iceland
    assert capitals.to_iso2("IC") == "IS"   # Iceland
    assert capitals.to_iso2("SZ") == "CH"   # Switzerland, NOT Eswatini
    assert capitals.to_iso2("WZ") == "SZ"   # Eswatini
    assert capitals.to_iso2("CH") == "CN"   # China, NOT Switzerland
    assert capitals.to_iso2("EZ") == "CZ"   # Czechia
    assert capitals.to_iso2("SP") == "ES"   # Spain
    assert capitals.to_iso2("ES") == "SV"   # El Salvador, NOT Spain
    assert capitals.to_iso2("LO") == "SK"   # Slovakia
    assert capitals.to_iso2("DA") == "DK"   # Denmark
    assert capitals.to_iso2("PO") == "PT"   # Portugal
    assert capitals.to_iso2("SW") == "SE"   # Sweden
    assert capitals.to_iso2("EI") == "IE"   # Ireland
    assert capitals.to_iso2("TS") == "TN"   # Tunisia
    assert capitals.to_iso2("NI") == "NG"   # Nigeria, NOT Nicaragua
    assert capitals.to_iso2("NG") == "NE"   # Niger


def test_codes_the_two_schemes_agree_on_pass_through():
    """Most countries share a code, and identity there is correct rather than
    lucky -- listing 200 no-op rows would be noise that could itself drift."""
    for code in ("US", "FR", "IT", "CA", "JP", "MX", "PL", "TR"):
        assert capitals.to_iso2(code) == code


def test_an_unusable_code_returns_none_rather_than_guessing():
    assert capitals.to_iso2(None) is None
    assert capitals.to_iso2("") is None
    assert capitals.to_iso2("USA") is None   # three letters is not FIPS 10-4
    assert capitals.to_iso2("X") is None


# --- one capital per country ------------------------------------------------

def test_an_override_beats_the_city_geonames_marked():
    """GeoNames marks Sucre as Bolivia's capital; La Paz seats the government
    and every ministry, and is not marked PPLC at all. An override that could
    only choose among PPLC rows would be unable to express this -- which is
    exactly what it did before, silently falling back to Sucre."""
    index = _index(
        geonames_row(geonameid="1", name="Sucre", country_code="BO",
                     feature_code="PPLC", lat="-19.03332", lon="-65.26274",
                     population="224838"),
        geonames_row(geonameid="2", name="La Paz", country_code="BO",
                     feature_code="PPLG", lat="-16.5", lon="-68.15",
                     population="2004652"),
    )
    assert index["BO"]["name"] == "La Paz"


def test_countries_geonames_marks_no_capital_for_still_get_one():
    """Three countries in the live file carry no PPLC row: IL, PS and EH. Two
    of them are among the most heavily reported places on this map, so leaving
    their diplomacy on a country centroid was not an option."""
    index = _index(
        geonames_row(geonameid="1", name="Jerusalem", country_code="IL",
                     feature_code="PPLA", lat="31.76904", lon="35.21633",
                     population="971800"),
        geonames_row(geonameid="2", name="Tel Aviv", country_code="IL",
                     feature_code="PPLA", lat="32.08088", lon="34.78057",
                     population="432892"),
        geonames_row(geonameid="3", name="Ramallah", country_code="PS",
                     feature_code="PPL", lat="31.89964", lon="35.20422",
                     population="43880"),
    )
    assert index["IL"]["name"] == "Jerusalem"
    assert index["PS"]["name"] == "Ramallah"


def test_population_decides_where_no_override_applies():
    index = _index(
        geonames_row(geonameid="1", name="Smallcap", country_code="XX", population="90000"),
        geonames_row(geonameid="2", name="Bigcap", country_code="XX", population="900000"),
    )
    assert index["XX"]["name"] == "Bigcap"


def test_the_choice_does_not_depend_on_file_order():
    """Without a deterministic tiebreak the winner follows download order, so a
    country could anchor to a different city after a restart and every
    diplomacy pin in it would move."""
    a = geonames_row(geonameid="10", name="Alpha", country_code="XX", population="500000")
    b = geonames_row(geonameid="20", name="Beta", country_code="XX", population="500000")
    assert _index(a, b)["XX"]["name"] == _index(b, a)["XX"]["name"]


def test_an_override_survives_the_city_list_not_containing_it():
    """Ramallah is 43,880 people and is cut by cities.py's 100,000 floor -- a
    threshold about map clutter, which must not silently decide whether a
    country has a diplomatic anchor. The entry carries its own coordinates."""
    index = _index(geonames_row())  # Kyiv only; nothing for PS at all
    assert index["PS"]["name"] == "Ramallah"
    assert (index["PS"]["lat"], index["PS"]["lon"]) == (31.89964, 35.20422)
    assert index["PS"]["country_code"] == "PS"


def test_an_override_prefers_upstreams_own_row_when_it_is_there():
    """So coordinates and population track GeoNames rather than going stale in
    a table nobody revisits."""
    index = _index(geonames_row(
        geonameid="281184", name="Jerusalem", country_code="IL",
        feature_code="PPLA", lat="31.9", lon="35.3", population="1000000",
    ))
    assert index["IL"]["geonameid"] == 281184
    assert index["IL"]["lat"] == 31.9


def test_non_capitals_never_enter_the_index():
    """A provincial seat (PPLA) is not a national capital. Only the override
    entries, which are explicit by construction, may appear without a PPLC row."""
    index = _index(
        geonames_row(geonameid="1", name="Lyon", country_code="FR",
                     feature_code="PPLA", population="522969"),
    )
    assert "FR" not in index
    assert set(index) == set(capitals._CAPITAL_OVERRIDES)


# --- anchors ----------------------------------------------------------------

def test_records_in_one_country_share_an_anchor_id():
    """The frontend groups a capital hub on this exact string, so two records
    snapped to the same capital must produce the identical id."""
    capital = {"name": "Kyiv", "country_code": "ua", "lat": 50.45, "lon": 30.52}
    first = capitals.anchor_for(capital)
    second = capitals.anchor_for(dict(capital))
    assert first["id"] == second["id"] == "capital:UA"
    assert first["kind"] == "capital"
    assert (first["lat"], first["lon"]) == (50.45, 30.52)


# --- cold start -------------------------------------------------------------

def test_the_index_is_empty_rather_than_wrong_before_cities_loads(monkeypatch):
    """cities.py is started before officials.py and nothing waits on it, so the
    first diplomacy poll legitimately runs against no data. Callers leave the
    record where GDELT put it; this must not raise."""
    monkeypatch.setattr(capitals.registry, "has", lambda name: False)
    monkeypatch.setattr(capitals, "_index", None)
    assert capitals.capital_for_fips("UP") is None
    assert capitals.capital_for_iso2("UA") is None
