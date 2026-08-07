"""EASA Conflict Zone Information Bulletins: airspace a regulator says to avoid.

A CZIB is the European Union Aviation Safety Agency formally telling operators
not to fly through a named airspace, with a bulletin number, an issue date and
an expiry date. That is the best-attributed evidence anywhere in this app: a
named EU regulator, a document reference a reader can look up, and a stated
review date. Nothing in normalisation is allowed to drop any of it, which is
why every record below carries `reference`, `issued`, `valid_until`, `updated`,
`status` and `url` rather than a rendered summary of them.

Two requests per poll, and the second one is worth arguing for. The JSON export
carries the substance but no link and no bulletin number; the RSS companion
carries both, in its `<link>` slug -- `czib-2018-02r21` is CZIB-2018-02 revision
21. Its `<guid>` starts with the same `Nid` the JSON is keyed on, so the join is
the publisher's own identifier rather than a title match. One extra GET every
twelve hours buys the one field that makes a pin checkable against the source
document, so it is worth it -- but it is fetched inside its own try: if the feed
is down the bulletins still publish, unreferenced, the same way hazards.py lets
the earthquake half publish when the volcano half fails.

--- the coordinate field is wrong, and is never read -----------------------

Every record has a `coordinates` string and it must be ignored. It is the CMS
geocoding the *country name*, not the airspace:

  Afghanistan  -> 34.5260131, 69.1776476   which is Kabul.
  Pakistan     -> 25.1446897, 67.1847767   which is Karachi -- while the
                  bulletin covers Baluchistan and Khyber Pakhtunkhwa, and
                  Karachi is in neither province.

Fourteen of the thirty-three records carry one, and drawing it would claim
city-level precision for a document about a national FIR. So placement here
goes through gazetteer.py instead and is labelled `geo_precision: "country"`,
with `geo_radius_km` from the country's own geometry. A reader is told the pin
is a country, not a place. **Do not restore the field.**

--- what a bulletin is, and how many pins it becomes -----------------------

`country` is a comma-joined list, and it does the whole range: one country, or
eleven ("Bahrain, Iran, Iraq, Israel, Jordan, Kuwait, Lebanon, Oman, Qatar,
United Arab Emirates, Saudi Arabia"), or the empty string. So a bulletin fans
out to several country-level records, or to none. Neither is silent: the
zero-country case is logged per bulletin with its Nid and title, and the count
appears on every poll line.

Placement reads the `country` field only. It deliberately does not scrape the
title, even though "Airspace of Kenya" would parse perfectly -- because "Iran
and neighbouring airspace" would not, and a rule that is right two times in
three is worse than no rule when its output is a pin.

--- withdrawn bulletins ----------------------------------------------------

Eighteen of the thirty-three are Withdrawn, some since 2021. They are carried,
not discarded, because a withdrawn CZIB is a real fact -- this airspace was
restricted, by this regulator, between these dates -- and this map's rule is to
thin the presentation rather than delete the data.

But a withdrawn bulletin is emphatically not a current warning, and it must be
impossible to render as one by accident. So it is distinguished three separate
ways, any one of which is enough to filter on:

  kind      "czib_withdrawn" rather than "czib". A consumer that only knows
            about "czib" -- the ordinary case for a layer that renders one kind
            -- shows the active set and nothing else, with no code change.
  active    False.
  severity  0. It contributes nothing to how dangerous anywhere is today.

The rendering contract is therefore: draw `kind == "czib"`; offer the withdrawn
set behind a filter if there is a use for it.

--- cadence ----------------------------------------------------------------

Twelve hours. Bulletins are issued and revised over months -- the `updated`
timestamps in the live set cluster monthly and the oldest active bulletin has
stood since 2017 -- so nothing here changes between two polls of any interval
in the permitted range. What decides it is the other direction: a *new* CZIB
means a regulator has just told airlines to stop flying somewhere, which is
news, and half a day is the most staleness that is defensible for that. Six
hours would double the load on a public regulator's CMS to learn nothing;
twenty-four could sit on a new bulletin for a full day.
"""

import asyncio
import html
import logging
import math
import re
import time
from datetime import datetime, timezone
from xml.etree import ElementTree

import httpx

from backend import storage
from backend.cache import registry
from backend.sources import gazetteer

log = logging.getLogger("osint-globe.czib")

