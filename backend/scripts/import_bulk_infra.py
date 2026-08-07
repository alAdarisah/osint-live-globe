"""One-shot bulk importer for critical-infrastructure / military-base data,
sourced from public bulk datasets instead of hand-curation or a live API.

Three kinds of source, handled differently:

  - OpenStreetMap (military bases): fetched live via one Overpass API query
    (no key, no signup) -- `--osm-military`.
  - Wikidata (all infra types + military bases): fetched live via the public
    SPARQL endpoint (no key, no signup) -- `--wikidata`. Runs one query per
    class (wdt:P31/wdt:P279* against a curated QID), pulling wdt:P625
    coordinates. Wikidata's military-base coverage is patchy outside
    NATO/Japan and doesn't reliably encode operational status, so treat its
    military rows as lower-confidence than OSM's -- worth a manual skim of
    infrastructure_imported.py before folding in.
  - Global Energy Monitor (refineries/LNG/nuclear) and NGA World Port Index
    (ports): GEM's trackers and NGA's WPI both gate their bulk CSV/XLSX
    downloads behind a browser click (email signup for GEM, a portal click
    for NGA) -- there's no stable unauthenticated URL to script around that.
    So: download the file yourself from
      GEM   https://globalenergymonitor.org/download-data
      NGA   https://msi.nga.mil (or the HDX mirror: search "World Port Index")
    and point this script at the local file with --gem-refineries /
    --gem-lng / --gem-nuclear / --wpi. Column names vary release to release,
    so the CSV reader below auto-detects name/lat/lon/status columns by
    header keyword rather than hardcoding exact column names.

  HIFLD (US DHS) was investigated too but its ArcGIS FeatureServer endpoints
  keep moving/dying (checked several candidate service URLs live while
  writing this -- none resolved), so there's no stable free URL to wire up
  today. If you find a current one, it's the same shape as --wpi: dump to
  CSV/GeoJSON and add a --hifld-<layer> flag using normalize_csv().

Output is NOT merged into backend/infrastructure.py automatically -- it's
written to a separate backend/infrastructure_imported.py so the diff is easy
to skim, prune, and hand-tag with region_keys before folding into the main
lists (see infrastructure.py's `serialize()` for how the two would combine).
That file is generated, scratch, and not in the repo: this script writes it
when it runs, and once its rows have been folded in it holds nothing but two
empty lists, which is worse than absent -- it reads like a curated source that
happens to be empty. Delete it after folding in.

Run: python -m backend.scripts.import_bulk_infra --osm-military --wikidata \
         --gem-refineries path/to/gem_oil_gas.csv --wpi path/to/wpi.csv
"""
import argparse
import csv
import logging
import re
import time
from pathlib import Path

import httpx

from backend.infrastructure import INFRA_SITES, MILITARY_BASES

log = logging.getLogger("import_bulk_infra")
logging.basicConfig(level=logging.INFO, format="%(message)s")

OUT_PATH = Path(__file__).resolve().parent.parent / "infrastructure_imported.py"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# A single planet-wide query reliably 504s on the public instance (it's a
# shared, rate-limited service -- see the caveat in this script's docstring
# and in the research plan this script came out of). Splitting into a few
# large continental boxes, queried one at a time with a pause between, is
# slower but actually completes. `landuse=military` (way/relation centroid
# via `out center`) is used alone -- adding the bare `military=*` node
# catch-all roughly triples result size for mostly small/unnamed features
# and was the main cause of the 504s during testing.
OVERPASS_BBOXES = {
    "north_america": (5, -170, 75, -50),
    "south_america": (-60, -85, 15, -30),
    "europe": (35, -25, 72, 45),
    "africa": (-35, -20, 38, 52),
    "middle_east_central_asia": (12, 25, 45, 80),
    "asia_pacific": (-50, 60, 55, 180),
}
OVERPASS_QUERY_TMPL = (
    '[out:json][timeout:90];nwr["landuse"="military"]["name"]({s},{w},{n},{e});out center tags;'
)

# Keyword -> our subtype, checked against OSM tags (military=*, aeroway=*).
_OSM_SUBTYPE_RULES = [
    (("aeroway", "airfield"), "air"),
    (("aeroway", "aerodrome"), "air"),
    (("military", "airfield"), "air"),
    (("military", "naval_base"), "naval"),
    (("military", "naval"), "naval"),
    (("military", "barracks"), "army"),
    (("military", "depot"), "logistics"),
    (("military", "range"), "missile"),
]

