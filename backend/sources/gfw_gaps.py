"""AIS disabling events, as Global Fishing Watch records them.

The independent second opinion on the one thing backend/sources/dark_vessels.py
infers entirely from our own feed. That module watches the AIS history this
project collected and calls a long silence in watched waters "worth a look";
this one reports what a different organisation, with a different AIS feed and a
published methodology, concluded about the same behaviour worldwide.

Independent is the operative word. dark_vessels reads one upstream -- aisstream
-- so when that upstream stops, as it did for nine days in July 2026 and again
from 2026-08-05, the gap layer does not degrade, it inverts: no feed means no
positions, means no gaps to find, means an empty layer that looks like calm
water. This source has no such coupling. It kept answering throughout.

Two claims, and both of them are GFW's
--------------------------------------
Same discipline as gfw_detections.py, with the ownership shifted one step
further away from us:

  1. *This vessel's AIS transmission stopped for N hours.* GFW's **measurement**,
     of GFW's feed. Not ours, and not comparable to ours -- their satellite AIS
     reception is modelled per vessel (`positions_per_day_sat`), which is what
     lets them distinguish a transponder switched off from a receiver that
     could not hear it. We have no such model.
  2. *The disabling was intentional.* GFW's **inference**, carried as
     `intentional_disabling` and never renamed to anything that sounds like a
     finding of ours.

Nothing in this module asserts either. It reports that GFW asserts them, which
is why every record carries `publisher` and the dated attribution.

A measured caveat on the second one: every event in this dataset carries
`intentionalDisabling: true` -- all 19,976 rows of a first full sweep, and every
entry of every page sampled. So today the flag describes the dataset's inclusion
criterion rather than distinguishing one event in it from another, and anything
reading it as "GFW singled this one out" would be wrong. It is still carried,
because it is GFW's claim to make and theirs to widen, and because a field that
silently starts varying is better than one this module decided not to store.
Nothing here depends on it varying.

Why the corroboration is about the hull, not the event
------------------------------------------------------
The obvious design -- match a GFW gap to one of ours and mark it confirmed --
cannot work, and the reason is arithmetic rather than effort. Our AIS history is
kept for HISTORY_RETENTION_SECONDS, three days, so dark_vessels can only ever
see gaps inside that window. GFW's gaps batch runs five or more days behind wall
clock: on 2026-08-07 a four-day window returned zero events and the newest gap
in the feed began 2026-08-02. The two windows do not overlap and never will
without changing one of those numbers.

So what travels back to dark_vessels is a *prior*: how often GFW has recorded
this MMSI intentionally disabling over the window below, and when it last did.
A ship going quiet in the Gulf tonight is a different kind of interesting if the
same hull was flagged three times last month, and that statement survives the
lag. It is labelled as what it is -- history about a vessel, not evidence about
tonight -- because a reader who mistook it for confirmation would be reading a
five-day-old fact as a live one.

Two windows, one download
-------------------------
That prior wants a month. The map wants nothing like it, and for a while it got
one anyway: the full 30-day sweep was stored and served, so roughly 20,000 pins
were on offer and the oldest of them marked a vessel that went quiet four weeks
ago. A pin is read as a thing that happened, and drawn beside a live position it
makes a claim about *when* that nothing on the tile contradicts.

So the sweep still asks for the month -- it is ~20 requests against a quota it
uses 0.5% of, and the prior is the reason it exists -- and only the recent end
of it becomes pins (see PIN_LOOKBACK_DAYS). What this deliberately does not do
is reach the three days the rest of the map is held to. It cannot: the batch is
published five or more days behind wall clock, so a three-day window here would
draw an empty layer every day of the year, and an empty layer reads as calm
water rather than as a feed that has not caught up yet. That would be a worse
error than the one it fixed. The honest arrangement is a window that clears the
lag, a `disposition: CORROBORATING` gate so nobody is handed this layer unasked
(see frontend/src/map/scene.js), and `age_days` stated on every record.

What was measured and left out
------------------------------
`public-global-encounters-events` looked like the natural corroborator for
dark_vessels' ship-to-ship inference and is not. Measured on 2026-08-07 across a
seven-day window: 13,056 encounters globally, 11,242 of them inside this map's
AIS boxes, and *every one* of those was typed `fishing-fishing` with
`potentialRisk: false`. GFW's public encounters product is a fishing product --
carrier-to-fishing transshipment and fishing vessels rafted together -- while
the STS transfers dark_vessels looks for are tankers alongside tankers away from
port. Ingesting it would have added eleven thousand fishing boats corroborating
nothing. `public-global-loitering-events` was rejected on volume for the same
lack of a matching claim: 141,515 events in seven days.

Global, not chokepoint-bounded
------------------------------
config.WATCHED_WATERS bounds what this map will draw a conclusion from, which is
a constraint on inference and not on a batch download. A seven-day global window
is 2,795 gaps and three requests; the same window clipped to those boxes was two
events. The boxes would throw away 99.9% of a payload that costs nothing extra to
keep, so this fetches worldwide and lets the layer decide what to draw.

Licence
-------
CC BY-NC 4.0, the same terms and the same non-commercial restriction that
gfw_detections.py carries, propagating to anything derived from it. The
attribution GFW requires is dated, so it is built per sweep and travels on every
record rather than living in a frontend lookup table a new layer could forget to
join.
"""

