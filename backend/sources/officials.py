"""Officials & Diplomacy: one layer, two kinds of evidence.

What heads of state, foreign ministries and international bodies are saying and
doing -- statements, meetings, state visits, demands, threats, sanctions.

Two inputs, deliberately kept distinguishable rather than blended:

  gdelt          CAMEO-coded events from newsroom reporting (registry key
                 "gdelt_officials", gated in gdelt._is_officials_row). Reported
                 by an editor, machine-coded by GDELT -- so it has reach and
                 corroboration, and it can be wrong about who did what.
  official_feed  The government's own press feed (official_feeds.py). Certain
                 about attribution, published with no editor between the claim
                 and the reader.

The `origin` field survives all the way to the popup for exactly that reason.
Merging them into an undifferentiated "diplomacy" feed would hide the one thing
a reader most needs in order to weigh a statement about a war.

Structure mirrors event_fusion.py: wait for inputs, poll, normalise, deduplicate,
publish to the registry and the archive.
"""

import asyncio
import logging
import re
import time
from datetime import datetime, timezone

from backend import config, storage
from backend.cache import registry
from backend.sources import cameo
from backend.sources.outlets import label_for_url

log = logging.getLogger("osint-globe.officials")

# Same 24h horizon as the news layer and official_feeds, so all three agree
# about what "recent" means.
RETENTION_SECONDS = 24 * 3600

# Safety valve. /api/officials applies its own world-view cap on top; this
# bounds what is held and archived.
MAX_RECORDS = 3000


def _gdelt_when(row: dict) -> float | None:
    """GDELT's DATEADDED -> unix seconds. The only sub-day stamp it publishes."""
    raw = row.get("date_added")
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw)[:14], "%Y%m%d%H%M%S").replace(
            tzinfo=timezone.utc
        ).timestamp()
    except (TypeError, ValueError):
        return None


def _normalize_gdelt(row: dict) -> dict | None:
    kind = cameo.diplomatic_kind(
        row.get("event_code"), row.get("event_base_code"), row.get("event_root_code")
    )
    if not kind:
        return None
    published = _gdelt_when(row)
    if published is None:
        return None

    actor1 = cameo.pretty_actor(row.get("actor1"), row.get("actor1_group"), row.get("actor1_type"))
    actor2 = cameo.pretty_actor(row.get("actor2"), row.get("actor2_group"), row.get("actor2_type"))
    verb = cameo.cameo_sentence(
        row.get("event_code"), row.get("event_base_code"), row.get("event_root_code")
    )
    location = cameo.clean_location(row.get("location"))

    # The coded sentence, assembled the same way conflict pins assemble theirs
    # (event_fusion._build_summary) -- a rendering of the CAMEO fields, never an
    # extra claim. The popup prints the provenance line that says so.
    summary = None
    if verb and actor1 and actor2:
        summary = f"{actor1} {verb} {actor2}."
    elif verb and actor1:
        trimmed = actor1 + " " + verb
        for tail in (" with", " to", " on", " against", " from", " between", " by"):
            if trimmed.endswith(tail):
                trimmed = trimmed[: -len(tail)]
                break
        summary = trimmed.rstrip() + "."

    headline = (row.get("real_title") or "").strip() or None
    return {
        "id": f"gdelt:{row.get('event_id')}",
        "origin": "gdelt",
        "kind": kind,
        "lat": row.get("lat"),
        "lon": row.get("lon"),
        "geo_precision": row.get("geo_precision") or "unknown",
        "location": location,
        "country": cameo.country_from_location(row.get("location")),
        "headline": headline,
        # Falls back to the CAMEO label when no headline was scraped, so a pin
        # always says something more specific than "diplomatic event".
        "label": cameo.cameo_label(
            row.get("event_code"), row.get("event_base_code"), row.get("event_root_code")
        ),
        "summary": summary,
        "actor1": actor1,
        "actor2": actor2,
        "actor1_country": row.get("actor1_country"),
        "actor2_country": row.get("actor2_country"),
        "url": row.get("source_url"),
        "outlet": row.get("source_name") or label_for_url(row.get("source_url")),
        "outlets": row.get("outlets") or [],
        "outlet_count": row.get("outlet_count") or 0,
        "mentions": row.get("mentions") or 0,
        "goldstein": row.get("goldstein"),
        "published_at": published,
        # This row is also a News item. Named here so the map can draw it once,
        # exactly as fused conflict records do -- see
        # event_fusion._coverage_for and the frontend's merged-id set.
        "coverage_event_ids": [row["event_id"]] if row.get("event_id") else [],
    }