JSON_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs/export-json?page&_format=json"
# The same thirty-three bulletins, with the canonical document URL the JSON
# omits. See the module docstring for why the second request earns its place.
FEED_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs/feed.xml"
# Where a reader lands when the RSS join found no link for a bulletin.
INDEX_URL = "https://www.easa.europa.eu/en/domains/air-operations/czibs"

REFRESH_INTERVAL = 12 * 3600  # see "cadence" above
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# Not required -- the export answers a bare httpx client with 200 -- but naming
# the caller is the polite thing to do on a public regulator's site.
USER_AGENT = "osint-live-globe/1.0 (+https://github.com/)"

PUBLISHER = "EASA"

# What an active bulletin scores on the map's shared 0-100 scale (see
# frontend/src/map/severity.js). "High", not "Critical": critical is for things
# happening now, and a standing airspace advisory is a persistent condition
# rather than an incident. Every active bulletin gets the same number because
# EASA grades none of them -- Active vs Withdrawn is the only severity signal
# this feed carries, and inventing a finer one from issue dates or expiry
# windows would be an opinion the regulator has not published.
ACTIVE_SEVERITY = 70

# `updated` arrives as an HTML fragment:
#     <time datetime="2026-07-24T14:07:23+03:00">2026-07-24T14:07:23+0300</time>
# The machine-readable value is the attribute. The element's *text* is a second,
# differently-formatted rendering of the same instant, and reading that instead
# means parsing whatever the CMS's display template happens to emit today.
_TIME_ATTR_RE = re.compile(r'datetime="([^"]+)"')

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

# EASA's country vocabulary -> ISO 3166-1 alpha-2, keyed by gazetteer.normalize
# so case, punctuation and the `&#039;` in "Democratic People&#039;s Republic of
# Korea" all fold away before the lookup.
#
# Measured against the live feed rather than guessed: these are the twenty-five
# countries the thirty-three bulletins actually name, plus the formal/short
# alternates for those same countries, because the field and the bulletin title
# already disagree about Russia ("Russia" / "the Russian Federation") and the
# CMS is free to change its mind. Kenya and Venezuela are here because both have
# a bulletin whose `country` field is empty and whose title names them -- a
# revision that fills the field must not then fail to place.
#
# A name absent from here falls through to the countries layer below, and a name
# neither knows is logged, not swallowed.
_ISO2_BY_NAME = {
    gazetteer.normalize(name): iso2
    for name, iso2 in {
        "Afghanistan": "AF",
        "Bahrain": "BH",
        "Democratic People's Republic of Korea": "KP",
        "North Korea": "KP",
        "Egypt": "EG",
        "Ethiopia": "ET",
        "Iran": "IR",
        "Islamic Republic of Iran": "IR",
        "Iraq": "IQ",
        "Israel": "IL",
        "Jordan": "JO",
        "Kenya": "KE",
        "Kuwait": "KW",
        "Lebanon": "LB",
        "Libya": "LY",
        "Mali": "ML",
        "Oman": "OM",
        "Pakistan": "PK",
        "Qatar": "QA",
        "Russia": "RU",
        "Russian Federation": "RU",
        "Saudi Arabia": "SA",
        "Somalia": "SO",
        "South Sudan": "SS",
        "Sudan": "SD",
        "Syria": "SY",
        "Syrian Arab Republic": "SY",
        "Ukraine": "UA",
        "United Arab Emirates": "AE",
        "Venezuela": "VE",
        "Yemen": "YE",
    }.items()
}


# --- text and dates ---------------------------------------------------------


def _clean(raw: str | None) -> str | None:
    """An HTML blob -> one clean line, or None.

    `field_easa_valid_until_descr` is a `<p>` element full of `&nbsp;`, which
    html.unescape turns into U+00A0 -- a character `\\s` matches for str
    patterns, so the collapse below removes it rather than leaving an invisible
    hard space in the middle of the popup text.
    """
    if not raw:
        return None
    return _WS_RE.sub(" ", html.unescape(_TAG_RE.sub(" ", html.unescape(raw)))).strip() or None


def _text(raw: str | None) -> str:
    """A plain field's value, entity-decoded and trimmed.

    Both halves are load-bearing: the live feed carries
    "Democratic People&#039;s Republic of Korea " -- an HTML entity *and* a
    trailing space -- in a field that is not otherwise markup.
    """
    return html.unescape(raw or "").strip()


def _parse_issued(value: str | None) -> float | None:
    """`issued_date` -> unix seconds. ISO 8601 with a `+0200`/`+0300` offset."""
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw).timestamp()
    except ValueError:
        return None


