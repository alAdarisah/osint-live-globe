// Position-history trails for the selected ship/aircraft.
//
// Neither AIS nor ADS-B gives us historical position data (each poll is just
// a live snapshot), so trails are built up client-side across polls: one
// array of recent [lat,lon] points per vehicle, keyed by MMSI/ICAO24. This
// also doubles as the closest thing to a "flight path" we can offer --
// OpenSky only gives live position, not filed routes, so this traces where
// the vehicle has actually been, not where it's going.
//
// Only the *selected* vehicle is tracked at all (see restrictTo below), so
// deselected vehicles never leave a "streak" and there's no per-poll
// bookkeeping cost for the (often hundreds of) vehicles that aren't selected.

import { L } from "./leafletGlobal";

// restrictTo semantics: omitted (undefined) tracks every reporting entity;
// a string tracks only that one id (the selected vehicle); an explicit null
// means "track nothing right now" (nothing selected) -- distinct from
// undefined so callers can express "selection cleared".
export function updateTrails(trailMap, items, idField, maxPoints, restrictTo) {
  const trackAll = restrictTo === undefined;
  if (!trackAll && restrictTo == null) {
    trailMap.clear();
    return;
  }
  const seenIds = new Set();
  for (const item of items) {
    const id = item[idField];
    if (id == null || (!trackAll && id !== restrictTo)) continue;
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
    seenIds.add(id);
    let trail = trailMap.get(id);
    if (!trail) {
      trail = [];
      trailMap.set(id, trail);
    }
    const last = trail[trail.length - 1];
    if (!last || last[0] !== item.lat || last[1] !== item.lon) {
      trail.push([item.lat, item.lon]);
      if (trail.length > maxPoints) trail.shift();
    }
  }
  for (const id of [...trailMap.keys()]) {
    if (!seenIds.has(id)) trailMap.delete(id); // vehicle no longer reporting (or deselected) -- drop its trail
  }
}

// `style` optionally overrides the opacity ceiling and adds a dashArray --
// used by satellite trails (semi-transparent, dashed, reads as a background
// orbital track) while ship/aircraft trails keep their default solid,
// higher-opacity "active selection" look.
export function renderTrailLayer(trailLayer, trailMap, color, visibleIds, style) {
  const maxOpacity = style?.maxOpacity ?? 0.5;
  const dashArray = style?.dashArray;
  trailLayer.clearLayers();
  for (const [id, points] of trailMap) {
    if (!visibleIds.has(id) || points.length < 2) continue;
    for (let i = 0; i < points.length - 1; i++) {
      const t = (i + 1) / (points.length - 1); // 0 (oldest) .. 1 (newest)
      L.polyline([points[i], points[i + 1]], {
        color,
        weight: 2,
        opacity: (0.08 + t * 0.42) * (maxOpacity / 0.5),
        dashArray,
        interactive: false,
      }).addTo(trailLayer);
    }
  }
}
