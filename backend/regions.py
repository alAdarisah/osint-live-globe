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
    "world": {"label": "World", "group": "continent", "bounds": None},
    "africa": {"label": "Africa", "group": "continent", "bounds": (-35.0, -18.0, 38.0, 52.0)},
    "asia": {"label": "Asia", "group": "continent", "bounds": (-11.0, 26.0, 55.0, 150.0)},
    "europe": {"label": "Europe", "group": "continent", "bounds": (34.5, -25.0, 72.0, 45.0)},
    "north_america": {"label": "North America", "group": "continent", "bounds": (5.5, -168.0, 75.0, -52.0)},
    "south_america": {"label": "South America", "group": "continent", "bounds": (-56.0, -82.0, 13.0, -34.0)},
    "oceania": {"label": "Oceania", "group": "continent", "bounds": (-50.0, 110.0, 0.0, 180.0)},
    # Conflict / high-interest theaters.
    "middle_east": {"label": "Middle East", "group": "conflict", "bounds": (12.0, 32.0, 42.0, 63.0)},
    "russia_ukraine": {"label": "Russia / Ukraine", "group": "conflict", "bounds": (44.0, 20.0, 57.0, 42.0)},
    "korea_taiwan": {"label": "Korea / Taiwan Strait", "group": "conflict", "bounds": (20.0, 118.0, 43.0, 132.0)},
    "south_china_sea": {"label": "South China Sea", "group": "conflict", "bounds": (-5.0, 99.0, 23.0, 122.0)},
    "red_sea_horn_africa": {"label": "Red Sea / Horn of Africa", "group": "conflict", "bounds": (-2.0, 32.0, 30.0, 52.0)},
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


# Per-feature bbox cache for the countries GeoJSON, keyed by id(feature_list)
# so it's automatically invalidated whenever countries.py refreshes its data
# with a new FeatureCollection (once/day) -- no manual cache-busting needed.
_geojson_bbox_cache: dict[int, list[Bounds]] = {}


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
    if bounds is None:
        return fc
    features = fc.get("features") or []
    cache_key = id(features)
    bboxes = _geojson_bbox_cache.get(cache_key)
    if bboxes is None or len(bboxes) != len(features):
        bboxes = [_feature_bbox(f) for f in features]
        _geojson_bbox_cache.clear()  # only one countries dataset in play at a time
        _geojson_bbox_cache[cache_key] = bboxes
    kept = [f for f, bbox in zip(features, bboxes) if _bboxes_intersect(bbox, bounds)]
    return {"type": "FeatureCollection", "features": kept}
