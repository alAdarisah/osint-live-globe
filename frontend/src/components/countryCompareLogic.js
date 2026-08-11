// Pure logic behind CountryCompareView.jsx -- turning two or three already-
// selected countries' own `props`/`bounds` plus the map controller's shared
// `raw` data bucket into aligned table rows. Plain JS, no JSX and no window/
// Leaflet dependency of its own, for the same reason every other *PanelLogic.js
// module in this directory is: the project's headless test suite (`node
// --test`, no build step) cannot import JSX at all -- see
// frontend/tests/countryCompare.test.js. (Importing map/popups.js below does
// pull in map/decorators.js, which touches window.L at module scope -- the
// test file stubs that the same way countryCardSections.test.js already does,
// rather than this module reimplementing itemsInBounds/coverageStateFor/
// recentConflictStats a second time and risking the two answers drifting
// apart. See intelPanelLogic.js for the same trade-off made the same way.)
//
// The central problem this module exists to solve: countryCardSections
// (map/popups.js) renders a country as one HTML string per section, and its
// own statRow helper drops a falsy value -- including a real, checked zero --
// rather than print it, which is the right call for a single card (a zero
// tells a lone reader nothing extra) and the wrong one for a comparison
// table, where "France: 0" and "France: not checked" must never render the
// same way. So this module does not touch statRow, does not parse the HTML
// countryCardSections builds, and does not reuse its output at all -- it goes
// back to the same `raw` buckets the card reads and asks each metric for a
// *typed* cell instead of a string: a real value (CELL_STATUS.VALUE, which
// includes zero), a source that does not cover this country
// (NOT_COLLECTED), a feed this session has not fetched yet or fetched for
// somewhere else (NOT_LOADED), or a metric that cannot apply to this shape at
// all (NOT_APPLICABLE, e.g. a territory with no ISO3 code to match a source
// keyed on one). Those four are exactly the brief's own list, and every
// metric below returns one of them and nothing else.

import { itemsInBounds, coverageStateFor, recentConflictStats } from "../map/popups.js";
import { classifyAircraft, classifyShip } from "../map/decorators.js";
import { fmtNumber } from "../utils/format.js";

// Two or three -- the brief's own words. A fourth (or fifth, ...) selected
// country is not an error; selectCompareCountries below is where "what
// happens at four or more" is decided, explicitly, rather than left for the
// table to overflow or silently drop someone with no explanation on screen.
export const MIN_COMPARE_COUNTRIES = 2;
export const MAX_COMPARE_COUNTRIES = 3;

export const CELL_STATUS = {
  VALUE: "value",
  NOT_COLLECTED: "not-collected",
  NOT_LOADED: "not-loaded",
  NOT_APPLICABLE: "not-applicable",
};

// The one sentence every empty cell in this table falls back to, by status --
// a single home for the wording (per this task's own brief: "put the string
// in the pure module rather than composing it inline in JSX") so the table
// and any tooltip built on top of it can never say something different from
// what actually happened. Each metric's own compute() can still supply a more
// specific reason (see NOT_LOADED_REASON below); this is only the fallback
// for a metric that has nothing more specific to say.
const STATUS_TEXT = {
  [CELL_STATUS.NOT_COLLECTED]: "Not covered by this source for this country.",
  [CELL_STATUS.NOT_LOADED]: "Not checked yet.",
  [CELL_STATUS.NOT_APPLICABLE]: "Does not apply to this country.",
};

/** One table cell: a real value (possibly 0) or one of the three reasons
 *  there isn't one. `value` is the raw number (never a formatted string --
 *  see formatCellValue), null for every non-VALUE status. */
function cell(status, value, reason) {
  return { status, value, reason: reason || (status === CELL_STATUS.VALUE ? null : STATUS_TEXT[status]) };
}

// The two coverageStateFor reasons (map/popups.js) that both mean "this map
// has not looked here yet", worded the same way that module's own
// coverageReason does for the identical two states -- restated rather than
// imported, since coverageReason itself is not exported (it composes HTML-
// register text for the card's tooltips, this module never touches HTML).
const NOT_LOADED_REASON = {
  not_loaded: "Not loaded this session yet -- this feed has not been fetched.",
  scoped_elsewhere: "Fetched, but only for a different area -- not checked here yet.",
};

