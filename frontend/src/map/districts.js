// The conflict record at admin-2, read through the card a district opens.
//
// hapi_conflict.py has been collecting 56,000 district-months for 32 countries
// across two years -- political violence, civilian targeting and demonstrations,
// counted separately -- and every one of them reached the browser only as a
// sentence in a country card, because the records carry no coordinates. This is
// what draws the districts themselves, joined to OCHA boundaries on p-code, and
// what answers for one of them when it is clicked.
//
// It deliberately paints nothing. A monthly archive that is weeks old by
// construction, tinted across six countries, was a second choropleth competing
// with the live map for the same eye -- and the number a reader actually wants
// is the one for the district under the cursor, which is a card's question, not
// a fill's. The counts are all still here; only the tint is gone.

import { L } from "./leafletGlobal";
import { buildShapeIndex, countryContainsPoint } from "./countryHitTest";
import { esc, fmtNumber } from "../utils/format";

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

/**
 * The districts of the one state a reader has drilled into.
 *
 * The only district geometry drawn at all, and it is drawn as the last step of a
 * selection: country, then state, then the districts inside it. So it appears
 * only where the reader is looking, and it carries no fill -- over a state that
 * is already outlined and possibly already shaded by the country choropleth, the
 * one thing left to say is where the internal lines run. A fill here would
 * invent a colour for a number nobody asked to see; the numbers are in the card
 * a district opens.
 */
export function createDistrictOutlineLayer(map) {
  // Above the subdivisions (355) and below the choropleth fills (360): these are
  // the more specific lines of the two below it, and they must not be painted
  // over by a fill that is describing the same districts.
  if (!map.getPane("districtOutlinePane")) {
    map.createPane("districtOutlinePane").style.zIndex = 358;
  }
  // One constant style, hover and selection toggled as classes on the element --
  // same reason as the subdivisions layer: Leaflet applies `className` when it
  // creates a path and never again.
  const style = {
    className: "district-outline",
    color: "#6fe3ff",
    weight: 1,
    fillColor: "#6fe3ff",
    fillOpacity: 0,
    interactive: false,
  };
  return L.geoJSON(null, { style: () => style, pane: "districtOutlinePane" });
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

export function buildDistrictIndex(features) {
  return buildShapeIndex(features, (props) => ({
    pcode: props.pcode,
    name: props.name || "",
    admin1: props.admin1 || "",
    country_code: props.country_code || "",
  }));
}

export function findDistrictAt(index, lat, lon) {
  for (const entry of index) {
    if (countryContainsPoint(entry, lat, lon)) return entry;
  }
  return null;
}

/**
 * The month selector that rides on the card.
 *
 * This is the whole archive control now that nothing is painted: no metric to
 * choose, because all four counts are shown at once, and no layer-wide coverage
 * tally, because the card is answering about one district rather than about the
 * layer. The change handler is bound by the controller after the content is set
 * -- see bindDistrictMonthSelect in createMapController.js -- because this is a
 * string of HTML and cannot carry one.
 *
 * Omitted entirely when the months list has not arrived: a selector with one
 * option nobody chose is furniture.
 */
function monthPickerHtml(month, months) {
  if (!months.length) return "";
  const options = months
    .map((m) => `<option value="${esc(m)}"${m === month ? " selected" : ""}>${esc(m)}</option>`)
    .join("");
  return `<label class="district-month">Month
    <select class="district-month-select">${options}</select></label>`;
}

/**
 * What a clicked district says.
 *
 * All four counts, every time. They are three different things HAPI counts
 * separately -- and deaths -- so showing one and hiding the rest behind a
 * control would make a reader click twice to learn what one request already
 * fetched.
 *
 * `record` is null for a district the archive has no row for in this month --
 * distinct from a row of zeros, and said in those words, because the whole
 * archive rests on that difference. `loading` is the third state and is kept
 * apart from both: a month whose counts are still in flight must not read as a
 * month with no record.
 */
export function districtPopupHtml(entry, state = {}) {
  const { record = null, month = null, months = [], loading = false } = state;
  const where = [entry.admin1, entry.country_code].filter(Boolean).join(" &middot; ");
  const head = `
    <h3>${esc(entry.name || entry.pcode)}</h3>
    <div class="meta">${where}${entry.pcode ? ` &middot; ${esc(entry.pcode)}` : ""}</div>
    ${monthPickerHtml(month, months)}`;
  const provenance = `<div class="meta">ACLED via HDX HAPI, joined to OCHA COD-AB boundaries on
    p-code. A monthly archive that runs to the end of a past month &mdash; not the live conflict
    layer, and not comparable to it.</div>`;
  if (loading) {
    return `${head}
      <div class="meta district-loading">Loading ${esc(month || "the archive")}&hellip;</div>
      ${provenance}`;
  }
  if (!record) {
    return `${head}
      <div class="meta district-nodata">No record for ${esc(month || "this month")}.
        That is different from a reported zero &mdash; this district is not in the archive for this
        month, so nothing is claimed about it either way.</div>
      ${provenance}`;
  }
  const rows = DISTRICT_METRICS.map((m) => {
    const value = Number(m.valueOf(record)) || 0;
    return `<div class="district-row"><span>${esc(m.label)}</span><b>${fmtNumber(value)}</b></div>`;
  }).join("");
  return `${head}
    <div class="meta">Reviewed record for <b>${esc(record.month || month || "")}</b></div>
    <div class="district-rows">${rows}</div>
    <div class="meta">Demonstrations are counted separately and are not part of the violence totals.</div>
    ${provenance}`;
}
