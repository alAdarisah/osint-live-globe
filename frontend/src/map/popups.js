// Country/city popup HTML: population + density (countries) and any
// recent conflict/news events matched nearby. Reads from the current raw
// events/gdelt arrays passed in by the caller (see useLeafletMap) rather than
// holding its own copy, so it's always working off the latest poll.

import { esc, fmtNumber, haversineKm, parseGdeltDateAdded, timeAgoFromDateAdded, timeAgoFromUnix } from "../utils/format";
import { boundsContainsPoint } from "../utils/geo";
import {
  classifyAircraft, classifyShip, classifyVesselTraffic, isSanctioned,
  AIS_COVERAGE_CAVEAT, EMPTY_WATER_HEADLINE,
  OSM_INFRA_STYLE, OSM_INFRA_ORDER, AIRFIELD_STYLE, AIRFIELD_ORDER, MILITARY_ROLE_STYLE,
  POWER_PLANT_FUEL_STYLE, MILITARY_SUBTYPE_STYLE,
  satellitePassesSectionHtml,
} from "./decorators";
import { countryContainsPoint } from "./countryHitTest";
import { CLASS_LABEL as WATER_CLASS_LABEL, WATER_SCALE_CAVEAT } from "./water";
import { SUBDIVISION_SCALE_CAVEAT } from "./subdivisions";
import { DISTRICT_METRICS, DISTRICT_NO_RECORD_CAVEAT } from "./districts";

// ACLED/GDELT country names don't always match Natural Earth's ADMIN name
// (e.g. "Russian Federation" vs "Russia") -- this covers the common cases.
// It's best-effort: some countries may just show no matched events.
const COUNTRY_ALIASES = {
  "united states of america": "united states", "russian federation": "russia",
  "republic of korea": "south korea", "korea, republic of": "south korea",
  "democratic people's republic of korea": "north korea", "dem. rep. korea": "north korea",
  "czechia": "czech republic", "ivory coast": "cote d'ivoire", "côte d'ivoire": "cote d'ivoire",
  "eswatini": "swaziland", "democratic republic of the congo": "democratic republic of congo",
  "congo, dem. rep.": "democratic republic of congo", "congo, dr": "democratic republic of congo",
  "republic of the congo": "congo", "viet nam": "vietnam", "lao pdr": "laos",
  // Both sides of two joins that were silently missing each other: Natural
  // Earth says "Republic of the Congo" and "Republic of Serbia" where HDX says
  // "Republic of Congo" and "Serbia". Aliasing both ends onto one target is
  // what makes the match symmetric -- mapping only the Natural Earth side left
  // the HDX key normalising to something nothing else reached.
  "republic of congo": "congo", "republic of serbia": "serbia",
  "syrian arab republic": "syria", "united republic of tanzania": "tanzania",
  "bolivia (plurinational state of)": "bolivia", "venezuela (bolivarian republic of)": "venezuela",
  "iran (islamic republic of)": "iran", "brunei darussalam": "brunei", "cabo verde": "cape verde",
  "united kingdom of great britain and northern ireland": "united kingdom",
  "state of palestine": "palestine", "west bank and gaza": "palestine", "myanmar (burma)": "myanmar",
};

export function normalizeCountryName(name) {
  if (!name) return "";
  const n = name.toLowerCase().trim().replace(/^the\s+/, "");
  return COUNTRY_ALIASES[n] || n;
}

/**
 * The attributes that make a row openable, or "" for a row that is not.
 *
 * The country card renders these sections as raw HTML (see CountryInfoCard.jsx),
 * so a row cannot carry a React handler -- it carries the two things a delegated
 * listener needs to find the record again, and the card resolves them against
 * the live feed rather than against whatever was true when the string was built.
 * A row with no id is left inert rather than made to look clickable: the popup
 * it would open is keyed on that id.
 */
function openableRow(kind, id) {
  if (id == null || id === "") return "";
  return ` class="event-row event-row-open" role="button" tabindex="0"`
    + ` data-event-kind="${esc(kind)}" data-event-id="${esc(String(id))}"`;
}

function formatEventRow(type, item) {
  if (type === "events") {
    const label = item.event_type || "Conflict event";
    const sourceLabel = (item.corroborated_by && item.corroborated_by.length ? item.corroborated_by : [item.source])
      .filter(Boolean)
      .join("/")
      .toUpperCase();
    const open = openableRow("events", item.id);
    return `<div${open || ' class="event-row"'}><b>${esc(label)}</b>${item.fatalities ? ` (${item.fatalities} fatalities)` : ""}
      <div class="event-meta">${esc(item.country || "")} &middot; ${esc(item.date || "")} &middot; ${esc(sourceLabel)}</div></div>`;
  }
  const headline = (item.real_title || "").trim();
  if (!headline) return ""; // defensive: server should never serve a title-less item, but never render a blank row if it slips through
  const link = item.source_url
    ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">${esc(headline)}</a>`
    : esc(headline);
  const sourceLabel = item.source_name || "GDELT";
  const when = timeAgoFromDateAdded(item.date_added);
  const corroborated = item.corroborated ? " &middot; corroborated" : "";
  // The headline keeps its own link to the article -- that is the citation, and
  // it must stay a plain link a reader can middle-click. The row around it opens
  // the detail card; the delegated handler ignores clicks that landed on the
  // anchor so the two never fight over one gesture.
  const open = openableRow("gdelt", item.event_id);
  return `<div${open || ' class="event-row"'}>${link}<div class="event-meta">${esc(sourceLabel)} &middot; ${esc(when)}${corroborated}</div></div>`;
}

const MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TREND_MONTHS = 6;

// HDX's aggregate ACLED export (backend/sources/hdx_conflict_stats.py) --
// country-month event/fatality counts with no registration or embargo, so
// it stays current even when the point-level ACLED feed is stuck on an
// account's recency embargo. Keyed by ACLED's own country naming, same as
// raw.events, so normalizeCountryName's alias table covers both.
// Superseded by buildSparkline below, which renders the same HDX series as
// inline bars instead of a list of text rows -- kept only for cityPopupHtml,
// which has no room for a chart.
function buildTrendSection(monthlySeries) {
  if (!monthlySeries || !monthlySeries.length) return "";
  const recent = monthlySeries.slice(-TREND_MONTHS);
  const rows = recent
    .map((m) => {
      const label = `${MONTH_ABBR[m.month]} ${m.year}`;
      return `<div class="trend-row"><span class="trend-month">${esc(label)}</span><span class="trend-count">${m.events} events${m.fatalities ? `, ${m.fatalities} killed` : ""}</span></div>`;
    })
    .join("");
  return `<div class="popup-trend"><div class="meta">Conflict trend (HDX/ACLED, monthly)</div>${rows}</div>`;
}

// News ids already represented by a conflict or officials record in the same
// card. Without this the country card lists one story twice -- once as the
// incident and once as the headline underneath it -- which is the duplication
// the map itself now avoids, reappearing in a different panel.
//
// Recomputed per card rather than shared with the controller's own set: this
// module is called with `raw` and nothing else, and a card is built on click,
// not on every render.
function mergedNewsIdsIn(raw) {
  const ids = new Set();
  for (const source of [raw.events, raw.officials]) {
    for (const record of source || []) {
      for (const id of record.coverage_event_ids || []) ids.add(id);
    }
  }
  return ids;
}

// `heading` is dropped by the country card, which labels the fold itself, and
// kept by the city popup, which has no folds and so still needs the line.
function buildEventsSection(eventItems, gdeltItems, { heading = true } = {}) {
  const rows = [
    ...eventItems.map((i) => formatEventRow("events", i)),
    ...gdeltItems.map((i) => formatEventRow("gdelt", i)),
  ].filter(Boolean);
  if (!rows.length) {
    return '<div class="popup-events"><div class="meta">No recent conflict/news events matched for this area.</div></div>';
  }
  return `<div class="popup-events">${heading ? '<div class="meta">Recent events</div>' : ""}${rows.join("")}</div>`;
}

// ---------- live situational snapshot ----------
//
// Everything below is derived from data the app has already fetched for the
// map layers -- no extra request is made when a country is clicked. The
// point is to turn the country card from a static encyclopedia entry
// (population/density/HDI) into "what is happening inside this country
// right now", which is the question this map exists to answer and which no
// other panel answers per-country.
//
// Geometry test is the country's bounding box, not its true border. That's
// deliberate: it reuses boundsContainsPoint, costs one comparison per item,
// and stays responsive on the ADS-B layer (10k+ aircraft). It over-counts
// for sprawling or oddly-shaped countries, so the UI says "in / near"
// rather than claiming precision it doesn't have.
// The filtered records themselves, not just their count -- countInBounds
// below is itemsInBounds(...).length, kept as its own name because most call
// sites only ever want the number. Tasks 9's new sections need the records
// (to list them, to sum a field on them), so this is the one both build on.
// Exported (Task 13's brief names these alongside bboxesOverlap as reusable
// rather than reinventable) even though most call sites in this file stay
// local -- map/eventDetail.js's Nearby block needs a *radius*, not a bbox,
// so it filters with haversineKm directly instead; these two stay the right
// tool for every bbox-scoped section on this page.
export function itemsInBounds(items, bounds, predicate) {
  if (!bounds || !items) return [];
  const out = [];
  for (const item of items) {
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
    if (!boundsContainsPoint(bounds, item.lat, item.lon)) continue;
    if (predicate && !predicate(item)) continue;
    out.push(item);
  }
  return out;
}

export function countInBounds(items, bounds, predicate) {
  return itemsInBounds(items, bounds, predicate).length;
}

// The exact sentence buildLivePicture has always used for "this is a count
// over whatever this session happens to have loaded, not a survey" -- Task 9
// reuses it verbatim for the military section's own bbox-scoped counts rather
// than paraphrasing the same caveat a second way (see that task's brief).
const BBOX_LOAD_CAVEAT = '<div class="cstat-note">Counted within the area currently loaded.</div>';

function statRow(icon, label, value, extraClass) {
  if (!value) return ""; // a zero tells the reader nothing -- omit rather than pad the card with noise
  return `<div class="cstat ${extraClass || ""}"><span class="cstat-v">${value}</span><span class="cstat-l">${esc(label)}</span></div>`;
}

function buildLivePicture(bounds, raw) {
  const military = countInBounds(raw.adsb, bounds, (a) => classifyAircraft(a) === "military");
  const navy = countInBounds(raw.ais, bounds, (s) => classifyShip(s) === "navy");
  const tankers = countInBounds(raw.ais, bounds, (s) => classifyShip(s) === "tanker");
  const jamming = countInBounds(raw.jamming, bounds);
  const fires = countInBounds(raw.firms, bounds);
  const infra = countInBounds(raw.infra, bounds);

  const cells = [
    statRow("", "military aircraft", military, "hot"),
    statRow("", "navy vessels", navy),
    statRow("", "tankers", tankers),
    statRow("", "GPS jamming cells", jamming, "hot"),
    statRow("", "active fires", fires),
    statRow("", "infrastructure sites", infra),
  ].join("");

  // No heading of its own: the card's fold is labelled (see
  // countryCardSections), and a section that restates its own title inside
  // itself just costs a line in a 320px column.
  //
  // Task 32: an empty `cells` used to mean drop the whole section, whether or
  // not these six feeds had actually been checked against this country's
  // bounds yet -- see emptyFoldReason's own docstring for the conflation
  // ("looked and found nothing" vs "did not look here") this sweep exists to
  // close everywhere it was found, not just here.
  if (!cells) {
    const reason = emptyFoldReason(["adsb", "ais", "jamming", "firms", "infra"], bounds, raw);
    return reason ? emptyFoldNote(reason) : "";
  }

  // Two of the six feeds behind these numbers are now clipped to a snapped
  // viewport box (fires and jamming -- see `scoped` in map/scene.js), so for a
  // country the reader is not looking at, this counts what has been loaded
  // rather than what exists. CountrySelectionBar can open a card for exactly
  // that case: a country still selected but off-screen.
  //
  // Said rather than fixed, and deliberately. Un-scoping the two feeds would
  // put a quarter of a million FIRMS points back on every poll to make one
  // stat row complete. Under-reporting silently is the failure; under-reporting
  // with a label is a fact, and it is the same register as the choropleth's
  // coverage note and the conflict layer's cap note.
  return `<div class="cstats">${cells}</div>
    ${BBOX_LOAD_CAVEAT}`;
}

// 72h rather than the full 3-day feed window so "recent" means recent --
// and severity/corroboration are surfaced because they're the two things
// that separate a confirmed massacre from a single unverified report.
const RECENT_WINDOW_MS = 72 * 3600 * 1000;

// Pulled out of buildConflictSummary so the summary strip's own events/
// fatalities tiles (Task 10's summaryTiles, below) count the exact same
// window the same way -- two independent loops re-deriving "recent events in
// this bbox" could quietly disagree about the cutoff or the bounds check,
// which is exactly the kind of drift the strip and its own fold must never
// show.
//
// Exported for countryCompareLogic.js (Task 40): the comparison table's
// events/fatalities rows read this exact function rather than re-deriving
// "recent conflict activity in a bbox" a third way, for the identical reason
// summaryTiles already reuses it -- two independently-written counts of the
// same thing are exactly the kind of drift this project has had to close
// before. Note that this silently reads as all-zero when `bounds` is null
// (every record fails the `!bounds` check below) -- fine for its two existing
// callers, which never invoke it without bounds, but a caller that can be
// handed a null bounds (countryCompareLogic's cells can) must check for that
// itself before calling in, not trust a zero coming back out of this.
export function recentConflictStats(bounds, raw) {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let count = 0;
  let fatalities = 0;
  let corroborated = 0;
  let worst = null;
  for (const e of raw.events || []) {
    if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
    if (!bounds || !boundsContainsPoint(bounds, e.lat, e.lon)) continue;
    if (e.date) {
      const t = Date.parse(`${e.date}T00:00:00Z`);
      if (!Number.isNaN(t) && t < cutoff) continue;
    }
    count += 1;
    fatalities += e.fatalities || 0;
    if (e.corroborated) corroborated += 1;
    if (!worst || (e.severity || 0) > (worst.severity || 0)) worst = e;
  }
  return { count, fatalities, corroborated, worst };
}

function buildConflictSummary(bounds, raw, escalationZone) {
  const { count, fatalities, corroborated, worst } = recentConflictStats(bounds, raw);

  const badge = escalationZone
    ? `<div class="cescalating">ESCALATING &middot; ${escalationZone.ratio}&times; its own baseline (${esc(escalationZone.label)})</div>`
    : "";

  if (!count) return badge;

  const worstLine = worst
    ? `<div class="meta">Most severe: ${esc(worst.event_type || "event")} &middot; ${worst.severity ?? 0}/100${
        worst.notes ? ` &mdash; ${esc(worst.notes.slice(0, 90))}` : ""
      }</div>`
    : "";

  return `${badge}
    <div class="cstats">
      ${statRow("", "events", count, "hot")}
      ${statRow("", "killed", fatalities, "hot")}
      ${statRow("", "corroborated", corroborated)}
    </div>${worstLine}`;
}

// Inline SVG bars rather than the previous five lines of text: a year of
// monthly fatalities is a shape, and a shape is read instantly where a list
// of numbers has to be parsed. Scaled to its own max, since absolute
// magnitudes differ hugely between countries.
const SPARK_MONTHS = 12;

// A minimal inline bar chart. Built for ACLED's monthly fatality counts (the
// defaults below); since Task 8 it is also how the energy section (buildEnergy)
// draws the 24-hour net-flow series -- same bars, same "accent the newest
// point" idea, same non-uniform viewBox scaling so the SVG fills whatever
// width the card gives it, differing only in how many points to plot, how to
// read a bar's value, and how to caption the chart. `headingOf` is spliced in
// unescaped (the default has no untrusted data in it; a caller with backend
// strings to interpolate -- e.g. a unit -- must esc() them itself), while the
// caption returned by `captionOf` is escaped once here, for both the visible
// line and the SVG's aria-label, so a caller returns plain text either way.
//
// Exported for the sparkline tests: there is no DOM here to poke, only this.
export function buildSparkline(series, opts = {}) {
  const {
    count = SPARK_MONTHS,
    // Named readValue rather than valueOf: every plain object inherits
    // Object.prototype.valueOf, so `{ valueOf = default } = opts` never sees
    // its default when opts is {} -- it silently picks up the built-in
    // instead, which is not a function of one argument and throws the
    // moment it is called. readValue has no such collision.
    readValue = (m) => m.fatalities || 0,
    headingOf = (recent) => `Fatalities, last ${recent.length} months (HDX/ACLED)`,
    captionOf = (recent, max) => {
      const last = recent[recent.length - 1];
      return last ? `${MONTH_ABBR[last.month]} ${last.year}: ${last.fatalities || 0} killed · peak ${max}` : "";
    },
  } = opts;
  if (!series || series.length < 2) return "";
  const recent = series.slice(-count);
  // The real peak -- possibly zero, for a country whose last twelve months
  // (or a border with no flow at all) are genuinely quiet. This is what
  // headingOf/captionOf see; a series that is actually all zero must read
  // back "peak 0", not a leaked implementation constant.
  const max = Math.max(...recent.map((m) => Math.abs(readValue(m))), 0);
  // The bar-height divisor is a separate value: never zero, so the division
  // below is never by zero, but this number itself is never shown -- only
  // `max` (the real, possibly-zero peak) is passed to the caption.
  const divisor = max || Number.EPSILON;
  const w = 8;
  const gap = 2;
  const h = 26;
  const bars = recent
    .map((m, i) => {
      const bh = Math.max(1, Math.round((Math.abs(readValue(m)) / divisor) * h));
      // Newest bar accented so "where are we now" is obvious at a glance.
      const fill = i === recent.length - 1 ? "#ff5c2a" : "rgba(255,140,58,0.55)";
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" fill="${fill}" rx="1"/>`;
    })
    .join("");
  const label = captionOf(recent, max);
  return `<div class="meta">${headingOf(recent)}</div>
    <svg class="cspark" viewBox="0 0 ${recent.length * (w + gap)} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${bars}</svg>
    <div class="meta">${esc(label)}</div>`;
}

/**
 * @param props   the GeoJSON feature's properties (name/population/density/hdi)
 * @param raw     the map controller's live data buckets
 * @param bounds  the country's own bounding box {south,west,north,east}, used
 *                for every "inside this country" count below. Optional -- the
 *                card degrades to the name-matched sections without it.
 */
// The reviewed counterpart to the live picture above it: ACLED's own monthly
// totals at district level (via HDX HAPI -- keyless and, unlike the ACLED API
// on a research account, not embargoed) plus UCDP's peer-reviewed death count.
//
// Deliberately labelled with the month it covers rather than presented as
// current. The live layer answers "what is being reported right now"; this
// answers "what was actually verified", and the two disagreeing is
// information, not a bug to hide.
function buildVerifiedRecord(wanted, raw) {
  const districts = (raw.conflictDistricts || []).filter(
    (r) => normalizeCountryName(r.country) === wanted
  );
  if (!districts.length) return "";

  const latestMonth = districts.reduce((m, r) => (r.month > m ? r.month : m), "");
  const current = districts.filter((r) => r.month === latestMonth);
  const events = current.reduce((n, r) => n + (r.events || 0), 0);
  const killed = current.reduce((n, r) => n + (r.fatalities || 0), 0);
  if (!events && !killed) return "";

  const worst = current
    .filter((r) => r.fatalities > 0)
    .sort((a, b) => b.fatalities - a.fatalities)
    .slice(0, 3);

  return `
    <div class="csection-body">
      <div class="csection-h">${esc(latestMonth)}</div>
      <div class="cstats">
        <div class="cstat"><span class="cstat-v">${fmtNumber(events)}</span>events</div>
        <div class="cstat${killed > 0 ? " hot" : ""}"><span class="cstat-v">${fmtNumber(killed)}</span>killed</div>
        <div class="cstat"><span class="cstat-v">${fmtNumber(current.length)}</span>districts</div>
      </div>
      ${worst.length ? `<div class="meta">Worst-hit: ${worst
        .map((r) => `${esc(r.admin2 || r.admin1 || "?")} (${r.fatalities})`)
        .join(", ")}</div>` : ""}
      <div class="meta">ACLED via HDX HAPI, complete to end of ${esc(latestMonth)} &mdash; reviewed monthly totals, not live.</div>
    </div>`;
}

