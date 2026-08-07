"""Grain balance sheets and the food price index.

Every fixture below is real text captured from the two publishers on 2026-08-06,
not a hand-written approximation, because both hazards these tests guard against
live in the punctuation:

- AMIS leaves an unpublished figure *blank*. Every IGC row has an empty
  `other_uses`; every USDA row has empty `food_use` and `feed_use`. Reading
  those as 0.0 invents a forecast nobody made and turns a silence into a
  disagreement.
- The FAO Food Price Index CSV is not a CSV table. Two title rows sit above the
  header, a row of bare commas sits below it, every line is padded out to 65
  columns and the whole file is CRLF. A parser that skips a fixed number of
  lines does not fail on that -- it reads the base-period line as the column
  names.

The third property is the point of the module: three bodies estimate the same
quantity and all three survive to the card. Argentine wheat exports for 2026/27
are 15.0 (FAO), 14.3 (IGC) and 14.5 (USDA), and no line of this module is
allowed to turn that into one number.
"""

import pytest

from backend.sources import food_trade as ft

AMIS_HEADER = (
    "database_code,database,m49,region_name,product_code,product_name,date,year,"
    "season,units,total_supply,opening_stocks,production,imports_nmy,"
    "total_utilization,domestic_utilization,food_use,feed_use,other_uses,"
    "exports_nmy,closing_stocks"
)

# Argentina, wheat, 2026/27, as each of the three databases published it.
ARG_CBS = (
    "CBS,FAO-AMIS,32,Argentina,1,Wheat,2026-01-01,2026,2026/27,Million tonnes,"
    "26.003,3.5,22.5,0.003,26.003,7.503,4.9,1.603,1.0,15.0,3.5"
)
ARG_IGC = (
    "IGC,IGC,32,Argentina,1,Wheat,2026-01-01,2026,2026/27,Million tonnes,"
    "23.91,3.39,20.5,0.0,23.91,7.24,5.95,0.33,,14.3,2.37"
)
ARG_PSD = (
    "PSD,USDA-PSD,32,Argentina,1,Wheat,2026-01-01,2026,2026/27,Million tonnes,"
    "25.142,4.132,21.0,0.01,25.142,7.45,,,,14.5,3.192"
)

# The two regions with no ISO3 of their own, and one with a non-ASCII name.
EU_CBS = (
    "CBS,FAO-AMIS,150,European Union,1,Wheat,2026-01-01,2026,2026/27,Million tonnes,"
    "158.713,17.021,135.823,5.869,158.713,113.663,50.284,47.133,16.246,29.592,15.458"
)
CHN_CBS = (
    'CBS,FAO-AMIS,156,"China, mainland",1,Wheat,2026-01-01,2026,2026/27,Million tonnes,'
    "296.10816,150.60816,140.5,5.0,296.10816,138.41152,88.0,28.0,22.41152,0.18,157.51664"
)
TUR_IGC = (
    "IGC,IGC,792,Türkiye,1,Wheat,2026-01-01,2026,2026/27,Million tonnes,"
    "32.46,3.45,22.0,7.01,32.46,21.92,17.38,1.22,,6.15,4.39"
)


def amis_csv(*rows: str) -> str:
    return "\n".join((AMIS_HEADER, *rows)) + "\n"


def estimates(*rows: str) -> list[dict]:
    return ft.parse_amis(amis_csv(*rows))


# --- three bodies, one quantity --------------------------------------------


def test_the_three_databases_stay_separate_for_the_same_country_and_commodity():
    """The whole reason this source exists. Averaging them, or picking one,
    would throw away the corroboration axis they are here to provide."""
    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    wheat = merged["ARG"]["commodities"]["wheat"]

    assert wheat["databases"] == ["CBS", "IGC", "PSD"]
    assert wheat["estimates"]["CBS"]["exports_nmy"] == 15.0
    assert wheat["estimates"]["IGC"]["exports_nmy"] == 14.3
    assert wheat["estimates"]["PSD"]["exports_nmy"] == 14.5


def test_each_estimate_names_the_body_that_issued_it():
    """`database_code` is the query parameter; `database` is what the body calls
    itself, and it is what a card should print."""
    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    publishers = {
        code: est["publisher"]
        for code, est in merged["ARG"]["commodities"]["wheat"]["estimates"].items()
    }
    assert publishers == {"CBS": "FAO-AMIS", "IGC": "IGC", "PSD": "USDA-PSD"}


