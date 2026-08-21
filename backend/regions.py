"""Shared region registry: quick-nav camera targets that double as backend
payload filters. Both the frontend's region bar and the /api/* endpoints'
`region=` query param read from REGIONS, so the two can never drift apart --
add a region here and it shows up as a button *and* as a valid filter.

Bounds are (south, west, north, east) in degrees. "world" (and any unknown
key) means "no filter" -- the caller gets the full global dataset, same as
before this feature existed.

**CountryIndex, at the bottom of this file**, is the other kind of spatial
work this module holds: not a fixed camera box but a real point-in-country
test over the countries GeoJSON (backend/sources/countries.py). There is no
PostGIS in this project (see the global "plain columns plus Python"
constraint), and frontend/src/map/countryHitTest.js already had to solve the
identical problem for the map's own click/hover hit-testing -- so this is a
direct Python port of that file's pointInRing/ringArea/countryContainsPoint,
not a second algorithm invented for the backend. Keeping the two in step
matters: a point either side of this map calls "inside France" should always
be the same point.

`CountryIndex.nearest_country` is the fallback `country_at` itself does not
attempt: backend/sources/cables.py's own docstring warns that TeleGeography's
geometry is "schematic rather than survey-accurate", and a cable landing
point is drawn at the coast rather than surveyed onto it -- so a real,
correctly-named landing can sit a short distance seaward of Natural Earth's
own 1:50m coastline and miss every polygon's ray cast outright. Measured
against Task 38's own landing set: a strict `country_at` alone left roughly
a third of all real (non-planned) landings unmatched, most of them exactly
this case (Aden, Ajaccio, Al Faw -- real cities on a real coast, just outside
the drawn line). `nearest_country` snaps a near-miss to the closest country
within a short radius, the same "coastal snap" judgement call
naval_presence.py's own PORT_MATCH_RADIUS_KM already makes for AIS positions
near a port.
"""

import math

from backend.sources.proximity import EARTH_RADIUS_KM

Bounds = tuple[float, float, float, float]

REGIONS: dict[str, dict] = {
    "world": {"label": "World", "group": "world", "bounds": None},
    # Conflict / high-interest theaters only -- the old continent buttons
    # (Africa/Asia/Europe/...) were dropped as too coarse to be useful next
    # to these. Bounds are deliberately tight to the theater itself rather
    # than the old sprawling boxes (e.g. the old "middle_east" ran from Egypt
    # to Afghanistan) so each button actually flies to a meaningful area.
    "russia_ukraine": {"label": "Russia / Ukraine", "group": "conflict", "bounds": (44.0, 21.0, 56.0, 41.0)},
    "israel_gaza_lebanon": {"label": "Israel / Gaza / Lebanon", "group": "conflict", "bounds": (29.0, 34.0, 34.5, 37.0)},
    "persian_gulf_hormuz": {"label": "Persian Gulf / Strait of Hormuz", "group": "conflict", "bounds": (23.0, 47.0, 31.0, 58.0)},
    "red_sea_yemen": {"label": "Red Sea / Yemen", "group": "conflict", "bounds": (10.0, 38.0, 20.0, 51.0)},
    "korean_peninsula": {"label": "Korean Peninsula", "group": "conflict", "bounds": (33.0, 124.0, 43.5, 131.0)},
    "taiwan_strait": {"label": "Taiwan Strait", "group": "conflict", "bounds": (20.0, 116.0, 26.5, 123.0)},
    "south_china_sea": {"label": "South China Sea", "group": "conflict", "bounds": (-4.0, 102.0, 23.0, 121.0)},
    "sahel": {"label": "Sahel", "group": "conflict", "bounds": (8.0, -6.0, 18.0, 16.0)},
    "sudan": {"label": "Sudan", "group": "conflict", "bounds": (8.0, 21.0, 23.0, 39.0)},
    "kashmir": {"label": "Kashmir", "group": "conflict", "bounds": (28.0, 70.0, 37.0, 80.0)},
    "venezuela_caribbean": {"label": "Venezuela / Caribbean", "group": "conflict", "bounds": (5.0, -75.0, 16.0, -58.0)},
}


def bounds_for(key: str | None) -> Bounds | None:
    if not key:
        return None
    entry = REGIONS.get(key)
    if not entry:
        return None
    return entry["bounds"]


def serialize() -> dict:
    return {
        key: {"label": v["label"], "group": v["group"], "bounds": v["bounds"]}
        for key, v in REGIONS.items()
    }


