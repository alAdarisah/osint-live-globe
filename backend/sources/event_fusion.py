import asyncio
import logging
import math
import re
import time
from datetime import datetime, timezone

from backend import config, storage
from backend.cache import registry

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

# CAMEO's 20 top-level event root codes (gdelt.py's COL_EVENT_ROOT_CODE) --
# a GDELT-only cluster with no matching real headline (most of them: title
# backfill only runs for verified-domain source_urls, see gdelt.py) used to
# fall back to the bare, uninformative "Conflict event" label with nothing
# else to go on. CAMEO's own root category is always present regardless of
# whether a headline was ever fetched, so it's a free, always-available
# upgrade from "Conflict event" to e.g. "Assault" or "Fight with small arms
# and light weapons" -- still generic (it's a ~200-code taxonomy collapsed to
# 20 buckets), but meaningfully more specific than nothing.
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

CAMEO_ROOT_LABEL = {
    1: "Public statement",
    2: "Appeal",
    3: "Expressed intent to cooperate",
    4: "Consultation",
    5: "Diplomatic cooperation",
    6: "Material cooperation",
    7: "Provided aid",
    8: "Yield / de-escalation",
    9: "Investigation",
    10: "Demand",
    11: "Disapproval",
    12: "Rejection",
    13: "Threat",
    14: "Protest",
    15: "Military mobilization / force posture",
    16: "Reduced relations",
    17: "Coercion",
    18: "Assault",
    19: "Fighting",
    20: "Unconventional mass violence",
}

# A GDELT structured event and an ACLED/UCDP row describing the same
# incident should land within a few days and ~55km of each other even
# accounting for reporting lag / geocoding imprecision on either side. Same
# thresholds the old conflict_watch.py used for its (narrower) UCDP<->GDELT
# matching, generalized here to run across all three input buckets.
_MATCH_DAYS = 2
_MATCH_DEGREES = 0.5

# ACLED/UCDP carry real structured fields (actor names, a reviewed fatality
# count); GDELT is CAMEO-coded with no fatality field of its own. When a
# cluster spans sources, the richest one should supply the record's core
# fields -- this is that priority order, low number wins.
_SOURCE_PRIORITY = {"acled": 0, "ucdp": 1, "gdelt": 2}

# GDELT event_ids folded into some fused record on the most recent poll --
# app.py's /api/news filter reads this so a headline that became a conflict
# pin doesn't also render a second time as a plain News pin. Module-level
# rather than threaded through return values since app.py's _gdelt_filter is
# a separate request path with no natural way to receive it otherwise (same
# shape as registry.get(...).data being read directly elsewhere in this app).
_consumed_gdelt_ids: set[str] = set()


def consumed_gdelt_ids() -> set[str]:
    return _consumed_gdelt_ids


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
    # GDELT's date_added, "YYYYMMDDHHMMSS".
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _normalize_structured(source: str, raw: dict) -> dict:
    return {
        "source": source,
        "id": raw.get("id"),
        "lat": raw.get("lat"),
        "lon": raw.get("lon"),
        "dt": _parse_structured_dt(raw.get("date")),
        "event_type": raw.get("event_type"),
        "sub_event_type": raw.get("sub_event_type"),
        "actor1": raw.get("actor1"),
        "actor2": raw.get("actor2"),
        "fatalities": raw.get("fatalities") or 0,
        "country": raw.get("country"),
        "notes": raw.get("notes"),
    }


def _normalize_gdelt(raw: dict) -> dict:
    headline = (raw.get("real_title") or "").strip()
    location = raw.get("location") or None
    text = f"{headline} {location or ''}".strip()
    if headline:
        event_type, sub_event_type = _classify(text)
    else:
        # No real headline to run the keyword classifier over (most GDELT
        # rows -- title backfill only runs for verified-domain source_urls,
        # see gdelt.py) -- a bare location string ("New York, United
        # States") never contains a conflict keyword, so classifying off it
        # alone would just silently reproduce this same generic fallback.
        # CAMEO's own root category is always present regardless of a
        # headline, so use that instead of a bare "Conflict event" with zero
        # further detail.
        event_type = CAMEO_ROOT_LABEL.get(raw.get("event_root_code"), "Conflict event")
        sub_event_type = None
    return {
        "source": "gdelt",
        "id": raw.get("event_id"),
        "lat": raw.get("lat"),
        "lon": raw.get("lon"),
        "dt": _parse_gdelt_dt(raw.get("date_added")),
        "event_type": event_type,
        "sub_event_type": sub_event_type,
        "actor1": raw.get("actor1"),
        "actor2": raw.get("actor2"),
        "fatalities": _extract_fatalities(text) if headline else 0,
        "country": location,
        "notes": headline or None,
        # Extra GDELT-only signals with no ACLED/UCDP equivalent -- carried
        # through _merge_cluster below so the frontend can show "how many
        # outlets/mentions" and "how intense" even without a real headline.
        "mentions": raw.get("mentions") or 0,
        "goldstein": raw.get("goldstein"),
        "avg_tone": raw.get("avg_tone"),
        "source_url": raw.get("source_url") if headline else None,
    }


