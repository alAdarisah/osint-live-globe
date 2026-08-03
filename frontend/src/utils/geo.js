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
