// Country/city popup HTML: population + density (countries) and any
// recent conflict/news events matched nearby. Reads from the current raw
// events/gdelt arrays passed in by the caller (see useLeafletMap) rather than
// holding its own copy, so it's always working off the latest poll.

import { esc, fmtNumber, haversineKm, timeAgoFromDateAdded } from "../utils/format";

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

function buildEventsSection(eventItems, gdeltItems) {
  const rows = [
    ...eventItems.map((i) => formatEventRow("events", i)),
    ...gdeltItems.map((i) => formatEventRow("gdelt", i)),
  ].filter(Boolean);
  if (!rows.length) {
    return '<div class="popup-events"><div class="meta">No recent conflict/news events matched for this area.</div></div>';
  }
  return `<div class="popup-events"><div class="meta">Recent events</div>${rows.join("")}</div>`;
}

export function countryPopupHtml(props, raw) {
  const name = props.name || "Unknown";
  const wanted = normalizeCountryName(name);
  const eventMatches = raw.events.filter((e) => normalizeCountryName(e.country) === wanted).slice(0, 3);
  const gdeltMatches = raw.gdelt
    .filter((e) => {
      if (!e.location) return false;
      const parts = e.location.split(",");
      return normalizeCountryName(parts[parts.length - 1]) === wanted;
    })
    .slice(0, 3);
  const statsKey = Object.keys(raw.conflictStats || {}).find((k) => normalizeCountryName(k) === wanted);
  const trendSeries = statsKey ? raw.conflictStats[statsKey] : null;
  return `
    <h3>${esc(name)}</h3>
    <div class="meta">Population: ${fmtNumber(props.population)}${props.pop_year ? ` (${esc(props.pop_year)})` : ""}</div>
    <div class="meta">Population density: ${props.density != null ? `${props.density} /km&sup2;` : "n/a"}</div>
    <div class="meta">Human Development Index: ${props.hdi != null ? props.hdi.toFixed(3) : "n/a"}</div>
    ${buildEventsSection(eventMatches, gdeltMatches)}
    ${buildTrendSection(trendSeries)}
    <p class="meta">Population/density: World Bank. HDI: UNDP (via Our World in Data). Events matched by country name &mdash; naming differences can cause a miss.</p>`;
}

export function cityPopupHtml(city, raw, countryNameByIso2) {
  const countryName = countryNameByIso2[city.country_code] || city.country_code || "";
  const eventMatches = raw.events
    .filter((e) => typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  const gdeltMatches = raw.gdelt
    .filter((e) => typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  return `
    <h3>${esc(city.name)}</h3>
    <div class="meta">${esc(countryName)} &middot; Population: ${fmtNumber(city.population)}</div>
    ${buildEventsSection(eventMatches, gdeltMatches)}
    <p class="meta">Population: GeoNames. Events within 50km, matched by distance.</p>`;
}
