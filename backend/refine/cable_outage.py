"""Task 38: does a country's internet-outage score spike at the same time as
something is happening near its submarine-cable landings?

**This is a coincidence, not a cause, and every string this module writes says
so.** A cable fault and an outage score sharing a window of time and distance
means exactly that -- they were observed near each other -- and nothing more.
Submarine-cable faults are overwhelmingly the result of ordinary maritime
activity (anchors dragged across a route, dredging near a landing), not
anything deliberate; that is the one qualitative claim this module is allowed
to make, and it makes no claim at all about any specific event or country.
NOTE below is that sentence's one home -- every reader of this document (the
panel, the raw JSON, a future card) gets it from here, never a second
hand-typed copy that could drift from it.

**Provenance is "derived", never "measured", "reported" or "inferred".** A
coincidence is arithmetic and geometry over three already-collected signals --
backend/sources/outages.py's own IODA composite, backend/sources/cables.py's
landing points, and this map's own fused conflict_events -- not a new
observation about any of them. See REFERENCE_NAME's own `provenance` field.

**Why this module keeps its own history.** backend/sources/outages.py's own
module docstring is explicit that IODA's `scores.overall` is a composite, and
that every poll's `reference_snapshots` document (`outages`) is a snapshot of
*now*, not a series -- there is no stored history to compute a "spike" against
directly. Unlike naval_presence.py and infra_risk.py, which recompute a fixed
window straight from entity_history or conflict_events on every pass, this
module is the one place in the refine tier that has to build its own time
series from scratch, one sample at a time, because the source it reads has
none. `update_history` below does that: a small, bounded, keyed
reference_snapshots document (HISTORY_NAME) -- never entity_history, and never
unbounded (see MAX_SAMPLES_PER_COUNTRY and BASELINE_LOOKBACK_HOURS).

**Cursor discipline.** `compute()` reads the *last durably written* history at
the top of every pass, computes this pass's document from it, and only then
attempts to persist an updated history for the *next* pass to read. If that
write fails, this pass's own document was still computed from the last known-
good history (never from the update that didn't land), and the next pass reads
storage fresh -- so a failed write costs at most the one sample that pass would
have contributed, never a silently pruned window of samples that were never
actually saved. See compute()'s own comment at the point of that write.

**"Found nothing" vs "did not look" vs "too soon to tell" vs "never seen".**
Four different facts this module keeps apart, for two independent axes:

  - The event search (mirroring infra_risk.py's own three-way split): an event
    with no usable coordinate (`events_missing_coordinate`), one with no
    `geo_radius_km` (`events_without_radius`, never searched), and one that was
    searched and matched no landing (`events_searched`, contributes nothing to
    `coincidences`) are three different facts, never collapsed into each other.

  - The spike call, per landing-holding country (`statuses`): `spike` (this
    poll's score cleared SPIKE_RATIO times the highest score this module has
    recorded for the country in the retained window), `no_spike` (checked,
    and either the current score is not elevated enough or the country simply
    is not reporting above IODA's own MIN_SCORE floor right now, but this
    module has seen it above that floor before), `insufficient_history` (this
    module has not watched this country, or has not watched it for long
    enough, to say either of the above with any confidence), `never_observed`
    (this module's own history is old enough, in aggregate, that "IODA has
    never once put this country above its floor while we were watching" is a
    real fact rather than an artefact of having only just started), and
    `not_checkable` (this country's landings were found, but this map has no
    ISO2 code for the country at all -- see the geometric-attribution note
    below -- so there is no key IODA's own document could ever be looked up
    under, checked or not; a permanent structural gap, not a temporal one).
    The middle two are easy to conflate -- both look like "zero samples" from
    this country's own row -- and are told apart by the *whole* history's own
    age (`_meta.started_at`, not any one country's), see _spike_status below.

**Landing -> country is geometric, not by name.** The first version of this
module joined a landing to a country by parsing the trailing token off
TeleGeography's own free-text name ("Beculuk, Indonesia") against Natural
Earth's admin-0 name list. Task 38 review (Important 2): that join silently
dropped every US landing, because TeleGeography writes "United States" and
Natural Earth's own ADMIN field is "United States of America" -- a country a
reader is near-certain to check first, checked never at all, and reading
identically to "checked, quiet". A landing's *coordinate* carries no such
spelling disagreement, and this map already draws the polygon to test it
against (backend/sources/countries.py) -- so `group_landings_by_country`
below tests each landing's point against backend/regions.py's CountryIndex
(itself a Python port of the frontend's own countryHitTest.js) instead. A
landing whose point falls inside a real Natural Earth feature but that
feature carries no ISO2 (Natural Earth's own "-99" sentinel, past the three-
country override below) is still grouped by country -- its own landings
still cohere -- but is marked `not_checkable` rather than silently defaulting
to a status that would misreport "checked" as "quiet".
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from backend import config, regions, storage
from backend.sources.proximity import ProximityIndex

log = logging.getLogger("osint-globe.cable_outage")

REFERENCE_NAME = "cable_outage"
HISTORY_NAME = "cable_outage_history"

# How far back a conflict event may have first been seen and still count as
# "concurrent" with a spike. Matched to outages.py's own WINDOW_SECONDS (a
# day): that is already the window IODA's own summary describes an outage
# over, so "concurrent" means "inside the same day IODA is already talking
# about", not a second, differently-sized window layered on top of it.
EVENT_WINDOW_HOURS = 24

# How far back this module's own score history (HISTORY_NAME) retains a
# sample, per country, and therefore how far back a baseline can ever reach.
# Same day-scale window as EVENT_WINDOW_HOURS, for the same reason: IODA's own
# summary is itself a rolling day, so a baseline drawn from a wider window
# would compare "now" against data older than IODA's own signal claims to
# describe.
BASELINE_LOOKBACK_HOURS = 24

# A spike verdict needs at least this many prior samples in the retained
# window before this module will call it either way -- one lucky earlier
# sample is not a baseline. See _spike_status.
MIN_BASELINE_SAMPLES = 3

# ...and the oldest of those samples has to be at least this old, so a
# baseline built entirely out of the last hour's worth of polling (a country
# that started reporting minutes ago) is not mistaken for a settled recent
# history. Deliberately looser than MIN_BASELINE_SAMPLES alone would give at
# this module's own poll cadence (config.CABLE_OUTAGE_INTERVAL), so both
# conditions have to fail together for a country to be judged too new.
MIN_BASELINE_SPAN_HOURS = 6

# How far above its own recent peak a country's score has to climb before
# this module calls it a spike. Unmeasured -- like naval_presence.py's
# PORT_MATCH_RADIUS_KM and MIN_WINDOW_AIS_REPORTS, no operator has watched a
# real season of IODA composites to know where the honest threshold sits, so
# this is a deliberately conservative starting guess (double the highest
# score this module has itself recorded for the country) rather than a
# calibrated figure. It is a judgement call on an unbounded composite score,
# never a claim about what fraction of a country actually went offline --
# see outages.py's own docstring on what scores.overall is not.
SPIKE_RATIO = 2.0

# How old this module's *own* history has to be, in aggregate, before a
# landing-holding country with zero recorded samples is called "never
# observed" rather than "insufficient history". Same window as
# BASELINE_LOOKBACK_HOURS: once this module has been watching for at least
# one full retained window, a country that still has no sample in it is a
# real fact about that country, not an artefact of this module having only
# just started.
MATURITY_HOURS = 24

# A second, independent bound on HISTORY_NAME's size, on top of the time-based
# pruning BASELINE_LOOKBACK_HOURS already does -- the same "retention alone
# assumes normal cadence, the cap holds even if that assumption breaks" belt-
# and-braces MAX_SAMPLES_PER_COUNTRY name pattern this codebase already uses
# elsewhere (see vessel_profile.py's VESSEL_DRAUGHT_MIN_SAMPLES neighbourhood).
# At an IODA-matching 15-minute cadence this is well over BASELINE_LOOKBACK_
# HOURS' worth of samples for one country; it only bites if this job were ever
# run far faster than intended.
MAX_SAMPLES_PER_COUNTRY = 200

# How many ranked coincidences the document carries, and how many matched
# events one coincidence entry carries -- same "shortlist, not a re-listing of
# everything" reasoning as infra_risk.py's own TOP_N.
TOP_N = 30
EVENTS_PER_COINCIDENCE = 10

SPIKE = "spike"
NO_SPIKE = "no_spike"
INSUFFICIENT_HISTORY = "insufficient_history"
NEVER_OBSERVED = "never_observed"
NOT_CHECKABLE = "not_checkable"

# The one sentence this whole feature exists to attach to every number it
# produces. Rendered verbatim by the frontend panel (never re-typed there),
# the same "one home for the caveat" discipline infra_risk.py's own `note`
# already established for proximity-vs-causation. Deliberately avoids the
# words a later edit must never reintroduce here -- see
# backend/tests/test_cable_outage.py's own banned-language assertion for the
# exact list this sentence is written to never need.
NOTE = (
    "This is a coincidence, not causation. An outage score and a nearby event "
    "sharing this window means only that they were observed close together in "
    "time and place -- nothing here says or implies one explains the other. "
    "Submarine-cable faults are overwhelmingly the result of ordinary maritime "
    "activity, such as anchors dragged across a route or dredging near a "
    "landing, rather than anything deliberate."
)

_EVENTS_SQL = """
SELECT id, lat, lon, geo_radius_km, event_type, country, notes, severity, first_seen
  FROM conflict_events
 WHERE first_seen >= $1 AND pipeline_version = $2
