"""Displacement and food-security aggregation.

The two hazards these guard against are both double-counting: IPC republishes
the same geography for every analysis round, and HAPI returns admin-2 districts
alongside the admin-1 provinces that contain them. Summing naively inflates
every figure, in one case by roughly the number of rounds on file.
"""

from backend.sources import humanitarian as hum


def unhcr_row(code="AFG", name="Afghanistan", year=2024, **overrides):
    row = {
        "year": year,
        "coo": code,
        "coo_iso": code,
        "coo_name": name,
        "refugees": 5766586,
        "asylum_seekers": 384732,
        "returned_refugees": 364443,
        "idps": 3199710,
        "stateless": "0",
        "ooc": 871521,
    }
    row.update(overrides)
    return row


def ipc_row(phase="3", population=100, start="2026-04-01T00:00:00", level=2, ipc_type="current"):
    return {
        "location_code": "SDN",
        "admin_level": level,
        "ipc_phase": phase,
        "ipc_type": ipc_type,
        "population_in_phase": population,
        "reference_period_start": start,
        "reference_period_end": "2026-05-31T23:59:59",
    }


# --- UNHCR -----------------------------------------------------------------


def test_countries_are_keyed_by_iso3_so_the_hapi_half_joins_without_names():
    parsed = hum.parse_unhcr([unhcr_row()])
    assert list(parsed) == ["AFG"]
    assert parsed["AFG"]["refugees"] == 5766586
    assert parsed["AFG"]["idps"] == 3199710


def test_string_zeros_and_dashes_become_numbers_or_none():
    """UNHCR writes zeros as the string "0" and blanks as "-"."""
    parsed = hum.parse_unhcr([unhcr_row(stateless="0", asylum_seekers="-")])
    assert parsed["AFG"]["stateless"] == 0
    assert parsed["AFG"]["asylum_seekers"] is None


def test_the_newest_year_wins_when_several_are_returned():
    """UNHCR publishes the previous year partway through the following one, so
    a window of years routinely comes back with several per country."""
    parsed = hum.parse_unhcr([
        unhcr_row(year=2023, refugees=1),
        unhcr_row(year=2025, refugees=3),
        unhcr_row(year=2024, refugees=2),
    ])
    assert parsed["AFG"]["year"] == 2025
    assert parsed["AFG"]["refugees"] == 3


def test_a_country_with_nothing_to_report_is_dropped():
    empty = unhcr_row(code="AIA", refugees="0", asylum_seekers="0", idps="0", stateless="0")
    assert hum.parse_unhcr([empty]) == {}


def test_a_row_without_a_usable_country_code_or_year_is_skipped():
    assert hum.parse_unhcr([unhcr_row(coo_iso="-", coo="-")]) == {}
    assert hum.parse_unhcr([unhcr_row(year="n/a")]) == {}


# --- IPC food security -----------------------------------------------------


def test_only_crisis_or_worse_is_counted():
    """Phases 1 and 2 are "minimal" and "stressed"; including them would just
    restate the population."""
    result = hum.parse_food_security([
        ipc_row(phase="1", population=900),
        ipc_row(phase="2", population=500),
        ipc_row(phase="3", population=100),
        ipc_row(phase="4", population=50),
        ipc_row(phase="5", population=5),
    ])
    assert result["population_in_crisis"] == 155


def test_only_the_newest_analysis_round_is_used():
    """IPC republishes the same geography every round; summing across rounds
    counts the same people once per round."""
    result = hum.parse_food_security([
        ipc_row(phase="3", population=100, start="2021-04-01T00:00:00"),
        ipc_row(phase="3", population=250, start="2026-04-01T00:00:00"),
    ])
    assert result["population_in_crisis"] == 250
    assert result["reference_period_start"] == "2026-04-01T00:00:00"


def test_admin_two_districts_are_not_added_to_the_provinces_containing_them():
    result = hum.parse_food_security([
        ipc_row(phase="3", population=1000, level=1),
        ipc_row(phase="3", population=600, level=2),
        ipc_row(phase="3", population=400, level=2),
    ])
    assert result["population_in_crisis"] == 1000
    assert result["admin_level"] == 2


def test_projected_analyses_are_ignored():
    """`ipc_type` "current" is the observed situation; the projections are
    forecasts and must not be shown as measurements."""
    assert hum.parse_food_security([ipc_row(ipc_type="projected")]) is None


def test_no_crisis_population_yields_nothing_rather_than_a_zero():
    assert hum.parse_food_security([ipc_row(phase="1", population=900)]) is None
    assert hum.parse_food_security([]) is None


# --- IDPs and operational presence -----------------------------------------


def test_idp_totals_take_the_newest_round_at_the_deepest_level():
    result = hum.parse_idps([
        {"admin_level": 2, "population": 100, "reference_period_start": "2023-09-30T00:00:00"},
        {"admin_level": 1, "population": 900, "reference_period_start": "2026-05-30T00:00:00"},
        {"admin_level": 2, "population": 400, "reference_period_start": "2026-05-30T00:00:00"},
        {"admin_level": 2, "population": 300, "reference_period_start": "2026-05-30T00:00:00"},
    ])
    assert result["population"] == 700
    assert result["admin_level"] == 2


def test_operational_presence_is_reduced_to_counts_not_a_list_of_four_hundred_orgs():
    result = hum.parse_operational_presence([
        {"org_acronym": "ACTED", "sector_name": "Cash programming"},
        {"org_acronym": "ACTED", "sector_name": "Protection"},
        {"org_acronym": "NRC", "sector_name": "Protection"},
    ])
    assert result["organisations"] == 2
    assert result["sector_count"] == 2
    assert "Protection" in result["sectors"]


def test_no_organisations_present_yields_nothing():
    assert hum.parse_operational_presence([]) is None


# --- merge -----------------------------------------------------------------


def test_the_two_publishers_merge_on_the_country_code():
    merged = hum.merge(
        {"SDN": {"country_code": "SDN", "country": "Sudan", "refugees": 10}},
        {"SDN": {"food_security": {"population_in_crisis": 500}}},
    )
    assert merged["SDN"]["country"] == "Sudan"
    assert merged["SDN"]["displacement"]["refugees"] == 10
    assert merged["SDN"]["food_security"]["population_in_crisis"] == 500


def test_a_country_known_to_only_one_publisher_still_appears():
    """The HAPI half is inert without a contact address, so the UNHCR-only case
    is the normal one out of the box, not an edge case."""
    merged = hum.merge({"AFG": {"country_code": "AFG", "refugees": 1}}, {})
    assert list(merged) == ["AFG"]
    hapi_only = hum.merge({}, {"SDN": {"idps": {"population": 5}}})
    assert hapi_only["SDN"]["idps"]["population"] == 5
    assert "displacement" not in hapi_only["SDN"]
