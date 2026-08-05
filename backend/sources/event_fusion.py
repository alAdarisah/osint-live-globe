import asyncio
import logging
import math
import os
import re
import time
from datetime import datetime, timezone

from backend import config, storage
from backend.cache import registry
from backend.sources import proximity
# The CAMEO vocabulary moved to its own module: officials.py renders the
# diplomatic half of the same taxonomy (roots 01-17) and would otherwise have to
# import this fusion pipeline for a lookup dict. Bound to the private names this
# module has always used so its call sites are unchanged.
from backend.sources.cameo import (
    ACTOR_TYPE_LABEL as CAMEO_ACTOR_TYPE_LABEL,  # noqa: F401 - re-exported
    CODE_LABEL as CAMEO_CODE_LABEL,  # noqa: F401 - re-exported
    CODE_SENTENCE as CAMEO_CODE_SENTENCE,  # noqa: F401 - re-exported
    ROOT_LABEL as CAMEO_ROOT_LABEL,  # noqa: F401 - re-exported
    ROOT_SENTENCE as CAMEO_ROOT_SENTENCE,  # noqa: F401 - re-exported
    cameo_label as _cameo_label,
    cameo_sentence as _cameo_sentence,
    clean_location as _clean_location,
    country_from_location as _country_from_location,
    pretty_actor as _pretty_actor,
)
from backend.sources.outlets import is_non_news_url, label_for_url, rank_outlets

log = logging.getLogger("osint-globe.event_fusion")

# One real event can reach this pipeline up to three times: as an ACLED row,
# as a UCDP row (both via acled.py's combined list), and as a GDELT
# structured conflict event (gdelt.py, quad_class 3/4 -- see that module's
# _parse_events, which no longer requires a verified news domain). Rendering
# all three as separate map pins is exactly the "icons on top of each other
# for the same incident" problem -- this module's only job is to collapse
# same-event rows across those three inputs into one canonical record before
# anything gets drawn.

# Same 3-bucket vocabulary acled.py's UCDP rows already use (UCDP_VIOLENCE_TYPE),
# reused here so a GDELT-only cluster (no ACLED/UCDP match) still lands in the
# same event_type taxonomy the frontend already renders icons for.
_STATE_ACTOR_WORDS = (
    "military", "army", "troops", "soldiers", "government forces", "air force",
    "navy", "police", "security forces", "national guard", "regime forces",
)
_NONSTATE_ACTOR_WORDS = (
    "militia", "rebels", "insurgents", "guerrilla", "separatists", "gunmen",
    "militants", "fighters", "cartel", "gang",
)
_ONESIDED_WORDS = (
    "civilians", "massacre", "executed", "ethnic cleansing", "genocide",
    "targeted civilians", "protesters killed", "unarmed",
)

_CASUALTY_RE = re.compile(
    r"(\d+)\s*(?:people\s+)?(?:were\s+)?(?:reportedly\s+)?(killed|kills?|dead|died|wounded|injured)",
    re.IGNORECASE,
)
_CASUALTY_RE_VERB_FIRST = re.compile(r"kills?\s+(\d+)", re.IGNORECASE)

# CAMEO root codes that describe actual violence. GDELT's conflict feed is
# split across two "quad classes": 3 is *Verbal* Conflict (accusations,
# denials, demands, political statements) and 4 is Material Conflict. Only
# the material half belongs on a map billed as "Conflict & Violence" -- with
# both, 72% of this layer was verbal and 42% of it was inside the United
# States, i.e. domestic political reporting rather than armed conflict.
#
# Filtering here rather than in gdelt.py is deliberate: gdelt.py's parsed
# feed also backs /api/news, which *wants* the broad political picture. The
# narrow violence gate belongs at the point those rows become conflict
# candidates, so the two layers can disagree about what's relevant.
#
# 17 (COERCE) is material but covers arrests, expulsions and censorship, so
# it's excluded -- repression, not violence. ACLED/UCDP rows bypass this
# entirely; they're already curated conflict data.
VIOLENCE_ROOT_CODES = {18, 19, 20}

# Violence-typed is necessary but not sufficient. GDELT codes a great deal of
# ordinary domestic crime as FIGHT/ASSAULT, and because its corpus is
# dominated by US local media, filtering on event type alone still left 43%
# of this layer inside the United States -- real violence, but not armed
# conflict, which is what the map is for.
#
# CAMEO also classifies each actor by *type*, and requiring at least one
# armed party is what separates a battle from a bar fight. COP (police) is
# deliberately excluded: including it re-admits the entire domestic crime
# blotter. GOV/CVL likewise -- a government spokesman being "attacked"
# rhetorically is not a conflict event.
ARMED_ACTOR_TYPES = {
    "MIL",  # military
    "REB",  # rebels
    "INS",  # insurgents
    "SEP",  # separatists
    "PAR",  # paramilitary
    "UAF",  # unaligned armed forces
    "SPY",  # intelligence services
}

# A GDELT structured event and an ACLED/UCDP row describing the same
# incident should land within a few days and ~55km of each other even
# accounting for reporting lag / geocoding imprecision on either side. Same
# thresholds the old conflict_watch.py used for its (narrower) UCDP<->GDELT
# matching, generalized here to run across all three input buckets.
_MATCH_DAYS = 2

# Kilometres, not degrees. The old threshold was 0.5 degrees in each axis,
# which is ~55 km east-west at the equator but ~35 km at 50N and ~28 km at
# 60N -- so the clusterer was quietly stricter in Ukraine than in the Sahel,
# for no reason anyone chose.
_MATCH_KM = 50.0

# Spatial hash cell size. Must be at least _MATCH_KM/111 degrees so the
# neighbourhood scan can reach the full radius; the longitude reach is widened
# per-latitude by proximity.lon_cells_for_radius.
_CELL_DEG = 0.5

# ACLED/UCDP carry real structured fields (actor names, a reviewed fatality
# count); GDELT is CAMEO-coded with no fatality field of its own. When a
# cluster spans sources, the richest one should supply the record's core
# fields -- this is that priority order, low number wins.
_SOURCE_PRIORITY = {"acled": 0, "ucdp": 1, "gdelt": 2}

# --- cluster identity ------------------------------------------------------
#
# A fused record's id used to be "{primary_source}:{primary_id}", derived fresh
# every poll. That changes the moment cluster membership changes -- a new
# report arriving, or a higher-priority source joining -- and since
# conflict_events is keyed on id, a changed id inserts a *new* row with a fresh
# first_seen. escalation.py counts first_seen. So every re-key manufactured a
# brand-new "incident" out of an incident we had already been watching.
#
# Instead: a cluster inherits whichever id its members already carried, and
# only a genuinely new cluster mints one. Both maps are rebuilt from the
# current clusters each poll, so they prune themselves.
_cluster_id_by_member: dict[str, str] = {}
_cluster_minted_at: dict[str, float] = {}


