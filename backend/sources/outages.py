"""Which countries -- and now which of their regions and ISPs -- are losing
the internet right now.

IODA (Internet Outage Detection and Analysis, Georgia Tech) watches three
independent signals -- BGP withdrawals, active probing of address space, and
unsolicited darknet traffic -- and reports where they disagree with normal. It
is keyless and public.

Three passes over the same summary endpoint, `entityType` switched each time:

- **country** -- genuinely national in scope, and the only one with no location
  finer than the country, so it is served as a country-keyed dictionary rather
  than points (see parse_outages below) and rendered as a country tint plus a
  line in the country card. Unchanged by this module's region/ASN additions.
- **region** -- IODA's own sub-national entities (NetAcuity regions: Algerian
  wilayas, US states, Ukrainian oblasts and the like). IODA does not carry ISO
  3166-2 codes itself, only its own numeric `entityCode`, a name, and the
  parent country's ISO2 -- so matching one to the admin-1 boundary this map
  already draws is a name join, done once per poll in `build_region_lookup`.
  Exact match first, then a name folded through the same normalisation the
  gazetteer uses, then unmatched. **A region that cannot be matched stays in
  the payload with `matched: "unmatched"`** -- it is real evidence IODA
  published, and dropping it silently would be indistinguishable from IODA
  never having reported it at all. It is simply never drawn, for want of a
  shape to draw it on.
- **asn** -- the networks actually carrying the loss, for countries the
  country pass already put above the floor. Not every ASN in a country, which
  would be a census, but the handful IODA itself is currently scoring highest
  there -- see ASN_TOP_N. Persisted for the record; nothing on the map reads
  it yet.

What the score is *not*, in any of the three: a percentage of the
country/region offline. `scores.overall` is IODA's own composite, unbounded
and useful only in comparison -- against the same entity's normal, and against
other entities in the same window. The frontend says so wherever it shows a
number, and so does every record's own `signals` field, which keeps the three
underlying detectors visible rather than collapsed into one number that hides
which of them actually saw something.
"""

import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry
from backend.sources import admin1_boundaries
from backend.sources.gazetteer import normalize

log = logging.getLogger("osint-globe.outages")

IODA_URL = "https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary"
REFRESH_INTERVAL = 15 * 60
FAILURE_RETRY_INTERVAL = 60  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# How far back each poll asks about. A day, so a blackout that began overnight
# is still reported this morning rather than vanishing the moment it stops
# getting worse.
WINDOW_SECONDS = 24 * 3600

# IODA reports every country/region with any anomaly at all, and the long tail
# is routine noise. This is a floor on the composite score, chosen to keep the
# tail out of the country/state cards without hiding anything a reader would
# call an outage. Applied identically to all three passes: the composite is
# the same kind of number regardless of what entity it is scoring.
MIN_SCORE = 1_000_000

# "Top ISPs", not a census: enough to say something concrete about who is
# carrying a country's outage without turning this into a sweep of every ASN
# IODA has ever scored there (a busy country returns dozens).
ASN_TOP_N = 5

# Natural Earth ships "-99" as the ISO2 of a handful of countries (France,
# Norway, Kosovo among them -- see popups.js's own ISO2_BY_ISO3, which this
# mirrors in the other direction). admin1_boundaries.py keys its stored
# collections by ISO3, so those three would otherwise never resolve to a
# lookup here even though Natural Earth does carry their admin-1 geometry.
_ISO3_BY_ISO2_OVERRIDE = {"FR": "FRA", "NO": "NOR", "XK": "KOS"}