_STATUS_KEEP_KEYWORDS = ("operat", "active")
_STATUS_DROP_KEYWORDS = ("retir", "cancel", "shelved", "mothball", "decommission")


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s or "unnamed"


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    from math import radians, sin, cos, asin, sqrt
    r = 6371.0
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


def build_dedup_index(existing: list[dict]) -> tuple[set[str], list[tuple[float, float]]]:
    ids = {e["id"] for e in existing}
    coords = [(e["lat"], e["lon"]) for e in existing]
    return ids, coords


def is_duplicate(lat: float, lon: float, coords: list[tuple[float, float]], radius_km: float = 5.0) -> bool:
    return any(haversine_km(lat, lon, c_lat, c_lon) <= radius_km for c_lat, c_lon in coords)


def unique_id(base_id: str, taken: set[str]) -> str:
    candidate, n = base_id, 2
    while candidate in taken:
        candidate = f"{base_id}_{n}"
        n += 1
    taken.add(candidate)
    return candidate


# ---------------------------------------------------------------- OSM ----

def _osm_element_to_row(el: dict) -> dict | None:
    tags = el.get("tags") or {}
    name = tags.get("name")
    if not name:
        return None
    if "center" in el:
        lat, lon = el["center"]["lat"], el["center"]["lon"]
    elif "lat" in el:
        lat, lon = el["lat"], el["lon"]
    else:
        return None
    subtype = "joint"
    for (key, needle), sub in _OSM_SUBTYPE_RULES:
        if needle in (tags.get(key) or "").lower():
            subtype = sub
            break
    return {
        "name": name,
        "lat": round(lat, 4), "lon": round(lon, 4),
        "type": "military", "subtype": subtype,
        "note": f"OpenStreetMap landuse=military tag ({tags.get('military') or 'unspecified branch'}).",
    }


def fetch_osm_military() -> list[dict]:
    # A generic httpx UA gets a bare 406 from overpass-api.de's Apache front
    # end (mod_security-style UA filtering) -- any identifiable UA passes.
    headers = {"User-Agent": "osint-globe-import/1.0 (one-shot bulk import script)"}
    rows: list[dict] = []
    with httpx.Client(timeout=120, headers=headers) as client:
        for i, (region, (s, w, n, e)) in enumerate(OVERPASS_BBOXES.items()):
            query = OVERPASS_QUERY_TMPL.format(s=s, w=w, n=n, e=e)
            log.info("Querying Overpass for landuse=military in %s ...", region)
            try:
                resp = client.post(OVERPASS_URL, data={"data": query})
                resp.raise_for_status()
                payload = resp.json()
            except Exception as exc:  # noqa: BLE001 - Overpass's public instance is flaky/rate-limited; skip region, keep going
                log.warning("  %s: fetch failed (%s) -- skipping this region, rerun later to retry", region, exc)
                continue
            region_rows = [r for el in payload.get("elements", []) if (r := _osm_element_to_row(el))]
            log.info("  %s: %d tagged military features with a name", region, len(region_rows))
            rows.extend(region_rows)
            if i < len(OVERPASS_BBOXES) - 1:
                time.sleep(3)  # be polite to the shared public instance between requests
    return rows


# ------------------------------------------------------------ Wikidata ----

WIKIDATA_URL = "https://query.wikidata.org/sparql"

# our infra type -> (Wikidata class QID, source label)
WIKIDATA_INFRA_CLASSES = {
    "refinery": ("Q12353044", "Wikidata: oil refinery"),
    "nuclear": ("Q134447", "Wikidata: nuclear power plant"),
    "lng_terminal": ("Q15709854", "Wikidata: LNG terminal"),
    "port": ("Q44782", "Wikidata: port"),
    "desalination": ("Q51932686", "Wikidata: desalination plant"),
    "fab": ("Q4168959", "Wikidata: semiconductor fabrication plant"),
}
# our military subtype -> Wikidata class QID
WIKIDATA_MILITARY_CLASSES = {
    "air": "Q695850",       # airbase
    "naval": "Q1324633",    # naval base
    "missile": "Q21193688", # missile base
}

_SPARQL_TMPL = (
    "SELECT ?item ?itemLabel ?coord WHERE {{"
    "  ?item wdt:P31/wdt:P279* wd:{qid} ."
    "  ?item wdt:P625 ?coord ."
    '  FILTER NOT EXISTS {{ ?item wdt:P576 ?dissolved }}'  # skip dissolved/demolished
    '  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}'
    "}} LIMIT {limit}"
)
_WKT_POINT_RE = re.compile(r"Point\(([-\d.]+)\s+([-\d.]+)\)")


