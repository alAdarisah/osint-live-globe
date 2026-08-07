"""Which way the electricity is flowing across Europe's borders.

Fraunhofer ISE's Energy-Charts API republishes ENTSO-E's cross-border exchange,
keyless and under CC BY 4.0, which is why it is here rather than ENTSO-E itself.
Two endpoints, and the difference between them is the whole point of the module:

- **`/v2/cbpf`** -- cross-border *physical flows*. Metered reality: what the
  interconnectors actually carried. It runs several hours behind wall clock,
  because that is ENTSO-E's own publication lag, not a choice this poller makes.
- **`/v2/cbet`** -- scheduled *commercial exchanges*. The day-ahead market's
  intent, published through the end of tomorrow.

They are stored under separate keys and each half names its own endpoint,
resolution and window. **They are never added together and never fall back to
one another**: a scheduled megawatt is a contract and a measured one is a
reading, and a card that quoted the schedule when the meter had not reported yet
would be inventing a measurement. Where they disagree that disagreement is
itself the interesting signal -- an interconnector that was sold and did not
flow is a curtailment, an outage, or a border that went down.

**None of it goes on the map.** A flow is an edge between two countries, not a
point: it has no location, and there is no honest pin for "0.4 GW from Slovakia
into Ukraine". Same rule humanitarian.py's docstring sets out for aggregates.
It is served as a country-keyed dictionary and read by the country card.

Every provenance field the publisher ships -- its licence string, its sign
convention, the resolution, when it generated the response and how far its data
actually reaches -- is carried through into each half of each country's record
rather than asserted here. The card is meant to be able to say "physical flows,
15-minute resolution, current to 19:15 local" and quote energy-charts.info's own
attribution line, on the publisher's authority rather than on ours.
"""

import asyncio
import logging
import time

import httpx

from backend import config, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.energy_flows")

BASE_URL = "https://api.energy-charts.info/v2"

# The CountryV2 enum from the API's own /openapi.json, minus `all` -- which is
# in the enum but answers 404 "no content available" on both endpoints, so there
# is no bulk request to make and this is necessarily one call per country.
#
# `eu` is kept. It is not a duplicate of the rows below and not a sum of them:
# its series are the bloc's *external* interconnectors only (Norway, the UK,
# Switzerland, Turkey, Ukraine, Russia, the Western Balkans), so it answers
# "is Europe importing or exporting right now" -- a question no combination of
# the per-country rows can be trusted to reconstruct, since nothing in the
# payload marks which of a member state's borders are internal to the EU.
COUNTRIES = (
    "eu",
    "at", "ba", "be", "bg", "ch", "cy", "cz", "de", "dk", "ee", "es", "fi",
    "fr", "ge", "gr", "hr", "hu", "ie", "it", "lt", "lu", "lv", "md", "me",
    "mk", "nl", "no", "pl", "pt", "ro", "rs", "se", "si", "sk", "ua", "uk",
    "xk",
)

# The API's codes are ISO 3166-1 alpha-2 with one exception: `uk` is the ccTLD,
# and the country shapes this joins against are keyed on ISO_A2 (see
# backend/sources/countries.py), where the United Kingdom is GB. Getting this
# wrong does not error -- it silently produces a record no country card can
# ever find, which is the failure mode outages.py's ISO2 join exists to avoid.
COUNTRY_CODE_OVERRIDES = {"uk": "GB"}

# Codes that are not countries, and must not be mistaken for one by anything
# iterating the dictionary looking for country cards to fill.
AGGREGATE_CODES = frozenset({"eu"})

# (record key, endpoint, what the numbers are). The third element is the label
# a reader sees, and it is the reason both halves are kept: "measured" and
# "scheduled" are different kinds of claim.
ENDPOINTS = (
    ("physical", "cbpf", "measured"),
    ("commercial", "cbet", "scheduled"),
)

# The counterpart series that is not a counterpart: the API appends a `sum`
# series carrying the country's net position. Surfaced separately as `net`
# rather than left among the neighbours, where anything summing the list would
# double every figure.
NET_SERIES_ID = "sum"

# Seconds between requests when the service has not said otherwise. With the
# rate-limit backoff below, a measured full sweep is 76 requests in ~11 minutes
# -- so a cycle is that plus the poll interval, not the poll interval alone.
# That is the courtesy a free unauthenticated service is owed, and it is cheap
# here because the data underneath only advances every 15 minutes anyway.
REQUEST_SPACING = 3.0

# Attempts per request. The limiter is real, not advisory: at 3s spacing roughly
# one request in four still comes back 429, each carrying a `retry-after` of 1-6
# seconds, and the service drops the occasional connection outright under a
# sustained sweep. Both were observed live, and both are why this exists --
# without a retry a sweep would silently lose a quarter of Europe every hour and
# still call itself healthy, because a missing country is indistinguishable from
# Cyprus, which has no interconnectors and legitimately returns nothing.
REQUEST_ATTEMPTS = 4

FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at the poll interval

# How many of an endpoint's requests may fail outright before *that endpoint* is
# recorded as degraded. Counted per endpoint rather than across the sweep, which
# is the whole point: the two are independent claims about different things (see
# the module docstring), so one of them going down must not discard the other's
# data. Pooled, a single dead endpoint was half of every request the sweep made
# and so always exceeded any threshold below 50% -- which is how a live `cbet`
# answering for 37 countries came to be thrown away because `cbpf` was 500ing.
#
# A few borders going quiet is still normal; a quarter of them is that endpoint
# being down, and calling it healthy would leave most of Europe's cards blank
# under a green light.
MAX_TOLERATED_FAILURES = len(COUNTRIES) // 4

# How many times an endpoint may fail *without a single answer of any kind*
# before the rest of the sweep stops asking it. Observed live on 2026-08-07:
# `/v2/cbpf` returned 500 for every country while `/v2/cbet` served normally, so
# the sweep spent one request per country -- 38 of them -- re-confirming a
# server-side outage, and each one took a slot from a rate limiter that was
# already answering `retry-after: 22`. Five is enough to tell an outage from a
# run of bad luck, and it is the courtesy a free service is owed.
#
# A 404 counts as an answer, not a failure -- Cyprus has no interconnectors and
# says so, which is the endpoint working. Only transport errors and non-404 HTTP
# errors count here.
ENDPOINT_DEAD_AFTER = 5


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def parse_exchange(payload: dict, measurement: str) -> dict | None:
    """One /v2/cbpf or /v2/cbet response -> one compact half of a record.

    Compact deliberately. The upstream window is 15-minute resolution across
    every neighbour, and keeping all of it would be several megabytes of JSON
    served to every browser that opens a country card -- for a chart nobody has
    asked for. What is kept is the newest interval in full (who, how much, which
    direction), the net position across the whole window as a sparkline, and
    per-neighbour statistics over that window: 335 KB for the whole of Europe,
    both endpoints, measured. Nothing is lost by it -- the raw window is one
    keyless request away and stays that way.
    """
    if not isinstance(payload, dict):
        return None
    rows = payload.get("data") or []
    # Read the series metadata by id: the counterpart names and descriptions are
    # the publisher's own wording and are the only country labels in the payload
    # (the *subject* country is never named, only coded), so they are carried
    # through rather than translated.
    meta = {
        (s.get("id") or ""): s
        for s in payload.get("series") or []
        if isinstance(s, dict)
    }

    net_series: list[dict] = []
    values_by_id: dict[str, list[float]] = {}
    latest: dict | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        values = row.get("values") or {}
        if not isinstance(values, dict):
            continue
        timestamp = row.get("timestamp")
        net = _number(values.get(NET_SERIES_ID))
        for key, raw in values.items():
            if key == NET_SERIES_ID:
                continue
            number = _number(raw)
            if number is not None:
                values_by_id.setdefault(key, []).append(number)
        if net is not None:
            net_series.append({"t": timestamp, "net": net})
        # The newest interval that actually carries a figure. A trailing row of
        # nulls is the publisher saying "not yet", and reporting it as the
        # current state would draw every border at zero.
        if any(_number(v) is not None for v in values.values()):
            latest = row

    if latest is None:
        return None

    latest_values = latest.get("values") or {}
    counterparts = []
    for key, raw in latest_values.items():
        if key == NET_SERIES_ID:
            continue
        value = _number(raw)
        window = values_by_id.get(key) or []
        info = meta.get(key) or {}
        counterparts.append({
            "id": key,
            "name": info.get("name") or key,
            "description": info.get("description"),
            "value": value,
            # Over the window the response actually covered, so a border that
            # reversed during the day is visible as such rather than reduced to
            # whichever direction it happened to be pointing at the last tick.
            "mean": round(sum(window) / len(window), 4) if window else None,
            "min": min(window) if window else None,
            "max": max(window) if window else None,
        })
    # Biggest interconnector first, in either direction -- an export of 3 GW is
    # as much the headline as an import of 3 GW.
    counterparts.sort(key=lambda c: abs(c["value"] or 0.0), reverse=True)

    attributes = payload.get("attributes") or {}
    return {
        # Provenance, all of it straight off the response. Nothing below is a
        # constant in this module: the resolution, the window and the licence
        # are the publisher's claims about its own data and the card quotes them
        # as such.
        "endpoint": payload.get("endpoint"),
        "measurement": measurement,
        "unit": payload.get("unit"),
        "resolution": payload.get("resolution"),
        "interval_minutes": payload.get("interval_minutes"),
        "timezone": payload.get("timezone"),
        "bidding_zone": payload.get("bidding_zone"),
        "sign_convention": attributes.get("sign_convention"),
        "license": payload.get("license"),
        "generated_at": payload.get("generated_at"),
        "available_from": payload.get("available_from"),
        "available_until": payload.get("available_until"),
        "latest_timestamp": latest.get("timestamp"),
        "net": _number(latest_values.get(NET_SERIES_ID)),
        "counterparts": counterparts,
        "net_series": net_series,
        "intervals": len(rows),
    }


