// Painting the country shapes by a number.
//
// Four country-keyed datasets were already being fetched, polled and then
// rendered only as sentences inside the country card (see popups.js): IODA's
// outage scores, UNHCR/HAPI's displacement and food-security figures, HDX's
// monthly conflict counts, and the HDI/density/population carried on the
// country features themselves. All of them are national aggregates, which is
// exactly what a country shape can express and a pin cannot -- so this module
// turns them into a fill, and the card goes on saying the precise numbers.
//
// One rule holds across every metric: **more paint means more distress**. HDI
// is therefore inverted, because a low human-development index is the bad end
// while a high fatality count is. Without that the legend would have to be read
// afresh for every metric, and a reader scanning for trouble would be misled by
// whichever one happened to run the other way.
//
// The metric list lives here rather than in layers.js for the same reason the
// severity bands live in severity.js: the map paints from it, the panel builds
// its selector and legend from it, and a second copy is how those two drift.

import { normalizeCountryName } from "./popups";
import { paletteColor } from "./iconTheme";

// --- value extraction --------------------------------------------------
//
// Each metric says how to get its number out of one country feature. Returning
// null means "this country has no value", which is deliberately distinct from
// returning 0 -- see the note on colourFor below. Every accessor is written to
// return null rather than throw or coerce, because all four sources have
// partial coverage and a NaN in a colour ramp paints an undefined fill.

/**
 * A number, or null when the field is absent.
 *
 * The explicit null/undefined/"" guard is load-bearing rather than defensive:
 * `Number(null)` is 0 and `Number.isFinite(0)` is true, so a coercion-only
 * check reports every country missing a field as measuring zero. That is the
 * one mistake this module exists to avoid, and it fails worst on the inverted
 * metric -- the 14 countries with no HDI were being painted as the lowest human
 * development on earth.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * HDX's 24 monthly rows for a country, matched by normalised name.
 *
 * The name index is built once per pass and handed in through `ctx` rather than
 * cached on `raw.conflictStats`: that object is the country card's own data,
 * and a module that only wants to *read* a feed should not be leaving fields on
 * it. Rebuilding 243 entries per pass is microseconds; doing the normalise
 * inside a find() per country would not be, which is the only thing the index
 * is here to avoid.
 */
function hdxSeries(props, raw, ctx) {
  const wanted = normalizeCountryName(props.name);
  if (!wanted || !ctx.hdxByNorm) return null;
  const series = ctx.hdxByNorm[wanted];
  return Array.isArray(series) ? series : null;
}

const FATALITY_MONTHS = 12;

function conflictFatalities(props, raw, ctx) {
  const series = hdxSeries(props, raw, ctx);
  if (!series || !series.length) return null;
  return series
    .slice(-FATALITY_MONTHS)
    .reduce((sum, row) => sum + (numberOrNull(row.fatalities) || 0), 0);
}

// UNHCR counts these by country of *origin* -- people this country's situation
// has displaced, wherever they now are -- which is what the country card
// already says in words. Painting it therefore colours the source of a
// displacement crisis, not the countries hosting its people, and the legend has
// to say so or the map states the opposite of what the data means.
function displacedTotal(props, raw) {
  const record = (raw.humanitarian || {})[props.iso_a3];
  const d = record && record.displacement;
  if (!d) return null;
  const parts = [d.refugees, d.asylum_seekers, d.idps].map(numberOrNull);
  // A country reporting some of the three but not all is summed over what it
  // does report; one reporting none of them has no value at all.
  if (parts.every((v) => v === null)) return null;
  return parts.reduce((sum, v) => sum + (v || 0), 0);
}

function foodCrisis(props, raw) {
  const record = (raw.humanitarian || {})[props.iso_a3];
  const food = record && record.food_security;
  return food ? numberOrNull(food.population_in_crisis) : null;
}