def _normalize_feed(row: dict) -> dict:
    return {
        "id": row["id"],
        "origin": "official_feed",
        "kind": row.get("kind") or "statement",
        "lat": row.get("lat"),
        "lon": row.get("lon"),
        # The seat of the institution, not the site of the act. Marked as such
        # so the map never implies this is where anything happened.
        "geo_precision": "institution",
        "location": row.get("government"),
        "country": row.get("country"),
        "headline": row.get("title"),
        "label": None,
        "summary": row.get("summary"),
        "actor1": row.get("government"),
        "actor2": None,
        "actor1_country": None,
        "actor2_country": None,
        "url": row.get("url"),
        "outlet": row.get("government"),
        "outlets": [],
        # A press release has no outlet count by construction -- it was carried
        # by exactly its own publisher. Left at zero rather than set to 1 so it
        # never reads as corroboration.
        "outlet_count": 0,
        "mentions": 0,
        "goldstein": None,
        "published_at": row.get("published_at"),
        "coverage_event_ids": [],
    }


# --- deduplication ---------------------------------------------------------
#
# Two records describing one act: a ministry's own release and a wire story
# GDELT coded from it, or two GDELT rows that scraped the same headline off
# different URLs. Both should be one pin.
#
# Matched on headline similarity rather than on actor country pairs, which was
# the obvious approach and does not work: a press release names its counterpart
# in prose ("Telephone conversation with President of Brazil") while GDELT
# names it in a CAMEO code (BRA), and bridging the two needs entity resolution
# this module has no business doing. Headline text is the thing both origins
# actually share.
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOPWORDS = frozenset({
    "the", "a", "an", "of", "on", "in", "to", "and", "for", "with", "at", "by",
    "from", "as", "is", "was", "are", "were", "be", "been", "his", "her", "its",
    "their", "he", "she", "they", "it", "that", "this", "over", "after", "says",
    "said", "new", "up", "out", "amid",
})
# Jaccard overlap above which two headlines are the same story. 0.5 is
# deliberately conservative: a false merge silently deletes a real statement,
# whereas a missed merge costs one extra pin.
_SIMILARITY_THRESHOLD = 0.5
# Below this many meaningful tokens a headline is too short for the overlap
# ratio to mean anything -- "Meeting with the President" against "Meeting with
# the Chancellor" is 0.67 similar and describes two different meetings.
_MIN_TOKENS = 4

# How far apart two reports of one act can be. A press office publishes when it
# happens and a newsroom publishes when it files, so the gap is hours, not
# minutes.
#
# This is a window rather than a same-UTC-day test, which is what it was first
# written as and which quietly failed at midnight: the Kremlin publishing a call
# at 23:50 UTC and Reuters filing it at 00:10 fall on two calendar days and
# never merged, so every late-evening statement rendered twice.
_MERGE_WINDOW_SECONDS = 12 * 3600


def _tokens(text: str | None) -> frozenset[str]:
    if not text:
        return frozenset()
    return frozenset(t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS and len(t) > 2)


def _same_story(a: dict, b: dict) -> bool:
    if a.get("kind") != b.get("kind"):
        return False
    if abs((a.get("published_at") or 0) - (b.get("published_at") or 0)) > _MERGE_WINDOW_SECONDS:
        return False
    at = a.get("_tokens")
    bt = b.get("_tokens")
    at = _tokens(a.get("headline")) if at is None else at
    bt = _tokens(b.get("headline")) if bt is None else bt
    if len(at) < _MIN_TOKENS or len(bt) < _MIN_TOKENS:
        return False
    return len(at & bt) / len(at | bt) >= _SIMILARITY_THRESHOLD


# An official's own release outranks a report about it: it is the primary
# source, and it is the one whose attribution is certain.
_ORIGIN_PRIORITY = {"official_feed": 0, "gdelt": 1}