import asyncio
import logging
import time
from datetime import date, datetime, timedelta, timezone

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.gfw_gaps")

BASE_URL = "https://gateway.api.globalfishingwatch.org"
EVENTS_PATH = "/v3/events"

# `:latest` resolves server-side -- the response metadata reported
# `public-global-gaps-events:v4.0` on 2026-08-07 -- so the version is read from
# each response rather than pinned here, and a GFW version bump is visible in
# the log instead of being a 404.
DATASET = "public-global-gaps-events:latest"

# How far back each sweep asks. Long because this is a *prior* about a hull
# rather than a live layer (see the module docstring): one month is enough for
# "has done this before" to mean something, and the payload is small -- a
# 14-day window was 9,402 events, so a month is roughly 20 requests at the page
# size below.
LOOKBACK_DAYS = 30

# How far back a gap may have started and still be drawn.
#
# One download, two consumers, opposite windows. dark_vessels wants the month
# above: "this hull has been flagged three times recently" is a statement about
# months and it survives the publication lag precisely because it never claims
# to be about tonight. The map wants much less, because a pin is read as a thing
# that happened -- and a gap that began four weeks ago, drawn beside a live
# position, is a claim about *when* that nothing on the tile contradicts. The
# whole 30 days used to be stored and served, so that claim was being made
# roughly 20,000 times.
#
# Ten rather than three, and the difference is the publisher's rather than ours.
# GFW issues this batch five or more days behind wall clock: measured on
# 2026-08-07, a four-day window returned zero events and the newest gap in the
# feed began 2026-08-02. A three-day pin window would therefore draw an empty
# layer every day of the year, and an empty layer reads as a broken feed rather
# than as calm water -- so it would be a worse lie than the one it fixed. Ten
# clears the lag with a few days of usable content behind it, and every record
# still states its own `age_days` so a reader is never asked to infer it.
#
# The rows this stops refreshing age out on their own: config.ENTITY_STALE_AFTER
# gives this kind two days, and eviction is measured from the last write, so a
# gap that leaves this window is simply no longer re-upserted and is gone within
# two days. Nothing here has to delete anything.
PIN_LOOKBACK_DAYS = 10

# The API's ceiling is generous: limit=1000 was accepted and returned 1000
# entries. `offset` is not optional -- sending `limit` without it is a 422 --
# and paging follows the response's own `nextOffset` rather than adding the page
# size, because the two are not required to agree.
PAGE_SIZE = 1000

# Pages per sweep, as a stop rather than an expectation. At 1,000 an entry this
# is 40,000 events, roughly double the busiest month measured; it exists so a
# paging bug or a `nextOffset` that stops advancing cannot spin forever against
# a metered API.
MAX_PAGES = 40

# Sort is not cosmetic here. The date filter selects events that *overlap* the
# window, so the unsorted default leads with multi-year disablings still open --
# the first page of a 10-day window began in 2020 and ran 54,574 hours. Newest
# first puts the events this is actually about at the front, which is what makes
# MAX_PAGES a safe stop rather than a silent truncation of the wrong end.
#
# Allowed values are exactly `+start`, `-start`, `+end`, `-end`; anything else
# is a 422.
SORT = "-start"