def parse_outages(payload: dict, window_start: float, window_end: float) -> dict[str, dict]:
    """IODA's summary -> {ISO2: record}.

    Keyed by the two-letter country code because that is what the map's own
    country shapes are keyed by (see backend/sources/countries.py), so the tint
    can be applied without a second name-matching step -- and country name
    matching is exactly the kind of join that silently drops Cote d'Ivoire.
    """
    out: dict[str, dict] = {}
    for row in (payload or {}).get("data") or []:
        entity = row.get("entity") or {}
        code = (entity.get("code") or "").strip().upper()
        if not code or (entity.get("type") or "") != "country":
            continue
        scores = row.get("scores") or {}
        overall = scores.get("overall")
        if not isinstance(overall, (int, float)) or overall < MIN_SCORE:
            continue
        out[code] = {
            "country_code": code,
            "country": entity.get("name"),
            "score": float(overall),
            # The three signals behind the composite, kept separate: a drop
            # visible in BGP alone is a routing change, while one visible in all
            # three is the network genuinely going away.
            "signals": {
                key: value for key, value in scores.items()
                if key != "overall" and isinstance(value, (int, float))
            },
            "event_count": row.get("event_cnt"),
            "window_start": window_start,
            "window_end": window_end,
        }
    return out


def region_lookup_for_country(features: list[dict]) -> dict:
    """One country's admin-1 features (as admin1_boundaries.py stores them) ->
    {"exact": {name: code}, "fuzzy": {normalized_name: code}}.

    Only features carrying both a name and a code are usable -- Natural Earth
    ships a handful of subdivisions with no ISO 3166-2 code at all (see that
    module's own docstring), and those can never be joined by name here either.
    `setdefault` rather than plain assignment: where two subdivisions share a
    name after normalising (rare, but Natural Earth's own duplicate-code cases
    -- see admin1_boundaries.py's `_assign_keys` -- can produce it), the first
    one encountered wins rather than the last, which is at least deterministic
    against the order the source publishes them in.
    """
    exact: dict[str, str] = {}
    fuzzy: dict[str, str] = {}
    for feature in features or []:
        props = feature.get("properties") or {}
        code = props.get("code")
        name = props.get("name")
        if not code or not name:
            continue
        exact.setdefault(name, code)
        fuzzy.setdefault(normalize(name), code)
    return {"exact": exact, "fuzzy": fuzzy}


def _iso2_to_iso3_map() -> dict[str, str]:
    """ISO2 -> ISO3, from the countries source's own live features.

    Both codes are carried on the same feature (see sources/countries.py), so
    this needs no fetch of its own -- it just reads whatever the countries
    poller currently has in hand. Built fresh on every call rather than cached,
    so a boundary correction there is picked up on this module's very next
    poll without a restart.
    """
    out: dict[str, str] = dict(_ISO3_BY_ISO2_OVERRIDE)
    if not registry.has("countries"):
        return out
    fc = registry.get("countries").data or {}
    for feature in (fc.get("features") or []):
        props = feature.get("properties") or {}
        iso2 = (props.get("iso_a2") or "").strip().upper()
        iso3 = (props.get("iso_a3") or "").strip().upper()
        if iso2 and iso2 != "-99" and iso3 and iso3 != "-99":
            out[iso2] = iso3
    return out


def _region_country_codes(payload: dict) -> set[str]:
    """Every ISO2 the region pass mentions, matched or not -- the lookup is
    built for exactly this set, and only this set, so a poll never reads more
    admin-1 collections out of Postgres than the response it just got actually
    needs."""
    codes: set[str] = set()
    for row in (payload or {}).get("data") or []:
        entity = row.get("entity") or {}
        if (entity.get("type") or "") != "region":
            continue
        code = ((entity.get("attrs") or {}).get("country_code") or "").strip().upper()
        if code:
            codes.add(code)
    return codes


async def build_region_lookup(country_codes: set[str]) -> dict[str, dict]:
    """ISO2 -> region_lookup_for_country's result, for every country code in
    `country_codes` this map has admin-1 geometry for.

    A country missing from the returned dict (no ISO3, or no stored admin-1
    collection) is not an error -- parse_outage_regions below simply finds no
    lookup for it and every one of its regions comes back unmatched, which is
    the honest answer for a country this map cannot place subdivisions in at
    all.
    """
    iso3_by_iso2 = _iso2_to_iso3_map()
    lookup: dict[str, dict] = {}
    for iso2 in country_codes:
        iso3 = iso3_by_iso2.get(iso2)
        if not iso3:
            continue
        collection = await storage.reference(f"{admin1_boundaries.SNAPSHOT_PREFIX}:{iso3}")
        features = (collection or {}).get("features") or []
        if features:
            lookup[iso2] = region_lookup_for_country(features)
    return lookup


