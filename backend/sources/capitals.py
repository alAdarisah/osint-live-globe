"""Where a country's government sits, and how to get there from a GDELT row.

The Officials & Diplomacy layer draws events GDELT geocoded only to a country
centroid -- a point in the geometric middle of a landmass, which is an artifact
of the geocoder rather than a location. Diplomacy happens in capitals, so this
module answers "given a country, where is its seat of government".

Not a poller. It owns no fetch and registers no source: cities.py already
downloads the GeoNames file every six hours, and a second download would be a
second failure mode for the same data. It reads that poller's registry entry
lazily, the same cross-source read officials.py and event_fusion.py already do.

It lives outside cities.py because the interesting part is not the GeoNames
parsing -- it is the code crosswalk below, which has nothing to do with
GeoNames and would be invisible buried in an 85-line poller.
"""

import logging

from backend.cache import registry

log = logging.getLogger("osint-globe.capitals")

# GDELT's ActionGeo_CountryCode is FIPS 10-4. GeoNames' country_code is ISO
# 3166-1 alpha-2. They are both two-letter country codes and they are NOT the
# same scheme.
#
# The trap, stated plainly because it is the failure this table exists to
# prevent: **AU is Austria in FIPS and Australia in ISO 3166-1.** A join that
# assumes the codes match files Vienna's diplomacy in Canberra -- silently,
# plausibly, and for every Austrian event forever. AS is Australia in FIPS and
# American Samoa in ISO. GM is Germany in FIPS and Gambia in ISO. There is no
# shortcut here; the crosswalk has to be explicit.
#
# Only the mappings that differ are listed. Codes identical in both schemes
# (US, FR, IT, CA, JP, ...) fall through to the identity case in to_iso2.
FIPS_TO_ISO2 = {
    "AC": "AG",  # Antigua and Barbuda
    "AG": "DZ",  # Algeria          -- AG is Antigua in ISO
    "AJ": "AZ",  # Azerbaijan
    "AN": "AD",  # Andorra
    "AS": "AU",  # Australia        -- AS is American Samoa in ISO
    "AU": "AT",  # Austria          -- AU is Australia in ISO. See above.
    "BA": "BH",  # Bahrain
    "BC": "BW",  # Botswana
    "BD": "BM",  # Bermuda
    "BF": "BS",  # Bahamas          -- BF is Burkina Faso in ISO
    "BG": "BD",  # Bangladesh       -- BG is Bulgaria in ISO
    "BH": "BZ",  # Belize           -- BH is Bahrain in ISO
    "BK": "BA",  # Bosnia and Herzegovina
    "BL": "BO",  # Bolivia
    "BM": "MM",  # Myanmar          -- BM is Bermuda in ISO
    "BN": "BJ",  # Benin
    "BO": "BY",  # Belarus          -- BO is Bolivia in ISO
    "BP": "SB",  # Solomon Islands
    "BU": "BG",  # Bulgaria
    "BX": "BN",  # Brunei
    "BY": "BI",  # Burundi          -- BY is Belarus in ISO
    "CB": "KH",  # Cambodia
    "CD": "TD",  # Chad             -- CD is DR Congo in ISO
    "CE": "LK",  # Sri Lanka
    "CF": "CG",  # Congo-Brazzaville
    "CG": "CD",  # DR Congo         -- straight swap with the line above
    "CH": "CN",  # China            -- CH is Switzerland in ISO
    "CI": "CL",  # Chile            -- CI is Côte d'Ivoire in ISO
    "CJ": "KY",  # Cayman Islands
    "CQ": "MP",  # Northern Mariana Islands
    "CS": "CR",  # Costa Rica
    "CT": "CF",  # Central African Republic
    "CU": "CU",  # Cuba
    "CW": "CK",  # Cook Islands
    "DA": "DK",  # Denmark
    "DO": "DM",  # Dominica
    "DR": "DO",  # Dominican Republic
    "EI": "IE",  # Ireland
    "EK": "GQ",  # Equatorial Guinea
    "EN": "EE",  # Estonia
    "ES": "SV",  # El Salvador      -- ES is Spain in ISO
    "EZ": "CZ",  # Czechia
    "FJ": "FJ",  # Fiji
    "GA": "GM",  # Gambia
    "GB": "GA",  # Gabon            -- GB is the UK in ISO
    "GG": "GE",  # Georgia          -- GG is Guernsey in ISO
    "GJ": "GD",  # Grenada
    "GM": "DE",  # Germany          -- GM is Gambia in ISO
    "GV": "GN",  # Guinea
    "HA": "HT",  # Haiti
    "HO": "HN",  # Honduras
    "IC": "IS",  # Iceland
    "ID": "ID",  # Indonesia
    "IS": "IL",  # Israel           -- IS is Iceland in ISO
    "IV": "CI",  # Côte d'Ivoire
    "IZ": "IQ",  # Iraq
    "JA": "JP",  # Japan
    "JO": "JO",  # Jordan
    "KE": "KE",  # Kenya
    "KN": "KP",  # North Korea
    "KS": "KR",  # South Korea
    "KU": "KW",  # Kuwait
    "KV": "XK",  # Kosovo
    "LE": "LB",  # Lebanon
    "LG": "LV",  # Latvia
    "LH": "LT",  # Lithuania
    "LO": "SK",  # Slovakia
    "LS": "LI",  # Liechtenstein
    "LT": "LS",  # Lesotho
    "MA": "MG",  # Madagascar
    "MB": "MQ",  # Martinique
    "MD": "MD",  # Moldova
    "MG": "MN",  # Mongolia         -- MG is Madagascar in ISO
    "MI": "MW",  # Malawi
    "MJ": "ME",  # Montenegro
    "MK": "MK",  # North Macedonia
    "MP": "MU",  # Mauritius        -- MP is N. Marianas in ISO
    "MU": "OM",  # Oman             -- MU is Mauritius in ISO
    "MY": "MY",  # Malaysia
    "NG": "NE",  # Niger            -- NG is Nigeria in ISO
    "NI": "NG",  # Nigeria          -- straight swap with the line above
    "NL": "NL",  # Netherlands
    "NS": "SR",  # Suriname
    "NU": "NI",  # Nicaragua
    "PA": "PY",  # Paraguay
    "PM": "PA",  # Panama
    "PO": "PT",  # Portugal
    "PP": "PG",  # Papua New Guinea
    "PU": "GW",  # Guinea-Bissau
    "RI": "RS",  # Serbia
    "RP": "PH",  # Philippines
    "RQ": "PR",  # Puerto Rico
    "RS": "RU",  # Russia           -- RS is Serbia in ISO
    "SA": "SA",  # Saudi Arabia
    "SF": "ZA",  # South Africa
    "SG": "SN",  # Senegal          -- SG is Singapore in ISO
    "SI": "SI",  # Slovenia
    "SN": "SG",  # Singapore        -- straight swap with the Senegal line
    "SP": "ES",  # Spain
    "ST": "LC",  # Saint Lucia
    "SU": "SD",  # Sudan
    "SW": "SE",  # Sweden
    "SZ": "CH",  # Switzerland      -- SZ is Eswatini in ISO
    "TD": "TT",  # Trinidad and Tobago
    "TI": "TJ",  # Tajikistan
    "TN": "TO",  # Tonga
    "TO": "TG",  # Togo             -- straight swap with the line above
    "TP": "ST",  # Sao Tome and Principe
    "TS": "TN",  # Tunisia
    "TU": "TR",  # Turkey
    "TX": "TM",  # Turkmenistan
    "UK": "GB",  # United Kingdom
    "UP": "UA",  # Ukraine
    "UV": "BF",  # Burkina Faso
    "VM": "VN",  # Vietnam
    "WA": "NA",  # Namibia
    "WE": "PS",  # West Bank / Palestine
    "WZ": "SZ",  # Eswatini         -- straight swap with the Switzerland line
    "YM": "YE",  # Yemen
    "ZA": "ZM",  # Zambia           -- ZA is South Africa in ISO
    "ZI": "ZW",  # Zimbabwe
}

