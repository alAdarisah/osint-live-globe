"""Spatial helpers shared by the fusion pipeline.

Two things live here: a haversine distance, and a coarse grid index for
answering "is there one of these near here" without scanning every point.
Both were previously reimplemented per call site (backend/scripts/
import_bulk_infra.py has its own haversine; event_fusion compared raw degrees).
"""

import math

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres.

    Worth the trigonometry over a degree box: half a degree of longitude is
    ~55 km at the equator but ~19 km at 70N, so a degree-based threshold is
    silently three times stricter in the Arctic than at the equator -- which
    is exactly the wrong way round for a map whose busiest theatres sit at
    45-50N.
    """
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def lon_cells_for_radius(lat: float, radius_km: float, cell_deg: float) -> int:
    """How many longitude cells to either side must be scanned at this latitude.

    A degree of longitude shrinks with cos(latitude), so a fixed 3x3 cell
    neighbourhood stops covering the radius as you move away from the equator.
    The 0.1 floor stops a near-polar point from asking to scan the entire
    globe.
    """
    km_per_cell = 111.32 * max(math.cos(math.radians(lat)), 0.1) * cell_deg
    return max(1, math.ceil(radius_km / km_per_cell))


class ProximityIndex:
    """Coarse lat/lon bucket index over a set of points.

    Built once per poll from a source's registry data and queried once per
    fused event. FIRMS alone can be tens of thousands of points, so the
    alternative -- a full scan per event -- is what this exists to avoid.
    """

    __slots__ = ("_cells", "_cell_deg", "_count")

    def __init__(self, points, cell_deg: float = 0.5):
        self._cell_deg = cell_deg
        self._cells: dict[tuple[int, int], list[dict]] = {}
        self._count = 0
        for point in points or ():
            lat, lon = point.get("lat"), point.get("lon")
            if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                continue
            self._cells.setdefault(self._cell(lat, lon), []).append(point)
            self._count += 1

    def __len__(self) -> int:
        return self._count

    def _cell(self, lat: float, lon: float) -> tuple[int, int]:
        # Longitude wraps: the +180 cell must neighbour the -180 cell, or every
        # point near the antimeridian is invisible to points just across it.
        span = int(round(360.0 / self._cell_deg))
        return int(math.floor(lat / self._cell_deg)), int(math.floor(lon / self._cell_deg)) % span

    def nearest(self, lat: float, lon: float, radius_km: float) -> dict | None:
        """The closest indexed point within radius_km, or None."""
        if not self._cells:
            return None
        span = int(round(360.0 / self._cell_deg))
        lat_reach = max(1, math.ceil(radius_km / (110.574 * self._cell_deg)))
        lon_reach = lon_cells_for_radius(lat, radius_km, self._cell_deg)
        lat_cell, lon_cell = self._cell(lat, lon)

        best, best_km = None, radius_km
        for d_lat in range(-lat_reach, lat_reach + 1):
            for d_lon in range(-lon_reach, lon_reach + 1):
                bucket = self._cells.get((lat_cell + d_lat, (lon_cell + d_lon) % span))
                if not bucket:
                    continue
                for point in bucket:
                    distance = haversine_km(lat, lon, point["lat"], point["lon"])
                    if distance <= best_km:
                        best, best_km = point, distance
        return best
