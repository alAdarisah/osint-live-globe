// Country/city popup HTML: population + density (countries) and any
// recent conflict/news events matched nearby. Reads from the current raw
// events/gdelt arrays passed in by the caller (see useLeafletMap) rather than
// holding its own copy, so it's always working off the latest poll.

import { esc, fmtNumber, haversineKm, timeAgoFromDateAdded } from "../utils/format";
import { boundsContainsPoint } from "../utils/geo";
import { classifyAircraft, classifyShip } from "./decorators";

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

function formatEventRow(type, item) {
  if (type === "events") {
    const label = item.event_type || "Conflict event";
    const sourceLabel = (item.corroborated_by && item.corroborated_by.length ? item.corroborated_by : [item.source])
      .filter(Boolean)
      .join("/")
      .toUpperCase();
    return `<div class="event-row"><b>${esc(label)}</b>${item.fatalities ? ` (${item.fatalities} fatalities)` : ""}
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
  return `<div class="event-row">${link}<div class="event-meta">${esc(sourceLabel)} &middot; ${esc(when)}${corroborated}</div></div>`;
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
function countInBounds(items, bounds, predicate) {
  if (!bounds || !items) return 0;
  let n = 0;
  for (const item of items) {
    if (typeof item.lat !== "number" || typeof item.lon !== "number") continue;
    if (!boundsContainsPoint(bounds, item.lat, item.lon)) continue;
    if (predicate && !predicate(item)) continue;
    n += 1;
  }
  return n;
}

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
  return `<div class="cstats">${cells}</div>`;
}

// 72h rather than the full 3-day feed window so "recent" means recent --
// and severity/corroboration are surfaced because they're the two things
// that separate a confirmed massacre from a single unverified report.
const RECENT_WINDOW_MS = 72 * 3600 * 1000;

function buildConflictSummary(bounds, raw, escalationZone) {
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

function buildSparkline(monthlySeries) {
  if (!monthlySeries || monthlySeries.length < 2) return "";
  const recent = monthlySeries.slice(-SPARK_MONTHS);
  const max = Math.max(...recent.map((m) => m.fatalities || 0), 1);
  const w = 8;
  const gap = 2;
  const h = 26;
  const bars = recent
    .map((m, i) => {
      const val = m.fatalities || 0;
      const bh = Math.max(1, Math.round((val / max) * h));
      // Newest bar accented so "where are we now" is obvious at a glance.
      const fill = i === recent.length - 1 ? "#ff5c2a" : "rgba(255,140,58,0.55)";
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" fill="${fill}" rx="1"/>`;
    })
    .join("");
  const last = recent[recent.length - 1];
  const label = last ? `${MONTH_ABBR[last.month]} ${last.year}: ${last.fatalities || 0} killed` : "";
  return `<div class="meta">Fatalities, last ${recent.length} months (HDX/ACLED)</div>
    <svg class="cspark" viewBox="0 0 ${recent.length * (w + gap)} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">${bars}</svg>
    <div class="meta">${esc(label)} &middot; peak ${max}</div>`;
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
 * @returns {{title: string, sections: Array<{id, title, html, defaultOpen}>}}
 */
// Displacement and food security (backend/sources/humanitarian.py). Keyed on
// ISO3, which is what both UNHCR and HAPI use -- and which the country features
// already carry (see backend/sources/countries.py), so no name matching.
//
// Every figure is a country-level aggregate over a reference period of months,
// so each one states its period. Nothing here is live and none of it is drawn
// on the map.
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
    ].filter(Boolean);
    if (parts.length) {
      rows.push(`<div>${parts.join(" &middot; ")}</div>
        <div class="meta">UNHCR, ${esc(d.year)} &mdash; counted by country of <b>origin</b>: people this
          country's situation has displaced, wherever they are now.</div>`);
    }
  }
  if (food) {
    rows.push(`<div><b>${fmtNumber(food.population_in_crisis)}</b> in IPC phase 3 or worse (crisis, emergency
      or famine)</div>
      <div class="meta">IPC via HDX HAPI, analysis period from ${esc((food.reference_period_start || "").slice(0, 10))}.</div>`);
  }
  if (idps) {
    rows.push(`<div>${fmtNumber(idps.population)} internally displaced, in-country assessment</div>
      <div class="meta">HDX HAPI, reporting round from ${esc((idps.reference_period_start || "").slice(0, 10))}.</div>`);
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

// A country losing the internet is one of the few things on this map that is
// genuinely national in scope, so it belongs in the country card rather than as
// a pin. IODA's `score` is a composite of three detection methods and is
// unbounded -- it is emphatically not a percentage of the country offline, and
// this says so rather than dressing it up as one.
function buildConnectivity(props, raw) {
  const code = props.iso_a2 && props.iso_a2 !== "-99" ? props.iso_a2 : null;
  const outage = code ? (raw.outages || {})[code] : null;
  if (!outage) return "";
  const signals = Object.keys(outage.signals || {});
  return `
    <div class="outage-block">
      <div class="outage-head">Connectivity disruption detected</div>
      <div>IODA composite score: ${fmtNumber(Math.round(outage.score))}${
        outage.event_count ? ` &middot; ${esc(outage.event_count)} event(s)` : ""
      }</div>
      ${signals.length ? `<div class="meta">Seen in: ${signals.map((k) => esc(k.split(".")[0])).join(", ")}</div>` : ""}
    </div>
    <p class="meta">Over the last 24 hours, from IODA (Georgia Tech), which watches BGP withdrawals, active
      probing and darknet traffic. The score is a composite that is only meaningful <b>in comparison</b>
      &mdash; against this country's own normal and against others in the same window. It is not a
      percentage of the country offline, and it cannot distinguish a shutdown from a cable fault.</p>`;
}

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
    { id: "verified", title: "Verified record", html: buildVerifiedRecord(wanted, raw) },
    { id: "trend", title: "Fatality trend", html: buildSparkline(trendSeries) },
    { id: "events", title: "Recent events", html: buildEventsSection(eventMatches, gdeltMatches, { heading: false }) },
    {
      id: "sources",
      title: "Sources & caveats",
      html: `<p class="meta">Live counts use the country's bounding box, so figures near borders are
        approximate. Population/density: World Bank. HDI: UNDP. Listed events matched by country name.</p>`,
    },
  ];

  return { title: name, sections: sections.filter((s) => s.html && s.html.trim()) };
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