def parse_outage_regions(
    payload: dict, lookup_by_iso2: dict[str, dict], window_start: float, window_end: float
) -> dict[str, dict[str, dict]]:
    """IODA's region summary -> {ISO2: {key: record}}.

    `key` is the resolved ISO 3166-2 code for an exact or fuzzy match, or
    IODA's own `entityCode` for a region this map could not place -- the two
    id spaces never collide (an ISO 3166-2 code always contains a hyphen; a
    NetAcuity entityCode is bare digits), so unmatched regions get a stable key
    of their own rather than being dropped for want of one.
    """
    out: dict[str, dict[str, dict]] = {}
    for row in (payload or {}).get("data") or []:
        entity = row.get("entity") or {}
        if (entity.get("type") or "") != "region":
            continue
        attrs = entity.get("attrs") or {}
        country_code = (attrs.get("country_code") or "").strip().upper()
        entity_code = str(entity.get("code") or "").strip()
        name = (entity.get("name") or "").strip()
        if not country_code or not entity_code or not name:
            continue
        scores = row.get("scores") or {}
        overall = scores.get("overall")
        if not isinstance(overall, (int, float)) or overall < MIN_SCORE:
            continue

        lookup = lookup_by_iso2.get(country_code) or {}
        region_code = lookup.get("exact", {}).get(name)
        matched = "exact"
        if region_code is None:
            region_code = lookup.get("fuzzy", {}).get(normalize(name))
            matched = "fuzzy" if region_code is not None else "unmatched"

        record = {
            "entity_code": entity_code,
            "name": name,
            "country_code": country_code,
            # None, honestly, rather than a made-up code, when matched is "unmatched".
            "region_code": region_code,
            "matched": matched,
            "score": float(overall),
            "signals": {
                key: value for key, value in scores.items()
                if key != "overall" and isinstance(value, (int, float))
            },
            "event_count": row.get("event_cnt"),
            "window_start": window_start,
            "window_end": window_end,
            "publisher": "IODA (Georgia Tech)",
        }
        key = region_code if matched != "unmatched" else entity_code
        out.setdefault(country_code, {})[key] = record
    return out


def parse_outage_asns(
    payload: dict, country_code: str, window_start: float, window_end: float
) -> list[dict]:
    """IODA's ASN summary for one country -> its top ASN_TOP_N records,
    highest score first.

    IODA does not name the country on an ASN entity (an AS can straddle
    borders), so `country_code` is the country this fetch was scoped to via
    `relatedTo=country/<ISO2>` -- carried on the record as the fetch's own
    claim, not IODA's.
    """
    out: list[dict] = []
    for row in (payload or {}).get("data") or []:
        entity = row.get("entity") or {}
        if (entity.get("type") or "") != "asn":
            continue
        attrs = entity.get("attrs") or {}
        scores = row.get("scores") or {}
        overall = scores.get("overall")
        if not isinstance(overall, (int, float)) or overall < MIN_SCORE:
            continue
        asn = str(entity.get("code") or "").strip()
        if not asn:
            continue
        out.append({
            "asn": asn,
            # attrs.name is the operator's own short name ("MTNCI-AS"); the bare
            # entity.name repeats the ASN ("AS36974 (AFNET-AS)") when attrs has
            # none, which still beats leaving the field empty.
            "name": attrs.get("name") or entity.get("name"),
            "org": attrs.get("org"),
            "country_code": country_code,
            "score": float(overall),
            "event_count": row.get("event_cnt"),
            "window_start": window_start,
            "window_end": window_end,
            "publisher": "IODA (Georgia Tech)",
        })
    out.sort(key=lambda r: r["score"], reverse=True)
    return out[:ASN_TOP_N]


