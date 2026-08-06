"""How much to believe a conflict record, and what to do when the answer is
"almost nothing".

The map already had a 0-100 number attached to every event, and it was
answering the wrong question. `severity` is *how consequential* -- a mass
casualty event scores high whether the only source is Reuters or a domain
registered last week. The popup put that number under the heading "How much to
trust this", which is a category error a reader has no way to detect: a fabricated
massacre and a confirmed one score identically, because the score is about the
claim's size rather than its provenance.

So this module answers the provenance question separately.

  reliability        0-100. Who is behind this report, how many independent
                     newsrooms carried it, whether a human analyst coded it, and
                     whether anything about the page argues against it.
  reliability_band   the four buckets the UI actually renders. A bar without a
                     word next to it makes a reader guess where the thresholds
                     are.
  reliability_reasons  what moved the number, in the order it moved. Same
                     contract as severity_reasons: a bare "31/100" is not an
                     explanation, and here the explanation is the whole point.

The dominant input is the masthead (see outlets.outlet_tier). That is
deliberate and it is the thing the rest of this pipeline was missing: a wire
service and an unlabelled aggregator are not two samples of the same
distribution, and averaging them was letting the second inherit the map's
credibility from the first.

Breadth is counted separately from tier and cannot substitute for it. Forty
content farms republishing one another is one chain of custody, not forty --
the same distinction event_fusion draws between corroborated_by (datasets) and
outlet_count (newsrooms), extended one level down.

Both layers that pin a report score it here: the fused conflict records through
`assess`, and the GDELT news pins through `assess_news`, which is a translation
of the same function rather than a second one. Two popups asking "how much to
trust this" off two independently-tuned scales would be worse than one of them
not asking at all.

--- and then the screen -----------------------------------------------------

Scoring something as unreliable is not the same as removing it, and this module
does both, in that order and only in that order. A low score is a statement to
the reader: "this is thin, here is why". A removal is a statement the reader
cannot see, so it has to be earned by a specific, checkable failure rather than
by a low number.

That is what `screen` is. It runs *only* on records that already scored badly,
and it never returns a verdict of its own -- it returns the list of concrete
tests the record failed, each of which is a fact about the page rather than an
opinion about it:

  - the URL says the page is opinion, archive or magazine, not a dispatch
  - the URL's own publication date is months behind today
  - the event date is further behind today than any report lag can explain
  - no identifiable newsroom is behind it at all

A well-sourced record is never screened. If Reuters files an opinion column
about a strike, that is a thing the map should say ("commentary") rather than a
thing it should silently delete -- and it scores well enough that this code
never looks at it.
"""

import math
from datetime import date, datetime, timezone

from backend.sources.gdelt import MAX_REPORT_LAG_DAYS
from backend.sources.outlets import (
    TIER_ESTABLISHED,
    TIER_MAJOR,
    TIER_UNKNOWN,
    best_tier,
    count_at_tier,
    is_non_news_url,
    label_for_url,
    outlet_tier,
    url_age_months,
)

# Datasets where a human analyst read the reporting and coded the incident
# before it was published. Whatever the underlying newsrooms were, a record
# that reached ACLED or UCDP has been through a review step no news pipeline
# offers, and that is the strongest provenance available here.
_STRUCTURED_SOURCES = frozenset({"acled", "ucdp"})

# Where a record starts, before anything else is known about it.
#
# The gap between tiers is wide on purpose. Measured against a live window, the
# median GDELT conflict row is carried by one or two outlets and almost none of
# them are allowlisted -- so a gentle tier gradient would leave the whole layer
# in one band and the score would carry no information. These numbers put a
# lone unvouched-for domain in the bottom band on its own, which is the claim
# the map should be making about it, and let breadth and corroboration lift it
# out only by adding real evidence.
_BASE_STRUCTURED = 88
_BASE_BY_TIER = {
    TIER_MAJOR: 82,
    TIER_ESTABLISHED: 60,
    TIER_UNKNOWN: 20,
}
# Nothing names an outlet at all. Rare -- `outlets` normally holds at least a
# bare hostname -- and it means the record is a CAMEO code with no traceable
# page behind it.
_BASE_NO_OUTLET = 10

# How much independent breadth is worth. Logarithmic for the same reason the
# severity score's outlet term is: the step from one newsroom to three is the
# one that matters, and the step from thirty to forty is syndication.
_BREADTH_MAX = 12

# A second *dataset* recorded the same incident. Worth more per unit than
# breadth because it is a different method rather than a wider distribution of
# the same one.
_MULTI_DATASET_BONUS = 8

# The coordinate is doubted (geoverify's contested / dateline_suspect). Not
# fatal -- the event may well have happened, somewhere else -- but a report the
# pipeline has already caught misplacing itself is a report to read with more
# care.
_DOUBTED_PLACEMENT_PENALTY = 12

