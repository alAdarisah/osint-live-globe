"""Infrastructure as OpenStreetMap has it, kept separate from the curated list.

backend/infrastructure.py holds 207 sites whose coordinates a person checked,
and its docstring commits to exactly that. This module adds thousands more from
OpenStreetMap -- military airfields and installations, power plants, border
crossings -- and it is deliberately a *different layer* rather than more entries
in that one. Blending crowd-sourced geometry into a list that promises
human-checked coordinates would quietly break the promise, and every popup here
names OpenStreetMap so a reader always knows which they are looking at.

Scoped to the conflict theatres in backend/regions.py rather than to the world.
That is not a performance shortcut: Overpass is a shared public service with no
key and a real cost per query, and "every power plant on earth" is both a rude
thing to ask it for and a layer nobody can read.

The sweep is one region at a time with a long pause between, and partial results
are published as they arrive -- a full pass takes on the order of twenty minutes
and there is no reason to hold back the first ten regions while the eleventh
runs.

Task 28 adds four more point classes (substations, refineries, storage tanks,
oil/gas wells) to the same point query above, and one more per-region
geometry pass, riding beside the rail-line one Task 27 added: a single
combined `out geom` request per region carrying both power lines
(power=line|cable) and pipelines (man_made=pipeline), each its own named set
so a cap on one can never starve the other -- the same reason the point
sweep's classes are each bound to their own set. Deliberately ONE more
request per region rather than two: Task 27 already roughly doubled a full
pass's running time by adding the rail-line request, and asking Overpass for
a second and third geometry pass on top of that, serially, in the same loop,
would have stacked that cost again. See build_grid_lines_query's own note.
"""

import asyncio
import logging
import time

import httpx

from backend import regions, storage
from backend.cache import registry

log = logging.getLogger("osint-globe.osm_infra")

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Overpass rejects the default `python-httpx/x.y` User-Agent outright with
# 406 Not Acceptable -- every region failed identically until this was set, with
# nothing in the response body to say why. Naming the caller is also simply what
# a shared public service with no key is owed.
USER_AGENT = "osint-live-globe/1.0 (+https://github.com/)"
REFRESH_INTERVAL = 24 * 3600
FAILURE_RETRY_INTERVAL = 600
# Between regions. Overpass asks callers not to run queries back to back, and a
# full sweep has all day to finish.
BETWEEN_REGIONS_SECONDS = 30
# Overpass' own server-side limit, and ours. Generous because some of these
# boxes are 20 degrees across -- and raised from 180 once the rail selectors
# were added: the count-only query for the Russia/Ukraine box already took 260s
# on the 2026-08-06 probe, and a full data query returning the geometry is
# heavier still, so 180 was guaranteeing a 504 on the largest theatres.
QUERY_TIMEOUT = 600
# Per feature class, not per region. The distinction is the whole reason the
# query below is shaped the way it is: with one shared cap over a combined
# result set, Russia/Ukraine came back as 725 border-control nodes, 58 military
# areas and 4 airfields -- one noisy class had starved every other one. A cap
# each gives 132 airfields, 285 military areas, 300 power plants and 300
# crossings from the same box.
MAX_PER_FEATURE = 300
# Rail points get their own, far higher cap. MAX_PER_FEATURE = 300 exists to
# suppress unnamed *fragments* of the noisy area classes; a railway station is a
# discrete, whole feature, not a fragment, so the same cap would silently drop
# 95% of a real layer -- 5,227 of the 5,527 stations in the Russia/Ukraine box
# alone. Thinning a dense layer is the renderer's job (declutter: thin the
# presentation, never delete the data), so the collector keeps all of them. Kept
# as a large explicit ceiling rather than truly uncapped so one pathological box
# can never make us ask a volunteer service for an unbounded result set.
MAX_RAIL_PER_FEATURE = 25000

# Task 27: mainline rail *geometry*, layered under railways.py's coarse
# Natural Earth linework so a reader who wants named lines, operators and
# gauges can have them, without this map losing what it already drew before
# this task -- see railways.py's own module docstring for why "layered
# under a global fallback" is not an accurate way to say that: Natural Earth
# is clipped to these same eleven theatre boxes too, not worldwide.
#
# Queried separately from every selector above, on its own Overpass request,
# because it needs `out geom` -- every vertex of every way -- rather than
# `out center`, the one computed point per feature the rest of this sweep asks
# for. The point classes' caps bound how many *features* come back; a line's
# byte cost is dominated by how many *vertices* each one carries, which no
# feature cap controls, so RAIL_LINE_TIMEOUT and MAX_RAIL_LINE_WAYS below are
# a floor under the risk, not a promise of a small response.
#
# Restricted to railway=rail|light_rail|narrow_gauge -- the lines a train
# actually runs on -- rather than every railway=* value. Sidings, yard leads,
# platform edges and disused/abandoned/proposed/construction track all carry
# the same tag family and are exactly what made railways.py's own docstring
# reject OSM's *full* rail linework as ~300 MB per theatre-scale sweep (186.8
# MB for Russia/Ukraine alone): this selector is the running-line subset of
# that, and is expected to be a small fraction of it -- but it has not been
# measured against a live Overpass instance, so treat a slow or a failed pass
# on the largest theatres (Russia/Ukraine, the Sahel) as expected, not as a
# bug, until an operator has watched a few real sweeps complete.
RAIL_LINE_TIMEOUT = QUERY_TIMEOUT  # the same ceiling the point sweep already leans on
MAX_RAIL_LINE_WAYS = 6000  # a cap on *ways*, not vertices -- see the note above

