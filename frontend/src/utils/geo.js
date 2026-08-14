// Plain-object equivalents of the Leaflet LatLngBounds methods the app uses
// outside the map controller (e.g. IntelPanel's viewport scope filtering GDELT
// items to the current view). Kept as plain {south,west,north,east} rather than
// passing a live Leaflet LatLngBounds into React so components that only
// need "am I roughly in view" don't have to import Leaflet at all.

export function padBounds({ south, west, north, east }, factor) {
  const latPad = (north - south) * factor;
  const lonPad = (east - west) * factor;
  return { south: south - latPad, west: west - lonPad, north: north + latPad, east: east + lonPad };
}

export function boundsContainsPoint(bounds, lat, lon) {
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

/**
 * `lon` moved by whole turns of the globe to sit as close to `refLon` as it can.
 *
 * The one piece of arithmetic behind seamless horizontal panning. A web map
 * repeats east-west for ever, so the same place has infinitely many longitudes
 * -- Wellington is 174.8, and also 534.8, and also -185.2 -- and every one of
 * them is correct. Which one is *useful* depends on where the camera is: at a
 * view centred on 179 the copy at 174.8 is on screen and the copy at -185.2 is a
 * whole world away, while at a view centred on -179 it is the other way round.
 *
 * Everything that reads a stored longitude has to ask this question, and until
 * now nothing did. A viewport test against a padded box spanning [169, 189]
 * rejected a point stored as -179; a marker placed at its stored longitude drew
 * a world to the left of the camera; a trail segment from 179.5 to -179.5 drew
 * the long way round, all the way across the map. All three are the same bug,
 * and this is the answer to all three.
 *
 * Returns the input unchanged for non-finite values, so a caller can hand it a
 * record with a missing coordinate and get one back to reject in the usual way.
 */
export function nearestLon(lon, refLon) {
  if (!Number.isFinite(lon) || !Number.isFinite(refLon)) return lon;
  return lon + Math.round((refLon - lon) / 360) * 360;
}

/**
 * A path with the wrap-around jumps taken out of it.
 *
 * Each point is placed on the copy of the globe nearest the point before it, so
 * a track that crosses the antimeridian keeps going in the direction it was
 * already travelling instead of snapping back across the whole map. The first
 * point anchors to `refLon` -- the camera -- so the path is drawn on the copy
 * being looked at.
 *
 * @param {Array<[number, number]>} points [lat, lon] pairs, in order
 */
/**
 * The most copies of the world any one view is allowed to draw.
 *
 * A guard, not a design parameter: `minZoom: 2` means an honest viewport never
 * asks for more than three, so reaching this cap always means something upstream
 * is wrong (a mid-animation bounds read, a broken zoom). Five keeps such a view
 * slow rather than unresponsive.
 */
export const MAX_WORLD_COPIES = 5;

/**
 * Which copies of the world are on screen, as offsets from the camera's own.
 *
 * `nearestLon` above answers the question for a single point: which of a stored
 * longitude's infinitely many copies is the camera looking at. This answers the
 * other half, the one a layer drawing whole-world geometry has to ask -- how many
 * copies can the reader see *at once* -- and returns `[0]`, `[-360, 0]`,
 * `[-360, 0, 360]` and so on. Adding an offset to a longitude already placed by
 * `nearestLon` puts it on that copy, so the two compose: pick the near copy, then
 * repeat it outwards.
 *
 * Offsets are relative to the camera's copy rather than absolute, because that is
 * the copy every existing caller already draws on. A camera three worlds out
 * still gets `[-360, 0, 360]`.
 *
 * A copy counts as in view only if it overlaps the bounds by more than a point.
 * The default view is exactly one world wide, so it *touches* both neighbours
 * while showing no pixel of either; counting a touch would triple the geometry of
 * every static layer on the most common view of the map for nothing.
 *
 * @param {number} west - bounds west longitude, unwrapped (may exceed +-180)
 * @param {number} east - bounds east longitude; less than `west` is read as a
 *   seam-crossing view rather than an empty one (see normalizedLonSpan in
 *   map/viewportProfile.js, which guards the same hazard)
 * @param {number} refLon - the camera longitude, the same reference `nearestLon` takes
 * @returns {number[]} ascending multiples of 360, always containing 0
 */
export function worldCopyOffsets(west, east, refLon) {
  if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(refLon)) return [0];
  const right = east <= west ? east + 360 : east;
  // Copy k spans [refLon - 180 + 360k, refLon + 180 + 360k]. It overlaps the
  // bounds when its east edge is strictly past `west` and its west edge strictly
  // short of `right`; the +1/-1 are what make those inequalities strict, and are
  // the whole reason a one-world-wide view answers 1 instead of 3.
  let low = Math.floor((west - refLon - 180) / 360) + 1;
  let high = Math.ceil((right - refLon + 180) / 360) - 1;
  if (high < low) return [0]; // unreachable for finite input; a floor, not a case
  if (high - low + 1 > MAX_WORLD_COPIES) {
    // Trim the outermost copies, never the camera's own -- dropping copy 0 would
    // blank the view the reader is actually looking at.
    const half = Math.floor((MAX_WORLD_COPIES - 1) / 2);
    low = Math.max(low, -half);
    high = Math.min(high, low + MAX_WORLD_COPIES - 1);
  }
  const offsets = [];
  for (let k = low; k <= high; k += 1) offsets.push(k * 360);
  return offsets;
}