const NO_BOUNDS_REASON =
  "This country's boundary has not finished loading yet, so nothing in its area could be checked.";

/**
 * A bbox-scoped metric's cell: NOT_LOADED if there is no bounds to check
 * against yet, or if coverageStateFor says this feed has not been fetched
 * (or was fetched for somewhere else); otherwise VALUE, from `valueFn`.
 *
 * `valueFn` is only ever called once coverage is confirmed "checked" -- the
 * same discipline recentConflictStats' own callers in map/popups.js follow,
 * so a metric here can never read a false zero out of an unfetched feed.
 */
function boundedStat(feedKey, bounds, raw, valueFn) {
  if (!bounds) return cell(CELL_STATUS.NOT_LOADED, null, NO_BOUNDS_REASON);
  const state = coverageStateFor(feedKey, bounds, raw);
  if (state !== "checked") return cell(CELL_STATUS.NOT_LOADED, null, NOT_LOADED_REASON[state]);
  return cell(CELL_STATUS.VALUE, valueFn(), null);
}

/** The bbox-scoped count case (fires, military aircraft, navy vessels): the
 *  same itemsInBounds every count-based section of the country card itself
 *  counts with, so this table can never disagree with that card about how
 *  many of something sit inside the same country's box. */
function boundedCount(feedKey, bounds, raw, predicate) {
  return boundedStat(feedKey, bounds, raw, () => itemsInBounds(raw[feedKey] || [], bounds, predicate).length);
}

/** A country-feature field (population, HDI): VALUE if the source published
 *  one, NOT_COLLECTED (with the given reason) if it did not. There is no
 *  NOT_LOADED case here -- unlike a polled feed, these fields arrive on the
 *  same boundary fetch that makes a country selectable at all (see
 *  backend/sources/countries.py's own enrichment pass), so by the time a
 *  country can be added to a comparison its `props` are already whatever
 *  they will be for this session. */
function recordField(value, notCollectedReason) {
  return value != null
    ? cell(CELL_STATUS.VALUE, value, null)
    : cell(CELL_STATUS.NOT_COLLECTED, null, notCollectedReason);
}

/**
 * Refugees by country of origin -- the one metric here with a real
 * NOT_APPLICABLE case: a shape with no ISO3 code (Natural Earth's "-99"
 * territories) can never be matched against UNHCR's country-keyed records,
 * which is a structurally different fact from "UNHCR has data for other
 * countries but not this one" (NOT_COLLECTED, below). Mirrors
 * refugeesTile's own three-way split in map/popups.js exactly, so the
 * summary strip on a single card and this table's own row can never disagree
 * about which of the three applies to a given country.
 */
function refugeesCell(props, raw) {
  if (!props.iso_a3) {
    return cell(
      CELL_STATUS.NOT_APPLICABLE, null,
      "This shape carries no ISO3 code to match against UNHCR's country keys."
    );
  }
  // Unscoped, like refugeesTile's own check -- humanitarian.py's payload is
  // never bbox-limited, so there is no "scoped elsewhere" for this feed, only
  // "fetched" or "not yet".
  const state = coverageStateFor("humanitarian", null, raw);
  if (state !== "checked") return cell(CELL_STATUS.NOT_LOADED, null, NOT_LOADED_REASON[state]);
  const refugees = (raw.humanitarian || {})[props.iso_a3]?.displacement?.refugees;
  if (refugees == null) {
    return cell(CELL_STATUS.NOT_COLLECTED, null, "UNHCR has not reported a refugee figure for this country.");
  }
  return cell(CELL_STATUS.VALUE, refugees, null);
}