def parse_bbox(raw: str | None) -> Bounds | None:
    """Parse a "south,west,north,east" query parameter, or return None.

    None means "no viewport filter", which is the same thing an absent
    parameter means -- so a malformed box degrades to the full region rather
    than to an error. That is deliberate: this parameter is an optimisation the
    client offers, not a request the client makes, and a client that sends a
    bad one should get a slower correct answer rather than a failure.

    Everything here is validation rather than parsing, because the values reach
    filter_points, which trusts what it is given. A NaN would compare false
    against every point and silently empty the layer; a south above its north
    would do the same; and an unbounded box is just the absent case spelled at
    length.
    """
    if not raw:
        return None
    parts = raw.split(",")
    if len(parts) != 4:
        return None
    try:
        south, west, north, east = (float(p) for p in parts)
    except ValueError:
        return None
    # NaN fails every comparison including its own, so this catches it too.
    if not all(-90.0 <= v <= 90.0 for v in (south, north)):
        return None
    if not all(-180.0 <= v <= 180.0 for v in (west, east)):
        return None
    if south > north or west > east:
        # west > east is a box crossing the antimeridian. Legitimate on a map
        # with worldCopyJump, and not representable as one
        # (south, west, north, east) tuple that _in_bounds can test -- so it is
        # refused here rather than silently returning the empty intersection it
        # would produce.
        return None
    return (south, west, north, east)


def intersect(a: Bounds | None, b: Bounds | None) -> Bounds | None:
    """The overlap of two boxes, or None when either is absent.

    Used to combine a named region with a viewport box: a reader inside a
    selected zone should get that zone's data clipped to what they can see, and
    never data from outside the zone they chose. An empty overlap is returned as
    a degenerate box rather than as None, because None means "no filter" here --
    returning it for two boxes that do not overlap would hand back the whole
    world, which is the exact opposite of what was asked.
    """
    if a is None:
        return b
    if b is None:
        return a
    south = max(a[0], b[0])
    west = max(a[1], b[1])
    north = min(a[2], b[2])
    east = min(a[3], b[3])
    if south > north or west > east:
        return (0.0, 0.0, 0.0, 0.0)
    return (south, west, north, east)


def _in_bounds(lat: float, lon: float, bounds: Bounds) -> bool:
    south, west, north, east = bounds
    return south <= lat <= north and west <= lon <= east


def bbox_contains_point(bbox, lat: float, lon: float) -> bool:
    """Point-in-bbox, antimeridian-aware: `bbox` is [south, west, north, east],
    and west > east means the box wraps the antimeridian -- the convention
    backend/sources/water_bodies.py's own `_bbox` stores for a marine feature
    like the Bering Sea (see that function's docstring for which six features
    actually need it). backend/app.py's `_water_bbox_overlaps` already gives a
    bbox-*vs*-bbox query this same two-range treatment; this is the point-vs-
    bbox form Task 42's alert rules need for a geofence pinned to one stored
    water feature's bbox, captured once at rule-creation time, rather than a
    second query box built fresh per request.

    Unlike `_in_bounds` above (which every REGIONS entry and every viewport
    query already satisfies west <= east for -- regions.parse_bbox refuses a
    wrapped *query* box outright), a geofence's stored bbox can legitimately
    wrap, so this is the version a caller that cannot assume that reaches for.
    """
    if not bbox or len(bbox) != 4:
        return False
    south, west, north, east = bbox
    if lat < south or lat > north:
        return False
    if west <= east:
        return west <= lon <= east
    return lon >= west or lon <= east


def filter_points(items: list[dict], bounds: Bounds | None) -> list[dict]:
    if bounds is None:
        return items
    out = []
    for item in items:
        lat, lon = item.get("lat"), item.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        if _in_bounds(lat, lon, bounds):
            out.append(item)
    return out