# --- severity -------------------------------------------------------------
#
# A single 0-100 number so the map can make consequential events visually
# louder than minor ones, and so Piece 3's "notable events" ranking has
# something principled to sort on. Built only from signals the sources
# actually supply, and deliberately additive-then-capped rather than
# multiplicative: a missing input (GDELT never reports fatalities; UCDP never
# reports mentions) should cost an event some score, not zero it out.
_SEVERITY_BASE = {
    "One-sided violence": 45,        # civilians targeted
    "Unconventional mass violence": 45,
    "State-based armed conflict": 40,
    "Fighting": 35,
    "Non-state conflict": 35,
    "Battle": 35,
    "Explosion": 35,
    "Assault": 30,
    "Violence against civilians": 40,
}
_SEVERITY_DEFAULT_BASE = 25


def _severity_for(event_type: str | None, fatalities: int, source_count: int,
                  mentions: int, goldstein) -> int:
    label = (event_type or "").strip()
    base = _SEVERITY_DEFAULT_BASE
    for key, value in _SEVERITY_BASE.items():
        if key.lower() in label.lower():
            base = value
            break

    # sqrt so the difference between 1 and 10 dead matters far more than
    # between 200 and 400 -- the first is a scale change, the second isn't.
    fatality_points = min((fatalities or 0) ** 0.5 * 8, 30)

    # Independent confirmation is the strongest quality signal available.
    corroboration_points = min(max(source_count - 1, 0) * 10, 20)

    # How widely it's being reported. log-scaled: 500 mentions isn't 10x as
    # significant as 50, and this must never outweigh actual casualties.
    mentions_points = min(math.log10((mentions or 0) + 1) * 5, 10)

    # CAMEO's own -10..+10 intensity for the action; only the conflictual
    # half contributes.
    goldstein_points = min(max(-(goldstein or 0), 0), 10)

    return int(min(base + fatality_points + corroboration_points + mentions_points + goldstein_points, 100))


def _same_event(a: dict, b: dict) -> bool:
    if a["lat"] is None or a["lon"] is None or b["lat"] is None or b["lon"] is None:
        return False
    if a["dt"] is None or b["dt"] is None:
        return False
    if abs((a["dt"] - b["dt"]).days) > _MATCH_DAYS:
        return False
    if abs(a["lat"] - b["lat"]) > _MATCH_DEGREES or abs(a["lon"] - b["lon"]) > _MATCH_DEGREES:
        return False
    return True


def _merge_cluster(cluster: list[dict]) -> dict:
    cluster = sorted(cluster, key=lambda c: _SOURCE_PRIORITY.get(c["source"], 9))
    primary = cluster[0]
    sources = sorted({c["source"] for c in cluster})
    fatalities = max((c["fatalities"] or 0) for c in cluster)
    notes = primary["notes"] or next((c["notes"] for c in cluster if c["notes"]), None)
    date_str = primary["dt"].date().isoformat() if primary["dt"] else None
    # Only mark a GDELT id "consumed" (excluded from /api/news) when it was
    # actually merged with a *different* source -- that's the genuine
    # duplicate case (a UCDP row and a GDELT headline about the same
    # incident). A GDELT-only singleton cluster is still exactly one pin
    # here (Conflict & Violence) and, separately, one headline in News --
    # those are two different views of one item, not a duplicate to hide.
    # gdelt.py's own feed is already conflict-filtered (quad_class 3/4 only,
    # see gdelt.py's _parse_events) -- excluding every singleton too would
    # empty the News layer out entirely, not just fix real duplicates.
    gdelt_ids = [c["id"] for c in cluster if c["source"] == "gdelt" and c["id"]] if len(sources) > 1 else []
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
    severity = _severity_for(event_type, fatalities, len(sources), mentions, goldstein)
    return {
        "id": f"{primary['source']}:{primary['id']}",
        "severity": severity,
        "lat": primary["lat"],
        "lon": primary["lon"],
        "date": date_str,
        "event_type": event_type,
        "sub_event_type": primary["sub_event_type"],
        "actor1": primary["actor1"],
        "actor2": primary["actor2"],
        "fatalities": fatalities,
        "country": country,
        "notes": notes,
        "source": primary["source"],
        "corroborated": len(sources) > 1,
        "corroborated_by": sources,
        "mentions": mentions,
        "goldstein": goldstein,
        "avg_tone": avg_tone,
        "source_url": source_url,
        "_gdelt_ids": gdelt_ids,
    }


