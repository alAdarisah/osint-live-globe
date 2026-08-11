import { SVG, GLYPH_CHOICES, shippedGlyph } from "./svgIcons.js";
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
    note: "Colour of a conflict pin, by its severity score. One hue on purpose --"
      + " violence is red here, and severity is how bright the red is. Orange and yellow"
      + " are spoken for: an orange pin is a regulator's airspace warning, a yellow one is"
      + " a navy hull.",
    tokens: [
      { id: "severity.critical", label: "Critical (75+)", value: "#ff1a1a" },
      { id: "severity.high", label: "High (55-74)", value: "#e03131" },
      { id: "severity.moderate", label: "Moderate (40-54)", value: "#b02525" },
      { id: "severity.low", label: "Low (0-39)", value: "#7f1d1d" },
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
      // One row per drawn city glyph rather than one row for the whole layer.
      // The four population bands and the capital each draw a different shape
      // (see CITY_TIERS in decorators.js), and a single "City / capital" token
      // meant the shape picker could only set all five to the same glyph --
      // which deletes the graduated-symbol distinction the tiers exist for.
      // Same colour on all five, because that distinction was never carried by
      // hue; splitting them is about being able to size, delay and re-shape a
      // band on its own.
      { id: "city.capital", label: "Capital city", value: "#ff6fb5" },
      { id: "city.mega", label: "Megacity (5M+)", value: "#ff6fb5" },
      { id: "city.large", label: "Large city (1M-5M)", value: "#ff6fb5" },
      { id: "city.medium", label: "City (250k-1M)", value: "#ff6fb5" },
      { id: "city.town", label: "Town (100k-250k)", value: "#ff6fb5" },
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
      // One row per runway layout, not one row for "civil". The three tiers
      // draw three different glyphs (see AIRFIELD_STYLE in decorators.js), and
      // under a single token the shape picker could only flatten them onto one
      // -- a small strip and an international airport reading identically is
      // exactly what the tiered glyphs were drawn to prevent.
      { id: "airfield.large", label: "Large airport", value: "#7f93a8" },
      { id: "airfield.medium", label: "Medium airport", value: "#7f93a8" },
      { id: "airfield.small", label: "Small airfield", value: "#7f93a8" },
      { id: "airfield.military", label: "Airfield, military by name", value: "#ff8c3a" },
      { id: "cable.route", label: "Submarine cable route", value: "#4fd1c5" },
      { id: "cable.landing", label: "Cable landing point", value: "#4fd1c5" },
      { id: "cable.planned", label: "Planned cable landing", value: "#7f93a8" },
      { id: "launch.upcoming", label: "Upcoming launch", value: "#ffd60a" },
      { id: "launch.flown", label: "Recent launch (flown)", value: "#8aa0ad" },
      // Two shapes, two rows: a military airfield draws a runway and a military
      // area draws a compound. They shared a token and so shared one shape
      // picker, which could only make both of them the same thing.
      { id: "osm.military_airfield", label: "Military airfield (OpenStreetMap)", value: "#ff8c3a" },
      { id: "osm.military_area", label: "Military area (OpenStreetMap)", value: "#ff8c3a" },
      { id: "osm.power", label: "Power plant (OpenStreetMap)", value: "#9be15d" },
      { id: "osm.border", label: "Border crossing (OpenStreetMap)", value: "#c9b6ff" },
      // EASA airspace bulletins, coloured by status rather than by severity.
      // Their `severity` is two-valued -- 70 when live, 0 when withdrawn -- so
      // putting it on the shared severity ramp would paint every live advisory
      // the same orange and every withdrawn one yellow, which reads as a mild
      // live warning rather than as a document that has been rescinded.
      // Orange, and the only orange on the map that names a thing rather than a
      // degree of one. It used to be a pink-red, which put it inside the
      // conflict layer's colour language while being a different kind of claim
      // entirely -- a regulator's standing instruction, not an incident. The
      // severity ramp gave orange up for this (see SEVERITY_BANDS in
      // severity.js), so a warning is now the only thing on the map drawn in it.
      { id: "czib.active", label: "Airspace warning, active (EASA)", value: "#ff8c00" },
      { id: "czib.withdrawn", label: "Airspace warning, withdrawn", value: "#7f93a8" },
      // Steel-teal, a sibling of the civil airfields above: the two are the same
      // kind of thing -- a published gazetteer of places traffic goes -- in two
      // domains, and they should read that way.
      { id: "port.wpi", label: "Port (NGA World Port Index)", value: "#7fa8b8" },
      { id: "dam.barrier", label: "Dam / reservoir (Global Dam Watch)", value: "#4a9fd8" },
      // Railway station/halt/yard/border nodes, riding the OpenStreetMap layer.
      // Siblings of osm.border above -- same crowd-sourced provenance, the same
      // muted slate so a station never reads as a border crossing.
      //
      // Four rows rather than one. They used to share a single "Railway node"
      // token, which made every dial on them all-or-nothing: a halt is a
      // request stop with a nameboard and a station is a building with a
      // timetable, and "show the halts only once I am on top of them, keep the
      // stations from further out" was unsayable. It is four pin types, so it
      // is four rows.
      { id: "osm.railway_station", label: "Railway station (OpenStreetMap)", value: "#8aa0c4" },
      { id: "osm.railway_halt", label: "Railway halt (OpenStreetMap)", value: "#8aa0c4" },
      { id: "osm.railway_yard", label: "Railway yard (OpenStreetMap)", value: "#8aa0c4" },
      { id: "osm.railway_border", label: "Railway border crossing (OSM)", value: "#8aa0c4" },
      // Coarse basemap rail *linework* (Natural Earth 1:10m, 2021). A muted grey,
      // and colour-only like cable.route below -- it is a polyline, not a pin.
      { id: "railway.line", label: "Railway line (Natural Earth, 2021)", value: "#6f7d92" },
      // DeFlock ALPR camera locations. A muted violet, deliberately quiet: this is
      // crowd-sourced surveillance-infrastructure metadata, not a live feed.
      { id: "deflock.camera", label: "ALPR camera (DeFlock / OpenStreetMap)", value: "#a78bba" },
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
  "event.corroborated", "sanctions.designated", "cable.route", "railway.line",
  "choropleth.low", "choropleth.mid", "choropleth.high",
]);