# Where GeoNames' own PPLC choice is not the city this layer should anchor to,
# and the three countries it marks no capital for at all.
#
# Measured against the live file rather than assumed: GeoNames marks exactly one
# PPLC row per country, for 241 of the 244 countries present. So this is not a
# tie-break table -- it is a correction table, and it is deliberately short.
#
# Looked up across *all* of a country's cities, not only its PPLC rows: the
# whole point of an entry here is to name a city GeoNames did not mark.
# Each entry carries its own coordinates rather than only a name. The name is
# still looked up in the GeoNames list first, so an override normally inherits
# whatever coordinates and population upstream currently has -- but it cannot
# *depend* on that row being there. Ramallah is 43,880 people and would be cut
# by cities.py's 100,000 floor, which has nothing to do with capitals and should
# not silently decide whether Palestine has an anchor.
_CAPITAL_OVERRIDES = {
    # Seat of government differs from the city GeoNames marks. Only listed where
    # GeoNames actually disagrees -- an entry that merely restates PPLC is noise
    # that can silently rot.
    # GeoNames marks Sucre (constitutional). La Paz seats the government and
    # every ministry.
    "BO": {"name": "La Paz", "lat": -16.5, "lon": -68.15, "population": 2004652},

    # No PPLC row exists for these three -- measured, not assumed: they are the
    # only countries in the live file with cities but no marked capital. Each
    # names the city the government administers from, which is the question this
    # module exists to answer. It is not a statement about sovereignty,
    # recognition or borders, and nothing downstream reads it as one.
    # Knesset, Supreme Court and the ministries.
    "IL": {"name": "Jerusalem", "lat": 31.76904, "lon": 35.21633, "population": 971800},
    # The Palestinian Authority's administrative seat.
    "PS": {"name": "Ramallah", "lat": 31.89964, "lon": 35.20422, "population": 43880},
    # The territory's administrative centre and its largest city.
    "EH": {"name": "Laayoune", "lat": 27.1418, "lon": -13.18797, "population": 196331},
}

