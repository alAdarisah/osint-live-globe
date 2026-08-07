// Live marker appearance: the one place a glyph's colour and size are resolved.
//
// Everything that draws a pin -- decorators.js, the WebGL sprite styles, the
// control panel's own legend swatches -- reads its colour from here rather than
// from a hex literal at the point of use, so Admin Mode can recolour a layer
// without any of those modules knowing it happened.
//
// Deliberately module-level mutable state rather than React context. The map is
// imperative (see createMapController.js) and decorators are plain functions
// called from inside it hundreds of times per pan; threading a palette through
// every one of those call sites would be a large change to code that has no
// other reason to know about settings. The trade is that a palette change does
// not by itself repaint anything -- setIconTheme's caller is responsible for
// asking the controller to re-render, which is exactly what
// useLeafletMap's setIconTheme does.

/**
 * Every colour a reader can change, grouped the way the admin panel shows them.
 * `value` is the default -- the colour the map has always used -- and stays the
 * fallback whenever an override is absent or invalid.
 *
 * A token is only worth listing if it names something a reader can point at on
 * the map. Shape-only legends (which glyph means "air strike") are not colours
 * and are not listed.
 */
export const PALETTE_GROUPS = [
  {
    id: "severity",
    label: "Conflict severity",
    note: "Colour of a conflict pin, by its severity score.",
    tokens: [
      { id: "severity.critical", label: "Critical (75+)", value: "#ff1a1a" },
      { id: "severity.high", label: "High (55-74)", value: "#ff5c2a" },
      { id: "severity.moderate", label: "Moderate (40-54)", value: "#ff9500" },
      { id: "severity.low", label: "Low (0-39)", value: "#ffd11a" },
      { id: "event.corroborated", label: "Corroborated", value: "#3ac1ff" },
      { id: "event.history", label: "Verified record (UCDP)", value: "#8f9bb3" },
    ],
  },
  {
    id: "news",
    label: "News & diplomacy",
    tokens: [
      { id: "news.pin", label: "News pin", value: "#ffd60a" },
      { id: "officials.cooperative", label: "Cooperative act", value: "#7ee0c9" },
      { id: "officials.hostile", label: "Hostile act", value: "#ff9500" },
      { id: "officials.neutral", label: "Statement / neutral", value: "#c9b6ff" },
    ],
  },
  {
    id: "traffic",
    label: "Air & sea traffic",
    tokens: [
      { id: "ship.navy", label: "Navy / MSC vessel", value: "#ffd60a" },
      { id: "ship.tanker", label: "Oil tanker", value: "#ffb347" },
      { id: "ship.other", label: "Civilian vessel", value: "#35c2ff" },
      // Only the fallback glyph. Aircraft with a known role (fighter, tanker,
      // AWACS...) are coloured by that role -- see MILITARY_ROLE_STYLE -- and
      // collapsing ten roles onto one swatch would delete that distinction.
      { id: "aircraft.military", label: "Military aircraft (role unknown)", value: "#ff4d4d" },
      { id: "aircraft.helicopter", label: "Helicopter", value: "#9be15d" },
      { id: "aircraft.commercial", label: "Commercial aircraft", value: "#d8b9ff" },
      { id: "aircraft.other", label: "General aviation", value: "#8aa0ad" },
      // The ring drawn on an OFAC-listed hull or airframe. Shared by both, on
      // purpose: it is one claim about one list.
      { id: "sanctions.designated", label: "OFAC-designated", value: "#ff3b30" },
      { id: "dark.gap", label: "Went dark (AIS gap)", value: "#c9b6ff" },
      { id: "dark.sts", label: "Possible ship-to-ship transfer", value: "#7ee0c9" },
      // Global Fishing Watch's own findings, kept next to the two above because
      // they are the same subject seen by a different publisher -- and given a
      // neighbouring violet on purpose, so the family reads as a family while
      // still never being mistaken for this app's own inference.
      { id: "gfw.gap", label: "AIS disabling (Global Fishing Watch)", value: "#c084fc" },
      // The loudest colour in the maritime palette, deliberately: a hull an
      // instrument saw with nothing in the transponder picture to pair it with
      // is the finding this layer exists for.
      { id: "gfw.unmatched", label: "Satellite detection, no AIS match", value: "#ff3ea5" },
      // The palette's existing "already known, nothing to look at" grey. A
      // matched detection is a ship the AIS layer is drawing anyway.
      { id: "gfw.matched", label: "Satellite detection, matched to AIS", value: "#8aa0ad" },
    ],
  },
  {
    id: "places",
    label: "Places & infrastructure",
    tokens: [
      { id: "city.marker", label: "City / capital", value: "#ff6fb5" },
      { id: "infra.refinery", label: "Oil refinery", value: "#ff9500" },
      { id: "infra.lng_terminal", label: "LNG terminal", value: "#9be15d" },
      { id: "infra.port", label: "Port / oil terminal", value: "#d8b9ff" },
      { id: "infra.desalination", label: "Desalination plant", value: "#35c2ff" },
      { id: "infra.nuclear", label: "Nuclear facility", value: "#ffd60a" },
      { id: "infra.fab", label: "Semiconductor fab", value: "#6fe3ff" },
      // Also the colour of the pipeline *routes* (the polylines), so a node and
      // the line it sits on can never drift apart.
      { id: "infra.pipeline", label: "Pipeline node & routes", value: "#ffb347" },
      { id: "satellite.stations", label: "Space station", value: "#6fe3ff" },
      { id: "satellite.military", label: "Military satellite", value: "#ff4d4d" },
      { id: "airfield.civil", label: "Airfield", value: "#7f93a8" },
      { id: "airfield.military", label: "Airfield, military by name", value: "#ff8c3a" },
      { id: "cable.route", label: "Submarine cable route", value: "#4fd1c5" },
      { id: "cable.landing", label: "Cable landing point", value: "#4fd1c5" },
      { id: "cable.planned", label: "Planned cable landing", value: "#7f93a8" },
      { id: "launch.upcoming", label: "Upcoming launch", value: "#ffd60a" },
      { id: "launch.flown", label: "Recent launch (flown)", value: "#8aa0ad" },
      { id: "osm.military", label: "Military site (OpenStreetMap)", value: "#ff8c3a" },
      { id: "osm.power", label: "Power plant (OpenStreetMap)", value: "#9be15d" },
      { id: "osm.border", label: "Border crossing (OpenStreetMap)", value: "#c9b6ff" },
      // EASA airspace bulletins, coloured by status rather than by severity.
      // Their `severity` is two-valued -- 70 when live, 0 when withdrawn -- so
      // putting it on the shared severity ramp would paint every live advisory
      // the same orange and every withdrawn one yellow, which reads as a mild
      // live warning rather than as a document that has been rescinded.
      { id: "czib.active", label: "Airspace warning, active (EASA)", value: "#ff4d6d" },
      { id: "czib.withdrawn", label: "Airspace warning, withdrawn", value: "#7f93a8" },
      // Steel-teal, a sibling of airfield.civil above: the two are the same
      // kind of thing -- a published gazetteer of places traffic goes -- in two
      // domains, and they should read that way.
      { id: "port.wpi", label: "Port (NGA World Port Index)", value: "#7fa8b8" },
      { id: "dam.barrier", label: "Dam / reservoir (Global Dam Watch)", value: "#4a9fd8" },
    ],
  },
  {
    id: "choropleth",
    label: "Country fill",
    note: "The three-stop ramp the country shapes are painted with, low to high. Kept clear of"
      + " the severity and reliability ramps on purpose: this covers whole countries, and"
      + " sharing their colour language would read as one enormous pin.",
    tokens: [
      { id: "choropleth.low", label: "Low", value: "#2dd4bf" },
      { id: "choropleth.mid", label: "Middle", value: "#6366f1" },
      { id: "choropleth.high", label: "High", value: "#c026d3" },
    ],
  },
];