def _parse_valid_until(value: str | None) -> float | None:
    """`valid_until_date` -> unix seconds. `dd/mm/yyyy`, and often empty.

    A *different* format from `issued_date` in the same record, which is the
    reason these are two functions: one permissive parser tried against both
    would read "01/02/2027" as either January or February depending on which
    branch it reached first, and be wrong silently for eleven months of the
    year. Taken as midnight UTC on the stated day -- the day itself is what
    EASA publishes, and the raw string is carried alongside so nothing depends
    on this interpretation.
    """
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%d/%m/%Y").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def _parse_updated(value: str | None) -> float | None:
    """The `<time datetime="...">` attribute out of the `updated` fragment."""
    match = _TIME_ATTR_RE.search(value or "")
    if not match:
        return None
    try:
        return datetime.fromisoformat(html.unescape(match.group(1))).timestamp()
    except ValueError:
        return None


# --- country -> a point, at country precision -------------------------------
#
# Nothing in this module invents a coordinate. A bulletin names countries; a
# country is a region, not a point; so what is drawn is the region's
# population-weighted centre, labelled as the country-level claim it is and
# ringed with the country's own radius.
#
# Population-weighted rather than geometric, for the reason gazetteer.py already
# gives one level down when it locates an oblast from its towns: "somewhere in
# this country" is far more likely to mean a populated part of it than an empty
# one. This is the same computation applied to the country.


# (the Gazetteer the cache was built from, ISO2 -> (lat, lon)). Compared by
# identity, because gazetteer.install() swaps the whole index in one rebind --
# so a new object is exactly the event that invalidates this.
_centroids: tuple[object, dict[str, tuple[float, float]]] | None = None


def country_centroids() -> dict[str, tuple[float, float]]:
    """ISO2 -> the population-weighted centre of that country's places.

    Empty until the gazetteer's first load, which the caller has to treat as
    "cannot place anything yet" rather than "this country does not exist".
    """
    global _centroids
    index = gazetteer.current()
    if _centroids is not None and _centroids[0] is index:
        return _centroids[1]

    # lat is a plain weighted mean; longitude is a weighted *circular* mean, so
    # a country spanning the antimeridian (Russia does) cannot average its two
    # ends into the middle of the Pacific.
    acc: dict[str, list[float]] = {}
    for place in index.places:
        # Populated places only. The index also holds ADM1/ADM2 divisions whose
        # population is the sum of their members', so counting those would weigh
        # every town two or three extra times and pull the centre towards
        # whichever part of the country is most finely subdivided.
        if place.feature_class != "P":
            continue
        code = place.country_code
        if not code:
            continue
        weight = float(max(place.population, 1))
        radians = math.radians(place.lon)
        bucket = acc.setdefault(code, [0.0, 0.0, 0.0, 0.0])
        bucket[0] += place.lat * weight
        bucket[1] += math.cos(radians) * weight
        bucket[2] += math.sin(radians) * weight
        bucket[3] += weight

    out: dict[str, tuple[float, float]] = {}
    for code, (lat_sum, x, y, total) in acc.items():
        if total <= 0 or (x == 0.0 and y == 0.0):
            continue
        out[code] = (lat_sum / total, math.degrees(math.atan2(y, x)))
    _centroids = (index, out)
    return out


# (countries state version, normalized name -> ISO2). Same lazy cross-source
# read capitals.py does off `cities`, and for the same reason: countries.py
# already downloads Natural Earth every 24 hours and a second copy would be a
# second failure mode for one table.
_ne_names: tuple[int, dict[str, str]] | None = None


def _natural_earth_names() -> dict[str, str]:
    """Country name -> ISO2, from the boundaries layer, or {} before it loads."""
    global _ne_names
    if not registry.has("countries"):
        return {}
    state = registry.get("countries")
    if _ne_names is not None and _ne_names[0] == state.version:
        return _ne_names[1]
    out: dict[str, str] = {}
    payload = state.data if isinstance(state.data, dict) else {}
    for feature in payload.get("features") or ():
        props = (feature or {}).get("properties") or {}
        code = str(props.get("iso_a2") or "").strip().upper()
        key = gazetteer.normalize(str(props.get("name") or ""))
        # Natural Earth writes "-99" where it has no code; a two-letter alpha
        # string is the only thing that can be one.
        if key and len(code) == 2 and code.isalpha():
            out.setdefault(key, code)
    _ne_names = (state.version, out)
    return out