# A gap longer than this is not a vessel going dark, it is a hull that left the
# feed: the same multi-year records described above, which are almost all
# navigation aids and base stations rather than ships. Dropped rather than
# stored, because a pin drawn where something stopped transmitting in 2020 is
# not about anything happening now.
MAX_GAP_HOURS = 30 * 24

# Stored rows, newest first. entity_latest holds one row per record and every
# gap is a distinct immutable event, so without a cap this kind grows with the
# window rather than with the world.
#
# Sized against the window rather than guessed: the API reported 23,667 events
# for the 30 days to 2026-08-07. The first value tried here was 20,000, which
# silently dropped the oldest 3,700 and left the stored window running 4.6 to
# 28.1 days back instead of the 30 asked for -- a truncation visible nowhere
# except by measuring it. This clears that with headroom and stays a real stop.
MAX_RECORDS = 30_000

_TIMEOUT = httpx.Timeout(60.0, connect=15.0)

# Between pages. GFW's rate limit is not the binding constraint at this volume
# -- 20 requests every six hours -- but it costs nothing to be unhurried against
# a free non-commercial API.
PAGE_SPACING = 1.0


def attribution(today: date) -> str:
    """GFW's required form, which is dated and so cannot be a constant."""
    return f"Copyright {today.year}, Global Fishing Watch, Inc. Accessed on {today.isoformat()}."


def _epoch(iso: str | None) -> float | None:
    """One of GFW's `...Z` timestamps as epoch seconds."""
    if not isinstance(iso, str) or not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _number(value) -> float | None:
    """A figure that may arrive as a string.

    GFW is inconsistent about this within a single record: `durationHours` comes
    back as a float while `distanceKm` and `impliedSpeedKnots` beside it are
    strings, and `onPosition`'s coordinates are strings where `offPosition`'s
    are floats. Read leniently rather than per field, so a type that flips
    upstream does not silently empty a column.
    """
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_gap(entry: dict, now: float, credit: str) -> dict | None:
    """One /v3/events entry -> one stored record, or None if it is not usable.

    Placed where the vessel *went dark*, not where it came back: the last known
    position is the fact, the reappearance is the consequence. Same convention
    as dark_vessels.py, so the two layers can be read against each other without
    a reader having to know which end each one drew.
    """
    if not isinstance(entry, dict):
        return None
    event_id = entry.get("id")
    gap = entry.get("gap") or {}
    if not event_id or not isinstance(gap, dict):
        return None

    off = gap.get("offPosition") or {}
    lat = _number(off.get("lat"))
    lon = _number(off.get("lon"))
    if lat is None or lon is None:
        # Fall back to the event position, which is where the API places the
        # event as a whole. A record with no coordinates at all is dropped: this
        # is a map layer, and a gap that cannot be drawn is not one.
        position = entry.get("position") or {}
        lat = _number(position.get("lat"))
        lon = _number(position.get("lon"))
    if lat is None or lon is None:
        return None

    went_dark_at = _epoch(entry.get("start"))
    resumed_at = _epoch(entry.get("end"))
    hours = _number(gap.get("durationHours"))
    if hours is None and went_dark_at and resumed_at:
        hours = (resumed_at - went_dark_at) / 3600.0
    if hours is None or hours > MAX_GAP_HOURS:
        return None

    vessel = entry.get("vessel") or {}
    on = gap.get("onPosition") or {}
    distances = entry.get("distances") or {}

    return {
        "id": f"gfw:gap:{event_id}",
        "kind": "ais_disabling",
        "lat": lat,
        "lon": lon,
        # GFW's `ssvid` is the MMSI, which is what makes this joinable to
        # dark_vessels' records at all -- they key gaps on the same number.
        "mmsi": str(vessel.get("ssvid")) if vessel.get("ssvid") is not None else None,
        "name": vessel.get("name"),
        "flag": vessel.get("flag"),
        "vessel_type": vessel.get("type"),
        "vessel_id": vessel.get("id"),
        "went_dark_at": went_dark_at,
        "resumed_at": resumed_at,
        "gap_hours": round(hours, 1),
        "resumed_lat": _number(on.get("lat")),
        "resumed_lon": _number(on.get("lon")),
        "distance_km": _number(gap.get("distanceKm")),
        "implied_speed_kn": _number(gap.get("impliedSpeedKnots")),
        # GFW's inference, named as theirs. See the module docstring: this
        # module does not decide whether a disabling was deliberate, it reports
        # that GFW decided it.
        "intentional_disabling": gap.get("intentionalDisabling"),
        # The reception model behind that inference, carried so the claim can be
        # read rather than taken: a vessel GFW hears 90 times a day going silent
        # is a different fact from one it hears twice.
        "positions_per_day_sat": _number(gap.get("positionsPerDaySatReception")),
        "distance_from_shore_km": _number(distances.get("startDistanceFromShoreKm")),
        "distance_from_port_km": _number(distances.get("startDistanceFromPortKm")),
        # The failure this layer risks is a five-day-old gap rendering like a
        # live one, so the age is on every record rather than inferred by a
        # reader from a timestamp.
        "age_days": round((now - went_dark_at) / 86400.0, 1) if went_dark_at else None,
        "publisher": "Global Fishing Watch",
        "license": "CC BY-NC 4.0",
        "attribution": credit,
        # Not ours, and not a detection. Both flags are read by the renderer,
        # which draws anything inferred with the dashed treatment.
        "inferred": True,
        "source": "gfw",
    }


