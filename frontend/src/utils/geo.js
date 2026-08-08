// Plain-object equivalents of the Leaflet LatLngBounds methods the app uses
// outside the map controller (e.g. NewsBroadcastPanel filtering GDELT items
// to the current view). Kept as plain {south,west,north,east} rather than
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
export function unwrapPath(points, refLon) {
  let previous = refLon;
  return points.map(([lat, lon]) => {
    const shifted = nearestLon(lon, previous);
    previous = shifted;
    return [lat, shifted];
  });
}