/** token id -> shipped default. Also the whole set of ids that may be overridden. */
export const DEFAULT_COLORS = Object.freeze(
  Object.fromEntries(PALETTE_GROUPS.flatMap((g) => g.tokens.map((t) => [t.id, t.value])))
);

/**
 * The tokens that also carry a size, and so get a size control.
 *
 * Not every colour names something with a size of its own. Three do not, and
 * offering a slider that moves nothing would be worse than offering none:
 *
 *   event.corroborated    recolours a pin already sized by its severity
 *   sanctions.designated  a ring drawn around a hull or airframe, not a pin
 *   cable.route           a polyline; its landing points are sized separately
 *   choropleth.*          a country fill; its size is the country
 *
 * Everything else resolves to a marker whose pixel size passes through
 * scaledSize, which is what a per-token multiplier acts on.
 */
const COLOUR_ONLY_TOKENS = new Set([
  "event.corroborated", "sanctions.designated", "cable.route",
  "choropleth.low", "choropleth.mid", "choropleth.high",
]);

export function tokenHasSize(token) {
  return token in DEFAULT_COLORS && !COLOUR_ONLY_TOKENS.has(token);
}

/** Every sizable token at its shipped multiplier -- which is 1, by definition. */
export const DEFAULT_SIZES = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_COLORS).filter(tokenHasSize).map((id) => [id, 1]))
);