def iso2_for(name: str) -> str | None:
    """A country name as EASA writes it -> ISO 3166-1 alpha-2, or None."""
    key = gazetteer.normalize(name)
    if not key:
        return None
    return _ISO2_BY_NAME.get(key) or _natural_earth_names().get(key)


# --- parsing ----------------------------------------------------------------


def parse_bulletins(payload: dict) -> list[dict]:
    """The JSON export -> one dict per bulletin, unplaced.

    Read by key, defensively: this is a CMS export and every field below has
    been observed empty in the live set. Split from the placement step so the
    document parse can be tested on its own, and so `coordinates` has exactly
    one place it is conspicuously not read (see the module docstring).
    """
    out: list[dict] = []
    for row in (payload or {}).get("conflict_zones") or []:
        nid = _text(row.get("Nid"))
        if not nid:
            # The publisher's own node id is the only stable key this feed has,
            # and synthesising one would mint a fresh pin on every poll.
            log.warning("CZIB record with no Nid, skipped: %r", _text(row.get("name")))
            continue
        raw_countries = _text(row.get("country"))
        countries = [part.strip() for part in raw_countries.split(",") if part.strip()]
        out.append(
            {
                "nid": nid,
                "name": _text(row.get("name")),
                "status": _text(row.get("status")),
                "countries": countries,
                "issued": _parse_issued(row.get("issued_date")),
                "valid_until": _parse_valid_until(row.get("valid_until_date")),
                "valid_until_text": _text(row.get("valid_until_date")) or None,
                "valid_until_note": _clean(row.get("field_easa_valid_until_descr")),
                "updated": _parse_updated(row.get("updated")),
            }
        )
    return out


def parse_feed(body: bytes | str) -> dict[str, dict]:
    """The RSS companion -> {Nid: {"url", "reference"}}.

    The join key is the `<guid>`, which reads "143944 on Wed, 22 Jul 2026
    00:00:00 +0300" -- the JSON's Nid, then the publication date. Taking the
    leading token joins on the publisher's identifier; matching on `<title>`
    would join on prose, and five bulletins in the live set share the title
    "Airspace of Iran".

    `reference` is the URL's last path segment, upper-cased: "czib-2018-02r21"
    is how EASA spells CZIB-2018-02R21, and it is the number a reader quotes.
    It is carried verbatim rather than reformatted -- two of the thirty-three
    are not CZIBs at all ("sib-2014-21r1" is a Safety Information Bulletin) and
    a tidying rule would relabel them.
    """
    root = ElementTree.fromstring(body if isinstance(body, str) else body.decode("utf-8", "replace"))
    out: dict[str, dict] = {}
    for item in root.iter():
        if item.tag.split("}")[-1] != "item":
            continue
        guid = (item.findtext("guid") or "").strip()
        nid = guid.split(" ", 1)[0].strip()
        link = (item.findtext("link") or "").strip()
        if not nid or not link:
            continue
        slug = link.rstrip("/").rsplit("/", 1)[-1]
        out[nid] = {"url": link, "reference": slug.upper() or None}
    return out


