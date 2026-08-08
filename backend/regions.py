"""Shared region registry: quick-nav camera targets that double as backend
payload filters. Both the frontend's region bar and the /api/* endpoints'
`region=` query param read from REGIONS, so the two can never drift apart --
add a region here and it shows up as a button *and* as a valid filter.

Bounds are (south, west, north, east) in degrees. "world" (and any unknown
key) means "no filter" -- the caller gets the full global dataset, same as
before this feature existed.
"""

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
