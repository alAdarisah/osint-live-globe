"""Parsing and classification for backend/sources/official_feeds.py.

Nothing here touches the network. The two fixtures in conftest are real feed
shapes: RSS 2.0 with the article URL in <link>'s text, and Atom with it in a
href attribute alongside a decoy rel="self" link.
"""

from datetime import datetime, timezone

from backend.sources import official_feeds as of
from backend.tests.conftest import ATOM_FEED, RSS_FEED

FEED = {
    "key": "example", "government": "Example Press Office", "country": "Exampleland",
    "lat": 12.5, "lon": -3.25, "url": "https://example.gov/feed",
}


def _parse(text):
    return of.parse_feed(text, FEED)


def test_parses_rss_items_with_links_and_dates():
    items = _parse(RSS_FEED)
    assert len(items) == 2
    newest = items[0]  # sorted newest-first
    assert newest["title"] == "Foreign Minister meets counterpart in Geneva"
    assert newest["url"] == "https://example.gov/news/geneva-talks"
    assert newest["published_at"] == datetime(2026, 8, 5, 10, 51, 5, tzinfo=timezone.utc).timestamp()
    # Publisher metadata comes from the feed table, not from the document.
    assert newest["government"] == "Example Press Office"
    assert (newest["lat"], newest["lon"]) == (12.5, -3.25)


def test_parses_atom_and_prefers_the_alternate_link():
    """rel="self" points at the feed itself. Taking the first <link> element --
    the obvious implementation -- links every entry back to the feed URL."""
    items = _parse(ATOM_FEED)
    assert len(items) == 1
    assert items[0]["url"] == "https://example.gov/news/sanctions"
    assert items[0]["published_at"] == datetime(
        2026, 8, 5, 9, 15, tzinfo=timezone(offset=__import__("datetime").timedelta(hours=1))
    ).timestamp()


def test_description_html_and_entities_are_stripped():
    body = _parse(RSS_FEED)[0]["summary"]
    assert "<p>" not in body
    assert "&amp;" not in body
    assert body == "The two ministers discussed & reviewed the ceasefire."


def test_summary_is_dropped_when_it_only_repeats_the_title():
    feed = RSS_FEED.replace(
        "<description>&lt;p&gt;The two ministers discussed &amp;amp; reviewed the ceasefire.&lt;/p&gt;</description>",
        "<description>Foreign Minister meets counterpart in Geneva</description>",
    )
    assert _parse(feed)[0]["summary"] is None


def test_items_without_a_title_or_link_are_dropped():
    """Both are required: one is what a reader sees, the other is the only way
    to check it. An entry with neither is not showable."""
    assert _parse(RSS_FEED.replace("<link>https://example.gov/news/geneva-talks</link>", "")) \
        == [i for i in _parse(RSS_FEED) if "geneva" not in i["url"]]


def test_id_is_stable_across_polls():
    """These feeds republish the same entries every ten minutes, so the id has
    to be a function of the article, not of when it was seen."""
    assert _parse(RSS_FEED)[0]["id"] == _parse(RSS_FEED)[0]["id"]
    assert _parse(RSS_FEED)[0]["id"] == "example:https://example.gov/news/geneva-talks"


# --- timestamps ------------------------------------------------------------

def test_parses_the_three_date_formats_these_feeds_actually_use():
    rfc822 = of._parse_when("Wed, 05 Aug 2026 10:51:05 +0000")
    iso = of._parse_when("2026-08-05T10:51:05+00:00")
    assert rfc822 == iso
    # The IAEA's own non-standard "YY-MM-DD  HH:MM", double space included.
    assert of._parse_when("26-07-30  12:15") == datetime(
        2026, 7, 30, 12, 15, tzinfo=timezone.utc
    ).timestamp()


def test_an_unparseable_date_falls_back_to_fetch_time_rather_than_dropping():
    """A government's own announcement is worth showing even when its feed
    stamps the date in a format nobody standardised."""
    feed = RSS_FEED.replace("Wed, 05 Aug 2026 10:51:05 +0000", "sometime last week")
    assert of._parse_when("sometime last week") is None
    items = of.parse_feed(feed, FEED, now=1_000_000.0)
    assert any(i["published_at"] == 1_000_000.0 for i in items)


# --- what kind of act ------------------------------------------------------

def test_classifies_the_common_press_release_shapes():
    assert of.classify_kind("Foreign Minister meets counterpart in Geneva") == "meeting"
    assert of.classify_kind("Telephone conversation with President of Brazil") == "meeting"
    assert of.classify_kind("Prime Minister to visit Kyiv") == "meeting"
    assert of.classify_kind("Sanctions imposed on three individuals") == "rupture"
    assert of.classify_kind("Ambassador recalled for consultations") == "rupture"
    assert of.classify_kind("Joint declaration signed on maritime security") == "agreement"
    assert of.classify_kind("Government condemns attack on civilians") == "demand"
    assert of.classify_kind("Remarks by the Commissioner on the budget") == "statement"


def test_the_most_consequential_reading_wins_when_a_title_matches_two():
    """"Sanctions imposed after talks collapse" is a rupture, not a meeting."""
    assert of.classify_kind("Sanctions imposed after talks collapse") == "rupture"
    assert of.classify_kind("Minister threatens to halt negotiations") == "threat"


def test_classification_ignores_the_body_text():
    """Searching the description too was tried and reversed the accuracy: a
    press-release body runs several paragraphs, so something matches nearly
    always. This pins the title-only rule."""
    title = "Presidential Message on the Birthday of the Coast Guard"
    assert of.classify_kind(title) == "statement"
    # classify_kind takes only a title -- a body that mentions a summit cannot
    # reach it. Asserted through parse_feed, which is where both are available.
    feed = RSS_FEED.replace(
        "Foreign Minister meets counterpart in Geneva", title,
    ).replace(
        "&lt;p&gt;The two ministers discussed &amp;amp; reviewed the ceasefire.&lt;/p&gt;",
        "The President will host a summit and hold talks with allies.",
    )
    assert next(i for i in _parse(feed) if i["title"] == title)["kind"] == "statement"