def _member_key(item: dict) -> str:
    return f"{item['source']}:{item['id']}"


def _stable_cluster_id(cluster: list[dict], now: float) -> tuple[str, list[str]]:
    """Return (cluster_id, superseded_ids).

    When a new report bridges two clusters that were previously separate, the
    id minted earliest wins and the other is returned as superseded -- the
    caller deletes it, because leaving it in the archive would let one incident
    be counted twice.
    """
    known = {_cluster_id_by_member[_member_key(m)]
             for m in cluster if _member_key(m) in _cluster_id_by_member}
    if known:
        # Earliest mint wins; ties broken on the id itself so the outcome never
        # depends on set iteration order.
        winner = min(known, key=lambda cid: (_cluster_minted_at.get(cid, now), cid))
        return winner, sorted(known - {winner})

    # Genuinely new. Seed on the earliest-observed member, falling back to
    # source priority and then the id, so the same cluster always mints the
    # same value regardless of the order _fuse happened to walk it.
    seed = min(
        cluster,
        key=lambda m: (
            m.get("seen_at") if m.get("seen_at") is not None else float("inf"),
            _SOURCE_PRIORITY.get(m["source"], 9),
            str(m["id"]),
        ),
    )
    return _member_key(seed), []

# There used to be a module-level set of "consumed" GDELT ids here, which
# app.py's /api/news filter read in order to *delete* any headline that had
# become part of a conflict pin. That deduplicated the map at the cost of the
# text: the article existed nowhere afterwards, not in the news feed, not in
# the country card, and not on the pin that had absorbed it.
#
# The record now carries the headlines instead (see _coverage_for) plus the
# news ids they came from, and the frontend suppresses the duplicate marker
# from that. Same one-pin-per-incident result, nothing thrown away.

# Cluster ids that lost a merge on the most recent poll -- see
# _stable_cluster_id. start() deletes these from the archive.
_superseded_ids: list[str] = []


def _classify(text: str) -> tuple[str, str | None]:
    lowered = text.lower()
    if any(w in lowered for w in _ONESIDED_WORDS):
        return "One-sided violence", "One-sided violence"
    has_state = any(w in lowered for w in _STATE_ACTOR_WORDS)
    has_nonstate = any(w in lowered for w in _NONSTATE_ACTOR_WORDS)
    if has_state:
        return "State-based armed conflict", "State-based armed conflict"
    if has_nonstate:
        return "Non-state conflict", "Non-state conflict"
    return "Conflict event", None


def _extract_fatalities(text: str) -> int:
    best = 0
    for match in _CASUALTY_RE.finditer(text):
        if match.group(2).lower() in ("killed", "kill", "kills", "dead", "died"):
            best = max(best, int(match.group(1)))
    for match in _CASUALTY_RE_VERB_FIRST.finditer(text):
        best = max(best, int(match.group(1)))
    return best


def _parse_structured_dt(s: str | None):
    # ACLED event_date / UCDP date, both "YYYY-MM-DD".
    if not s:
        return None
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _parse_gdelt_dt(s: str | None):
    # Both GDELT date fields start "YYYYMMDD" -- SQLDATE is exactly that,
    # DATEADDED is "YYYYMMDDHHMMSS".
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


# SQLDATE is when the event is reported to have *happened*; DATEADDED is when
# GDELT ingested the article. Using the latter as the event date (the old
# behaviour) meant a story published today about a 2014 massacre was dated
# today. Using the former without a guard means that same story is plotted as
# a live event with a 2014 date.
#
# So: take SQLDATE, but treat a large gap as retrospective reporting and drop
# the row. Deliberately generous -- this is a sanity gate, not the map's
# recency window, which lives in the frontend filter. Measured over a 12h live
# window, 96.6% of violent rows are same-day and 2.3% exceed 30 days (the
# worst being a full year), so this cuts the retrospectives without touching
# ordinary reporting lag. The drop count is logged rather than silent: if this
# assumption is ever wrong, it would empty the layer, and that must be visible.
_MAX_REPORT_LAG_DAYS = 30
_dropped_retrospective = 0


def _gdelt_event_dt(raw: dict):
    """The event's own date, or None if it looks retrospective."""
    global _dropped_retrospective
    added = _parse_gdelt_dt(raw.get("date_added"))
    occurred = _parse_gdelt_dt(raw.get("event_date"))
    if occurred is None:
        return added  # no SQLDATE to work with; ingest time is the best available
    if added is not None and (added - occurred).days > _MAX_REPORT_LAG_DAYS:
        _dropped_retrospective += 1
        return None
    return occurred


def _build_summary(record: dict) -> str | None:
    """A plain sentence for what CAMEO coded, or None when there is nothing to say.

    This is a *rendering* of structured fields, not a new claim: every word comes
    from the event code and the two actor slots. The frontend prints it under a
    provenance line saying exactly that, which is the part that keeps it honest.

    Violence roots only. cameo.py's sentence table covers all 20 CAMEO roots
    now that officials.py renders the diplomatic half, so without this guard a
    row that reached here mis-coded ("Russia visited Ukraine") would be
    described on a pin the map labels Conflict & Violence.
    """
    if record.get("event_root_code") not in VIOLENCE_ROOT_CODES:
        return None
    verb = _cameo_sentence(
        record.get("event_code"), record.get("event_base_code"), record.get("event_root_code")
    )
    if not verb:
        return None
    actor1 = _pretty_actor(record.get("actor1"), record.get("actor1_group"), record.get("actor1_type"))
    actor2 = _pretty_actor(record.get("actor2"), record.get("actor2_group"), record.get("actor2_type"))
    where = _clean_location(record.get("location")) or record.get("country")

    if actor1 and actor2:
        sentence = f"{actor1} {verb} {actor2}"
    elif actor1:
        # No target coded. Drop the dangling preposition rather than leaving
        # "Russian armed forces carried out an air strike on ." on screen.
        sentence = f"{actor1} {verb.rstrip()}".rstrip()
        for tail in (" on", " against", " with", " of", " held by", " to"):
            if sentence.endswith(tail):
                sentence = sentence[: -len(tail)]
                break
    elif actor2:
        sentence = f"{actor2} was targeted"
    else:
        return None

    if where:
        sentence = f"{sentence} in {where}"
    return f"{sentence}."