async def _fetch_entity_type(client: httpx.AsyncClient, entity_type: str, start: float, end: float, **params) -> dict:
    resp = await client.get(
        IODA_URL,
        params={"from": int(start), "until": int(end), "entityType": entity_type, **params},
    )
    resp.raise_for_status()
    return resp.json()


async def start():
    state = registry.register("outages", key_configured=True)  # no key required
    # A dict, not a list -- same shape as hdx_conflict_stats, and read the same
    # way by the country card rather than drawn as markers.
    state.data = {}
    await storage.warm_reference(state, "outages", "Internet outages")

    regions_state = registry.register("outages_regions", key_configured=True)
    regions_state.data = {}
    await storage.warm_reference(regions_state, "outages_regions", "Sub-national internet outages")

    # Not read by any endpoint yet -- see the module docstring's ASN pass note
    # -- but warmed and health-checked the same as the other two regardless, so
    # a restart does not quietly stop collecting it and nothing downstream has
    # to guess whether it is still being written.
    asns_state = registry.register("outages_asns", key_configured=True)
    asns_state.data = {}
    await storage.warm_reference(asns_state, "outages_asns", "Outage-affected ISPs")

    consecutive_failures = 0
    while True:
        ok = False
        try:
            end = time.time()
            begin = end - WINDOW_SECONDS
            async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
                country_payload = await _fetch_entity_type(client, "country", begin, end)
                outages = parse_outages(country_payload, begin, end)

                region_payload = await _fetch_entity_type(client, "region", begin, end)
                lookup = await build_region_lookup(_region_country_codes(region_payload))
                regions = parse_outage_regions(region_payload, lookup, begin, end)

                # One relatedTo fetch per country already above the floor -- see
                # ASN_TOP_N. Usually a handful of requests; a single country's
                # failure here must not cost the country or region passes that
                # already succeeded, so it is caught per-country rather than
                # around the whole loop.
                asns: dict[str, list[dict]] = {}
                for code in outages:
                    try:
                        asn_payload = await _fetch_entity_type(
                            client, "asn", begin, end, relatedTo=f"country/{code}"
                        )
                        top = parse_outage_asns(asn_payload, code, begin, end)
                        if top:
                            asns[code] = top
                    except Exception as exc:  # noqa: BLE001 - one country's ASNs, not the whole poll
                        log.warning("IODA ASN fetch failed for %s: %s", code, exc)

            state.data = outages
            state.last_success = time.time()
            state.last_error = None
            regions_state.data = regions
            regions_state.last_success = time.time()
            regions_state.last_error = None
            asns_state.data = asns
            asns_state.last_success = time.time()
            asns_state.last_error = None
            ok = True

            worst = sorted(outages.values(), key=lambda r: r["score"], reverse=True)[:3]
            region_count = sum(len(v) for v in regions.values())
            region_matched = sum(
                1 for by_country in regions.values() for r in by_country.values() if r["matched"] != "unmatched"
            )
            log.info(
                "Internet outages: %d countries above threshold%s, %d regions (%d matched), %d countries with ASN detail",
                len(outages),
                f" (worst: {', '.join(r['country'] or r['country_code'] for r in worst)})" if worst else "",
                region_count,
                region_matched,
                len(asns),
            )
            await storage.record_reference("outages", outages)
            await storage.record_reference("outages_regions", regions)
            await storage.record_reference("outages_asns", asns)
            await storage.record_source_health("outages", len(outages), True)
            await storage.record_source_health("outages_regions", region_count, True)
            await storage.record_source_health("outages_asns", sum(len(v) for v in asns.values()), True)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            # One shared failure: whichever of the three passes raised, the
            # ones after it in the try block above never ran either, so all
            # three health rows and all three states' last_error say so --
            # not just the one that happened to throw.
            state.last_error = str(exc)
            regions_state.last_error = str(exc)
            asns_state.last_error = str(exc)
            log.warning("IODA outage fetch failed: %s", exc)
            await storage.record_source_health("outages", None, False, str(exc))
            await storage.record_source_health("outages_regions", None, False, str(exc))
            await storage.record_source_health("outages_asns", None, False, str(exc))
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