# Rebuilt when cities.py publishes a new list. Keyed ISO2 -> capital record.
_index: dict[str, dict] | None = None
_index_version = -1
_logged_empty = False


def to_iso2(code: str | None) -> str | None:
    """FIPS 10-4 country code -> ISO 3166-1 alpha-2.

    Public because geoverify.py needs the same crosswalk to scope a gazetteer
    lookup to the country GDELT thinks an event is in, and a second copy of
    this table anywhere would be a second place for the AU/AS/GM traps below to
    be got wrong.

    Codes absent from the table fall through unchanged: the two schemes agree
    on the majority of countries, and an identity mapping there is correct
    rather than lucky. A code that is neither in the table nor a real ISO2 code
    simply fails to find a capital, which is the safe outcome.
    """
    if not code:
        return None
    code = code.strip().upper()
    if len(code) != 2:
        return None
    return FIPS_TO_ISO2.get(code, code)


def _rank(city: dict) -> tuple[int, int]:
    """Population, with the GeoNames id breaking a tie.

    The tiebreak matters: without it the winner depends on the order rows
    happen to appear in the download, so the same country could anchor to a
    different city after a restart and every diplomacy pin in it would move.
    """
    return (city.get("population") or 0, -(city.get("geonameid") or 0))


def _build_index(cities: list[dict]) -> dict[str, dict]:
    """ISO2 -> the one city this country's diplomacy anchors to.

    An override is searched across every city in the country; GeoNames' PPLC
    flag only decides the default. That is what lets the table name La Paz over
    Sucre, and lets it supply a seat of government for the three countries
    GeoNames marks no capital for at all.
    """
    marked: dict[str, list[dict]] = {}
    by_country: dict[str, list[dict]] = {}
    for city in cities:
        iso2 = (city.get("country_code") or "").strip().upper()
        if not iso2:
            continue
        by_country.setdefault(iso2, []).append(city)
        if city.get("is_capital"):
            marked.setdefault(iso2, []).append(city)

    index: dict[str, dict] = {}
    for iso2 in set(marked) | set(_CAPITAL_OVERRIDES):
        override = _CAPITAL_OVERRIDES.get(iso2)
        chosen = None
        if override:
            # Prefer upstream's own row for the named city, so coordinates and
            # population stay current; fall back to the literal, which is what
            # makes the entry independent of cities.py's population floor.
            chosen = next(
                (c for c in by_country.get(iso2, ()) if c.get("name") == override["name"]),
                {**override, "country_code": iso2, "geonameid": None},
            )
        if chosen is None:
            group = marked.get(iso2)
            if not group:
                continue
            chosen = max(group, key=_rank)
        index[iso2] = chosen
    return index


def _capital_index() -> dict[str, dict]:
    """The ISO2 -> capital lookup, rebuilt only when cities.py republishes."""
    global _index, _index_version, _logged_empty
    if not registry.has("cities"):
        return {}
    state = registry.get("cities")
    if _index is None or state.version != _index_version:
        _index = _build_index(state.data or [])
        _index_version = state.version
        if _index:
            log.info("Capital index built: %d countries", len(_index))
    if not _index and not _logged_empty:
        # Cold start: cities.py is started before officials.py but nothing waits
        # on it, so the first diplomacy poll can legitimately run against an
        # empty index. Callers leave the record where it is; this is not an
        # error and must not be logged as one on every poll.
        _logged_empty = True
        log.info("Capital index is empty (cities not loaded yet); diplomacy stays where GDELT put it")
    return _index or {}


def capital_for_iso2(code: str | None) -> dict | None:
    """The capital of an ISO 3166-1 alpha-2 country, or None."""
    if not code:
        return None
    return _capital_index().get(code.strip().upper())


def capital_for_fips(code: str | None) -> dict | None:
    """The capital of a country named by a GDELT FIPS 10-4 code, or None.

    None is a normal answer, not a failure: microstate capitals below GeoNames'
    own 15,000 floor (Vaduz, Ngerulmud, Vatican City) are not in the source file
    at all, and GDELT emits region codes that name no country. Callers degrade
    by leaving the record where it is.
    """
    return capital_for_iso2(to_iso2(code))


def anchor_for(capital: dict) -> dict:
    """The map-facing anchor a snapped record carries.

    Deliberately a general shape rather than a capital-specific one: official
    press releases anchor to their issuing institution the same way, and the
    frontend groups on `id` without caring which kind it is.
    """
    iso2 = (capital.get("country_code") or "").strip().upper()
    return {
        "kind": "capital",
        "id": f"capital:{iso2}",
        "name": capital.get("name"),
        "country_code": iso2,
        "lat": capital.get("lat"),
        "lon": capital.get("lon"),
    }