# A ship's MMSI is nine digits. GFW's `ssvid` field is not clean -- a real sweep
# produced keys of "2", "11", "14", "15" and "25" among the 6,950 -- and those
# are not vessels whose history is being described, they are malformed
# identifiers. Left in, each one is a bucket that any record carrying the same
# junk value would join to, which is the quiet way an unrelated hull acquires
# somebody else's record of going dark. Dropped instead: a prior that cannot be
# attributed to a specific vessel is not a prior about anything.
def is_ship_mmsi(value: str | None) -> bool:
    return bool(value) and value.isdigit() and len(value) == 9


def drawable(records: list[dict], now: float) -> list[dict]:
    """The slice of a sweep recent enough to put on the map.

    Everything outside it stays in `records` and still builds the hull priors --
    that is the point of slicing here rather than narrowing the fetch. A shorter
    request would save nothing worth having (the sweep is ~20 paged requests
    against a quota it uses 0.5% of) and would cost the prior the history that
    makes it worth reading.

    A gap with no start time is not drawn. Every other layer on this map keeps an
    undated record rather than hiding data over a missing field, and the
    exception is argued rather than inherited: `age_days` is on every record here
    *because* the failure this layer risks is a five-day-old gap rendering like a
    live one, and a record with no start cannot make that statement at all.
    parse_gap already drops a gap with no coordinates on the same reasoning.
    """
    cutoff = now - PIN_LOOKBACK_DAYS * 86400
    return [r for r in records if (r.get("went_dark_at") or 0.0) >= cutoff]


def vessel_priors(records: list[dict]) -> dict[str, dict]:
    """Records -> what is known about each hull, keyed by MMSI.

    The shape dark_vessels reads back (see its `gfw_prior` handling). Deliberately
    small: a count, the most recent occurrence and whether GFW called any of them
    intentional. Everything else stays on the events themselves, because this is
    meant to annotate an inference, not to restate a layer inside it.
    """
    priors: dict[str, dict] = {}
    for record in records:
        mmsi = record.get("mmsi")
        if not is_ship_mmsi(mmsi):
            continue
        prior = priors.setdefault(mmsi, {
            "events": 0,
            "intentional_events": 0,
            "last_gap_at": None,
            "last_gap_hours": None,
            "publisher": "Global Fishing Watch",
        })
        prior["events"] += 1
        if record.get("intentional_disabling"):
            prior["intentional_events"] += 1
        went_dark_at = record.get("went_dark_at")
        if went_dark_at and (prior["last_gap_at"] is None or went_dark_at > prior["last_gap_at"]):
            prior["last_gap_at"] = went_dark_at
            prior["last_gap_hours"] = record.get("gap_hours")
    return priors


async def _page(client: httpx.AsyncClient, start: date, end: date, offset: int) -> dict:
    params = {
        "datasets[0]": DATASET,
        "start-date": start.isoformat(),
        "end-date": end.isoformat(),
        "limit": PAGE_SIZE,
        "offset": offset,
        "sort": SORT,
    }
    response = await client.get(f"{BASE_URL}{EVENTS_PATH}", params=params)
    response.raise_for_status()
    return response.json()