/**
 * The country card, as a list of independently foldable sections.
 *
 * It used to be one HTML string, which made the card an all-or-nothing read:
 * six subjects (identity, live conflict, live picture, the verified record, a
 * year of fatalities, matched events) stacked into a 320px column that ran well
 * past the bottom of the screen, with the one section a given reader wanted
 * somewhere in the middle of it. As sections they collapse individually and the
 * choice is remembered (see CountryInfoCard.jsx/useAccordion.js).
 *
 * Sections that have nothing to say are dropped here rather than rendered
 * empty: a fold labelled "Verified record" that opens onto nothing is worse
 * than no fold, because it costs a click to find that out.
 *
 * @param props   the GeoJSON feature's properties (name/population/density/hdi)
 * @param raw     the map controller's live data buckets
 * @param bounds  the country's own bounding box {south,west,north,east}, used
 *                for every "inside this country" count. Optional -- the card
 *                degrades to the name-matched sections without it.
 * @returns {{title: string, sections: Array<{id, title, html, defaultOpen}>,
 *   summary: Array<object>, groups: Array<{id, title, sectionIds}>}}
 */
// Displacement and food security (backend/sources/humanitarian.py). Keyed on
// ISO3, which is what both UNHCR and HAPI use -- and which the country features
// already carry (see backend/sources/countries.py), so no name matching.
//
// Every figure is a country-level aggregate over a reference period of months,
// so each one states its period. Nothing here is live and none of it is drawn
// on the map.
// A bare "2" tells a reader nothing; this says what an admin_level number is
// a precision claim about. HDX HAPI's own convention (also IPC's): 0 is the
// whole country, 1/2/... are progressively finer subnational divisions, and
// which one a given row lands on varies by country and by dataset -- see
// humanitarian.py's parse_food_security/parse_idps, which each take the
// deepest level actually present rather than assuming one.
function adminLevelCaveat(level) {
  if (level == null) return "";
  return level === 0
    ? "a national figure, reported at admin level 0"
    : `a subnational figure, reported at admin level ${level}`;
}

function buildHumanitarian(props, raw) {
  const record = props.iso_a3 ? (raw.humanitarian || {})[props.iso_a3] : null;
  if (!record) return "";
  const d = record.displacement;
  const food = record.food_security;
  const idps = record.idps;
  const presence = record.operational_presence;
  const rows = [];
  if (d) {
    const parts = [
      d.refugees != null ? `${fmtNumber(d.refugees)} refugees` : null,
      d.asylum_seekers != null ? `${fmtNumber(d.asylum_seekers)} asylum seekers` : null,
      d.idps != null ? `${fmtNumber(d.idps)} internally displaced` : null,
      d.stateless ? `${fmtNumber(d.stateless)} stateless` : null,
      // Both new in Task 8: UNHCR reports these alongside refugees/asylum
      // seekers/stateless for the same country-of-origin row, and != null
      // (rather than truthy) so a reported zero still shows -- "0 returned
      // this year" is a fact, not the same as "not reported".
      d.returned_refugees != null ? `${fmtNumber(d.returned_refugees)} returned refugees` : null,
      d.others_of_concern != null ? `${fmtNumber(d.others_of_concern)} others of concern` : null,
    ].filter(Boolean);
    if (parts.length) {
      rows.push(`<div>${parts.join(" &middot; ")}</div>
        <div class="meta">Reported by UNHCR for ${esc(d.year)} &mdash; counted by country of <b>origin</b>: people
          this country's situation has displaced, wherever they are now.</div>`);
    }
  }
  if (food) {
    rows.push(`<div><b>${fmtNumber(food.population_in_crisis)}</b> in IPC phase 3 or worse (crisis, emergency
      or famine)</div>
      <div class="meta">IPC via HDX HAPI, analysis period from ${esc((food.reference_period_start || "").slice(0, 10))}${
        food.admin_level != null ? ` &mdash; ${adminLevelCaveat(food.admin_level)}` : ""
      }.</div>`);
  }
  if (idps) {
    rows.push(`<div>${fmtNumber(idps.population)} internally displaced, in-country assessment</div>
      <div class="meta">HDX HAPI, reporting round from ${esc((idps.reference_period_start || "").slice(0, 10))}${
        idps.admin_level != null ? ` &mdash; ${adminLevelCaveat(idps.admin_level)}` : ""
      }.</div>`);
  }
  if (presence) {
    rows.push(`<div>${fmtNumber(presence.organisations)} aid organisations reported active across
      ${esc(presence.sector_count)} sectors</div>
      <div class="meta">HDX HAPI 3W (who does what, where).</div>`);
  }
  if (!rows.length) return "";
  return `${rows.join("")}
    <p class="meta">All of the above are <b>aggregates over months</b>, not current counts, and are shown
      here rather than on the map for exactly that reason.</p>`;
}

/** IODA's record for this country shape, by ISO2 where the shape has one.
 *
 *  Natural Earth ships "-99" as the ISO2 of eight features in ne_50m -- Norway,
 *  France, Northern Cyprus, Somaliland, Kosovo, Siachen Glacier, and Australia's
 *  Indian Ocean and Ashmore/Cartier territories -- so a code-only lookup left
 *  a French or Norwegian outage out of the card with nothing to show for it.
 *  Those shapes are keyed by name everywhere else in this app, and IODA names
 *  its entities too, so the name is the second way in. It is tried only when
 *  there is no usable code: a country that *has* an ISO2 and is absent from the
 *  dict genuinely has no outage, and matching it on name from there could only
 *  ever produce a false positive.
 *
 *  Mirrors rebuildOutagePoints in createMapController.js, which resolves the
 *  same two sides in the same order for the map pins.
 */
function outageFor(props, raw) {
  const outages = raw.outages || {};
  const code = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null;
  if (code) return outages[code] || null;
  const wanted = normalizeCountryName(props.name);
  if (!wanted) return null;
  return Object.values(outages).find((o) => normalizeCountryName(o.country) === wanted) || null;
}

/*  Natural Earth's "-99" problem again, but with no name to fall back on.
 *
 *  Energy-Charts records carry a country_code and no country *name*
 *  (energy_flows.py's merge), so the second step outageFor() takes above has
 *  nothing to match against and France, Norway and Kosovo would come up
 *  silently blank -- the record exists and nothing can reach it. Those shapes
 *  do carry ADM0_A3 (props.iso_a3, see countries.py), so a small explicit map
 *  is the way in. Only the three that actually have an energy record are
 *  listed; the other two "-99" features are Northern Cyprus and Somaliland,
 *  which have no bidding zone and never will.
 *
 *  outageFor above deliberately keeps its name path rather than sharing this:
 *  IODA does publish entity names, so for that feed the name is real evidence
 *  and this table would be a second, redundant answer.
 */
const ISO2_BY_ISO3 = { NOR: "NO", FRA: "FR", KOS: "XK" };

export function energyRecordFor(props, raw) {
  const code = props.iso_a2 && props.iso_a2 !== "-99"
    ? props.iso_a2
    : ISO2_BY_ISO3[props.iso_a3];
  if (!code) return null;
  const record = (raw.energyFlows || {})[code];
  // `aggregate` is the EU row: the bloc's external interconnectors only, not a
  // sum of the member states. It is not a country and must not paint one.
  return record && !record.aggregate ? record : null;
}

// --- sub-national outages (backend/sources/outages.py's region pass) ------
//
// Admin-1 features (subdivisions.js's buildSubdivisionIndex) carry only their
// ISO3 country_code (see backend/sources/admin1_boundaries.py) -- no ISO2 at
// all -- while outages.py's region payload is keyed `{ISO2: {code: record}}`
// to match the country pass's own key. So this join needs one more step than
// outageFor's does: ISO3 -> ISO2, through the same country features (and the
// same "-99" fallback table) energyRecordFor above already uses, for exactly
// the same reason.
function iso2ForIso3(iso3, raw) {
  const code = (iso3 || "").toUpperCase();
  if (!code) return null;
  const features = raw.countries?.features || [];
  const feature = features.find((f) => (f.properties?.iso_a3 || "").toUpperCase() === code);
  const direct = feature?.properties?.iso_a2;
  if (direct && direct !== "-99") return direct;
  return ISO2_BY_ISO3[code] || null;
}

/**
 * IODA's region record for this admin-1 shape, or null.
 *
 * Only an exact or fuzzy match ever resolves here. An unmatched region has no
 * `region_code` to join on by construction (see outages.py's own docstring on
 * why it is kept in the payload anyway) -- there is no admin-1 shape for it to
 * be the record of, so a card built from a shape can never reach it. That is
 * correct for *this* function: it answers for one shape, and an unmatched
 * record is not the record of any shape. It is not the whole answer for a
 * reader, though -- see regionMatchSummary below, which is what tells a state
 * or district card the difference between "IODA never scored anywhere near
 * here" and "IODA scored something here that could not be placed on a map".
 */
export function regionOutageFor(props, raw) {
  if (!props?.country_code || !props?.code) return null;
  const iso2 = iso2ForIso3(props.country_code, raw);
  if (!iso2) return null;
  const byCountry = (raw.outagesRegions || {})[iso2];
  if (!byCountry) return null;
  return Object.values(byCountry).find((r) => r.matched !== "unmatched" && r.region_code === props.code) || null;
}

/**
 * How many of one country's IODA-scored regions could be matched to an
 * admin-1 boundary, and how many could not -- null when this country has no
 * region-level reporting in the current feed at all.
 *
 * This exists because regionOutageFor's per-shape answer, on its own, makes
 * "IODA never scored anywhere near this state" and "IODA scored something
 * here but this map could not tell which state it was" look identical: both
 * read as an empty Connectivity fold. At this build's own measured match
 * rate roughly a quarter of a country's regions can land in the second
 * bucket, so silence there is not a rare edge case -- it is the same
 * fetched-but-unplaceable-vs-never-fetched conflation this project has had
 * to close in several other layers, and the fix is the same shape every
 * time: say what was found, even when it could not be drawn.
 *
 * Takes the ISO2 directly rather than a shape's props, because its two
 * callers reach it from different places: the country card already has ISO2
 * (outageFor's own record carries it), while the admin-1/admin-2 cards go
 * through iso2ForIso3 first.
 */
export function regionMatchSummary(iso2, raw) {
  const byCountry = iso2 ? (raw.outagesRegions || {})[iso2] : null;
  if (!byCountry) return null;
  const records = Object.values(byCountry);
  if (!records.length) return null;
  const unmatched = records.filter((r) => r.matched === "unmatched").length;
  return { matched: records.length - unmatched, unmatched, total: records.length };
}

// ISO3, the same key humanitarian uses -- so this one joins on props.iso_a3
// directly, with no name matching and no "-99" problem at all.
export function foodRecordFor(props, raw) {
  const record = (raw.foodTrade || {})[props.iso_a3];
  // `aggregate` is the EU row, which is not a sum of the member rows -- those
  // are not in this feed at all -- and has no country shape to paint.
  return record && !record.aggregate ? record : null;
}

// A country losing the internet is genuinely national in scope, so the card is
// where the numbers live -- the map pin (see decorateOutage) is a way to find
// the country, not a claim about where inside it anything happened. IODA's
// `score` is a composite of three detection methods and is unbounded -- it is
// emphatically not a percentage of the country offline, and this says so rather
// than dressing it up as one.
/**
 * window_start/window_end (outages.py, unix seconds) as the reader's own
 * clock rather than the bare epoch numbers the payload carries: how many
 * hours the score covers, and the UTC time it runs up to -- "last 24 hours,
 * to 14:00 UTC". Reads the actual window rather than assuming it always
 * matches outages.py's WINDOW_SECONDS constant, since a slow or retried poll
 * can make it something other than exactly 24h.
 *
 * Exported for the test: it is the one piece of arithmetic in this section.
 */
export function formatOutageWindow(windowStart, windowEnd) {
  if (typeof windowStart !== "number" || typeof windowEnd !== "number") return "";
  const end = new Date(windowEnd * 1000);
  if (Number.isNaN(end.getTime())) return "";
  const hours = Math.round((windowEnd - windowStart) / 3600);
  const hh = String(end.getUTCHours()).padStart(2, "0");
  const mm = String(end.getUTCMinutes()).padStart(2, "0");
  return `last ${hours} hour${hours === 1 ? "" : "s"}, to ${hh}:${mm} UTC`;
}

function buildConnectivity(props, raw) {
  const outage = outageFor(props, raw);
  // Task 32 review (known instance 1): regionSummary used to be computed only
  // once an `outage` record already existed, keyed off outage.country_code --
  // so a country whose own aggregate score sat under IODA's reporting floor
  // (raw.outages carries only countries above it) lost this whole section,
  // sub-national tally included, even when some of its regions genuinely had
  // scored. Computed here, before the early return, off props' own ISO2, so
  // a quiet country score can no longer hide a region that was not quiet.
  //
  // Task 32 review, round 2 (Important 1): the first version of this fix
  // fell back to `outage ? outage.country_code : null` for a "-99" shape with
  // no outage record -- which is every "-99" shape in exactly the case this
  // fix exists for, since outageFor's own name-matched fallback (used to find
  // `outage` in the first place) only ever succeeds when raw.outages *has*
  // an entry to match a name against. A France/Norway/Kosovo under the
  // reporting floor has no such entry, `outage` is null, and the fallback
  // resolved to null right along with it -- the precise conflation this task
  // exists to close, unclosed for exactly the three countries `outageFor`'s
  // own docstring three paragraphs above calls out by name. ISO2_BY_ISO3 is
  // the fix `energyRecordFor` above already uses for this identical "-99,
  // no name to fall back on" problem, and `buildAdminConnectivity` two
  // functions below already reaches it (via iso2ForIso3) for the same
  // reason -- reused here a third time rather than reinvented, in the one
  // function of the three that had not yet been given it.
  const iso2 = outage
    ? outage.country_code
    : (props.iso_a2 && props.iso_a2 !== "-99"
      ? props.iso_a2
      : ISO2_BY_ISO3[(props.iso_a3 || "").toUpperCase()] || null);
  const regionSummary = regionMatchSummary(iso2, raw);
  if (!outage) {
    if (!regionSummary) return "";
    return `
      <div>No national-level internet disruption detected for this country over the current window.</div>
      <p class="meta">IODA also scored ${regionSummary.total} region(s) here over the same window &mdash;
        ${regionSummary.matched} matched to a state or province boundary here (see its own card)${
          regionSummary.unmatched
            ? `, and ${regionSummary.unmatched} could not be matched to one and are not drawn`
            : ""
        }. A quiet country-level score does not mean every region inside it was quiet too.</p>
      <p class="meta">Reported by IODA (Georgia Tech). The score is a composite that is only meaningful
        <b>in comparison</b> &mdash; against a region's own normal and against others in the same window.</p>`;
  }
  const signals = Object.keys(outage.signals || {});
  const windowText = formatOutageWindow(outage.window_start, outage.window_end);
  return `
    <div class="outage-block">
      <div class="outage-head">Internet disruption detected</div>
      <div>IODA composite score: ${fmtNumber(Math.round(outage.score))}${
        outage.event_count ? ` &middot; ${esc(outage.event_count)} event(s)` : ""
      }</div>
      ${signals.length ? `<div class="meta">Seen in: ${signals.map((k) => esc(k.split(".")[0])).join(", ")}</div>` : ""}
    </div>
    <p class="meta">Over the ${esc(windowText || "reporting window")}, reported by IODA (Georgia Tech), which watches
      BGP withdrawals, active probing and darknet traffic. The score is a composite that is only meaningful
      <b>in comparison</b> &mdash; against this country's own normal and against others in the same window.
      It is not a percentage of the country offline, and it cannot distinguish a shutdown from a cable fault.</p>
    ${regionSummary ? `<div class="meta">Sub-national: IODA also scored ${regionSummary.total} region(s) within
        this country over the same window &mdash; ${regionSummary.matched} matched to a state or province boundary
        here (see its own card)${regionSummary.unmatched
          ? `, and ${regionSummary.unmatched} could not be matched to one and are not drawn`
          : ""}.</div>` : ""}`;
}

// --- cross-border electricity (backend/sources/energy_flows.py) ---------
//
// Not on the map, and the module says why: a flow is an edge between two
// countries, it has no location, and there is no honest pin for "0.4 GW from
// Slovakia into Ukraine".
//
// The two halves are rendered as two labelled blocks and are never merged or
// summed. One is what the interconnectors carried, measured; the other is what
// the day-ahead market sold, scheduled. Those are different kinds of claim on
// different clocks, and the distance between them is itself the signal.
function energyHalf(half, heading, body) {
  if (!half) return "";
  return `<div class="csection-h">${heading}</div>${body(half)}`;
}

const ENERGY_COUNTERPART_CAP = 6;

function buildEnergy(props, raw) {
  const record = energyRecordFor(props, raw);
  if (!record) return "";
  const physical = record.physical;
  const commercial = record.commercial;
  if (!physical && !commercial) return "";
  const signed = (v, unit) => `${v > 0 ? "+" : ""}${Number(v).toFixed(2)} ${esc(unit || "GW")}`;
  const counterparts = (physical && physical.counterparts) || [];
  const shown = counterparts.slice(0, ENERGY_COUNTERPART_CAP);

  // available_from/interval_minutes are the publisher's own claim about what
  // period it offers and at what resolution -- reported, like everything
  // else in this function, and carried through rather than assumed to always
  // be "today, 15 minutes" (see energy_flows.py's parse_exchange docstring).
  const coverageLine = (h) => (h.available_from
    ? `<div class="meta">Coverage reported: from ${esc(h.available_from)}${
        h.interval_minutes != null ? ` at ${esc(h.interval_minutes)}-minute intervals` : ""
      }.</div>`
    : "");

  // net_series is the same shape on both halves, but the two halves are not
  // the same kind of evidence -- physical is metered, commercial is a
  // published schedule -- so the caller says which word applies and the
  // chart is labelled with that word rather than one label doing for both.
  // Reuses buildSparkline rather than a second bar-chart renderer; only the
  // value reader and the two captions differ from the fatalities default.
  const netFlowSpark = (h, provenanceWord) => {
    if (!h.net_series || h.net_series.length < 2) return "";
    const unit = h.unit || "GW";
    return buildSparkline(h.net_series, {
      count: Infinity, // the whole reported window, not the last 12 of anything
      readValue: (pt) => pt.net,
      headingOf: (recent) => `Net position, ${recent.length} intervals (${esc(unit)}, ${provenanceWord})`,
      captionOf: (recent, max) => {
        const last = recent[recent.length - 1];
        if (!last) return "";
        const val = `${last.net > 0 ? "+" : ""}${Number(last.net).toFixed(2)} ${unit}`;
        return `${last.t || "latest"}: ${val} · peak ${max.toFixed(2)} ${unit}`;
      },
    });
  };

  return `
    <div class="cstats">
      ${physical && physical.net != null
        ? `<div class="cstat hot"><span class="cstat-v">${signed(physical.net, physical.unit)}</span>net, measured</div>`
        : ""}
      ${commercial && commercial.net != null
        ? `<div class="cstat"><span class="cstat-v">${signed(commercial.net, commercial.unit)}</span>net, scheduled</div>`
        : ""}
    </div>
    ${energyHalf(physical, "Measured &mdash; what the interconnectors carried", (h) => `
      <div class="meta">${esc(h.resolution || "resolution not stated")} resolution${
        h.latest_timestamp ? ` &middot; current to ${esc(h.latest_timestamp)}` : ""
      }${h.timezone ? ` (${esc(h.timezone)})` : ""}${
        h.bidding_zone ? ` &middot; bidding zone ${esc(h.bidding_zone)}` : ""
      }</div>
      ${coverageLine(h)}
      ${netFlowSpark(h, "measured")}
      ${h.sign_convention
        // Printed verbatim rather than restated. The backend deliberately does
        // not assert which sign means import -- it carries the publisher's own
        // words, and there is a test enforcing that -- so neither does this.
        ? `<div class="meta"><b>${esc(h.sign_convention)}</b> &mdash; the publisher's own words.</div>`
        : ""}
      ${shown.length
        ? `<ul class="coverage-list">${shown.map((c) => `<li>${esc(c.name)}: ${
            c.value != null ? signed(c.value, h.unit) : "not reported"
          }${c.min != null && c.max != null
            ? ` <span class="coverage-meta">over the window ${esc(Number(c.min).toFixed(2))} to ${esc(Number(c.max).toFixed(2))}</span>`
            : ""}</li>`).join("")}</ul>`
        : ""}
      ${counterparts.length > ENERGY_COUNTERPART_CAP
        ? `<div class="meta">+${esc(counterparts.length - ENERGY_COUNTERPART_CAP)} more borders &mdash; the
            list is capped, the count is not.</div>`
        : ""}`)}
    ${commercial
      ? energyHalf(commercial, "Scheduled &mdash; what the day-ahead market sold", (h) => `
        <div class="meta">${esc(h.resolution || "resolution not stated")} resolution${
          h.available_until ? ` &middot; published through ${esc(h.available_until)}` : ""
        }</div>
        ${coverageLine(h)}
        ${netFlowSpark(h, "reported")}
        <p class="meta"><b>Not a measurement, and never used as one.</b> This is the day-ahead market's
          intent. The meters above run several hours behind wall clock &mdash; that is ENTSO-E's
          publication lag, not a choice this app makes &mdash; so early in the day the schedule can be
          the only figure there is. Where the two disagree, that disagreement is the interesting thing:
          an interconnector that was sold and did not flow is a curtailment, an outage, or a border that
          went down.</p>`)
      : '<p class="meta">No day-ahead schedule published for this country in the current window.</p>'}
    <p class="meta">A flow is an edge between two countries, not a place &mdash; there is no honest pin
      for &ldquo;0.4 GW from Slovakia into Ukraine&rdquo;, which is why none of this is on the map.</p>
    <div class="meta">Source: Energy-Charts (Fraunhofer ISE), republishing ENTSO-E &mdash; direct
      measurement (physical) and a published market schedule (commercial).${
        physical && physical.license ? ` ${esc(physical.license)}.` : ""
      }</div>`;
}