// Natural Earth ships "-99" as the ISO2 of five features (Norway, France,
// Northern Cyprus, Somaliland, Kosovo), so a code-only lookup drops them. Same
// two-step resolution outageFor() in popups.js and rebuildOutagePoints() in
// createMapController.js already use, for the same reason: the name is tried
// only when there is no usable code, since a country that has an ISO2 and is
// absent from the dict genuinely has no outage.
function outageScore(props, raw) {
  const outages = raw.outages || {};
  const code = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null;
  let record = code ? outages[code] : null;
  if (!record && !code) {
    const wanted = normalizeCountryName(props.name);
    record = wanted
      ? Object.values(outages).find((o) => normalizeCountryName(o.country) === wanted)
      : null;
  }
  return record ? numberOrNull(record.score) : null;
}

function featureNumber(key) {
  return (props) => numberOrNull(props[key]);
}

// --- the metrics -------------------------------------------------------

export const CHOROPLETH_METRICS = [
  {
    id: "conflict_fatalities",
    label: "Conflict deaths, 12 months",
    scale: "log",
    valueOf: conflictFatalities,
    format: (v) => `${Math.round(v).toLocaleString()} deaths`,
    note: "ACLED monthly totals via HDX, summed over the last 12 months. A reviewed"
      + " historical record, not the live layer.",
  },
  {
    id: "displacement",
    label: "People displaced",
    scale: "log",
    valueOf: displacedTotal,
    format: (v) => `${Math.round(v).toLocaleString()} people`,
    note: "Refugees, asylum seekers and internally displaced, counted by UNHCR by country"
      + " of ORIGIN — this paints where a displacement crisis comes from, not where its"
      + " people now are.",
  },
  {
    id: "food_crisis",
    label: "Food crisis (IPC 3+)",
    scale: "log",
    valueOf: foodCrisis,
    format: (v) => `${Math.round(v).toLocaleString()} in crisis or worse`,
    note: "IPC phase 3 or worse via HDX HAPI. Assessed in only a handful of countries, so"
      + " most of the map is unpainted for want of an assessment rather than for want of"
      + " hunger.",
  },
  {
    id: "outages",
    label: "Internet outage",
    // Percentile rank, never a linear ramp. IODA's score is an unbounded
    // composite of three detection methods -- the single value currently in the
    // feed is 1.0e10 -- so a linear scale renders one saturated country and 176
    // blanks, which says nothing about any of them.
    scale: "rank",
    valueOf: outageScore,
    format: (v) => `IODA score ${v.toExponential(2)}`,
    note: "IODA's composite outage score over a trailing 24 hours. Ranked rather than"
      + " scaled: the score is unbounded, so only the ordering is meaningful.",
  },
  {
    id: "hdi",
    scale: "linear",
    // The one metric where low is the bad end, inverted so that the whole
    // selector keeps one meaning: more paint, more distress.
    invert: true,
    label: "Human development (low = strong)",
    valueOf: featureNumber("hdi"),
    format: (v) => `HDI ${v.toFixed(3)}`,
    note: "UNDP Human Development Index. Inverted, so the strongest fill is the lowest"
      + " index — consistent with every other metric here.",
  },
  {
    id: "density",
    scale: "log",
    label: "Population density",
    valueOf: featureNumber("density"),
    format: (v) => `${Math.round(v).toLocaleString()} people/km²`,
    note: "People per square kilometre. Context rather than distress — the one metric here"
      + " that is not a measure of harm.",
  },
];

export function metricById(id) {
  return CHOROPLETH_METRICS.find((m) => m.id === id) || null;
}

// --- colour ------------------------------------------------------------
//
// A three-stop ramp, deliberately clear of the two ramps the map already uses:
// severity's yellow-to-red (severity.js) and reliability's green-to-red. Those
// both live on pins; this covers whole countries, so sharing a colour language
// with either would make a busy country read as one enormous severity chip.
//
// Magnitude is carried by opacity as well as hue. A single hue at one opacity
// has to lean on lightness alone to say "more", which the semi-transparent fill
// over two different basemaps cannot reliably deliver.
const RAMP_STOPS = [
  { token: "choropleth.low", value: "#2dd4bf" },
  { token: "choropleth.mid", value: "#6366f1" },
  { token: "choropleth.high", value: "#c026d3" },
];

const MIN_FILL_OPACITY = 0.18;
const MAX_FILL_OPACITY = 0.62;

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Position 0..1 along the three-stop ramp, honouring Admin Mode overrides.
 *
 * Exported so the district layer (districts.js) paints from the same ramp. The
 * two layers answer different questions but they are both "a polygon shaded by
 * a number", and giving the subnational one its own colours would mean a reader
 * had to learn a second scale to read the same kind of picture one zoom level
 * further in.
 */
