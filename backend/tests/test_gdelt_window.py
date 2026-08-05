"""The news window: what stays in the accumulator, for how long, and in what
order it is served.

These pin the three decisions that turned a 2h15m feed into a 24h one without
turning the map into a wall of pins:

  * retention is split by trust, because only a verified-domain row can ever
    become a News pin at all;
  * the served slice is ranked by decayed reach, because raw reach over 24h is
    a "biggest stories of the day" list rather than a live feed;
  * the slice is restricted to trusted rows, so a widened window cannot spend
    its budget on items that can never be shown.
"""

from datetime import datetime, timedelta, timezone

import pytest

from backend.sources import gdelt


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M%S")


def _row(event_id, *, hours_old=0.0, mentions=1, url="https://www.reuters.com/world/a",
         title=None, mention_urls=()):
    added = datetime.now(timezone.utc) - timedelta(hours=hours_old)
    row = {
        "event_id": event_id, "date_added": _stamp(added), "mentions": mentions,
        "source_url": url, "mention_urls": list(mention_urls), "quad_class": 4,
        "lat": 0.0, "lon": 0.0, "geo_feature_id": f"f{event_id}",
    }
    if title is not None:
        row["real_title"] = title
    return row


@pytest.fixture(autouse=True)
def _clean_accumulators():
    """These are module-level dicts that persist across polls by design."""
    gdelt._ACCUMULATED.clear()
    gdelt._ACCUMULATED_OFFICIALS.clear()
    yield
    gdelt._ACCUMULATED.clear()
    gdelt._ACCUMULATED_OFFICIALS.clear()


# --- retention -------------------------------------------------------------

def test_a_trusted_row_survives_the_full_day():
    store = {"a": _row("a", hours_old=20)}
    gdelt._prune(store, "test")
    assert "a" in store


def test_an_untrusted_row_is_dropped_at_the_short_window():
    """It can never be a News pin -- app.py requires a real_title, and titles
    are only ever scraped from the allowlist -- so holding it for 24h would
    multiply the accumulator to serve nobody. event_fusion loses nothing: it
    keeps its own 3-day copy and re-reads this store every 15 minutes."""
    store = {"a": _row("a", hours_old=4, url="https://daily-content-farm.example/x")}
    gdelt._prune(store, "test")
    assert store == {}


def test_an_untrusted_row_still_survives_the_fusion_window():
    store = {"a": _row("a", hours_old=1, url="https://daily-content-farm.example/x")}
    gdelt._prune(store, "test")
    assert "a" in store


def test_a_row_reachable_through_the_mentions_table_counts_as_trusted():
    """_title_url_for falls back to a verified-domain article that covered the
    same event, so a row whose own URL is a content farm can still get a real
    headline -- and therefore still deserves the long window."""
    store = {"a": _row("a", hours_old=20, url="https://daily-content-farm.example/x",
                       mention_urls=["https://apnews.com/article/x"])}
    gdelt._prune(store, "test")
    assert "a" in store


def test_a_row_past_the_full_day_is_dropped_even_when_trusted():
    store = {"a": _row("a", hours_old=30)}
    gdelt._prune(store, "test")
    assert store == {}


def test_an_undated_row_is_never_aged_out():
    """Dropping it would be discarding data on a missing field. The hard cap is
    what bounds these."""
    row = _row("a")
    row["date_added"] = ""
    store = {"a": row}
    gdelt._prune(store, "test")
    assert "a" in store


# --- ranking ---------------------------------------------------------------

def test_a_fresh_story_outranks_a_much_bigger_one_from_half_a_day_ago():
    """Raw reach was the old sort key. Over a 24h window it makes the feed a
    list of the day's biggest stories, so the map's most recent news is the
    news it never shows."""
    fresh = _row("fresh", hours_old=0.2, mentions=5)
    big_and_old = _row("old", hours_old=12, mentions=15)
    now = datetime.now(timezone.utc)
    assert gdelt._news_rank(fresh, now) > gdelt._news_rank(big_and_old, now)


def test_reach_still_decides_between_two_equally_recent_stories():
    now = datetime.now(timezone.utc)
    assert gdelt._news_rank(_row("a", mentions=40), now) > gdelt._news_rank(_row("b", mentions=2), now)


def test_a_brand_new_story_with_no_mentions_yet_is_still_rankable():
    """Over a 24h window a story ingested moments ago legitimately has no
    mention count. Multiplying by a flat zero would sink every one of them."""
    now = datetime.now(timezone.utc)
    assert gdelt._news_rank(_row("a", mentions=0), now) > 0


def test_the_served_slice_holds_only_trusted_rows():
    served = gdelt._news_slice([
        _row("trusted", title="Real headline"),
        _row("farm", url="https://daily-content-farm.example/x", title="Also a headline"),
    ])
    assert [r["event_id"] for r in served] == ["trusted"]


def test_the_slice_collapses_two_rows_citing_one_article():
    """The accumulator is keyed per (article, place) for the conflict layer's
    benefit; a news list wants one entry per headline."""
    url = "https://www.reuters.com/world/same-story"
    served = gdelt._news_slice([
        _row("a", url=url, mentions=3), _row("b", url=url, mentions=9),
    ])
    assert len(served) == 1
    assert served[0]["mentions"] == 9  # the better-covered copy wins


def test_the_ordering_is_stable_between_polls():
    """Two rows with identical reach and timestamp must not swap places, or the
    marker layer churns on every poll for no reason."""
    rows = [_row("b", mentions=4, url="https://www.reuters.com/b"),
            _row("a", mentions=4, url="https://www.reuters.com/a")]
    first = [r["event_id"] for r in gdelt._news_slice(rows)]
    second = [r["event_id"] for r in gdelt._news_slice(list(reversed(rows)))]
    assert first == second