def test_the_spread_is_labelled_as_this_apps_arithmetic_not_as_a_published_figure():
    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    spread = merged["ARG"]["commodities"]["wheat"]["spread"]

    assert spread["inferred_by"] == ft.INFERRED_BY
    exports = spread["fields"]["exports_nmy"]
    assert exports["low"] == 14.3 and exports["low_source"] == "IGC"
    assert exports["high"] == 15.0 and exports["high_source"] == "FAO-AMIS"
    # 15.0 - 14.3 is 0.7000000000000011 in binary floating point.
    assert exports["spread"] == 0.7
    assert exports["estimates"] == 3


def test_a_field_only_one_body_published_has_no_spread():
    """`other_uses` is published by FAO alone. A spread over one estimate is not
    a spread, and one computed against a blank read as zero would be a lie."""
    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    fields = merged["ARG"]["commodities"]["wheat"]["spread"]["fields"]

    assert "other_uses" not in fields
    # food_use has two of the three (FAO and IGC; USDA leaves it blank).
    assert fields["food_use"]["estimates"] == 2


# --- blanks are not zeros ---------------------------------------------------


def test_a_blank_numeric_field_is_none_and_never_zero():
    """IGC leaves `other_uses` empty on every row; USDA leaves `food_use` and
    `feed_use` empty on every row. 0.0 would assert a forecast of nothing."""
    igc, psd = estimates(ARG_IGC, ARG_PSD)

    assert igc["other_uses"] is None
    assert psd["food_use"] is None and psd["feed_use"] is None and psd["other_uses"] is None
    # And a real zero survives as a real zero.
    assert igc["imports_nmy"] == 0.0


def test_blanks_stay_none_through_the_merge():
    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    estimates_by_db = merged["ARG"]["commodities"]["wheat"]["estimates"]

    assert estimates_by_db["IGC"]["other_uses"] is None
    assert estimates_by_db["CBS"]["other_uses"] == 1.0


# --- M49 -> the key this project joins on -----------------------------------


def test_ordinary_regions_are_keyed_by_iso3():
    assert ft.country_key(32) == ("ARG", False, None)
    assert ft.country_key(792)[0] == "TUR"
    assert ft.country_key(840)[0] == "USA"


def test_the_european_union_is_kept_as_a_flagged_aggregate_not_dropped():
    """It has no ISO3 and no country card, but it is not a sum of the member
    rows either -- those are not in the feed -- so dropping it would lose about a
    fifth of world wheat with nothing to rebuild it from."""
    key, aggregate, _note = ft.country_key(ft.M49_EUROPEAN_UNION)
    assert (key, aggregate) == (ft.EU_KEY, True)
    assert key in ft.AGGREGATE_CODES

    merged = ft.merge(estimates(EU_CBS))
    assert merged["EU"]["aggregate"] is True
    assert merged["EU"]["country"] == "European Union"
    assert merged["EU"]["commodities"]["wheat"]["estimates"]["CBS"]["production"] == 135.823


def test_china_mainland_maps_to_chn_but_says_what_it_excludes():
    """The map's CHN polygon covers the same territory FAO means by "China,
    mainland", so the join is honest -- but the card must not relabel the figure
    "China" as though Hong Kong, Macao and Taiwan were in it."""
    key, aggregate, note = ft.country_key(ft.M49_CHINA_MAINLAND)
    assert (key, aggregate) == ("CHN", False)
    assert "Hong Kong" in note and "Taiwan" in note

    merged = ft.merge(estimates(CHN_CBS))
    assert merged["CHN"]["country"] == "China, mainland"
    assert merged["CHN"]["note"] == ft.CHINA_MAINLAND_NOTE
    assert merged["CHN"]["aggregate"] is False


def test_an_unknown_region_is_namespaced_rather_than_silently_dropped():
    """No country feature carries an iso_a3 of this shape, so it reaches no card
    -- but the figures survive in storage and the log says what to add."""
    key, aggregate, _note = ft.country_key(1248)  # FAO's wider "China" aggregate
    assert key == "m49:1248" and aggregate is False


