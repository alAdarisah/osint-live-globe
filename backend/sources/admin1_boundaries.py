"""Admin-1 boundaries -- states, provinces, oblasts -- from Natural Earth.

Exists because a country is not the smallest thing a reader points at. Clicking
the United States returns one 9.8-million-km2 shape, which answers "which
country" and nothing else; the state is the unit almost everything reported
about that country is reported in, and it is the boundary a reader already has
in their head when they look at the map.

Natural Earth rather than OCHA's COD-AB, which is where the admin-2 district
layer gets its geometry (see admin2_boundaries.py). COD-AB exists for countries
with an active humanitarian response and no further: there is no OCHA boundary
file for the United States, Canada or Australia. Natural Earth is public domain,
ships every admin level from one file, and carries ISO 3166-2 codes -- the join
any future subnational feed will want, and the same role p-codes play for the
district layer.

The 1:10m cut, which is the only one that answers for more than a handful of
countries. The 1:50m file carries 294 subdivisions across the nine federations
large enough to be cut at that scale (USA, RUS, IND, IDN, CHN, BRA, CAN, AUS,
ZAF); selecting France, Nigeria or Syria there got a country outline and nothing
inside it. 1:10m carries 4,596 subdivisions across 251 countries -- every
country that has an admin-1 level at all -- and it is also better at the coast,
where 1:50m leaves slivers between a state and its own country outline wide
enough that a click on Manhattan landed in no state. It does not fix that
entirely and no scale would: downtown Miami is outside Natural Earth's Florida
in the published 1:10m geometry too, before any rounding here. The frontend
handles that by claiming such a click for the country rather than acting on the
miss -- see the click handler in map/createMapController.js.

Country attribution is Natural Earth's `adm0_a3` as published, which puts Crimea
and Sevastopol under Russia even though their ISO 3166-2 codes are UA-43 and
UA-40. Not corrected here, because the country layer this draws inside of is
Natural Earth too (ne_50m, see sources/countries.py) and puts the same ground
inside Russia's outline: reassigning it here alone would draw Ukrainian states
in territory where clicking resolves to Russia, and leave a hole in Russia.

The cost is size, and it is paid in three places. The download is 40.7 MB, which
is why it comes from raw.githubusercontent rather than jsDelivr -- jsDelivr
answers this file with "File size exceeded the configured limit of 20 MB".
Parsing it peaks around 400 MB of Python heap for the minute the weekly refresh
runs. And it stores as 21.9 MB across 251 snapshots once rounded, the largest
being Russia at 2.2 MB and the United States at 0.9 MB -- served per country, so
what a reader actually downloads is the one country they selected.

Downloaded once a week, for the same reason the district boundaries are: these
are administrative borders, which move when a country reorganises itself.
"""
import asyncio
import logging
import time

import httpx

from backend import storage
from backend.cache import registry
from backend.sources.admin2_boundaries import thin_geometry

log = logging.getLogger(__name__)

GEOJSON_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
    "ne_10m_admin_1_states_provinces.geojson"
)

REFRESH_INTERVAL = 7 * 24 * 3600
FAILURE_RETRY_INTERVAL = 60 * 60

SNAPSHOT_PREFIX = "admin1_boundaries"

# Coordinate precision, in decimal places. Three is about 110 m -- one place
# finer than the district layer keeps, because these shapes are read zoomed
# *into* a country rather than across one, and a state border visibly stepping
# in kilometre increments at zoom 7 would look like an error in the data rather
# than a rounding in the transport. The source is generalised to roughly a
# kilometre already, so this costs size without discarding anything real.
COORD_PRECISION = 3