# No scraped headline: the record is CAMEO codes and nothing else, so there is
# no text anyone could check it against.
_NO_HEADLINE_PENALTY = 10

# The URL's section path says commentary/archive rather than dispatch. Priced
# in here as well as screened for below, so a well-sourced opinion piece still
# visibly loses ground without being deleted.
_NON_NEWS_PENALTY = 18

# The URL claims a publication date behind today. Per month, capped -- a
# two-month-old page in a live conflict feed is odd; a two-year-old one is a
# re-crawl.
_STALE_URL_PENALTY_PER_MONTH = 5
_STALE_URL_PENALTY_MAX = 20

BAND_HIGH = "high"
BAND_MEDIUM = "medium"
BAND_LOW = "low"
BAND_VERY_LOW = "very_low"

# Thresholds, and the words the UI puts next to the bar. Named here rather than
# in the frontend so the screen below and the label a reader sees can never
# disagree about what "unreliable" means.
_BANDS = (
    (70, BAND_HIGH),
    (45, BAND_MEDIUM),
    (25, BAND_LOW),
    (0, BAND_VERY_LOW),
)

# At or above this, `screen` is not run at all. It is the boundary between the
# two bottom bands and the rest: a record that reached "mixed" has either a
# newsroom we vouch for or real independent breadth behind it, and neither of
# those should be removable by a heuristic reading of a URL.
SCREEN_BELOW = 45

# How far behind today a URL's own claimed publication date has to be before it
# stops being lag and starts being a re-crawl of an old page. Three months is
# well beyond any newsroom's publication cycle and well inside the multi-year
# gap the failure mode actually produces.
STALE_URL_MONTHS = 3


def band_for(score: int) -> str:
    for floor, name in _BANDS:
        if score >= floor:
            return name
    return BAND_VERY_LOW


def _structured(record: dict) -> bool:
    if (record.get("source") or "") in _STRUCTURED_SOURCES:
        return True
    return any(s in _STRUCTURED_SOURCES for s in record.get("corroborated_by") or ())


def _article_url(record: dict) -> str | None:
    """The page this record was coded from, titled or not.

    source_url is withheld by event_fusion when no headline was ever scraped,
    because a link with nothing to put on it is not something a popup can show.
    That is a display rule and it must not reach here: "we never scraped this
    article's title" and "there is no article" are opposite claims, and the
    screen below deletes things on the strength of the second.
    """
    return record.get("source_url") or record.get("article_url")


def _outlet_names(record: dict) -> list[str]:
    """Every outlet name attached to the record, deduped.

    Three fields feed this and all three are needed. `outlets` is the ranked,
    capped display list; `verified_outlets` is the allowlisted subset, which
    survives on records archived before `outlets` shipped; and the article the
    record itself cites may name an outlet that the capped list dropped.
    """
    names = list(record.get("outlets") or [])
    names.extend(record.get("verified_outlets") or [])
    cited = label_for_url(_article_url(record))
    if cited:
        names.append(cited)
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def leading_outlet(record: dict) -> str | None:
    """The best-ranked outlet behind the record -- the one worth naming.

    This is what the popup says out loud ("Reported by BBC News"), so it has to
    be the outlet that earns the score rather than whichever name sorted first.
    """
    names = _outlet_names(record)
    if not names:
        return None
    return min(names, key=lambda name: (outlet_tier(name), name.lower()))


def assess(record: dict) -> dict:
    """The reliability fields for one merged conflict record.

    Returns overrides rather than mutating, the same contract geoverify.reconcile
    follows, so a caller can apply them with `record.update(assess(record))` and
    nothing here can quietly rewrite the record it was asked about.
    """
    reasons: list[str] = []
    names = _outlet_names(record)
    tier = best_tier(names)
    lead = leading_outlet(record)

    if _structured(record):
        score = float(_BASE_STRUCTURED)
        reasons.append("Coded from the underlying reporting by a human analyst")
    elif not names:
        score = float(_BASE_NO_OUTLET)
        reasons.append("No identifiable newsroom is behind this report")
    else:
        score = float(_BASE_BY_TIER[tier])
        if tier == TIER_MAJOR:
            reasons.append(f"Reported by {lead}, a major international newsroom")
        elif tier == TIER_ESTABLISHED:
            reasons.append(f"Reported by {lead}, an established newsroom")
        else:
            reasons.append(
                f"Reported by {lead}, which is not a newsroom this app vouches for"
            )

    # Breadth. Counted over the true total (outlet_count), not over the capped
    # display list, so a widely syndicated story is not penalised for the cap.
    outlet_count = record.get("outlet_count") or 0
    if outlet_count > 1:
        score += min(math.log10(outlet_count) * 14, _BREADTH_MAX)
        majors = count_at_tier(names, TIER_MAJOR)
        if majors > 1:
            reasons.append(f"Carried by {majors} major newsrooms independently")
        else:
            reasons.append(f"Carried by {outlet_count} newsrooms")

    datasets = len(record.get("corroborated_by") or ()) or 1
    if datasets > 1:
        score += _MULTI_DATASET_BONUS
        reasons.append(f"Recorded independently by {datasets} datasets")

    if not (record.get("notes") or "").strip():
        score -= _NO_HEADLINE_PENALTY
        reasons.append("No article text -- coded fields only")

    if record.get("geo_verdict") in ("contested", "dateline_suspect"):
        score -= _DOUBTED_PLACEMENT_PENALTY
        reasons.append("The reporting contradicts where this is pinned")

    source_url = _article_url(record)
    if is_non_news_url(source_url):
        score -= _NON_NEWS_PENALTY
        reasons.append("The source page is commentary or archive, not a dispatch")

    months = url_age_months(source_url)
    if months and months >= 1:
        score -= min(months * _STALE_URL_PENALTY_PER_MONTH, _STALE_URL_PENALTY_MAX)
        reasons.append(f"The source URL is dated {months} months before today")

    final = int(max(1, min(round(score), 99)))
    return {
        "reliability": final,
        "reliability_band": band_for(final),
        "reliability_tier": tier,
        "reliability_outlet": lead,
        "reliability_reasons": reasons,
    }