export function rampColor(t) {
  const stops = RAMP_STOPS.map((s) => hexToRgb(paletteColor(s.token, s.value)));
  const clamped = Math.min(Math.max(t, 0), 1);
  const span = 1 / (stops.length - 1);
  const i = Math.min(Math.floor(clamped / span), stops.length - 2);
  const local = (clamped - i * span) / span;
  const a = stops[i];
  const b = stops[i + 1];
  return rgbToHex([0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * local));
}

// --- building a paint pass ---------------------------------------------

/**
 * Resolve one metric over the current country features and current data.
 *
 * Returns a `styleFor(props)` the layer can hand straight to Leaflet, plus the
 * coverage numbers the panel needs to say how much of the world this metric
 * actually knows about. That count is not decoration: four of the six metrics
 * have partial coverage, and a reader looking at a mostly-blank map is entitled
 * to know whether that means "no harm here" or "nobody has measured here".
 *
 * @param metricId  one of CHOROPLETH_METRICS' ids, or null for no fill
 * @param features  the country GeoJSON features currently loaded
 * @param raw       the map controller's live data buckets
 */
export function buildChoropleth(metricId, features, raw) {
  const metric = metricById(metricId);
  if (!metric || !features || !features.length) {
    return { metric: null, styleFor: () => null, covered: 0, total: features ? features.length : 0 };
  }

  // Indexes the accessors need, built once per pass and never written back to
  // `raw` -- see hdxSeries.
  const ctx = {};
  if (metric.id === "conflict_fatalities") {
    ctx.hdxByNorm = {};
    for (const [name, series] of Object.entries(raw.conflictStats || {})) {
      ctx.hdxByNorm[normalizeCountryName(name)] = series;
    }
  }

  const values = new Map();
  for (const f of features) {
    const v = metric.valueOf(f.properties, raw, ctx);
    if (v !== null && Number.isFinite(v)) values.set(f.properties, v);
  }

  const present = [...values.values()];
  const positionOf = makePositioner(metric, present);

  return {
    metric,
    covered: present.length,
    total: features.length,
    /**
     * Null means "no value" and the caller leaves the shape unpainted, which is
     * how an unmeasured country stays visually distinct from one measured at
     * zero. Those are different claims and the map must not merge them.
     */
    styleFor(props) {
      const value = values.get(props);
      if (value === undefined) return null;
      const t = positionOf(value);
      return {
        fillColor: rampColor(t),
        fillOpacity: MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * t,
        value,
      };
    },
  };
}

/**
 * How a raw value maps to 0..1 along the ramp, per the metric's own scale.
 *
 *   rank    percentile among the countries that have a value. The only honest
 *           reading of an unbounded score.
 *   log     counts spanning orders of magnitude -- 12 deaths and 12,000 both
 *           need to be distinguishable, which a linear ramp cannot do.
 *   linear  a bounded index.
 *
 * A metric whose values are all identical positions everything at the top
 * rather than dividing by a zero range: with one country reporting, that one
 * country is the whole of what is known, and painting it faintly would
 * understate the only data point there is.
 */
function makePositioner(metric, present) {
  if (!present.length) return () => 0;

  if (metric.scale === "rank") {
    const sorted = [...present].sort((a, b) => a - b);
    return (v) => {
      if (sorted.length === 1) return 1;
      const below = sorted.filter((x) => x < v).length;
      return below / (sorted.length - 1);
    };
  }

  const transform = metric.scale === "log" ? (v) => Math.log1p(Math.max(v, 0)) : (v) => v;
  const mapped = present.map(transform);
  const min = Math.min(...mapped);
  const max = Math.max(...mapped);
  const range = max - min;
  return (v) => {
    const t = range > 0 ? (transform(v) - min) / range : 1;
    return metric.invert ? 1 - t : t;
  };
}

/** The ramp as swatches, for the panel's legend. */
export function rampSwatches(steps = 5) {
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 1 : i / (steps - 1);
    return {
      t,
      color: rampColor(t),
      opacity: MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * t,
    };
  });
}
