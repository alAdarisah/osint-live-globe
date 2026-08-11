// Task 30: tile tint. Pure logic only -- no DOM, no Leaflet, no React -- so it
// can run under plain `node --test` the same way adminSearch.js and
// placeInfoCardLayout.js do (see those files' own notes on why that
// constraint matters).
//
// The basemap is a raster PNG from CARTO (map/layers.js), and so is the GIBS
// imagery layer and the RainViewer/OWM weather tiles -- there is no vector
// style underneath any of them to recolour, so "tint" here is two CSS
// mechanisms layered on top of the pixels a tile server already sent:
//
//   filter        saturate/brightness/contrast/invert/blur, built by
//                 buildTileFilter below into one `filter:` value.
//   tint overlay  a full-pane ::after painted in `tintColor` at `tintStrength`
//                 opacity, composited with `blendMode` -- deliberately a
//                 mix-blend-mode overlay rather than `hue-rotate`, because
//                 hue-rotate spins every hue in the tile by the same angle
//                 (turning blue sea orange along with everything else);
//                 a blended tint colours toward one target instead.
//
// Three independent dial sets, one per pane -- basemap, imagery, weather --
// because tinting a road map and tinting a satellite mosaic are different
// jobs (see BasemapSection.jsx and style.css's own notes on how the three
// panes involved are kept apart).

// The four blend modes offered. Chosen because they are the ones a reader
// can predict without seeing the result first: multiply always darkens
// toward the tint colour, screen always lightens toward it, and overlay/
// soft-light both push contrast toward it at roughly the tile's own
// brightness. The exotic modes (difference, hue, color-burn...) can produce a
// result with no visible relationship to the colour picked, which is a worse
// control than not offering the knob at all.
export const BLEND_MODES = ["multiply", "screen", "overlay", "soft-light"];

// One target's whole dial, and what it ships as. `tintStrength: 0` is what
// makes the tint invisible regardless of `tintColor`/`blendMode` -- the two
// are only ever picked together, so leaving the colour at a real (if inert)
// default rather than null keeps the colour picker from opening blank the
// first time a reader turns the strength up.
export const DEFAULT_TILE_DIAL = Object.freeze({
  tintColor: "#000000",
  tintStrength: 0,
  blendMode: "multiply",
  saturate: 1,
  brightness: 1,
  contrast: 1,
  invert: false,
  blur: 0,
});

/**
 * The CSS `filter` value for one dial, as a single string ready for a custom
 * property.
 *
 * Only the functions that move a value away from its identity are included,
 * and the result is the literal string `"none"` when every one of them does
 * -- both so the shipped configuration (every preset starts here) sends the
 * browser the cheapest possible value rather than a no-op
 * `saturate(1) brightness(1) contrast(1) blur(0px)`, and so
 * `tests/tileTint.test.js` has one unambiguous string to assert for
 * "untouched".
 */
export function buildTileFilter(dial) {
  // Merged onto the default rather than trusted whole -- every real caller
  // passes a complete dial (mergeTileDial and defaultSettings both always
  // produce one), but a partial object here should read as "everything else
  // stayed put" rather than as `undefined` reaching a CSS function.
  const d = { ...DEFAULT_TILE_DIAL, ...(dial || {}) };
  const parts = [];
  if (d.saturate !== 1) parts.push(`saturate(${d.saturate})`);
  if (d.brightness !== 1) parts.push(`brightness(${d.brightness})`);
  if (d.contrast !== 1) parts.push(`contrast(${d.contrast})`);
  if (d.invert) parts.push("invert(1)");
  if (d.blur > 0) parts.push(`blur(${d.blur}px)`);
  return parts.length ? parts.join(" ") : "none";
}

/**
 * The six one-click starting points, in the order the panel offers them.
 *
 * Every preset is a complete dial, not a patch -- clicking one replaces
 * whatever was set before, the same way picking a shipped glyph in the icon
 * picker does. "Editable after" (see the brief) is what the sliders
 * underneath are for; a preset is where a reader starts, not a mode they
 * stay locked into.
 */