export function tokenHasSize(token) {
  return token in DEFAULT_COLORS && !COLOUR_ONLY_TOKENS.has(token);
}

/** Every sizable token at its shipped multiplier -- which is 1, by definition. */
export const DEFAULT_SIZES = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_COLORS).filter(tokenHasSize).map((id) => [id, 1]))
);

/**
 * Which layer's gate each kind of pin sits under.
 *
 * Needed because a pin type's own "shows from zoom" is applied *on top of* its
 * layer's -- the later of the two wins (see tokenZoom below and pinZoomGate in
 * createMapController.js). A token with no entry here is one with no pin of its
 * own to withhold: the three colour-only tokens, the choropleth ramp, and
 * outage.country, which names a colour the palette does not offer.
 *
 * Deliberately not derived from the palette groups. Those group by subject --
 * "Air & sea traffic" holds three ship classes and four aircraft classes across
 * five different layers -- and a layer is not a subject.
 */
export const TOKEN_LAYER = Object.freeze({
  "severity.critical": "events",
  "severity.high": "events",
  "severity.moderate": "events",
  "severity.low": "events",
  "event.history": "conflictHistory",
  "news.pin": "gdelt",
  "officials.cooperative": "officials",
  "officials.hostile": "officials",
  "officials.neutral": "officials",
  "ship.navy": "aisNavy",
  "ship.tanker": "aisTanker",
  "ship.other": "aisCivilian",
  "aircraft.military": "adsbMilitary",
  "aircraft.helicopter": "adsbCivilian",
  "aircraft.commercial": "adsbCivilian",
  "aircraft.other": "adsbCivilian",
  "dark.gap": "darkVessels",
  "dark.sts": "darkVessels",
  "gfw.gap": "gfwGaps",
  "gfw.unmatched": "gfwDetections",
  "gfw.matched": "gfwDetections",
  "city.capital": "cities",
  "city.mega": "cities",
  "city.large": "cities",
  "city.medium": "cities",
  "city.town": "cities",
  "infra.refinery": "infra",
  "infra.lng_terminal": "infra",
  "infra.port": "infra",
  "infra.desalination": "infra",
  "infra.nuclear": "infra",
  "infra.fab": "infra",
  "infra.pipeline": "infra",
  "satellite.stations": "satellites",
  "satellite.military": "satellites",
  "airfield.large": "airports",
  "airfield.medium": "airports",
  "airfield.small": "airports",
  "airfield.military": "airports",
  "cable.landing": "cableLandings",
  "cable.planned": "cableLandings",
  "launch.upcoming": "launches",
  "launch.flown": "launches",
  "osm.military_airfield": "osmInfra",
  "osm.military_area": "osmInfra",
  "osm.power": "osmInfra",
  "osm.border": "osmInfra",
  "osm.railway_station": "osmInfra",
  "osm.railway_halt": "osmInfra",
  "osm.railway_yard": "osmInfra",
  "osm.railway_border": "osmInfra",
  "deflock.camera": "deflock",
  "czib.active": "czib",
  "czib.withdrawn": "czib",
  "port.wpi": "ports",
  "dam.barrier": "dams",
});

