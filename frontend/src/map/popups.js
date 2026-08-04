// Country/city popup HTML: population + density (countries) and any
// recent conflict/news events matched nearby. Reads from the current raw
// acled/gdelt arrays passed in by the caller (see useLeafletMap) rather than
// holding its own copy, so it's always working off the latest poll.

import { esc, fmtNumber, haversineKm } from "../utils/format";
import { gdeltSentence } from "./decorators";

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
  if (type === "acled") {
    const label = item.event_type || "Conflict event";
    return `<div class="event-row"><b>${esc(label)}</b>${item.fatalities ? ` (${item.fatalities} fatalities)` : ""}
      <div class="event-meta">${esc(item.country || "")} &middot; ${esc(item.date || "")} &middot; ACLED</div></div>`;
  }
  const headline = (item.real_title && item.real_title.trim()) || gdeltSentence(item);
  const link = item.source_url
    ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">${esc(headline)}</a>`
    : esc(headline);
  const sourceLabel = item.source_name || "GDELT";
  return `<div class="event-row">${link}<div class="event-meta">${item.mentions || 0} mentions &middot; ${esc(sourceLabel)}</div></div>`;
}

function buildEventsSection(acledItems, gdeltItems) {
  const rows = [
    ...acledItems.map((i) => formatEventRow("acled", i)),
    ...gdeltItems.map((i) => formatEventRow("gdelt", i)),
  ];
  if (!rows.length) {
    return '<div class="popup-events"><div class="meta">No recent conflict/news events matched for this area.</div></div>';
  }
  return `<div class="popup-events"><div class="meta">Recent events</div>${rows.join("")}</div>`;
}

export function countryPopupHtml(props, raw) {
  const name = props.name || "Unknown";
  const wanted = normalizeCountryName(name);
  const acledMatches = raw.acled.filter((e) => normalizeCountryName(e.country) === wanted).slice(0, 3);
  const gdeltMatches = raw.gdelt
    .filter((e) => {
      if (!e.location) return false;
      const parts = e.location.split(",");
      return normalizeCountryName(parts[parts.length - 1]) === wanted;
    })
    .slice(0, 3);
  return `
    <h3>${esc(name)}</h3>
    <div class="meta">Population: ${fmtNumber(props.population)}${props.pop_year ? ` (${esc(props.pop_year)})` : ""}</div>
    <div class="meta">Population density: ${props.density != null ? `${props.density} /km&sup2;` : "n/a"}</div>
    <div class="meta">Human Development Index: ${props.hdi != null ? props.hdi.toFixed(3) : "n/a"}</div>
    ${buildEventsSection(acledMatches, gdeltMatches)}
    <p class="meta">Population/density: World Bank. HDI: UNDP (via Our World in Data). Events matched by country name &mdash; naming differences can cause a miss.</p>`;
}

export function cityPopupHtml(city, raw, countryNameByIso2) {
  const countryName = countryNameByIso2[city.country_code] || city.country_code || "";
  const acledMatches = raw.acled
    .filter((e) => typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  const gdeltMatches = raw.gdelt
    .filter((e) => typeof e.lat === "number" && haversineKm(city.lat, city.lon, e.lat, e.lon) <= 50)
    .slice(0, 3);
  return `
    <h3>${esc(city.name)}</h3>
    <div class="meta">${esc(countryName)} &middot; Population: ${fmtNumber(city.population)}</div>
    ${buildEventsSection(acledMatches, gdeltMatches)}
    <p class="meta">Population: GeoNames. Events within 50km, matched by distance.</p>`;
}