def _first(props: dict, *names: str):
    """A property by name, case-insensitively -- Natural Earth's GeoJSON builds
    are lower-cased while its shapefile-derived ones are not, and which one a
    given release serves is not something to depend on."""
    lowered = {k.lower(): v for k, v in props.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value not in (None, ""):
            return value
    return None


def _assign_keys(features: list[dict]) -> None:
    """Give every subdivision in one country an identity unique to that country.

    ISO 3166-2 is not one, and the map needs one: 155 subdivisions across 24
    countries share a code with another subdivision of the same country, because
    Natural Earth cuts a capital out of the region around it and gives both the
    region's code -- Lima the province and Lima the city are both PE-LIM, Almaty
    the region and Almaty the city are both KZ-ALA, and five Latvian cities carry
    their surrounding municipality's code. Selecting one of those on the map
    highlighted both.

    The code is left exactly as published -- it is what a subnational feed will
    join on, and rewriting it would make this file lie about the source. The
    duplicate gets a suffixed `key` instead, which is only ever an identity for
    the shape. Name is not enough to disambiguate on its own: 57 of the 155
    duplicate the name as well.
    """
    seen: dict[str, int] = {}
    for feature in features:
        props = feature["properties"]
        base = props["code"] or f"{props['country_code']}:{props['name']}"
        seen[base] = seen.get(base, 0) + 1
        props["key"] = base if seen[base] == 1 else f"{base}#{seen[base]}"


def build_collections(features: list[dict]) -> dict[str, dict]:
    """One FeatureCollection per country, keyed by ISO3.

    Split by country at collection time rather than at request time because
    that is how it is served: a reader who has clicked the United States is
    handed the fifty-one US shapes, not the two hundred and ninety-four.

    Everything except the code, the name and the geometry is dropped. Natural
    Earth ships ~60 properties per subdivision -- Latin transliterations, label
    ranks, feature-class codes, five name variants -- and none of them are read.
    Subdivisions with no ISO 3166-2 code are still kept: a handful of Chinese
    and Indonesian entries carry an empty one, and dropping them would leave
    holes in an otherwise complete country rather than an honest gap.
    """
    out: dict[str, dict] = {}
    for feature in features or []:
        props = feature.get("properties") or {}
        iso3 = _first(props, "adm0_a3", "iso_a3", "sov_a3")
        name = _first(props, "name_en", "name", "gn_name")
        geometry = thin_geometry(feature.get("geometry"), COORD_PRECISION)
        if not iso3 or not name or not geometry:
            continue
        collection = out.setdefault(str(iso3).upper(), {"type": "FeatureCollection", "features": []})
        collection["features"].append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "code": _first(props, "iso_3166_2") or "",
                "name": name,
                # The two-letter postal abbreviation, where the country has one
                # (US, CA, AU, BR). It is what a reader reads a state as, and
                # what a subnational feed keyed on anything shorter than the
                # ISO code will be keyed on.
                "postal": _first(props, "postal") or "",
                # "State", "Province", "Oblast", "Territory" -- kept because it
                # is the difference between a federal state and a federal
                # district, which is a real distinction to make in a popup.
                "kind": _first(props, "type_en", "type") or "",
                "country_code": str(iso3).upper(),
                "country": _first(props, "admin") or "",
            },
        })
    for collection in out.values():
        _assign_keys(collection["features"])
    return out


async def _fetch() -> dict[str, dict]:
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        resp = await client.get(GEOJSON_URL)
        resp.raise_for_status()
        return build_collections(resp.json().get("features") or [])


async def refresh_once() -> dict[str, int]:
    """Fetch, split, store each country, return per-country feature counts."""
    collections = await _fetch()
    stored: dict[str, int] = {}
    for iso3, collection in collections.items():
        await storage.record_reference(f"{SNAPSHOT_PREFIX}:{iso3}", collection)
        stored[iso3] = len(collection["features"])
    # Totals plus the ten largest, rather than the whole list: 251 countries is
    # not a line anyone reads, and the countries worth seeing in a weekly log are
    # the ones whose subdivision count could plausibly have changed shape.
    largest = sorted(stored.items(), key=lambda kv: -kv[1])[:10]
    log.info(
        "Natural Earth admin-1: stored %d subdivisions across %d countries (largest: %s)",
        sum(stored.values()),
        len(stored),
        ", ".join(f"{iso3} ({count})" for iso3, count in largest),
    )
    return stored


async def start():
    state = registry.ensure(SNAPSHOT_PREFIX, key_configured=True)  # keyless, public domain
    while True:
        try:
            stored = await refresh_once()
            # The per-country counts, and only those: the geometry is read back
            # out of Postgres per request, for the same reason the district
            # boundaries are. Which countries are covered is not published
            # anywhere separately -- a country with no stored subdivisions
            # answers with an empty collection, which the frontend remembers.
            state.data = stored
            state.last_success = time.time()
            state.last_error = None
            await storage.record_source_health(SNAPSHOT_PREFIX, sum(stored.values()), True)
            await asyncio.sleep(REFRESH_INTERVAL)
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("Admin-1 boundary refresh failed: %s", exc)
            await storage.record_source_health(SNAPSHOT_PREFIX, None, False, str(exc))
            await asyncio.sleep(FAILURE_RETRY_INTERVAL)
