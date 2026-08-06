"""Natural hazards: earthquakes and volcanic activity.

Two publishers, one layer, because a reader asking "did the ground move here"
does not care which agency answered. They are kept distinguishable all the way
to the popup by `kind`, and each record names its own publisher, for the same
reason officials.py keeps its two inputs apart: the evidence is different.

- **USGS** serves a GeoJSON summary feed refreshed every few minutes. It is the
  authoritative catalogue for global seismicity and needs no key.
- **Smithsonian GVP / USGS** publish a *weekly* volcanic activity report as RSS.
  Weekly is the real cadence of the underlying product, not a polling choice,
  and every record says so -- a volcano pin is a report about a week, not a
  live sensor reading.

Both feeds carry their own coordinates, so unlike the conflict pipeline there is
no geocoding step and nothing to be uncertain about. The one exception is a GVP
item published without a `<georss:point>`, which is handled explicitly below
rather than silently placed.
"""

import asyncio
import html
import logging
import re
import time
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import httpx

from backend import storage
from backend.cache import registry
from backend.sources import gazetteer

log = logging.getLogger("osint-globe.hazards")

# M2.5+ over the past day. The wider feeds (all_day, 1.0_day) are dominated by
# instrument-only microseismicity that nobody can feel and no map can usefully
# show; the narrower ones (4.5_day) miss the moderate quakes that matter in
# densely populated places. 2.5 is USGS's own "generally felt" threshold.
USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
GVP_URL = "https://volcano.si.edu/news/WeeklyVolcanoRSS.xml"

REFRESH_INTERVAL = 300  # USGS's own feed updates every ~5 minutes
GVP_REFRESH_INTERVAL = 6 * 3600  # the report itself is issued once a week
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# GeoRSS is the only namespace either feed needs from us.
_GEORSS = "{http://www.georss.org/georss}"

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_XML_DECL_RE = re.compile(r"^\s*<\?xml[^>]*\?>")

# "Etna (Italy) - Report for 23 July-29 July 2026 - New Eruptive Activity"
#
# The field separator is a *spaced* hyphen. That is not incidental: the report
# period itself contains an unspaced one ("23 July-29 July"), so a permissive
# `\s*-\s*` splits the date range in half and hands the headline group the
# second date.
_GVP_TITLE_RE = re.compile(
    r"^(?P<name>.+?)\s*\((?P<country>[^)]+)\)\s+-\s+Report for\s+(?P<period>.+?)\s+-\s+(?P<headline>.+)$"
)
# The stable Global Volcanism Program number, from the guid's fragment:
# "https://volcano.si.edu/reports_weekly.cfm#vn_211060"
_GVP_NUMBER_RE = re.compile(r"#vn_(\d+)")

# USGS PAGER alert -> the severity scale the rest of the map already speaks
# (frontend/src/map/severity.js's SEVERITY_BANDS). PAGER is an *impact*
# estimate -- expected fatalities and economic loss -- which is a better answer
# to "how bad is this" than magnitude alone, so where USGS has published one it
# wins. It is only computed for significant events, hence the magnitude
# fallback below.
_PAGER_SEVERITY = {"red": 95, "orange": 80, "yellow": 60, "green": 35}


def _severity_for_quake(magnitude: float | None, alert: str | None) -> int:
    """0-100 on the map's shared severity scale.

    Two different scales are being reconciled here, so the record keeps both
    `alert` and `magnitude` and says which one it used -- a reader comparing an
    M7.1 drawn amber against an M5.4 drawn red deserves to see why.
    """
    if alert and alert.lower() in _PAGER_SEVERITY:
        return _PAGER_SEVERITY[alert.lower()]
    if magnitude is None:
        return 0
    # M2.5 (the feed's floor, barely felt) through M8+ (catastrophic), spread
    # across the same bands conflict severity uses.
    return max(0, min(100, round((magnitude - 2.5) / 5.5 * 100)))