"""

# Natural Earth ships "-99" as the ISO2 of a handful of countries -- France,
# Norway and Kosovo among them. backend/sources/outages.py already had to
# solve exactly this problem to join IODA's country codes back to admin-1
# boundaries (see its own _ISO3_BY_ISO2_OVERRIDE), and this is the same three
# countries' ISO2, copied from that already-reviewed constant rather than
# re-derived -- not a new fact, the same one this codebase already ships.
# Without it, every landing on France's or Norway's own coastline (both carry
# several) would be grouped under its own name but never checkable against
# an outage score, for a reason that has nothing to do with the geometric
# join itself.
_ISO2_NAME_OVERRIDE = {"France": "FR", "Norway": "NO", "Kosovo": "XK"}

# How far a landing may sit outside every country polygon and still snap to
# the nearest one -- see regions.CountryIndex.nearest_country's own
# docstring for why this fallback exists at all (cable landings are drawn at
# the coast, not surveyed onto it, so a real, correctly-placed landing often
# lands a short distance seaward of Natural Earth's own 1:50m coastline).
# Same figure and the same "coastal snap" reasoning as naval_presence.py's
# own PORT_MATCH_RADIUS_KM.
LANDING_SNAP_RADIUS_KM = 25.0


# --- landing -> country ------------------------------------------------------


def _country_key(hit: dict) -> tuple[str | None, bool]:
    """A regions.CountryIndex hit (`{"iso2", "name"}`) -> (key, checkable).

    `key` is what group_landings_by_country/build_document key a country
    by. `checkable` says whether that key can ever be looked up in
    outages.py's own ISO2-keyed document: true for a real Natural Earth ISO2
    or one of the three curated overrides above, false for the country's
    bare name -- the fallback that still groups a country's own landings
    together (so its landing count is real and its name is real) even though
    this map has no code to compare its outage score against at all. See
    NOT_CHECKABLE.
    """
    iso2 = hit.get("iso2")
    if iso2:
        return iso2, True
    name = hit.get("name")
    if name and name in _ISO2_NAME_OVERRIDE:
        return _ISO2_NAME_OVERRIDE[name], True
    return name, False


def group_landings_by_country(
    landings: list[dict], country_index: "regions.CountryIndex",
) -> tuple[dict[str, list[dict]], dict, set[str]]:
    """entity_latest("cable_landings") rows -> {key: [landing, ...]}, how many
    were excluded and why, and which keys are `not_checkable` (see
    _country_key).

    A planned (`is_tbd`) landing is excluded outright, not merely flagged: its
    site is, by TeleGeography's own definition, not yet settled (see
    cables.py's own docstring), so there is no fixed point for a conflict
    event to be "near" at all -- counting a not-yet-built landing toward a
    coincidence would be a claim about a location that does not exist yet.

    A landing whose coordinate falls outside every polygon `country_index`
    holds is first retried with country_index.nearest_country (a landing is
    drawn at the coast, not surveyed onto it -- see LANDING_SNAP_RADIUS_KM's
    own comment); only a landing still unplaced after that -- genuinely in
    open water, or too far from any coastline this map's 1:50m resolution
    draws -- is counted under `landings_unmatched`. That is a different,
    rarer fact than `landings_unattributed` below (a country *was* found, it
    just has no ISO2 this map can check).
    """
    by_country: dict[str, list[dict]] = {}
    unattributed: set[str] = set()
    total = planned_excluded = unmatched = matched = unattributed_landings = snapped = 0
    for landing in landings or ():
        total += 1
        if landing.get("planned"):
            planned_excluded += 1
            continue
        lat, lon = landing.get("lat"), landing.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        landing_id = landing.get("id")
        if landing_id is None:
            continue
        hit = country_index.country_at(lat, lon)
        if hit is None:
            hit = country_index.nearest_country(lat, lon, max_km=LANDING_SNAP_RADIUS_KM)
            if hit is not None:
                snapped += 1
        if hit is None:
            unmatched += 1
            continue
        key, checkable = _country_key(hit)
        if key is None:
            unmatched += 1
            continue
        matched += 1
        if not checkable:
            unattributed.add(key)
            unattributed_landings += 1
        by_country.setdefault(key, []).append({
            "id": landing_id, "name": landing.get("name"), "lat": lat, "lon": lon,
        })
    stats = {
        "landings_total": total,
        "landings_planned_excluded": planned_excluded,
        "landings_unmatched": unmatched,
        "landings_matched": matched,
        "landings_unattributed": unattributed_landings,
        "landings_snapped": snapped,
    }
    return by_country, stats, unattributed


# --- score history ------------------------------------------------------


def update_history(history: dict, outages: dict, now: float, retention_seconds: float) -> dict:
    """`history` (this module's own bounded state, as it stood *before* this
    pass) plus this pass's outages.py snapshot -> a new history dict, with
    this pass's sample appended per currently-reporting country and every
    sample older than `retention_seconds` dropped.

    Never mutates `history` -- build_document below is handed the pre-update
    copy so what it reasons about and what this function starts from are
    always the same object, never one already changed out from under the
    other by call order.

    A country `outages` does not currently mention gets no new sample, never a
    fabricated zero: IODA's composite has no natural zero to record, and a
    country simply stops appearing in outages.py's own filtered document once
    it drops back under MIN_SCORE (see that module's docstring) -- recording a
    0 here would manufacture a data point IODA never reported.
    """
    meta = dict((history or {}).get("_meta") or {})
    if not isinstance(meta.get("started_at"), (int, float)):
        meta["started_at"] = now
    new_history: dict = {"_meta": meta}

    countries = set((history or {}).keys()) | set((outages or {}).keys())
    countries.discard("_meta")
    cutoff = now - retention_seconds

    for code in countries:
        prior = list(((history or {}).get(code) or {}).get("samples") or [])
        record = (outages or {}).get(code)
        if isinstance(record, dict) and isinstance(record.get("score"), (int, float)):
            prior.append({"ts": now, "score": float(record["score"])})
        kept = [s for s in prior if isinstance(s.get("ts"), (int, float)) and s["ts"] >= cutoff]
        if len(kept) > MAX_SAMPLES_PER_COUNTRY:
            kept = kept[-MAX_SAMPLES_PER_COUNTRY:]
        if kept:
            new_history[code] = {"samples": kept}
    return new_history


def _spike_status(country_code: str, history: dict, current_score, now: float) -> dict:
    """One country's verdict against `history` (the *prior* history --
    excludes this pass's own sample, see update_history's own note on why
    build_document is never handed a copy that already includes it) and
    `current_score` (this pass's live outages.py reading, or None if the
    country is not currently above MIN_SCORE).

    Returns {"status", "current_score", "baseline_score", "ratio"} -- see the
    module docstring's own four-way breakdown of what each status means.
    """
    meta = (history or {}).get("_meta") or {}
    started_at = meta.get("started_at")
    state_mature = isinstance(started_at, (int, float)) and (now - started_at) >= MATURITY_HOURS * 3600

    prior = ((history or {}).get(country_code) or {}).get("samples") or []
    has_current = isinstance(current_score, (int, float))

    if not has_current:
        if prior:
            # Reported above the floor before, just not this poll -- a real,
            # checked "quiet right now", not "we have never looked".
            return {"status": NO_SPIKE, "current_score": None, "baseline_score": None, "ratio": None}
        return {
            "status": NEVER_OBSERVED if state_mature else INSUFFICIENT_HISTORY,
            "current_score": None, "baseline_score": None, "ratio": None,
        }

    if not prior:
        # Elevated right now, but this is the very first sample this module
        # has ever recorded for it -- there is no way to tell "just started"
        # from "has been elevated for days and we only just started watching".
        return {
            "status": INSUFFICIENT_HISTORY, "current_score": current_score,
            "baseline_score": None, "ratio": None,
        }

    valid = [s for s in prior if isinstance(s.get("ts"), (int, float)) and isinstance(s.get("score"), (int, float))]
    if not valid:
        return {
            "status": INSUFFICIENT_HISTORY, "current_score": current_score,
            "baseline_score": None, "ratio": None,
        }

    span_hours = (now - min(s["ts"] for s in valid)) / 3600.0
    if len(valid) < MIN_BASELINE_SAMPLES or span_hours < MIN_BASELINE_SPAN_HOURS:
        return {
            "status": INSUFFICIENT_HISTORY, "current_score": current_score,
            "baseline_score": None, "ratio": None,
        }

    baseline = max(s["score"] for s in valid)
    ratio = (current_score / baseline) if baseline > 0 else None
    status = SPIKE if (ratio is not None and ratio >= SPIKE_RATIO) else NO_SPIKE
    return {"status": status, "current_score": current_score, "baseline_score": baseline, "ratio": ratio}


# --- the document ------------------------------------------------------


def build_document(
    outages: dict, by_country: dict, landing_stats: dict, events: list[dict], history: dict, now: float,
    unattributed: set[str] = frozenset(),
) -> dict:
    """Everything above, combined -- no asyncpg, no network, so the
    correlation logic is directly testable, the same shape naval_presence.py
    and infra_risk.py's own build_document take.

    `outages`: backend/sources/outages.py's own parse_outages shape,
        {iso2: {"score": float, "country": str, ...}}.
    `by_country`, `landing_stats`, `unattributed`: group_landings_by_country's
        return.
    `events`: conflict_events rows already windowed to EVENT_WINDOW_HOURS,
        [{"id", "lat", "lon", "geo_radius_km", "event_type", "country",
          "notes", "severity", "first_seen"}, ...] -- first_seen a float
        (epoch seconds), the same convention `now` itself uses.
    `history`: this module's own prior score history (see update_history).
    """
    landing_points = [
        {"lat": landing["lat"], "lon": landing["lon"], "landing_id": landing["id"], "country_code": code}
        for code, landings in (by_country or {}).items()
        for landing in landings
    ]
    landing_index = ProximityIndex(landing_points, cell_deg=0.5)

    events_searched = events_without_radius = events_missing_coordinate = 0
    # {country_code: {event_id: event_summary}} -- a dict keyed on event id so
    # the same event matching two landings in the same country is recorded
    # once, not twice.
    matches_by_country: dict[str, dict[str, dict]] = {}

    for event in events or ():
        lat, lon = event.get("lat"), event.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            # No coordinate, no circle to search -- see infra_risk.py's own
            # identical three-way split, which this mirrors on purpose.
            events_missing_coordinate += 1
            continue
        radius = event.get("geo_radius_km")
        if not isinstance(radius, (int, float)) or radius <= 0:
            events_without_radius += 1
            continue
        events_searched += 1
        hits = landing_index.within(lat, lon, radius)
        if not hits:
            continue
        seen_countries = set()
        for point in hits:
            code = point["country_code"]
            if code in seen_countries:
                continue
            seen_countries.add(code)
            matches_by_country.setdefault(code, {})[event["id"]] = {
                "id": event["id"],
                "event_type": event.get("event_type"),
                "country": event.get("country"),
                "notes": event.get("notes"),
                "severity": event.get("severity"),
                "first_seen": event.get("first_seen"),
                "lat": lat,
                "lon": lon,
            }

    status_counts = {SPIKE: 0, NO_SPIKE: 0, INSUFFICIENT_HISTORY: 0, NEVER_OBSERVED: 0, NOT_CHECKABLE: 0}
    statuses: dict[str, dict] = {}
    coincidences: list[dict] = []

    for code, landings in (by_country or {}).items():
        if code in unattributed:
            # This country's landings were found geometrically, but it has no
            # ISO2 this map can look outages.py's own document up under --
            # not "checked and quiet", not "too little history yet": there is
            # no key to check at all, ever, until this map's own country data
            # carries one. See _country_key and the module docstring's own
            # "landing -> country is geometric" note.
            status_counts[NOT_CHECKABLE] += 1
            statuses[code] = {
                "status": NOT_CHECKABLE, "current_score": None, "baseline_score": None, "ratio": None,
                "country": code, "landing_count": len(landings),
            }
            continue

        verdict = _spike_status(code, history, (outages or {}).get(code, {}).get("score"), now)
        status_counts[verdict["status"]] += 1
        statuses[code] = {
            **verdict,
            "country": (outages or {}).get(code, {}).get("country") or code,
            "landing_count": len(landings),
        }

        if verdict["status"] != SPIKE:
            continue
        matched = matches_by_country.get(code)
        if not matched:
            # Spiking, with landings, but this window's searched events never
            # landed inside any of them -- a real "checked, found nothing",
            # captured in statuses/status_counts above, not a coincidence.
            continue
        matched_events = sorted(
            matched.values(), key=lambda e: e.get("first_seen") or 0, reverse=True,
        )[:EVENTS_PER_COINCIDENCE]
        coincidences.append({
            "country_code": code,
            "country": statuses[code]["country"],
            "current_score": verdict["current_score"],
            "baseline_score": verdict["baseline_score"],
            "ratio": verdict["ratio"],
            "landings": landings,
            "events": matched_events,
            "provenance": "derived",
        })

    # Most matched events first; ties broken on country_code so two countries
    # tied at (say) one matched event each keep a stable relative order from
    # one pass to the next, the same reasoning infra_risk.py's own site_id
    # tie-break gives.
    coincidences.sort(key=lambda entry: (-len(entry["events"]), entry["country_code"]))

    return {
        "as_of": now,
        "event_window_hours": EVENT_WINDOW_HOURS,
        "baseline_lookback_hours": BASELINE_LOOKBACK_HOURS,
        "spike_ratio": SPIKE_RATIO,
        "countries_with_landings": len(by_country or {}),
        "landing_stats": landing_stats,
        "events_searched": events_searched,
        "events_without_radius": events_without_radius,
        "events_missing_coordinate": events_missing_coordinate,
        "status_counts": status_counts,
        "statuses": statuses,
        "coincidences": coincidences[:TOP_N],
        "provenance": "derived",
        "note": NOTE,
    }


async def compute() -> dict:
    pool = storage.get_pool()
    if pool is None:
        return {}
    now_dt = datetime.now(timezone.utc)
    now = now_dt.timestamp()
    since = now_dt - timedelta(hours=EVENT_WINDOW_HOURS)

    outages, history, countries_geojson, landings = await asyncio.gather(
        storage.reference("outages"),
        storage.reference(HISTORY_NAME),
        storage.reference("countries"),
        storage.entity_latest("cable_landings"),
    )
    outages = outages or {}
    history = history or {}

    country_index = regions.CountryIndex(countries_geojson or {})
    by_country, landing_stats, unattributed = group_landings_by_country(landings, country_index)

    async with pool.acquire() as conn:
        rows = await conn.fetch(_EVENTS_SQL, since, config.CONFLICT_PIPELINE_VERSION)
    events = [
        {
            "id": r["id"], "lat": r["lat"], "lon": r["lon"], "geo_radius_km": r["geo_radius_km"],
            "event_type": r["event_type"], "country": r["country"], "notes": r["notes"],
            "severity": r["severity"],
            "first_seen": r["first_seen"].timestamp() if r["first_seen"] is not None else None,
        }
        for r in rows
    ]

    doc = build_document(outages, by_country, landing_stats, events, history, now, unattributed)

    updated_history = update_history(history, outages, now, BASELINE_LOOKBACK_HOURS * 3600)
    wrote = await storage.record_reference(HISTORY_NAME, updated_history)
    if not wrote:
        # This pass's own document (above) was already computed from the last
        # *durable* history, never from this update -- so nothing shown this
        # pass depends on whether this write lands. If it didn't, the next
        # pass reads the same last-durable copy back out of storage and tries
        # again with a newer sample; the cost is exactly this one pass's
        # sample, never a pruned window of samples that were never saved.
        log.warning("cable_outage: failed to persist score history for this pass")

    return doc


async def derive_forever():
    """Recompute the correlation on a loop, in the refine process.

    Same "publish an empty-but-real document rather than skip a pass"
    discipline every other refine job here follows: "no coincidence found"
    (empty `coincidences`) and "not computed yet" (no document at all) are
    different answers, and skipping a failed pass would leave a stale
    document quietly implying the first when the truth is the second.
    """
    while True:
        try:
            doc = await compute()
            await storage.record_reference(REFERENCE_NAME, doc)
            await storage.record_source_health(REFERENCE_NAME, len(doc.get("coincidences", [])), True)
            log.info(
                "Cable outage correlation: %d countries with landings, %d spiking, %d coincidence(s)",
                doc.get("countries_with_landings", 0),
                doc.get("status_counts", {}).get(SPIKE, 0),
                len(doc.get("coincidences", [])),
            )
        except Exception as exc:  # noqa: BLE001 - keep the loop alive
            log.warning("Cable outage correlation failed: %s", exc)
            await storage.record_source_health(REFERENCE_NAME, None, False, str(exc))
        await asyncio.sleep(config.CABLE_OUTAGE_INTERVAL)