def _normalize_structured(source: str, raw: dict) -> dict:
    return {
        "source": source,
        "id": raw.get("id"),
        "lat": raw.get("lat"),
        "lon": raw.get("lon"),
        # ACLED and UCDP geocode to a named place, not a country centroid, so
        # their rows are locality-precision by construction. (ACLED does carry
        # its own geo_precision field; it isn't requested in acled.py's
        # `fields` param, and its coarsest level is still finer than GDELT's
        # country centroid.)
        "geo_precision": "locality",
        "geo_feature_id": None,
        "dt": _parse_structured_dt(raw.get("date")),
        "event_type": raw.get("event_type"),
        "sub_event_type": raw.get("sub_event_type"),
        "event_code": None,  # CAMEO-specific; ACLED/UCDP use their own taxonomy
        "event_root_code": None,
        "location": raw.get("location") or raw.get("country"),
        "actor1": raw.get("actor1"),
        "actor2": raw.get("actor2"),
        "actor1_type": None,   # CAMEO-specific
        "actor2_type": None,
        "actor1_group": None,
        "actor2_group": None,
        "event_base_code": None,
        "fatalities": raw.get("fatalities") or 0,
        # ACLED and UCDP report a death count for every row, including a real
        # zero. GDELT does not (see _normalize_gdelt), and conflating "reported
        # as none" with "not reported" is what put "Fatalities: 0" on pins where
        # nobody had counted anything.
        "fatalities_reported": True,
        "country": raw.get("country"),
        "notes": raw.get("notes"),
        # The newsrooms ACLED/UCDP coded the event from (their own `source` /
        # `source_article` columns, parsed in acled.py). Same field as GDELT's
        # Mentions-derived list, so _merge_cluster can union the two.
        "outlets": raw.get("outlets") or [],
    }


def _normalize_gdelt(raw: dict) -> dict:
    headline = (raw.get("real_title") or "").strip()
    location = raw.get("location") or None
    text = f"{headline} {location or ''}".strip()
    fatalities = _extract_fatalities(text) if headline else 0
    if headline:
        event_type, sub_event_type = _classify(text)
    else:
        # No real headline to run the keyword classifier over (most GDELT
        # rows -- title backfill only runs for verified-domain source_urls,
        # see gdelt.py) -- a bare location string ("New York, United
        # States") never contains a conflict keyword, so classifying off it
        # alone would just silently reproduce this same generic fallback.
        # CAMEO's own category is always present regardless of a headline, and
        # the full event code says what actually happened ("Aerial
        # bombardment") where the root code only says "Fighting".
        event_type = _cameo_label(
            raw.get("event_code"), raw.get("event_base_code"), raw.get("event_root_code")
        ) or "Conflict event"
        sub_event_type = None
    return {
        "source": "gdelt",
        "id": raw.get("event_id"),
        "lat": raw.get("lat"),
        "lon": raw.get("lon"),
        "geo_precision": raw.get("geo_precision") or "unknown",
        "geo_feature_id": raw.get("geo_feature_id"),
        # Kept alongside the human label so _cluster can require two rows
        # sharing a place to also describe the same kind of act.
        "event_root_code": raw.get("event_root_code"),
        # When *we* first saw this row, preserved across polls by
        # _accumulate_violent_gdelt. Distinct from both dt (when the event
        # happened) and date_added (when GDELT ingested the article): it is the
        # only field with sub-day resolution, which is what age-based fading on
        # the map needs to tell a 1-hour-old event from a 23-hour-old one.
        "seen_at": raw.get("_seen_at"),
        "dt": _gdelt_event_dt(raw),
        "event_type": event_type,
        "sub_event_type": sub_event_type,
        "event_code": raw.get("event_code"),
        "event_base_code": raw.get("event_base_code"),
        "actor1": raw.get("actor1"),
        "actor2": raw.get("actor2"),
        # Parsed by gdelt.py and, until now, dropped here. They are what turns
        # "Actor 1: ISRAELI / Actor 2: JOURNALIST" into a sentence with a
        # direction and a role in it (see _build_summary).
        "actor1_type": raw.get("actor1_type"),
        "actor2_type": raw.get("actor2_type"),
        "actor1_group": raw.get("actor1_group"),
        "actor2_group": raw.get("actor2_group"),
        "fatalities": fatalities,
        # GDELT never reports a casualty count. The only number available is
        # whatever _extract_fatalities can pull out of a scraped headline, and
        # for most rows there is no headline at all -- so a 0 here means "not
        # reported", which is a different statement from "nobody was hurt" and
        # must not be rendered as one.
        "fatalities_reported": fatalities > 0,
        # The place string and the country are two different things; conflating
        # them is why country cards never matched a GDELT event.
        "location": _clean_location(location),
        "country": _country_from_location(location),
        "notes": headline or None,
        # Extra GDELT-only signals with no ACLED/UCDP equivalent -- carried
        # through _merge_cluster below so the frontend can show "how many
        # outlets/mentions" and "how intense" even without a real headline.
        "mentions": raw.get("mentions") or 0,
        # Distinct newsrooms, from the Mentions table (see gdelt._fetch_window):
        # how many carried it, and (capped, see outlets.py) which ones.
        "outlet_count": raw.get("outlet_count") or 0,
        "outlets": raw.get("outlets") or [],
        "verified_outlets": raw.get("verified_outlets") or [],
        "goldstein": raw.get("goldstein"),
        "avg_tone": raw.get("avg_tone"),
        "source_url": raw.get("source_url") if headline else None,
        # The three fields a merged headline needs in order to survive as
        # *coverage* on the fused record rather than being deleted from the
        # news feed. source_name is the masthead, date_added is when GDELT
        # ingested the article (the only sub-day timestamp GDELT publishes),
        # and the id is what the frontend matches against to know this
        # headline already has a pin and must not be drawn a second time.
        #
        # Kept unconditionally, unlike source_url above: a cluster member with
        # no headline of its own still owns a news id that has to be
        # suppressed, otherwise the untitled row reappears as a bare News pin
        # on top of the conflict pin it belongs to.
        "source_name": raw.get("source_name"),
        "date_added": raw.get("date_added"),
        "mention_urls": raw.get("mention_urls") or [],
    }


# --- severity -------------------------------------------------------------
#
# A single 0-100 number so the map can make consequential events visually
# louder than minor ones, and so the notable-events ranking has something
# principled to sort on.
#
# Three parts, deliberately not one additive sum:
#
#   magnitude   what happened -- type, casualties, how widely carried
#   confidence  how sure we are it happened as described. A MULTIPLIER,
#               because one blog's single article about a "battle" is not 90%
#               of a battle confirmed by twelve newsrooms. Summing confidence
#               into magnitude (the old shape) meant a completely unverified
#               row still scored 25-45, i.e. above the notable-events floor of
#               40, so noise rendered orange and reached the alert panel.
#   evidence    independent confirmation -- a second dataset, a physical
#               signal. ADDED outside the discount, so a lone-outlet report
#               that ACLED also recorded is not penalised for being
#               lone-outlet.
_SEVERITY_BASE = {
    # Mass violence and civilian targeting first: these are the categories the
    # map exists to surface.
    "Ethnic cleansing": 50,
    "Mass killing": 50,
    "Weapons of mass destruction": 55,
    "Mass expulsion": 45,
    "Mass violence": 45,
    "One-sided violence": 45,
    "Unconventional mass violence": 45,
    "Suicide bombing": 45,
    "Aerial bombardment": 45,
    "Violence against civilians": 40,
    "State-based armed conflict": 40,
    "Artillery or armour": 40,
    "Vehicle bombing": 40,
    "Roadside bombing": 38,
    "Assassination": 38,
    "Bombing": 38,
    "Blockade or siege": 36,
    "Small-arms fighting": 35,
    "Fighting": 35,
    "Non-state conflict": 35,
    "Battle": 35,
    "Explosion": 35,
    "Ceasefire violation": 33,
    "Killing": 33,
    "Abduction or hostage-taking": 32,
    "Occupation of territory": 30,
    "Assault": 30,
    "Physical assault": 30,
    "Use of conventional force": 28,
    "Unconventional violence": 28,
}
_SEVERITY_DEFAULT_BASE = 20