def _wikidata_query(qid: str, limit: int = 800) -> list[dict]:
    headers = {"User-Agent": "osint-globe-import/1.0 (one-shot bulk import script)", "Accept": "application/json"}
    query = _SPARQL_TMPL.format(qid=qid, limit=limit)
    with httpx.Client(timeout=60, headers=headers) as client:
        resp = client.get(WIKIDATA_URL, params={"query": query})
        resp.raise_for_status()
        payload = resp.json()
    rows = []
    for b in payload.get("results", {}).get("bindings", []):
        name = b.get("itemLabel", {}).get("value", "")
        # Unlabeled items fall back to their Q-id as the "label" -- not a
        # usable display name, so skip them rather than show "Q11543287".
        if not name or re.fullmatch(r"Q\d+", name):
            continue
        m = _WKT_POINT_RE.match(b.get("coord", {}).get("value", ""))
        if not m:
            continue
        lon, lat = float(m.group(1)), float(m.group(2))
        rows.append({"name": name, "lat": round(lat, 4), "lon": round(lon, 4)})
    return rows


def fetch_wikidata_infra() -> list[dict]:
    rows: list[dict] = []
    for infra_type, (qid, label) in WIKIDATA_INFRA_CLASSES.items():
        log.info("Querying Wikidata for %s (%s) ...", infra_type, qid)
        try:
            hits = _wikidata_query(qid)
        except Exception as exc:  # noqa: BLE001 - public shared endpoint, keep going on failure
            log.warning("  %s: query failed (%s) -- skipping", infra_type, exc)
            continue
        log.info("  %s: %d labeled results with coordinates", infra_type, len(hits))
        for h in hits:
            rows.append({**h, "type": infra_type, "note": f"Source: {label}."})
        time.sleep(2)  # be polite to the shared public endpoint between requests (WDQS rate-limits hard during its frequent outages)
    return rows


def fetch_wikidata_military() -> list[dict]:
    rows: list[dict] = []
    for subtype, qid in WIKIDATA_MILITARY_CLASSES.items():
        log.info("Querying Wikidata for military/%s (%s) ...", subtype, qid)
        try:
            hits = _wikidata_query(qid)
        except Exception as exc:  # noqa: BLE001
            log.warning("  %s: query failed (%s) -- skipping", subtype, exc)
            continue
        log.info("  %s: %d labeled results with coordinates", subtype, len(hits))
        for h in hits:
            rows.append({
                **h, "type": "military", "subtype": subtype,
                "note": f"Source: Wikidata ({subtype} base class). Status/currency not verified -- confirm before relying on this.",
            })
        time.sleep(1)
    return rows


# ------------------------------------------------------------- CSV I/O ----

def _find_column(fieldnames: list[str], *keywords: str) -> str | None:
    for f in fieldnames:
        low = f.lower()
        if any(k in low for k in keywords):
            return f
    return None


