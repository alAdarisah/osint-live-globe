"""Flood alerts from GDACS, the EC JRC / UN global disaster alert system.

One publisher, one layer. GDACS runs the GLOFAS hydrological model over the
world's river basins and issues a Green/Orange/Red alert per flood event, keyed
to a stable numeric event id and revised in place as the event develops. It is
keyless, it is the reference source most humanitarian responders already work
from, and it is the only live water feed on the map.

--- why this is not a third publisher inside hazards.py ---------------------

It nearly was. A flood is a natural hazard, hazards.py already carries two
publishers on two clocks in one layer, and its GVP half is exactly the pattern
a slow secondary publisher needs. The loop was never the problem. What decided
it is what `kind` means once it leaves this file:

1. The hazards layer is a *two-way* switch on `kind` everywhere downstream --
   frontend/src/map/decorators.js:660 sends anything that is not "volcano" to
   decorateEarthquake, createMapController.js:1310 counts anything that is not
   "volcano" as a quake, and LayersSection.jsx does the same for its legend. A
   third kind under that layer key does not render as a new thing; it renders
   as an earthquake with no magnitude and no depth, and inflates the quake
   count. Making it render correctly means editing three frontend files, which
   is not this module's to do.
2. `kind` is also the eviction unit (config.ENTITY_STALE_AFTER). A quake is
   instantaneous and drops out of the USGS feed within a day; a GDACS flood
   event stays open for weeks and is revised through dozens of episodes. One
   window cannot answer both, and "hazards" is currently tuned to the volcano
   report's week.
3. The evidence is a different class. hazards.py's docstring can say "both
   feeds carry their own coordinates ... nothing to be uncertain about"
   precisely because a seismometer network and a volcano summit are measured
   positions. A GDACS flood point is a modelled centroid over an affected
   basin -- GDACS labels it `Centroid` itself -- so folding it in would mean
   weakening that claim for the whole module.
4. The dam-adjacency question this feed exists to answer ("is there a dam
   downstream of a flood warning", via backend/sources/proximity.py) wants to
   read the flood layer, not filter a mixed one.

The cost of the split is honest and is listed at the bottom of this docstring:
this module does nothing at all until someone registers it.

--- what a record claims ----------------------------------------------------

`severity` is GDACS's own alert level on the map's shared 0-100 scale, mapped
with the same numbers hazards.py gives USGS PAGER alerts, so a red flood and a
red quake mean the same thing to a reader comparing them side by side.

`geo_precision` is "region" for every record, never "locality". The feed's own
`polygonlabel` is "Centroid" and its `Class` is "Point_Centroid": the point is
the middle of an affected area, and the bbox GDACS ships with it is degenerate
(identical to the point), so nothing in the payload narrows it. The real extent
is the polygon at `footprint_url`, which this module links rather than fetches
-- one request per event would be a hundred requests per poll.

Records are *event-level*: the id is `gdacs:FL:<eventid>` with no episode in
it. GDACS revises an event by publishing a new episode -- there is a flood in
this sample on episode 64 -- and keying on `eventid:episodeid` would draw 64
pins for one flood and turn entity_history into a changelog of the publisher's
edits rather than of the world. The episode number is carried as a field so a
reader can still see which revision they are looking at.

Every event GDACS lists is published, including the ones it has closed:
`is_current` is carried verbatim and is the field a display filter belongs on.
Most of the list is closed at any moment (89 of 100 when this was written), so
a layer that draws all of it unfiltered is mostly history -- but that is a
thinning decision for the presentation, not a reason to drop rows the replay
timeline and the dam adjacency both want.

--- where this is wired up, now that it is ----------------------------------

- backend/app.py `_SOURCE_MODULES` starts the poller; `/api/floods` serves it.
- backend/config.py `ENTITY_STALE_AFTER["floods"]` is 14 days, well past the
  86400s default: every poll rewrites every row, so at the default a poller
  paused for a day would evict the layer whole, and GDACS keeps events open
  for weeks anyway.
- The frontend layer is its own key, `floods`, not a third kind inside
  `hazards`. decorateFlood in frontend/src/map/decorators.js draws it, on the
  shared severity ramp and with the dashed ring `geo_precision: "region"`
  requires; it sits in the Natural Hazards panel group beside its sibling.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.floods")

# The GeoJSON event list, filtered server-side to floods at any alert level.
# Preferred over GDACS's RSS feed (https://www.gdacs.org/xml/rss.xml): the RSS
# is 882 KB of all hazard types and would have to be filtered here, this is
# 130 KB already filtered, and it carries the structured alertscore, iso3 and
# footprint link the RSS summary does not.
GDACS_URL = (
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
    "?eventlist=FL&alertlevel=Green;Orange;Red"
)

# GLOFAS runs on a daily forecast cycle, but GDACS republishes throughout the
# day as episodes land -- the `datemodified` stamps in a single response spread
# across 06:00, 07:30, 12:14 and 12:49. Half an hour is the cost/latency
# balance: 48 requests a day for 130 KB against a public JRC endpoint, and at
# worst 30 minutes before an escalation to Red reaches the map. Polling this at
# the earthquake feed's 5 minutes would be ~290 requests a day to watch a
# number that moves on the order of hours.
REFRESH_INTERVAL = 30 * 60
FAILURE_RETRY_INTERVAL = 120  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# GDACS alert level -> the severity scale the rest of the map already speaks
# (frontend/src/map/severity.js's SEVERITY_BANDS). Deliberately the same
# numbers hazards.py's _PAGER_SEVERITY gives USGS PAGER alerts: both are a
# publisher's own coarse impact judgement rather than a physical measurement,
# so a red flood and a red quake should draw at the same weight. GDACS has no
# yellow band -- Green/Orange/Red is the whole scale -- so the 60 slot is
# simply unused here rather than invented for.
_ALERT_SEVERITY = {"red": 95, "orange": 80, "green": 35}


def _severity_for_alert(level: str | None) -> int:
    """0-100 on the map's shared severity scale, from GDACS's alert level.

    There is no fallback input to reach for. `alertscore` is GDACS's own finer
    number, but it is a different quantity on a different scale (1/2/3 here,
    with fractional episode scores alongside it) and deriving a 0-100 from it
    would be a claim GDACS has not made -- so it is carried as a field and a
    record GDACS left unrated scores 0.
    """
    return _ALERT_SEVERITY.get((level or "").strip().lower(), 0)


def _text(value) -> str | None:
    """A GDACS string field, or None when it is blank.

    Blank is the normal case, not the exception: `eventname` was empty on all
    100 events in the sample this was written against and `glide` on 96. An
    empty string reaching the popup renders as a present-but-nameless field,
    which reads as a bug rather than as an absence.
    """
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _iso_to_unix(value) -> float | None:
    """GDACS's naive ISO timestamps -> epoch seconds.

    They carry no offset ("2026-07-30T01:00:00") and are UTC: the same event's
    `htmldescription` restates the identical clock time, and GLOFAS is a global
    model on a UTC cycle. Treating them as local time would shift every flood
    by the deployment host's offset, so the assumption is made explicitly here
    rather than left to fromisoformat's naive default.
    """
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _affected_iso3(props: dict) -> list[str]:
    """Every country GDACS lists for the event, as ISO3 codes.

    The flat `iso3` field names only the first: a flood across Russia and
    Ukraine arrives with `country` = "Russia, Ukraine" and `iso3` = "RUS". Both
    are kept -- the flat one because it is what GDACS calls the event, this one
    because a joinable list of codes is what any country-scoped panel or
    downstream adjacency check actually needs.
    """
    out: list[str] = []
    for entry in props.get("affectedcountries") or []:
        if not isinstance(entry, dict):
            continue
        code = _text(entry.get("iso3"))
        if code and code not in out:
            out.append(code)
    return out


def parse_floods(payload: dict) -> list[dict]:
    """GDACS GeoJSON FeatureCollection -> flood records.

    Read defensively by key throughout. GDACS ships a mixed-case `Class` key
    next to lowercase ones and empty strings where other feeds omit the field,
    which is enough evidence that the schema is not being held stable for us.
    """
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        props = feature.get("properties") or {}

        # Publisher-assigned and stable. No synthesised fallback: an event with
        # no id cannot be updated in place on the next poll, so a made-up one
        # would accumulate a duplicate pin every 30 minutes.
        event_id = props.get("eventid")
        if event_id is None or _text(str(event_id)) is None:
            continue

        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue

        alert_level = _text(props.get("alertlevel"))
        urls = props.get("url") if isinstance(props.get("url"), dict) else {}
        event_type = _text(props.get("eventtype")) or "FL"

        out.append(
            {
                # Event-level, and the hazard type is in the key because GDACS
                # numbers eventids per type -- a tropical cyclone and a flood
                # can share 1104067.
                "id": f"gdacs:{event_type}:{event_id}",
                "kind": "flood",
                "lat": lat,
                "lon": lon,
                # The event's own onset, the analogue of a quake's origin time.
                # `updated` below is the separate freshness question: when
                # GDACS last revised what it says about this event.
                "time": _iso_to_unix(props.get("fromdate")),
                "from_time": _iso_to_unix(props.get("fromdate")),
                "to_time": _iso_to_unix(props.get("todate")),
                "updated": _iso_to_unix(props.get("datemodified")),
                # `eventname` is GDACS's human name for notable events and is
                # usually blank; `name` is the always-present generated line
                # ("Flood in Thailand"). Neither is guaranteed, hence the last
                # resort.
                "name": _text(props.get("eventname"))
                or _text(props.get("name"))
                or f"Flood {event_id}",
                "description": _text(props.get("description")),
                "country": _text(props.get("country")),
                "iso3": _text(props.get("iso3")),
                "affected_iso3": _affected_iso3(props),
                # The GLIDE number, the cross-agency disaster identifier that
                # lets this event be matched against ReliefWeb and HDX records
                # for the same flood. Usually absent; present on the ones that
                # drew an international response.
                "glide": _text(props.get("glide")),
                "event_id": str(event_id),
                "episode": props.get("episodeid"),
                "alert_level": alert_level,
                # GDACS's own finer number, carried rather than mapped. The
                # episode pair is the same judgement scoped to the latest
                # revision only, which can sit well below the event's overall
                # level -- worth showing, not worth colouring by.
                "alert_score": props.get("alertscore"),
                "episode_alert_level": _text(props.get("episodealertlevel")),
                "episode_alert_score": props.get("episodealertscore"),
                # GDACS's word for whether the event is still open. Kept
                # verbatim because it is the publisher's judgement, not ours,
                # and it is the field any "only what is happening now" filter
                # should read.
                "is_current": str(props.get("iscurrent")).strip().lower() == "true",
                "is_temporary": str(props.get("istemporary")).strip().lower() == "true",
                # Which model raised the alert (GLOFAS for every flood so far).
                # Named because a modelled alert and an observed one are
                # different evidence and the popup should be able to say which.
                "model_source": _text(props.get("source")),
                "url": _text(urls.get("report")),
                # The affected-area polygon. A link, not a fetch: one request
                # per event would be ~100 extra requests per poll for geometry
                # nothing on the map draws yet.
                "footprint_url": _text(urls.get("geometry")),
                "severity": _severity_for_alert(alert_level),
                "severity_basis": "gdacs_alertlevel",
                # Never "locality". See the module docstring: GDACS calls this
                # point a centroid itself.
                "geo_precision": "region",
                "polygon_label": _text(props.get("polygonlabel")),
                "publisher": "GDACS (European Commission JRC / UN)",
            }
        )
        # `severitydata` is deliberately not carried. It is GDACS's flood
        # magnitude, it was 0.0 on every event in the sample, and a second
        # field called "severity" sitting next to the 0-100 one this map runs
        # on would be read as contradicting it.

    # Open events first, then by severity, then by how recently GDACS touched
    # them. The first key is what makes a truncated read useful: most of the
    # list is closed at any moment, so severity alone would put a Red that
    # ended in July above every flood happening today.
    out.sort(
        key=lambda r: (r["is_current"], r.get("severity") or 0, r.get("updated") or 0.0),
        reverse=True,
    )
    return out


async def _fetch(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(GDACS_URL)
    resp.raise_for_status()
    return parse_floods(resp.json())


async def start():
    state = registry.register("floods", key_configured=True)  # no key required
    # A 30-minute clock means a failed boot fetch would otherwise leave the
    # layer empty for half an hour after every restart.
    await storage.warm_points(state, "floods", "Floods")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
                floods = await _fetch(client)
            state.data = floods
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info(
                "Floods: %d GDACS events (%d current, %d orange or red)",
                len(floods),
                sum(1 for r in floods if r["is_current"]),
                sum(1 for r in floods if (r.get("severity") or 0) >= _ALERT_SEVERITY["orange"]),
            )
            await storage.record_snapshot("floods", floods, id_field="id")
            await storage.record_source_health("floods", len(floods), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("GDACS flood fetch failed: %s", exc)
            await storage.record_source_health("floods", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
