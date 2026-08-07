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

/**
 * Replace one entity's trail with a path recorded server-side.
 *
 * This is what turns a trail from "since you selected it" into "since we
 * started hearing it". The backend has kept every position it recorded for the
 * retention window (see /api/track and storage.entity_track); until now the
 * only history the map could draw was whatever it had watched accumulate in
 * this tab, so selecting an aircraft that had been flying for a day drew a
 * single dot.
 *
 * Seeded into the *same* array the live poll appends to, deliberately. The
 * recorded path and the live tail are one continuous thing to a reader, and
 * giving the historical half its own layer would have meant a second colour
 * language on the map for what is the same claim -- where this went. The
 * existing age ramp in renderTrailLayer then reads correctly end to end: oldest
 * and faintest at the start of the recorded track, brightest at the live end.
 *
 * `points` arrive oldest-first from the endpoint. Trimmed from the *front* when
 * over budget, keeping the newest, which is the same end updateTrails keeps.
 */
export function seedTrailFromTrack(trailMap, id, points, maxPoints) {
  if (id == null || !Array.isArray(points)) return;
  const path = [];
  for (const p of points) {
    if (typeof p?.lat !== "number" || typeof p?.lon !== "number") continue;
    const last = path[path.length - 1];
    // Same duplicate guard updateTrails applies: entity_history only receives a
    // row when a position changed, but a track can still be seeded twice by two
    // selections in a row, and a zero-length segment renders as nothing while
    // still costing the age ramp a step.
    if (!last || last[0] !== p.lat || last[1] !== p.lon) path.push([p.lat, p.lon]);
  }
  if (!path.length) return;
  trailMap.set(id, path.length > maxPoints ? path.slice(path.length - maxPoints) : path);
}

// `color` is either one colour for the whole layer or a `(id) => colour`
// function, so a single trail layer can hold two visually distinct
// categories -- satellites use it to draw military objects' tracks in the same
// red their marker glyph uses (see SATELLITE_STYLE) while stations stay cyan,
// without splitting the layer in two and without the colour being restated
// somewhere it could drift from the icon.
//
// `style` optionally overrides the opacity ceiling and adds a dashArray --
// used by satellite trails (semi-transparent, dashed, reads as a background
// orbital track) while ship/aircraft trails keep their default solid,
// higher-opacity "active selection" look.
export function renderTrailLayer(trailLayer, trailMap, color, visibleIds, style) {
  const maxOpacity = style?.maxOpacity ?? 0.5;
  const dashArray = style?.dashArray;
  const colorFor = typeof color === "function" ? color : () => color;
  trailLayer.clearLayers();
  for (const [id, points] of trailMap) {
    if (!visibleIds.has(id) || points.length < 2) continue;
    const stroke = colorFor(id);
    for (let i = 0; i < points.length - 1; i++) {
      const t = (i + 1) / (points.length - 1); // 0 (oldest) .. 1 (newest)
      L.polyline([points[i], points[i + 1]], {
        color: stroke,
        weight: 2,
        opacity: (0.08 + t * 0.42) * (maxOpacity / 0.5),
        dashArray,
        interactive: false,
      }).addTo(trailLayer);
    }
  }
}