// --- the stack -------------------------------------------------------------
//
// Which layer draws over which, and how much the ones underneath recede.
//
// Two ordered groups, not one, because the map has two drawing mechanisms and
// they do not interleave. Every pin is a DOM marker in Leaflet's markerPane
// (z 600); the three washes are canvases in the overlayPane (z 400) below it.
// A canvas can therefore never be ordered above a pin -- that has always been
// true of this map -- so the panel offers two lists rather than one list that
// silently ignores half the moves made in it. Making them interleave would mean
// a Leaflet pane per layer and a `pane` option threaded through every marker,
// polyline and canvas renderer on the map, which is a large change to buy an
// ordering nobody has asked for: pins over washes is the right answer.
//
// Order is top-first. Within the pins, the default is an editorial claim and
// reads as one: violence, then the warnings about it, then the hazards, then
// what is moving, then the places it is all happening to.
//
// This table lives here rather than in a module of its own because iconTheme.js
// deliberately imports nothing -- that is what lets tests/pinZoom.test.js load
// it under `node --test` with no bundler -- and the stack is appearance state
// of exactly the kind this file already owns.
// Cities sit at the head of the reference block rather than at the foot of the
// whole list, which is where they started. Two reasons, and the second is the
// one that made it wrong:
//
//   A city is what everything else is read *against*. Drawing it beneath the
//   ports, dams and airfields whose position it gives meaning to inverts that.
//
//   The depth fade compounded with the graduated one the city glyphs already
//   carry (0.45 for a town up to 1 for a capital, see CITY_TIERS). At the bottom
//   of the stack that landed a town at 0.45 x 0.55 = 25% and a capital at 55% --
//   two separate mechanisms both saying "recede", multiplied.
//
// The line it now sits on is a coherent one: what happened, then what is
// inferred or in motion, then the places all of it happened to.
export const PIN_STACK = [
  "events", "conflictHistory", "czib", "hazards", "floods", "gdelt", "officials",
  "darkVessels", "gfwGaps", "gfwDetections", "satellites", "launches",
  "cities", "infra", "osmInfra", "deflock", "airports", "ports", "dams",
  "railways", "cables", "outagePoints",
];
export const WASH_STACK = ["vehicles", "jamming", "firms"];

/**
 * Layer keys that ride another key's place in the stack.
 *
 * The six WebGL buckets are sprites on one shared canvas (see webglLayer.js), so
 * they have exactly one position between them -- splitting the canvas to give
 * each its own would undo the reason it exists. Cable landings are drawn as part
 * of the cables layer for the same reason its checkbox covers both: a cable and
 * the place it comes ashore are one fact.
 */
export const STACK_ALIAS = Object.freeze({
  aisNavy: "vehicles", aisTanker: "vehicles", aisCivilian: "vehicles",
  aisDigitraffic: "vehicles",
  adsbMilitary: "vehicles", adsbCivilian: "vehicles", adsbFlagged: "vehicles",
  cableLandings: "cables",
  firmsPoints: "firms",
});

export const DEFAULT_STACK = Object.freeze({ pins: [...PIN_STACK], washes: [...WASH_STACK] });

/** How faint the bottom of a group is drawn, before any per-layer opacity. */
export const DEFAULT_STACK_FADE_FLOOR = 0.55;

/**
 * Tokens that used to stand for several kinds of pin at once, and what they
 * were split into.
 *
 * Each of these named one row in the panel that drew two, three or five
 * different glyphs on the map, so every dial on it was all-or-nothing -- and
 * the shape picker was worse than that, since choosing a glyph flattened a
 * whole family onto it. They are now one row per pin type.
 *
 * A saved configuration still holds the old key, and dropping it would silently
 * reset whatever an operator had set there. mergeSettings (see
 * settings/defaults.js) fans the stored value out across the replacements
 * instead: one colour becomes the same colour on each, one zoom becomes the
 * same zoom on each, which is exactly what the single dial used to do.
 *
 * The glyph override is deliberately *not* carried across. It was the one
 * setting that could not have meant what it now says: under the old shared
 * token a chosen shape overwrote every member of the family, so replaying it
 * would re-flatten the distinction this split exists to restore.
 */