# What is asked for, the per-record class it becomes, and its cap.
#
# Why each one carries a `["name"]` filter or does not:
#
# `military=airfield` does not: an unnamed military airfield is still an
# airfield, and there are few enough of them that noise is not the risk.
#
# The three area classes do. Without it, `landuse=military` is dominated by
# small unnamed fragments (perimeter strips, individual firing ranges, sheds
# inside a base already mapped) -- 432 of 600 results in one theatre -- and
# `barrier=border_control` by every unnamed gate post along a frontier.
#
# The four rail classes do NOT, and deliberately: a station/halt/yard is a
# discrete whole feature rather than a fragment, so there is no fragment noise
# for a name to filter out -- an unnamed station is a real station and gets the
# fallback label below. `railway=border` is the emphatic case: only 17 of 101
# such nodes in the Russia/Ukraine box carry a name, so a `["name"]` filter
# would discard 83% of them; what they do carry is a UIC or operator ref, which
# _fallback_name reads instead. (Verified zero overlap with barrier=border_control,
# so there is nothing to dedup between the two.)
#
# Bridges and tunnels are deliberately absent: they are secondary tags on rail
# *ways* (15,181 bridge + 2,384 tunnel segments in Russia/Ukraine alone), and
# forcing 40-metre culverts through `out center` would swamp the stations 3:1.
#
# Task 28 adds four more point classes, all discrete whole facilities rather
# than fragments of a larger area (the same distinction MAX_PER_FEATURE's own
# note draws between landuse=military and military=airfield above), so none
# of them carries a `["name"]` filter:
#
# `power=substation` -- a transformer yard is one feature, named or not.
#
# `industrial=refinery` -- there are few enough of these per theatre that
# MAX_PER_FEATURE's noise concern does not apply; it exists mainly so a
# refinery too small or new for backend/infrastructure.py's curated list
# still shows up somewhere, with OpenStreetMap's own caveat attached.
#
# `man_made=storage_tank` and `man_made=petroleum_well` do NOT get
# MAX_PER_FEATURE's 300: a single storage terminal or oil field can carry
# thousands of individual tanks or wellheads, each a real, distinct feature --
# thinning that at the collector would be exactly the "cap that deletes the
# layer" MAX_RAIL_PER_FEATURE's own note already rejected for rail stations.
# MAX_INFRA_POINT_PER_FEATURE is a large explicit ceiling for the same reason
# MAX_RAIL_PER_FEATURE is one (one pathological theatre must never ask a
# volunteer service for an unbounded result set), not a measured figure --
# no live Overpass probe has been run against Ras Tanura or a Gulf oil field
# to see how close to it a real sweep comes. Watch the ingest logs (see
# _capped_kinds below) after the first few real sweeps and raise or split this
# if it turns out to be too small.
MAX_INFRA_POINT_PER_FEATURE = 4000

_FEATURES = (
    ('nwr["military"="airfield"]', "military_airfield", MAX_PER_FEATURE),
    ('nwr["landuse"="military"]["name"]', "military_area", MAX_PER_FEATURE),
    ('nwr["power"="plant"]["name"]', "power_plant", MAX_PER_FEATURE),
    ('nwr["barrier"="border_control"]["name"]', "border_control", MAX_PER_FEATURE),
    ('nwr["railway"="station"]', "railway_station", MAX_RAIL_PER_FEATURE),
    ('nwr["railway"="halt"]', "railway_halt", MAX_RAIL_PER_FEATURE),
    ('nwr["railway"="yard"]', "railway_yard", MAX_RAIL_PER_FEATURE),
    # Node-only: a border marker is a point on the track, never an area.
    ('node["railway"="border"]', "railway_border", MAX_RAIL_PER_FEATURE),
    ('nwr["power"="substation"]', "power_substation", MAX_PER_FEATURE),
    ('nwr["industrial"="refinery"]', "refinery", MAX_PER_FEATURE),
    ('nwr["man_made"="storage_tank"]', "storage_tank", MAX_INFRA_POINT_PER_FEATURE),
    # Node-only: a wellhead is a point, never mapped as an area.
    ('node["man_made"="petroleum_well"]', "oil_well", MAX_INFRA_POINT_PER_FEATURE),
)

_RAILWAY_KINDS = {
    "station": "railway_station",
    "halt": "railway_halt",
    "yard": "railway_yard",
    "border": "railway_border",
}

# plant:source / generator:source is OSM's own free-text fuel field -- rich
# ("gas;oil", "hydro", "waste") rather than a closed set, so this is a
# keyword match against a short, ordered list rather than a dict lookup.
# Order matters where a compound value could match more than one keyword
# (there is no such case among these eight today, but a future OSM value
# like "biomass;coal" would take whichever keyword is checked first).
# "waste" is folded into "biomass" -- waste-to-energy generation is grouped
# with biomass in most public reporting this map's readers already know
# (EIA, IEA), and OSM has no separate `waste` category of its own to place it
# in instead. Anything else -- oil, geothermal, diesel, tidal, and no tag at
# all -- reports "other" rather than a guess: the brief's own list of eight is
# a floor on what gets a distinct glyph, not a closed set of what a plant may
# burn.
_FUEL_KEYWORDS = (
    ("nuclear", "nuclear"),
    ("coal", "coal"),
    ("gas", "gas"),
    ("hydro", "hydro"),
    ("wind", "wind"),
    ("solar", "solar"),
    ("biomass", "biomass"),
    ("waste", "biomass"),
)


def _fuel_category(source_tag: str | None) -> str:
    """OSM's freehand plant:source/generator:source -> one of the map's own
    eight fuel buckets, tested directly since the frontend's glyph picker
    trusts this field rather than re-parsing the raw tag itself."""
    if not source_tag:
        return "other"
    text = source_tag.strip().lower()
    for keyword, category in _FUEL_KEYWORDS:
        if keyword in text:
            return category
    return "other"


def _commissioning_year(value: str | None) -> int | None:
    """OSM's start_date is freehand ("1986", "1986-05", "circa 1970") -- this
    reads only a confident four-digit year prefix and leaves the rest, the
    same "drop rather than guess" rule _megawatts below applies to output_mw.
    """
    if not value:
        return None
    text = value.strip()
    if len(text) >= 4 and text[:4].isdigit():
        year = int(text[:4])
        # A sanity floor/ceiling, not a claim about when generation began --
        # OSM's own date range for this tag runs from real 19th-century hydro
        # plants to "under construction" placeholders a few years out; this
        # only catches a stray non-year numeral (a voltage, an id) that
        # happened to start with four digits.
        if 1850 <= year <= 2100:
            return year
    return None