// --- grid stress (Task 28): net exchange + outage score, side by side -----
//
// Not a rebuild of buildEnergy above -- that section already states the
// interconnector picture in full, sparkline included. This one exists to put
// two independently-collected signals in the same fold so a reader can see
// them move together (or not) without holding two folds open at once: the
// physical net position Energy-Charts/ENTSO-E measures, and the internet-
// disruption score IODA derives. Neither is evidence for the other, and the
// text says so in as many words -- a coincidence is worth noticing, not a
// causal claim this app makes on a reader's behalf.
function buildGridStress(props, raw) {
  const record = energyRecordFor(props, raw);
  const physical = record && record.physical;
  const outage = outageFor(props, raw);
  if (!physical && !outage) return "";

  const unit = (physical && physical.unit) || "GW";
  const netNow = physical && physical.net != null ? physical.net : null;
  // Task 32 review (Important 2): this used to compute regionSummary only
  // when `outage` was already truthy, keyed off outage.country_code -- the
  // identical floor-hides-regions defect buildConnectivity's own known
  // instance 1 had, just one fold over. A country with real cross-border
  // flow (so this section renders regardless) but an IODA aggregate under
  // the reporting floor has no `outage` record, and the sub-national tally
  // silently dropped out from under a section that was still on screen.
  // Same fix, same reasoning, same ISO2_BY_ISO3 fallback for the "-99"
  // shapes (France/Norway/Kosovo) buildConnectivity's own fix above needed.
  const iso2 = outage
    ? outage.country_code
    : (props.iso_a2 && props.iso_a2 !== "-99"
      ? props.iso_a2
      : ISO2_BY_ISO3[(props.iso_a3 || "").toUpperCase()] || null);
  const regionSummary = regionMatchSummary(iso2, raw);

  // A 24h window off the publisher's own reported cadence rather than a
  // hard-coded "96 points" -- physical exchange is usually 15-minute steps,
  // but interval_minutes is the publisher's own stated resolution (see
  // buildEnergy's own coverageLine) and this reads it rather than assuming.
  const intervalMin = Number.isFinite(physical && physical.interval_minutes) ? physical.interval_minutes : 15;
  const pointsIn24h = Math.max(2, Math.round((24 * 60) / intervalMin));
  const spark = physical && physical.net_series && physical.net_series.length >= 2
    ? buildSparkline(physical.net_series, {
        count: pointsIn24h,
        readValue: (pt) => pt.net,
        headingOf: (recent) => `Net position, last ~24h (${recent.length} interval${recent.length === 1 ? "" : "s"}, ${esc(unit)}, measured)`,
        captionOf: (recent, max) => {
          const last = recent[recent.length - 1];
          if (!last) return "";
          const val = `${last.net > 0 ? "+" : ""}${Number(last.net).toFixed(2)} ${unit}`;
          return `${last.t || "latest"}: ${val} &middot; peak ${max.toFixed(2)} ${unit}`;
        },
      })
    : "";

  return `
    <div class="cstats">
      ${netNow != null
        ? `<div class="cstat hot"><span class="cstat-v">${netNow > 0 ? "+" : ""}${Number(netNow).toFixed(2)} ${esc(unit)}</span>net exchange, measured</div>`
        : ""}
      ${outage
        ? `<div class="cstat"><span class="cstat-v">${fmtNumber(Math.round(outage.score))}</span>IODA outage score</div>`
        : ""}
    </div>
    ${spark}
    ${regionSummary
      ? `<div class="meta">Sub-national: ${regionSummary.matched} of ${regionSummary.total} IODA-scored
          region(s) here matched to a state/province boundary (see its own card).</div>`
      : ""}
    ${!physical ? '<p class="meta">No cross-border electricity data published for this country -- the score above stands alone.</p>' : ""}
    ${!outage ? '<p class="meta">No internet-disruption score currently reported for this country -- the exchange figure above stands alone.</p>' : ""}
    <p class="meta"><b>Two independent measurements on two different clocks, placed side by side, not
      combined.</b> Cross-border flow is metered every ${esc(intervalMin)} minutes by grid operators; the
      outage score is IODA's own composite over its own reporting window. Neither is derived from the
      other, and a coincidence between a swing in one and a spike in the other is exactly that &mdash; a
      coincidence worth noticing, not a causal claim this app makes for you.</p>
    <div class="meta">Source: Energy-Charts (Fraunhofer ISE) republishing ENTSO-E, <i>measured</i> &middot;
      IODA (Georgia Tech), <i>derived</i> composite score.</div>`;
}

// --- food balance sheets and the price index (food_trade.py) ------------
//
// Three independent bodies estimate every number here and this card never
// averages them: the distance between them is itself the signal. The backend
// keeps them apart all the way to this point and stamps its own spread figure
// `inferred_by`, so the only thing left to do is not undo that.
const FOOD_DB_ORDER = ["CBS", "IGC", "PSD"];
const FOOD_COLUMNS = [
  ["production", "Production"],
  ["imports_nmy", "Imports"],
  ["exports_nmy", "Exports"],
  ["closing_stocks", "Closing stocks"],
];

// A blank AMIS field is "not published", which is not zero -- every IGC row
// leaves other uses blank and every USDA row leaves food and feed use blank.
function fmtOrDash(value) {
  return value == null ? "&mdash;" : fmtNumber(value);
}

function foodCommodityBlock(commodity) {
  const present = FOOD_DB_ORDER.filter((db) => commodity.estimates && commodity.estimates[db]);
  if (!present.length) return "";
  const spread = commodity.spread && commodity.spread.fields && commodity.spread.fields.production;
  return `
    <div class="csection-h">${esc(commodity.product || commodity.commodity)}${
      commodity.season ? ` &middot; ${esc(commodity.season)} (marketing year)` : ""
    }</div>
    <table class="food-estimates">
      <tr><th></th>${FOOD_COLUMNS.map(([, label]) => `<th>${label}</th>`).join("")}</tr>
      ${present.map((db) => {
        const e = commodity.estimates[db];
        return `<tr><td>${esc(e.publisher || db)}</td>${
          FOOD_COLUMNS.map(([field]) => `<td>${fmtOrDash(e[field])}</td>`).join("")
        }</tr>`;
      }).join("")}
    </table>
    ${commodity.units ? `<div class="meta">${esc(commodity.units)} &middot; trade counted on the national
      marketing year, which is a different quantity from calendar-year trade.</div>` : ""}
    ${spread
      ? `<div class="inferred-block">
          <div>The three bodies are <b>${fmtNumber(spread.spread)} ${esc(commodity.units || "")}</b> apart on
            production &mdash; ${esc(spread.high_source)} highest, ${esc(spread.low_source)} lowest.</div>
          <div class="meta">${esc(commodity.spread.basis || "")} Computed by
            ${esc(commodity.spread.inferred_by || "this app")}.</div>
        </div>`
      : ""}`;
}

function buildFoodTrade(props, raw) {
  const record = foodRecordFor(props, raw);
  const price = raw.foodPriceIndex || null;
  const commodities = record && record.commodities ? Object.values(record.commodities) : [];
  const blocks = commodities.map(foodCommodityBlock).filter(Boolean);
  const latest = price && price.latest;
  // The global index is context for this country's balance sheets, not a
  // section in its own right. A country AMIS does not cover gets no food fold
  // at all rather than one whose only content says "this is not about you" --
  // that would be 150-odd cards carrying a number none of them is about.
  if (!blocks.length) return "";
  const priceLabel = (key) => esc((price.labels && price.labels[key]) || key);
  return `
    ${blocks.join("")}
    ${blocks.length ? `
    <p class="meta"><b>Three independent bodies estimate every number here and this card never averages
      them.</b> FAO, the International Grains Council and USDA all forecast the same quantity, and the
      distance between them is itself the signal &mdash; a figure they agree on to within a percent is
      settled, one they differ on by ten percent is a market nobody can see clearly. A dash is
      &ldquo;not published&rdquo;, which is not zero.</p>
    <p class="meta"><b>These are forecasts.</b> A marketing-year balance sheet is not an observation
      &mdash; the year has not finished and most of it has not happened. This is a different kind of
      claim from anything else on this map, and it is labelled as one.</p>` : ""}
    ${latest ? `
    <div class="csection-h">FAO Food Price Index &mdash; global, not this country</div>
    <div>${priceLabel("food_price_index")}: <b>${fmtNumber(latest.food_price_index)}</b> in
      ${esc(latest.month)}${price.base_period ? ` (${esc(price.base_period)})` : ""}</div>
    <div class="meta">${["cereals", "oils", "dairy", "meat", "sugar"]
      .filter((k) => latest[k] != null)
      .map((k) => `${priceLabel(k)} ${fmtNumber(latest[k])}`)
      .join(" &middot; ")}</div>
    <p class="meta">One worldwide monthly series, shown in every country's card because it is the number
      the balance sheets above should be read beside &mdash; a tightening balance and a rising cereal
      price are one story told from the supply side and the demand side. It is <b>not a figure about this
      country</b>, and it is an index of what happened rather than a forecast, which is the opposite
      evidence footing to everything above it.</p>` : ""}
    ${record && record.note ? `<p class="meta">${esc(record.note)}</p>` : ""}
    <div class="meta">Sources: ${
      [record && record.attribution, latest && price.attribution].filter(Boolean).map(esc).join(" &middot; ")
    } &mdash; curated forecasts (AMIS) and an observed index (FPI).</div>`;
}

// ---------- Task 9: energy, military, transport, data coverage ----------
//
// Four more sections, all read from data the app already has in hand for its
// own layers -- same discipline buildLivePicture set: no extra request fires
// just because a country was clicked. All four share two problems the rest of
// the card mostly doesn't: OpenStreetMap and Global Dam Watch are swept over
// only this app's eleven tracked conflict theatres (see osm_infra.py's and
// dams.py's own module docstrings), so a country outside every theatre reads
// zero from either not because it has none of that thing, but because the
// sweep never reached it. Every section below that draws on raw.osmInfra or
// raw.dams says so, rather than let an honest "not swept" read as "confirmed
// empty" -- the same mistake the OSM output_mw caveat two sections down exists
// to prevent for a single field, generalised here to a whole feed.
const OSM_SWEEP_CAVEAT = "OpenStreetMap's sweep behind the figures above covers only this app's eleven "
  + "tracked conflict theatres, not the whole world &mdash; a zero here can mean the sweep never reached "
  + "this country, not that nothing is here.";
const DAM_SWEEP_CAVEAT = "Global Dam Watch is limited the same way here: swept only over those same eleven "
  + "theatres, not the whole world.";

/**
 * Group a list by some key, dropping items the key function says are
 * unclassifiable into their own bucket rather than a bucket named "null".
 * Shared by the energy section's by-source breakdown and the transport
 * section's size-class bucketing -- the same small piece of arithmetic both
 * need, so it exists once rather than as two hand-rolled loops that could
 * quietly disagree about how a missing key is counted.
 *
 * Not exported itself; the two call sites below (summarizePowerPlants,
 * bucketAirportsByType, bucketPortsBySize) are what the tests exercise, since
 * those are the shapes a caller actually needs.
 */
function tallyBy(items, keyOf) {
  const counts = {};
  let unclassified = 0;
  for (const item of items || []) {
    const key = keyOf(item);
    if (key == null) {
      unclassified += 1;
      continue;
    }
    counts[key] = (counts[key] || 0) + 1;
  }
  return { counts, unclassified, total: (items || []).length };
}

// ---------- energy infrastructure (beside the existing cross-border section) ----------
//
// Task 8 already gave this card a "Cross-border electricity" fold
// (buildEnergy/id "power" below) for what the interconnectors carry and what
// the day-ahead market sold -- a claim about flows crossing a border, which
// has no location of its own and is deliberately not on the map. This section
// is the opposite kind of claim: what generates and stores power *inside*
// this country's own bbox. Kept as a separate fold rather than folded into
// "power" -- physical vs. commercial flow (measured vs. scheduled) is already
// the one distinction that section exists to make, and stacking "how much
// generation capacity is here" on top would blur that into a second,
// unrelated distinction sharing one heading. Task 9's brief leaves the choice
// open; this is the "add beside it" branch, and nothing about buildEnergy
// below (including its net_series sparkline and coverage line, both new in
// Task 8) is touched.
const ENERGY_SOURCE_CAP = 6;

/**
 * Power plants, reduced to the one arithmetic problem the brief calls out by
 * name: OSM tags `output_mw` on a minority of the plants it has, and a sum
 * over only the tagged ones must never be presented as this country's
 * generation capacity. Exported so that arithmetic -- including the case
 * where every plant in view is untagged -- is tested directly, without
 * building a card around it.
 *
 * Review fix (Task 28, Important 1): buckets on `p.fuel`, osm_infra.py's own
 * normalised _fuel_category, not the raw `source_tag`. Grouping on the raw
 * tag was the bug this fixes -- "gas", "gas;oil" and "natural gas" would
 * have shown as three separate rows in the card while decorators.js drew all
 * three as the same glyph, the exact place raw-tag noise was most likely to
 * leak past the normalisation this task added and be read by a user.
 */
export function summarizePowerPlants(plants) {
  const list = plants || [];
  const tagged = list.filter((p) => Number.isFinite(p.output_mw));
  const totalOutputMw = tagged.reduce((sum, p) => sum + p.output_mw, 0);
  const { counts } = tallyBy(list, (p) => p.fuel || null);
  return {
    count: list.length,
    taggedCount: tagged.length,
    totalOutputMw,
    byFuel: Object.entries(counts).sort((a, b) => b[1] - a[1]),
  };
}

// Task 28: which curated backend/infrastructure.py site types count as
// "refineries & terminals" for this section -- deliberately narrower than
// every type INFRA_STYLE draws (desalination and fabs are their own subject,
// not energy generation/storage/transport).
const CURATED_ENERGY_INFRA_TYPES = new Set(["refinery", "lng_terminal", "port"]);
const OSM_ENERGY_INFRA_KINDS = new Set(["refinery", "storage_tank", "oil_well"]);

function buildEnergyInfrastructure(bounds, raw) {
  // Task 28: power plants moved off raw.osmInfra onto their own raw.powerPlants
  // array (see createMapController.js's applyData) -- reading the old
  // osmInfra-filtered-by-kind path here would silently report zero forever.
  const plants = itemsInBounds(raw.powerPlants, bounds);
  const substations = itemsInBounds(raw.osmInfra, bounds, (d) => d.kind === "power_substation");
  const dams = itemsInBounds(raw.dams, bounds);
  const landings = itemsInBounds(raw.cableLandings, bounds);
  const curatedEnergySites = itemsInBounds(raw.infra, bounds, (d) => CURATED_ENERGY_INFRA_TYPES.has(d.type));
  const osmEnergySites = itemsInBounds(raw.osmInfra, bounds, (d) => OSM_ENERGY_INFRA_KINDS.has(d.kind));
  if (!plants.length && !dams.length && !landings.length
    && !curatedEnergySites.length && !osmEnergySites.length && !substations.length) {
    // Task 32: powerPlants/substations read osmInfra's own coverage record --
    // see COVERAGE_FEEDS' note on why that split has no fetchCoverage entry
    // of its own.
    const reason = emptyFoldReason(["osmInfra", "dams", "cableLandings", "infra"], bounds, raw);
    return reason ? emptyFoldNote(reason) : "";
  }

  const summary = summarizePowerPlants(plants);
  const shownFuels = summary.byFuel.slice(0, ENERGY_SOURCE_CAP);

  const damPower = dams.filter((d) => Number.isFinite(d.power_mw));
  const damPowerMw = damPower.reduce((sum, d) => sum + d.power_mw, 0);
  const damCapacity = dams.filter((d) => Number.isFinite(d.capacity_mcm));
  const damCapacityMcm = damCapacity.reduce((sum, d) => sum + d.capacity_mcm, 0);

  const osmEnergyByKind = tallyBy(osmEnergySites, (d) => d.kind);

  return `
    <div class="cstats">
      ${statRow("", "power plants (OSM)", summary.count)}
      ${statRow("", "substations (OSM)", substations.length)}
      ${statRow("", "dams", dams.length)}
      ${statRow("", "cable landings", landings.length)}
    </div>
    ${summary.count ? `
    <div class="csection-h">Power plants</div>
    <div>${summary.taggedCount} of ${summary.count} plant${summary.count === 1 ? "" : "s"} tag a
      generation capacity in OpenStreetMap.</div>
    ${summary.taggedCount
      ? `<div><b>${fmtNumber(Math.round(summary.totalOutputMw))} MW</b> summed over just those
          ${summary.taggedCount} &mdash; <b>not this country's generation capacity</b>, since
          ${summary.count - summary.taggedCount} plant${summary.count - summary.taggedCount === 1 ? "" : "s"}
          here carry no output tag at all and contribute nothing to that sum.</div>`
      : `<div class="meta">None of the ${summary.count} plant${summary.count === 1 ? "" : "s"} found here
          tag an output figure, so no capacity total can be shown &mdash; OpenStreetMap has the sites, not
          the numbers, for this country.</div>`}
    ${shownFuels.length
      ? `<div class="meta">By fuel: ${shownFuels.map(([fuel, n]) =>
          `${esc((POWER_PLANT_FUEL_STYLE[fuel] || POWER_PLANT_FUEL_STYLE.other).label)} (${n})`).join(", ")}</div>`
      : ""}
    ` : ""}
    ${dams.length ? `
    <div class="csection-h">Dams</div>
    <div>${damPower.length} of ${dams.length} dam${dams.length === 1 ? "" : "s"} report a generation
      capacity: <b>${fmtNumber(Math.round(damPowerMw))} MW</b> summed over ${damPower.length === dams.length ? "all of them" : `just those ${damPower.length}`}.</div>
    <div>${damCapacity.length} of ${dams.length} report a reservoir capacity:
      <b>${fmtNumber(Math.round(damCapacityMcm))} million m&sup3;</b> summed over ${damCapacity.length === dams.length ? "all of them" : `just those ${damCapacity.length}`}.</div>
    ` : ""}
    ${plants.length && dams.length
      ? `<p class="meta">A hydroelectric facility can be listed both ways -- as an OSM power plant tagged
          <code>source=hydro</code> and, separately, as a Global Dam Watch dam with its own
          <code>power_mw</code> -- and the two figures above are never summed against each other. Do not add
          them together yourself; the same station may be counted in both.</p>`
      : ""}
    ${(curatedEnergySites.length || osmEnergySites.length) ? `
    <div class="csection-h">Refineries, terminals &amp; storage</div>
    <p class="meta">Two independent claims about the same kind of site, kept apart rather than summed:
      this app's own curated, hand-checked list, and what OpenStreetMap's mappers have separately
      surveyed.</p>
    ${curatedEnergySites.length
      ? `<div class="meta">${curatedEnergySites.length} curated:</div>${infraListRows(curatedEnergySites, null, (d) => d.name)}`
      : '<div class="meta">None on this app\'s curated list here.</div>'}
    ${osmEnergySites.length
      ? `<div class="meta">${osmEnergySites.length} from OpenStreetMap: ${["refinery", "storage_tank", "oil_well"]
          .filter((k) => osmEnergyByKind.counts[k])
          .map((k) => `${esc(OSM_INFRA_STYLE[k].label.toLowerCase())} (${osmEnergyByKind.counts[k]})`).join(", ")}</div>`
      : '<div class="meta">None from the OpenStreetMap sweep here.</div>'}
    ` : ""}
    <p class="meta">${OSM_SWEEP_CAVEAT} ${DAM_SWEEP_CAVEAT}</p>
    <div class="meta">Source: OpenStreetMap contributors (ODbL), via Overpass, <i>reported</i> by its
      mappers and not checked by hand &middot; Global Dam Watch v1.0 (CC BY 4.0), <i>reported</i> by the
      dataset's own contributing surveys &middot; TeleGeography submarine cable landings &middot; this app's
      curated critical-infrastructure list, <i>reported</i>, hand-checked coordinates.</div>`;
}