def _is_violent_gdelt_row(row: dict) -> bool:
    """Gate for GDELT rows entering the conflict layer.

    Two conditions, both required: the event is violence-typed
    (VIOLENCE_ROOT_CODES), and at least one party is an armed actor
    (ARMED_ACTOR_TYPES, or a named known group such as a listed militia).
    ACLED/UCDP rows never reach this -- they're curated conflict data and
    pass through untouched.
    """
    if row.get("event_root_code") not in VIOLENCE_ROOT_CODES:
        return False
    if row.get("actor1_type") in ARMED_ACTOR_TYPES or row.get("actor2_type") in ARMED_ACTOR_TYPES:
        return True
    # A named organisation carries the same signal even when CAMEO left the
    # type code blank, which it often does for non-state groups.
    return bool(row.get("actor1_group") or row.get("actor2_group"))


def _fuse(acled_state_rows: list[dict], gdelt_rows: list[dict]) -> list[dict]:
    # gdelt_rows arrive pre-filtered from _accumulate_violent_gdelt -- the
    # violence/armed-actor gate runs there so the accumulator only ever holds
    # rows worth keeping for three days.
    items = [_normalize_structured(row.get("source") or "acled", row) for row in acled_state_rows]
    items.extend(_normalize_gdelt(row) for row in gdelt_rows)
    items.sort(key=lambda c: _SOURCE_PRIORITY.get(c["source"], 9))

    assigned = [False] * len(items)
    merged = []
    consumed_gdelt: set[str] = set()
    for i, seed in enumerate(items):
        if assigned[i]:
            continue
        cluster = [seed]
        assigned[i] = True
        for j in range(i + 1, len(items)):
            if assigned[j]:
                continue
            if _same_event(seed, items[j]):
                cluster.append(items[j])
                assigned[j] = True
        record = _merge_cluster(cluster)
        consumed_gdelt.update(record.pop("_gdelt_ids"))
        merged.append(record)

    global _consumed_gdelt_ids
    _consumed_gdelt_ids = consumed_gdelt
    return merged


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


def _fetch() -> list[dict]:
    # registry.has() guards startup ordering -- a broken/slow import of
    # either acled.py or gdelt.py shouldn't crash this module's poll loop
    # (see app.py's per-module try/except at startup for the same
    # "one bad source stays inert" principle applied here).
    acled_state_rows = (registry.get("acled").data if registry.has("acled") else []) or []
    gdelt_rows = (registry.get("gdelt").data if registry.has("gdelt") else []) or []
    return _fuse(acled_state_rows, _accumulate_violent_gdelt(gdelt_rows))


async def _wait_for_inputs() -> None:
    # acled.py's own first poll (OAuth + paginated ACLED read + UCDP
    # candidate download) and gdelt.py's first window fetch both take real
    # time -- firing this module's first _fetch() immediately at cold start
    # reliably races them and fuses against still-empty state.data.
    deadline = time.time() + 60
    while time.time() < deadline:
        acled_ready = registry.has("acled") and registry.get("acled").version > 0
        gdelt_ready = registry.has("gdelt") and registry.get("gdelt").version > 0
        if acled_ready and gdelt_ready:
            return
        await asyncio.sleep(1)


async def start():
    state = registry.register("events", key_configured=True)
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
            await storage.record_conflict_events(items)
            await storage.record_snapshot("events", items, "id")
            corroborated = sum(1 for d in items if d.get("corroborated"))
            log.info(
                "Fused events: %d canonical (%d corroborated by 2+ sources) from ACLED + UCDP + GDELT",
                len(items), corroborated,
            )
            await storage.record_source_health("events", len(items), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Event fusion failed: %s", exc)
            await storage.record_source_health("events", None, False, str(exc))
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