def parse_earthquakes(payload: dict) -> list[dict]:
    """USGS GeoJSON FeatureCollection -> hazard records.

    Read defensively by key rather than by position: USGS has added properties
    to this feed before and every field below is optional in their own schema.
    """
    out: list[dict] = []
    for feature in (payload or {}).get("features") or []:
        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        # GeoJSON's third ordinate is depth in km for this feed. A quake with
        # no depth is still worth showing; a quake with no position is not.
        depth_km = None
        if len(coords) > 2:
            try:
                depth_km = float(coords[2])
            except (TypeError, ValueError):
                depth_km = None
        props = feature.get("properties") or {}
        magnitude = props.get("mag")
        try:
            magnitude = float(magnitude) if magnitude is not None else None
        except (TypeError, ValueError):
            magnitude = None
        # USGS timestamps are milliseconds since epoch; everything else in this
        # backend is seconds.
        raw_time = props.get("time")
        when = None
        if isinstance(raw_time, (int, float)):
            when = raw_time / 1000.0
        alert = (props.get("alert") or "").strip().lower() or None
        out.append(
            {
                "id": f"usgs:{feature.get('id') or f'{lat},{lon},{raw_time}'}",
                "kind": "earthquake",
                "lat": lat,
                "lon": lon,
                "magnitude": magnitude,
                "depth_km": depth_km,
                "place": props.get("place"),
                "time": when,
                "alert": alert,
                "tsunami": bool(props.get("tsunami")),
                "felt": props.get("felt"),
                "significance": props.get("sig"),
                "url": props.get("url"),
                "severity": _severity_for_quake(magnitude, alert),
                "severity_basis": "pager" if alert else "magnitude",
                "geo_precision": "locality",
                "publisher": "USGS",
            }
        )
    out.sort(key=lambda r: r.get("severity") or 0, reverse=True)
    return out


def _clean(raw: str | None) -> str | None:
    """Feed prose -> one clean line. GVP descriptions are escaped HTML."""
    if not raw:
        return None
    return _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", html.unescape(raw)))).strip() or None


def _georss_point(item: ElementTree.Element) -> tuple[float, float] | None:
    el = item.find(f"{_GEORSS}point")
    if el is None or not (el.text or "").strip():
        return None
    parts = el.text.split()
    if len(parts) < 2:
        return None
    try:
        return float(parts[0]), float(parts[1])
    except ValueError:
        return None


def _decode_gvp(body: bytes) -> str:
    """The GVP feed's bytes, decoded by what it actually is.

    It declares `encoding="ISO-8859-1"` and is in fact Windows-1252: the
    apostrophes and dashes GVP's prose is full of arrive as 0x92/0x96, which
    ISO-8859-1 maps to unprintable C1 control characters. Taking the
    declaration at its word is why every summary read "Etna?s summit craters".
    cp1252 agrees with ISO-8859-1 on every byte that is actually defined in
    both, so this is strictly a superset, not a guess.

    The declaration is then dropped rather than rewritten: ElementTree refuses
    a `str` that still carries an encoding declaration, and the string in hand
    is already decoded.
    """
    text = body.decode("cp1252", "replace")
    return _XML_DECL_RE.sub("", text, count=1).lstrip()