def _dedupe(records: list[dict]) -> list[dict]:
    """Collapse records describing the same act, primary sources winning.

    Bucketed by kind so the pairwise comparison runs within a group rather than
    across the whole list, and each record is only compared against survivors
    (which are few, since most records are distinct) rather than against every
    other member of its bucket.
    """
    buckets: dict[str, list[dict]] = {}
    for record in sorted(
        records,
        key=lambda r: (_ORIGIN_PRIORITY.get(r["origin"], 9), -(r.get("published_at") or 0)),
    ):
        # Computed once per record rather than once per comparison: the same
        # headline is otherwise re-tokenised for every survivor it is tested
        # against. Removed again before the records are served.
        record["_tokens"] = _tokens(record.get("headline"))
        buckets.setdefault(record.get("kind") or "", []).append(record)

    out: list[dict] = []
    for bucket in buckets.values():
        kept: list[dict] = []
        for record in bucket:
            match = next((k for k in kept if _same_story(k, record)), None)
            if match is None:
                kept.append(record)
                continue
            # The loser is absorbed rather than discarded: its reach counts
            # towards the survivor's, and its news id still has to be
            # suppressed on the map or the headline reappears as its own pin.
            match["outlet_count"] = max(match.get("outlet_count") or 0, record.get("outlet_count") or 0)
            match["mentions"] = max(match.get("mentions") or 0, record.get("mentions") or 0)
            match["coverage_event_ids"] = sorted(
                set(match.get("coverage_event_ids") or []) | set(record.get("coverage_event_ids") or [])
            )
            # Two independent origins agreeing is the strongest signal this
            # layer has, and it is a different statement from "widely carried".
            if match["origin"] != record["origin"]:
                match["corroborated_by_primary_source"] = True
            if not match.get("headline"):
                match["headline"] = record.get("headline")
            if not match.get("url"):
                match["url"] = record.get("url")
        out.extend(kept)
    for record in out:
        record.pop("_tokens", None)  # working state, never served
    return out


def _rank(record: dict, now: float) -> float:
    """Recency-weighted reach, for the cap. Same shape as gdelt._news_rank.

    A press release scores no reach of its own (outlet_count is 0 by
    construction), so the +2 floor keeps primary sources rankable rather than
    guaranteeing they are cut first.
    """
    age_hours = max((now - (record.get("published_at") or now)) / 3600.0, 0.0)
    reach = (record.get("outlet_count") or 0) + 2
    if record.get("origin") == "official_feed":
        # A government's own announcement is worth showing even when no
        # newsroom has picked it up yet -- often *because* none has.
        reach += 4
    return reach * 0.5 ** (age_hours / 6.0)


def _fetch() -> list[dict]:
    gdelt_rows = (registry.get("gdelt_officials").data if registry.has("gdelt_officials") else []) or []
    feed_rows = (registry.get("official_feeds").data if registry.has("official_feeds") else []) or []

    records = [r for r in (_normalize_gdelt(row) for row in gdelt_rows) if r]
    records.extend(_normalize_feed(row) for row in feed_rows)

    now = time.time()
    cutoff = now - RETENTION_SECONDS
    records = [
        r for r in records
        if r.get("published_at") and r["published_at"] >= cutoff
        and isinstance(r.get("lat"), (int, float)) and isinstance(r.get("lon"), (int, float))
    ]
    records = _dedupe(records)
    records.sort(key=lambda r: _rank(r, now), reverse=True)
    for record in records:
        record["ingested_at"] = now
    return records[:MAX_RECORDS]


async def _wait_for_inputs() -> None:
    # Same cold-start guard event_fusion uses: gdelt.py's first window fetch and
    # official_feeds' first round both take real time, and firing immediately
    # reliably races them and fuses against still-empty state.
    deadline = time.time() + 60
    while time.time() < deadline:
        gdelt_ready = registry.has("gdelt_officials") and registry.get("gdelt_officials").version > 0
        feeds_ready = registry.has("official_feeds") and registry.get("official_feeds").version > 0
        if gdelt_ready and feeds_ready:
            return
        await asyncio.sleep(1)


async def start():
    state = registry.register("officials", key_configured=True)  # no key required
    await _wait_for_inputs()
    while True:
        try:
            items = _fetch()
            state.data = items
            state.last_success = time.time()
            state.last_error = None
            primary = sum(1 for i in items if i["origin"] == "official_feed")
            log.info(
                "Officials & diplomacy: %d records (%d from governments' own feeds, "
                "%d machine-coded from news)",
                len(items), primary, len(items) - primary,
            )
            await storage.record_snapshot("officials", items, "id")
            await storage.record_source_health("officials", len(items), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Officials fusion failed: %s", exc)
            await storage.record_source_health("officials", None, False, str(exc))
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