def test_a_non_ascii_region_name_survives_the_parse():
    (row,) = estimates(TUR_IGC)
    assert row["region_name"] == "Türkiye"
    assert row["country_code"] == "TUR"


# --- the season is attached to every number ---------------------------------


def test_every_estimate_carries_its_own_season_and_evidence_grade():
    """A marketing-year balance sheet is a forecast. Nothing may render it as a
    measurement, so the label travels with the number rather than sitting once
    at the top of the document."""
    for row in estimates(ARG_CBS, ARG_IGC, ARG_PSD):
        assert row["season"] == "2026/27"
        assert row["evidence"] == ft.EVIDENCE_FORECAST

    merged = ft.merge(estimates(ARG_CBS, ARG_IGC, ARG_PSD))
    wheat = merged["ARG"]["commodities"]["wheat"]
    assert wheat["season"] == "2026/27"
    assert wheat["units"] == "Million tonnes"
    for estimate in wheat["estimates"].values():
        assert estimate["season"] == "2026/27"
        assert estimate["evidence"] == ft.EVIDENCE_FORECAST
    assert merged["ARG"]["evidence"] == ft.EVIDENCE_FORECAST


def test_the_commodity_header_refuses_to_pick_a_season_when_they_disagree():
    """They never have. If they ever do, a header cannot answer for all three --
    the per-estimate season is the authoritative one and stays intact."""
    stale = ARG_PSD.replace("2026/27", "2025/26")
    wheat = ft.merge(estimates(ARG_CBS, ARG_IGC, stale))["ARG"]["commodities"]["wheat"]

    assert wheat["season"] is None
    assert wheat["seasons"] == ["2025/26", "2026/27"]
    assert wheat["estimates"]["PSD"]["season"] == "2025/26"
    assert wheat["estimates"]["CBS"]["season"] == "2026/27"


def test_a_row_with_no_season_is_dropped_rather_than_published_unlabelled():
    unlabelled = ARG_CBS.replace(",2026,2026/27,", ",2026,,")
    assert estimates(unlabelled) == []


def test_the_commodity_is_read_from_the_rows_own_product_name():
    """The documented product codes and the live view disagree about which of 4
    and 5 is rice, so the name is taken from the row rather than from the code
    that was asked for."""
    maize = ARG_CBS.replace(",1,Wheat,", ",5,Maize,")
    merged = ft.merge(estimates(ARG_CBS, maize))
    assert sorted(merged["ARG"]["commodities"]) == ["maize", "wheat"]
    assert merged["ARG"]["commodities"]["maize"]["product"] == "Maize"
    assert merged["ARG"]["commodities"]["maize"]["product_code"] == 5


# --- resolving the query FAO actually runs ----------------------------------
#
# The real resource list, in the order the catalogue returns it. Two of the four
# URLs end in ".sql" and only one of them is a SQL file -- the first is a
# ready-made proxy call that *embeds* the second. Picking the wrong one nests the
# proxy inside itself and answers 502 on all twelve requests, which is exactly
# what happened the first time this ran against the live service.

AMIS_RESOURCES = [
    {
        "id": "95664e37-970e-4728-acbb-082d8d11c2b2",
        "format": "smart-csv",
        "name": "AMIS Database",
        "url": (
            "https://api.data.apps.fao.org/api/v2/bigquery?sql_url="
            "https://data.apps.fao.org/catalog/dataset/10d3d4ae-120d-4f55-90f5-34d36fc9f922"
            "/resource/1f2b85b1-837e-4a11-ba5b-fc85b4680769/download/amis-parameterized-query.sql"
        ),
    },
    {
        "id": "8a7f046f-5048-49cc-8eae-d70f93412b24",
        "format": "JSON",
        "name": "amis-terriajs-config.json",
        "url": (
            "https://data.apps.fao.org/catalog/dataset/10d3d4ae-120d-4f55-90f5-34d36fc9f922"
            "/resource/8a7f046f-5048-49cc-8eae-d70f93412b24/download/amis-terriajs-config.json"
        ),
    },
    {
        "id": "1f2b85b1-837e-4a11-ba5b-fc85b4680769",
        "format": "application/x-sql",
        "name": "amis-parameterized-query.sql",
        "url": (
            "https://data.apps.fao.org/catalog/dataset/10d3d4ae-120d-4f55-90f5-34d36fc9f922"
            "/resource/1f2b85b1-837e-4a11-ba5b-fc85b4680769/download/amis-parameterized-query.sql"
        ),
    },
]