/**
 * The eight rows this table shows, chosen deliberately narrow rather than
 * mirroring every fold on the country card:
 *
 *  - A list of recent events (the card's own "Recent events" fold) is not a
 *    row a table can align -- there is no single number to compare.
 *  - A metric only one source covers well (cross-border electricity is
 *    ENTSO-E/Europe-only; sub-national IODA scores need a matched admin-1
 *    shape) would read as "country A is worse" when the truth is "country B
 *    just is not in this source" -- exactly the ranking-by-coverage trap
 *    this task's brief warns against, so those are left off rather than
 *    shipped with a caveat nobody will read before comparing two numbers.
 *  - Naval presence (buildMilitary's own navalPresenceHtml) is reported per
 *    conflict *theatre*, not per country -- its own text says a hull
 *    anywhere in a theatre box counts for every country touching it, which
 *    makes it actively misleading side by side with a metric that really is
 *    per-country. Left out for the same reason.
 *
 * What is left spans this project's whole four-word provenance vocabulary on
 * purpose, so no reader can mistake this table for one register of evidence:
 * population/HDI/events/fatalities/refugees are *reported* by a named body;
 * fire detections are *measured* by satellite; navy vessels are *derived*
 * from a broadcast ship-type code (buildMilitary's own words); military
 * aircraft are *inferred* from callsign/registry heuristics (also
 * buildMilitary's own words) rather than a confirmed flag. Each row carries
 * its own word rather than the table claiming one register for all eight.
 */
const METRICS = [
  {
    id: "population", label: "Population", unit: null, provenance: "reported", source: "World Bank",
    compute: (c) => recordField(c.props.population, "Not published for this country (World Bank)."),
  },
  {
    id: "hdi", label: "Human Development Index", unit: null, provenance: "reported", source: "UNDP",
    compute: (c) => recordField(c.props.hdi, "Not published for this country (UNDP)."),
  },
  {
    id: "conflictEvents72h", label: "Conflict events, last 72h", unit: "events", provenance: "reported", source: "ACLED",
    compute: (c, raw) => boundedStat("events", c.bounds, raw, () => recentConflictStats(c.bounds, raw).count),
  },
  {
    id: "conflictFatalities72h", label: "Conflict fatalities, last 72h", unit: "killed", provenance: "reported", source: "ACLED",
    compute: (c, raw) => boundedStat("events", c.bounds, raw, () => recentConflictStats(c.bounds, raw).fatalities),
  },
  {
    id: "fires", label: "Active fire detections", unit: "fires", provenance: "measured", source: "NASA FIRMS / HMS",
    compute: (c, raw) => boundedCount("firms", c.bounds, raw, undefined),
  },
  {
    id: "militaryAircraft", label: "Military aircraft in/near country", unit: "aircraft", provenance: "inferred",
    source: "ADS-B, classified by callsign/registry heuristics",
    compute: (c, raw) => boundedCount("adsb", c.bounds, raw, (a) => classifyAircraft(a) === "military"),
  },
  {
    id: "navyVessels", label: "Navy vessels in/near country", unit: "vessels", provenance: "derived",
    source: "AIS, classified by broadcast ship-type code",
    compute: (c, raw) => boundedCount("ais", c.bounds, raw, (s) => classifyShip(s) === "navy"),
  },
  {
    id: "refugeesOrigin", label: "Refugees, by country of origin", unit: "refugees", provenance: "reported", source: "UNHCR",
    compute: (c, raw) => refugeesCell(c.props, raw),
  },
];

export const COMPARE_METRICS = METRICS;

/** `value` formatted for display -- HDI to three decimals (matching the
 *  country card's own `props.hdi.toFixed(3)`), everything else through
 *  fmtNumber's thousands separator. Null in, null out: a non-VALUE cell has
 *  nothing to format and the caller renders its `reason` instead. */
function formatCellValue(metricId, value) {
  if (value == null) return null;
  if (metricId === "hdi") return value.toFixed(3);
  return fmtNumber(value);
}