// ---------- military & security ----------
//
// Sanctioned hulls and tails are matched on their *registry*, not their
// position: an OFAC-listed flag state or an aircraft's ICAO allocation-block
// country is a fact about who a hull or airframe is claimed under, unrelated
// to where it happens to be on the map right now. So this half of the
// section is not bbox-scoped like the rest of it, and says so in its own
// caveat rather than borrowing the bbox one it does not share.
const SANCTIONED_LIST_CAP = 6;

function sanctionedByFlag(props, raw) {
  const wanted = normalizeCountryName(props.name);
  const iso2 = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null;
  const ships = wanted
    ? (raw.ais || []).filter((d) => isSanctioned(d) && normalizeCountryName(d.sanctions.flag || "") === wanted)
    : [];
  // hex_country is derived from the aircraft's permanent ICAO 24-bit
  // allocation (see decorators.js's own note on it vs. origin_country) --
  // the closest thing an airframe has to a flag state, and the only one
  // OFAC's own listing data does not carry for aircraft rows.
  const aircraft = iso2
    ? (raw.adsb || []).filter((d) => isSanctioned(d) && d.hex_country === iso2)
    : [];
  return { ships, aircraft };
}

function sanctionedRows(ships, aircraft) {
  const shipRows = ships.slice(0, SANCTIONED_LIST_CAP).map((d) => {
    const open = openableRow("ais", d.mmsi);
    return `<div${open || ' class="event-row"'}><b>${esc(d.name || `MMSI ${d.mmsi}`)}</b>
      <div class="event-meta">${esc(d.sanctions.program || "OFAC-designated")} &middot; vessel</div></div>`;
  }).join("");
  const aircraftRows = aircraft.slice(0, SANCTIONED_LIST_CAP).map((d) => {
    const open = openableRow("adsb", d.icao24);
    return `<div${open || ' class="event-row"'}><b>${esc(d.registration || d.callsign || d.icao24)}</b>
      <div class="event-meta">${esc(d.sanctions.program || "OFAC-designated")} &middot; aircraft</div></div>`;
  }).join("");
  return shipRows + aircraftRows;
}

// Task 29: how many distinct physical installations raw.militaryBases
// reports, treating an OSM record the backend already matched to a curated
// one (matched_curated_id) as corroborating evidence for that site rather
// than a second installation -- the same arithmetic backend/infrastructure.py's
// own count_distinct_bases applies, over the pre-merged document that same
// module's merge_military_bases already served (see /api/infrastructure).
function distinctBaseCount(bases) {
  return bases.reduce((n, s) => n + (s.source === "curated" || !s.matched_curated_id ? 1 : 0), 0);
}

const BASE_LIST_CAP = 8;

function baseTypeLabel(site) {
  if (site.source === "curated") {
    return (MILITARY_SUBTYPE_STYLE[site.subtype] || {}).label || site.subtype || "Military site";
  }
  return OSM_INFRA_STYLE[site.kind]?.label || site.kind;
}

// One row per site, mixed provenance -- a curated entry opens the `infra`
// marker it already is, an OSM entry opens `osmInfra`, and one stamped
// `matched_curated_id` says so in its own row rather than being hidden or
// summed into its curated twin (see merge_military_bases' own docstring on
// why the two never blend into one record).
//
// Task 32 review (empty-state sweep, known instance 2): `ambiguous_match`
// (backend/infrastructure.py's `_closest_curated_match`) is the other half
// of the same record -- an OSM site that sat within range of *more than one*
// curated site had its match refused on purpose, which used to look
// identical to "no curated site nearby" (both left `matched_curated_id`
// unset). Read here so the row says which of the two actually happened.
function militaryBaseRows(sites) {
  const rows = sites.slice(0, BASE_LIST_CAP).map((site) => {
    const open = openableRow(site.source === "curated" ? "infra" : "osmInfra", site.id);
    const corroborated = site.source === "osm" && site.matched_curated_id;
    return `<div${open || ' class="event-row"'}>${esc(site.name)}
      <div class="event-meta">${esc(baseTypeLabel(site))} &middot; ${
        site.source === "curated" ? "curated" : "OpenStreetMap"
      }${corroborated ? " &middot; also on the curated list" : ""}${
        site.ambiguous_match ? " &middot; more than one curated site within 5km, match refused" : ""
      }${
        site.operator ? ` &middot; operator per OSM: ${esc(site.operator)}` : ""
      }</div></div>`;
  }).join("");
  const more = sites.length > BASE_LIST_CAP ? `<div class="meta">+${esc(sites.length - BASE_LIST_CAP)} more</div>` : "";
  return rows + more;
}

// Which airfields in view have actually moved military traffic in the last
// 24h, per backend/sources/airfield_activity.py -- joined against raw.airports
// (the only place a code from that document has a coordinate at all, see that
// module's own docstring) rather than treated as a layer of its own.
function militaryAirfieldActivity(bounds, raw) {
  const activity = raw.airfieldActivity || {};
  return itemsInBounds(raw.airports, bounds)
    .map((a) => activity[a.id] || activity[a.icao] || activity[a.iata])
    .filter((entry) => entry && entry.military_aircraft > 0)
    .sort((a, b) => b.military_aircraft - a.military_aircraft);
}

// The same region-bounds-containment test countryCardSections' own
// escalationZone already runs against raw.escalation -- restated rather than
// shared, since the two documents key their per-zone entries differently
// (escalation by array index, this by region_key) and factoring one helper
// out for two call sites with different input shapes was not worth the
// indirection here.
function navalPresenceRegion(bounds, raw) {
  if (!bounds) return null;
  const cLat = (bounds.south + bounds.north) / 2;
  const cLon = (bounds.west + bounds.east) / 2;
  return Object.values(raw.navalPresence?.regions || {}).find((z) => {
    if (!Array.isArray(z.bounds)) return false;
    const [zs, zw, zn, ze] = z.bounds;
    return cLat >= zs && cLat <= zn && cLon >= zw && cLon <= ze;
  }) || null;
}

// Task 29 review (Important 2): this used to appear only on the water card's
// own naval line, in different words, and not at all on the country card's --
// so the identical claim ("N naval hulls in {label}") carried a different
// level of honesty depending on which card happened to be open. Said once
// here and reused by both call sites (navalPresenceHtml and buildWaterTraffic)
// so that can never happen again. It matters because the theatre boxes are
// large: south_china_sea (-4,102 -> 23,121) reaches the Gulf of Thailand and
// the Sulu Sea; red_sea_yemen (10,38 -> 20,51) reaches the whole Gulf of
// Aden -- a hull in either is reported here, whether or not it is actually
// inside the sea or country a reader opened. Not shown next to a *port*
// line: a port match is a precise id, not a theatre-box substitution, so it
// carries no version of this caveat.
const NAVAL_PRESENCE_THEATRE_CAVEAT =
  "Reported for the wider conflict theatre this sits inside, not this exact area -- a hull anywhere in the theatre counts here.";

// One sentence per zone/port -- "N naval hulls here, up/down/unchanged from
// the day before", or, honestly, that the trend cannot be stated at all when
// backend/refine/naval_presence.py's own coverage check tripped (see that
// module's docstring on why the check exists and what it protects against:
// a change in how much of the world this map is listening to, read as a
// change in how many hulls are at sea).
//
// Day-over-day, not week-over-week: the comparison this reports is whatever
// entity_history can still hold when the job runs (pruned at
// config.HISTORY_RETENTION_SECONDS, 3 days), so the baseline is the 24h
// before the current 24h -- see that module's "The baseline compares against
// the day before, not a week before" section. `week_ago` is still the field
// name the served document uses; the period it covers is a day.
function navalPresenceSentence(label, entry) {
  const current = entry.current || 0;
  const noun = current === 1 ? "naval hull" : "naval hulls";
  if (!entry.trend_computable) {
    return `${current} ${noun} in ${esc(label)} right now &mdash; trend not shown: ${esc(entry.reason || "AIS coverage changed across the comparison window")}.`;
  }
  if (entry.trend > 0) return `${current} ${noun} in ${esc(label)} right now, up from ${entry.week_ago} the day before.`;
  if (entry.trend < 0) return `${current} ${noun} in ${esc(label)} right now, down from ${entry.week_ago} the day before.`;
  return `${current} ${noun} in ${esc(label)} right now, unchanged from the day before.`;
}

function navalPresenceHtml(bounds, raw) {
  const region = navalPresenceRegion(bounds, raw);
  const ports = itemsInBounds(raw.infra, bounds, (d) => d.type === "port")
    .map((p) => ({ name: p.name, entry: raw.navalPresence?.ports?.[p.id] }))
    .filter((r) => r.entry);
  if (!region && !ports.length) return "";
  return `
    <div class="csection-h">Naval presence</div>
    ${region ? `<div>${navalPresenceSentence(region.label, region)}</div>
      <div class="meta">${NAVAL_PRESENCE_THEATRE_CAVEAT}</div>` : ""}
    ${ports.map((p) => `<div>${navalPresenceSentence(p.name, p.entry)}</div>`).join("")}
    <p class="meta">Navy-classified AIS contacts (ITU-R M.1371 &ldquo;military operations&rdquo;), <i>derived</i>
      from the last 24 hours of this map's own recorded AIS history, compared against the 24 hours before
      that (backend/refine/naval_presence.py's own CURRENT_WINDOW_HOURS and WINDOW_DAYS). The comparison is
      day-over-day rather than week-over-week because that history is pruned after 3 days, so a week-old
      baseline no longer exists to compare against. A warship broadcasting no AIS, or a navy that does not
      use this classification, is invisible to this count entirely -- absence here is not evidence of
      absence at sea.</p>`;
}

// EASA's Conflict Zone Information Bulletins (backend/sources/czib.py),
// cross-referenced into this section by the same country_code every CZIB pin
// already carries -- see buildEnergyInfrastructure for the sibling pattern of
// pulling a country-scoped list off a feed that mostly renders as pins of
// its own.
//
// NOTAMs (Notices to Air Missions -- the actual, hour-by-hour airspace
// closures a pilot flight-plans against) are out of scope for this map
// entirely, here and everywhere else: there is no free global NOTAM feed
// with a licence this project can use. CZIB is the closest attributed,
// licence-clear substitute this map has -- a named regulator's own standing
// advisory -- and it is presented as exactly that, not as a NOTAM stand-in.
function czibForCountry(raw, props) {
  const iso2 = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null;
  if (!iso2) return [];
  return (raw.czib || []).filter((b) => b.active && b.country_code === iso2);
}

function czibRows(bulletins) {
  return bulletins.slice(0, 4).map((b) => {
    const open = openableRow("czib", b.id);
    const scope = b.bulletin_countries?.length > 1 ? ` &middot; covers ${b.bulletin_countries.length} countries` : "";
    return `<div${open || ' class="event-row"'}>${esc(b.name)}
      <div class="event-meta">${esc(b.reference || "EASA CZIB")}${scope}</div></div>`;
  }).join("");
}