async def _fetch_all(client: httpx.AsyncClient, start: date, end: date) -> tuple[list[dict], str | None]:
    """Every page of the window. Returns (entries, the dataset version GFW used)."""
    entries: list[dict] = []
    version: str | None = None
    offset = 0
    for page in range(MAX_PAGES):
        if page:
            await asyncio.sleep(PAGE_SPACING)
        body = await _page(client, start, end, offset)
        datasets = (body.get("metadata") or {}).get("datasets") or []
        if datasets and version is None:
            version = datasets[0]
        batch = body.get("entries") or []
        entries += batch
        next_offset = body.get("nextOffset")
        # Three separate ends, and only the first is the ordinary one: a short
        # page, a null nextOffset (GFW's "that was the last page"), and an
        # offset that did not move, which would otherwise re-request the same
        # page until MAX_PAGES.
        if not batch or next_offset is None or next_offset == offset:
            break
        offset = next_offset
    else:
        log.warning(
            "GFW gaps: stopped at the %d-page ceiling with %d entries -- the window "
            "may be truncated (newest first, so the oldest end is what is missing)",
            MAX_PAGES, len(entries),
        )
    return entries, version


async def ingest_once():
    """One sweep: fetch the window, store the events and the per-hull priors.

    Two writes, on purpose. The events are point rows and go to entity_latest
    like any other layer; the priors are a small keyed document and go to
    reference_snapshots, because dark_vessels needs to look a hull up by MMSI
    and reading 20,000 rows out of Postgres every fifteen minutes to build that
    dictionary in the refine process would be the expensive way to do it.
    """
    key_configured = bool(config.GFW_API_TOKEN)
    state = registry.ensure("gfw_gaps", key_configured=key_configured)
    if not key_configured:
        # Recorded rather than only set on the state: this process serves no
        # /api/health of its own, so a missing token that never reaches
        # source_health leaves the backend reporting "waiting for the ingest
        # service to run for the first time" forever -- the wrong problem.
        state.last_error = "GFW_API_TOKEN not set in .env"
        await storage.record_source_health("gfw_gaps", None, False, state.last_error)
        return

    now = time.time()
    today = datetime.fromtimestamp(now, tz=timezone.utc).date()
    start = today - timedelta(days=LOOKBACK_DAYS)
    credit = attribution(today)
    headers = {"Authorization": f"Bearer {config.GFW_API_TOKEN}"}

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=headers) as client:
            entries, version = await _fetch_all(client, start, today)

        records = [r for r in (parse_gap(e, now, credit) for e in entries) if r]
        # Newest first, then capped. The sort is restated here rather than
        # trusted from the request because a record with no start timestamp
        # would otherwise sit wherever the API happened to put it, and the cap
        # is the one place the order decides what is thrown away.
        records.sort(key=lambda r: r.get("went_dark_at") or 0.0, reverse=True)
        records = records[:MAX_RECORDS]

        # The prior is built from the whole window and the pins from its recent
        # end -- see drawable(). Order matters: priors first, off `records`, so
        # narrowing what the map draws can never quietly narrow what
        # dark_vessels knows.
        priors = vessel_priors(records)
        pins = drawable(records, now)
        state.data = pins
        state.last_success = time.time()
        state.last_error = None
        await storage.record_snapshot("gfw_gaps", pins, id_field="id")
        await storage.record_reference("gfw_vessel_priors", priors)
        # The pin count, because this is the number a reader compares against an
        # empty layer. The sweep total is in the log line below.
        await storage.record_source_health("gfw_gaps", len(pins), True)

        intentional = sum(1 for r in pins if r.get("intentional_disabling"))
        newest = max((r.get("went_dark_at") or 0.0) for r in records) if records else 0.0
        log.info(
            "GFW gaps: %d disabling events over %d days, %d of them inside the "
            "%d-day pin window (%d called intentional), %d vessels with a prior, "
            "dataset %s, newest event %.1f days old",
            len(records), LOOKBACK_DAYS, len(pins), PIN_LOOKBACK_DAYS,
            intentional, len(priors),
            version or DATASET,
            (now - newest) / 86400.0 if newest else -1.0,
        )
    except Exception as exc:  # noqa: BLE001 - the ingest loop keeps going
        state.last_error = str(exc)
        log.warning("GFW gaps sweep failed: %s", exc)
        await storage.record_source_health("gfw_gaps", None, False, str(exc))
