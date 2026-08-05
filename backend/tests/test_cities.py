"""GeoNames parsing: which columns are read, and which rows survive the floor.

The capital flag was in the downloaded file all along and simply never read,
which is why the map had no concept of a capital and the diplomacy layer had
nowhere to anchor to. These pin the columns by position -- a headerless TSV
does not raise on a wrong index, it silently returns a neighbouring field.
"""

from backend.sources import cities

from .conftest import geonames_row


def _parse(*rows: str) -> list[dict]:
    return cities._parse_cities("\n".join(rows))


def test_feature_code_and_geonameid_are_read_from_the_right_columns():
    (kyiv,) = _parse(geonames_row())
    assert kyiv["geonameid"] == 703448
    assert kyiv["feature_code"] == "PPLC"
    assert kyiv["name"] == "Kyiv"
    assert kyiv["country_code"] == "UA"
    assert (kyiv["lat"], kyiv["lon"]) == (50.45466, 30.5238)
    assert kyiv["population"] == 2797553


def test_pplc_bypasses_the_population_floor():
    """A capital is context the map needs whatever its size -- and it is the
    point diplomacy pins are snapped onto, so losing it loses the anchor."""
    (podgorica,) = _parse(geonames_row(
        geonameid="3193044", name="Podgorica", country_code="ME",
        lat="42.44111", lon="19.26361", population="150977",
    ))
    assert podgorica["is_capital"] is True

    # Well under MIN_POPULATION and still kept.
    small = _parse(geonames_row(
        geonameid="3168070", name="San Marino", country_code="SM",
        lat="43.93667", lon="12.44639", population="4061",
    ))
    assert len(small) == 1
    assert small[0]["is_capital"] is True


def test_a_non_capital_below_the_floor_is_still_dropped():
    assert _parse(geonames_row(
        name="Somewhere", feature_code="PPL", population="20000",
    )) == []


def test_a_historical_capital_is_not_marked_as_one():
    """PPLCH is a *former* capital. Matching it would put a capital star on
    Kyoto, and would give Japan's diplomacy two anchors to choose between."""
    (kyoto,) = _parse(geonames_row(
        geonameid="1857910", name="Kyoto", country_code="JP",
        feature_code="PPLCH", lat="35.02107", lon="135.75385", population="1459640",
    ))
    assert kyoto["is_capital"] is False

    # PPLA is a first-order administrative capital -- every provincial seat on
    # earth. Also not a national capital.
    (lyon,) = _parse(geonames_row(
        geonameid="2996944", name="Lyon", country_code="FR",
        feature_code="PPLA", population="522969",
    ))
    assert lyon["is_capital"] is False


def test_malformed_rows_are_skipped_rather_than_crashing_the_poll():
    rows = _parse(
        "not\tenough\tcolumns",
        geonames_row(population="not-a-number"),
        geonames_row(geonameid="", name="No id"),
        geonames_row(),
    )
    assert [c["name"] for c in rows] == ["Kyiv"]


def test_output_is_ordered_largest_first():
    rows = _parse(
        geonames_row(geonameid="1", name="Small", feature_code="PPL", population="120000"),
        geonames_row(geonameid="2", name="Big", feature_code="PPL", population="9000000"),
    )
    assert [c["name"] for c in rows] == ["Big", "Small"]
