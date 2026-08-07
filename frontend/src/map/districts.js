// The conflict record at admin-2, painted on district boundaries.
//
// hapi_conflict.py has been collecting 56,000 district-months for 32 countries
// across two years -- political violence, civilian targeting and demonstrations,
// counted separately -- and every one of them reached the browser only as a
// sentence in a country card, because the records carry no coordinates. This is
// the layer that draws them, joined to OCHA boundaries on p-code.
//
// Deliberately a separate module from choropleth.js even though both paint
// polygons by a number. That one answers "how does this country compare to
// other countries" over four national datasets; this one answers "where inside
// this country" over one subnational dataset, and it has a month rather than a
// present tense. Sharing the ramp is right; sharing the metric list would put
// two unrelated vocabularies in one selector.

import { L } from "./leafletGlobal";
import { rampColor, rampSwatches } from "./choropleth";
import { countryContainsPoint } from "./countryHitTest";
import { esc, fmtNumber } from "../utils/format";

// Which countries have stored geometry. Kept in step with COUNTRIES in
// backend/sources/admin2_boundaries.py -- asking for a country with no boundary
// file returns an empty collection, so a drift here costs a wasted request
// rather than a broken layer.
export const DISTRICT_COUNTRIES = ["AFG", "VEN", "YEM", "SDN", "COD", "UKR"];

// The three counts HAPI reports separately, kept separate here.
//
// `events` and `fatalities` deliberately exclude demonstrations -- see
// hapi_conflict.py, which keeps them out of the headline totals because this
// app's conflict layer is violence-only. Offering demonstrations as its own
// metric rather than folding it in is the same distinction, made visible.
export const DISTRICT_METRICS = [
  {
    id: "fatalities",
    label: "Deaths",
    valueOf: (r) => r.fatalities,
    format: (v) => `${v.toLocaleString()} deaths`,
  },
  {
    id: "political_violence",
    label: "Political violence",
    valueOf: (r) => r.political_violence,
    format: (v) => `${v.toLocaleString()} events`,
  },
  {
    id: "civilian_targeting",
    label: "Violence against civilians",
    valueOf: (r) => r.civilian_targeting,
    format: (v) => `${v.toLocaleString()} events`,
  },
  {
    id: "demonstration",
    label: "Demonstrations",
    valueOf: (r) => r.demonstration,
    format: (v) => `${v.toLocaleString()} events`,
  },
];

export function districtMetricById(id) {
  return DISTRICT_METRICS.find((m) => m.id === id) || DISTRICT_METRICS[0];
}

export { rampSwatches };

/**
 * Index one month's district counts by p-code.
 *
 * Keyed on `admin2_code` with a fallback to parsing it out of `id`, because the
 * two are the same value and older stored records carry only the second: the
 * source folded the p-code into `hapi-<ISO3>-<PCODE>-<YYYY-MM>` long before it
 * kept it as a field. Reading both means the layer works against data collected
 * before that change rather than waiting a poll cycle to light up.
 */
export function indexDistrictCounts(records) {
  const byPcode = new Map();
  for (const r of records || []) {
    const pcode = r.admin2_code || String(r.id || "").split("-")[2];
    if (pcode) byPcode.set(pcode, r);
  }
  return byPcode;
}

// Log-scaled, like the national conflict metrics: district counts run from 0 to
// several hundred within one country and a linear ramp leaves everything except
// the worst district at the bottom of the scale.
//
// Zero is painted, at the very bottom of the ramp, and that is the point of
// this layer as much as the peaks are: a district reporting zero deaths this
// month is a fact, and it must not look like a district nobody reported on.
// Districts with no record at all are left unpainted -- same distinction the
// country choropleth draws, for the same reason.
export function buildDistrictScale(metric, counts) {
  const values = [];
  for (const record of counts.values()) {
    const v = Number(metric.valueOf(record));
    if (Number.isFinite(v)) values.push(v);
  }
  const max = values.length ? Math.max(...values) : 0;
  const span = Math.log1p(Math.max(max, 1));
  return (value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    return span > 0 ? Math.log1p(Math.max(v, 0)) / span : 0;
  };
}

const MIN_FILL_OPACITY = 0.2;
const MAX_FILL_OPACITY = 0.75;

/**
 * @param getFill (pcode) => {fillColor, fillOpacity} | null
 */