# How sure we are, as a multiplier on magnitude.
#
# Calibrated against the live distribution rather than guessed. Outlet counts
# on violent rows are low and heavily skewed -- the median event is carried by
# one or two outlets -- so an aggressive single-outlet discount pushes the
# entire feed under the "Moderate" band and the map's colour scale stops
# carrying information at all. These values keep a lone unverified report below
# the alert threshold while still letting a well-covered or casualty-bearing
# event reach High and Critical.
_CONFIDENCE_SINGLE_OUTLET = 0.70   # one outlet, one dataset: the noise case
_CONFIDENCE_TWO_OUTLETS = 0.88
_CONFIDENCE_MULTI_OUTLET = 1.0
# Enough independent newsrooms that "did this happen" is no longer the question.
_WELL_SOURCED_OUTLETS = 3

# A headline means we know what happened, not merely that CAMEO coded
# something. Most rows have no scraped title at all, and those are exactly the
# ones where event_type is a bare taxonomy label and fatalities is
# unknowable -- so this is a real distinction, not a cosmetic one.
_NO_HEADLINE_PENALTY = 0.92
_HEADLINE_BONUS = 6

_JAMMING_POINTS = 10
_THERMAL_POINTS = 8


def _severity_for(record: dict, reasons: list[str] | None = None) -> int:
    """0-100 for one merged cluster. Takes the record rather than positional
    arguments -- it reads nine inputs now, and a nine-argument call site is a
    bug waiting to happen.

    `reasons`, when passed, is filled with the factors that actually moved the
    score. A bare "Severity: 24/100" tells a reader nothing about whether 24
    means "minor incident" or "we barely know anything about this" -- and here
    it usually means the second, which is worth saying out loud.
    """
    def note(text: str) -> None:
        if reasons is not None:
            reasons.append(text)

    label = (record.get("event_type") or "").strip().lower()
    base = _SEVERITY_DEFAULT_BASE
    # Longest key first, so "Mass killing" is not shadowed by "Killing".
    for key in sorted(_SEVERITY_BASE, key=len, reverse=True):
        if key.lower() in label:
            base = _SEVERITY_BASE[key]
            break

    fatalities = record.get("fatalities") or 0
    outlets = record.get("outlet_count") or 0
    datasets = len(record.get("corroborated_by") or []) or 1

    # sqrt so the difference between 1 and 10 dead matters far more than
    # between 200 and 400 -- the first is a change of scale, the second isn't.
    magnitude = base + min(fatalities ** 0.5 * 8, 30)
    if fatalities:
        note(f"{fatalities} reported killed")
    elif not record.get("fatalities_reported"):
        note("no casualty figure reported")

    # How many independent newsrooms carried it. This is the signal the export
    # file's NumMentions/NumSources could never provide (both are saturated on
    # violent rows); it comes from the Mentions table.
    magnitude += min(math.log10(outlets + 1) * 18, 22)
    # Not noted here: the outlet count already has its own line in the popup
    # (corroborationLine), and printing it twice makes the reason list read as
    # padding rather than as an explanation.

    # We have an actual headline for this, rather than only a CAMEO code.
    if record.get("notes"):
        magnitude += _HEADLINE_BONUS
    else:
        note("no article text, coded fields only")

    # CAMEO's own -10..+10 intensity. Weighted low on purpose: measured over a
    # live window, |Goldstein| is 10 for the median violent row, so it is very
    # nearly a constant here and cannot carry the weight it used to.
    magnitude += min(max(-(record.get("goldstein") or 0), 0), 10) * 0.5

    if outlets >= _WELL_SOURCED_OUTLETS:
        confidence = _CONFIDENCE_MULTI_OUTLET
    elif outlets == 2:
        confidence = _CONFIDENCE_TWO_OUTLETS
    elif datasets > 1:
        confidence = _CONFIDENCE_MULTI_OUTLET  # a second dataset settles it
    else:
        confidence = _CONFIDENCE_SINGLE_OUTLET
        note("reported by a single outlet")

    if COUNTRY_CENTROID_POLICY == "demote":
        penalty = _IMPRECISION_PENALTY.get(record.get("geo_precision"), 1.0)
        confidence *= penalty
        if penalty < 1.0:
            note("location known only approximately")
    if not record.get("notes"):
        confidence *= _NO_HEADLINE_PENALTY

    # Added after the discount: independent confirmation should not itself be
    # discounted for the thinness of the report it confirms.
    evidence = min(max(datasets - 1, 0) * 10, 20)
    if datasets > 1:
        note(f"recorded independently by {datasets} datasets")
    if record.get("jamming_nearby"):
        evidence += _JAMMING_POINTS
        note("GPS interference detected nearby")
    if record.get("thermal_nearby"):
        evidence += _THERMAL_POINTS
        note("thermal anomaly detected nearby")

    return int(max(0, min(magnitude * confidence + evidence, 100)))


def _same_event(a: dict, b: dict) -> bool:
    if a["lat"] is None or a["lon"] is None or b["lat"] is None or b["lon"] is None:
        return False
    if a["dt"] is None or b["dt"] is None:
        return False
    if abs((a["dt"] - b["dt"]).days) > _MATCH_DAYS:
        return False
    return proximity.haversine_km(a["lat"], a["lon"], b["lat"], b["lon"]) <= _MATCH_KM


def _same_place_and_family(a: dict, b: dict) -> bool:
    """Cheap pre-match on GDELT's own geographic identity.

    Two rows carrying the same ActionGeo_FeatureID are the same place by
    construction -- no distance arithmetic needed, and it catches pairs whose
    coordinates differ slightly between geocoder revisions. 90% of violent rows
    carry one.

    Guarded on the CAMEO root so that two different kinds of act in the same
    city on the same day (an abduction and an airstrike) do not collapse into
    one record just because they share a place.
    """
    feature = a.get("geo_feature_id")
    if not feature or feature != b.get("geo_feature_id"):
        return False
    if a.get("event_root_code") != b.get("event_root_code"):
        return False
    if a["dt"] is None or b["dt"] is None:
        return False
    return abs((a["dt"] - b["dt"]).days) <= _MATCH_DAYS