def to_records(bulletins: list[dict], links: dict[str, dict] | None = None) -> tuple[list[dict], list[dict]]:
    """Bulletins -> country-level point records, plus what could not be placed.

    One record per (bulletin, country): an eleven-country bulletin is eleven
    pins that each carry the same reference, the same dates and the full country
    list, so a reader clicking any one of them sees it is one of eleven rather
    than a claim about that country alone.

    The second return value is every bulletin-country pair that produced no
    record and why. It is returned rather than logged here so the caller can
    report a count on every poll -- a bulletin that quietly stops being placed
    is the failure this feed is most likely to have, and it would otherwise look
    exactly like EASA having withdrawn it.
    """
    links = links or {}
    centroids = country_centroids()
    records: list[dict] = []
    unplaced: list[dict] = []

    for bulletin in bulletins:
        nid = bulletin["nid"]
        link = links.get(nid) or {}
        countries = bulletin["countries"]
        if not countries:
            unplaced.append({"nid": nid, "name": bulletin["name"], "country": None, "reason": "no country named"})
            continue
        active = bulletin["status"].lower() == "active"
        for country in countries:
            iso2 = iso2_for(country)
            if not iso2:
                unplaced.append({"nid": nid, "name": bulletin["name"], "country": country, "reason": "unknown country name"})
                continue
            point = centroids.get(iso2)
            if point is None:
                unplaced.append({"nid": nid, "name": bulletin["name"], "country": country, "reason": f"no gazetteer places for {iso2}"})
                continue
            records.append(
                {
                    "id": f"czib:{nid}:{iso2}",
                    # Two kinds, one layer. A withdrawn bulletin is history, not
                    # a warning, and must not be renderable as one by default.
                    "kind": "czib" if active else "czib_withdrawn",
                    "lat": point[0],
                    "lon": point[1],
                    "name": bulletin["name"],
                    "country": country,
                    "country_code": iso2,
                    # The whole list on every pin, so an eleven-country bulletin
                    # reads as one document rather than eleven findings.
                    "bulletin_countries": countries,
                    "country_count": len(countries),
                    "status": bulletin["status"],
                    "active": active,
                    "bulletin_id": nid,
                    "reference": link.get("reference"),
                    "url": link.get("url") or INDEX_URL,
                    "issued": bulletin["issued"],
                    "valid_until": bulletin["valid_until"],
                    "valid_until_text": bulletin["valid_until_text"],
                    "valid_until_note": bulletin["valid_until_note"],
                    "updated": bulletin["updated"],
                    # The observation time is the last thing the publisher did
                    # to this document, falling back to when it was issued.
                    "time": bulletin["updated"] or bulletin["issued"],
                    "severity": ACTIVE_SEVERITY if active else 0,
                    "severity_basis": "czib_status",
                    # Placed by this module, not by EASA. The bulletin is about a
                    # national airspace and the pin says exactly that much.
                    "geo_precision": "country",
                    "geo_radius_km": gazetteer.country_radius_km(iso2),
                    "publisher": PUBLISHER,
                }
            )

    # Active first, then newest, so a truncating consumer keeps the warnings.
    records.sort(key=lambda r: (not r["active"], -(r.get("time") or 0)))
    return records, unplaced


# --- polling ----------------------------------------------------------------


async def _fetch() -> tuple[list[dict], list[dict]]:
    async with httpx.AsyncClient(
        timeout=30, follow_redirects=True, headers={"User-Agent": USER_AGENT}
    ) as client:
        resp = await client.get(JSON_URL)
        resp.raise_for_status()
        bulletins = parse_bulletins(resp.json())
        try:
            feed = await client.get(FEED_URL)
            feed.raise_for_status()
            links = parse_feed(feed.content)
        except Exception as exc:  # noqa: BLE001 - the bulletins still publish
            log.warning("CZIB feed fetch failed (%s); bulletins publish with no reference or URL", exc)
            links = {}
    return to_records(bulletins, links)


async def start():
    state = registry.register("czib", key_configured=True)  # no key required
    # Twelve hours between polls, and a failure backs off towards that -- so a
    # bad boot fetch would otherwise leave the layer blank for half a day over
    # data that changes a few times a year.
    await storage.warm_points(state, "czib", "EASA conflict zones")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            records, unplaced = await _fetch()
            if not records and unplaced:
                # The fetch worked and placement produced nothing from it --
                # normally a cold gazetteer at boot, but a wholesale rename of
                # EASA's country vocabulary would look the same. Either way it
                # is a failure and is recorded as one: it retries in minutes and
                # /api/health says why, where publishing an empty layer would go
                # green and then sit on it for a full twelve-hour interval.
                raise RuntimeError(
                    f"no bulletin could be placed ({len(unplaced)} unplaced; "
                    f"first: {unplaced[0]['reason']})"
                )
            state.data = records
            state.last_success = time.time()
            state.last_error = None
            ok = True
            active = sum(1 for r in records if r["active"])
            log.info(
                "EASA CZIB: %d records (%d active, %d withdrawn), %d unplaced",
                len(records), active, len(records) - active, len(unplaced),
            )
            for item in unplaced:
                # One line each, not a count: a bulletin nothing draws is
                # invisible on the map by definition, so the log is the only
                # place it can be noticed. "unknown country name" here means one
                # line in _ISO2_BY_NAME is missing.
                log.warning(
                    "CZIB %s (%s) not placed: %s%s",
                    item["nid"], item["name"], item["reason"],
                    f" [{item['country']}]" if item["country"] else "",
                )
            await storage.record_snapshot("czib", records, id_field="id")
            await storage.record_source_health("czib", len(records), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("CZIB fetch failed: %s", exc)
            await storage.record_source_health("czib", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
