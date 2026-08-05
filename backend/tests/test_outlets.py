"""Outlet naming: labels, ranking, and the delimited strings ACLED/UCDP ship.

These are what turn "carried by 7 independent outlets" into seven names, so the
cases that matter are the ones where a name would otherwise be lost (subdomains,
duplicates across polls) or where the list could grow without bound.
"""

from backend.sources import outlets as ol


# --- labels ----------------------------------------------------------------

def test_allowlisted_domain_becomes_its_masthead():
    assert ol.outlet_label("reuters.com") == "Reuters"
    # Subdomains too -- GDELT's Mentions table reports plenty of them, and the
    # old set-intersection check missed every one.
    assert ol.outlet_label("edition.cnn.com") == "CNN"
    assert ol.outlet_label("www.bbc.co.uk") == "BBC News"


def test_unknown_domain_keeps_its_own_host():
    """Naming an unvouched-for outlet is the point; hiding it was the bug."""
    assert ol.outlet_label("kyivpost.com") == "kyivpost.com"
    assert ol.outlet_label("www.sudantribune.com") == "sudantribune.com"
    assert ol.outlet_label("MIXED.Case.example") == "mixed.case.example"


def test_label_of_a_lookalike_domain_is_not_the_masthead():
    # endswith("." + domain) must not match a domain that merely ends in the
    # same characters -- "notreuters.com" is not Reuters.
    assert ol.outlet_label("notreuters.com") == "notreuters.com"


# --- news dispatch vs. commentary -------------------------------------------
#
# The allowlist says whether we trust the newsroom. These say whether the page
# is a report of something that just happened -- a different question, and the
# one a live map actually needs answered.

def test_magazine_and_opinion_sections_are_not_news_dispatches():
    """The exact URL that put a suicide bombing on the map in Tunisia, dated
    today, out of a 25-year 9/11 retrospective."""
    assert ol.is_non_news_url(
        "https://www.theatlantic.com/magazine/2026/09/al-qaeda-25-years-post-9-11/687965/"
    )
    assert ol.is_non_news_url("https://www.kyivpost.com/opinion/81739")
    assert ol.is_non_news_url(
        "https://www.reviewjournal.com/opinion/opinion-columns/victor-joecks/how-gun-control-fails"
    )


def test_ordinary_reporting_is_not_rejected():
    assert not ol.is_non_news_url("https://www.reuters.com/world/europe/strike-on-kherson-2026-08-05/")
    assert not ol.is_non_news_url("https://apnews.com/article/sudan-rsf-omdurman-abc123")
    # A topic desk is still a news desk: a bombing filed under business or
    # sport is still a bombing.
    assert not ol.is_non_news_url("https://www.bbc.com/news/business-12345")
    assert not ol.is_non_news_url(None)
    assert not ol.is_non_news_url("not a url")


def test_the_article_slug_is_never_matched():
    """Section segments only. These words appear constantly in headlines, and
    matching them there would reject real dispatches."""
    assert not ol.is_non_news_url("https://www.reuters.com/world/un-review-of-gaza-ceasefire-2026")
    assert not ol.is_non_news_url("https://apnews.com/article/opinion-polls-shift-in-kyiv")
    # The hostname is not the path -- reviewjournal.com is a newspaper.
    assert not ol.is_non_news_url("https://www.reviewjournal.com/news/shooting-on-the-strip")


# --- ranking and the cap ---------------------------------------------------

def test_mastheads_rank_ahead_of_bare_domains():
    ranked = ol.rank_outlets(["zzz-local.example", "Reuters", "aaa-local.example", "BBC News"])
    assert ranked == ["BBC News", "Reuters", "aaa-local.example", "zzz-local.example"]


def test_ranking_dedupes_and_drops_blanks():
    assert ol.rank_outlets(["Reuters", "Reuters", "", None]) == ["Reuters"]