def filter_paths(items: list[dict], bounds: Bounds | None, key: str = "path") -> list[dict]:
    """Line records whose own extent touches the viewport.

    The sibling of filter_points for the sources that serve linework rather than
    pins -- power lines and railways, whose records are `{"path": [[lat, lon], ...]}`
    rather than GeoJSON features, so filter_geojson cannot read them.

    Bbox against bbox, not "does any vertex fall inside". A transmission line can
    cross the whole viewport with both endpoints outside it, and testing vertices
    would drop exactly the long lines a reader most wants to see. The cost is
    over-inclusion: a line whose extent is a whole country is returned whenever the
    viewport touches that extent, even where the line itself does not pass. That is
    the right direction to be wrong in -- a line drawn that need not have been is
    noise, a line silently missing is a map that lies about the grid.

    Clipping the geometry instead would be smaller still and is deliberately not
    done: a clipped line is a different claim from the one OpenStreetMap made, and
    this map's whole promise is that it draws what its sources said.
    """
    if bounds is None:
        return items
    out = []
    for item in items:
        path = item.get(key)
        if not path:
            continue
        lats = [p[0] for p in path if isinstance(p, (list, tuple)) and len(p) >= 2]
        lons = [p[1] for p in path if isinstance(p, (list, tuple)) and len(p) >= 2]
        if not lats:
            continue
        if _bboxes_intersect((min(lats), min(lons), max(lats), max(lons)), bounds):
            out.append(item)
    return out


# Per-feature bbox cache for the countries GeoJSON, invalidated whenever
# countries.py swaps in a new FeatureCollection (once/day) -- no manual
# cache-busting needed.
#
# Keyed by holding the feature list itself and comparing with `is`, not by
# id(): CPython recycles id() values once an object is freed, so the old
# id-keyed version could in principle hand a *new* feature list the bboxes
# computed for a dead one that happened to land at the same address. The
# length check that guarded it only caught the case where the country count
# also changed. Keeping a reference costs nothing here -- the live dataset is
# already held by the source registry.
_bbox_cache_features: list | None = None
_bbox_cache_bboxes: list[Bounds] = []


def _walk_coords(coords):
    # GeoJSON geometries nest coordinate arrays to different depths
    # (Polygon: [ring][point][lon,lat], MultiPolygon: [poly][ring][point][lon,lat]).
    # Recursing until we hit a [lon, lat] pair handles any of them uniformly.
    if not coords:
        return
    if isinstance(coords[0], (int, float)):
        yield coords[0], coords[1]
        return
    for c in coords:
        yield from _walk_coords(c)


def _feature_bbox(feature: dict) -> Bounds:
    geometry = feature.get("geometry") or {}
    lats, lons = [], []
    for lon, lat in _walk_coords(geometry.get("coordinates")):
        lats.append(lat)
        lons.append(lon)
    if not lats:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(lats), min(lons), max(lats), max(lons))


def _bboxes_intersect(a: Bounds, b: Bounds) -> bool:
    a_south, a_west, a_north, a_east = a
    b_south, b_west, b_north, b_east = b
    return a_south <= b_north and b_south <= a_north and a_west <= b_east and b_west <= a_east


def filter_geojson(fc: dict, bounds: Bounds | None) -> dict:
    # Before the countries source's first successful poll, state.data is
    # still SourceState's generic empty-list default (see backend/cache.py),
    # not yet the {"type": ..., "features": [...]} shape -- treat that as an
    # empty FeatureCollection rather than crashing on a request that lands
    # in that narrow startup window.
    if not isinstance(fc, dict):
        return {"type": "FeatureCollection", "features": []}
    if bounds is None:
        return fc
    global _bbox_cache_features, _bbox_cache_bboxes
    features = fc.get("features") or []
    if _bbox_cache_features is not features:
        _bbox_cache_features = features
        _bbox_cache_bboxes = [_feature_bbox(f) for f in features]
    kept = [f for f, bbox in zip(features, _bbox_cache_bboxes) if _bboxes_intersect(bbox, bounds)]
    return {"type": "FeatureCollection", "features": kept}


# --- point-in-country -------------------------------------------------------
#
# Ported from frontend/src/map/countryHitTest.js -- see this module's own
# docstring for why a port rather than a new algorithm. Names below
# (_point_in_ring, _ring_area) mirror that file's pointInRing/ringArea on
# purpose, so the two can be read side by side.


def _wrap_lon(lon: float) -> float:
    return ((lon + 180.0) % 360.0 + 360.0) % 360.0 - 180.0


def _point_in_ring(ring: list, lat: float, lon: float) -> bool:
    """Standard even-odd ray cast. `ring` is GeoJSON order: [[lon, lat], ...]."""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _ring_area(ring: list) -> float:
    """Shoelace, in raw degrees -- only ever compared against other rings'
    values to break a "point falls in two features" tie (an enclave inside
    its enclosing state), the same reason countryHitTest.js's own ringArea
    does not need a real projection either."""
    total = 0.0
    j = len(ring) - 1
    for i in range(len(ring)):
        total += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        j = i
    return abs(total) / 2.0