/**
 * The map/sprite key for one drawn copy of a record.
 *
 * A record is a fact; a copy is that same fact seen again because the map repeats
 * east-west. Anything that stores drawn objects by record id has to key on both,
 * or the second copy overwrites the first in the map and only one of them is ever
 * drawn or torn down.
 *
 * Every copy is keyed the same way, including the camera's own, and the copy comes
 * first. That ordering is what makes the key injective for arbitrary ids: the copy
 * number contains no "|", so the first "|" always ends it, and two keys can only be
 * equal if both the copy and the id were. Leaving the primary copy's key as the
 * bare id instead would look tidier and would collide -- a record whose own id
 * happened to read "c1|x" would key identically to record "x" on copy +1, and one
 * of the two markers would silently overwrite the other. Ids here include
 * cityKey's "name|cc|lat|lon" composites, so "an id would never contain the
 * separator" was not an assumption worth making.
 *
 * Nothing reads these keys back apart: the marker maps and sprite buckets are only
 * ever written and iterated through, and the declutter offsets are keyed on the raw
 * id separately (see offsetFor and _offsetFor), which is why the primary copy is
 * free to stop being keyed by its bare id.
 *
 * Shared by the Leaflet marker layers and the WebGL sprite buckets deliberately:
 * two spellings of one key format is precisely the thing that silently diverges.
 */
export function worldCopyKey(id, copy) {
  return `c${copy / 360}|${id}`;
}

/**
 * One draw per (record, visible copy of the world).
 *
 * The expansion every repeated layer performs. Returns `{item, copy}` wrappers
 * rather than mutated records, because the record is what popups, tooltips, clicks
 * and counts read and it must keep its real coordinates -- only the *drawn*
 * position moves onto a copy.
 *
 * @param {object[]} items records, already viewport/zoom filtered by the caller
 * @param {number[]} offsets from worldCopyOffsets
 */
export function worldCopyDraws(items, offsets) {
  // The single-copy case is what a reader sees at almost every zoom, so it is kept
  // apart: one wrapper per record instead of a nested loop over a one-element list.
  if (offsets.length === 1) {
    const only = offsets[0];
    return items.map((item) => ({ item, copy: only }));
  }
  const out = [];
  for (const item of items) for (const copy of offsets) out.push({ item, copy });
  return out;
}

/**
 * A visitor over the copies of the world a record actually lands on.
 *
 * worldCopyDraws above expands a record onto every copy in view and lets Leaflet
 * clip what falls outside. That is right for markers, whose counts are in the
 * hundreds, and wrong for a heat layer: FIRMS runs to 100k+ points, and handing
 * leaflet.heat three times that on every pan would turn the cheapest layer at world
 * zoom into the most expensive one, to paint pixels that are off screen.
 *
 * So this culls. At the zoom where three copies are on screen the viewport spans
 * barely more than one world, so the outer copies take slivers rather than whole
 * duplicates and the total stays near the single-copy cost.
 *
 * Deliberately a visitor rather than a function returning an array of copies: at
 * FIRMS volumes an array per record is 100k allocations per pan. The latitude test
 * runs once per record rather than once per copy for the same reason, and the bounds
 * arrive as four numbers so that no LatLng is minted per placement.
 *
 * @param {{south: number, north: number, west: number, east: number}} bounds padded viewport
 * @param {number} refLon camera longitude
 * @param {number[]} offsets from worldCopyOffsets
 * @returns {(lat: number, lon: number, visit: (drawLon: number, copy: number) => void) => void}
 */