export const TILE_TINT_PRESETS = {
  default: {
    label: "Default",
    dial: { ...DEFAULT_TILE_DIAL },
  },
  muted: {
    label: "Muted",
    // A quiet grey wash and a lower saturation -- for keeping the basemap
    // out of the way of everything drawn on top of it, without going dark.
    dial: {
      tintColor: "#8a8f98",
      tintStrength: 0.18,
      blendMode: "multiply",
      saturate: 0.55,
      brightness: 1,
      contrast: 0.95,
      invert: false,
      blur: 0,
    },
  },
  highContrast: {
    label: "High contrast",
    // No tint at all -- this preset is purely the three legibility dials
    // pushed toward the readable end, for a low-light room or a projector.
    dial: {
      tintColor: "#000000",
      tintStrength: 0,
      blendMode: "multiply",
      saturate: 1.25,
      brightness: 1.05,
      contrast: 1.35,
      invert: false,
      blur: 0,
    },
  },
  night: {
    label: "Night",
    // Dark red, multiplied in hard and brightness pulled well down --
    // red-light-discipline styling, so a screen glanced at in the dark does
    // not blow out night vision the way a plain white basemap does.
    dial: {
      tintColor: "#2a0a0a",
      tintStrength: 0.55,
      blendMode: "multiply",
      saturate: 0.5,
      brightness: 0.55,
      contrast: 1.1,
      invert: false,
      blur: 0,
    },
  },
  amber: {
    label: "Amber",
    // The other classic low-light console colour, softer than Night --
    // soft-light keeps the amber from crushing the tile's own contrast the
    // way multiply would.
    dial: {
      tintColor: "#ffb000",
      tintStrength: 0.35,
      blendMode: "soft-light",
      saturate: 0.8,
      brightness: 1.05,
      contrast: 1.05,
      invert: false,
      blur: 0,
    },
  },
  print: {
    label: "Print",
    // Fully desaturated with the contrast pushed up -- what a screenshot
    // should look like reproduced on a black-and-white printer or fax, where
    // colour cannot carry any of the distinction.
    dial: {
      tintColor: "#000000",
      tintStrength: 0,
      blendMode: "multiply",
      saturate: 0,
      brightness: 1.05,
      contrast: 1.15,
      invert: false,
      blur: 0,
    },
  },
};

// The order BasemapSection renders the preset buttons in -- an object's own
// key order would happen to match this today, but an explicit list is what
// keeps that true on purpose rather than by accident of insertion order.
export const TILE_TINT_PRESET_ORDER = ["default", "muted", "highContrast", "night", "amber", "print"];

function clampNum(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * A stored (or imported, or hand-edited) dial merged onto the shipped
 * default, field by field -- the same "every value is range-checked rather
 * than trusted" rule mergeSettings applies to everything else in
 * settings/defaults.js, kept here instead of duplicated there because the
 * dial's own shape and its valid ranges are one fact, not two.
 *
 * A missing or malformed `stored` (including the whole thing being absent,
 * which is exactly what an old configuration saved before Task 30 looks
 * like) returns the shipped default rather than throwing -- that is what
 * lets mergeSettings call this unconditionally for basemap/imagery/weather
 * without first checking whether the key exists.
 */
export function mergeTileDial(stored) {
  const base = { ...DEFAULT_TILE_DIAL };
  if (!stored || typeof stored !== "object") return base;
  if (typeof stored.tintColor === "string" && HEX_COLOR_RE.test(stored.tintColor)) {
    base.tintColor = stored.tintColor;
  }
  base.tintStrength = clampNum(stored.tintStrength, base.tintStrength, 0, 1);
  if (BLEND_MODES.includes(stored.blendMode)) base.blendMode = stored.blendMode;
  base.saturate = clampNum(stored.saturate, base.saturate, 0, 2);
  base.brightness = clampNum(stored.brightness, base.brightness, 0.3, 1.7);
  base.contrast = clampNum(stored.contrast, base.contrast, 0.5, 1.5);
  base.invert = stored.invert === true;
  base.blur = clampNum(stored.blur, base.blur, 0, 3);
  return base;
}
