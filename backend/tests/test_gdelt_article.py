"""What the article scrape now reads out of a page, and what it refuses to.

The scrape used to keep only the headline. It now also keeps a body excerpt and
the dateline, because those are what backend/sources/geoverify.py checks the
pin's location against. A false dateline is worse than no dateline -- it would
move a pin -- so most of these tests are about what does *not* parse.
"""

import pytest

from backend.sources import gdelt


# --- excerpt ---------------------------------------------------------------


def test_excerpt_takes_paragraph_text_in_order():
    html = """
      <html><body>
        <p>Russian forces struck a market in the centre of Kherson on Tuesday.</p>
        <p>Regional officials said at least three people were killed in the attack.</p>
      </body></html>
    """
    excerpt = gdelt.extract_excerpt(html)
    assert excerpt.startswith("Russian forces struck a market")
    assert "at least three people were killed" in excerpt


def test_excerpt_ignores_scripts_and_styles():
    """Script bodies carry place names in tracking payloads; letting them into
    the excerpt would feed the placement check confident nonsense."""
    html = """
      <html><head><style>.ad { background: url(kyiv.png); }</style></head>
      <body>
        <script>var geo = {"city": "Ashburn", "country": "US"};</script>
        <p>Shelling was reported in the eastern districts of Kharkiv overnight.</p>
      </body></html>
    """
    excerpt = gdelt.extract_excerpt(html)
    assert "Ashburn" not in excerpt
    assert "Kharkiv" in excerpt


def test_excerpt_skips_short_paragraphs():
    """One- and two-word paragraphs are bylines, timestamps and share prompts."""
    html = """
      <p>Share</p><p>By A. Reporter</p>
      <p>A drone strike hit an oil depot near Novorossiysk early on Wednesday.</p>
    """
    excerpt = gdelt.extract_excerpt(html)
    assert excerpt.startswith("A drone strike hit an oil depot")


def test_excerpt_is_capped():
    html = "".join(f"<p>{'word ' * 40}</p>" for _ in range(30))
    assert len(gdelt.extract_excerpt(html)) <= gdelt.MAX_EXCERPT_CHARS


def test_a_page_with_no_paragraphs_yields_no_excerpt():
    assert gdelt.extract_excerpt("<html><body><div>nav</div></body></html>") is None
    assert gdelt.extract_excerpt("") is None


def test_excerpt_unescapes_entities_and_collapses_whitespace():
    html = "<p>Forces  attacked\n  a depot &amp; a bridge near the front line today.</p>"
    assert gdelt.extract_excerpt(html) == (
        "Forces attacked a depot & a bridge near the front line today."
    )


# --- datelines that should parse -------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("KYIV, Aug 5 (Reuters) - Russian forces struck a market.", "KYIV"),
        ("KYIV (Reuters) - Russian forces struck a market.", "KYIV"),
        ("BEIRUT, Lebanon — Israeli aircraft hit targets in the south.", "BEIRUT"),
        ("WASHINGTON — The Pentagon said on Tuesday that it had.", "WASHINGTON"),
        ("CAIRO/BEIRUT, Aug 5 (Reuters) - Talks resumed on Tuesday.", "CAIRO"),
        ("NEW DELHI, August 5, 2026 — Officials confirmed the strike.", "NEW DELHI"),
        ("PORT-AU-PRINCE, Aug. 5 (AP) - Gangs seized the district.", "PORT-AU-PRINCE"),
        # Mixed-case house styles still read as datelines while most of the
        # letters are capitals.
        ("KYIV, Ukraine -- Shelling continued overnight.", "KYIV"),
    ],
)
def test_datelines_that_should_parse(text, expected):
    assert gdelt.extract_dateline(text) == expected


# --- datelines that must NOT parse -----------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # An ordinary sentence with a dash in it. Reading this as a dateline
        # would place a pin on the word "Officials".
        "Officials said on Tuesday - according to two people - that talks failed.",
        "The strike happened in the early hours — residents said.",
        # No separator at all.
        "KYIV Aug 5 Reuters Russian forces struck a market.",
        # Lower-case opening: not the dateline convention.
        "kyiv, aug 5 (reuters) - forces struck a market.",
        # Too many words to be a place name.
        "THE ENTIRE SOUTHERN COMMAND STRUCTURE OF THE ARMY — officials said.",
        "",
    ],
)
def test_datelines_that_must_not_parse(text):
    assert gdelt.extract_dateline(text) is None


def test_a_hyphenated_place_name_is_not_split_on_its_hyphen():
    """An unspaced hyphen must never count as the separator, or Port-au-Prince
    becomes "Port"."""
    assert gdelt.extract_dateline("PORT-AU-PRINCE — Gangs seized the district.") == "PORT-AU-PRINCE"


def test_the_agency_and_date_are_recognised_then_discarded():
    """They are how a dateline is identified; what the caller wants is a place
    it can look up in the gazetteer."""
    place = gdelt.extract_dateline("GENEVA, Aug 5, 2026 (Agence France-Presse) — Talks opened.")
    assert place == "GENEVA"


def test_a_dateline_far_into_the_text_is_ignored():
    """Datelines open the body. Anything deeper is a sentence with a dash."""
    text = "x" * 120 + " KYIV, Aug 5 (Reuters) - Forces struck a market."
    assert gdelt.extract_dateline(text) is None


