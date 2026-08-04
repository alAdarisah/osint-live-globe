import asyncio
import logging
import re
import time
from datetime import datetime, timezone

from backend import config, storage
from backend.cache import registry
from backend.sources.acled import UCDP_VIOLENCE_TYPE

log = logging.getLogger("osint-globe.conflict_watch")

# No HTTP fetching of its own -- UCDP GED Candidate rows and GDELT conflict
# candidates are already being polled by backend/sources/acled.py and
# backend/sources/gdelt.py respectively (see registry.get(...).data below).
# This module's own work is entirely local: NLP-lite extraction over GDELT's
# real_title text, cross-referencing it against UCDP for corroboration, and
# persisting the result to its own SQLite table -- no ACLED account/key is
# read or required anywhere in this file.

# Same 3 buckets acled.py already classifies UCDP rows into, reused here so
# GDELT-derived and UCDP-derived items share one vocabulary in the frontend
# instead of two incompatible event_type taxonomies for the same layer.
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

# Casualty phrasing this loose (rather than a strict grammar) is deliberately
# tolerant -- headlines vary too much in word order for a rigid pattern, and
# this only needs to be "roughly right for a confidence signal," not
# authoritative (that's what corroboration against UCDP is for).
_CASUALTY_RE = re.compile(
    r"(\d+)\s*(?:people\s+)?(?:were\s+)?(?:reportedly\s+)?(killed|kills?|dead|died|wounded|injured)",
    re.IGNORECASE,
)
# Headlines as often lead with the verb ("kills 12", "gunmen kill 3") as
# follow it ("12 killed") -- this second pattern catches that ordering,
# which the number-then-keyword pattern above misses entirely.
_CASUALTY_RE_VERB_FIRST = re.compile(r"kills?\s+(\d+)", re.IGNORECASE)

# UCDP publishes month-old-or-fresher rows; a GDELT headline and a UCDP row
# describing the same incident should land within a few days of each other
# even accounting for reporting lag on either side.
_MATCH_DAYS = 2
# Coarse degree-based box rather than true haversine -- cheap, and at this
# radius (~55km at the equator, tighter at higher latitudes) the imprecision
# doesn't change which UCDP row is the right match, only pads the margin
# slightly at extreme latitudes.
_MATCH_DEGREES = 0.5


def _classify(text: str) -> tuple[str, str | None]:
    lowered = text.lower()
    if any(w in lowered for w in _ONESIDED_WORDS):
        return UCDP_VIOLENCE_TYPE["3"], "One-sided violence"
    has_state = any(w in lowered for w in _STATE_ACTOR_WORDS)
    has_nonstate = any(w in lowered for w in _NONSTATE_ACTOR_WORDS)
    # A government-side actor word means the state is a party, whether or not
    # the other side is also named -- that's UCDP's own "state-based" bucket.
    # Only non-state actor words with no state actor present is the
    # non-state-conflict bucket (two armed groups fighting each other).
    if has_state:
        return UCDP_VIOLENCE_TYPE["1"], "State-based armed conflict"
    if has_nonstate:
        return UCDP_VIOLENCE_TYPE["2"], "Non-state conflict"
    return "Conflict event", None


def _extract_fatalities(text: str) -> int:
    best = 0
    for match in _CASUALTY_RE.finditer(text):
        if match.group(2).lower() in ("killed", "kill", "kills", "dead", "died"):
            best = max(best, int(match.group(1)))
    for match in _CASUALTY_RE_VERB_FIRST.finditer(text):
        best = max(best, int(match.group(1)))
    return best


def _parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.strptime(s[:8], "%Y%m%d").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        except ValueError:
            return None