// Anything else is either a typo or a stale saved config from an older build;
// both should fall back to the shipped colour rather than paint a marker
// `undefined`.
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

let palette = { ...DEFAULT_COLORS };
let globalScale = 1;
// Per-layer { scale, opacity } -- see SETTINGS_LAYERS in settings/defaults.js
// for which keys exist and what each one covers.
let layerStyles = {};
// Per-token size multiplier. The third and narrowest of the three size dials,
// under the global one and the per-layer one: "every pin", then "every pin in
// this layer", then "this kind of pin". A layer like AIS carries three of these
// (navy, tanker, civilian), which is the whole reason this level exists -- there
// was no way to make navy hulls stand out without also enlarging the civilian
// traffic they need to stand out from.
let tokenSizes = {};

/**
 * @param {object} next
 * @param {number} [next.scale]   global size multiplier, 1 == shipped sizes
 * @param {Record<string,string>} [next.colors]  token -> hex override
 * @param {Record<string,number>} [next.sizes]   token -> size multiplier
 * @param {Record<string,{scale?:number,opacity?:number}>} [next.layers]
 */
export function setIconTheme(next = {}) {
  if (Number.isFinite(next.scale)) globalScale = clampScale(next.scale);
  if (next.colors) {
    const merged = { ...DEFAULT_COLORS };
    for (const [token, value] of Object.entries(next.colors)) {
      if (token in DEFAULT_COLORS && typeof value === "string" && HEX.test(value)) merged[token] = value;
    }
    palette = merged;
  }
  if (next.sizes) {
    const merged = {};
    for (const [token, value] of Object.entries(next.sizes)) {
      if (tokenHasSize(token) && Number.isFinite(value)) merged[token] = clampScale(value);
    }
    tokenSizes = merged;
  }
  if (next.layers) layerStyles = next.layers;
}

function clampScale(value) {
  return Math.min(Math.max(value, 0.4), 3);
}

/** The colour for a token, or `fallback` if the token is unknown. */
export function paletteColor(token, fallback) {
  if (!token) return fallback;
  return palette[token] || DEFAULT_COLORS[token] || fallback;
}

export function iconScale() {
  return globalScale;
}

/** One kind of pin's own size multiplier (1 when it has never been configured). */
export function tokenScale(token) {
  const value = token ? tokenSizes[token] : null;
  return Number.isFinite(value) ? value : 1;
}

/**
 * A shipped pixel size, put through the global, per-layer and per-token
 * multipliers. Rounded, and that rounding matters: the number is rendered into
 * the icon's HTML string, which createMapController's updateMarker compares to
 * decide whether to rebuild a marker's DOM (see svgIcons.js's buildDivIcon).
 * A fractional size would differ between otherwise-identical renders.
 *
 * `token` is optional and every caller that can name one should pass it -- the
 * size a pin is *drawn* at and the size the placement pass *reserves* for it
 * come from the same call, so a token applied in one and not the other would
 * leave a 30px icon being routed around a 15px hole (see the note at the top of
 * decorators.js).
 */
export function scaledSize(px, layerKey, token) {
  // Some style objects carry no size of their own (the military-base subtypes
  // share one fixed infra size). Scaling a missing number would produce NaN and
  // an icon 4px wide; handing it back untouched leaves the caller's own
  // fallback in charge.
  if (!Number.isFinite(px)) return px;
  const layer = layerKey ? layerStyles[layerKey] : null;
  const layerScale = Number.isFinite(layer?.scale) ? layer.scale : 1;
  return Math.max(4, Math.round(px * globalScale * layerScale * tokenScale(token)));
}

/** A layer's opacity multiplier (1 when it has never been configured). */
export function layerOpacity(layerKey) {
  const value = layerStyles[layerKey]?.opacity;
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;
}

/**
 * A {svg, color, size, token} style object (SHIP_STYLE.navy, AIRCRAFT_STYLE.military,
 * ...) with its colour and size resolved through the current theme.
 *
 * Returns a fresh object every call rather than mutating the shipped constant:
 * the constants are also read as documentation (the control panel's legend) and
 * by webglLayer's texture cache, which keys on name|color|size and so picks up
 * a themed style as a distinct texture with no invalidation needed.
 */
export function themedStyle(style, layerKey) {
  if (!style) return style;
  return {
    ...style,
    color: paletteColor(style.token, style.color),
    size: scaledSize(style.size, layerKey, style.token),
    opacity: layerOpacity(layerKey),
  };
}
