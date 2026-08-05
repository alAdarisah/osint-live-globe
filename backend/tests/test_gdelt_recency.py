"""The recency gate: keeping retrospectives and commentary off the live map.

Every retention rule in gdelt.py is keyed on DATEADDED, which is when GDELT
ingested the article rather than when anything happened. An archival re-crawl
and a magazine retrospective both arrive with DATEADDED = now, so the windows
see them as breaking news. These pin the three signals that do not.
"""

from backend.sources import gdelt

from .conftest import gdelt_row, gdelt_row_diplomatic


def _row(**over) -> dict:
    """A parsed news candidate, as _news_slice sees it."""
    base = {
        "event_id": "1", "mentions": 3, "event_date": "20260805",
        "date_added": "20260805101500",
        "source_url": "https://www.reuters.com/world/europe/kherson-strike",
        "lat": 46.6, "lon": 32.6,
    }
    base.update(over)
    return base


# --- the lag gate ----------------------------------------------------------

def test_a_report_about_something_years_ago_is_not_news():
    assert gdelt.report_lag_days("20190805", "20260805101500") > gdelt.MAX_REPORT_LAG_DAYS
    assert gdelt._is_current_report(_row(event_date="20190805")) is False


def test_ordinary_reporting_lag_is_untouched():
    """The recall guard. 96% of live rows are same-day and this must not be
    the thing that empties the feed."""
    assert gdelt._is_current_report(_row(event_date="20260805")) is True
    assert gdelt._is_current_report(_row(event_date="20260728")) is True  # a week
    assert gdelt.report_lag_days("20260728", "20260805101500") == 8


def test_a_row_with_no_usable_date_is_kept():
    """Dropping on a missing field is dropping data on a data problem, not on
    anything a reader chose."""
    assert gdelt._is_current_report(_row(event_date=None)) is True
    assert gdelt.report_lag_days(None, "20260805101500") is None
    assert gdelt.report_lag_days("20260805", None) is None


# --- the section gate ------------------------------------------------------

def test_a_magazine_retrospective_never_becomes_a_news_pin():
    """The Atlantic's 25-years-after-9/11 feature, which started all of this.

    GDELT stamped it with *today's* SQLDATE, so the lag gate above sees zero lag
    and passes it. Only the section signal catches this one.
    """
    essay = _row(
        source_url="https://www.theatlantic.com/magazine/2026/09/al-qaeda-25-years-post-9-11/687965/",
    )
    assert gdelt.report_lag_days(essay["event_date"], essay["date_added"]) == 0
    assert gdelt._is_current_report(essay) is False


def test_a_live_opinion_column_is_not_a_dispatch():
    # Both of these were live in a 12h window and both were genuinely op-eds:
    # an Al Jazeera piece that made GDELT re-code the 2014 Chibok kidnapping as
    # today's abduction, and an MEE column geocoded to Lebanon.
    assert gdelt._is_current_report(_row(
        source_url="https://www.aljazeera.com/opinions/2026/8/5/nigeria-cannot-build-safe-schools",
    )) is False
    assert gdelt._is_current_report(_row(
        source_url="https://www.middleeasteye.net/opinion/why-syria-will-not-join-the-fight",
    )) is False


# --- the URL-date gate, which ships off ------------------------------------

def test_the_url_date_gate_is_off_by_default():
    """It is the only one of the three whose false-positive rate has not been
    measured against live data, and the failure mode is silent deletion of real
    breaking news. probe_gdelt.py prints every row it would reject."""
    stale = _row(source_url="https://www.reuters.com/world/2019/07/some-story")
    assert gdelt.URL_DATE_GATE is False
    assert gdelt._is_current_report(stale) is True


def test_the_url_date_gate_rejects_an_old_url_when_enabled(monkeypatch):
    monkeypatch.setattr(gdelt, "URL_DATE_GATE", True)
    assert gdelt._is_current_report(
        _row(source_url="https://www.reuters.com/world/2019/07/some-story")
    ) is False
    # A URL from this month still passes, and so does one with no date at all.
    assert gdelt._is_current_report(
        _row(source_url="https://www.reuters.com/world/kherson-strike")
    ) is True


# --- where the gate is applied ---------------------------------------------

def test_the_news_slice_drops_what_the_gate_rejects():
    kept = _row(event_id="keep")
    dropped = _row(event_id="drop", event_date="20190805")
    served = gdelt._news_slice([kept, dropped])
    assert [d["event_id"] for d in served] == ["keep"]


def test_the_gate_does_not_change_what_event_fusion_sees():
    """_ACCUMULATED is shared with the conflict layer, which runs its own
    already-correct gates. Filtering rows out of the *store* would change
    fusion's input as a side effect of a news fix -- so the news gate runs at
    serve time and the accumulator keeps everything."""
    store = {}
    retrospective = _row(event_id="old", event_date="20190805")
    gdelt._accumulate(store, [retrospective])
    assert len(store) == 1, "the row is still there for event_fusion to judge"
    assert gdelt._news_slice(list(store.values())) == []


def test_the_officials_gate_rejects_a_retrospective():
    diplomatic = gdelt._parse_events(
        "\t".join(gdelt_row_diplomatic()) + "\n"
    )[0]
    assert gdelt._is_officials_row(diplomatic) is True

    retrospective = gdelt._parse_events(
        "\t".join(gdelt_row_diplomatic(sqldate="20190805")) + "\n"
    )[0]
    assert gdelt._is_officials_row(retrospective) is False


def test_the_officials_gate_rejects_a_commentary_url():
    commentary = gdelt._parse_events(
        "\t".join(gdelt_row_diplomatic(
            source_url="https://www.bbc.com/opinion/2026/what-the-summit-really-meant",
        )) + "\n"
    )[0]
    assert gdelt._is_officials_row(commentary) is False


def test_rehydrated_officials_rows_are_re_gated(monkeypatch):
    """_rehydrate writes straight into the store, bypassing _is_officials_row.
    Without a re-gate every deploy resurrects a full retention window of rows
    the current rules would reject, and the fix looks intermittently broken."""
    good = gdelt._parse_events("\t".join(gdelt_row_diplomatic()) + "\n")[0]
    stale = gdelt._parse_events(
        "\t".join(gdelt_row_diplomatic(event_id="9", sqldate="20190805")) + "\n"
    )[0]

    monkeypatch.setattr(gdelt, "_ACCUMULATED", {})
    monkeypatch.setattr(gdelt, "_ACCUMULATED_OFFICIALS", {})
    kept = [row for row in (good, stale) if gdelt._is_officials_row(row)]
    assert [r["event_id"] for r in kept] == [good["event_id"]]


# --- the counters ----------------------------------------------------------

def test_each_heuristic_keeps_its_own_count():
    """A single fused counter would say the gate dropped 40 rows and nothing
    about which heuristic started over-matching."""
    before = gdelt.recency_drop_counts()
    gdelt._is_current_report(_row(event_date="20190805"))
    gdelt._is_current_report(_row(source_url="https://www.theatlantic.com/magazine/2026/09/x/1/"))
    after = gdelt.recency_drop_counts()
    assert after["retrospective"] == before["retrospective"] + 1
    assert after["commentary"] == before["commentary"] + 1
    assert after["stale_url"] == before["stale_url"]


def test_a_clean_row_moves_no_counter():
    before = gdelt.recency_drop_counts()
    assert gdelt._is_current_report(_row()) is True
    assert gdelt.recency_drop_counts() == before