def test_the_cited_article_s_outlet_leads_the_list():
    """The popup links to one article; the names must not contradict it."""
    ranked = ol.rank_outlets(
        ["aol.co.uk", "Reuters", "express.co.uk"], preferred="express.co.uk"
    )
    assert ranked == ["express.co.uk", "Reuters", "aol.co.uk"]
    # No preference given (or one not among the names): mastheads still lead.
    assert ol.rank_outlets(["aol.co.uk", "Reuters"]) == ["Reuters", "aol.co.uk"]
    assert ol.rank_outlets(["aol.co.uk", "Reuters"], preferred="absent.example") == \
        ["Reuters", "aol.co.uk"]


def test_the_cited_outlet_survives_the_cap():
    """The alphabet used to decide this: a story on 35 near-identical local
    sites kept the A-to-D ones and dropped the outlet actually being linked."""
    syndicated = [f"{c}town-news.example" for c in "abcdefghijkl"] + ["zed-herald.example"]
    ranked = ol.rank_outlets(syndicated, preferred="zed-herald.example")
    assert ranked[0] == "zed-herald.example"
    assert len(ranked) == ol.MAX_OUTLET_NAMES


def test_label_for_url_reads_the_outlet_off_an_article_link():
    assert ol.label_for_url("https://www.express.co.uk/news/1") == "express.co.uk"
    assert ol.label_for_url("https://edition.cnn.com/x") == "CNN"
    assert ol.label_for_url(None) is None
    assert ol.label_for_url("not a url") is None


def test_list_is_capped_and_keeps_the_recognisable_names():
    """A viral story can be carried by dozens of outlets; the payload can't."""
    many = [f"local-{i}.example" for i in range(40)] + ["Reuters", "AP News"]
    ranked = ol.rank_outlets(many)
    assert len(ranked) == ol.MAX_OUTLET_NAMES
    assert ranked[:2] == ["AP News", "Reuters"], "mastheads survive the cut"


def test_unioning_two_capped_lists_stays_capped():
    # gdelt.py re-ranks accumulated lists on every poll rather than
    # concatenating them -- this is the invariant that makes that safe.
    first = ol.rank_outlets(f"a-{i}.example" for i in range(8))
    second = ol.rank_outlets(f"b-{i}.example" for i in range(8))
    assert len(ol.rank_outlets(first + second)) == ol.MAX_OUTLET_NAMES


# --- ACLED/UCDP source strings ---------------------------------------------

def test_delimited_source_strings_split_into_names():
    assert ol.split_outlet_names("Radio Dabanga; Sudan Tribune") == ["Radio Dabanga", "Sudan Tribune"]
    # UCDP's candidate CSV mixes both delimiters.
    assert ol.split_outlet_names("Xinhua|Agence France Presse") == ["Xinhua", "Agence France Presse"]


def test_source_string_order_is_preserved():
    """ACLED lists its primary source first, and that ordering is information."""
    assert ol.split_outlet_names("Zamfara Times; AFP") == ["Zamfara Times", "AFP"]


def test_source_string_drops_blanks_and_duplicates():
    assert ol.split_outlet_names("AFP;; AFP ;Reuters") == ["AFP", "Reuters"]
    assert ol.split_outlet_names("") == []
    assert ol.split_outlet_names(None) == []


def test_long_citations_are_truncated_not_dropped():
    # UCDP's source_article is a whole citation. The outlet is the first few
    # words, so truncating keeps the useful part rather than losing the row.
    citation = "Agence France Presse, 'Sudan army says it has retaken the city', 12 March 2026, page 4"
    (name,) = ol.split_outlet_names(citation)
    assert name.startswith("Agence France Presse")
    assert len(name) <= 60


def test_source_string_is_capped_like_every_other_outlet_list():
    crowded = ";".join(f"Outlet {i}" for i in range(30))
    assert len(ol.split_outlet_names(crowded)) == ol.MAX_OUTLET_NAMES