export const SPLIT_TOKENS = Object.freeze({
  "city.marker": ["city.capital", "city.mega", "city.large", "city.medium", "city.town"],
  "airfield.civil": ["airfield.large", "airfield.medium", "airfield.small"],
  "osm.military": ["osm.military_airfield", "osm.military_area"],
  "osm.railway": [
    "osm.railway_station", "osm.railway_halt", "osm.railway_yard", "osm.railway_border",
  ],
});

/** The tokens that name a drawable pin, and so can be given a zoom of their own. */
export function tokenHasZoom(token) {
  return token in TOKEN_LAYER;
}

/**
 * Every gateable token at its shipped gate -- which is null, meaning "whenever
 * the layer draws". Null rather than a number on purpose: a token that stored
 * its layer's current gate would silently stop following it the moment the
 * layer's own slider moved.
 */
export const DEFAULT_ZOOMS = Object.freeze(
  Object.fromEntries(Object.keys(TOKEN_LAYER).map((id) => [id, null]))
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
// Per-token minimum zoom, and the set of layers that have at least one. The set
// is derived rather than asked for, because the renderers consult it once per
// layer per pass to decide whether the per-pin question is worth asking at all
// -- almost always it is not, and resolving a token for ten thousand hulls to
// learn that none of them is gated is exactly the kind of work a render pass
// cannot afford.
let tokenZooms = {};
let layersWithTokenZoom = new Set();
// The ceiling to tokenZooms' floor: the zoom past which this kind of pin stops
// drawing. Kept in its own table and its own layer set rather than as a second
// field on the first, because the two are set independently -- a pin type very
// often has one and not the other -- and a combined table would have to store an
// entry for every token that carries either.
let tokenZoomMaxes = {};
let layersWithTokenZoomMax = new Set();
// Per-token glyph override, as a glyph *name* rather than an SVG string: the
// name is what the config stores, what the picker offers and what survives a
// build that redraws a glyph. Storing the markup would freeze a pin at whatever
// the shape looked like on the day it was chosen.
let tokenGlyphs = {};
// The stack, resolved to what the two readers below need: a rank per key within
// its own group, and the size of that group. Rebuilt on every order change
// rather than recomputed per lookup -- layerOpacity is called once per marker
// per render, which is tens of thousands of times a pan.
let stackRanks = new Map();
let stackFadeFloor = DEFAULT_STACK_FADE_FLOOR;

/**
 * @param {object} next
 * @param {number} [next.scale]   global size multiplier, 1 == shipped sizes
 * @param {Record<string,string>} [next.colors]  token -> hex override
 * @param {Record<string,number>} [next.sizes]   token -> size multiplier
 * @param {Record<string,number|null>} [next.zooms]  token -> minimum zoom
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
  if (next.zooms) {
    const merged = {};
    const layers = new Set();
    for (const [token, value] of Object.entries(next.zooms)) {
      // A null is the ordinary case, not a malformed one: it is how "follow the
      // layer" is stored, so it drops out here rather than being recorded.
      if (!tokenHasZoom(token) || !Number.isFinite(value)) continue;
      merged[token] = clampZoom(value);
      layers.add(TOKEN_LAYER[token]);
    }
    tokenZooms = merged;
    layersWithTokenZoom = layers;
  }
  if (next.zoomMaxes) {
    const merged = {};
    const layers = new Set();
    for (const [token, value] of Object.entries(next.zoomMaxes)) {
      if (!tokenHasZoom(token) || !Number.isFinite(value)) continue;
      merged[token] = clampZoom(value);
      layers.add(TOKEN_LAYER[token]);
    }
    tokenZoomMaxes = merged;
    layersWithTokenZoomMax = layers;
  }
  if (next.glyphs) {
    const merged = {};
    for (const [token, name] of Object.entries(next.glyphs)) {
      // Both halves checked: a token this build does not offer a choice for, and
      // a glyph name it no longer draws, each fall back to the shipped shape
      // rather than to nothing. An icon that renders empty is worse than one
      // that ignores a stale preference.
      if (GLYPH_CHOICES[token]?.includes(name) && SVG[name]) merged[token] = name;
    }
    tokenGlyphs = merged;
  }
  if (next.layers) layerStyles = next.layers;
  if (next.stack) setStack(next.stack);
  if (Number.isFinite(next.stackFadeFloor)) {
    stackFadeFloor = Math.min(Math.max(next.stackFadeFloor, 0.1), 1);
  }
}

/**
 * Resolve a stored order into the rank table the map reads.
 *
 * The stored order is merged onto the shipped one rather than trusted as a
 * whole: a configuration written by an older build is missing whatever layers
 * have been added since, and a layer that fell out of the stack would be drawn
 * with no rank at all -- which is to say at full strength, on top, which is the
 * one outcome a stack is supposed to make impossible. Anything unrecognised is
 * dropped, anything missing is appended in its shipped order.
 */
function setStack(stack = {}) {
  const ranks = new Map();
  for (const [group, shipped] of [["pins", PIN_STACK], ["washes", WASH_STACK]]) {
    // Only the pins are depth-faded. The washes are already the background tier
    // by construction -- three canvases under every pin on the map -- so fading
    // them for depth as well is a second mechanism saying what their being
    // canvases already says, and the two multiply.
    //
    // FIRMS is what proved it: the layer ships deliberately faint at 0.3 (a
    // global thermal feed is mostly agricultural burning, see
    // FIRMS_HEAT_OPACITY in layers.js), sat at the bottom of the wash stack for
    // another 0.55, and drew at 0.165 -- close enough to invisible that moving
    // its opacity slider looked like a control that did nothing. Order still
    // decides which wash covers which; it just no longer dims them too.
    const faded = group === "pins";
    const stored = Array.isArray(stack[group]) ? stack[group] : [];
    const known = new Set(shipped);
    const seen = new Set();
    const order = [];
    for (const key of stored) {
      if (known.has(key) && !seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    for (const key of shipped) if (!seen.has(key)) order.push(key);
    order.forEach((key, index) => ranks.set(key, { index, of: order.length, faded }));
  }
  stackRanks = ranks;
}
setStack(DEFAULT_STACK);

/** Where a layer sits, resolving the keys that ride another layer's place. */
function stackEntryFor(layerKey) {
  return stackRanks.get(STACK_ALIAS[layerKey] || layerKey) || null;
}

/**
 * How much a layer is faded for sitting where it does in the stack.
 *
 * Linear from 1 at the top of a group to the floor at the bottom, and applied on
 * top of the layer's own opacity rather than instead of it -- so the order
 * expresses "how much of the reader's attention is this entitled to" and the
 * per-layer slider stays an absolute correction on that.
 *
 * A key with no place in the stack is not faded. Those are the substrate --
 * country shapes, districts, the basemap -- which sit under everything by
 * construction and have nothing to be ranked against.
 */
export function stackFade(layerKey) {
  const entry = stackEntryFor(layerKey);
  if (!entry || entry.of < 2 || !entry.faded) return 1;
  return 1 - (1 - stackFadeFloor) * (entry.index / (entry.of - 1));
}

/**
 * The z-index offset a layer's markers are drawn with.
 *
 * Leaflet orders markers inside one pane by zIndexOffset, which is what makes
 * this possible without a pane per layer. The stride has to clear the per-icon
 * term applyStacking already subtracts (an icon size, at most ~120px after a 3x
 * global scale) or a large icon in one layer would sink below a small one in the
 * layer beneath it.
 */
export function stackZIndex(layerKey) {
  const entry = stackEntryFor(layerKey);
  if (!entry) return 0;
  return (entry.of - entry.index) * 1000;
}

function clampScale(value) {
  return Math.min(Math.max(value, 0.4), 3);
}

// Whole levels only. Leaflet reports fractional zooms mid-gesture and every
// other gate on this map is an integer, so a threshold of 6.35 would be a
// number no reader could have meant and no comparison could be reasoned about.
function clampZoom(value) {
  return Math.min(Math.max(Math.round(value), 0), 18);
}

/**
 * The zoom this kind of pin starts drawing at, or null when it has none.
 *
 * Applied *on top of* the layer's own gate rather than instead of it: the later
 * of the two wins. A pin type cannot be made to appear before its layer does,
 * and that is not a simplification -- a layer below its gate is often not even
 * fetched (see LAYER_MANIFEST's `fetch` in map/scene.js), so a token allowed to
 * undercut it would promise pins there is no data for.
 */
export function tokenZoom(token) {
  const value = token ? tokenZooms[token] : null;
  return Number.isFinite(value) ? value : null;
}

/**
 * The zoom this kind of pin stops drawing past, or null when it has none.
 *
 * The ceiling to tokenZoom's floor, and the narrow end of the same pair of dials
 * the layer carries. Inclusive: a ceiling of 6 means the pin is still drawn at
 * zoom 6 and gone at 7, which is what "up to zoom 6" means to the person setting
 * it. Reading it the other way would make a range of 6 to 6 empty.
 *
 * Unlike the floor there is no shipped value anywhere -- nothing in
 * LAYER_MANIFEST expresses a ceiling -- so a null here means "no ceiling" rather
 * than "follow the layer". A layer-level ceiling is applied separately and
 * independently; the two compose as "whichever is lower wins", the mirror of the
 * floor's "whichever is later wins".
 */
export function tokenZoomMax(token) {
  const value = token ? tokenZoomMaxes[token] : null;
  return Number.isFinite(value) ? value : null;
}

/** Whether any pin type in this layer carries a zoom of its own. */
export function layerHasTokenZoom(layerKey) {
  return layersWithTokenZoom.has(layerKey);
}

/**
 * The glyph markup for a token: the operator's choice, or `fallback`.
 *
 * Mirrors paletteColor exactly, and sits in the same place in every decorator --
 * the shipped shape is passed in so a token nobody has configured costs one
 * failed lookup and returns what it was already going to draw.
 */
export function paletteGlyph(token, fallback) {
  if (!token) return fallback;
  const chosen = tokenGlyphs[token];
  return (chosen && SVG[chosen]) || fallback;
}

/** The glyphs this token may be set to, shipped-first. Empty when it has none. */
export function glyphChoicesFor(token) {
  return GLYPH_CHOICES[token] || [];
}

export { shippedGlyph };

/** Whether any pin type in this layer carries a ceiling of its own. */
export function layerHasTokenZoomMax(layerKey) {
  return layersWithTokenZoomMax.has(layerKey);
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

/**
 * The same multipliers, for a line's weight rather than an icon's box.
 *
 * scaledSize is wrong for a polyline in both of its adjustments, and quietly so.
 * It rounds, because an icon's pixel size is baked into the HTML string
 * updateMarker diffs and a fractional one would differ between identical
 * renders -- a line has no such string. And it floors at 4px so an icon can
 * never shrink to something unclickable -- which would take a submarine cable
 * from its shipped 1.4px hairline to 4px, nearly tripling the weight of a mesh
 * of 718 routes the moment it started honouring the dial at all.
 *
 * Floored at 0.5px instead: below that a browser stops drawing a stroke
 * reliably, and a line the dial has made invisible is a line nobody can find
 * their way back from.
 */
/**
 * One layer's own size multiplier, without the global icon scale on top.
 *
 * For the two heat layers, whose "size" is a kernel radius rather than an icon.
 * The global dial says what it does on the panel -- "scales every marker, and
 * the spacing the declutter pass reserves for it" -- and a density kernel is
 * neither a marker nor something the placement pass routes around. Turning the
 * global dial down to thin a crowded pin field would otherwise also shrink the
 * fire blobs, which is a change nobody asked for and no label predicts.
 */
export function layerScale(layerKey) {
  const value = layerKey ? layerStyles[layerKey]?.scale : null;
  return Number.isFinite(value) ? value : 1;
}

export function scaledWeight(px, layerKey) {
  if (!Number.isFinite(px)) return px;
  const layer = layerKey ? layerStyles[layerKey] : null;
  const layerScale = Number.isFinite(layer?.scale) ? layer.scale : 1;
  return Math.max(0.5, px * globalScale * layerScale);
}

/**
 * A layer's opacity multiplier: its own setting, times its depth in the stack.
 *
 * Both, because they answer different questions. The stack fade is a statement
 * about precedence -- reference material recedes so the layers it is context for
 * can be read over it -- and the slider is a correction on top of whatever that
 * produces. Folding the fade in here rather than at each drawing site is what
 * makes it reach everything: every marker's icon, the two heat canvases, the
 * WebGL sprite buckets and the city glyphs all resolve opacity through this one
 * call.
 */
export function layerOpacity(layerKey) {
  const value = layerStyles[layerKey]?.opacity;
  const own = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1;
  return own * stackFade(layerKey);
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
    svg: paletteGlyph(style.token, style.svg),
    size: scaledSize(style.size, layerKey, style.token),
    opacity: layerOpacity(layerKey),
  };
}