def merge(halves: dict[str, dict[str, dict]]) -> dict[str, dict]:
    """{api_code: {"physical": ..., "commercial": ...}} -> {ISO2: record}.

    Keyed on the two-letter code the country shapes use, for the same reason
    outages.py is: it is the only join that does not silently drop the countries
    whose names two publishers spell differently.
    """
    merged: dict[str, dict] = {}
    for api_code, parts in halves.items():
        present = {name: half for name, half in parts.items() if half}
        if not present:
            continue
        code = COUNTRY_CODE_OVERRIDES.get(api_code, api_code.upper())
        record = {
            "country_code": code,
            "api_code": api_code,
            # Not a country. Anything walking this dictionary to fill country
            # cards should skip it rather than look for a shape named EU.
            "aggregate": api_code in AGGREGATE_CODES,
        }
        record.update(present)
        merged[code] = record
    return merged


def _retry_after(resp: httpx.Response) -> float:
    """How long the service just asked to be left alone for, at least."""
    try:
        return max(REQUEST_SPACING, float(resp.headers.get("retry-after") or 0))
    except (TypeError, ValueError):
        return REQUEST_SPACING


async def _get(client: httpx.AsyncClient, endpoint: str, country: str) -> tuple[dict | None, float]:
    """One request. Returns (payload or None for "no data", how long to wait).

    A 404 is not an error here. Cyprus has no interconnectors at all and answers
    404 "no content available" on both endpoints; so does any country whose data
    has not been published for the day yet. Treating that as a failure would
    keep this source permanently amber over a condition that is simply true.

    A 429 is not an error either, until it has been obeyed and repeated: the
    response says how many seconds to hold, so the only honest reading of it is
    to wait that long and ask again rather than to record a gap. A dropped
    connection gets the same treatment for the same reason.
    """
    wait = REQUEST_SPACING
    for attempt in range(REQUEST_ATTEMPTS):
        last = attempt == REQUEST_ATTEMPTS - 1
        try:
            resp = await client.get(f"{BASE_URL}/{endpoint}", params={"country": country})
        except httpx.TransportError:
            if last:
                raise
            await asyncio.sleep(wait)
            continue
        wait = _retry_after(resp)
        if resp.status_code == 429 and not last:
            await asyncio.sleep(wait)
            continue
        if resp.status_code == 404:
            return None, wait
        # Including a 429 on the last attempt: at that point it is a real
        # failure and belongs in the sweep's failure list with its status.
        resp.raise_for_status()
        return resp.json(), wait
    return None, wait  # unreachable; the loop always returns or raises


async def _sweep() -> tuple[dict[str, dict], dict[str, list[str]], set[str]]:
    """Both endpoints for every country, paced.

    Returns (records, failures per endpoint, endpoints abandoned mid-sweep).

    Sequential on purpose. This is 76 requests against a free service with a
    live rate limiter, and there is nothing to gain from finishing a once-an-hour
    sweep faster. Measured end to end at ~11 minutes, all 76 succeeding.

    One country failing must not cost the other 37, so each request is caught
    where it happens -- same shape as hazards.py, where the weekly volcano
    report failing does not discard the earthquakes already in hand. One
    *endpoint* failing must not cost the other either, which is why the failures
    come back keyed by endpoint rather than in one list: the caller decides which
    halves are still publishable, and it cannot do that from a total.
    """
    halves: dict[str, dict[str, dict]] = {}
    failures: dict[str, list[str]] = {endpoint: [] for _n, endpoint, _m in ENDPOINTS}
    # An answer of any kind, 404 included. Only an endpoint that has never given
    # one is a candidate for being abandoned.
    answered: dict[str, int] = {endpoint: 0 for _n, endpoint, _m in ENDPOINTS}
    abandoned: set[str] = set()
    async with httpx.AsyncClient(
        timeout=45, follow_redirects=True, headers={"User-Agent": "osint-live-globe/1.0"}
    ) as client:
        wait = 0.0  # nothing to be polite about before the first request
        for country in COUNTRIES:
            for name, endpoint, measurement in ENDPOINTS:
                if endpoint in abandoned:
                    continue
                await asyncio.sleep(wait)
                # The floor, in case the request below fails before it can read
                # the publisher's own advice off the response.
                wait = REQUEST_SPACING
                try:
                    payload, wait = await _get(client, endpoint, country)
                except Exception as exc:  # noqa: BLE001 - one border is not the sweep
                    # `exc or type(exc).__name__` because httpx's transport
                    # errors routinely stringify to nothing at all, and
                    # "cbet/ua: " in the health record explains nothing.
                    failures[endpoint].append(f"{endpoint}/{country}: {exc or type(exc).__name__}")
                    log.debug("Energy flows: %s/%s failed: %s", endpoint, country, exc)
                    if not answered[endpoint] and len(failures[endpoint]) >= ENDPOINT_DEAD_AFTER:
                        abandoned.add(endpoint)
                        log.warning(
                            "Energy flows: %s failed %d times without answering once "
                            "-- skipping it for the rest of this sweep (%s)",
                            endpoint, len(failures[endpoint]), failures[endpoint][-1],
                        )
                    continue
                answered[endpoint] += 1
                if payload is None:
                    continue
                parsed = parse_exchange(payload, measurement)
                if parsed:
                    halves.setdefault(country, {})[name] = parsed
    return merge(halves), failures, abandoned


