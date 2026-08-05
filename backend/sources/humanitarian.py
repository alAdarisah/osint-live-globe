"""Who has been displaced, and who is going hungry.

The conflict layers on this map answer "what happened, where". This answers the
question immediately behind it, which for most of the world is the more
consequential one: what it did to the people living there.

Two publishers, chosen so the module is useful with no configuration at all:

- **UNHCR** (`api.unhcr.org`) is keyless and works out of the box. It gives
  refugees, asylum seekers, internally displaced people and stateless people by
  *country of origin*, which is the framing that matches a map of conflict --
  "how many people has this war put to flight", not "how many arrived here".
- **HDX HAPI** adds IPC food-security phases and in-country IDP counts at
  admin-2 resolution, plus which organisations are operating where. HAPI needs a
  contact address (see backend/sources/hapi.py), so this half stays inert until
  one is configured and says so, exactly as hapi_conflict.py does.

**None of it goes on the map.** Every figure here is a country or admin-1
aggregate over a reference period of months, and drawing that as a pin would
claim a precision it does not have -- and add exactly the clutter the rest of
this map spent its time removing. It is served as a country-keyed dictionary
and rendered inside the country card, with its reference period attached to
every number.
"""

import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry
from backend.sources import hapi

log = logging.getLogger("osint-globe.humanitarian")

UNHCR_URL = "https://api.unhcr.org/population/v1/population/"
POLL_INTERVAL = 12 * 3600  # both publishers update on the order of months
FAILURE_RETRY_INTERVAL = 300

# UNHCR publishes the previous year's figures partway through the following
# one, so "this year" is routinely empty. Asking for a small window and taking
# the newest year that actually returned rows avoids a blank card every January.
UNHCR_YEARS_BACK = 3
UNHCR_PAGE_LIMIT = 400  # ~210 countries of origin; one page

# IPC phase 3 is "Crisis", 4 "Emergency", 5 "Catastrophe/Famine". Phase 3 and
# above is the standard headline figure -- "people in crisis or worse" -- and
# summing all five phases would just restate the population.
IPC_CRISIS_MIN_PHASE = 3

# Same fixed country list hapi_conflict uses, and for the same reason: the whole
# dataset is far larger than anything this app asks about.
COUNTRIES = (
    "UKR", "PSE", "SYR", "LBN", "IRQ", "YEM", "SDN", "SSD", "ETH", "SOM",
    "MLI", "BFA", "NER", "NGA", "TCD", "CMR", "COD", "MOZ", "LBY", "AFG",
    "MMR", "COL", "VEN", "HTI",
)