def assess_news(item: dict) -> dict:
    """The same fields for a News pin, which is one article rather than a cluster.

    The question is identical -- who is behind this and how much does that add
    up to -- and the answer has to be scored by the same code, or the map ends
    up with two "How much to trust this" bars calibrated differently and no way
    for a reader to know it. So this is a translation layer over `assess`, not a
    second scorer.

    Three of assess's inputs mean something else on a raw GDELT news row:

      real_title    is the headline. `notes` is the fused record's field name
                    and is absent here, which would otherwise charge every news
                    pin the "coded fields only" penalty for having a headline in
                    the wrong key.
      corroborated_by  names datasets that recorded a *nearby incident* (see
                    gdelt._corroborated_by), not datasets this record was built
                    from. Left to assess it would read as "a human analyst coded
                    this", which is a claim about an article nobody at ACLED has
                    seen. It is still real corroboration, so it is added back
                    below, priced the same and worded honestly.
      source        is unset on these rows; naming it keeps the structured-source
                    test from depending on a missing key.
    """
    view = dict(item)
    view["notes"] = (item.get("real_title") or "").strip()
    view["source"] = "gdelt"
    matched = [d for d in (item.get("corroborated_by") or ()) if d in _STRUCTURED_SOURCES]
    view["corroborated_by"] = []

    out = assess(view)
    if matched:
        score = int(min(99, out["reliability"] + _MULTI_DATASET_BONUS))
        names = "/".join(name.upper() for name in matched)
        out = {
            **out,
            "reliability": score,
            "reliability_band": band_for(score),
            "reliability_reasons": [
                *out["reliability_reasons"],
                f"{names} separately records an incident at this place and time",
            ],
        }
    return out


# --- the screen ------------------------------------------------------------


def _event_age_days(record: dict, today: date | None = None) -> int | None:
    """Whole days between the record's event date and today, or None.

    Reads `date` (the merged record's own YYYY-MM-DD), which is the only date
    field that survives clustering -- the per-member datetimes do not.
    """
    raw = (record.get("date") or "").strip()
    if not raw:
        return None
    try:
        when = datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None
    today = today or datetime.now(timezone.utc).date()
    return (today - when).days


def screen(record: dict, today: date | None = None) -> list[str]:
    """Concrete failures that disqualify an already-unreliable record.

    Returns an empty list for anything scoring at or above SCREEN_BELOW without
    looking at it -- the gate is the caller's contract as much as this
    function's, and putting it here means no call site can forget it.

    Human-coded records are exempt outright, belt and braces: they score far
    above the threshold anyway, and a heuristic that could ever delete ACLED
    data on the strength of a URL pattern is not one worth having.
    """
    if _structured(record):
        return []
    if (record.get("reliability") or 100) >= SCREEN_BELOW:
        return []

    failures: list[str] = []
    source_url = _article_url(record)

    if is_non_news_url(source_url):
        failures.append("the source page is an opinion, magazine or archive section")

    months = url_age_months(source_url)
    if months is not None and months >= STALE_URL_MONTHS:
        failures.append(f"the source URL is dated {months} months before today")

    age_days = _event_age_days(record, today)
    if age_days is not None and age_days > MAX_REPORT_LAG_DAYS:
        failures.append(
            f"the event is dated {age_days} days ago, beyond any plausible report lag"
        )

    # Genuinely untraceable: no outlet named anywhere *and* no page to trace it
    # back to. Both halves are required. Without the URL condition this fires on
    # the ordinary case of a row whose Mentions entry has not landed yet, which
    # is most of the conflict layer -- deleting those would empty the map on the
    # strength of a timing detail.
    if not _outlet_names(record) and not source_url:
        failures.append("no identifiable newsroom is behind it")

    return failures