export function createDistrictsLayer(map, getFill = () => null) {
  // Between the country shapes (350) and the uncertainty circles (380): a
  // district fill has to sit over its own country's fill, and under everything
  // that marks a specific place.
  if (!map.getPane("districtsPane")) {
    map.createPane("districtsPane").style.zIndex = 360;
  }
  function districtStyle(feature) {
    const fill = getFill(feature?.properties?.pcode);
    return {
      className: "district-shape",
      // A hairline boundary at low opacity, unlike the country shapes' fully
      // transparent stroke. Countries are legible from their coastlines; a
      // district is only distinguishable from its neighbour by the line
      // between them, and a choropleth of unseparated blobs cannot be read.
      color: "rgba(255,255,255,0.18)",
      weight: 0.5,
      fillColor: (fill && fill.fillColor) || "#6fe3ff",
      fillOpacity: fill ? fill.fillOpacity : 0,
      // Same reasoning as the country shapes (see layers.js): hit-testing is
      // done against the geometry from the map's own click handler, so a fill
      // must never intercept a click meant for a pin on top of it.
      interactive: false,
    };
  }
  return L.geoJSON(null, { style: districtStyle, pane: "districtsPane" });
}

// ---------- hit-testing ----------
//
// Same arrangement the country shapes use, and for the same reason: the
// polygons are drawn `interactive: false` and clicks are resolved against the
// geometry from the map's own handler, so a fill can never swallow a click
// meant for a pin sitting on top of it (see countryHitTest.js).
//
// The point-in-polygon test itself is countryContainsPoint, reused rather than
// reimplemented -- it is the only hard part of this, holes and antimeridian
// wrapping included, and a second copy is how the two would drift.
//
// Deliberately a flat scan rather than the smallest-area-first ordering
// findCountryAt needs. That ordering exists so enclaves wholly inside another
// country stay selectable; districts partition their country rather than nest
// inside one another, so first-match-wins over any order is already correct.
// Cost is one bounding-box comparison per district -- 1,563 of them for the six
// covered countries, and only the one or two that pass go on to a ring test.

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

export function buildDistrictIndex(features) {
  const entries = [];
  for (const feature of features || []) {
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) continue;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const rings of polygons) {
      for (const [lon, lat] of rings[0] || []) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    if (!Number.isFinite(minLat)) continue;
    const props = feature.properties || {};
    entries.push({
      pcode: props.pcode,
      name: props.name || "",
      admin1: props.admin1 || "",
      country_code: props.country_code || "",
      polygons,
      bbox: { minLat, maxLat, minLon, maxLon },
    });
  }
  return entries;
}

export function findDistrictAt(index, lat, lon) {
  for (const entry of index) {
    if (countryContainsPoint(entry, lat, lon)) return entry;
  }
  return null;
}

/**
 * What a clicked district says.
 *
 * All four counts, not only the one being painted. The metric selector chooses
 * what the *map* shades; a reader who has clicked a specific district is asking
 * about that district, and answering with one number out of four they can see
 * in the dropdown would make them change the shading and click again to read
 * the rest. The painted one is marked so the popup and the map agree about
 * which number produced the colour.
 *
 * `record` is null for a district the archive has no row for in this month --
 * distinct from a row of zeros, and said in those words, because the whole
 * layer rests on that difference.
 */
export function districtPopupHtml(entry, record, month, metricId) {
  const where = [entry.admin1, entry.country_code].filter(Boolean).join(" &middot; ");
  const head = `
    <h3>${esc(entry.name || entry.pcode)}</h3>
    <div class="meta">${where}${entry.pcode ? ` &middot; ${esc(entry.pcode)}` : ""}</div>`;
  if (!record) {
    return `${head}
      <div class="meta district-nodata">No record for ${esc(month || "this month")}.
        That is different from a reported zero &mdash; this district is not in the archive for this
        month, so nothing is claimed about it either way.</div>
      <div class="meta">Source: ACLED via HDX HAPI &middot; boundary: OCHA COD-AB</div>`;
  }
  const rows = DISTRICT_METRICS.map((m) => {
    const value = Number(m.valueOf(record)) || 0;
    const active = m.id === metricId;
    return `<div class="district-row${active ? " district-row-active" : ""}">
      <span>${esc(m.label)}</span><b>${fmtNumber(value)}</b></div>`;
  }).join("");
  return `${head}
    <div class="meta">Reviewed record for <b>${esc(record.month || month || "")}</b></div>
    <div class="district-rows">${rows}</div>
    <div class="meta">Demonstrations are counted separately and are not part of the violence totals.</div>
    <div class="meta">ACLED via HDX HAPI, joined to OCHA COD-AB boundaries on p-code. A monthly
      archive that runs to the end of a past month &mdash; not the live conflict layer.</div>`;
}

/** The fill for one district's value, or null when it has no record. */
export function districtFill(position) {
  if (position === null) return null;
  return {
    fillColor: rampColor(position),
    fillOpacity: MIN_FILL_OPACITY + (MAX_FILL_OPACITY - MIN_FILL_OPACITY) * position,
  };
}