def normalize_csv(path: Path, infra_type: str, source_label: str) -> list[dict]:
    """Best-effort normalizer for a GEM/WPI-style CSV: auto-detects the name,
    latitude, longitude, and (optional) status columns by header keyword
    since exact column names vary by dataset release."""
    if not path.exists():
        log.warning("%s: file not found, skipping", path)
        return []

    with path.open(encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        name_col = _find_column(fieldnames, "name", "port")
        lat_col = _find_column(fieldnames, "lat")
        lon_col = _find_column(fieldnames, "lon", "long")
        status_col = _find_column(fieldnames, "status")
        if not (name_col and lat_col and lon_col):
            log.warning(
                "%s: couldn't auto-detect name/lat/lon columns (found: %s) -- skipping",
                path, fieldnames,
            )
            return []

        rows, skipped_status = [], 0
        for row in reader:
            name = (row.get(name_col) or "").strip()
            if not name:
                continue
            try:
                lat, lon = float(row[lat_col]), float(row[lon_col])
            except (ValueError, TypeError, KeyError):
                continue
            if status_col:
                status = (row.get(status_col) or "").lower()
                if any(k in status for k in _STATUS_DROP_KEYWORDS):
                    skipped_status += 1
                    continue
                # If the dataset has a status column but it's not clearly
                # "operating", still keep it -- unlabeled/other statuses are
                # common for smaller sites and dropping them silently would
                # bias the import toward whatever GEM/NGA happened to flag.
            rows.append({
                "name": name, "lat": round(lat, 4), "lon": round(lon, 4),
                "type": infra_type,
                "note": f"Source: {source_label}.",
            })
    log.info("%s: %d rows parsed (%d dropped as retired/cancelled)", path.name, len(rows), skipped_status)
    return rows


# ------------------------------------------------------------- output ----

def render_list(var_name: str, rows: list[dict]) -> str:
    lines = [f"{var_name}: list[dict] = ["]
    for r in rows:
        if r["type"] == "military":
            lines.append(
                f'    {{"id": {r["id"]!r}, "name": {r["name"]!r}, "type": "military", '
                f'"subtype": {r["subtype"]!r}, "lat": {r["lat"]!r}, "lon": {r["lon"]!r}, '
                f'"region_keys": [], "note": {r["note"]!r}}},'
            )
        else:
            lines.append(
                f'    {{"id": {r["id"]!r}, "name": {r["name"]!r}, "type": {r["type"]!r}, '
                f'"lat": {r["lat"]!r}, "lon": {r["lon"]!r}, '
                f'"region_keys": [], "note": {r["note"]!r}}},'
            )
    lines.append("]")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--osm-military", action="store_true", help="fetch military bases live from OSM Overpass")
    ap.add_argument("--wikidata", action="store_true", help="fetch infra sites + military bases live from Wikidata SPARQL")
    ap.add_argument("--gem-refineries", type=Path, help="path to a locally downloaded GEM oil/gas infra CSV")
    ap.add_argument("--gem-lng", type=Path, help="path to a locally downloaded GEM gas infra (LNG) CSV")
    ap.add_argument("--gem-nuclear", type=Path, help="path to a locally downloaded GEM nuclear power tracker CSV")
    ap.add_argument("--wpi", type=Path, help="path to a locally downloaded NGA World Port Index CSV")
    ap.add_argument("--out", type=Path, default=OUT_PATH, help="output .py file (default: backend/infrastructure_imported.py)")
    ap.add_argument("--dedup-radius-km", type=float, default=5.0, help="drop imported entries within this distance of an existing entry")
    args = ap.parse_args()

    if not any([args.osm_military, args.wikidata, args.gem_refineries, args.gem_lng, args.gem_nuclear, args.wpi]):
        ap.error("nothing to do -- pass at least one of --osm-military / --wikidata / --gem-refineries / --gem-lng / --gem-nuclear / --wpi")

    infra_ids, infra_coords = build_dedup_index(INFRA_SITES)
    mil_ids, mil_coords = build_dedup_index(MILITARY_BASES)

    raw_infra: list[dict] = []
    if args.gem_refineries:
        raw_infra += normalize_csv(args.gem_refineries, "refinery", "Global Energy Monitor - Oil & Gas Infrastructure Tracker")
    if args.gem_lng:
        raw_infra += normalize_csv(args.gem_lng, "lng_terminal", "Global Energy Monitor - Global Gas Infrastructure Tracker")
    if args.gem_nuclear:
        raw_infra += normalize_csv(args.gem_nuclear, "nuclear", "Global Energy Monitor - Global Nuclear Power Tracker")
    if args.wpi:
        raw_infra += normalize_csv(args.wpi, "port", "NGA World Port Index (Pub 150)")
    if args.wikidata:
        raw_infra += fetch_wikidata_infra()

    raw_military: list[dict] = []
    if args.osm_military:
        raw_military += fetch_osm_military()
    if args.wikidata:
        raw_military += fetch_wikidata_military()

    def dedup_and_id(raw: list[dict], taken_ids: set[str], coords: list[tuple[float, float]]) -> list[dict]:
        out = []
        for r in raw:
            if is_duplicate(r["lat"], r["lon"], coords, args.dedup_radius_km):
                continue
            r["id"] = unique_id(slugify(r["name"]), taken_ids)
            coords.append((r["lat"], r["lon"]))
            out.append(r)
        return out

    final_infra = dedup_and_id(raw_infra, infra_ids, infra_coords)
    final_military = dedup_and_id(raw_military, mil_ids, mil_coords)

    args.out.write_text(
        '"""Generated by `python -m backend.scripts.import_bulk_infra` -- NOT auto-merged into\n'
        "infrastructure.py. Review each entry (accuracy, region_keys, dedup against the\n"
        "hand-curated lists) before folding into INFRA_SITES / MILITARY_BASES.\n"
        f'Generated at {time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())}.\n"""\n\n'
        + render_list("IMPORTED_INFRA_SITES", final_infra)
        + "\n\n\n"
        + render_list("IMPORTED_MILITARY_BASES", final_military)
        + "\n",
        encoding="utf-8",
    )

    log.info(
        "Wrote %d infra sites + %d military bases (after dedup) -> %s",
        len(final_infra), len(final_military), args.out,
    )


if __name__ == "__main__":
    main()