class _Union:
    """Minimal union-find with path compression.

    The old clusterer compared every row against the *seed* of a cluster only,
    never against members added later, so a chain of overlapping reports
    (A near B, B near C, A far from C) fragmented into separate pins instead of
    becoming one incident. Union-find makes clustering transitive, which is
    what "these all describe one event" actually means.
    """

    __slots__ = ("parent",)

    def __init__(self, size: int):
        self.parent = list(range(size))

    def find(self, i: int) -> int:
        root = i
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[i] != root:
            self.parent[i], i = root, self.parent[i]
        return root

    def union(self, i: int, j: int) -> None:
        root_i, root_j = self.find(i), self.find(j)
        if root_i != root_j:
            self.parent[max(root_i, root_j)] = min(root_i, root_j)


def _cluster(items: list[dict]) -> list[list[dict]]:
    """Group rows describing the same incident. Roughly O(n * neighbours).

    Two passes feed one union-find: an exact FeatureID match, then a spatial
    hash so each row is distance-tested only against rows in nearby cells
    rather than against all n. The previous implementation was O(n^2) and
    non-transitive; this is neither.
    """
    union = _Union(len(items))
    span = int(round(360.0 / _CELL_DEG))

    by_feature: dict[tuple, list[int]] = {}
    cells: dict[tuple[int, int], list[int]] = {}
    for index, item in enumerate(items):
        feature = item.get("geo_feature_id")
        if feature:
            by_feature.setdefault((feature, item.get("event_root_code")), []).append(index)
        if item["lat"] is None or item["lon"] is None:
            continue
        key = (int(math.floor(item["lat"] / _CELL_DEG)),
               int(math.floor(item["lon"] / _CELL_DEG)) % span)
        cells.setdefault(key, []).append(index)

    for group in by_feature.values():
        first = group[0]
        for other in group[1:]:
            if _same_place_and_family(items[first], items[other]):
                union.union(first, other)

    for (lat_cell, lon_cell), bucket in cells.items():
        # Latitude of this cell, used to widen the longitude scan: at 70N a
        # 0.5-degree cell is only ~19 km wide, so a fixed 3x3 neighbourhood
        # would not reach _MATCH_KM.
        lat_reach = max(1, math.ceil(_MATCH_KM / (110.574 * _CELL_DEG)))
        lon_reach = proximity.lon_cells_for_radius(lat_cell * _CELL_DEG, _MATCH_KM, _CELL_DEG)
        neighbours: list[int] = []
        for d_lat in range(-lat_reach, lat_reach + 1):
            for d_lon in range(-lon_reach, lon_reach + 1):
                if d_lat == 0 and d_lon == 0:
                    continue
                # The modulo is what makes +180 neighbour -180; without it,
                # every event near the antimeridian is invisible to events
                # just across it.
                neighbours.extend(cells.get((lat_cell + d_lat, (lon_cell + d_lon) % span), ()))

        for position, index in enumerate(bucket):
            for other in bucket[position + 1:]:
                if _same_event(items[index], items[other]):
                    union.union(index, other)
            for other in neighbours:
                if other > index and _same_event(items[index], items[other]):
                    union.union(index, other)

    grouped: dict[int, list[dict]] = {}
    for index, item in enumerate(items):
        grouped.setdefault(union.find(index), []).append(item)
    return list(grouped.values())


# How usable a coordinate is, best first. Independent of _SOURCE_PRIORITY:
# which dataset writes the best prose and which member is geocoded most
# precisely are different questions, and conflating them let a country-centroid
# row from a higher-priority source override a city-precise one.
_PRECISION_RANK = {"locality": 0, "region": 1, "country": 2, "unknown": 3}


# How many headlines travel with one fused record. A busy incident can be
# clustered from a dozen GDELT rows; a popup that lists all of them is a wall
# of near-identical wire copy, and /api/events serves up to EVENTS_MAX_ITEMS
# records in one response, so this has to be bounded for the same reason
# outlets.MAX_OUTLET_NAMES is.
MAX_COVERAGE_ITEMS = 8


def _coverage_for(gdelt_members: list[dict]) -> list[dict]:
    """The article headlines behind one fused record, newest first.

    This is where a news item goes instead of being deleted. Each entry is one
    real scraped headline from a verified newsroom, carrying enough to render a
    line a reader can act on: what it said, who published it, when, and a link.

    Deduped on URL rather than on id, because two GDELT rows coding different
    actor pairs out of the same article are two ids and one piece of coverage.
    """
    by_url: dict[str, dict] = {}
    for member in gdelt_members:
        title = (member.get("notes") or "").strip()
        url = member.get("source_url")
        if not title or not url:
            continue
        existing = by_url.get(url)
        # Keep whichever copy GDELT ingested first: date_added is the only
        # sub-day timestamp available, and "when did this story break" is the
        # question the popup's relative time is answering.
        if existing and (existing.get("published") or "") <= (member.get("date_added") or ""):
            continue
        by_url[url] = {
            "event_id": member.get("id"),
            "title": title,
            "url": url,
            "outlet": member.get("source_name") or label_for_url(url),
            "published": member.get("date_added"),
        }
    return sorted(
        by_url.values(),
        key=lambda c: (c.get("published") or "", str(c.get("event_id") or "")),
        reverse=True,
    )[:MAX_COVERAGE_ITEMS]