/**
 * One row: a metric's own cell for every selected country, in the same
 * order, plus whether the row is fit to compare at all (`comparable`,
 * meaning every cell is a real value) and, only when it is, whether those
 * values actually differ (`differs`).
 *
 * `differs` is deliberately just a boolean, not a rank or a "which one is
 * higher" -- see buildCountryComparison's own note on why this table never
 * says which country's number is worse. A row with any non-VALUE cell is
 * never marked `differs`: a real 12 next to "not covered by this source" is
 * not a comparison, it is one country having a number and the other not
 * being in the source, and highlighting that as a "difference" would be
 * exactly the coverage-read-as-a-finding mistake this task's brief calls out
 * by name.
 */
export function buildComparisonRow(metric, countries, raw) {
  const cells = countries.map((c) => metric.compute(c, raw || {}));
  const comparable = cells.every((c) => c.status === CELL_STATUS.VALUE);
  const differs = comparable && new Set(cells.map((c) => c.value)).size > 1;
  return {
    id: metric.id,
    label: metric.label,
    unit: metric.unit,
    provenance: metric.provenance,
    source: metric.source,
    cells: cells.map((c) => ({ ...c, formatted: formatCellValue(metric.id, c.value) })),
    comparable,
    differs,
  };
}

/**
 * `countries`, capped to MAX_COMPARE_COUNTRIES in the order given (the same
 * click order countrySelection.js/reportCountrySelection already preserves),
 * plus whoever got dropped by the cap.
 *
 * This is the whole answer to "what happens at four or more selected": the
 * table always compares the first two or three, never guesses which ones the
 * reader meant, and the caller is expected to say on screen who was left out
 * (see truncationNote below) rather than let a fourth column silently
 * squeeze the layout or a fourth country silently vanish with nothing said.
 */
export function selectCompareCountries(countries) {
  const list = Array.isArray(countries) ? countries : [];
  return {
    countries: list.slice(0, MAX_COMPARE_COUNTRIES),
    omitted: list.slice(MAX_COMPARE_COUNTRIES),
  };
}

/**
 * The full comparison payload for a `countries` list of
 * `{key, name, props, bounds}` entries (props/bounds as countryCardSections
 * itself takes -- see countryCompareRows in map/createMapController.js for
 * where these come from) against the controller's shared `raw` bucket.
 *
 * @returns {{countries: {key,name}[], omittedNames: string[], rows: object[]}}
 */
export function buildCountryComparison(countries, raw) {
  const { countries: selected, omitted } = selectCompareCountries(countries);
  return {
    countries: selected.map((c) => ({ key: c.key, name: c.name })),
    omittedNames: omitted.map((c) => c.name),
    rows: METRICS.map((metric) => buildComparisonRow(metric, selected, raw)),
  };
}

/** The on-screen note for a selection the cap trimmed, or null when nothing
 *  was trimmed. Kept as a function rather than a template the view composes
 *  itself, per this task's own rule that a user-visible sentence lives here,
 *  not in JSX. */
export function truncationNote(omittedNames) {
  if (!omittedNames || !omittedNames.length) return null;
  return `Comparing the first ${MAX_COMPARE_COUNTRIES} countries selected, in the order they were clicked. `
    + `Not shown: ${omittedNames.join(", ")}.`;
}

/** What the view shows instead of a table when fewer than two countries are
 *  selected -- e.g. the reader removed a chip while the comparison was open. */
export function needMoreCountriesNote(selectedCount) {
  const n = selectedCount || 0;
  return n === 1
    ? "Select at least one more country to compare."
    : `Select at least ${MIN_COMPARE_COUNTRIES} countries to compare.`;
}

// The standing caveat this task's brief requires on screen, always, not in a
// tooltip a reader has to find: this table is only ever as complete as this
// map's own collection, and collection coverage is not the same between
// countries. Without this line, a reader comparing two aligned numbers has no
// way to tell "these countries differ" from "this map knows more about one of
// them" -- the exact confusion the brief names as the thing this view must
// survive being asked.
export const COMPARE_COVERAGE_CAVEAT =
  "This compares what this map has collected about each country, not the countries themselves. "
  + "A blank cell means this map does not know -- not that the true value is zero -- and coverage is not "
  + "the same for every country, so a gap here can be a gap in this map's own sources rather than a real "
  + "difference between the countries.";