def _point_to_segment_km(lat: float, lon: float, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance from (lat, lon) to the segment (lat1, lon1)-(lat2, lon2), in
    km -- the true minimum over every point on the segment, not just its two
    endpoints (see CountryIndex.nearest_country's own docstring for why that
    distinction matters).

    Computed via a local equirectangular projection centred on the query
    point (`lat`, `lon` becomes the origin; longitude is scaled by
    cos(lat) so a degree of longitude and a degree of latitude are
    comparable distances near the origin), then plain 2D point-to-segment
    geometry in that projected space. This is a flat-earth approximation,
    not true spherical geometry -- accurate to a small fraction of a percent
    at the tens-of-km scale this fallback operates at, and it needs no
    geodesy dependency this project does not otherwise carry. It is not
    meant to be accurate over hundreds of kilometres, which is exactly why
    `nearest_country` bounds its own search to `max_km` before ever
    trusting a result this function returns.
    """
    cos_lat0 = math.cos(math.radians(lat))

    def to_xy(la: float, lo: float) -> tuple[float, float]:
        x = math.radians(lo - lon) * cos_lat0 * EARTH_RADIUS_KM
        y = math.radians(la - lat) * EARTH_RADIUS_KM
        return x, y

    ax, ay = to_xy(lat1, lon1)
    bx, by = to_xy(lat2, lon2)
    dx, dy = bx - ax, by - ay
    seg_len2 = dx * dx + dy * dy
    if seg_len2 == 0.0:
        # A degenerate segment (two identical points, which a real ring
        # should not carry but a malformed one might) -- distance to that
        # single point.
        return math.hypot(ax, ay)
    # t is how far along A->B the query point's projection falls; clamped to
    # [0, 1] so a point whose perpendicular foot lands *past* an endpoint is
    # measured to that endpoint instead, which is what "closest point on the
    # segment" (not on the infinite line through it) means.
    t = max(0.0, min(1.0, (-ax * dx + -ay * dy) / seg_len2))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(cx, cy)  # the query point is the origin (0, 0)


def _polygons_of(geometry: dict | None) -> list:
    if not geometry:
        return []
    kind = geometry.get("type")
    if kind == "Polygon":
        return [geometry.get("coordinates") or []]
    if kind == "MultiPolygon":
        return geometry.get("coordinates") or []
    return []


class CountryIndex:
    """Point-in-country lookup over the countries GeoJSON (backend/sources/
    countries.py). Built once per caller from a FeatureCollection and queried
    per point -- the same shape backend/sources/proximity.py's ProximityIndex
    takes for "build once, query many" over a source's own snapshot.

    A landing name is free text some other gazetteer chose to write ("United
    States" against Natural Earth's "United States of America" is the gap
    that first motivated this); a landing's *coordinate* is not, so testing
    it against the polygon this map already draws for that country removes
    the join's dependency on anyone's spelling entirely.
    """

    __slots__ = ("_entries",)

    def __init__(self, feature_collection: dict | None):
        entries = []
        for feature in (feature_collection or {}).get("features") or []:
            polygons = _polygons_of(feature.get("geometry"))
            if not polygons:
                continue
            min_lat = min_lon = math.inf
            max_lat = max_lon = -math.inf
            area = 0.0
            for rings in polygons:
                outer = rings[0] if rings else None
                if not outer or len(outer) < 4:
                    continue
                area += _ring_area(outer)
                for lon, lat in outer:
                    if lat < min_lat:
                        min_lat = lat
                    if lat > max_lat:
                        max_lat = lat
                    if lon < min_lon:
                        min_lon = lon
                    if lon > max_lon:
                        max_lon = lon
            if min_lat == math.inf:
                continue  # every ring in this feature was degenerate -- nothing to test against
            props = feature.get("properties") or {}
            iso2 = props.get("iso_a2")
            iso2 = iso2.strip().upper() if isinstance(iso2, str) else None
            if not iso2 or iso2 == "-99":
                # Natural Earth's own "no ISO2" sentinel -- see
                # backend/sources/outages.py's identical override note.
                # Left None here rather than guessed: it is the caller's own
                # decision (and its own already-cited override, if it has
                # one) what a missing code should fall back to.
                iso2 = None
            entries.append({
                "iso2": iso2,
                "name": props.get("name"),
                "polygons": polygons,
                "bbox": (min_lat, min_lon, max_lat, max_lon),
                "area": area,
            })
        # Smallest-area-first, so an enclave (Lesotho inside South Africa, San
        # Marino inside Italy) is matched before the country surrounding it --
        # the identical reason countryHitTest.js's buildCountryIndex sorts the
        # same way for the frontend's own click hit-test.
        entries.sort(key=lambda e: e["area"])
        self._entries = entries

    def __len__(self) -> int:
        return len(self._entries)

    def country_at(self, lat, lon) -> dict | None:
        """The smallest country containing (lat, lon) -> {"iso2", "name"}
        (`iso2` may be None -- see __init__'s own note), or None if the point
        falls outside every polygon this index holds (open ocean, or a
        coastline this map's 1:50m resolution does not resolve finely enough
        to close around a point right at the water's edge)."""
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return None
        x = _wrap_lon(lon)
        for entry in self._entries:
            min_lat, min_lon, max_lat, max_lon = entry["bbox"]
            if lat < min_lat or lat > max_lat or x < min_lon or x > max_lon:
                continue
            if _country_contains(entry, lat, x):
                return {"iso2": entry["iso2"], "name": entry["name"]}
        return None

    def nearest_country(self, lat, lon, max_km: float = 25.0) -> dict | None:
        """The country whose outer coastline passes closest to (lat, lon),
        within `max_km` -> {"iso2", "name", "distance_km"}, or None past that
        radius.

        For a point `country_at` already places inside a polygon, call that
        instead -- this is the fallback for one that just misses every ring,
        which real cable landings do often enough to matter (see this
        module's own docstring).

        Task 38 review (Important 2): the first version of this measured
        distance to the nearest *vertex* of each candidate ring, which has a
        real failure mode -- a point sitting near the middle of a country's
        own long, vertex-sparse coastal edge can read as farther from that
        country than from a neighbour whose nearest *vertex* merely happens
        to be closer, even though the neighbour's actual coastline is
        farther away. `distance_km` below is instead the true minimum
        distance from the point to any *edge* (the segment between two
        consecutive ring vertices, not just their endpoints), computed via a
        local equirectangular (flat-earth) projection centred on the query
        point -- accurate to a small fraction of a percent at the scale this
        fallback operates at (tens of km, never hundreds -- see max_km), and
        needing no geodesy dependency this project does not otherwise carry.
        `distance_km` is returned (not just used internally) so a caller can
        carry the confidence of a snapped attribution through to wherever it
        is displayed, rather than only into an aggregate count -- see
        backend/refine/cable_outage.py's own group_landings_by_country.

        `max_km` bounds the guess the same way PORT_MATCH_RADIUS_KM bounds
        naval_presence.py's own port attribution: past it, "nearest country"
        stops meaning anything (the middle of the Pacific has a nearest
        country too, just not a meaningful one), so the caller gets None
        rather than a distant, misleading match.
        """
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return None
        x = _wrap_lon(lon)
        # A fixed degree margin, not a precise km->degree conversion: this
        # only widens the bbox pre-filter before the real distance check
        # below runs, so over-including a few extra candidate countries
        # costs a little time and never correctness. 111 km/degree is the
        # equatorial figure, deliberately generous at higher latitudes where
        # a degree of longitude is narrower than that.
        pad = max_km / 111.0 + 0.5
        best: dict | None = None
        best_km = max_km
        for entry in self._entries:
            min_lat, min_lon, max_lat, max_lon = entry["bbox"]
            if lat < min_lat - pad or lat > max_lat + pad or x < min_lon - pad or x > max_lon + pad:
                continue
            for rings in entry["polygons"]:
                for ring in rings:
                    if not ring or len(ring) < 2:
                        continue
                    for i in range(len(ring) - 1):
                        lon1, lat1 = ring[i]
                        lon2, lat2 = ring[i + 1]
                        km = _point_to_segment_km(lat, x, lat1, lon1, lat2, lon2)
                        if km < best_km:
                            best_km = km
                            best = entry
        if best is None:
            return None
        return {"iso2": best["iso2"], "name": best["name"], "distance_km": best_km}


def _country_contains(entry: dict, lat: float, lon: float) -> bool:
    for rings in entry["polygons"]:
        outer = rings[0] if rings else None
        if not outer or not _point_in_ring(outer, lat, lon):
            continue
        # Holes: a point inside a hole is outside the country (e.g. an
        # enclave cut out of the surrounding state's own polygon).
        in_hole = False
        for hole in rings[1:]:
            if _point_in_ring(hole, lat, lon):
                in_hole = True
                break
        if not in_hole:
            return True
    return False