def parse_volcanoes(body: bytes | str) -> list[dict]:
    """The GVP weekly report -> hazard records."""
    root = ElementTree.fromstring(_decode_gvp(body) if isinstance(body, bytes) else body)
    out: list[dict] = []
    for item in root.iter():
        if item.tag.split("}")[-1] != "item":
            continue
        title_el = item.find("title")
        title = _clean(title_el.text if title_el is not None else None)
        if not title:
            continue
        match = _GVP_TITLE_RE.match(title)
        name = match.group("name") if match else title
        country = match.group("country") if match else None
        period = match.group("period") if match else None
        headline = match.group("headline") if match else None

        guid_el = item.find("guid")
        guid = (guid_el.text or "").strip() if guid_el is not None else ""
        number_match = _GVP_NUMBER_RE.search(guid)
        volcano_number = number_match.group(1) if number_match else None

        point = _georss_point(item)
        geo_precision = "locality"
        if point is None:
            # No coordinate published. Rather than dropping the report or
            # inventing a position, try the gazetteer the conflict pipeline
            # already uses and mark the result as the weaker evidence it is.
            # A volcano is a physical feature, and the gazetteer is built from
            # *populated places*, so this is expected to miss more often than
            # it hits -- a miss drops the item, which is the honest outcome.
            candidates = gazetteer.resolve(name, limit=1)
            if not candidates:
                log.debug("GVP item %r has no coordinate and no gazetteer match", title)
                continue
            place = candidates[0].place
            point = (place.lat, place.lon)
            geo_precision = "region"

        pub_el = item.find("pubDate")
        when = None
        if pub_el is not None and (pub_el.text or "").strip():
            try:
                parsed = parsedate_to_datetime(pub_el.text.strip())
                when = parsed.timestamp() if parsed is not None else None
            except (TypeError, ValueError):
                when = None

        desc_el = item.find("description")
        out.append(
            {
                "id": f"gvp:{volcano_number or name}",
                "kind": "volcano",
                "lat": point[0],
                "lon": point[1],
                "name": name,
                "country": country,
                "report_period": period,
                "headline": headline,
                "summary": _clean(desc_el.text if desc_el is not None else None),
                "time": when,
                "volcano_number": volcano_number,
                "url": (guid or "https://volcano.si.edu/reports_weekly.cfm"),
                # "New Eruptive Activity" is GVP's own wording for a change of
                # state; "Ongoing Activity" is a continuing situation. That
                # distinction is the only severity signal the feed carries, and
                # inventing a finer one from the prose would be a claim GVP has
                # not made.
                "severity": 70 if (headline or "").lower().startswith("new") else 45,
                "severity_basis": "gvp_report_type",
                "geo_precision": geo_precision,
                "publisher": "Smithsonian GVP / USGS",
            }
        )
    return out


async def _fetch_earthquakes(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(USGS_URL)
    resp.raise_for_status()
    return parse_earthquakes(resp.json())


async def _fetch_volcanoes(client: httpx.AsyncClient) -> list[dict]:
    resp = await client.get(GVP_URL)
    resp.raise_for_status()
    return parse_volcanoes(resp.content)


async def start():
    state = registry.register("hazards", key_configured=True)  # no key required
    # The quake half refreshes every 5 minutes, so this matters least here --
    # but the volcano half is on a 6-hour clock and a failed boot fetch would
    # otherwise drop the weekly report for that whole window.
    await storage.warm_points(state, "hazards", "Hazards")
    consecutive_failures = 0
    volcanoes: list[dict] = []
    volcanoes_fetched_at = 0.0
    while True:
        ok = False
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                quakes = await _fetch_earthquakes(client)
                # The weekly report is refetched on its own much slower clock:
                # polling it every 5 minutes alongside the quake feed would be
                # ~2000 requests a week for a file that changes once. A failure
                # here is not allowed to discard the copy already in hand.
                if time.time() - volcanoes_fetched_at >= GVP_REFRESH_INTERVAL:
                    try:
                        volcanoes = await _fetch_volcanoes(client)
                        volcanoes_fetched_at = time.time()
                    except Exception as exc:  # noqa: BLE001 - quakes still publish
                        log.warning("GVP weekly report fetch failed: %s", exc)
            state.data = quakes + volcanoes
            state.last_success = time.time()
            state.last_error = None
            ok = True
            log.info("Hazards: %d earthquakes, %d volcano reports", len(quakes), len(volcanoes))
            await storage.record_snapshot("hazards", state.data, id_field="id")
            await storage.record_source_health("hazards", len(state.data), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Hazards fetch failed: %s", exc)
            await storage.record_source_health("hazards", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
