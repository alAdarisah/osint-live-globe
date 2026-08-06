"""Who is behind a report, and when that is thin enough to act on.

Two things are being pinned down here, and they are deliberately separate
tests because they are separate decisions:

  the score    a masthead is the dominant input, and the gap between a wire
               service and an unvouched-for domain has to be wide enough that
               the map's colour and copy actually say different things about
               them.
  the screen   a low score never removes anything on its own. Removal takes a
               specific, checkable failure, and it may only ever be applied to
               something that already scored badly.

The second half is where the risk lives: a screen that could delete a real
event, or that could run on a well-sourced one, is worse than no screen.
"""

from datetime import date

from backend.sources import reliability as rl
from backend.sources import outlets as ol

TODAY = date(2026, 8, 6)


def _record(**overrides):
    """A plain GDELT-derived record: one unvouched-for outlet, fresh, headlined."""
    return {
        "source": "gdelt",
        "corroborated_by": ["gdelt"],
        "notes": "Blast reported in the city centre",
        "outlets": ["dailyblog.example"],
        "outlet_count": 1,
        "date": TODAY.isoformat(),
        "source_url": "https://dailyblog.example/news/blast",
        **overrides,
    }


def _scored(**overrides):
    record = _record(**overrides)
    record.update(rl.assess(record))
    return record


# --- outlet tiers ----------------------------------------------------------


def test_tiers_separate_wires_from_allowlist_from_everything_else():
    assert ol.outlet_tier("BBC News") == ol.TIER_MAJOR
    assert ol.outlet_tier("Reuters") == ol.TIER_MAJOR
    # The Kyiv Independent is a real newsroom on the allowlist, but it is not a
    # wire service -- the middle tier exists precisely so it is not flattened
    # into either neighbour.
    assert ol.outlet_tier("The Kyiv Independent") == ol.TIER_ESTABLISHED
    assert ol.outlet_tier("kyivpost.com") == ol.TIER_UNKNOWN
    assert ol.outlet_tier(None) == ol.TIER_UNKNOWN


def test_a_tier_can_be_read_off_a_domain_as_well_as_a_label():
    """Both forms are in circulation -- GDELT yields domains, merges yield labels."""
    assert ol.outlet_tier("bbc.co.uk") == ol.TIER_MAJOR
    assert ol.outlet_tier("www.edition.cnn.com") == ol.TIER_MAJOR
    # A lookalike must not inherit the masthead's tier.
    assert ol.outlet_tier("notreuters.com") == ol.TIER_UNKNOWN


def test_best_tier_takes_the_strongest_not_the_average():
    """Content farms republishing Reuters do not make Reuters less reliable."""
    names = ["seo-farm.example", "Reuters", "another-farm.example"]
    assert ol.best_tier(names) == ol.TIER_MAJOR
    assert ol.best_tier([]) == ol.TIER_UNKNOWN


# --- the score -------------------------------------------------------------


def test_a_major_newsroom_reads_as_reliable():
    scored = _scored(outlets=["BBC News"], source_url="https://www.bbc.com/news/world-1")
    assert scored["reliability_band"] == rl.BAND_HIGH
    assert scored["reliability_outlet"] == "BBC News"
    assert "major international newsroom" in scored["reliability_reasons"][0]


def test_an_unvouched_for_outlet_reads_as_unreliable():
    """The whole point: one anonymous domain is not evidence of an atrocity."""
    scored = _scored()
    assert scored["reliability_band"] == rl.BAND_VERY_LOW
    assert scored["reliability"] < rl.SCREEN_BELOW


def test_human_coded_datasets_outrank_any_newsroom():
    scored = _scored(source="acled", corroborated_by=["acled"], outlets=["Radio Dabanga"])
    assert scored["reliability_band"] == rl.BAND_HIGH


def test_breadth_lifts_a_weak_record_without_making_it_reliable():
    """Syndication is real evidence, but it is not a standards desk."""
    thin = _scored()
    wide = _scored(outlet_count=12)
    assert wide["reliability"] > thin["reliability"]
    assert wide["reliability_band"] != rl.BAND_HIGH


def test_a_contradicted_coordinate_costs_the_report_credibility():
    plain = _scored(outlets=["BBC News"], source_url="https://www.bbc.com/news/world-1")
    doubted = _scored(
        outlets=["BBC News"],
        source_url="https://www.bbc.com/news/world-1",
        geo_verdict="dateline_suspect",
    )
    assert doubted["reliability"] < plain["reliability"]


