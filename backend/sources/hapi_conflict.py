"""ACLED conflict counts at district level, via HDX HAPI. Keyless, no embargo.

This is the practical answer to not having event-level ACLED access. A
Research-tier myACLED account is embargoed roughly twelve months, which makes
backend/sources/acled.py's point feed useless for anything current (see
_within_real_lookback there -- it correctly discards every embargoed row). HDX
HAPI republishes the same ACLED data as monthly counts per admin-2 district,
with no key and no embargo: verified live, coverage runs to the end of the
previous month.

What that buys, none of which the live GDELT-derived layer can do on its own:

  * a ground-truth check on where violence actually is, independent of what
    happened to be in the news in the last two hours;
  * escalation baselines that need zero uptime from this app, instead of the
    36 hours of self-observed history escalation.py otherwise requires;
  * real district-level numbers on country cards.

It is emphatically NOT live -- every record carries the month it covers, and
nothing here should ever be rendered as a current event.

`app_identifier` is a courtesy string HAPI asks callers to send (base64 of
"name:email"), not an issued credential. It is read from the environment so a
deployment identifies itself rather than this repo hard-coding an address.
"""

import asyncio
import base64
import logging
import os
import time
from datetime import datetime, timezone

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.hapi_conflict")

BASE_URL = "https://hapi.humdata.org/api/v2/coordination-context/conflict-events"
POLL_INTERVAL = 6 * 3600  # the underlying data changes monthly; this only needs to notice within a day
FAILURE_RETRY_INTERVAL = 300
PAGE_SIZE = 10000  # HAPI's maximum
MAX_PAGES = 10     # Colombia needs 7 over a 24-month window; this is the safety valve above that
RETRIES = 3        # a free public API will occasionally 429 under concurrent paging
MONTHS_KEPT = 24

# ACLED's own event-type buckets as HAPI exposes them.
EVENT_TYPES = ("political_violence", "civilian_targeting", "demonstration")

# Countries overlapping regions.py's theatres, plus the other large ongoing
# conflicts. Deliberately a fixed list rather than "every country": the whole
# dataset is millions of rows and the app only ever asks about these.
COUNTRIES = (
    "UKR", "RUS", "PSE", "ISR", "LBN", "SYR", "IRQ", "IRN", "YEM", "SAU",
    "SDN", "SSD", "ETH", "SOM", "MLI", "BFA", "NER", "NGA", "TCD", "CMR",
    "COD", "MOZ", "LBY", "AFG", "PAK", "IND", "MMR", "PHL", "COL", "MEX",
    "VEN", "HTI", "PRK", "KOR", "TWN", "CHN", "ARM", "AZE", "GEO", "EGY",
)


def _app_identifier() -> str | None:
    """HAPI's caller identifier: base64 of "appname:email".

    Not a credential -- nothing is issued or approved -- but HAPI does validate
    that the email is well-formed and rejects placeholders with
    403 "Invalid app identifier", so there is no usable built-in default. Set
    HAPI_CONTACT_EMAIL in .env (gitignored) rather than committing an address.
    """
    raw = os.getenv("HAPI_APP_IDENTIFIER", "").strip()
    if raw:
        return raw
    contact = os.getenv("HAPI_CONTACT_EMAIL", "").strip()
    if not contact:
        return None
    return base64.b64encode(f"osint-live-globe:{contact}".encode()).decode()


def _month_key(value: str | None) -> str | None:
    """"2026-07-01T00:00:00" -> "2026-07"."""
    if not value:
        return None
    return value[:7] or None


def _months_ago(months: int) -> str:
    now = datetime.now(timezone.utc)
    total = now.year * 12 + (now.month - 1) - months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


async def _get_page(client: httpx.AsyncClient, params: dict, code: str) -> list[dict]:
    """One page, retrying the failures that are worth retrying.

    Forty countries paged concurrently will occasionally draw a 429 or a
    transient 5xx from a free public API, and without a retry those countries
    silently vanish from the layer for six hours until the next poll -- which
    is exactly the sort of quiet partial failure that makes a map lie.
    """
    delay = 2.0
    for attempt in range(RETRIES):
        try:
            resp = await client.get(BASE_URL, params=params)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < RETRIES - 1:
                await asyncio.sleep(delay)
                delay *= 2
                continue
            resp.raise_for_status()
            return (resp.json() or {}).get("data") or []
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt == RETRIES - 1:
                raise
            await asyncio.sleep(delay)
            delay *= 2
    return []