def _merge_cluster(cluster: list[dict]) -> dict:
    cluster = sorted(cluster, key=lambda c: _SOURCE_PRIORITY.get(c["source"], 9))
    primary = cluster[0]
    # primary still supplies the narrative fields (actors, notes, fatalities);
    # the coordinate comes from whichever member actually knows where it was.
    coord_member = min(
        cluster,
        key=lambda c: (
            _PRECISION_RANK.get(c.get("geo_precision"), 3),
            _SOURCE_PRIORITY.get(c["source"], 9),
        ),
    )
    sources = sorted({c["source"] for c in cluster})
    fatalities = max((c["fatalities"] or 0) for c in cluster)
    notes = primary["notes"] or next((c["notes"] for c in cluster if c["notes"]), None)
    date_str = primary["dt"].date().isoformat() if primary["dt"] else None
    country = primary["country"] or next((c["country"] for c in cluster if c.get("country")), None)
    # GDELT-only signals (see _normalize_gdelt) -- None/0 for an
    # ACLED/UCDP-only cluster, since neither source carries them. mentions
    # takes the max across every GDELT member of the cluster (more outlets
    # reporting the same incident is itself a corroboration-strength signal,
    # distinct from corroborated_by's cross-*source* count); goldstein/
    # avg_tone/source_url come from whichever GDELT member has them first.
    gdelt_members = [c for c in cluster if c["source"] == "gdelt"]
    mentions = max((c.get("mentions") or 0 for c in gdelt_members), default=0)
    goldstein = next((c.get("goldstein") for c in gdelt_members if c.get("goldstein") is not None), None)
    avg_tone = next((c.get("avg_tone") for c in gdelt_members if c.get("avg_tone") is not None), None)
    source_url = next((c.get("source_url") for c in gdelt_members if c.get("source_url")), None)
    event_type = primary["event_type"] or "Conflict event"
    # Distinct newsrooms that carried this, from the GDELT Mentions table.
    # A different axis from corroborated_by, which counts distinct *datasets*:
    # forty outlets running one wire story is broad reach but a single chain of
    # custody, whereas ACLED and GDELT agreeing is two independent methods.
    # Conflating them is why "corroborated" used to mean nothing.
    outlet_count = max((c.get("outlet_count") or 0 for c in gdelt_members), default=0)
    verified_outlets = sorted({
        name for c in gdelt_members for name in (c.get("verified_outlets") or [])
    })
    # Which outlets, across *every* member rather than only the GDELT ones: an
    # ACLED row merged with a GDELT row was reported by both datasets' sources,
    # and naming only half of them would understate the coverage the count
    # above already claims. Capped and ranked by rank_outlets (see outlets.py),
    # so unioning several already-capped lists stays bounded.
    outlets = rank_outlets(
        (name for c in cluster for name in (c.get("outlets") or [])),
        # The outlet whose article this record cites leads the list, so the
        # names and the "Open source article" link agree with each other.
        preferred=label_for_url(source_url),
    )
    if len(sources) > 1:
        corroboration = "multi_dataset"
    elif outlet_count >= _WELL_SOURCED_OUTLETS:
        corroboration = "multi_outlet"
    else:
        corroboration = "single"

    coverage = _coverage_for(gdelt_members)
    # Every GDELT member's id, headline or not. This is the whole reason a
    # merged headline no longer has to be deleted: the frontend suppresses the
    # duplicate *marker* by matching against this list, while /api/news keeps
    # serving the item so it stays in the scrolling feed and the country card.
    # Previously the backend dropped the item outright and its text existed
    # nowhere -- dedup that lost data rather than relocating it.
    coverage_event_ids = [c["id"] for c in gdelt_members if c.get("id")]

    # Earliest observation across the cluster, so a record's age is measured
    # from when we first heard about the incident rather than from whichever
    # member happens to be primary this poll.
    seen_ats = [c["seen_at"] for c in cluster if c.get("seen_at") is not None]
    record = {
        # Placeholder; _fuse overwrites it with a stable id (_stable_cluster_id)
        # so re-clustering can't mint phantom incidents.
        "id": f"{primary['source']}:{primary['id']}",
        "ingested_at": min(seen_ats) if seen_ats else None,
        "lat": coord_member["lat"],
        "lon": coord_member["lon"],
        "geo_precision": coord_member.get("geo_precision") or "unknown",
        "geo_feature_id": coord_member.get("geo_feature_id"),
        "date": date_str,
        "event_type": event_type,
        "sub_event_type": primary["sub_event_type"],
        "event_code": next((c.get("event_code") for c in cluster if c.get("event_code")), None),
        # The full place string ("Kherson, Khersons'ka Oblast', Ukraine")
        # alongside the bare country, so a popup can show where without the
        # country matcher having to parse it back out.
        "location": next((c.get("location") for c in cluster if c.get("location")), None),
        "actor1": primary["actor1"],
        "actor2": primary["actor2"],
        "actor1_type": primary.get("actor1_type"),
        "actor2_type": primary.get("actor2_type"),
        "actor1_group": primary.get("actor1_group"),
        "actor2_group": primary.get("actor2_group"),
        "event_base_code": primary.get("event_base_code"),
        "event_root_code": primary.get("event_root_code"),
        "fatalities": fatalities,
        # True only if some member of the cluster genuinely reported a count.
        "fatalities_reported": any(c.get("fatalities_reported") for c in cluster),
        "country": country,
        "notes": notes,
        "source": primary["source"],
        # Kept as a bool because the frontend's blue-pin path and popup copy
        # already key off it -- but it now means something. It used to be
        # "2+ datasets", which with ACLED embargoed was permanently false.
        "corroborated": corroboration != "single",
        "corroborated_by": sources,
        "corroboration": corroboration,
        "outlet_count": outlet_count,
        "outlets": outlets,
        "verified_outlets": verified_outlets,
        "mentions": mentions,
        "goldstein": goldstein,
        "avg_tone": avg_tone,
        "source_url": source_url,
        # The headlines this incident was reported under, and the news ids that
        # therefore already have a pin. See _coverage_for.
        "coverage": coverage,
        "coverage_event_ids": coverage_event_ids,
    }
    reasons: list[str] = []
    record["severity"] = _severity_for(record, reasons)
    record["severity_reasons"] = reasons
    # A rendering of the coded fields, not an extra claim -- see _build_summary.
    # Only worth generating when there is no real article text to show instead.
    record["summary"] = None if notes else _build_summary(record)
    return record


# --- what to do with events that have no real location --------------------
#
# Roughly a fifth of GDELT conflict rows are geocoded only to a country
# centroid (measured: 17.8% overall, 31.6% of rows passing the violence gate).
# A pin in the geometric middle of Sudan is not a location, it is an artifact
# of the geocoder. Exactly one of:
#
#   "keep"      render as-is -- the old behaviour, i.e. assert a precision we
#               do not have
#   "demote"    keep the event but mark it, penalise its severity, and let the
#               frontend draw it as an area rather than a point
#   "drop"      exclude from the live layer entirely
#   "aggregate" collapse to one record per (country, day, event family), with
#               a cluster_size, for a country-level badge
#
# Changing this value is the only edit needed to change the policy: the
# frontend keys off the geo_precision field, so "drop" simply stops those
# records arriving and "aggregate" makes them arrive pre-collapsed.
COUNTRY_CENTROID_POLICY = os.getenv("COUNTRY_CENTROID_POLICY", "demote")

# Severity multiplier applied under "demote". Not a punishment for being
# imprecise -- a correction. An event we cannot place is less actionable than
# an identical one we can, and the map should rank it that way.
_IMPRECISION_PENALTY = {"country": 0.70, "region": 0.85, "unknown": 0.80, "locality": 1.0}


def _apply_precision_policy(records: list[dict]) -> list[dict]:
    if COUNTRY_CENTROID_POLICY == "keep":
        return records
    if COUNTRY_CENTROID_POLICY == "drop":
        return [r for r in records if r.get("geo_precision") != "country"]
    if COUNTRY_CENTROID_POLICY == "aggregate":
        return _aggregate_country_records(records)
    return records  # "demote" -- the penalty is applied inside _severity_for