def test_the_query_url_is_the_sql_file_not_the_proxy_call_that_embeds_it():
    picked = ft.pick_sql_url(AMIS_RESOURCES)
    assert picked == AMIS_RESOURCES[2]["url"]
    assert not picked.startswith(ft.AMIS_QUERY_URL), (
        "this is the failure that returns 502 on every request: the proxy passed "
        "to itself as its own sql_url parameter"
    )
    # The value hardcoded as the fallback is the one resolution should agree with.
    assert picked == ft.AMIS_SQL_URL_FALLBACK


def test_a_catalogue_with_no_query_file_raises_so_the_fallback_is_used():
    with pytest.raises(RuntimeError, match="no .sql resource"):
        ft.pick_sql_url([AMIS_RESOURCES[0], AMIS_RESOURCES[1]])


# --- the price index --------------------------------------------------------
#
# CRLF and the 65-column padding are reproduced exactly: they are the reason the
# header has to be found rather than counted to.

FPI_CSV = "\r\n".join([
    "FAO Food Price Index" + "," * 65,
    "2014-2016=100" + "," * 65,
    "Date,Food Price Index,Meat,Dairy,Cereals,Oils,Sugar" + "," * 59,
    "," * 65,
    "1990-01,64.4,74.3,53.5,64.1,44.59,87.9" + "," * 59,
    "2026-05,130.8,130.5,119.2,114.2,185.0,95.1" + "," * 59,
    "2026-06,130.3,131.0,117.4,110.2,192.0,89.7" + "," * 59,
    "",
])


def test_the_header_is_found_below_faos_two_title_rows():
    parsed = ft.parse_price_index(FPI_CSV)
    assert parsed["months"] == 3
    assert parsed["first_month"] == "1990-01"
    assert parsed["last_month"] == "2026-06"
    # Read as column names, not as data -- and not mistaken for the header.
    assert parsed["index"] == "FAO Food Price Index"


def test_the_base_period_is_kept_because_an_index_without_one_has_no_scale():
    assert ft.parse_price_index(FPI_CSV)["base_period"] == "2014-2016=100"


def test_the_sub_indices_keep_faos_own_labels_alongside_their_keys():
    parsed = ft.parse_price_index(FPI_CSV)
    assert parsed["labels"]["cereals"] == "Cereals"
    assert parsed["labels"]["food_price_index"] == "Food Price Index"
    # The 59 padding columns are not columns.
    assert list(parsed["labels"]) == [
        "food_price_index", "meat", "dairy", "cereals", "oils", "sugar",
    ]


def test_the_headline_and_the_cereals_sub_index_are_reachable_without_scanning():
    latest = ft.parse_price_index(FPI_CSV)["latest"]
    assert latest["month"] == "2026-06"
    assert latest["food_price_index"] == 130.3
    assert latest["cereals"] == 110.2


def test_the_blank_spacer_row_is_not_a_month():
    months = [row["month"] for row in ft.parse_price_index(FPI_CSV)["series"]]
    assert months == ["1990-01", "2026-05", "2026-06"]


def test_the_price_index_is_graded_as_observed_not_as_a_forecast():
    """The opposite grade to the AMIS half, which is why they are two documents."""
    assert ft.parse_price_index(FPI_CSV)["evidence"] == ft.EVIDENCE_OBSERVED
    assert ft.EVIDENCE_OBSERVED != ft.EVIDENCE_FORECAST


def test_a_missing_header_raises_rather_than_publishing_an_empty_series():
    """A silently empty index is a green health light over a blank card."""
    with pytest.raises(ValueError, match="header"):
        ft.parse_price_index("FAO Food Price Index,,,\r\n2014-2016=100,,,\r\n")


def test_a_header_with_no_months_under_it_raises_too():
    with pytest.raises(ValueError, match="no monthly rows"):
        ft.parse_price_index("Date,Food Price Index,Cereals\r\n,,\r\n")