async def _fetch_country(client: httpx.AsyncClient, code: str, identifier: str) -> list[dict]:
    cutoff = _months_ago(MONTHS_KEPT)
    # start_date is the parameter HAPI actually honours (verified against its
    # OpenAPI spec -- reference_period_* names are silently ignored and return
    # the full history back to 1997).
    base_params = {
        "output_format": "json",
        "location_code": code,
        "start_date": f"{cutoff}-01",
        "limit": PAGE_SIZE,
        "app_identifier": identifier,
    }

    rows: list[dict] = []
    for page in range(MAX_PAGES):
        chunk = await _get_page(client, {**base_params, "offset": page * PAGE_SIZE}, code)
        rows.extend(chunk)
        # A short page means the end. Sudan alone exceeds one page even over a
        # 24-month window, so paging is not optional.
        if len(chunk) < PAGE_SIZE:
            break
    else:
        log.warning("HAPI: hit the %d-page ceiling for %s; data may be truncated", MAX_PAGES, code)

    # Roll the per-(district, month, type) rows up into one record per district
    # per month, with the three event types as separate counts. That is the
    # shape a map layer and a country card both want, and it is roughly an
    # order of magnitude fewer records than the raw response.
    grouped: dict[tuple, dict] = {}
    for row in rows:
        month = _month_key(row.get("reference_period_start"))
        if not month or month < cutoff:
            continue
        key = (row.get("admin1_code"), row.get("admin2_code"), month)
        record = grouped.get(key)
        if record is None:
            record = grouped[key] = {
                "id": f"hapi-{code}-{row.get('admin2_code') or row.get('admin1_code')}-{month}",
                "country_code": code,
                "country": row.get("location_name"),
                "admin1": row.get("admin1_name"),
                "admin2": row.get("admin2_name"),
                "month": month,
                "events": 0,
                "fatalities": 0,
            }
        events = row.get("events") or 0
        fatalities = row.get("fatalities") or 0
        event_type = row.get("event_type")
        if event_type in EVENT_TYPES:
            record[event_type] = (record.get(event_type) or 0) + events
        # Demonstrations are counted separately and deliberately excluded from
        # the headline totals: this app's conflict layer is violence-only, and
        # the two numbers should not be mixed just because one API returns
        # them together.
        if event_type != "demonstration":
            record["events"] += events
            record["fatalities"] += fatalities
    return list(grouped.values())


async def _fetch(identifier: str) -> list[dict]:
    # Modest concurrency: HAPI is a public good and forty parallel 10k-row
    # requests is not a neighbourly way to use it.
    semaphore = asyncio.Semaphore(2)

    async def one(client, code):
        async with semaphore:
            try:
                return await _fetch_country(client, code, identifier)
            except Exception as exc:  # noqa: BLE001 - one country failing is not the poll failing
                # WARNING, not debug: a country dropping out silently means the
                # map is missing a whole theatre with no visible sign of it.
                log.warning("HAPI conflict fetch failed for %s: %s", code, exc)
                return []

    async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
        results = await asyncio.gather(*(one(client, c) for c in COUNTRIES))
    missing = [c for c, chunk in zip(COUNTRIES, results) if not chunk]
    if missing:
        log.warning("HAPI conflict: no data for %d/%d countries: %s",
                    len(missing), len(COUNTRIES), ", ".join(missing))
    return [record for chunk in results for record in chunk]


async def start():
    identifier = _app_identifier()
    state = registry.register("hapi_conflict", key_configured=bool(identifier))
    if not identifier:
        # Not a key, but HAPI still requires a valid contact address. Stay
        # inert and say so, rather than retrying a request that can only 403.
        state.last_error = (
            "HAPI_CONTACT_EMAIL not set in .env -- district-level ACLED needs a "
            "contact address (no registration, but HAPI rejects placeholders)"
        )
        log.warning("HAPI conflict disabled: %s", state.last_error)
        while True:
            await asyncio.sleep(3600)

    failures = 0
    while True:
        try:
            items = await _fetch(identifier)
            if not items:
                raise RuntimeError("HAPI returned no conflict records")
            state.data = items
            state.last_success = time.time()
            state.last_error = None
            failures = 0
            newest = max((r["month"] for r in items), default="?")
            log.info(
                "HAPI conflict: %d district-months across %d countries (through %s)",
                len(items), len({r["country_code"] for r in items}), newest,
            )
            await storage.record_reference("hapi_conflict", items)
            await storage.record_source_health("hapi_conflict", len(items), True)
            await asyncio.sleep(POLL_INTERVAL)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            failures += 1
            state.last_error = str(exc)
            log.warning("HAPI conflict fetch failed: %s", exc)
            await storage.record_source_health("hapi_conflict", None, False, str(exc))
            await asyncio.sleep(min(FAILURE_RETRY_INTERVAL * failures, POLL_INTERVAL))