def _number(value) -> int | None:
    """UNHCR writes zeros and blanks as the strings "0" and "-"."""
    if value in (None, "-", ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_unhcr(items: list[dict]) -> dict[str, dict]:
    """UNHCR population rows -> {ISO3: record}, newest year per country.

    Keyed on the ISO3 country-of-origin code, which is what HAPI uses too, so
    the two halves join without a name match.
    """
    out: dict[str, dict] = {}
    for row in items or []:
        code = (row.get("coo_iso") or row.get("coo") or "").strip().upper()
        if not code or len(code) != 3:
            continue
        try:
            year = int(row.get("year"))
        except (TypeError, ValueError):
            continue
        existing = out.get(code)
        if existing and existing["year"] >= year:
            continue
        record = {
            "country_code": code,
            "country": row.get("coo_name"),
            "year": year,
            "refugees": _number(row.get("refugees")),
            "asylum_seekers": _number(row.get("asylum_seekers")),
            "idps": _number(row.get("idps")),
            "returned_refugees": _number(row.get("returned_refugees")),
            "stateless": _number(row.get("stateless")),
            "others_of_concern": _number(row.get("ooc")),
        }
        # A row where every figure is absent is not data about a country, it is
        # a row UNHCR had nothing to say about.
        if any(record[k] for k in ("refugees", "asylum_seekers", "idps", "stateless")):
            out[code] = record
    return out


def parse_food_security(rows: list[dict]) -> dict | None:
    """HAPI IPC rows for one country -> the current crisis-or-worse headline.

    Only the newest reference period is used. IPC republishes the same
    geography for each analysis round, so summing across periods would count
    the same people several times over.
    """
    current = [r for r in rows or [] if (r.get("ipc_type") or "") == "current"]
    if not current:
        return None
    newest = max((r.get("reference_period_start") or "") for r in current)
    in_period = [r for r in current if (r.get("reference_period_start") or "") == newest]
    # Admin-2 rows and their admin-1 parents both appear; taking the deepest
    # level present avoids adding a district to the province containing it.
    deepest = max((r.get("admin_level") or 0) for r in in_period)
    in_period = [r for r in in_period if (r.get("admin_level") or 0) == deepest]

    total = 0
    for row in in_period:
        try:
            phase = int(row.get("ipc_phase"))
        except (TypeError, ValueError):
            continue
        if phase < IPC_CRISIS_MIN_PHASE:
            continue
        total += row.get("population_in_phase") or 0
    if not total:
        return None
    return {
        "population_in_crisis": total,
        "reference_period_start": newest,
        "reference_period_end": max((r.get("reference_period_end") or "") for r in in_period) or None,
        "admin_level": deepest,
    }


def parse_operational_presence(rows: list[dict]) -> dict | None:
    """The 3W -- who is doing what, where -- reduced to two counts.

    Deliberately just counts. A list of 400 organisations is a dataset, not a
    line in a card, and the useful signal at this altitude is whether anyone is
    there at all.
    """
    orgs = {r.get("org_acronym") or r.get("org_name") for r in rows or []}
    orgs.discard(None)
    sectors = {r.get("sector_name") for r in rows or []}
    sectors.discard(None)
    if not orgs:
        return None
    return {"organisations": len(orgs), "sectors": sorted(sectors)[:12], "sector_count": len(sectors)}


def parse_idps(rows: list[dict]) -> dict | None:
    """HAPI IDP rows for one country -> the newest reporting round's total."""
    if not rows:
        return None
    newest = max((r.get("reference_period_start") or "") for r in rows)
    in_period = [r for r in rows if (r.get("reference_period_start") or "") == newest]
    deepest = max((r.get("admin_level") or 0) for r in in_period)
    total = sum(
        r.get("population") or 0 for r in in_period if (r.get("admin_level") or 0) == deepest
    )
    if not total:
        return None
    return {"population": total, "reference_period_start": newest, "admin_level": deepest}


async def _fetch_unhcr() -> dict[str, dict]:
    # `coo_all=true` asks for one row per country of origin rather than the
    # origin/asylum matrix, which is tens of thousands of rows and answers a
    # question this map does not ask.
    async with httpx.AsyncClient(
        timeout=60, follow_redirects=True, headers={"User-Agent": "osint-live-globe/1.0"}
    ) as client:
        resp = await client.get(
            UNHCR_URL,
            params={
                "limit": UNHCR_PAGE_LIMIT,
                "yearFrom": time.gmtime().tm_year - UNHCR_YEARS_BACK,
                "yearTo": time.gmtime().tm_year,
                "coo_all": "true",
            },
        )
        resp.raise_for_status()
    return parse_unhcr((resp.json() or {}).get("items") or [])


async def _fetch_hapi(identifier: str) -> dict[str, dict]:
    """IPC, IDP and 3W figures per country, as far as HAPI will give them."""
    subjects = {
        "food_security": ("food-security-nutrition-poverty/food-security", parse_food_security),
        "idps": ("affected-people/idps", parse_idps),
        "operational_presence": ("coordination-context/operational-presence", parse_operational_presence),
    }
    out: dict[str, dict] = {}
    # Modest concurrency: HAPI is a public good, and this is 24 countries times
    # three subjects.
    semaphore = asyncio.Semaphore(2)

    async def one(client, code, name, path, parse):
        async with semaphore:
            try:
                rows = await hapi.get_page(
                    client,
                    f"{hapi.BASE_URL}/{path}",
                    {
                        "output_format": "json",
                        "location_code": code,
                        "limit": hapi.PAGE_SIZE,
                        "app_identifier": identifier,
                    },
                )
            except Exception as exc:  # noqa: BLE001 - one subject failing is not the poll failing
                log.warning("HAPI %s failed for %s: %s", name, code, exc)
                return
            parsed = parse(rows)
            if parsed:
                out.setdefault(code, {})[name] = parsed

    async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
        await asyncio.gather(*(
            one(client, code, name, path, parse)
            for code in COUNTRIES
            for name, (path, parse) in subjects.items()
        ))
    return out


def merge(unhcr: dict[str, dict], hapi_data: dict[str, dict]) -> dict[str, dict]:
    """One record per country, each half labelled with where it came from."""
    merged: dict[str, dict] = {}
    for code in set(unhcr) | set(hapi_data):
        record = {"country_code": code}
        displacement = unhcr.get(code)
        if displacement:
            record["displacement"] = displacement
            record["country"] = displacement.get("country")
        for name, value in (hapi_data.get(code) or {}).items():
            record[name] = value
        merged[code] = record
    return merged


async def start():
    identifier = hapi.app_identifier()
    # `key_configured` reports the HAPI half only: UNHCR needs nothing, so this
    # source is always at least partly alive and /api/health should say which
    # part is missing rather than showing it as unconfigured outright.
    state = registry.register("humanitarian", key_configured=bool(identifier))
    if not identifier:
        state.last_error = (
            "HAPI_CONTACT_EMAIL not set in .env -- food security, IDP counts and "
            "operational presence need a contact address (no registration, but "
            "HAPI rejects placeholders). UNHCR displacement figures still load."
        )
        log.warning("Humanitarian: HAPI half disabled -- %s", state.last_error)

    failures = 0
    while True:
        try:
            unhcr = await _fetch_unhcr()
            hapi_data = await _fetch_hapi(identifier) if identifier else {}
            merged = merge(unhcr, hapi_data)
            if not merged:
                raise RuntimeError("no humanitarian records from any publisher")
            state.data = merged
            state.last_success = time.time()
            # Deliberately not cleared when the HAPI half is unconfigured: that
            # message is the standing explanation for why half the card is
            # missing, and a successful UNHCR fetch does not make it untrue.
            if identifier:
                state.last_error = None
            failures = 0
            log.info(
                "Humanitarian: %d countries with displacement figures, %d with HAPI detail",
                len(unhcr), len(hapi_data),
            )
            await storage.record_reference("humanitarian", merged)
            await storage.record_source_health("humanitarian", len(merged), True)
            await asyncio.sleep(POLL_INTERVAL)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            failures += 1
            state.last_error = str(exc)
            log.warning("Humanitarian fetch failed: %s", exc)
            await storage.record_source_health("humanitarian", None, False, str(exc))
            await asyncio.sleep(min(FAILURE_RETRY_INTERVAL * failures, POLL_INTERVAL))