def _aggregate_country_records(records: list[dict]) -> list[dict]:
    """Collapse country-precision records into one per (country, day, type).

    Keeps the highest-severity member as the representative and records how
    many were folded in, so a country-level badge can show "7 reported
    incidents" rather than seven pins stacked on one centroid.
    """
    passthrough = [r for r in records if r.get("geo_precision") != "country"]
    buckets: dict[tuple, list[dict]] = {}
    for record in records:
        if record.get("geo_precision") != "country":
            continue
        key = (record.get("country"), record.get("date"), record.get("event_type"))
        buckets.setdefault(key, []).append(record)

    for members in buckets.values():
        best = max(members, key=lambda r: r.get("severity") or 0)
        best["cluster_size"] = len(members)
        best["fatalities"] = max((m.get("fatalities") or 0) for m in members)
        passthrough.append(best)
    return passthrough


# Rows rejected because the article was commentary or a retrospective rather
# than a dispatch. Counted rather than silently dropped for the same reason
# _dropped_retrospective is: if the section heuristic ever starts matching
# ordinary reporting, that has to be visible in the log instead of quietly
# thinning the layer.
_dropped_non_news = 0


def _is_violent_gdelt_row(row: dict) -> bool:
    """Gate for GDELT rows entering the conflict layer.

    Three conditions, all required: the event is violence-typed
    (VIOLENCE_ROOT_CODES), at least one party is an armed actor
    (ARMED_ACTOR_TYPES, or a named known group such as a listed militia), and
    the article it was coded from is a news dispatch rather than commentary or
    a retrospective (see outlets.is_non_news_url).

    That last condition is not redundant with the report-lag gate in
    _gdelt_event_dt. A magazine feature about a bombing in 2002 is stamped by
    GDELT with *today's* SQLDATE, so the lag check sees zero lag and passes it
    through as a live event -- which is how a 25-year 9/11 retrospective put a
    suicide bombing on the map in Tunisia, dated today.

    ACLED/UCDP rows never reach this -- they're curated conflict data and
    pass through untouched.
    """
    global _dropped_non_news
    if row.get("event_root_code") not in VIOLENCE_ROOT_CODES:
        return False
    armed = (
        row.get("actor1_type") in ARMED_ACTOR_TYPES
        or row.get("actor2_type") in ARMED_ACTOR_TYPES
        # A named organisation carries the same signal even when CAMEO left the
        # type code blank, which it often does for non-state groups.
        or bool(row.get("actor1_group") or row.get("actor2_group"))
    )
    if not armed:
        return False
    # Last, so the counter means "rows this filter actually took off the map"
    # rather than "rows it matched" -- most of what it matches would have been
    # rejected by the armed-actor test anyway, and a log line that conflated
    # the two would badly overstate what the heuristic is doing.
    if is_non_news_url(row.get("source_url")):
        _dropped_non_news += 1
        return False
    return True


def _fuse(acled_state_rows: list[dict], gdelt_rows: list[dict]) -> list[dict]:
    # gdelt_rows arrive pre-filtered from _accumulate_violent_gdelt -- the
    # violence/armed-actor gate runs there so the accumulator only ever holds
    # rows worth keeping for three days.
    items = [_normalize_structured(row.get("source") or "acled", row) for row in acled_state_rows]
    items.extend(_normalize_gdelt(row) for row in gdelt_rows)
    # An event with no usable date can't be aged, filtered, clustered or
    # ranked -- and _gdelt_event_dt returns None precisely for the
    # retrospective reports the sanity gate exists to reject.
    items = [item for item in items if item["dt"] is not None]
    items.sort(key=lambda c: _SOURCE_PRIORITY.get(c["source"], 9))

    global _cluster_id_by_member, _cluster_minted_at, _superseded_ids

    merged = []
    now = time.time()
    next_member_ids: dict[str, str] = {}
    next_minted_at: dict[str, float] = {}
    superseded: set[str] = set()

    for cluster in _cluster(items):
        cluster_id, losers = _stable_cluster_id(cluster, now)
        superseded.update(losers)
        next_minted_at[cluster_id] = _cluster_minted_at.get(cluster_id, now)
        for member in cluster:
            next_member_ids[_member_key(member)] = cluster_id

        record = _merge_cluster(cluster)
        record["id"] = cluster_id
        merged.append(record)

    # Rebuilt wholesale rather than mutated, so members that aged out of the
    # input simply stop being tracked.
    _cluster_id_by_member = next_member_ids
    _cluster_minted_at = next_minted_at
    # An id that survived as a winner elsewhere this poll is not superseded.
    _superseded_ids = sorted(superseded - set(next_minted_at))
    return _apply_precision_policy(merged)


# gdelt.py's own accumulator holds a ~2 hour rolling window, which is right
# for a *news* feed but far too short for the conflict layer: after the
# violence + armed-actor gates, two hours of GDELT yields only a handful of
# events worldwide, while ACLED and UCDP contribute a 3-day window. The layer
# therefore claimed "last 3 days" while its largest input covered two hours.
#
# Violent events are rare enough (order 100s/day globally, post-filter) to
# keep a 3-day window in memory cheaply, so this keeps its own accumulator
# aligned to the window the UI advertises. Keyed by GDELT event id; _seen_at
# is preserved across polls so an event ages from when it was first observed.
_VIOLENT_RETENTION_SECONDS = 3 * 86400
_VIOLENT_HARD_CAP = 5000  # safety valve; far above observed volume
_violent_gdelt: dict[str, dict] = {}


def _accumulate_violent_gdelt(rows: list[dict]) -> list[dict]:
    now = time.time()
    for row in rows:
        if not _is_violent_gdelt_row(row):
            continue
        event_id = row.get("event_id")
        if not event_id:
            continue
        stored = dict(row)
        prior = _violent_gdelt.get(event_id)
        stored["_seen_at"] = prior["_seen_at"] if prior else now
        _violent_gdelt[event_id] = stored

    cutoff = now - _VIOLENT_RETENTION_SECONDS
    for event_id in [k for k, v in _violent_gdelt.items() if v.get("_seen_at", now) < cutoff]:
        del _violent_gdelt[event_id]

    if len(_violent_gdelt) > _VIOLENT_HARD_CAP:
        # Oldest-first eviction if an unusually violent window blows past the cap.
        for event_id, _ in sorted(_violent_gdelt.items(), key=lambda kv: kv[1].get("_seen_at", 0))[
            : len(_violent_gdelt) - _VIOLENT_HARD_CAP
        ]:
            del _violent_gdelt[event_id]

    return list(_violent_gdelt.values())