function buildMilitary(bounds, raw, props) {
  // The broader, fragment-heavy landuse=military area class stays its own
  // stat -- see osm_infra.py's own note on why it is deliberately not one of
  // the six kinds merge_military_bases treats as an installation.
  const militaryAreas = itemsInBounds(raw.osmInfra, bounds, (d) => d.kind === "military_area");
  const basesInBounds = itemsInBounds(raw.militaryBases, bounds);
  const aircraft = itemsInBounds(raw.adsb, bounds, (a) => classifyAircraft(a) === "military");
  const navy = itemsInBounds(raw.ais, bounds, (s) => classifyShip(s) === "navy");
  const { ships: sanctionedShips, aircraft: sanctionedAircraft } = sanctionedByFlag(props, raw);
  const airActivity = militaryAirfieldActivity(bounds, raw);
  const navalHtml = navalPresenceHtml(bounds, raw);
  const czibBulletins = czibForCountry(raw, props);

  if (!militaryAreas.length && !basesInBounds.length && !aircraft.length && !navy.length
    && !sanctionedShips.length && !sanctionedAircraft.length && !airActivity.length
    && !navalHtml && !czibBulletins.length) {
    // Task 32: militaryBases rides raw.infra's own coverage record (both
    // arrive on the same one-shot /api/infrastructure payload -- see
    // useOsintData.js's publishFetchOutcome call for it).
    const reason = emptyFoldReason(["osmInfra", "infra", "adsb", "ais"], bounds, raw);
    return reason ? emptyFoldNote(reason) : "";
  }

  const roleCounts = tallyBy(aircraft, (a) => (a.military_role && MILITARY_ROLE_STYLE[a.military_role] ? a.military_role : null));
  const roleEntries = Object.entries(roleCounts.counts).sort((a, b) => b[1] - a[1]);

  const cells = [
    statRow("", "installations (curated + OSM)", distinctBaseCount(basesInBounds), "hot"),
    statRow("", "military areas (OSM, broader)", militaryAreas.length),
    statRow("", "military aircraft", aircraft.length, "hot"),
    statRow("", "navy vessels", navy.length),
  ].join("");

  return `
    <div class="cstats">${cells}</div>
    ${BBOX_LOAD_CAVEAT}
    ${roleEntries.length
      ? `<div class="meta">Aircraft by role: ${roleEntries.map(([role, n]) => `${esc(MILITARY_ROLE_STYLE[role].label)} (${n})`).join(", ")}</div>`
      : ""}
    ${basesInBounds.length ? `<div class="csection-h">Bases &amp; installations</div>
    <p class="meta">This app's own curated list beside OpenStreetMap's military=* sweep -- two independent
      claims, kept apart rather than blended (see any site's own popup for which one it is). A site OSM also
      corroborates against the curated list is noted, not summed twice into the count above.</p>
    ${militaryBaseRows(basesInBounds)}` : ""}
    ${militaryAreas.length ? `<div class="csection-h">Military areas (OpenStreetMap)</div>${
      infraListRows(militaryAreas, "osmInfra", (d) => d.name)
    }<p class="meta">${OSM_SWEEP_CAVEAT}</p>` : ""}
    ${basesInBounds.some((s) => s.source === "curated") ? `<p class="meta">A curated base's own popup
      (click its pin, or the row above) shows recent conflict activity within 75km, the same hot-zone flare
      every curated infrastructure site carries -- OpenStreetMap-sourced pins do not carry that flare yet.</p>` : ""}
    ${airActivity.length ? `<div class="csection-h">Airfields with recent military movements</div>
    ${airActivity.slice(0, 6).map((entry) => `<div class="event-row">${esc(entry.name || entry.code)}
      <div class="event-meta">${entry.military_aircraft} of ${entry.aircraft} movements in the last 24h were
        military</div></div>`).join("")}
    <p class="meta">Derived from this map's own recorded ADS-B history (backend/sources/airfield_activity.py),
      ranked so a small field where nearly every movement is military is not crowded out by a busy civil hub's
      much larger raw count. NOTAMs (official notice-to-airmen airspace restrictions) are out of scope for this
      map -- no free global feed publishes them under a usable licence -- so this is recorded traffic, not a
      published closure.</p>` : ""}
    ${navalHtml}
    ${czibBulletins.length ? `<div class="csection-h">Airspace warnings (EASA CZIB)</div>
    ${czibRows(czibBulletins)}
    <p class="meta">Standing regulator advisories, not incidents -- see the Airspace layer for the full set.</p>` : ""}
    ${(sanctionedShips.length || sanctionedAircraft.length) ? `
    <div class="csection-h">Sanctioned hulls & tails flagged to ${esc(props.name || "this country")}</div>
    ${sanctionedRows(sanctionedShips, sanctionedAircraft)}
    <p class="meta">Matched on OFAC's listed flag state for vessels and the aircraft's ICAO
      allocation-block country for tails &mdash; both are a claim about the registry a hull or airframe is
      held under, not about where it is right now, so this list is <b>not</b> limited to the area currently
      loaded the way the counts above are.</p>` : ""}
    <div class="meta">Sources: OpenStreetMap contributors (ODbL) via Overpass, <i>reported</i> &middot;
      curated infrastructure list (this app, hand-checked coordinates), <i>reported</i> &middot; ADS-B
      military classification, <i>inferred</i> from callsign/registry heuristics where no confirmed flag is
      available (see the aircraft's own popup) &middot; AIS navy classification, <i>derived</i> from the
      vessel's own broadcast ship-type code &middot; recorded ADS-B movement history, <i>derived</i> &middot;
      recorded AIS movement history, <i>derived</i> &middot; EASA Conflict Zone Information Bulletins,
      <i>reported</i> &middot; OFAC Specially Designated Nationals list (US Treasury), <i>reported</i>.</div>`;
}

// ---------- transport ----------
const PORT_SIZE_ORDER = ["Large", "Medium", "Small", "Very small"];

/** Airports bucketed by OurAirports' own size class. Exported for the test. */
export function bucketAirportsByType(airports) {
  return tallyBy(airports, (a) => (AIRFIELD_STYLE[a.type] ? a.type : null));
}

/** Ports bucketed by the World Port Index's own harbour-size label. */
export function bucketPortsBySize(ports) {
  return tallyBy(ports, (p) => p.harbor_size_label || null);
}

function buildTransport(bounds, raw) {
  const airports = itemsInBounds(raw.airports, bounds);
  const ports = itemsInBounds(raw.ports, bounds);
  const crossings = itemsInBounds(raw.osmInfra, bounds, (d) => d.kind === "border_control");
  // Task 27: railway_* kinds moved off raw.osmInfra onto their own layer's
  // raw.railwayPoints (see createMapController.js's applyData note) -- same
  // OpenStreetMap sweep, just its own array now, so no predicate is needed.
  const rail = itemsInBounds(raw.railwayPoints, bounds);
  if (!airports.length && !ports.length && !crossings.length && !rail.length) {
    // Task 32: railwayPoints rides osmInfra's own coverage record -- same
    // client-side split as powerPlants (see buildEnergyInfrastructure).
    const reason = emptyFoldReason(["airports", "ports", "osmInfra"], bounds, raw);
    return reason ? emptyFoldNote(reason) : "";
  }

  const airportBuckets = bucketAirportsByType(airports);
  const portBuckets = bucketPortsBySize(ports);
  const oilTerminals = ports.filter((p) => p.oil_terminal).length;
  const railBuckets = tallyBy(rail, (d) => d.kind);

  return `
    <div class="cstats">
      ${statRow("", "airports", airports.length)}
      ${statRow("", "ports", ports.length)}
      ${statRow("", "border crossings (OSM)", crossings.length)}
      ${statRow("", "rail stops (OSM)", rail.length)}
    </div>
    ${BBOX_LOAD_CAVEAT}
    ${airports.length ? `<div class="csection-h">Airports by size</div>
      <div>${AIRFIELD_ORDER.filter((t) => airportBuckets.counts[t]).map((t) => `${esc(AIRFIELD_STYLE[t].label)} (${airportBuckets.counts[t]})`).join(", ")
        || "size not classified by OurAirports"}</div>` : ""}
    ${ports.length ? `<div class="csection-h">Ports by size</div>
      <div>${PORT_SIZE_ORDER.filter((s) => portBuckets.counts[s]).map((s) => `${esc(s)} (${portBuckets.counts[s]})`).join(", ")
        || "size not classified"}${portBuckets.unclassified ? `, ${portBuckets.unclassified} not classified` : ""}${
        oilTerminals ? ` &middot; <b>${oilTerminals}</b> with an oil terminal` : ""
      }</div>` : ""}
    ${crossings.length ? `<div class="csection-h">Border crossings (OpenStreetMap)</div>${infraListRows(crossings, "osmInfra", (d) => d.name)}` : ""}
    ${rail.length ? `<div class="csection-h">Rail (OpenStreetMap)</div>
      <div>${OSM_INFRA_ORDER.filter((k) => k.startsWith("railway_") && railBuckets.counts[k])
        .map((k) => `${esc(OSM_INFRA_STYLE[k].label)} (${railBuckets.counts[k]})`).join(", ")}</div>` : ""}
    ${(crossings.length || rail.length) ? `<p class="meta">${OSM_SWEEP_CAVEAT}</p>` : ""}
    <div class="meta">Sources: OurAirports (public domain), <i>reported</i> &middot; NGA World Port Index,
      <i>reported</i> reference data, roughly 2024-vintage &mdash; nothing in this feed is current &middot;
      OpenStreetMap contributors (ODbL) via Overpass, <i>reported</i>, for border crossings and rail.</div>`;
}

// ---------- data coverage: the honesty section ----------
//
// Every other fold above can be dropped when it has nothing to say -- an
// empty fold costs a click to discover, so countryCardSections filters it
// out. This one is the deliberate exception: it is the place a reader checks
// *why* a fold above is empty, so it has to survive being empty itself. It
// never returns "" and countryCardSections never gets the chance to drop it.
//
// Three things this section refuses to conflate, per feed:
//
//  1. "This map never fetched this feed at all" -- raw[key] starts life as
//     `[]` at construction (see createMapController.js) and stays that shape
//     whether or not a poll has ever landed, so an empty array on its own
//     cannot answer this. The real answer lives in raw.fetchCoverage
//     (written by useOsintData.js's recordCoverageRef): a feed with no entry
//     there, or one whose `fetchedAt` is still null, has never actually
//     returned anything to this browser tab -- most often because its own
//     zoom gate (scene.js) has not lifted yet, which happens routinely for a
//     country clicked straight from world view.
//  2. "This map fetched this feed, but for a different area" -- several of
//     these feeds are bbox-scoped (airports, dams, osmInfra, ports, jamming,
//     firms -- see scene.js's `scoped` flag), and the last successful fetch's
//     bbox does not always cover the country whose card is open: the reader
//     may have clicked a country without panning to it, or the feed simply
//     has not re-polled since the reader moved. Coverage here is genuinely
//     unknown, not zero.
//  3. "This map fetched this feed, scoped to (or covering) this country, and
//     found nothing there" -- the one case that earns "no coverage here".
//
// Collapsing any two of these into one message is the exact failure this
// section exists to prevent -- see the Task 9 review that caught the first
// version of this function inferring "never fetched" from `!Array.isArray`,
// which is true from the very first render for several of these feeds
// regardless of whether anything was ever fetched.
function firmsRecordMs(item) {
  if (!item.acq_date) return null;
  const time = String(item.acq_time || "").padStart(4, "0").slice(0, 4);
  const t = Date.parse(`${item.acq_date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`);
  return Number.isFinite(t) ? t : null;
}

function eventRecordMs(item) {
  if (!item.date) return null;
  const t = Date.parse(`${item.date}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// One entry per feed the card reads somewhere above for a bbox-scoped count
// or list -- the country-keyed feeds (humanitarian, energyFlows, foodTrade,
// outages, conflictStats/conflictDistricts) are matched by ISO code or name,
// not by "inside this bbox", so "coverage inside the bbox" is not a claim
// this section can honestly make about them and they are left out.
// `whenMs` reads the freshest in-bbox record's own timestamp where the feed
// carries one; the reference gazetteers (infra/osmInfra/dams/airports/ports/
// cableLandings) carry none, and are reported as a count on file rather than
// a fabricated delivery time.
const COVERAGE_FEEDS = [
  { key: "events", label: "ACLED conflict events", provenance: "reported", whenMs: eventRecordMs },
  { key: "gdelt", label: "GDELT news", provenance: "reported", whenMs: (r) => parseGdeltDateAdded(r.date_added)?.getTime() ?? null },
  { key: "ais", label: "AIS vessel tracking (aisstream.io)", provenance: "measured", whenMs: (r) => (Number.isFinite(r.updated) ? r.updated * 1000 : null) },
  { key: "adsb", label: "ADS-B aircraft tracking", provenance: "measured", whenMs: (r) => (Number.isFinite(r.updated) ? r.updated * 1000 : null) },
  { key: "firms", label: "Fire detections (NASA FIRMS / HMS)", provenance: "measured", whenMs: firmsRecordMs },
  { key: "jamming", label: "GPS jamming cells (gpsjam.org)", provenance: "derived", whenMs: () => null },
  { key: "infra", label: "Curated critical infrastructure", provenance: "reported", whenMs: () => null },
  // Task 28: powerPlants is deliberately NOT its own row here -- it is a
  // client-side split of this same osmInfra fetch (see createMapController.js's
  // applyData), not an independent poll, so it has no fetchCoverage entry of
  // its own to read. A separate row would read "never fetched" forever, which
  // is exactly the false-negative this section exists to prevent.
  { key: "osmInfra", label: "OpenStreetMap infrastructure sweep (incl. power plants)", provenance: "reported", whenMs: () => null },
  { key: "dams", label: "Global Dam Watch", provenance: "reported", whenMs: () => null },
  { key: "airports", label: "OurAirports gazetteer", provenance: "reported", whenMs: () => null },
  { key: "ports", label: "NGA World Port Index", provenance: "reported", whenMs: () => null },
  { key: "cableLandings", label: "Submarine cable landings (TeleGeography)", provenance: "reported", whenMs: () => null },
];

function coverageRow(label, body) {
  return `<div class="event-row"><b>${esc(label)}</b><div class="event-meta">${body}</div></div>`;
}

// Absorbs the rounding bboxCell applies to whatever it fetched (a
// `toFixed(2)` snap, ~1.1 km) and the coarser grid snap the viewport-based
// cell itself uses (bboxSnapDegrees, map/scene.js) -- without this, a feed
// fetched scoped to exactly this country's own bounds (the FOCUS_PROMOTE
// path in useOsintData.js) could read as "scoped elsewhere" purely from
// float noise at the edge.
const BBOX_CELL_TOLERANCE_DEG = 0.05;

/**
 * Whether the "south,west,north,east" cell a fetch was actually scoped to
 * (raw.fetchCoverage[key].bbox) fully contains this country's bounds.
 * `null` means the fetch carried no bbox restriction at all -- either the
 * feed isn't scoped (see scene.js's `scoped` flag) or the computed cell was
 * "essentially the whole world" (bboxCell's own guard in useOsintData.js) --
 * and both mean the same thing here: nothing was clipped, so it covers
 * everything.
 */
function bboxCellCoversCountry(bboxCell, bounds) {
  if (!bboxCell) return true;
  // Task 32: emptyFoldReason's water-card callers can legitimately have no
  // `bounds` at all (a marine feature with no stored bbox -- see
  // waterCardFor's own null fallback) and still have run a real containment
  // test through insideWaterFeature, which does not need bounds either. With
  // no bounds to compare against, this cannot say the fetch missed the area --
  // that would be a false "scoped elsewhere" for a check that in fact ran --
  // so it defers to the caller's own real answer instead, same as an
  // unparseable cell does just below.
  if (!bounds) return true;
  const parts = String(bboxCell).split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true; // unparseable: not this function's failure to report
  const [south, west, north, east] = parts;
  return bounds.south >= south - BBOX_CELL_TOLERANCE_DEG
    && bounds.north <= north + BBOX_CELL_TOLERANCE_DEG
    && bounds.west >= west - BBOX_CELL_TOLERANCE_DEG
    && bounds.east <= east + BBOX_CELL_TOLERANCE_DEG;
}

/**
 * One of "not_loaded" (never fetched, most often a zoom gate that has not
 * lifted -- see COVERAGE_FEEDS' own note), "scoped_elsewhere" (fetched, but
 * not for an area that covers this country) or "checked" (the data sitting
 * in raw[key] right now genuinely covers this country's bbox, so its own
 * emptiness or non-emptiness is a real answer). Exported for the test --
 * this is the one piece of logic the Critical review finding was about.
 */
export function coverageStateFor(key, bounds, raw) {
  const coverage = (raw.fetchCoverage || {})[key];
  if (!coverage || coverage.fetchedAt == null) return "not_loaded";
  if (coverage.scoped && !bboxCellCoversCountry(coverage.bbox, bounds)) return "scoped_elsewhere";
  return "checked";
}

// ---------- Task 10: the summary strip ----------
//
// Seven compact tiles above the folds -- population, events/fatalities in the
// last 72h, an internet-connectivity score, refugees, cross-border net power
// and military aircraft. Each one already has a fold behind it somewhere in
// this file (buildConflictSummary, buildConnectivity, buildHumanitarian,
// buildEnergy, buildLivePicture) and this is deliberately not a second source
// of truth for any of them: it reads the same raw buckets those folds read,
// and reuses coverageStateFor for exactly the reason buildCoverage does --
// so a tile's dash and its own fold's "why is this empty" line can never
// disagree about what happened.
//
// The project rule this whole card follows: a value we did not receive from
// a source is never shown as zero. A tile with nothing to show renders a dash
// and a tooltip saying why -- never fetched, fetched for a different area, or
// fetched and genuinely nothing to report (no ISO3 to match on, no bidding
// zone, no anomaly this window). Only a real, checked figure -- including a
// real, checked zero -- is ever printed as a number.
const NO_BOUNDS_REASON = "This country has no bounding box loaded, so this could not be checked.";

/**
 * The same *category* of reason buildCoverage's own rows report for these two
 * states -- not always the identical sentence. "scoped_elsewhere" here is in
 * fact copied verbatim from coverageRow's own text (the mdash aside, which is
 * an HTML entity there and a literal character here, since this string feeds
 * a React text node, not innerHTML). "not_loaded" is deliberately fuller than
 * the coverage table's terser "Not loaded this session -- not checked.": a
 * hover tooltip has room a compact table row does not, so it spells out *why*
 * ("most often because this feed's own zoom gate has not lifted") rather than
 * just naming the state. Both still answer to the same three states
 * coverageStateFor defines, so the strip and the fold can never disagree
 * about *which* of the three happened, even on the one where the words differ.
 * `null` means "checked" -- the caller has a real answer to show.
 */
function coverageReason(key, bounds, raw) {
  const state = coverageStateFor(key, bounds, raw);
  if (state === "not_loaded") {
    return "Not loaded this session yet — most often because this feed's own zoom gate has not lifted.";
  }
  if (state === "scoped_elsewhere") {
    return "Fetched, but for a different area — coverage here is unknown, not zero.";
  }
  return null;
}

/**
 * Task 32's shared mechanism -- the one place a bbox-scoped fold asks "is an
 * empty result here real, or did this map just not look?" before it decides
 * to say nothing.
 *
 * Confusing those two has been the single most repeated defect across this
 * plan (caught separately in Tasks 7, 9, 11, 16, 23, 26 and 29, each time in
 * a different component). The fix each time was local; this is the fix that
 * is not: every bbox-scoped section that counts records out of one or more
 * `raw[key]` feeds and drops itself when the count is zero calls this first,
 * with the list of feed keys its own counts actually came from. Built
 * entirely on coverageStateFor -- the same per-feed truth buildCoverage's own
 * table reads -- so a fold's silence and that table's own row for the same
 * feed can never disagree about which of the three states applies.
 *
 * Returns null when every key was genuinely checked against these bounds
 * (a real answer -- if the section's own counts are all zero, that is an
 * honest "looked and found nothing", and the section is entitled to drop
 * itself exactly as it always has). Otherwise returns one sentence explaining
 * why the section could not be a fair witness: no bounding box at all, one or
 * more of its feeds never fetched (most often a zoom gate that has not
 * lifted), or fetched for a different area. "Not loaded" outranks "scoped
 * elsewhere" when a section draws on several feeds in different states,
 * because "this map never looked" is the stronger caveat of the two.
 *
 * `keys` are COVERAGE_FEEDS keys (or the key another feed's coverage record
 * is deliberately read under -- powerPlants/railwayPoints/airDefense ride
 * osmInfra's, militaryBases rides infra's, cables rides cableLandings' --
 * see those keys' own notes on COVERAGE_FEEDS and useOsintData.js for why
 * they have no fetchCoverage entry of their own).
 *
 * `boundsOptional` is for the water-card callers: their real containment
 * test (insideWaterFeature) does not require bounds the way a country or
 * admin card's countInBounds/itemsInFeature does (see waterCardFor's own
 * note on `bounds` there being "a cheap pre-filter, not the containment test
 * itself") -- a water feature with no stored bbox still gets a real check, so
 * missing bounds must not read as "did not look" for those two callers the
 * way it correctly does for every count-based one.
 */
export function emptyFoldReason(keys, bounds, raw, { boundsOptional = false } = {}) {
  if (!bounds && !boundsOptional) return NO_BOUNDS_REASON;
  let worst = null;
  for (const key of keys) {
    const state = coverageStateFor(key, bounds, raw);
    if (state === "not_loaded") {
      worst = "not_loaded";
      break; // the stronger caveat of the two -- no need to keep checking
    }
    if (state === "scoped_elsewhere") worst = "scoped_elsewhere";
  }
  if (worst === "not_loaded") {
    return "Not loaded this session yet — most often because one of this section's own feeds has not "
      + "cleared its zoom gate. An empty section here is “not checked”, not “checked and empty”.";
  }
  if (worst === "scoped_elsewhere") {
    return "Fetched, but for a different area — coverage here is unknown, not zero.";
  }
  return null;
}

/**
 * The standard shape a bbox-scoped section renders when emptyFoldReason found
 * something to say and the section has no real cells to show either: one
 * caveat line, in the same "meta" register buildCoverage and the summary
 * strip's own tooltips use, rather than the section simply vanishing.
 */
function emptyFoldNote(reason) {
  return `<p class="meta">${esc(reason)}</p>`;
}

function tile(key, label, value, reason) {
  return value != null
    ? { key, label, value, unavailable: false, tooltip: null }
    : { key, label, value: null, unavailable: true, tooltip: reason };
}

function populationTile(props) {
  return tile(
    "population", "Population",
    props.population != null ? fmtNumber(props.population) : null,
    "Not published for this country (World Bank)."
  );
}

// Events and fatalities read the same raw.events feed (coverage key
// "events"), so one coverage check and one pass over recentConflictStats
// answers both tiles together rather than repeating either.
function boundedConflictTiles(bounds, raw) {
  if (!bounds) {
    return [
      tile("events72h", "Events, 72h", null, NO_BOUNDS_REASON),
      tile("fatalities72h", "Fatalities, 72h", null, NO_BOUNDS_REASON),
    ];
  }
  const reason = coverageReason("events", bounds, raw);
  if (reason) {
    return [
      tile("events72h", "Events, 72h", null, reason),
      tile("fatalities72h", "Fatalities, 72h", null, reason),
    ];
  }
  const { count, fatalities } = recentConflictStats(bounds, raw);
  return [
    tile("events72h", "Events, 72h", fmtNumber(count), null),
    tile("fatalities72h", "Fatalities, 72h", fmtNumber(fatalities), null),
  ];
}

// IODA's outages dict (backend/sources/outages.py) carries only countries
// above its own anomaly floor -- a country's absence from it is a real,
// checked "no disruption detected", not a missing fetch. That is a different
// reason from the coverage-vocabulary ones above, and this tile says so
// rather than borrowing wording that would claim the feed itself was never
// loaded.
function connectivityTile(props, raw) {
  const reason = coverageReason("outages", null, raw); // unscoped: never bbox-limited, so no bounds to check
  if (reason) return tile("connectivity", "Connectivity", null, reason);
  const outage = outageFor(props, raw);
  if (!outage) {
    return tile("connectivity", "Connectivity", null,
      "No disruption detected this window — IODA reports only countries above its own anomaly floor.");
  }
  return tile("connectivity", "Connectivity", fmtNumber(Math.round(outage.score)), null);
}

function refugeesTile(props, raw) {
  if (!props.iso_a3) {
    return tile("refugees", "Refugees", null, "This shape carries no ISO3 code to match against UNHCR's country keys.");
  }
  const reason = coverageReason("humanitarian", null, raw); // unscoped, same as outages above
  if (reason) return tile("refugees", "Refugees", null, reason);
  const refugees = (raw.humanitarian || {})[props.iso_a3]?.displacement?.refugees;
  if (refugees == null) {
    return tile("refugees", "Refugees", null, "UNHCR has not reported a refugee figure for this country.");
  }
  return tile("refugees", "Refugees", fmtNumber(refugees), null);
}

// v > 0 keeps a genuinely reported 0.00 GW readable as "0.00", not "-0.00" or
// a bare "+0" -- mirrors buildEnergy's own `signed` helper (kept separate
// rather than shared: that one escapes its unit for an HTML context, this one
// feeds a React text node and must not).
function formatSignedPower(value, unit) {
  return `${value > 0 ? "+" : ""}${Number(value).toFixed(2)} ${unit || "GW"}`;
}

function netPowerTile(props, raw) {
  const reason = coverageReason("energyFlows", null, raw); // unscoped, same as outages/humanitarian above
  if (reason) return tile("netPower", "Net power", null, reason);
  const record = energyRecordFor(props, raw);
  const physical = record?.physical;
  const commercial = record?.commercial;
  if (physical?.net != null) {
    return tile("netPower", "Net power", `${formatSignedPower(physical.net, physical.unit)}, measured`, null);
  }
  if (commercial?.net != null) {
    return tile("netPower", "Net power", `${formatSignedPower(commercial.net, commercial.unit)}, scheduled`, null);
  }
  return tile("netPower", "Net power", null,
    "No cross-border flow published for this country's bidding zone (Energy-Charts).");
}

function militaryAircraftTile(bounds, raw) {
  if (!bounds) return tile("militaryAircraft", "Military aircraft", null, NO_BOUNDS_REASON);
  const reason = coverageReason("adsb", bounds, raw);
  if (reason) return tile("militaryAircraft", "Military aircraft", null, reason);
  const count = countInBounds(raw.adsb, bounds, (a) => classifyAircraft(a) === "military");
  return tile("militaryAircraft", "Military aircraft", fmtNumber(count), null);
}

/**
 * The seven summary-strip tiles, in the order the strip shows them.
 *
 * @param props   the GeoJSON feature's properties, same as countryCardSections
 * @param raw     the map controller's live data buckets
 * @param bounds  the country's own bounding box, or null
 * @returns {Array<{key: string, label: string, value: string|null,
 *   unavailable: boolean, tooltip: string|null}>}
 */
export function summaryTiles(props, raw, bounds) {
  const [events72h, fatalities72h] = boundedConflictTiles(bounds, raw);
  return [
    populationTile(props),
    events72h,
    fatalities72h,
    connectivityTile(props, raw),
    refugeesTile(props, raw),
    netPowerTile(props, raw),
    militaryAircraftTile(bounds, raw),
  ];
}

function buildCoverage(bounds, raw) {
  if (!bounds) {
    // Nothing below can be checked against a country with no bounding box --
    // this is the whole-card version of "did not look", stated once rather
    // than repeated per feed with nothing behind it.
    return '<p class="meta">This country has no bounding box loaded, so none of the feeds below could be '
      + 'checked against it. That is &ldquo;this map did not look here&rdquo;, not &ldquo;this map looked '
      + 'and found nothing&rdquo;.</p>';
  }
  const rows = COVERAGE_FEEDS.map(({ key, label, provenance, whenMs }) => {
    const state = coverageStateFor(key, bounds, raw);
    if (state === "not_loaded") {
      return coverageRow(label, "Not loaded this session &mdash; not checked.");
    }
    if (state === "scoped_elsewhere") {
      return coverageRow(label, "Fetched, but for a different area &mdash; coverage here is unknown, not zero.");
    }
    const feed = Array.isArray(raw[key]) ? raw[key] : [];
    const matches = itemsInBounds(feed, bounds);
    if (!matches.length) {
      return coverageRow(label, "No coverage here &mdash; checked, nothing found.");
    }
    let freshest = null;
    for (const item of matches) {
      const ms = whenMs(item);
      if (Number.isFinite(ms) && (freshest === null || ms > freshest)) freshest = ms;
    }
    const when = freshest !== null ? timeAgoFromUnix(freshest / 1000) : null;
    const count = `${fmtNumber(matches.length)} on file here`;
    return coverageRow(
      label,
      when
        ? `Last delivered ${esc(when)} &middot; ${count} (${esc(provenance)})`
        : `${count}, reference data with no delivery time of its own (${esc(provenance)})`
    );
  }).join("");
  return `<div class="popup-events">${rows}</div>
    <p class="meta">Each line answers one question: has this feed ever put anything inside this country's
      bounding box. &ldquo;No coverage here&rdquo; means this map fetched data covering this country and
      came back empty; &ldquo;not loaded this session&rdquo; means it never fetched at all, most often
      because the feed's own zoom gate has not lifted; &ldquo;fetched, but for a different area&rdquo;
      means this map has that feed's data in hand right now, just not for anywhere near here. The three
      look similar and are not the same claim -- this section exists so they are never read as one.</p>`;
}

/**
 * Task 25's overpass section -- fed by createMapController.js's
 * loadSatellitePasses, which writes raw.satellitePasses[key] and re-renders
 * whichever of the country/water cards is open (the same fetch-then-store-
 * in-raw-then-refresh-the-open-card shape loadDistrictSeries already uses
 * for the district trend fold). Undefined (key was never selected, or its
 * fetch has not started yet -- the two are indistinguishable and both mean
 * "nothing to show yet") reads as still loading rather than empty, so the
 * card never flashes "no overpasses" for a fraction of a second before the
 * real fetch resolves.
 */
function buildSatellitePasses(raw, key) {
  return satellitePassesSectionHtml(raw.satellitePasses?.[key] || { status: "loading" });
}

// Task 10: fifteen sections is too many to scan at once, so PlaceInfoCard's
// optional `groups` prop folds them into three questions a reader actually
// asks -- what is happening right now (Situation), what does this country
// look like structurally (Country), and what does this map itself know or
// not know about its own coverage (Meta). A section id that shows up in none
// of these still renders, standalone, after all three -- see
// placeInfoCardGrouping.js's groupSections, which is what protects a section
// added later and never added to this table from silently vanishing instead
// of just looking mis-sorted.
export const COUNTRY_CARD_GROUPS = [
  {
    id: "situation", title: "Situation",
    sectionIds: ["conflict", "live", "satellitePasses", "connectivity", "events", "verified", "trend"],
  },
  {
    id: "country", title: "Country",
    sectionIds: ["profile", "humanitarian", "power", "energy", "gridStress", "transport", "military", "food"],
  },
  // "sanctions" is not a section id this card produces -- Task 9 folded
  // sanctioned hulls/tails into "military" rather than giving them their own
  // fold -- so it never matches anything here. Left in rather than trimmed:
  // it costs nothing (groupSections drops an id with no matching section) and
  // documents that sanctions belong with Meta's honesty-and-provenance folds
  // if a later task ever does split them out on their own.
  { id: "meta", title: "Meta", sectionIds: ["sanctions", "sources", "coverage"] },
];

export function countryCardSections(props, raw, bounds) {
  const name = props.name || "Unknown";
  const wanted = normalizeCountryName(name);
  // The same key createMapController.js's buildCountryIndex/countryKeyOfProps
  // compute from a country's own GeoJSON properties -- restated here rather
  // than imported (this side only ever has `props`, the same reason
  // countryKeyOfProps' own comment gives), including the `null` fallback
  // (a shape with neither an ISO code nor a name, which should not happen
  // in practice) so the string this interpolates to matches
  // `country:${next.key}` in setFocus exactly, even in that edge case.
  const satelliteKey = `country:${props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : props.name || null}`;
  const eventMatches = raw.events.filter((e) => normalizeCountryName(e.country) === wanted).slice(0, 3);
  const merged = mergedNewsIdsIn(raw);
  const gdeltMatches = raw.gdelt
    .filter((e) => {
      if (merged.has(e.event_id)) return false;
      if (!e.location) return false;
      const parts = e.location.split(",");
      return normalizeCountryName(parts[parts.length - 1]) === wanted;
    })
    .slice(0, 3);
  const statsKey = Object.keys(raw.conflictStats || {}).find((k) => normalizeCountryName(k) === wanted);
  const trendSeries = statsKey ? raw.conflictStats[statsKey] : null;

  // A region-level escalation entry counts for this country only if the
  // country actually sits inside that region's box -- otherwise every
  // country would inherit a neighbour's alert.
  const escalationZone = (raw.escalation || []).find((z) => {
    if (!bounds || !Array.isArray(z.bounds)) return false;
    const [zs, zw, zn, ze] = z.bounds;
    const cLat = (bounds.south + bounds.north) / 2;
    const cLon = (bounds.west + bounds.east) / 2;
    return cLat >= zs && cLat <= zn && cLon >= zw && cLon <= ze;
  });

  const sections = [
    {
      id: "profile",
      title: "Country profile",
      defaultOpen: true,
      html: `<div class="meta">Pop ${fmtNumber(props.population)}${props.pop_year ? ` (${esc(props.pop_year)})` : ""} &middot; ${
        props.density != null ? `${props.density}/km&sup2;` : "density n/a"
      } &middot; HDI ${props.hdi != null ? props.hdi.toFixed(3) : "n/a"}</div>`,
    },
    // Open by default, and the only other one that is: on a map of armed
    // conflict, "what has happened here in the last three days" is the question
    // a country was clicked to answer.
    { id: "conflict", title: "Conflict · last 72h", defaultOpen: true, html: buildConflictSummary(bounds, raw, escalationZone) },
    { id: "live", title: "Live picture · in/near country", html: buildLivePicture(bounds, raw) },
    // Task 25: not gated on bounds -- unlike the folds above, this reads a
    // lat/lon centroid createMapController.js computed itself (see
    // loadSatellitePasses), so it has something to say even before this
    // country's boundary layer has resolved a Leaflet bbox of its own.
    { id: "satellitePasses", title: "Satellite overpasses", html: buildSatellitePasses(raw, satelliteKey) },
    // Joined on ISO2 rather than on the country name: IODA and Natural Earth
    // disagree about several names ("Cote D Ivoire" vs "Côte d'Ivoire") and a
    // name join silently drops exactly those.
    { id: "connectivity", title: "Internet connectivity", defaultOpen: true,
      html: buildConnectivity(props, raw) },
    { id: "humanitarian", title: "Displacement & food security", html: buildHumanitarian(props, raw) },
    // Two country-keyed feeds that draw nothing: a cross-border flow has no
    // location and a marketing-year balance sheet is about a whole state. Both
    // sit below the humanitarian fold because both are context for it.
    { id: "power", title: "Cross-border electricity", html: buildEnergy(props, raw) },
    // Task 9: generation/storage infrastructure inside the country's own bbox
    // -- a different kind of claim from "power" above (a flow crossing a
    // border) so it is its own fold rather than a second heading stacked
    // inside that one. See buildEnergyInfrastructure's own note.
    { id: "energy", title: "Energy infrastructure", html: buildEnergyInfrastructure(bounds, raw) },
    // Task 28: net cross-border exchange and the IODA outage score, side by
    // side -- see buildGridStress's own note on why this is not a rebuild of
    // "power" above.
    { id: "gridStress", title: "Grid stress", html: buildGridStress(props, raw) },
    { id: "military", title: "Military & security", html: buildMilitary(bounds, raw, props) },
    { id: "transport", title: "Transport", html: buildTransport(bounds, raw) },
    { id: "food", title: "Food balance & prices", html: buildFoodTrade(props, raw) },
    { id: "verified", title: "Verified record", html: buildVerifiedRecord(wanted, raw) },
    { id: "trend", title: "Fatality trend", html: buildSparkline(trendSeries) },
    { id: "events", title: "Recent events", html: buildEventsSection(eventMatches, gdeltMatches, { heading: false }) },
    {
      id: "sources",
      title: "Sources & caveats",
      // The boundary disclosure sits at the top of this fold rather than in a
      // section of its own, and it is not optional: applyOverrides marks an
      // edited record for the same reason, and a national border that has been
      // redrawn without saying so is the stronger version of that problem.
      html: `${
        props.__bordersEdited
          ? `<p class="meta edited-note">This country's boundary has been redrawn in Admin Mode. It is
             not what the source serves.</p>`
          : ""
      }<p class="meta">Live counts use the country's bounding box, so figures near borders are
        approximate. Population/density: World Bank. HDI: UNDP. Listed events matched by country name.</p>`,
    },
    // The honesty section (Task 9): always present, never dropped when empty,
    // and last -- see buildCoverage's own note on why it never returns "".
    { id: "coverage", title: "Data coverage", html: buildCoverage(bounds, raw) },
  ];

  return {
    title: name,
    sections: sections.filter((s) => s.html && s.html.trim()),
    // Task 10: the summary strip above the folds, and the table that groups
    // the folds themselves into super-folds. Both are optional on
    // PlaceInfoCard -- waterCardSections below supplies neither, so the water
    // card is unaffected.
    summary: summaryTiles(props, raw, bounds),
    groups: COUNTRY_CARD_GROUPS,
  };
}

// ---------- water body card (Task 7) ----------
//
// The sibling of countryCardSections above, for the water layer Task 6 made
// selectable. Same shape ({title, sections}), same empty-section dropping,
// same openableRow convention for a row that opens a record's own detail --
// see that function's own docstring for the reasoning this one shares.
//
// One real difference from the country card throughout: `feature` here is not
// just the GeoJSON properties, it is a buildWaterIndex entry (map/water.js),
// carrying `polygons`/`bbox` (the hit-test geometry) and `rawBbox` (the
// feature's own stored [south,west,north,east], antimeridian-aware) alongside
// id/name/class. The country card settles for "inside this country's bounding
// box" because a true polygon test over every AIS/ADS-B contact on Earth is
// not affordable at that scale (see buildLivePicture's own note). A water
// body does not get that luxury: a strait or a channel is long and thin, and
// its bounding box can cover as much land as water -- so every "inside this
// water body" test below is a real point-in-polygon test, not a box.

/**
 * True containment inside a water feature's actual polygon, not its bounding
 * box. `bounds`, when given, is a cheap pre-filter -- the feature's own
 * client-computed bbox (see buildWaterIndex) -- that skips the ray-cast for a
 * point obviously outside. It can only ever be as large as or larger than the
 * true shape (it is that shape's own bounding envelope), so it is never a
 * source of a false negative, only of a skipped optimisation for the handful
 * of antimeridian-wrapping marine features where it is closer to the whole
 * globe than to the feature.
 *
 * Exported so IntelPanel's water scope (intelPanelLogic.js) can run the exact
 * same test the card's own honesty sections do, rather than a second,
 * possibly-drifting approximation of "inside this water body".
 */
export function insideWaterFeature(feature, bounds, lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (bounds && !boundsContainsPoint(bounds, lat, lon)) return false;
  return countryContainsPoint(feature, lat, lon);
}

const VESSEL_TRAFFIC_ORDER = ["tanker", "cargo", "navy", "fishing", "other"];
const VESSEL_TRAFFIC_LABEL = {
  tanker: "tankers", cargo: "cargo", navy: "navy", fishing: "fishing", other: "other",
};

/**
 * Vessel counts inside this water body, by classifyVesselTraffic's five-way
 * split. Exported on its own -- rather than only reachable through
 * buildWaterTraffic -- so the class-counting logic can be tested headlessly,
 * without building a whole card or a DOM.
 */
export function countVesselsByClass(ships, feature, bounds) {
  const counts = { tanker: 0, cargo: 0, navy: 0, fishing: 0, other: 0 };
  let total = 0;
  for (const ship of ships || []) {
    if (!insideWaterFeature(feature, bounds, ship.lat, ship.lon)) continue;
    counts[classifyVesselTraffic(ship)] += 1;
    total += 1;
  }
  return { counts, total };
}

function buildWaterTraffic(feature, raw, bounds) {
  const { counts, total } = countVesselsByClass(raw.ais, feature, bounds);
  // Task 29: the day-over-day naval trend can have something to say even when
  // this instant's live navy count is zero (a hull that was here yesterday and
  // has since moved on), so this is checked and shown regardless of `total`
  // -- the one place in this function that is not itself gated on it.
  const navalTrend = navalPresenceRegion(bounds, raw);
  if (!total && !navalTrend) {
    // navalTrend reads raw.navalPresence (navalPresenceRegion, just above), so
    // a section that can say nothing about either has to check both feeds'
    // coverage, not just ais' -- otherwise a navalPresence poll that has not
    // landed yet (or landed for a different theatre) reads as "checked, no
    // navy hulls" instead of "not checked".
    const reason = emptyFoldReason(["ais", "navalPresence"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }
  const rows = VESSEL_TRAFFIC_ORDER.map((k) => statRow("", VESSEL_TRAFFIC_LABEL[k], counts[k])).join("");
  return `${total ? `<div class="cstats">${rows}${statRow("", "total", total, "hot")}</div>${AIS_COVERAGE_CAVEAT}` : ""}
    ${navalTrend ? `<p>${navalPresenceSentence(navalTrend.label, navalTrend)}</p>
    <p class="meta">${NAVAL_PRESENCE_THEATRE_CAVEAT} Navy-classified AIS contacts (ITU-R M.1371
      &ldquo;military operations&rdquo;), <i>derived</i> from the last 24 hours of this map's own recorded
      AIS history, compared against the 24 hours before that.</p>` : ""}`;
}

/**
 * Rectangle overlap between two [south, west, north, east] boxes, either of
 * which may wrap the antimeridian (west > east -- water_bodies.py's _bbox
 * docstring, and buildWaterIndex's own note on `rawBbox`). Both sides get the
 * same two-range treatment: a marine feature can wrap (the Bering Sea, the
 * Pacific...) so there is no side this can assume is the simple one.
 * Exported so the bordering-country matcher's own overlap prefilter can be
 * tested directly.
 */
export function bboxesOverlap(a, b) {
  const [aS, aW, aN, aE] = a;
  const [bS, bW, bN, bE] = b;
  if (aS > bN || bS > aN) return false;
  const aRanges = aW <= aE ? [[aW, aE]] : [[aW, 180], [-180, aE]];
  const bRanges = bW <= bE ? [[bW, bE]] : [[bW, 180], [-180, bE]];
  return aRanges.some(([w1, e1]) => bRanges.some(([w2, e2]) => w1 <= e2 && w2 <= e1));
}

const BORDER_COUNTRY_CAP = 10;

/**
 * Countries this water body borders: a country index entry (buildCountryIndex,
 * map/countryHitTest.js) survives if its own bbox overlaps the water
 * feature's stored bbox, and then only if it actually contains a point on the
 * water body's own boundary -- the bbox overlap alone is not enough, since two
 * rectangles can overlap with the shapes inside them nowhere near touching.
 *
 * Every ring vertex is tested rather than a sample: this app's 1:10m water
 * geometry is already thinned (COORD_PRECISION in water_bodies.py), this runs
 * once per click, and the bbox prefilter above is what keeps the candidate
 * country list small before any ray-casting happens at all.
 *
 * Exported so the matcher can be tested directly, headlessly.
 */
export function waterBorderingCountries(feature, countryIndex) {
  if (!Array.isArray(feature?.rawBbox) || !countryIndex?.length) return [];
  const names = [];
  for (const country of countryIndex) {
    if (!country?.bbox) continue;
    const countryBox = [country.bbox.minLat, country.bbox.minLon, country.bbox.maxLat, country.bbox.maxLon];
    if (!bboxesOverlap(feature.rawBbox, countryBox)) continue;
    const touches = (feature.polygons || []).some((rings) =>
      (rings[0] || []).some(([lon, lat]) => countryContainsPoint(country, lat, lon))
    );
    if (touches) names.push(country.name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function buildWaterProfile(feature, raw) {
  const label = WATER_CLASS_LABEL[feature.class] || "Water";
  const borders = waterBorderingCountries(feature, raw.countryIndex);
  const shown = borders.slice(0, BORDER_COUNTRY_CAP);
  return `
    <div class="meta">${esc(label)}</div>
    ${borders.length ? `<div>Borders: ${shown.map(esc).join(", ")}${
      borders.length > shown.length ? ` &middot; +${esc(borders.length - shown.length)} more` : ""
    }</div>` : ""}
    ${WATER_SCALE_CAVEAT}`;
}

const DARK_RECENT_CAP = 3;

// AIS gaps (this app's own inference) and STS pairs (also this app's own
// inference) from raw.darkVessels, plus Global Fishing Watch's own published
// AIS-disabling events from raw.gfwGaps -- three counts, never merged into
// one, because they are three different organisations' claims (see
// dark_vessels.py and gfw_gaps.py). STS pairs carry no detection time of
// their own (dark_vessels.py's pairing is a snapshot, not a dated event), so
// they are counted but left out of the time-sorted "most recent" list rather
// than given a fabricated ordering.
function buildWaterDark(feature, raw, bounds) {
  const inside = (item) => insideWaterFeature(feature, bounds, item.lat, item.lon);
  const wentDark = (raw.darkVessels || []).filter((d) => d.kind === "ais_gap" && inside(d));
  const stsPairs = (raw.darkVessels || []).filter((d) => d.kind === "sts_pair" && inside(d));
  const gfwGaps = (raw.gfwGaps || []).filter(inside);
  const total = wentDark.length + stsPairs.length + gfwGaps.length;
  if (!total) {
    // Task 32's own fix, missed here: both feeds this fold counts (darkVessels,
    // gfwGaps) are gated at COUNTRY (see scene.js), so at world or theatre zoom
    // this returned "" unconditionally -- a silent drop indistinguishable from
    // "checked and found nothing dark", right below a Chokepoint watch fold
    // that confidently describes the same layer's scope. buildWaterTraffic and
    // buildWaterInfrastructure both already ask emptyFoldReason first; this is
    // the one counting water fold that did not.
    const reason = emptyFoldReason(["darkVessels", "gfwGaps"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }

  const timed = [
    ...wentDark.map((d) => ({
      kind: "darkVessels", id: d.id, label: d.name || `MMSI ${d.mmsi}`, sub: "Went dark", when: d.went_dark_at,
    })),
    ...gfwGaps.map((d) => ({
      kind: "gfwGaps", id: d.id, label: d.name || `MMSI ${d.mmsi}`, sub: "GFW AIS disabling", when: d.went_dark_at,
    })),
  ]
    .filter((r) => Number.isFinite(r.when))
    .sort((a, b) => b.when - a.when)
    .slice(0, DARK_RECENT_CAP);

  const rows = timed.map((r) => {
    const open = openableRow(r.kind, r.id);
    return `<div${open || ' class="event-row"'}><b>${esc(r.label)}</b>
      <div class="event-meta">${esc(r.sub)} &middot; ${esc(timeAgoFromUnix(r.when))}</div></div>`;
  }).join("");

  return `<div class="cstats">
      ${statRow("", "went dark", wentDark.length, "hot")}
      ${statRow("", "ship-to-ship", stsPairs.length, "hot")}
      ${statRow("", "GFW AIS disabling", gfwGaps.length)}
    </div>
    ${rows ? `<div class="popup-events">${rows}</div>` : ""}
    ${stsPairs.length && !timed.length
      ? '<p class="meta">Ship-to-ship pairs carry no detection time of their own -- each is a snapshot of '
        + "two hulls found close together, not a dated event -- so none are listed above by recency.</p>"
      : ""}
    <p class="meta">Every pin here is an inference from an absence or a proximity, not a detection. Treat
      each as worth a look, never as a finding.</p>`;
}

// A hand-kept mirror of backend/config.py's WATCHED_WATERS default (the eight
// boxes the Dark Vessels layer's "went dark" inference is willing to draw a
// conclusion from -- see dark_vessels.py's REQUIRE_CHOKEPOINT). There is no
// endpoint serving this list, and it changes only when someone edits the
// shipped default in config.py, so a small manually-synced copy here -- the
// same discipline this module's own COUNTRY_ALIASES table already follows --
// is the whole of it, rather than a network round trip for eight boxes that
// move once in a while. [south, west, north, east]; none of the eight wrap
// the antimeridian.
//
// config.py reads `os.getenv("WATCHED_WATERS", _DEFAULT_WATCHED_WATERS)`, so
// a deployment that overrides that env var desyncs this chokepoint fold from
// what the Dark Vessels layer actually honours -- nothing here would catch
// it. No override exists in this repo today, so this is a documented coupling
// to watch, not a sync mechanism worth building for a problem that has not
// happened: if backend/config.py:410 (WATCHED_WATERS) or its default at :384
// ever changes, this list has to change with it by hand.
const WATCHED_WATERS = [
  { label: "Black Sea", box: [40, 27, 47, 42] },
  { label: "Red Sea", box: [12, 32, 30, 43] },
  { label: "Gulf of Aden / Bab-el-Mandeb approach", box: [10, 43, 15, 52] },
  { label: "Strait of Hormuz / Persian Gulf", box: [24, 48, 30, 57] },
  { label: "Taiwan Strait", box: [21, 117, 26, 123] },
  { label: "South China Sea", box: [0, 105, 23, 121] },
  { label: "Eastern Mediterranean", box: [31, 20, 37, 36] },
  { label: "Suez Canal", box: [29.5, 32.0, 31.5, 33.0] },
];

/**
 * Every watched-water box this water feature's own bbox *overlaps* -- not
 * "is inside", and not just the first match.
 *
 * Both were wrong, and for the same underlying reason: WATCHED_WATERS' eight
 * boxes are hand-drawn approximations of one strait or approach each,
 * feature.rawBbox is the bounding box of a whole named sea, and two
 * rectangles overlapping is not the same claim as one containing the other.
 * Live data makes this concrete: INDIAN OCEAN's rawBbox is
 * [-60.53, 19.62, 10.43, 166.07], which overlaps the Gulf of Aden box
 * ([10, 43, 15, 52]) because an ocean-sized rectangle sweeps across
 * everything near it -- so the old find()-based version reported clicking
 * the Indian Ocean as "Inside Gulf of Aden / Bab-el-Mandeb approach", and
 * once the refine job writes chokepoint counts for that box,
 * buildWaterChokepointTraffic would attribute the strait's own hull counts
 * to the whole ocean.
 *
 * The honest fix is not a tighter containment test: even a real point-in-
 * polygon check of the water feature's own shape against WATCHED_WATERS'
 * boxes would still be answering "does this shape reach into that box"
 * rather than "is this shape that box", and for a feature the size of an
 * ocean the answer to the first question is often yes for boxes that are not
 * remotely what a reader would call "inside". So this only ever claims
 * overlap -- see buildWaterChokepoint's own wording below -- and every
 * caller iterates every match rather than taking WATCHED_WATERS.find()'s
 * first one arbitrarily, which is the other half of the bug: a water body
 * overlapping two boxes used to silently report only whichever WATCHED_WATERS
 * happened to list first.
 */
function watchedWaterOverlaps(feature) {
  if (!Array.isArray(feature?.rawBbox)) return [];
  return WATCHED_WATERS.filter((w) => bboxesOverlap(feature.rawBbox, w.box));
}

// Which watched-water boxes this water body overlaps, and what that does and
// does not mean for the Dark Vessels layer -- always answerable, so unlike
// every other fold this one never drops itself.
function buildWaterChokepoint(feature) {
  const hits = watchedWaterOverlaps(feature);
  if (hits.length) {
    const names = hits.map((h) => `<b>${esc(h.label)}</b>`).join(", ");
    return `<div>Overlaps ${hits.length === 1 ? "" : `${hits.length} of `}the eight theatres the Dark
        Vessels layer is willing to draw a &ldquo;went dark&rdquo; conclusion from: ${names}.</div>
      <p class="meta">This is a bounding-box overlap, not containment -- a large sea's own bbox can sweep
        across a strait's watch box without the sea actually bordering it, so treat this as "reaches into",
        not "is". Its ship-to-ship pairing and Global Fishing Watch's own AIS-disabling findings are not
        scoped this way &mdash; both run wherever AIS reaches, chokepoint or not.</p>`;
  }
  return `<div>Outside every chokepoint the Dark Vessels layer is scoped to.</div>
    <p class="meta">Its &ldquo;went dark&rdquo; inference will not draw a conclusion here even where a real
      gap exists &mdash; that is a limit on what the layer is willing to claim, not a report that nothing
      happens here. Ship-to-ship pairing and Global Fishing Watch's own AIS-disabling findings are
      unaffected and still run here.</p>`;
}

// Task 36: the seven cargo-class buckets backend/refine/vessel_profile.py's
// cargo_class() returns. A hull whose ship type was never decoded has no key
// in by_class at all (see lane_density.compute_chokepoints) rather than
// falling into "other" -- so this table is never consulted for that case,
// and nothing here needs an entry for it.
const CHOKEPOINT_CLASS_LABEL = {
  tanker: "Tanker", cargo: "Cargo", fishing: "Fishing", passenger: "Passenger",
  tug: "Tug", naval: "Naval", other: "Other",
};

const CHOKEPOINT_STATUS_WORD = { counted: "counted", partial: "still counting", missing: "not observed" };

// Task 36's own fold, distinct from buildWaterChokepoint above: that one is
// about what the Dark Vessels layer is willing to claim, this one is the
// actual distinct-hull count GET /api/chokepoints serves. Present only when
// this water body overlaps one of the eight watched boxes -- the same test
// buildWaterChokepoint uses -- because a box's own count is the only thing
// this section has anything to say about.
//
// A missing day is spelled out as an em dash in the 7-day line and folded
// into its own "N not observed" sentence, on purpose: this is the single
// most repeated defect flagged across this plan's own reviews (a day with no
// data rendering as zero traffic), and a reader skimming a popup is exactly
// who would otherwise misread "0" as "nothing crossed" rather than "this job
// never looked".
/** One watched box's own count section -- pulled out of buildWaterChokepointTraffic
 *  so a feature overlapping several boxes (see watchedWaterOverlaps' own note
 *  on the Indian Ocean/Gulf of Aden case) gets one of these per box instead of
 *  find()'s old arbitrary first match. */
function buildOneChokepointTraffic(hit, raw, heading) {
  const box = raw.chokepoints?.boxes?.[hit.label];
  if (!box || !Array.isArray(box.trend) || !box.trend.length) {
    return `${heading}<p class="meta">No chokepoint count recorded yet for <b>${esc(hit.label)}</b> &mdash;
      this map's own distinct-hull counter (backend/refine/lane_density.py) has not written a pass yet.</p>`;
  }
  const today = box.today || box.trend[box.trend.length - 1];
  const statusWord = CHOKEPOINT_STATUS_WORD[today.status] || today.status;
  const totalLine = today.total == null
    ? `<b>${esc(today.date)}</b>: not observed &mdash; this job has not looked at this day yet, which is
       not the same as zero traffic.`
    : `<b>${esc(today.date)}</b>: <b>${fmtNumber(today.total)}</b> distinct hull${today.total === 1 ? "" : "s"}
       (${esc(statusWord)}).`;
  const classEntries = today.by_class ? Object.entries(today.by_class).filter(([, n]) => n > 0) : [];
  const classRows = classEntries.length
    ? `<div class="cstats">${classEntries
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => statRow("", CHOKEPOINT_CLASS_LABEL[cls] || cls, n))
        .join("")}</div>`
    : "";
  const observed = box.trend.filter((d) => d.total != null);
  const missing = box.trend.length - observed.length;
  const recentLine = box.trend
    .slice(-7)
    .map((d) => `${esc(d.date.slice(5))}: ${d.total == null ? "&mdash;" : fmtNumber(d.total)}`)
    .join(" &middot; ");
  return `${heading}
    <div>${totalLine}</div>
    ${classRows}
    <p class="meta">Last 7 days: ${recentLine}. (&ldquo;&mdash;&rdquo; marks a day this job never observed,
      not a day with no traffic.)</p>
    <p class="meta">${esc(String(box.trend.length))}-day window: ${observed.length}
      day${observed.length === 1 ? "" : "s"} observed${missing ? `, ${missing} not observed` : ""}.</p>
    <p class="meta">Distinct hulls, by cargo class, <i>derived</i> by counting distinct MMSIs in this map's
      own aisstream.io AIS history (backend/refine/lane_density.py) &mdash; not a published source, and not
      a traffic census: AIS reception is not uniform, so a quiet day can mean genuinely little traffic or it
      can mean this map's own receivers simply heard less that day.</p>`;
}

function buildWaterChokepointTraffic(feature, raw) {
  const hits = watchedWaterOverlaps(feature);
  if (!hits.length) return ""; // outside every watched box -- this section has nothing to say
  // A heading only when there is more than one box to tell apart -- the
  // common single-box case renders exactly as it always did.
  return hits
    .map((hit) => buildOneChokepointTraffic(
      hit, raw, hits.length > 1 ? `<div class="csection-h">${esc(hit.label)}</div>` : ""
    ))
    .join("");
}

const INFRA_LIST_CAP = 6;

function infraListRows(items, kind, nameOf) {
  const rows = items.slice(0, INFRA_LIST_CAP).map((item) => {
    const open = kind ? openableRow(kind, item.id) : "";
    return `<div${open || ' class="event-row"'}>${esc(nameOf(item))}</div>`;
  }).join("");
  const more = items.length > INFRA_LIST_CAP
    ? `<div class="meta">+${esc(items.length - INFRA_LIST_CAP)} more</div>`
    : "";
  return rows + more;
}

// Cable routes (lines, tested by whether any drawn point falls inside the
// polygon -- there is no honest "crosses" test finer than that for a route
// drawn schematically to begin with), landing points and ports, all read
// straight off what the map has already fetched for its own layers.
function buildWaterInfrastructure(feature, raw, bounds) {
  const crossing = (raw.cables || []).filter((cable) =>
    (cable.paths || []).some((path) => path.some(([lat, lon]) => insideWaterFeature(feature, bounds, lat, lon)))
  );
  const landings = (raw.cableLandings || []).filter((p) => insideWaterFeature(feature, bounds, p.lat, p.lon));
  const shorePorts = (raw.ports || []).filter((p) => insideWaterFeature(feature, bounds, p.lat, p.lon));
  if (!crossing.length && !landings.length && !shorePorts.length) {
    // Task 32: raw.cables rides cableLandings' own coverage record -- both
    // arrive on the one-shot /api/cables payload (see useOsintData.js's
    // publishFetchOutcome call for it).
    const reason = emptyFoldReason(["cableLandings", "ports"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }

  return `
    <div class="cstats">
      ${statRow("", "cables crossing", crossing.length)}
      ${statRow("", "cable landings", landings.length)}
      ${statRow("", "ports", shorePorts.length)}
    </div>
    ${crossing.length ? `<div class="csection-h">Cable routes</div>${infraListRows(crossing, null, (c) => c.name)}` : ""}
    ${landings.length ? `<div class="csection-h">Landing points</div>${infraListRows(landings, "cableLandings", (p) => p.name)}` : ""}
    ${shorePorts.length ? `<div class="csection-h">Ports</div>${infraListRows(shorePorts, "ports", (p) => p.name)}` : ""}
    <p class="meta">Cable routes are drawn schematically; &ldquo;crossing&rdquo; here means the drawn path
      has a point inside this water body's polygon, not a survey of what the cable actually crosses on the
      seabed.</p>`;
}

// Same matching as countryCardSections's own events/gdelt handling, scoped by
// true polygon containment rather than a country's bounding box -- see this
// section's module note on why water gets the more expensive test.
function buildWaterIncidents(feature, raw, bounds) {
  const inside = (item) => insideWaterFeature(feature, bounds, item.lat, item.lon);
  const eventMatches = (raw.events || []).filter(inside).slice(0, 3);
  const merged = mergedNewsIdsIn(raw);
  const gdeltMatches = (raw.gdelt || [])
    .filter((e) => !merged.has(e.event_id) && inside(e))
    .slice(0, 3);
  return buildEventsSection(eventMatches, gdeltMatches, { heading: false });
}

function buildWaterSources() {
  return `
    <p class="meta">Boundary: Natural Earth 1:10m, public domain (CC0). Traffic: aisstream.io AIS, live.
      Dark activity: this app's own AIS-gap and ship-to-ship inference over aisstream.io history, plus
      Global Fishing Watch's AIS-disabling events (CC BY-NC 4.0, five or more days behind). Chokepoint
      watch: this app's own watched-water boxes, not a published source. Infrastructure: TeleGeography
      submarine cables and the NGA World Port Index (both curated gazetteers, not feeds). Incidents:
      ACLED and GDELT, matched by location.</p>
    <p class="meta">${EMPTY_WATER_HEADLINE} A fold above with nothing in it can mean nothing happened here,
      or it can mean this map has no coverage here &mdash; AIS reception, satellite imagery and news
      coverage all vary by place, and a quiet fold is not proof of a quiet sea.</p>`;
}

/**
 * The water body card, as a list of independently foldable sections -- the
 * sibling of countryCardSections above, same {title, sections} shape.
 *
 * @param feature  a buildWaterIndex entry (map/water.js): id/name/class plus
 *                 the hit-test geometry (`polygons`/`bbox`) and the feature's
 *                 own stored `rawBbox`.
 * @param raw      the map controller's live data buckets, plus `countryIndex`
 *                 (buildCountryIndex's own output, cached there for the
 *                 bordering-country match -- see createMapController.js).
 * @param bounds   the feature's own {south,west,north,east} bbox, used only
 *                 as a cheap pre-filter ahead of the real polygon tests
 *                 below. Optional -- the card still works without it, just
 *                 slower.
 * @returns {{title: string, sections: Array<{id, title, html, defaultOpen}>}}
 */
export function waterCardSections(feature, raw, bounds) {
  const label = WATER_CLASS_LABEL[feature.class] || "Water";
  const sections = [
    { id: "profile", title: "Water body", defaultOpen: true, html: buildWaterProfile(feature, raw) },
    // Task 25: `feature.id` is the same id createMapController.js's
    // selectWater/loadSatellitePasses key raw.satellitePasses under
    // ("water:<id>") -- see waterCardFor's own use of feature.id elsewhere
    // for the same identity.
    { id: "satellitePasses", title: "Satellite overpasses", html: buildSatellitePasses(raw, `water:${feature.id}`) },
    { id: "traffic", title: "Traffic now", html: buildWaterTraffic(feature, raw, bounds) },
    { id: "dark", title: "Dark activity", html: buildWaterDark(feature, raw, bounds) },
    { id: "chokepoint", title: "Chokepoint watch", html: buildWaterChokepoint(feature) },
    { id: "chokepointTraffic", title: "Chokepoint traffic", html: buildWaterChokepointTraffic(feature, raw) },
    { id: "infrastructure", title: "Infrastructure", html: buildWaterInfrastructure(feature, raw, bounds) },
    { id: "incidents", title: "Incidents", html: buildWaterIncidents(feature, raw, bounds) },
    { id: "sources", title: "Sources & caveats", html: buildWaterSources() },
  ];
  return { title: feature.name || label, sections: sections.filter((s) => s.html && s.html.trim()) };
}

export function cityPopupHtml(city, raw, countryNameByIso2) {
  const countryName = countryNameByIso2[city.country_code] || city.country_code || "";
  const eventMatches = raw.events
    .filter((e) => typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  const merged = mergedNewsIdsIn(raw);
  const gdeltMatches = raw.gdelt
    .filter((e) => !merged.has(e.event_id)
      && typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  return `
    <h3>${esc(city.name)}</h3>
    <div class="meta">${esc(countryName)} &middot; Population: ${fmtNumber(city.population)}</div>
    ${buildEventsSection(eventMatches, gdeltMatches)}
    <p class="meta">Population: GeoNames. Events within 50km, matched by distance.</p>`;
}

// ---------- admin-1 (state) and admin-2 (district) cards (Task 11) ----------
//
// The third and fourth users of the shape countryCardSections/waterCardSections
// established, and structurally closer to the water card than the country one:
// a country counts "inside this bounding box" because a true polygon test over
// every AIS/ADS-B contact on Earth is not affordable at that scale (see
// buildLivePicture's own note), but a state or a district gets no such excuse
// -- Rhode Island's bbox reaches into three neighbours, and a district shaped
// round a river bend is exactly the long-thin-shape problem water bodies
// already have. So every "inside this state/district" test below is the same
// true point-in-polygon test the map's own hit-testing already runs to select
// these shapes in the first place (findSubdivisionAt/findDistrictAt).
//
// Nothing new to build for that: entries from buildSubdivisionIndex and
// buildDistrictIndex are buildShapeIndex entries themselves (`{polygons,
// bbox}`), the exact pair countryContainsPoint needs, so the same clipping the
// map already does to find which shape a click landed in is reused here to
// find which live records land inside it -- by structural typing, the same
// reuse Task 7 made of buildShapeIndex/countryContainsPoint for water.

/**
 * True containment inside a subdivision or district's own polygon -- the same
 * two-step test insideWaterFeature runs above (a cheap bbox prefilter, then
 * the real ray-cast), rewritten here rather than imported from it: a third
 * caller of two lines is still two lines, and reaching into a section that
 * exists to describe water for a helper that has nothing to do with water
 * would be a stranger coupling than repeating them. `bounds`, when given, is
 * the entry's own bbox converted to {south,west,north,east} -- see
 * subdivisionCardFor/districtCardFor in createMapController.js, which do that
 * conversion the same way waterCardFor already does for water.
 */
function insideAdminFeature(entry, bounds, lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (bounds && !boundsContainsPoint(bounds, lat, lon)) return false;
  return countryContainsPoint(entry, lat, lon);
}

/** Every item from `items` that falls inside `entry`'s polygon, `predicate`
 *  permitting -- the polygon-test counterpart to itemsInBounds above. */
function itemsInFeature(items, entry, bounds, predicate) {
  const out = [];
  for (const item of items || []) {
    if (!insideAdminFeature(entry, bounds, item.lat, item.lon)) continue;
    if (predicate && !predicate(item)) continue;
    out.push(item);
  }
  return out;
}

// ---------- admin-1 profile ----------

function buildSubdivisionProfile(entry) {
  const code = entry.code || (entry.postal ? `${entry.country_code}-${entry.postal}` : "");
  // Escaped part by part, then joined -- escaping the joined string would
  // escape the separator's own ampersand and print "State &middot; Nigeria"
  // literally (same reasoning the old subdivisionPopupHtml gave for this).
  const meta = [entry.kind, entry.country].filter(Boolean).map(esc).join(" &middot; ");
  return `
    <div class="meta">${esc(entry.name)}</div>
    <div class="meta">${meta}${code ? ` &middot; ${esc(code)}` : ""}</div>
    <div class="meta">Natural Earth admin-1 boundary, <i>reported</i> geometry. Scale caveat and district
      coverage are in the Data coverage fold below.</div>`;
}

// ---------- admin-2 profile ----------

function buildDistrictProfile(entry) {
  const where = [entry.admin1, entry.country_code].filter(Boolean).join(" &middot; ");
  return `
    <div class="meta">${esc(entry.name || entry.pcode)}</div>
    <div class="meta">${esc(where)}${entry.pcode ? ` &middot; ${esc(entry.pcode)}` : ""}</div>
    <div class="meta">OCHA COD-AB boundary, <i>reported</i> geometry, joined to HDX HAPI's conflict
      archive on p-code. District coverage is in the Data coverage fold below.</div>`;
}

// ---------- admin-1 conflict: live ACLED points, clipped to the polygon ----------

/**
 * Events and fatalities inside this state over the same 72h window the
 * country card's own conflict fold uses (RECENT_WINDOW_MS above), plus the
 * two things a country-wide tally cannot show: which event types actually
 * made up the total here, and the single worst one. Never returns "" -- a
 * quiet state in the last 72h is itself the answer, said in words rather than
 * a fold that silently vanishes (see buildCoverage's own note on the same
 * choice for the honesty section).
 */
function buildSubdivisionConflict(entry, raw, bounds) {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let count = 0;
  let fatalities = 0;
  let worst = null;
  const typeCounts = {};
  for (const e of raw.events || []) {
    if (!insideAdminFeature(entry, bounds, e.lat, e.lon)) continue;
    if (e.date) {
      const t = Date.parse(`${e.date}T00:00:00Z`);
      if (!Number.isNaN(t) && t < cutoff) continue;
    }
    count += 1;
    fatalities += e.fatalities || 0;
    if (!worst || (e.severity || 0) > (worst.severity || 0)) worst = e;
    const type = e.event_type || "Unspecified";
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }
  const provenance = '<div class="meta">ACLED, matched by point falling inside this state\'s own polygon, '
    + 'last 72h &mdash; <i>reported</i>.</div>';
  if (!count) {
    return `<div class="meta">No conflict events matched inside this state in the last 72h.</div>${provenance}`;
  }
  const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const worstLine = worst
    ? `<div class="meta">Most severe: ${esc(worst.event_type || "event")} &middot; ${worst.severity ?? 0}/100${
        worst.notes ? ` &mdash; ${esc(worst.notes.slice(0, 90))}` : ""
      }</div>`
    : "";
  return `
    <div class="cstats">
      ${statRow("", "events", count, "hot")}
      ${statRow("", "killed", fatalities, "hot")}
    </div>
    ${topTypes.length ? `<div class="meta">Top event types: ${topTypes.map(([t, n]) => `${esc(t)} (${n})`).join(", ")}</div>` : ""}
    ${worstLine}
    ${provenance}`;
}

// ---------- admin-2 conflict: the reviewed monthly record plus its trend ----------

const DISTRICT_TREND_MONTHS = 24;

/**
 * The four DISTRICT_METRICS rows for whichever month is selected, plus a
 * 24-month fatality sparkline built from that district's own slice of the
 * hapi_conflict archive.
 *
 * `record` is null for a district the archive has no row for in the selected
 * month -- distinct from a row of zeros, and said in DISTRICT_NO_RECORD_CAVEAT's
 * own words, because the whole archive rests on that difference.
 * `loading` is the third state and is kept apart from both: a month whose
 * counts are still in flight must not read as a month with no record.
 * `series` is that one district's own records across every month the archive
 * has fetched for its country (see districtCardSections/createMapController.js's
 * loadDistrictSeries) -- already this district's alone, so no further
 * filtering happens here.
 */
function buildDistrictConflict(record, series, month, loading) {
  const monthLabel = esc(month || "the archive");
  const provenance = '<div class="meta">ACLED via HDX HAPI, joined to OCHA COD-AB boundaries on p-code '
    + '&mdash; <i>reported</i>. A monthly archive that runs to the end of a past month, not the live '
    + 'conflict layer, and not comparable to it.</div>';
  if (loading) {
    return `<div class="meta district-loading">Loading ${monthLabel}&hellip;</div>${provenance}`;
  }
  const recordBlock = record
    ? `<div class="meta">Reviewed record for <b>${esc(record.month || month || "")}</b></div>
       <div class="district-rows">${DISTRICT_METRICS.map((m) => {
         const value = Number(m.valueOf(record)) || 0;
         return `<div class="district-row"><span>${esc(m.label)}</span><b>${fmtNumber(value)}</b></div>`;
       }).join("")}</div>
       <div class="meta">Demonstrations are counted separately and are not part of the violence totals.</div>`
    : `<div class="meta district-nodata">No record for ${monthLabel}. ${DISTRICT_NO_RECORD_CAVEAT}</div>`;
  const trend = buildSparkline(series, {
    count: DISTRICT_TREND_MONTHS,
    readValue: (r) => r.fatalities || 0,
    headingOf: (recent) => `Fatalities, last ${recent.length} months (HDX/ACLED)`,
    captionOf: (recent, max) => {
      const last = recent[recent.length - 1];
      return last ? `${last.month || ""}: ${last.fatalities || 0} killed · peak ${max}` : "";
    },
  });
  return `${recordBlock}${trend}${provenance}`;
}

// ---------- shared: cities, live picture, infrastructure, coverage ----------
//
// Identical for admin-1 and admin-2 (see the task brief's own table), so each
// is written once and called from both subdivisionCardSections and
// districtCardSections below.

const ADMIN_CITY_CAP = 8;

/** Cities inside this state/district, largest first, with a capital flag. */
function buildAdminCities(entry, raw, bounds) {
  const cities = itemsInFeature(raw.cities, entry, bounds)
    .sort((a, b) => (b.population || 0) - (a.population || 0));
  if (!cities.length) {
    const reason = emptyFoldReason(["cities"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }
  const largest = cities[0];
  const shown = cities.slice(0, ADMIN_CITY_CAP);
  const rows = shown.map((c) => `<div class="event-row"><b>${esc(c.name)}</b>${c.is_capital ? " &middot; capital" : ""}
    <div class="event-meta">Population ${fmtNumber(c.population)}</div></div>`).join("");
  return `
    <div class="cstats">${statRow("", "cities", cities.length, "hot")}</div>
    <div class="meta">Largest: <b>${esc(largest.name)}</b>, population ${fmtNumber(largest.population)}${
      largest.is_capital ? " &middot; capital" : ""
    }</div>
    <div class="popup-events">${rows}</div>
    ${cities.length > shown.length ? `<div class="meta">+${cities.length - shown.length} more</div>` : ""}
    <div class="meta">Cities: GeoNames, <i>reported</i> population figures.</div>`;
}

/** Aircraft, ships, fires and GPS jamming cells inside -- the live picture,
 *  narrower than the country card's own (buildLivePicture) because a state or
 *  a district is a smaller claim to begin with: counts only, no navy/tanker
 *  breakdown. */
function buildAdminLive(entry, raw, bounds) {
  const aircraft = itemsInFeature(raw.adsb, entry, bounds).length;
  const ships = itemsInFeature(raw.ais, entry, bounds).length;
  const fires = itemsInFeature(raw.firms, entry, bounds).length;
  const jamming = itemsInFeature(raw.jamming, entry, bounds).length;
  const cells = [
    statRow("", "aircraft", aircraft, "hot"),
    statRow("", "ships", ships),
    statRow("", "active fires", fires),
    statRow("", "GPS jamming cells", jamming, "hot"),
  ].join("");
  if (!cells) {
    const reason = emptyFoldReason(["adsb", "ais", "firms", "jamming"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }
  return `<div class="cstats">${cells}</div>
    ${BBOX_LOAD_CAVEAT}
    <div class="meta">Aircraft: ADS-B, <i>measured</i>. Ships: AIS (aisstream.io), <i>measured</i>. Fires:
      NASA FIRMS/HMS, <i>measured</i>. GPS jamming cells: gpsjam.org, <i>derived</i> from crowdsourced
      ADS-B anomalies.</div>`;
}

/** Power plants, dams, airfields, ports, rail stops and border crossings
 *  inside -- the country card's own energy-infrastructure and transport
 *  folds (buildEnergyInfrastructure/buildTransport), merged into one section
 *  here because a state or district card has room for one infrastructure
 *  fold, not two. */
function buildAdminInfrastructure(entry, raw, bounds) {
  const inside = (items, predicate) => itemsInFeature(items, entry, bounds, predicate);
  // Task 28: power plants moved off raw.osmInfra onto their own
  // raw.powerPlants (see createMapController.js's applyData split) -- reading
  // the old osmInfra-filtered-by-kind path here would silently report zero.
  const plants = inside(raw.powerPlants);
  const dams = inside(raw.dams);
  const airports = inside(raw.airports);
  const ports = inside(raw.ports);
  // Task 27: same move as buildTransport above -- raw.railwayPoints, not
  // raw.osmInfra, is where the four railway kinds live now.
  const rail = inside(raw.railwayPoints);
  const crossings = inside(raw.osmInfra, (d) => d.kind === "border_control");
  if (!plants.length && !dams.length && !airports.length && !ports.length && !rail.length && !crossings.length) {
    const reason = emptyFoldReason(["osmInfra", "dams", "airports", "ports"], bounds, raw, { boundsOptional: true });
    return reason ? emptyFoldNote(reason) : "";
  }

  const summary = summarizePowerPlants(plants);
  const airportBuckets = bucketAirportsByType(airports);

  return `
    <div class="cstats">
      ${statRow("", "power plants", summary.count)}
      ${statRow("", "dams", dams.length)}
      ${statRow("", "airfields", airports.length)}
      ${statRow("", "ports", ports.length)}
      ${statRow("", "rail stops", rail.length)}
      ${statRow("", "border crossings", crossings.length)}
    </div>
    ${summary.count ? `<div class="meta">${summary.taggedCount} of ${summary.count} power plant${
        summary.count === 1 ? "" : "s"
      } tag a generation capacity in OpenStreetMap${
        summary.taggedCount
          ? ` &mdash; <b>${fmtNumber(Math.round(summary.totalOutputMw))} MW</b> summed over just those`
          : ""
      }.</div>` : ""}
    ${airports.length ? `<div class="meta">Airfields by size: ${
        AIRFIELD_ORDER.filter((t) => airportBuckets.counts[t])
          .map((t) => `${esc(AIRFIELD_STYLE[t].label)} (${airportBuckets.counts[t]})`)
          .join(", ") || "size not classified by OurAirports"
      }</div>` : ""}
    ${(plants.length || dams.length || rail.length || crossings.length)
      ? `<p class="meta">${OSM_SWEEP_CAVEAT} ${DAM_SWEEP_CAVEAT}</p>` : ""}
    <div class="meta">Sources: OpenStreetMap contributors (ODbL) via Overpass, <i>reported</i>, for power
      plants, rail and border crossings &middot; Global Dam Watch v1.0 (CC BY 4.0), <i>reported</i> &middot;
      OurAirports (public domain), <i>reported</i> &middot; NGA World Port Index, <i>reported</i> reference
      data, roughly 2024-vintage.</div>`;
}

// Mirrors backend/sources/admin2_boundaries.py's own COUNTRIES tuple by hand
// -- the same discipline WATCHED_WATERS above follows for its own backend
// default: six ISO3 codes are thirty-six characters, and a network round trip
// to keep them in sync would be a strange trade. If admin2_boundaries.py's
// COUNTRIES tuple ever changes, this has to change with it by hand.
const ADMIN2_COUNTRIES = [
  { iso3: "AFG", name: "Afghanistan" },
  { iso3: "VEN", name: "Venezuela" },
  { iso3: "YEM", name: "Yemen" },
  { iso3: "SDN", name: "Sudan" },
  { iso3: "COD", name: "Democratic Republic of the Congo" },
  { iso3: "UKR", name: "Ukraine" },
];

/**
 * The record buildAdminConnectivity actually reads, resolved once so the
 * state and district cards can share one fold body.
 *
 * A state card's `props` already carries `code` (its own ISO 3166-2) and
 * `regionOutageFor` reads it directly. A district card's does not -- IODA has
 * no district-level reading at all, so a district's connectivity is its
 * parent state's, found through the exact same geometric join
 * assignDistrictStates already computed for the drill-down
 * (raw.districtStateByPcode, createMapController.js) rather than a second,
 * fragile name match against `admin1` built here. See that function's own
 * comment on why a geometric join was chosen over a name one in the first
 * place: OCHA and Natural Earth spell the same province differently often
 * enough to lose a fifth of them.
 */
function adminOutageRecord(props, raw) {
  if (props?.code) return regionOutageFor(props, raw);
  if (!props?.pcode) return null;
  const stateKey = (raw.districtStateByPcode || new Map()).get(props.pcode);
  if (stateKey == null) return null;
  const state = (raw.subdivisionIndex || []).find((e) => e.key === stateKey);
  return state ? regionOutageFor(state, raw) : null;
}

/**
 * The Connectivity fold both admin-1 and admin-2 cards share (Task 26) --
 * same shape and same wording discipline as the country card's own
 * buildConnectivity above, just matched to this one boundary (or, for a
 * district, its parent state -- see adminOutageRecord) instead of the whole
 * country. Empty, like buildConnectivity, when there is genuinely nothing to
 * show: a state IODA has not scored is not different enough from a state
 * nobody has looked at to be worth a fold saying so, which is the same call
 * the country card already makes for this exact feed.
 *
 * Task 32 (this task's own inventory names this the "unmatched-region case"):
 * "genuinely nothing to show" is not the same claim as "adminOutageRecord
 * found no record for this exact boundary", and the old version conflated
 * them. A state whose IODA region record could not be geometrically matched
 * to any admin-1 shape (see regionMatchSummary's own docstring -- roughly a
 * quarter of a country's regions land there) reads identically, from here,
 * to a state IODA never looked at near at all -- both were a bare `null`
 * from adminOutageRecord. buildAdminCoverage already states the country-wide
 * version of this tally, but a reader who opened this fold specifically for
 * connectivity should not have to go find that one to learn the difference.
 */
function buildAdminConnectivity(props, raw) {
  const isDistrict = !props?.code && !!props?.pcode;
  const outage = adminOutageRecord(props, raw);
  if (!outage) {
    // adminOutageRecord reads raw.outagesRegions exclusively (via
    // regionOutageFor) -- a separate POLL_CONFIG row from raw.outages with its
    // own fetchCoverage entry (see FETCH_ALWAYS_BECAUSE's "outagesRegions" row
    // in map/scene.js). Checking "outages" here was checking the wrong feed's
    // coverage: a country whose national score had landed but whose
    // region-level poll had not (or had errored) still read as "checked,
    // nothing here" instead of "not checked yet".
    const reason = coverageReason("outagesRegions", null, raw); // unscoped, same as connectivityTile
    if (reason) return emptyFoldNote(reason);
    // State and district entries both carry their own country_code (ISO3 --
    // see subdivisionCardSections/districtCardSections' own docstrings), so
    // no state/district resolution is needed just to find the country this
    // boundary sits in, unlike adminOutageRecord's own district-to-state
    // lookup (which exists to find a *specific* state's outage record, not
    // merely its country).
    const regionSummary = regionMatchSummary(iso2ForIso3(props?.country_code, raw), raw);
    if (!regionSummary) return "";
    return `<p class="meta">IODA scored ${regionSummary.total} region(s) in this country over the current
      window, but none matched to this exact boundary &mdash; ${regionSummary.matched} matched to some
      other state or province here, and ${regionSummary.unmatched} could not be placed on any boundary at
      all (see the Data coverage fold below for the full tally). That is not the same as IODA finding
      nothing near here.</p>`;
  }
  const signals = Object.keys(outage.signals || {});
  const windowText = formatOutageWindow(outage.window_start, outage.window_end);
  const matchWord = outage.matched === "exact" ? "an exact" : "a fuzzy (name-normalised)";
  const scopeLine = isDistrict
    ? "IODA has no district-level reading &mdash; this is the state this district sits in."
    : `Matched to this boundary by ${matchWord} match between IODA's region name and this admin-1 shape's own name.`;
  return `
    <div class="outage-block">
      <div class="outage-head">Internet disruption detected</div>
      <div>IODA composite score: ${fmtNumber(Math.round(outage.score))}${
        outage.event_count ? ` &middot; ${esc(outage.event_count)} event(s)` : ""
      }</div>
      ${signals.length ? `<div class="meta">Seen in: ${signals.map((k) => esc(k.split(".")[0])).join(", ")}</div>` : ""}
    </div>
    <p class="meta">Over the ${esc(windowText || "reporting window")}, reported by IODA (Georgia Tech). ${scopeLine}
      The score is a composite that is only meaningful <b>in comparison</b> &mdash; against this region's own
      normal and against other regions in the same window. It is not a percentage of the region offline, and
      it cannot distinguish a shutdown from a cable fault.</p>`;
}

/**
 * The honesty fold both cards share: which six countries have admin-2
 * boundaries at all, the Natural Earth 1:10m subdivision caveat verbatim, the
 * "a missing row is not a reported zero" caveat verbatim, and how many of this
 * country's IODA-scored regions could and could not be placed on a boundary
 * here -- see SUBDIVISION_SCALE_CAVEAT, DISTRICT_NO_RECORD_CAVEAT and
 * regionMatchSummary respectively for why each is kept as its own thing
 * rather than retyped here. Never empty, like buildCoverage on the country
 * card: this is the place a reader checks *why* a fold above came back thin,
 * so it has to survive being asked about a country with no district layer,
 * and no IODA region reporting, at all.
 *
 * The region line is the fix for a conflation this project has repeated
 * across several other layers: without it, a province IODA scored but could
 * not place and a province IODA never looked at both render as an empty
 * Connectivity fold above, and a reader has no way to tell "nothing here"
 * from "something here we couldn't draw". At this build's own measured match
 * rate that is not a rare case -- roughly a quarter of a country's regions
 * can land in the second bucket.
 */
function buildAdminCoverage(props, raw) {
  const list = ADMIN2_COUNTRIES.map((c) => esc(c.name)).join(", ");
  const regionSummary = regionMatchSummary(iso2ForIso3(props?.country_code, raw), raw);
  // regionMatchSummary reads raw.outagesRegions and returns null both when
  // that feed has genuinely never scored anything here *and* when it has
  // never been fetched (or was fetched for a different area) at all -- this
  // fold used to print "no region-level reporting" for both, which is exactly
  // the "found nothing" vs "did not look" conflation this fold exists to
  // close for everything else on the card. coverageReason tells the two
  // apart the same way every other section on this card already does.
  const regionCoverageReason = regionSummary ? null : coverageReason("outagesRegions", null, raw);
  const regionLine = regionSummary
    ? `<div class="meta">Internet outages (IODA): ${regionSummary.matched} of ${regionSummary.total}
        region(s) IODA scored in this country over the current window matched to an admin-1 boundary here${
          regionSummary.unmatched
            ? ` &mdash; <b>${regionSummary.unmatched} could not be placed</b> and do not appear on any state
                or district card, though IODA did report them`
            : ""
        }.</div>`
    : regionCoverageReason
      ? `<div class="meta">Internet outages (IODA): ${esc(regionCoverageReason)}</div>`
      : `<div class="meta">Internet outages (IODA): no region-level reporting for this country in the current
        window.</div>`;
  return `
    <div class="meta">${SUBDIVISION_SCALE_CAVEAT}</div>
    <div class="meta">District-level (admin-2) boundaries and their monthly conflict archive exist for
      six countries only: ${list}. Every other state or district on this map has no district layer to
      drill into, which is not a claim that nothing has happened there.</div>
    <div class="meta district-nodata">A district can go unmentioned in the archive for any given month.
      ${DISTRICT_NO_RECORD_CAVEAT}</div>
    ${regionLine}
    <div class="meta">Boundaries: Natural Earth admin-1 (public domain, CC0) and OCHA COD-AB admin-2
      (public domain), both <i>reported</i> geometry.</div>`;
}

/**
 * The admin-1 (state) card, as a list of independently foldable sections --
 * the sibling of countryCardSections/waterCardSections above, same
 * {title, sections} shape.
 *
 * @param props   a buildSubdivisionIndex entry: key/code/name/postal/kind/
 *                country_code/country, plus the `{polygons, bbox}` pair
 *                buildShapeIndex attaches to every entry.
 * @param raw     the map controller's live data buckets, plus `outagesRegions`
 *                ({ISO2: {code: record}}, backend/sources/outages.py) the
 *                Connectivity fold reads through regionOutageFor.
 * @param bounds  the entry's own bbox, converted to {south,west,north,east}
 *                -- a cheap pre-filter ahead of the real polygon tests above,
 *                same role it plays for waterCardSections. Optional.
 */
export function subdivisionCardSections(props, raw, bounds) {
  const sections = [
    { id: "profile", title: "State profile", defaultOpen: true, html: buildSubdivisionProfile(props) },
    { id: "conflict", title: "Conflict · last 72h", defaultOpen: true, html: buildSubdivisionConflict(props, raw, bounds) },
    { id: "cities", title: "Cities", html: buildAdminCities(props, raw, bounds) },
    { id: "live", title: "Live picture", html: buildAdminLive(props, raw, bounds) },
    { id: "infrastructure", title: "Infrastructure", html: buildAdminInfrastructure(props, raw, bounds) },
    { id: "connectivity", title: "Connectivity", html: buildAdminConnectivity(props, raw) },
    { id: "coverage", title: "Data coverage", html: buildAdminCoverage(props, raw) },
  ];
  return { title: props.name || "State", sections: sections.filter((s) => s.html && s.html.trim()) };
}

/**
 * The admin-2 (district) card, as a list of independently foldable sections.
 *
 * @param props   a buildDistrictIndex entry: pcode/name/admin1/country_code,
 *                plus the `{polygons, bbox}` pair buildShapeIndex attaches.
 * @param raw     the map controller's live data buckets, plus the three
 *                district-archive fields the controller mirrors onto it
 *                (see createMapController.js): `districtCounts` (a Map,
 *                pcode -> this month's record), `districtMonthLoading`
 *                (whether that month's counts are still in flight) and
 *                `districtSeries` ({ISO3: record[]}, this country's own slice
 *                of the archive across every month fetched so far). Also
 *                `districtStateByPcode` (pcode -> parent state's subdivision
 *                key) and `subdivisionIndex`, which the Connectivity fold
 *                uses to find the state IODA actually scored -- see
 *                adminOutageRecord.
 * @param bounds  the entry's own bbox, converted to {south,west,north,east}.
 *                Optional.
 * @param month   the archive month currently selected ("YYYY-MM"), or null
 *                before the months list has loaded.
 */
export function districtCardSections(props, raw, bounds, month) {
  const record = (raw.districtCounts && raw.districtCounts.get(props.pcode)) || null;
  const loading = !!raw.districtMonthLoading;
  const series = ((raw.districtSeries || {})[props.country_code] || [])
    .filter((r) => (r.admin2_code || String(r.id || "").split("-")[2]) === props.pcode)
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  const sections = [
    { id: "profile", title: "District profile", defaultOpen: true, html: buildDistrictProfile(props) },
    { id: "conflict", title: "Conflict record", defaultOpen: true, html: buildDistrictConflict(record, series, month, loading) },
    { id: "cities", title: "Cities", html: buildAdminCities(props, raw, bounds) },
    { id: "live", title: "Live picture", html: buildAdminLive(props, raw, bounds) },
    { id: "infrastructure", title: "Infrastructure", html: buildAdminInfrastructure(props, raw, bounds) },
    { id: "connectivity", title: "Connectivity", html: buildAdminConnectivity(props, raw) },
    { id: "coverage", title: "Data coverage", html: buildAdminCoverage(props, raw) },
  ];
  return { title: props.name || props.pcode || "District", sections: sections.filter((s) => s.html && s.html.trim()) };
}