def _from_gdelt(candidates: list[dict], ucdp_rows: list[dict]) -> list[dict]:
    items = []
    for c in candidates:
        headline = (c.get("real_title") or "").strip()
        text = f"{headline} {c.get('location') or ''}"
        if not text.strip():
            continue
        event_type, sub_event_type = _classify(text)
        fatalities = _extract_fatalities(text)
        lat, lon = c.get("lat"), c.get("lon")
        added = _parse_date(c.get("date_added"))
        corroborated_by = []
        if lat is not None and lon is not None and added:
            for u in ucdp_rows:
                u_added = _parse_date(u.get("date"))
                if not u_added or abs((added - u_added).days) > _MATCH_DAYS:
                    continue
                if abs((u.get("lat") or 0) - lat) > _MATCH_DEGREES or abs((u.get("lon") or 0) - lon) > _MATCH_DEGREES:
                    continue
                corroborated_by.append("ucdp")
                break
        items.append(
            {
                "id": f"cw-gdelt-{c.get('event_id')}",
                "lat": lat,
                "lon": lon,
                "date": added.date().isoformat() if added else None,
                "event_type": event_type,
                "sub_event_type": sub_event_type,
                "actor1": c.get("actor1"),
                "actor2": c.get("actor2"),
                "fatalities": fatalities,
                "country": None,
                "notes": headline[:400],
                "source": "gdelt-nlp",
                "corroborated": bool(corroborated_by),
                "corroborated_by": corroborated_by,
            }
        )
    return items


def _from_ucdp(ucdp_rows: list[dict], acled_configured_rows: list[dict]) -> list[dict]:
    items = []
    for u in ucdp_rows:
        corroborated_by = []
        for a in acled_configured_rows:
            if a.get("date") == u.get("date") and a.get("country") == u.get("country"):
                corroborated_by.append("acled")
                break
        item = dict(u)
        item["id"] = f"cw-{u.get('id')}"
        item["corroborated"] = bool(corroborated_by)
        item["corroborated_by"] = corroborated_by
        items.append(item)
    return items


def _fetch() -> list[dict]:
    # registry.has() guards startup ordering -- _SOURCE_MODULES normally
    # starts acled/gdelt before this module, but a broken/slow import of
    # either shouldn't crash this one's poll loop (see app.py's per-module
    # try/except at startup for the same "one bad source stays inert"
    # principle applied here).
    acled_state_data = (registry.get("acled").data if registry.has("acled") else []) or []
    ucdp_rows = [d for d in acled_state_data if d.get("source") == "ucdp"]
    # Only used as an optional corroboration signal, never emitted as one of
    # this layer's own primary items -- see the module docstring above.
    acled_rows = [d for d in acled_state_data if d.get("source") == "acled"]
    gdelt_candidates = (registry.get("gdelt").data if registry.has("gdelt") else []) or []

    items = _from_ucdp(ucdp_rows, acled_rows)
    items.extend(_from_gdelt(gdelt_candidates, ucdp_rows))
    return items


async def _wait_for_inputs() -> None:
    # acled.py's own first poll (OAuth + paginated ACLED read + UCDP
    # candidate download) and gdelt.py's first window fetch both take real
    # time -- firing this module's first _fetch() immediately at cold start
    # (the old behavior) reliably raced them and computed against still-empty
    # state.data, so the very first poll -- and everything cached from it
    # until the next GDELT_POLL_INTERVAL -- came back with 0 items even
    # though both inputs land moments later. Poll for "has completed at
    # least one real fetch" rather than sleeping a guessed duration, since
    # either source's first-poll time varies (embargo re-check, network).
    deadline = time.time() + 60
    while time.time() < deadline:
        acled_ready = registry.has("acled") and registry.get("acled").version > 0
        gdelt_ready = registry.has("gdelt") and registry.get("gdelt").version > 0
        if acled_ready and gdelt_ready:
            return
        await asyncio.sleep(1)


async def start():
    state = registry.register("conflict_watch", key_configured=True)
    await _wait_for_inputs()
    while True:
        try:
            items = _fetch()
            state.data = items
            state.last_success = time.time()
            state.last_error = None
            await storage.record_conflict_watch_events(items)
            corroborated = sum(1 for d in items if d.get("corroborated"))
            log.info(
                "Conflict watch: %d items (%d corroborated) from UCDP + GDELT NLP",
                len(items), corroborated,
            )
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Conflict watch fetch failed: %s", exc)
        await asyncio.sleep(config.GDELT_POLL_INTERVAL)