# --- physical corroboration ------------------------------------------------
#
# Two signals the app already fetches for their own layers, reused here as
# independent evidence that something physical happened where a news report
# says it did.
#
# GPS jamming is the stronger of the two. Interference at this scale is
# essentially never agricultural or accidental, and jamming.py already filters
# to cells above a 25% bad-fix ratio and keeps only the 100 worst worldwide, so
# a hit is a real indicator of active electronic warfare. Its *absence* means
# nothing, though, and must never reduce a score: coverage exists only where
# ADS-B receivers do, which leaves much of Africa and central Asia blind.
#
# Thermal anomalies are much weaker. firms.py:25-36 records that this app
# already tried gating FIRMS on conflict correlation and removed it because
# most hotspots are wildfire and agricultural burning. Running the correlation
# in the other direction is not obviously better, so it is a small bonus, it
# never sets `corroborated`, and it is described in the UI as an observation
# ("thermal anomaly within 10 km the same day") rather than as confirmation.
# First thing to cut if it proves noisy.
_JAMMING_RADIUS_KM = 60      # gpsjam H3 res-4 cells are ~20 km across
_THERMAL_RADIUS_KM = 10

# Only event families where a fire or blast signature is physically plausible.
# A hostage-taking near a burning field is a coincidence, not evidence.
_BLAST_PLAUSIBLE = (
    "bombard", "artillery", "bombing", "explosion", "conventional force",
    "mass violence", "mass killing", "battle", "fighting", "siege",
)

_proximity_cache: dict[str, tuple[int, proximity.ProximityIndex]] = {}


def _proximity_index(name: str, cell_deg: float) -> proximity.ProximityIndex | None:
    """Build (or reuse) a spatial index over another source's current data.

    Cached against that source's registry version so a poll where nothing
    changed upstream doesn't rebuild the index.
    """
    if not registry.has(name):
        return None
    state = registry.get(name)
    cached = _proximity_cache.get(name)
    if cached and cached[0] == state.version:
        return cached[1]
    index = proximity.ProximityIndex(state.data or [], cell_deg=cell_deg)
    _proximity_cache[name] = (state.version, index)
    return index


def _attach_physical_evidence(records: list[dict]) -> None:
    jamming = _proximity_index("jamming", cell_deg=1.0)
    thermal = _proximity_index("firms", cell_deg=0.5)
    for record in records:
        lat, lon = record.get("lat"), record.get("lon")
        # A country centroid is not a place, so "something burning within 10 km
        # of it" is not evidence about the event.
        if lat is None or lon is None or record.get("geo_precision") != "locality":
            continue
        if jamming:
            hit = jamming.nearest(lat, lon, _JAMMING_RADIUS_KM)
            if hit:
                record["jamming_nearby"] = round(hit.get("jam_ratio") or 0, 3)
        if thermal and any(word in (record.get("event_type") or "").lower() for word in _BLAST_PLAUSIBLE):
            hit = thermal.nearest(lat, lon, _THERMAL_RADIUS_KM)
            if hit and hit.get("acq_date") == record.get("date"):
                record["thermal_nearby"] = True
        if record.get("jamming_nearby") or record.get("thermal_nearby"):
            record["severity"] = _severity_for(record)


def _fetch() -> list[dict]:
    # registry.has() guards startup ordering -- a broken/slow import of
    # either acled.py or gdelt.py shouldn't crash this module's poll loop
    # (see app.py's per-module try/except at startup for the same
    # "one bad source stays inert" principle applied here).
    acled_state_rows = (registry.get("acled").data if registry.has("acled") else []) or []
    # "gdelt_conflict", not "gdelt": the latter is the top-400-by-mentions slice
    # /api/news serves, and reading it here meant the violence gate only ever
    # saw whatever survived a popularity ranking.
    gdelt_rows = (registry.get("gdelt_conflict").data if registry.has("gdelt_conflict") else []) or []
    fused = _fuse(acled_state_rows, _accumulate_violent_gdelt(gdelt_rows))
    _attach_physical_evidence(fused)
    return fused


async def _rehydrate_violent_gdelt() -> None:
    """Refill the 3-day violence accumulator from Postgres after a restart.

    Without this, a restart drops the conflict layer to whatever GDELT's
    2-hour rolling window happens to hold and takes three days to build back
    up -- which also starves escalation.py, whose baseline needs 36 hours of
    comparable history before it will say anything at all.

    Rows already fetched live win on the next poll, so this only fills gaps.
    """
    try:
        stored = await storage.entity_latest("gdelt_conflict")
    except Exception as exc:  # noqa: BLE001 - a cold start is not a failure
        log.warning("Could not rehydrate the GDELT conflict window: %s", exc)
        return
    now = time.time()
    cutoff = now - _VIOLENT_RETENTION_SECONDS
    restored = 0
    for row in stored:
        event_id = row.get("event_id")
        if not event_id or event_id in _violent_gdelt or not _is_violent_gdelt_row(row):
            continue
        # Rows persisted before _seen_at existed, or from an older run, are
        # aged from now rather than being treated as brand new -- but anything
        # already past the retention window is simply not restored.
        seen_at = row.get("_seen_at")
        if seen_at is not None and seen_at < cutoff:
            continue
        row["_seen_at"] = seen_at if seen_at is not None else now
        _violent_gdelt[event_id] = row
        restored += 1
    if restored:
        log.info("Rehydrated %d violent GDELT rows from storage", restored)


async def _wait_for_inputs() -> None:
    # acled.py's own first poll (OAuth + paginated ACLED read + UCDP
    # candidate download) and gdelt.py's first window fetch both take real
    # time -- firing this module's first _fetch() immediately at cold start
    # reliably races them and fuses against still-empty state.data.
    deadline = time.time() + 60
    while time.time() < deadline:
        acled_ready = registry.has("acled") and registry.get("acled").version > 0
        gdelt_ready = registry.has("gdelt_conflict") and registry.get("gdelt_conflict").version > 0
        if acled_ready and gdelt_ready:
            return
        await asyncio.sleep(1)


async def start():
    state = registry.register("events", key_configured=True)
    await _rehydrate_violent_gdelt()
    await _wait_for_inputs()
    while True:
        try:
            items = _fetch()
            state.data = items
            state.last_success = time.time()
            state.last_error = None
            # Two writes on purpose: the rich, queryable archive (actors,
            # fatalities, corroboration, first/last seen) and the generic
            # point snapshot that makes fused events replayable on the
            # timeline the same way ships and aircraft are.
            # Order matters: drop the absorbed clusters before writing, so the
            # archive never briefly holds both halves of a merge.
            await storage.delete_conflict_events(_superseded_ids)
            await storage.record_conflict_events(items)
            await storage.record_snapshot("events", items, "id")
            corroborated = sum(1 for d in items if d.get("corroborated"))
            imprecise = sum(1 for d in items if d.get("geo_precision") != "locality")
            log.info(
                "Fused events: %d canonical (%d corroborated by 2+ sources, %d without a "
                "precise geocode); %d retrospective rows dropped (report lag > %dd); "
                "%d dropped as commentary/retrospective by URL section",
                len(items), corroborated, imprecise, _dropped_retrospective,
                _MAX_REPORT_LAG_DAYS, _dropped_non_news,
            )
            await storage.record_source_health("events", len(items), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Event fusion failed: %s", exc)
            await storage.record_source_health("events", None, False, str(exc))
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