def build_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region box, capped per feature class.

    Each selector is bound to its own named set and given its own `out`, which
    is what makes the cap per class rather than shared -- and lets the rail
    classes carry a far higher cap than the noisy area classes (see
    MAX_RAIL_PER_FEATURE vs MAX_PER_FEATURE).

    `out center` is the other load-bearing part: an area has no coordinate of
    its own, and this asks Overpass to compute one rather than shipping every
    node of every polygon back for us to average.
    """
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    sets = [f".s{i}" for i in range(len(_FEATURES))]
    selectors = "\n".join(
        f"{selector}{bbox}->{setname};"
        for setname, (selector, _kind, _cap) in zip(sets, _FEATURES)
    )
    outputs = "\n".join(
        f"{setname} out center tags {cap};"
        for setname, (_selector, _kind, cap) in zip(sets, _FEATURES)
    )
    return f"[out:json][timeout:{QUERY_TIMEOUT}];\n{selectors}\n{outputs}"


def _kind_of(tags: dict) -> str | None:
    if tags.get("military") == "airfield":
        return "military_airfield"
    if tags.get("landuse") == "military":
        return "military_area"
    if tags.get("power") == "plant":
        return "power_plant"
    if tags.get("barrier") == "border_control":
        return "border_control"
    railway = tags.get("railway")
    if railway in _RAILWAY_KINDS:
        return _RAILWAY_KINDS[railway]
    if tags.get("power") == "substation":
        return "power_substation"
    if tags.get("industrial") == "refinery":
        return "refinery"
    if tags.get("man_made") == "storage_tank":
        return "storage_tank"
    if tags.get("man_made") == "petroleum_well":
        return "oil_well"
    return None


_KIND_FALLBACK_NAME = {
    "military_airfield": "Military airfield",
    "military_area": "Military area",
    "power_plant": "Power plant",
    "border_control": "Border crossing",
    "railway_station": "Railway station",
    "railway_halt": "Railway halt",
    "railway_yard": "Railway yard",
    "railway_border": "Railway border crossing",
    "power_substation": "Substation",
    "refinery": "Refinery",
    "storage_tank": "Storage tank",
    "oil_well": "Oil/gas well",
}


def _fallback_name(kind: str, tags: dict) -> str:
    """A label for a feature OSM left unnamed.

    A plain lookup for every class but `railway=border`, which is the one class
    here that is routinely unnamed yet still identifiable: it carries a UIC
    station reference (`uic_ref`) or an operator's own ref (`ref:RO:CFR`,
    `railway:ref`, ...). Preferring those over the generic "Railway border
    crossing" is what keeps the 83% of border nodes that have no `name` from all
    reading identically on the map.
    """
    if kind == "railway_border":
        uic = tags.get("uic_ref")
        if uic:
            return f"UIC {uic}"
        for key, value in tags.items():
            if value and (key == "ref" or key.startswith("ref:") or key.endswith(":ref")):
                return str(value)
    return _KIND_FALLBACK_NAME[kind]


def parse_overpass(payload: dict, region_key: str) -> list[dict]:
    """An Overpass response -> records.

    Nodes carry lat/lon directly; ways and relations carry a computed `center`
    (see build_query). An element with neither is dropped rather than placed.
    """
    out: list[dict] = []
    for element in (payload or {}).get("elements") or []:
        tags = element.get("tags") or {}
        kind = _kind_of(tags)
        if not kind:
            continue
        center = element.get("center") or {}
        lat = element.get("lat", center.get("lat"))
        lon = element.get("lon", center.get("lon"))
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        osm_type = element.get("type")
        osm_id = element.get("id")
        if not osm_type or osm_id is None:
            continue
        out.append({
            # Prefixed so an OSM id can never collide with a curated site's id.
            "id": f"osm:{osm_type}/{osm_id}",
            "osm_type": osm_type,
            "osm_id": osm_id,
            "kind": kind,
            "lat": float(lat),
            "lon": float(lon),
            "name": tags.get("name") or tags.get("name:en") or _fallback_name(kind, tags),
            "named": bool(tags.get("name") or tags.get("name:en")),
            "operator": tags.get("operator"),
            # power=plant carries its own detail worth keeping; the rest do not.
            "source_tag": tags.get("plant:source") or tags.get("generator:source"),
            "output_mw": _megawatts(tags.get("plant:output:electricity")),
            # Task 28: only meaningful for power_plant, but computed for every
            # kind rather than branched on it -- _fuel_category("other" for a
            # missing tag) and _commissioning_year(None -> None) are both total
            # functions, so there is no dead-record case to special-case around.
            "fuel": _fuel_category(tags.get("plant:source") or tags.get("generator:source")),
            "commissioning_year": _commissioning_year(tags.get("start_date")),
            "region_key": region_key,
        })
    return out


def _megawatts(value: str | None) -> float | None:
    """"1200 MW" / "800000000 W" -> megawatts, or None.

    OSM writes this field freehand and most of the time it is unparseable; a
    number we cannot read is left out rather than guessed at.
    """
    if not value:
        return None
    text = value.strip().upper().replace(" ", "")
    try:
        if text.endswith("MW"):
            return float(text[:-2])
        if text.endswith("GW"):
            return float(text[:-2]) * 1000
        if text.endswith("KW"):
            return float(text[:-2]) / 1000
        if text.endswith("W"):
            return float(text[:-1]) / 1_000_000
    except ValueError:
        return None
    return None


def _capped_point_kinds(payload: dict) -> set[str]:
    """Which of the point sweep's per-class caps (_FEATURES) this region's
    raw response looks like it hit -- the same >= cap heuristic
    _ways_truncated uses for a line response, generalised to a query that
    carries several classes in one payload instead of one.

    Review note (Task 28, Important 2): MAX_INFRA_POINT_PER_FEATURE (4000,
    for storage_tank/petroleum_well) is an unmeasured judgment call, in the
    same file where every *line* cap already gets this treatment -- this is
    the log-and-flag half of that for every point class, including the four
    original ones (military_airfield/military_area/power_plant/
    border_control), which never had it either. Not wired to a served API
    field or a map note -- doing that would mean reshaping
    /api/osm-infrastructure's flat array into a wrapped document, judged out
    of scope for this pass (see the module's own review notes) -- so this is
    visibility for an operator reading logs, not yet a reader-facing one.

    Counted from the raw tags rather than from parse_overpass's output: an
    element parse_overpass drops (no usable position) would otherwise make a
    genuinely-capped class look like it stayed under its cap.
    """
    caps = {kind: cap for _selector, kind, cap in _FEATURES}
    counts: dict[str, int] = {}
    for element in (payload or {}).get("elements") or []:
        kind = _kind_of(element.get("tags") or {})
        if kind:
            counts[kind] = counts.get(kind, 0) + 1
    return {kind for kind, cap in caps.items() if counts.get(kind, 0) >= cap}


async def _fetch_region(client: httpx.AsyncClient, key: str, bounds) -> list[dict]:
    resp = await client.post(OVERPASS_URL, content=build_query(bounds).encode("utf-8"))
    # Overpass answers "too busy" with 429 and "you exceeded the timeout" with
    # 504, and both are ordinary states on a free shared service rather than
    # faults. Either just means this region keeps whatever it had.
    if resp.status_code in (429, 504):
        raise RuntimeError(f"Overpass busy ({resp.status_code}) for region {key}")
    resp.raise_for_status()
    payload = resp.json()
    capped = _capped_point_kinds(payload)
    if capped:
        log.warning(
            "OSM infrastructure: %s hit its per-class cap in %s -- results are partial for those classes there",
            sorted(capped), key,
        )
    return parse_overpass(payload, key)


def build_rail_line_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region box's mainline rail geometry.

    One selector, one `out geom` -- unlike build_query above there is nothing
    to union, because this asks for exactly one feature class. `out geom`
    (rather than `out center`) is the point of this query: it returns every
    vertex of every matched way, which is what a polyline needs and a point
    sweep never does.
    """
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    return (
        f"[out:json][timeout:{RAIL_LINE_TIMEOUT}];\n"
        f'way["railway"~"^(rail|light_rail|narrow_gauge)$"]{bbox};\n'
        f"out geom tags {MAX_RAIL_LINE_WAYS};"
    )


def parse_rail_lines(payload: dict, region_key: str) -> list[dict]:
    """An Overpass rail-line response -> attributed [lat, lon] line records.

    `out geom` gives each way its own list of {lat, lon} vertices -- geometry,
    not the `center` the point sweep above reads -- so this is its own parse
    rather than a branch of parse_overpass. A way with fewer than two usable
    vertices is not a line and is dropped, the same rule railways.py's own
    theatre clip applies to Natural Earth's runs. Every record is tagged
    source="osm" here, at the point of collection, so railways.py never has to
    guess provenance back out of the shape of the data -- see its own
    serialize(), which does the same for the Natural Earth half.
    """
    out: list[dict] = []
    for element in (payload or {}).get("elements") or []:
        if element.get("type") != "way":
            continue
        path = [
            [pt["lat"], pt["lon"]]
            for pt in (element.get("geometry") or [])
            if isinstance(pt, dict)
            and isinstance(pt.get("lat"), (int, float))
            and isinstance(pt.get("lon"), (int, float))
        ]
        if len(path) < 2:
            continue
        way_id = element.get("id")
        if way_id is None:
            continue
        tags = element.get("tags") or {}
        out.append({
            # Prefixed so an OSM way id can never collide with anything else
            # riding this document -- same convention parse_overpass uses.
            "id": f"osm:way/{way_id}",
            "source": "osm",
            "path": path,
            "name": tags.get("name") or tags.get("name:en"),
            "operator": tags.get("operator"),
            "gauge": tags.get("gauge"),
            "electrified": tags.get("electrified"),
            "usage": tags.get("usage"),
            "service": tags.get("service"),
            "railway": tags.get("railway"),
            "region_key": region_key,
        })
    return out


def _ways_truncated(payload: dict, cap: int) -> bool:
    """Whether a single-class `out geom` response looks like it hit `cap`
    rather than genuinely running out of matching ways.

    Overpass's `out ... N;` silently stops at N with no truncation marker of
    its own -- a capped response and a complete one that happens to have
    fewer ways than the cap are otherwise indistinguishable. Comparing the
    raw element count against the cap is the only signal available, and it is
    a heuristic rather than a certainty: a theatre with *exactly* `cap` ways
    would be flagged as capped when it is not. That false positive is the
    safe side to be wrong on -- the alternative (treating >= the cap as
    "probably complete") is the one that lets a genuinely truncated
    Russia/Ukraine sweep look identical to a full one, which is the exact
    failure this exists to catch.

    Task 27 introduced this check for the rail-line pass alone; Task 28
    reuses it rather than writing a second version for power lines and
    pipelines -- see _rail_lines_truncated and _grid_lines_truncated below,
    both now thin wrappers over this.
    """
    return len((payload or {}).get("elements") or []) >= cap


def _rail_lines_truncated(payload: dict) -> bool:
    return _ways_truncated(payload, MAX_RAIL_LINE_WAYS)


async def _fetch_rail_lines(client: httpx.AsyncClient, key: str, bounds) -> tuple[list[dict], bool]:
    """The parsed lines, and whether this region's response looks capped."""
    resp = await client.post(OVERPASS_URL, content=build_rail_line_query(bounds).encode("utf-8"))
    if resp.status_code in (429, 504):
        raise RuntimeError(f"Overpass busy ({resp.status_code}) for rail lines in {key}")
    resp.raise_for_status()
    payload = resp.json()
    return parse_rail_lines(payload, key), _rail_lines_truncated(payload)


def flatten_rail_lines(by_region: dict[str, list[dict]]) -> list[dict]:
    """Every theatre's rail lines as one list, deduplicated by OSM way id.

    Same reasoning as flatten() above: the theatre boxes in regions.py overlap,
    so a way inside an overlap would otherwise be counted, and drawn, once per
    box that swept it.
    """
    seen: dict[str, dict] = {}
    for lines in by_region.values():
        for line in lines:
            seen.setdefault(line["id"], line)
    return list(seen.values())


def serialize_rail_lines(lines: list[dict], truncated_regions: list[str] | None = None) -> dict:
    """The stored document railways.py reads back and merges with Natural Earth.

    Same shape discipline as railways.py's own serialize(): a provenance
    string meant for the popup, not just a bag of lines. `truncated_regions`
    is carried through so a reader looking at, say, Russia/Ukraine sees a
    stated reason the network looks thinner than it is, the same way
    zoomNotes.capped already tells a reader a band cap thinned a point layer
    rather than letting a partial view read as a complete one.
    """
    return {
        "attribution": "OpenStreetMap contributors",
        "provenance": "OpenStreetMap Overpass, railway=rail|light_rail|narrow_gauge, swept daily across the conflict theatres",
        "lines": lines,
        "truncated_regions": sorted(truncated_regions or []),
    }


# Task 28: transmission lines and pipelines, in one combined per-region
# `out geom` request rather than two separate ones -- see the module
# docstring's own note on why. Each class is bound to its own named set with
# its own `out geom tags N`, the same per-class-cap discipline build_query
# uses for the point sweep, so a dense pipeline network can never crowd out
# the power grid in the same box or the reverse.
MAX_POWER_LINE_WAYS = 6000  # same order of magnitude and the same unmeasured judgment call as MAX_RAIL_LINE_WAYS
MAX_PIPELINE_WAYS = 6000
GRID_LINE_TIMEOUT = QUERY_TIMEOUT  # the same ceiling the point and rail-line sweeps already lean on

_GRID_LINE_FEATURES = (
    # power=cable is the same physical thing as power=line, laid underground
    # or subsea instead of strung on towers -- one selector for both, the way
    # railway.py's own "rail|light_rail|narrow_gauge" alternation reads.
    ('way["power"~"^(line|cable)$"]', "power"),
    ('way["man_made"="pipeline"]', "pipeline"),
)


def build_grid_lines_query(bounds: tuple[float, float, float, float]) -> str:
    """Overpass QL for one region's transmission-line and pipeline geometry,
    in a single request -- see MAX_POWER_LINE_WAYS's own note on why this is
    one query with two named sets rather than two separate requests."""
    south, west, north, east = bounds
    bbox = f"({south},{west},{north},{east})"
    caps = {"power": MAX_POWER_LINE_WAYS, "pipeline": MAX_PIPELINE_WAYS}
    sets = [f".g{i}" for i in range(len(_GRID_LINE_FEATURES))]
    selectors = "\n".join(
        f"{selector}{bbox}->{setname};"
        for setname, (selector, _cls) in zip(sets, _GRID_LINE_FEATURES)
    )
    outputs = "\n".join(
        f"{setname} out geom tags {caps[cls]};"
        for setname, (_selector, cls) in zip(sets, _GRID_LINE_FEATURES)
    )
    return f"[out:json][timeout:{GRID_LINE_TIMEOUT}];\n{selectors}\n{outputs}"


def _grid_line_class(tags: dict) -> str | None:
    if tags.get("power") in ("line", "cable"):
        return "power"
    if tags.get("man_made") == "pipeline":
        return "pipeline"
    return None


def _parse_line_way(element: dict) -> tuple[str, list[list[float]], dict] | None:
    """The shared shape every `out geom` way parse needs: an id, a [lat, lon]
    path with at least two usable vertices, and the raw tags -- factored out
    so parse_grid_lines does not repeat parse_rail_lines' own vertex-reading
    loop for two more classes."""
    if element.get("type") != "way":
        return None
    path = [
        [pt["lat"], pt["lon"]]
        for pt in (element.get("geometry") or [])
        if isinstance(pt, dict)
        and isinstance(pt.get("lat"), (int, float))
        and isinstance(pt.get("lon"), (int, float))
    ]
    if len(path) < 2:
        return None
    way_id = element.get("id")
    if way_id is None:
        return None
    return f"osm:way/{way_id}", path, (element.get("tags") or {})


def parse_grid_lines(payload: dict, region_key: str) -> tuple[list[dict], list[dict]]:
    """One combined Overpass response -> (power lines, pipelines), each an
    attributed [lat, lon] line record. Split by tag rather than by which
    named set an element rode back on -- Overpass's `out` does not label an
    element with the set that produced it, only the union of everything asked
    for, so the tags themselves are the only way to tell the two apart.
    """
    power_lines: list[dict] = []
    pipelines: list[dict] = []
    for element in (payload or {}).get("elements") or []:
        parsed = _parse_line_way(element)
        if parsed is None:
            continue
        way_id, path, tags = parsed
        cls = _grid_line_class(tags)
        if cls == "power":
            power_lines.append({
                "id": way_id,
                "source": "osm",
                "path": path,
                "name": tags.get("name") or tags.get("name:en"),
                "operator": tags.get("operator"),
                "voltage": tags.get("voltage"),
                "cables": tags.get("cables"),
                "frequency": tags.get("frequency"),
                "region_key": region_key,
            })
        elif cls == "pipeline":
            pipelines.append({
                "id": way_id,
                "source": "osm",
                "path": path,
                "name": tags.get("name") or tags.get("name:en"),
                "operator": tags.get("operator"),
                "substance": tags.get("substance"),
                "diameter": tags.get("diameter"),
                "region_key": region_key,
            })
    return power_lines, pipelines


def _grid_lines_truncated(payload: dict) -> set[str]:
    """Which of "power"/"pipeline" looks capped in this region's combined
    response -- see _ways_truncated's own note on the mechanism this reuses.
    Per-class rather than per-response, because the two classes share one
    query but not one cap: a dense pipeline network hitting MAX_PIPELINE_WAYS
    says nothing about whether the power grid in the same box did too.
    """
    counts: dict[str, int] = {}
    for element in (payload or {}).get("elements") or []:
        if element.get("type") != "way":
            continue
        cls = _grid_line_class(element.get("tags") or {})
        if cls:
            counts[cls] = counts.get(cls, 0) + 1
    caps = {"power": MAX_POWER_LINE_WAYS, "pipeline": MAX_PIPELINE_WAYS}
    return {cls for cls, cap in caps.items() if counts.get(cls, 0) >= cap}


async def _fetch_grid_lines(
    client: httpx.AsyncClient, key: str, bounds
) -> tuple[list[dict], list[dict], set[str]]:
    """(power lines, pipelines, which of the two classes looks capped) for one region."""
    resp = await client.post(OVERPASS_URL, content=build_grid_lines_query(bounds).encode("utf-8"))
    if resp.status_code in (429, 504):
        raise RuntimeError(f"Overpass busy ({resp.status_code}) for grid lines in {key}")
    resp.raise_for_status()
    payload = resp.json()
    power_lines, pipelines = parse_grid_lines(payload, key)
    return power_lines, pipelines, _grid_lines_truncated(payload)


def flatten_power_lines(by_region: dict[str, list[dict]]) -> list[dict]:
    """Same overlap-dedup as flatten_rail_lines, for the power-line half."""
    seen: dict[str, dict] = {}
    for lines in by_region.values():
        for line in lines:
            seen.setdefault(line["id"], line)
    return list(seen.values())


def flatten_pipelines(by_region: dict[str, list[dict]]) -> list[dict]:
    """Same overlap-dedup as flatten_rail_lines, for the pipeline half."""
    seen: dict[str, dict] = {}
    for lines in by_region.values():
        for line in lines:
            seen.setdefault(line["id"], line)
    return list(seen.values())


def serialize_power_lines(lines: list[dict], truncated_regions: list[str] | None = None) -> dict:
    """The stored document power_lines.py reads back and republishes as-is --
    there is no Natural-Earth-style fallback to merge with for the grid, so
    this document is served close to verbatim rather than merged like
    railways.py's own serialize()."""
    return {
        "attribution": "OpenStreetMap contributors",
        "provenance": (
            "OpenStreetMap Overpass, power=line|cable, swept daily across this map's eleven "
            "conflict theatres, not worldwide."
        ),
        "lines": lines,
        "truncated_regions": sorted(truncated_regions or []),
    }


def serialize_pipelines(lines: list[dict], truncated_regions: list[str] | None = None) -> dict:
    """The stored document backend/infrastructure.py's endpoint merges with
    the curated PIPELINE_ROUTES fallback."""
    return {
        "attribution": "OpenStreetMap contributors",
        "provenance": (
            "OpenStreetMap Overpass, man_made=pipeline, swept daily across this map's eleven "
            "conflict theatres, not worldwide -- outside them only the curated schematic routes apply."
        ),
        "lines": lines,
        "truncated_regions": sorted(truncated_regions or []),
    }


def flatten(by_region: dict[str, list[dict]]) -> list[dict]:
    """Every theatre's sites as one list, deduplicated by OSM id.

    The theatres in regions.py overlap -- Taiwan Strait sits inside the South
    China Sea box, Sudan inside the Sahel's eastern edge -- so a feature in an
    overlap is returned by both sweeps under two different `region_key`s. The
    map collapses them anyway (its marker map is keyed by id), but the layer's
    own count would report 529 sites where 514 are drawn, which reads as a bug
    in the renderer rather than as what it is.

    First sweep wins, so a feature keeps the theatre that found it first rather
    than flipping between them from poll to poll.
    """
    seen: dict[str, dict] = {}
    for sites in by_region.values():
        for site in sites:
            seen.setdefault(site["id"], site)
    return list(seen.values())


def _regions_to_sweep() -> list[tuple[str, tuple]]:
    return [
        (key, entry["bounds"])
        for key, entry in regions.REGIONS.items()
        if entry.get("bounds")
    ]


async def _warm(state) -> dict[str, list[dict]]:
    """Seed the per-theatre map from storage, so a sweep never shrinks the layer.

    This is the slowest source here by a wide margin -- a full pass is ~20
    minutes of rate-limited Overpass queries, refreshed daily, and Overpass
    times out often enough that a boot can leave the layer empty for the rest
    of the day. Seeding `by_region` rather than just `state.data` is what makes
    that safe: each theatre is replaced only when its own sweep succeeds, so
    publishing after the first region can't drop the other twelve.
    """
    stored = await storage.entity_latest("osm_infra")
    if not stored:
        return {}
    by_region: dict[str, list[dict]] = {}
    for site in stored:
        by_region.setdefault(site.get("region_key") or "", []).append(site)
    state.data = flatten(by_region)
    log.info(
        "OSM infrastructure: warmed %d stored sites across %d theatres while the sweep runs",
        len(state.data), len(by_region),
    )
    return by_region


async def _warm_rail_lines() -> tuple[dict[str, list[dict]], set[str]]:
    """Seed the rail-line per-theatre map (and its truncation flags) from
    storage, for the same reason _warm above seeds the point one: without it,
    publishing after the first region of a fresh sweep would shrink the
    merged railways.py document from however many theatres the previous
    sweep covered down to one, for as long as the rest of this (now heavier,
    see RAIL_LINE_TIMEOUT's note) sweep takes to catch back up. The same
    applies to a region's own "capped" flag -- a theatre that hit
    MAX_RAIL_LINE_WAYS last pass should still say so until this pass has
    actually re-swept it, not go quiet the moment the process restarts.

    No registry state to fill here -- unlike the point sweep, nothing in this
    process serves rail lines directly; railways.py reads the stored document
    back in the backend process. So this only has to rebuild `by_region` and
    the truncated-region set.
    """
    stored = (await storage.reference("railways_osm")) or {}
    lines = stored.get("lines") or []
    truncated = set(stored.get("truncated_regions") or [])
    if not lines:
        return {}, truncated
    by_region: dict[str, list[dict]] = {}
    for line in lines:
        by_region.setdefault(line.get("region_key") or "", []).append(line)
    log.info(
        "OSM rail lines: warmed %d stored ways across %d theatres while the sweep runs",
        len(lines), len(by_region),
    )
    return by_region, truncated


async def _warm_grid_lines(reference_name: str) -> tuple[dict[str, list[dict]], set[str]]:
    """Same warm-before-first-sweep seeding as _warm_rail_lines, generalised
    to whichever of "power_lines_osm"/"pipelines_osm" the caller names --
    both documents have the identical {lines, truncated_regions} shape (see
    serialize_power_lines/serialize_pipelines), so one function reads either.
    """
    stored = (await storage.reference(reference_name)) or {}
    lines = stored.get("lines") or []
    truncated = set(stored.get("truncated_regions") or [])
    if not lines:
        return {}, truncated
    by_region: dict[str, list[dict]] = {}
    for line in lines:
        by_region.setdefault(line.get("region_key") or "", []).append(line)
    log.info(
        "OSM grid lines (%s): warmed %d stored ways across %d theatres while the sweep runs",
        reference_name, len(lines), len(by_region),
    )
    return by_region, truncated


async def sweep_forever():
    """Overpass sweeps, for the life of the ingest process.

    Not a scheduled job like the other ingest sources, for two reasons that both
    live in the loop below: a full pass takes ~20 minutes and publishes each
    theatre as it lands rather than at the end, and a failed pass lengthens its
    own retry (FAILURE_RETRY_INTERVAL scaled by consecutive failures). A fixed
    interval would either start a second sweep on top of a running one or throw
    that adaptive retry away -- and Overpass is a volunteer service that asks
    callers not to do either.
    """
    state = registry.ensure("osm_infra", key_configured=True)  # no key required
    # Per region, so one theatre failing keeps its previous copy instead of
    # blanking while the rest of the sweep continues.
    by_region: dict[str, list[dict]] = {}
    # Task 27: the rail-line pass rides the same per-region loop below (see the
    # comment there for why), so it gets the same warm-before-first-sweep
    # treatment as the point pass, and for the identical reason.
    rail_lines_by_region: dict[str, list[dict]] = {}
    # Which theatres' most recent rail-line fetch looked capped at
    # MAX_RAIL_LINE_WAYS (see _rail_lines_truncated) -- carried into the
    # stored document so a reader sees a stated reason a dense theatre's
    # network looks thinner than it is, rather than a silent partial view.
    rail_lines_truncated: set[str] = set()
    # Task 28: the combined power-line/pipeline pass, warmed the same way and
    # for the same reason as the rail-line pass above.
    power_lines_by_region: dict[str, list[dict]] = {}
    power_lines_truncated: set[str] = set()
    pipelines_by_region: dict[str, list[dict]] = {}
    pipelines_truncated: set[str] = set()
    if await storage.wait_for_warm_pool():
        by_region = await _warm(state)
        rail_lines_by_region, rail_lines_truncated = await _warm_rail_lines()
        power_lines_by_region, power_lines_truncated = await _warm_grid_lines("power_lines_osm")
        pipelines_by_region, pipelines_truncated = await _warm_grid_lines("pipelines_osm")
    consecutive_failures = 0
    while True:
        swept = 0
        rail_lines_swept = 0
        grid_lines_swept = 0
        started = time.time()
        try:
            async with httpx.AsyncClient(
                timeout=QUERY_TIMEOUT + 30, follow_redirects=True, headers={"User-Agent": USER_AGENT}
            ) as client:
                for i, (key, bounds) in enumerate(_regions_to_sweep()):
                    if i:
                        await asyncio.sleep(BETWEEN_REGIONS_SECONDS)
                    # This `continue` is the head of a chain: it skips the
                    # rail-line and grid-line fetches below for this region
                    # too, since both sit later in the same per-region loop
                    # body. See the rail-line block's own note (Minor 2, Task
                    # 28 review) for what that means for a region whose point
                    # fetch alone fails.
                    try:
                        by_region[key] = await _fetch_region(client, key, bounds)
                        swept += 1
                    except Exception as exc:  # noqa: BLE001 - one region is not the sweep
                        log.warning("OSM infrastructure fetch failed for %s: %s", key, exc)
                        continue
                    # Published as the sweep goes rather than at the end: a full
                    # pass takes ~20 minutes and there is no reason to withhold
                    # the first ten theatres while the eleventh runs.
                    state.data = flatten(by_region)
                    state.last_success = time.time()
                    state.last_error = None

                    # The rail-line pass for the same region, right after its
                    # point pass and before the next region's pause -- one more
                    # Overpass request per theatre rather than a second sweep
                    # pacing itself independently against the same server. Its
                    # own try/except: a rail-line timeout on a hard theatre
                    # (see RAIL_LINE_TIMEOUT's note) must cost that region only
                    # its lines, never its points, and must not stop the sweep
                    # moving on to the next theatre.
                    #
                    # This request can itself stall for up to RAIL_LINE_TIMEOUT
                    # (600s), and because it sits inside this same serial loop,
                    # a stall here delays every theatre later in *this pass*,
                    # not just this one's own freshness -- the pause before the
                    # next region only starts once this call returns. Bounded
                    # (worst case ~11 x 600s for one pass) and non-corrupting
                    # (each theatre still only ever overwrites its own entry),
                    # but worth knowing before reading a slow pass as a stuck one.
                    #
                    # Review note (Minor 2): this `continue` exits the *outer*
                    # per-region loop, not just this block -- so a rail-line
                    # failure here also skips the grid-line fetch below for
                    # this same region, this same pass. Inherited from the
                    # points-to-rail coupling Task 27 already had (a failed
                    # point fetch already skipped the rail-line fetch the same
                    # way) rather than introduced fresh here, and the effect is
                    # the same in both cases: that region's grid lines keep
                    # whatever a previous successful pass left in
                    # power_lines_by_region/pipelines_by_region (stale, not
                    # emptied) until a later pass re-reaches it. Worth knowing
                    # before adding a fourth per-region stage after this one --
                    # it inherits the same coupling unless restructured.
                    try:
                        lines, truncated = await _fetch_rail_lines(client, key, bounds)
                        rail_lines_by_region[key] = lines
                        if truncated:
                            rail_lines_truncated.add(key)
                        else:
                            rail_lines_truncated.discard(key)
                        rail_lines_swept += 1
                    except Exception as exc:  # noqa: BLE001 - one theatre's lines are not the sweep
                        log.warning("OSM rail lines fetch failed for %s: %s", key, exc)
                        continue
                    # Published per region like the points above. railways.py
                    # (a different process) reads this document back on its own
                    # clock and merges it with Natural Earth -- there is no
                    # registry state to update here, only the stored copy.
                    await storage.record_reference(
                        "railways_osm",
                        serialize_rail_lines(
                            flatten_rail_lines(rail_lines_by_region), sorted(rail_lines_truncated)
                        ),
                    )

                    # Task 28: the combined power-line/pipeline pass for the
                    # same region, right after the rail-line one -- one more
                    # Overpass request per theatre, not two, per the module
                    # docstring's note on why the two classes share a query.
                    # Its own try/except for the identical reason the rail-line
                    # block's has one: a stall here must cost this region only
                    # its grid lines, never its points or its rail lines, and
                    # must not stop the sweep moving to the next theatre.
                    try:
                        power_lines, pipeline_lines, capped = await _fetch_grid_lines(client, key, bounds)
                        power_lines_by_region[key] = power_lines
                        pipelines_by_region[key] = pipeline_lines
                        if "power" in capped:
                            power_lines_truncated.add(key)
                        else:
                            power_lines_truncated.discard(key)
                        if "pipeline" in capped:
                            pipelines_truncated.add(key)
                        else:
                            pipelines_truncated.discard(key)
                        grid_lines_swept += 1
                    except Exception as exc:  # noqa: BLE001 - one theatre's grid lines are not the sweep
                        log.warning("OSM grid lines fetch failed for %s: %s", key, exc)
                        continue
                    # Published per region, same as the rail-line document --
                    # power_lines.py and backend/infrastructure.py's endpoint
                    # (two different, unrelated readers) each pick up their own
                    # document on their own clock, in a different process.
                    await storage.record_reference(
                        "power_lines_osm",
                        serialize_power_lines(
                            flatten_power_lines(power_lines_by_region), sorted(power_lines_truncated)
                        ),
                    )
                    await storage.record_reference(
                        "pipelines_osm",
                        serialize_pipelines(
                            flatten_pipelines(pipelines_by_region), sorted(pipelines_truncated)
                        ),
                    )
            if swept:
                log.info(
                    "OSM infrastructure: %d sites across %d/%d theatres in %ds",
                    len(state.data), swept, len(_regions_to_sweep()), round(time.time() - started),
                )
                await storage.record_snapshot("osm_infra", state.data, id_field="id")
                await storage.record_source_health("osm_infra", len(state.data), True)
            else:
                raise RuntimeError("no theatre returned data")
            # Rail lines are additive to the point sweep's own pass/fail verdict
            # above, deliberately: a hard theatre timing out on the (heavier,
            # unbounded-by-vertex-count) line query must not turn a healthy
            # point sweep red. A systemic line failure is still visible -- just
            # as a falling item_count on railways.py's own "railways" health
            # row in the backend, once the merged document stops growing --
            # rather than as a second health row here. See this function's own
            # module-level note on RAIL_LINE_TIMEOUT for why that trade was made.
            if rail_lines_swept:
                log.info(
                    "OSM rail lines: %d ways across %d/%d theatres in %ds%s",
                    len(flatten_rail_lines(rail_lines_by_region)), rail_lines_swept,
                    len(_regions_to_sweep()), round(time.time() - started),
                    f" -- capped at {MAX_RAIL_LINE_WAYS}: {sorted(rail_lines_truncated)}"
                    if rail_lines_truncated else "",
                )
            else:
                log.warning("OSM rail lines: no theatre returned any this pass")
            # Same additive treatment as the rail-line block above, and the
            # same reason: a hard theatre's grid-line pass timing out must not
            # turn a healthy point sweep red. power_lines.py's own "power_lines"
            # health row and backend/infrastructure.py's served pipeline count
            # are where a systemic failure here would actually become visible.
            if grid_lines_swept:
                log.info(
                    "OSM grid lines: %d power lines, %d pipelines across %d/%d theatres in %ds%s",
                    len(flatten_power_lines(power_lines_by_region)),
                    len(flatten_pipelines(pipelines_by_region)),
                    grid_lines_swept, len(_regions_to_sweep()), round(time.time() - started),
                    f" -- capped: power {sorted(power_lines_truncated)}, pipeline {sorted(pipelines_truncated)}"
                    if (power_lines_truncated or pipelines_truncated) else "",
                )
            else:
                log.warning("OSM grid lines: no theatre returned any this pass")
        except Exception as exc:  # noqa: BLE001 - keep the poller alive
            state.last_error = str(exc)
            log.warning("OSM infrastructure sweep failed: %s", exc)
            await storage.record_source_health("osm_infra", None, False, str(exc))
        consecutive_failures = 0 if swept else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if swept
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