# --- news pins -------------------------------------------------------------
#
# Same scale, different record shape. What is being pinned down here is that the
# translation is faithful: a news pin and a conflict pin coded from the same
# article must not disagree about how much to trust it.


def _news(**overrides):
    """A raw GDELT news row, as gdelt.py accumulates it."""
    return {
        "real_title": "Air strike reported on the port",
        "outlets": ["Reuters"],
        "outlet_count": 1,
        "source_url": "https://www.reuters.com/world/strike-port",
        "corroborated_by": [],
        **overrides,
    }


def _scored_news(**overrides):
    item = _news(**overrides)
    item.update(rl.assess_news(item))
    return item


def test_a_news_pin_scores_on_the_same_scale_as_the_conflict_pin():
    """The same article, reaching the map by two routes, reads the same."""
    news = _scored_news()
    fused = _scored(
        outlets=["Reuters"],
        notes="Air strike reported on the port",
        source_url="https://www.reuters.com/world/strike-port",
    )
    assert news["reliability"] == fused["reliability"]
    assert news["reliability_band"] == rl.BAND_HIGH


def test_the_headline_is_read_from_the_news_field():
    """`notes` is the fused record's name for it; a news row keeps real_title."""
    with_headline = _scored_news()
    without = _scored_news(real_title=None)
    assert without["reliability"] < with_headline["reliability"]
    assert not any("coded fields only" in r for r in with_headline["reliability_reasons"])


def test_an_unvouched_for_news_domain_still_reads_as_weak():
    scored = _scored_news(
        outlets=["dailyblog.example"], source_url="https://dailyblog.example/news/strike"
    )
    assert scored["reliability_band"] in (rl.BAND_LOW, rl.BAND_VERY_LOW)


def test_a_matching_acled_record_corroborates_without_claiming_to_have_coded_it():
    """The lift is real; the sentence must not say an analyst read this article."""
    plain = _scored_news()
    matched = _scored_news(corroborated_by=["acled"])
    assert matched["reliability"] > plain["reliability"]
    assert any("ACLED separately records" in r for r in matched["reliability_reasons"])
    assert not any("human analyst" in r for r in matched["reliability_reasons"])


def test_corroboration_cannot_promote_an_unsourced_story_by_itself():
    """A dataset match near a content farm's story is evidence about the place,
    not a masthead behind the article."""
    scored = _scored_news(
        outlets=["dailyblog.example"],
        source_url="https://dailyblog.example/news/strike",
        corroborated_by=["acled", "ucdp"],
    )
    assert scored["reliability_band"] != rl.BAND_HIGH


# --- the screen ------------------------------------------------------------


def test_a_low_score_alone_removes_nothing():
    """A thin report is something to label, not something to delete."""
    assert rl.screen(_scored(), today=TODAY) == []


def test_an_unreliable_record_on_an_opinion_page_fails():
    failures = rl.screen(
        _scored(source_url="https://dailyblog.example/opinion/blast"), today=TODAY
    )
    assert failures and "opinion" in failures[0]


def test_an_unreliable_record_with_an_old_url_fails_as_stale():
    failures = rl.screen(
        _scored(source_url="https://dailyblog.example/2019/07/blast"), today=TODAY
    )
    assert any("dated" in f for f in failures)


def test_an_unreliable_record_dated_beyond_any_report_lag_fails():
    failures = rl.screen(_scored(date="2026-05-01"), today=TODAY)
    assert any("report lag" in f for f in failures)


def test_a_record_with_no_traceable_newsroom_fails():
    failures = rl.screen(
        _scored(outlets=[], outlet_count=0, source_url=None), today=TODAY
    )
    assert failures == ["no identifiable newsroom is behind it"]


def test_a_well_sourced_record_is_never_screened():
    """A Reuters commentary piece is a thing to say, not a thing to delete."""
    scored = _scored(outlets=["BBC News"], source_url="https://www.bbc.com/opinion/blast")
    assert scored["reliability"] >= rl.SCREEN_BELOW
    assert rl.screen(scored, today=TODAY) == []


def test_human_coded_records_are_exempt_from_the_screen_outright():
    """Belt and braces: no URL heuristic may ever delete ACLED data."""
    record = _scored(
        source="acled",
        corroborated_by=["acled"],
        source_url="https://dailyblog.example/archive/2001/09/attack",
        date="2001-09-11",
    )
    # Forced under the gate, to prove the exemption is the thing doing the work
    # rather than the score happening to be high.
    record["reliability"] = 1
    assert rl.screen(record, today=TODAY) == []
