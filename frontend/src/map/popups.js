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
} from "./decorators";
import { countryContainsPoint } from "./countryHitTest";
import { CLASS_LABEL as WATER_CLASS_LABEL, WATER_SCALE_CAVEAT } from "./water";

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
function itemsInBounds(items, bounds, predicate) {
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

function countInBounds(items, bounds, predicate) {
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
  if (!cells) return "";

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
function recentConflictStats(bounds, raw) {
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
  if (!outage) return "";
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
      It is not a percentage of the country offline, and it cannot distinguish a shutdown from a cable fault.</p>`;
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
 */
export function summarizePowerPlants(plants) {
  const list = plants || [];
  const tagged = list.filter((p) => Number.isFinite(p.output_mw));
  const totalOutputMw = tagged.reduce((sum, p) => sum + p.output_mw, 0);
  const { counts } = tallyBy(list, (p) => p.source_tag || null);
  return {
    count: list.length,
    taggedCount: tagged.length,
    totalOutputMw,
    bySource: Object.entries(counts).sort((a, b) => b[1] - a[1]),
  };
}

function buildEnergyInfrastructure(bounds, raw) {
  const plants = itemsInBounds(raw.osmInfra, bounds, (d) => d.kind === "power_plant");
  const dams = itemsInBounds(raw.dams, bounds);
  const landings = itemsInBounds(raw.cableLandings, bounds);
  if (!plants.length && !dams.length && !landings.length) return "";

  const summary = summarizePowerPlants(plants);
  const shownSources = summary.bySource.slice(0, ENERGY_SOURCE_CAP);

  const damPower = dams.filter((d) => Number.isFinite(d.power_mw));
  const damPowerMw = damPower.reduce((sum, d) => sum + d.power_mw, 0);
  const damCapacity = dams.filter((d) => Number.isFinite(d.capacity_mcm));
  const damCapacityMcm = damCapacity.reduce((sum, d) => sum + d.capacity_mcm, 0);

  return `
    <div class="cstats">
      ${statRow("", "power plants (OSM)", summary.count)}
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
    ${shownSources.length
      ? `<div class="meta">By source: ${shownSources.map(([src, n]) => `${esc(src || "unspecified")} (${n})`).join(", ")}</div>`
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
    <p class="meta">${OSM_SWEEP_CAVEAT} ${DAM_SWEEP_CAVEAT}</p>
    <div class="meta">Source: OpenStreetMap contributors (ODbL), via Overpass, <i>reported</i> by its
      mappers and not checked by hand &middot; Global Dam Watch v1.0 (CC BY 4.0), <i>reported</i> by the
      dataset's own contributing surveys &middot; TeleGeography submarine cable landings.</div>`;
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

function buildMilitary(bounds, raw, props) {
  const airfields = itemsInBounds(raw.osmInfra, bounds, (d) => d.kind === "military_airfield" || d.kind === "military_area");
  // Curated infra (backend/infrastructure.py) tags every military site
  // type: "military" -- the same field decorators.js reads to colour it.
  const bases = itemsInBounds(raw.infra, bounds, (d) => d.type === "military");
  const aircraft = itemsInBounds(raw.adsb, bounds, (a) => classifyAircraft(a) === "military");
  const navy = itemsInBounds(raw.ais, bounds, (s) => classifyShip(s) === "navy");
  const { ships: sanctionedShips, aircraft: sanctionedAircraft } = sanctionedByFlag(props, raw);

  if (!airfields.length && !bases.length && !aircraft.length && !navy.length
    && !sanctionedShips.length && !sanctionedAircraft.length) return "";

  const roleCounts = tallyBy(aircraft, (a) => (a.military_role && MILITARY_ROLE_STYLE[a.military_role] ? a.military_role : null));
  const roleEntries = Object.entries(roleCounts.counts).sort((a, b) => b[1] - a[1]);

  const cells = [
    statRow("", "military airfields/areas (OSM)", airfields.length, "hot"),
    statRow("", "curated bases", bases.length),
    statRow("", "military aircraft", aircraft.length, "hot"),
    statRow("", "navy vessels", navy.length),
  ].join("");

  return `
    <div class="cstats">${cells}</div>
    ${BBOX_LOAD_CAVEAT}
    ${roleEntries.length
      ? `<div class="meta">Aircraft by role: ${roleEntries.map(([role, n]) => `${esc(MILITARY_ROLE_STYLE[role].label)} (${n})`).join(", ")}</div>`
      : ""}
    ${airfields.length ? `<div class="csection-h">Airfields & areas (OpenStreetMap)</div>${
      infraListRows(airfields, "osmInfra", (d) => `${d.name} &mdash; ${OSM_INFRA_STYLE[d.kind]?.label || d.kind}`)
    }<p class="meta">${OSM_SWEEP_CAVEAT}</p>` : ""}
    ${bases.length ? `<div class="csection-h">Curated bases</div>${infraListRows(bases, null, (d) => d.name)}` : ""}
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
      vessel's own broadcast ship-type code &middot; OFAC Specially Designated Nationals list (US
      Treasury), <i>reported</i>.</div>`;
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
  const rail = itemsInBounds(raw.osmInfra, bounds, (d) => typeof d.kind === "string" && d.kind.startsWith("railway_"));
  if (!airports.length && !ports.length && !crossings.length && !rail.length) return "";

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
  { key: "osmInfra", label: "OpenStreetMap infrastructure sweep", provenance: "reported", whenMs: () => null },
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

/** The same wording buildCoverage's own rows use for these two states, so the
 * strip and the Data Coverage fold never tell two different stories about the
 * same feed. `null` means "checked" -- the caller has a real answer to show. */
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
    sectionIds: ["conflict", "live", "connectivity", "events", "verified", "trend"],
  },
  {
    id: "country", title: "Country",
    sectionIds: ["profile", "humanitarian", "power", "energy", "transport", "military", "food"],
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
 */
function insideWaterFeature(feature, bounds, lat, lon) {
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
  if (!total) return "";
  const rows = VESSEL_TRAFFIC_ORDER.map((k) => statRow("", VESSEL_TRAFFIC_LABEL[k], counts[k])).join("");
  return `<div class="cstats">${rows}${statRow("", "total", total, "hot")}</div>
    ${AIS_COVERAGE_CAVEAT}`;
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
  if (!total) return "";

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

function watchedWaterOverlap(feature) {
  if (!Array.isArray(feature?.rawBbox)) return null;
  return WATCHED_WATERS.find((w) => bboxesOverlap(feature.rawBbox, w.box)) || null;
}

// Whether this water body overlaps one of the eight chokepoint boxes, and
// what that does and does not mean for the Dark Vessels layer -- always
// answerable, so unlike every other fold this one never drops itself.
function buildWaterChokepoint(feature) {
  const hit = watchedWaterOverlap(feature);
  if (hit) {
    return `<div>Inside <b>${esc(hit.label)}</b>, one of the eight theatres the Dark Vessels layer is
        willing to draw a &ldquo;went dark&rdquo; conclusion from.</div>
      <p class="meta">Its ship-to-ship pairing and Global Fishing Watch's own AIS-disabling findings are
        not scoped this way &mdash; both run wherever AIS reaches, chokepoint or not.</p>`;
  }
  return `<div>Outside every chokepoint the Dark Vessels layer is scoped to.</div>
    <p class="meta">Its &ldquo;went dark&rdquo; inference will not draw a conclusion here even where a real
      gap exists &mdash; that is a limit on what the layer is willing to claim, not a report that nothing
      happens here. Ship-to-ship pairing and Global Fishing Watch's own AIS-disabling findings are
      unaffected and still run here.</p>`;
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
  if (!crossing.length && !landings.length && !shorePorts.length) return "";

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
    { id: "traffic", title: "Traffic now", html: buildWaterTraffic(feature, raw, bounds) },
    { id: "dark", title: "Dark activity", html: buildWaterDark(feature, raw, bounds) },
    { id: "chokepoint", title: "Chokepoint watch", html: buildWaterChokepoint(feature) },
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