def sweep_verdict(
    failures: dict[str, list[str]], abandoned: set[str]
) -> tuple[list[str], list[str], str | None]:
    """A sweep's failures -> (endpoints still trusted, endpoints given up on, what to say).

    Split out from the poll loop because it is the judgement the whole module
    turns on and it is worth being able to test without a sweep: which halves
    are publishable, and -- if any half is missing -- the sentence /api/health
    shows in its place. A blank card with no explanation is the failure mode
    this exists to prevent.
    """
    degraded = [
        endpoint for _n, endpoint, _m in ENDPOINTS
        if endpoint in abandoned or len(failures.get(endpoint) or []) > MAX_TOLERATED_FAILURES
    ]
    live = [endpoint for _n, endpoint, _m in ENDPOINTS if endpoint not in degraded]

    notes = []
    for endpoint in degraded:
        items = failures.get(endpoint) or []
        first = f" (first: {items[0]})" if items else ""
        if endpoint in abandoned:
            notes.append(
                f"{endpoint} answered nothing in {len(items)} attempts and was "
                f"skipped for the rest of the sweep{first}"
            )
        else:
            notes.append(
                f"{endpoint} failed for {len(items)} of {len(COUNTRIES)} countries{first}"
            )
    if notes and live:
        notes.append(f"serving {', '.join(live)} only")
    if not notes:
        # No endpoint is degraded, but individual borders can still have failed,
        # and the card for each of those will be blank -- so it still owes an
        # explanation, just not an alarming one.
        stragglers = [item for items in failures.values() for item in items]
        if stragglers:
            total = len(COUNTRIES) * len(ENDPOINTS)
            return live, degraded, (
                f"{len(stragglers)} of {total} requests failed: "
                f"{'; '.join(stragglers[:3])}"
            )
        return live, degraded, None
    return live, degraded, "; ".join(notes)


async def start():
    state = registry.register("energy_flows", key_configured=True)  # no key required
    # A dict keyed by country, not a list of points -- same shape as outages.py
    # and read the same way, by the country card rather than by the renderer.
    state.data = {}
    await storage.warm_reference(state, "energy_flows", "Energy flows")
    consecutive_failures = 0
    while True:
        ok = False
        try:
            merged, failures, abandoned = await _sweep()
            live, degraded, note = sweep_verdict(failures, abandoned)
            total_failures = sum(len(items) for items in failures.values())
            # Only a sweep with nothing publishable is a failed sweep. One dead
            # endpoint is a degraded one, and its surviving half is worth
            # storing -- labelled as the half it is, which merge() already does.
            if not merged or not live:
                raise RuntimeError(
                    f"energy-charts sweep produced {len(merged)} countries with "
                    f"{total_failures} request failures"
                    + (f" -- {note}" if note else "")
                )
            state.data = merged
            state.last_success = time.time()
            # A partial sweep is a success that still owes an explanation: the
            # card for the missing country (or the missing half) will be blank
            # and /api/health is the only place that can say why.
            state.last_error = note
            ok = True
            physical = sum(1 for r in merged.values() if "physical" in r)
            commercial = sum(1 for r in merged.values() if "commercial" in r)
            log.info(
                "Energy flows: %d countries (%d with measured physical flows, "
                "%d with scheduled exchanges), %d request failures%s",
                len(merged), physical, commercial, total_failures,
                f", degraded: {', '.join(degraded)}" if degraded else "",
            )
            await storage.record_reference("energy_flows", merged)
            await storage.record_source_health("energy_flows", len(merged), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Energy flows sweep failed: %s", exc)
            await storage.record_source_health("energy_flows", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            config.ENERGY_FLOWS_POLL_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, config.ENERGY_FLOWS_POLL_INTERVAL)
        )