# --- whole-page parse ------------------------------------------------------

_PAGE = """
<html><head>
  <meta property="og:title" content="Strike on Kherson market kills three" />
  <meta property="og:description" content="Regional officials reported casualties." />
  <title>Strike on Kherson market kills three | Example News</title>
</head><body>
  <p>KYIV, Aug 5 (Reuters) - Russian forces struck a market in Kherson on Tuesday,
     regional officials said, killing at least three people.</p>
</body></html>
"""


def test_parse_article_reads_all_four_fields_from_one_response():
    article = gdelt._parse_article(_PAGE)
    assert article.title == "Strike on Kherson market kills three"
    assert article.description == "Regional officials reported casualties."
    assert "struck a market in Kherson" in article.excerpt
    # The pin belongs in Kherson; the dateline says the story was filed from
    # Kyiv. Keeping them apart is the whole point.
    assert article.dateline == "KYIV"


def test_og_title_wins_over_the_title_tag():
    """The <title> tag carries the site name; og:title is the headline."""
    assert gdelt._parse_article(_PAGE).title == "Strike on Kherson market kills three"


def test_the_description_is_a_dateline_fallback_when_there_is_no_body():
    page = """
      <html><head>
        <meta name="description" content="BEIRUT — Aircraft struck southern villages." />
      </head><body></body></html>
    """
    article = gdelt._parse_article(page)
    assert article.excerpt is None
    assert article.dateline == "BEIRUT"


def test_an_empty_page_parses_to_all_none_rather_than_raising():
    article = gdelt._parse_article("")
    assert (article.title, article.description, article.excerpt, article.dateline) == (
        None, None, None, None,
    )


# --- carrying scraped text across polls ------------------------------------


def test_scraped_text_survives_the_accumulator():
    """It was earned by a network fetch, not published in the file. Losing it
    every 15 minutes would re-scrape the whole accumulator forever."""
    store = {}
    prior = {
        "event_id": "1", "source_url": "https://reuters.com/a", "geo_feature_id": "X",
        "mentions": 5, "real_title": "Strike on Kherson market",
        "article_excerpt": "KYIV, Aug 5 (Reuters) - Forces struck a market in Kherson.",
        "dateline_place": "KYIV",
    }
    gdelt._accumulate(store, [prior])
    fresh = {"event_id": "1", "source_url": "https://reuters.com/a", "geo_feature_id": "X",
             "mentions": 6}
    gdelt._accumulate(store, [fresh])

    kept = store[gdelt._conflict_key(fresh)]
    assert kept["dateline_place"] == "KYIV"
    assert "struck a market" in kept["article_excerpt"]


# --- which pages may be read, and what that permits ------------------------


def test_placement_evidence_may_be_read_from_outside_the_allowlist():
    """Measured over a live window, zero rows passing the violence gate had an
    allowlisted article attached. Gating the placement check on the allowlist
    left it reading nothing at all."""
    row = {"source_url": "https://www.manilatimes.net/2026/08/05/news/strike"}
    assert gdelt._title_url_for(row) is None
    assert gdelt._scrape_url_for(row) == row["source_url"]


def test_an_allowlisted_article_is_still_preferred():
    row = {"source_url": "https://example.blogspot.com/x",
           "mention_urls": ["https://www.reuters.com/world/y"]}
    assert gdelt._scrape_url_for(row) == "https://www.reuters.com/world/y"


def test_section_path_junk_is_still_excluded():
    """An opinion column is not a dispatch whatever domain it sits on."""
    assert gdelt._scrape_url_for(
        {"source_url": "https://www.manilatimes.net/opinion/2026/why-i-think"}
    ) is None


def test_a_row_with_no_url_at_all_is_not_scrapeable():
    assert gdelt._scrape_url_for({}) is None


def test_imprecise_rows_are_scraped_first():
    """They are the ones a placement check can improve: a country centroid has
    400 km of uncertainty to remove, a named town has almost none."""
    precise = {"geo_precision": "locality", "outlet_count": 40}
    imprecise = {"geo_precision": "country", "outlet_count": 1}
    assert sorted([precise, imprecise], key=gdelt._scrape_priority)[0] is imprecise


def test_reach_breaks_ties_between_equally_unplaceable_rows():
    quiet = {"geo_precision": "country", "outlet_count": 1}
    loud = {"geo_precision": "country", "outlet_count": 30}
    assert sorted([quiet, loud], key=gdelt._scrape_priority)[0] is loud


def test_a_looked_at_article_with_no_excerpt_is_not_overwritten_by_an_unscraped_row():
    """"Fetched, found nothing" and "not fetched" are different states: only the
    first licenses concluding the article names no place."""
    store = {}
    scraped = {"event_id": "2", "source_url": "https://apnews.com/b", "geo_feature_id": "Y",
               "mentions": 1, "real_title": "Headline",
               "article_excerpt": None, "dateline_place": None}
    gdelt._accumulate(store, [scraped])
    gdelt._accumulate(store, [{"event_id": "2", "source_url": "https://apnews.com/b",
                               "geo_feature_id": "Y", "mentions": 2}])

    kept = store[gdelt._conflict_key(scraped)]
    assert "article_excerpt" in kept
    assert kept["article_excerpt"] is None