export function worldCopyPlacer(bounds, refLon, offsets) {
  const { south, north, west, east } = bounds;
  return (lat, lon, visit) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < south || lat > north) return;
    const base = nearestLon(lon, refLon);
    for (let i = 0; i < offsets.length; i++) {
      const drawLon = base + offsets[i];
      if (drawLon < west || drawLon > east) continue;
      visit(drawLon, offsets[i]);
    }
  };
}

/**
 * A path shifted onto a neighbouring copy of the world.
 *
 * The counterpart to worldCopyOffsets: that decides which copies to draw, this
 * draws one of them. Latitude is untouched -- a copy of the world is a horizontal
 * translation and nothing else.
 *
 * @param {Array<[number, number]>} path [lat, lon] pairs
 * @param {number} offset a multiple of 360 from worldCopyOffsets
 */
export function shiftPathLon(path, offset) {
  if (!offset) return path; // the camera's own copy: no allocation for the common case
  return path.map(([lat, lon]) => [lat, lon + offset]);
}

export function unwrapPath(points, refLon) {
  let previous = refLon;
  return points.map(([lat, lon]) => {
    const shifted = nearestLon(lon, previous);
    previous = shifted;
    return [lat, shifted];
  });
}

/**
 * The bounding box of a path, or null if it holds no finite point.
 *
 * Null rather than a degenerate box, because the two mean different things to a
 * caller deciding whether to draw something: an empty box would compare as
 * "outside the view" by arithmetic accident, and a record with no usable
 * geometry deserves to be rejected on purpose.
 *
 * Longitude is unwrapped as it goes, exactly as unwrapPath does and for the same
 * reason -- each point taken on the copy of the world nearest the one before it.
 * A route running 170 -> 175 -> -175 -> -170 is one continuous line across the
 * antimeridian, and a plain min/max would describe it as the box from -175 to
 * 175: the entire rest of the world, everywhere except where the route actually
 * is. So `west` and `east` here may fall outside +/-180, which is what makes them
 * a continuous span that extentInView can translate as one piece.
 *
 * @param {Array<[number, number]>} path [lat, lon] pairs
 */
export function pathExtent(path) {
  if (!Array.isArray(path)) return null;
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let previous = null;
  for (const point of path) {
    const lat = point?.[0];
    const lon = point?.[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // The first usable point anchors the frame; every later one is placed
    // relative to its predecessor rather than to the anchor, so a path long
    // enough to wrap more than once still stays continuous.
    const unwrapped = previous == null ? lon : nearestLon(lon, previous);
    previous = unwrapped;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (unwrapped < west) west = unwrapped;
    if (unwrapped > east) east = unwrapped;
  }
  return south === Infinity ? null : { south, west, north, east };
}

/**
 * Does a path's extent overlap a viewport box, allowing for the repeating world?
 *
 * The line counterpart to boundsContainsPoint, and the difference between them is
 * the reason this exists rather than the caller testing each vertex: a segment
 * can cross the whole screen with both of its endpoints off it, and a per-vertex
 * test drops exactly that line. An overlap test keeps it.
 *
 * The extent is translated onto the copy of the world nearest `refLon` before the
 * longitude comparison -- as one piece, keyed off its midpoint, so a route never
 * gets torn in half across the antimeridian the way a per-vertex nearestLon would
 * tear it. That is also why this takes an extent rather than a path: the shift has
 * to be decided once for the whole line.
 *
 * @param {{south:number,west:number,north:number,east:number}|null} extent
 * @param {{south:number,west:number,north:number,east:number}} view
 * @param {number} refLon the camera's own longitude
 */
export function extentInView(extent, view, refLon) {
  if (!extent) return false;
  if (extent.north < view.south || extent.south > view.north) return false;
  const mid = (extent.west + extent.east) / 2;
  const shift = nearestLon(mid, refLon) - mid;
  return extent.west + shift <= view.east && extent.east + shift >= view.west;
}
