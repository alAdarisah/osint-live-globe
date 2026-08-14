// The OpenWeatherMap tile layers this map can draw, and the two small pieces
// of logic every one of them needs: the URL the backend's single tile route
// expects (see weather_tile in backend/app.py), and whether a reader's
// missing API key should grey a given checkbox out.
//
// Kept as one table rather than five near-identical L.tileLayer calls in
// map/layers.js and five copies of `disabled={!owmConfigured}` in
// WeatherSection.jsx -- both of those read this file instead, so a layer
// added here is the only place it has to be added. The five owmId values
// below are taken verbatim from _WEATHER_LAYERS in backend/app.py, which is
// the allow-list the backend route actually enforces; nothing here invents
// an id the backend would 404 on.
//
// Imports nothing, so it can be exercised directly under `node --test` (see
// frontend/tests/weatherLayers.test.js), the same reasoning
// map/countryHitTest.js gives for its own no-imports rule.
export const OWM_WEATHER_LAYERS = [
  { key: "clouds", owmId: "clouds_new" },
  { key: "wind", owmId: "wind_new" },
  { key: "precipitation", owmId: "precipitation_new" },
  { key: "temp", owmId: "temp_new" },
  { key: "pressure", owmId: "pressure_new" },
];

// The one route every OWM tile layer is served through, keyed by OWM layer
// id. {z}/{x}/{y} are Leaflet's own template placeholders -- left
// unexpanded here for L.tileLayer to fill in per tile, exactly as the
// clouds_new URL already did before this file existed.
export function owmTileUrl(owmId) {
  return `/api/weather/tile/${owmId}/{z}/{x}/{y}.png`;
}

const OWM_LAYER_KEYS = new Set(OWM_WEATHER_LAYERS.map((entry) => entry.key));

// Every layer in the table above needs OWM_API_KEY configured on the backend
// or its tiles 503 (see weather_tile's own check) -- but RainViewer's
// precipitation radar ("precip") and the Open-Meteo wind-arrow field
// ("windArrows") share the Weather section and neither touches OWM at all.
// A reader with no OWM key configured should see exactly the five rows above
// greyed out, not those two -- this is a lookup against the table rather
// than a hand-maintained list so that stays true automatically as layers are
// added to or removed from it.
export function isOwmLayerDisabled(layerKey, owmConfigured) {
  return OWM_LAYER_KEYS.has(layerKey) && !owmConfigured;
}
