// "Decorators" turn one raw API item (an ACLED event, a ship, a plane, a
// news event) into the trio a Leaflet marker needs: {icon, tooltip, detail}.
// Kept separate from map/renderers.js (which handles *when* to build/update
// a marker) so the "what does this thing look like" logic reads as a flat,
// self-contained reference for each data source.

import { L } from "./leafletGlobal";
import { SVG, buildDivIcon } from "./svgIcons";
import { esc, titleCase } from "../utils/format";

function icon(svgInner, color, size, rotateDeg, extraClass) {
  return buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass);
}

// ---------- ACLED / UCDP conflict events ----------

function acledColor(d) {
  const f = d.fatalities || 0;
  if (f >= 10) return "#ff1a1a";
  if (f >= 1) return "#ff8c3a";
  return "#ffd11a";
}

export function decorateAcled(d) {
  const tooltip = `<b>${esc(d.event_type || "Event")}</b><br/>${esc(d.country || "")} &middot; ${esc(d.date || "")}<br/>Fatalities: ${d.fatalities ?? 0}`;
  const detail = `
    <h3>${esc(d.event_type || "Conflict event")}${d.sub_event_type ? " &mdash; " + esc(d.sub_event_type) : ""}</h3>
    <div class="meta">${esc(d.country || "")} &middot; ${esc(d.date || "")} &middot; Fatalities: ${d.fatalities ?? 0}</div>
    ${d.actor1 ? `<div>Actor 1: ${esc(d.actor1)}</div>` : ""}
    ${d.actor2 ? `<div>Actor 2: ${esc(d.actor2)}</div>` : ""}
    ${d.notes ? `<p>${esc(d.notes)}</p>` : ""}
    <div class="meta">Source: ${d.source === "ucdp" ? "UCDP (GED Candidate)" : "ACLED"}</div>`;
  const size = 14 + Math.min(Math.sqrt(d.fatalities || 0), 8) * 1.6;
  return { icon: icon(SVG.burst, acledColor(d), size), tooltip, detail };
}

// ---------- GDELT news ----------

// GDELT's raw event export has no headline/summary text -- it's structured
// CAMEO-coded data (who did what to whom), and auto-coding that into a
// sentence was frequently wrong ("snow leopard tracking" got coded as
// "fighting"). The backend fetches each article's real <title>/og:title
// instead, which is what's shown when available; this CAMEO sentence is
// only a fallback for when that fetch fails.
const CAMEO_ROOT_VERB = {
  1: "made a public statement about", 2: "appealed to", 3: "expressed intent to cooperate with",
  4: "held consultations with", 5: "engaged in diplomatic cooperation with", 6: "engaged in material cooperation with",
  7: "provided aid to", 8: "yielded to", 9: "was investigated in connection with", 10: "made demands of",
  11: "disapproved of", 12: "rejected", 13: "threatened", 14: "protested against", 15: "exhibited military posture toward",
  16: "reduced relations with", 17: "used coercion against", 18: "assaulted", 19: "engaged in fighting with",
  20: "engaged in mass violence against",
};
const CAMEO_ROOT_LABEL = {
  1: "a public statement", 2: "an appeal", 3: "a show of intent to cooperate", 4: "consultations",
  5: "diplomatic cooperation", 6: "material cooperation", 7: "aid", 8: "a concession", 9: "an investigation",
  10: "a demand", 11: "disapproval", 12: "a rejection", 13: "a threat", 14: "a protest",
  15: "a show of military posture", 16: "reduced relations", 17: "coercion", 18: "an assault",
  19: "fighting", 20: "mass violence",
};

export function gdeltSentence(d) {
  const root = d.event_root_code;
  const a1 = d.actor1 ? titleCase(d.actor1) : "An unidentified party";
  const loc = d.location ? ` in ${d.location}` : "";
  if (d.actor2 && CAMEO_ROOT_VERB[root]) {
    return `${a1} ${CAMEO_ROOT_VERB[root]} ${titleCase(d.actor2)}${loc}.`;
  }
  return `${a1} was involved in ${CAMEO_ROOT_LABEL[root] || "an incident"}${loc}.`;
}

export function decorateGdelt(d) {
  const hasRealTitle = !!(d.real_title && d.real_title.trim());
  const headline = hasRealTitle ? d.real_title.trim() : gdeltSentence(d);
  const agency = d.source_name || null;
  const tooltip = `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${d.mentions || 0} mentions`;
  const sourceNote = hasRealTitle
    ? "Headline is the article's own title."
    : "Real headline unavailable (fetch failed or blocked) -- this line is auto-generated from GDELT's structured event data, treat as a rough gist only.";
  const detail = `
    <p class="news-sentence">${esc(headline)}</p>
    <div class="meta">${esc(d.location || "")} &middot; CAMEO ${esc(d.event_code || "n/a")} &middot; ${d.mentions || 0} mentions</div>
    ${d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    <div class="meta">Source: ${agency ? `${esc(agency)} (via GDELT)` : "GDELT"} &middot; added ${esc(d.date_added || "")}</div>
    <p class="meta">${sourceNote}</p>`;
  const size = 14 + Math.min(Math.log10((d.mentions || 1) + 1), 3) * 2.5;
  return { icon: icon(SVG.news, "#ffd60a", size), tooltip, detail };
}

// ---------- AIS ships ----------

// AIS "Type" (ship type code, from ShipStaticData -- see backend/sources/
// ais.py) is a real classification signal when present: 35 = "Military
// ops". USS/USNS name matching is the fallback for when static data hasn't
// arrived yet for a vessel (or it's a non-US warship AIS doesn't code as
// military ops) -- same "trust the flag over the heuristic" pattern
// classifyAircraft uses for d.military.
const MILITARY_SHIP_TYPE = 35;
const TANKER_SHIP_TYPE_MIN = 80;
const TANKER_SHIP_TYPE_MAX = 89;

export function isNavyVessel(d) {
  if (d.ship_type === MILITARY_SHIP_TYPE) return true;
  return /^(USS|USNS)\b/i.test((d.name || "").trim());
}

function isTanker(d) {
  return typeof d.ship_type === "number" && d.ship_type >= TANKER_SHIP_TYPE_MIN && d.ship_type <= TANKER_SHIP_TYPE_MAX;
}

export function classifyShip(d) {
  if (isNavyVessel(d)) return "navy";
  if (isTanker(d)) return "tanker";
  return "other";
}

// Same {svg,color,size} triples decorateAis picks inline below, pulled out
// so webglLayer.js can build its sprite texture cache from the same source
// of truth instead of re-deriving these values.
export const SHIP_STYLE = {
  navy: { svg: SVG.ship, color: "#ffd60a", size: 26, name: "ship-navy" },
  tanker: { svg: SVG.tanker, color: "#ffb347", size: 20, name: "ship-tanker" },
  other: { svg: SVG.ship, color: "#35c2ff", size: 16, name: "ship-other" },
};

export function decorateAis(d, { selectedMmsi } = {}) {
  const type = classifyShip(d);
  const navy = type === "navy";
  const tanker = type === "tanker";
  const typeLabel = navy ? " &middot; US Navy / MSC" : tanker ? " &middot; Oil/chemical tanker" : "";
  const tooltip = `<b>${esc(d.name || "Unknown vessel")}</b>${typeLabel}<br/>MMSI ${esc(d.mmsi)}<br/>Speed ${esc(d.speed ?? "?")} kn`;
  const detail = `
    <h3>${esc(d.name || "Unknown vessel")}</h3>
    <div class="meta">MMSI ${esc(d.mmsi)}</div>
    <div>Speed: ${esc(d.speed ?? "n/a")} kn &middot; Course: ${esc(d.course ?? "n/a")}&deg;</div>
    <div>Nav status code: ${esc(d.nav_status ?? "n/a")}</div>
    ${navy ? '<p class="meta">Identified as US Navy / Military Sealift Command from its AIS ship-type code (or USS/USNS naming when static data hasn\'t arrived yet). Most warships run AIS off underway for OPSEC -- this only shows vessels that broadcast it.</p>' : ""}
    ${tanker ? '<p class="meta">Identified as an oil/chemical tanker from its AIS ship-type code.</p>' : ""}
    <div class="meta">Source: aisstream.io (AIS)</div>`;
  const heading = Number.isFinite(d.heading) && d.heading !== 511 ? d.heading : d.course;
  let cls = "ship-marker";
  if (navy) cls += " navy-marker";
  if (tanker) cls += " tanker-marker";
  if (d.mmsi === selectedMmsi) cls += " selected";
  const size = navy ? 26 : tanker ? 20 : 16;
  const color = navy ? "#ffd60a" : tanker ? "#ffb347" : "#35c2ff";
  const svg = tanker ? SVG.tanker : SVG.ship;
  return { icon: icon(svg, color, size, heading, cls), tooltip, detail };
}

// ---------- ADS-B aircraft ----------

// Best-effort only: OpenSky has no "military" field. This flags common
// military/government callsign prefixes and otherwise falls back to the
// ADS-B emitter category. Never treat this as confirmed identification.
const MILITARY_CALLSIGN_PREFIXES = [
  "RCH", "CNV", "NATO", "HKY", "ASCOT", "IAM", "GAF", "DUKE", "TARTAN",
  "FORTE", "VIVI", "REACH", "KNIFE", "VADER", "POLAR", "FALCON", "VULCAN",
  "SLAM", "SPAR", "COBRA", "TITAN", "USAF", "NAVY", "MARINE", "ARMY",
];

export function classifyAircraft(d) {
  // d.military is a real flag (airplanes.live's dbFlags) when present --
  // trust it over the callsign heuristic below, which only exists because
  // OpenSky alone has no such field.
  if (d.military === true) return "military";
  const cs = (d.callsign || "").trim().toUpperCase();
  if (cs && MILITARY_CALLSIGN_PREFIXES.some((p) => cs.startsWith(p))) return "military";
  if (d.category === 8) return "helicopter";
  if ([2, 3, 9, 10, 12].includes(d.category)) return "other";
  if ([4, 5, 6, 7].includes(d.category)) return "commercial";
  if (/^[A-Z]{2,3}\d{2,4}[A-Z]?$/.test(cs)) return "commercial"; // airline-style callsign
  return "other";
}

// Exported so webglLayer.js's sprite texture cache draws from the same
// source of truth decorateAdsb below uses for its divIcon.
export const AIRCRAFT_STYLE = {
  military: { svg: SVG.planeMilitary, color: "#ff4d4d", size: 28, label: "Military", name: "plane-military" },
  helicopter: { svg: SVG.helicopter, color: "#9be15d", size: 18, label: "Helicopter", name: "plane-helicopter" },
  commercial: { svg: SVG.planeCommercial, color: "#d8b9ff", size: 16, label: "Commercial / airline", name: "plane-commercial" },
  other: { svg: SVG.planeOther, color: "#8aa0ad", size: 13, label: "General aviation / other", name: "plane-other" },
};

const MILITARY_ROLE_LABEL = {
  tanker: "Aerial refueling tanker",
  bomber: "Bomber",
  fighter: "Fighter jet",
  awacs: "AWACS / airborne early warning",
  recon: "Reconnaissance",
  patrol: "Maritime patrol",
  drone: "Unmanned / drone",
  transport: "Transport",
  helicopter: "Military helicopter",
};

export function decorateAdsb(d, { selectedIcao } = {}) {
  const type = classifyAircraft(d);
  const style = AIRCRAFT_STYLE[type];
  const label = type === "military" ? (d.military === true ? "Military (confirmed)" : "Military (heuristic)") : style.label;
  // airplanes.live supplies a real type/description for aircraft it has
  // reference data for -- OpenSky has no such field at all, so this is
  // only ever present some of the time (see backend/sources/adsb.py).
  const hasRealType = !!(d.type_desc && d.type_desc.trim());
  const roleLabel = d.military_role ? MILITARY_ROLE_LABEL[d.military_role] : null;
  const aircraftLine = hasRealType ? `${d.type_desc}${roleLabel ? ` (${roleLabel})` : ""}` : null;
  const tooltip = `<b>${esc(d.callsign || d.icao24)}</b>${aircraftLine ? ` &middot; ${esc(aircraftLine)}` : ` &middot; ${esc(label)}`}<br/>${esc(d.origin_country || "")}<br/>Alt ${esc(Math.round(d.altitude || 0))} m &middot; ${esc(Math.round((d.velocity || 0) * 3.6))} km/h`;
  const detail = `
    <h3>${esc(d.callsign || d.icao24)}</h3>
    ${aircraftLine ? `<div class="meta">Aircraft: ${esc(aircraftLine)}</div>` : ""}
    <div class="meta">Type: ${esc(label)} &middot; ${esc(d.origin_country || "")} &middot; ICAO24 ${esc(d.icao24)}</div>
    ${d.registration ? `<div>Registration: ${esc(d.registration)}</div>` : ""}
    ${d.operator ? `<div>Operator: ${esc(d.operator)}</div>` : ""}
    <div>Altitude: ${esc(Math.round(d.altitude || 0))} m</div>
    <div>Ground speed: ${esc(Math.round((d.velocity || 0) * 3.6))} km/h</div>
    <div>On ground: ${d.on_ground ? "yes" : "no"}</div>
    ${hasRealType
      ? '<p class="meta">Aircraft type/description from airplanes.live reference data.</p>'
      : '<p class="meta">Aircraft type is a best-effort guess from callsign pattern and ADS-B category when no confirmed source flag is available.</p>'}
    <div class="meta">Source: OpenSky Network + airplanes.live (ADS-B)</div>`;
  let cls = "aircraft-marker";
  if (type === "military") cls += " military-marker";
  if (d.icao24 === selectedIcao) cls += " selected";
  return { icon: icon(style.svg, style.color, style.size, d.heading, cls), tooltip, detail };
}

// ---------- critical infrastructure ----------

const INFRA_STYLE = {
  refinery: { svg: SVG.refinery, color: "#ff9500", label: "Refinery" },
  pipeline: { svg: SVG.pipeline, color: "#ffb347", label: "Pipeline" },
  desalination: { svg: SVG.desalination, color: "#35c2ff", label: "Desalination plant" },
  lng_terminal: { svg: SVG.lng, color: "#9be15d", label: "LNG terminal" },
  nuclear: { svg: SVG.nuclear, color: "#ffd60a", label: "Nuclear power plant" },
  port: { svg: SVG.port, color: "#d8b9ff", label: "Port / oil terminal" },
  fab: { svg: SVG.fab, color: "#6fe3ff", label: "Semiconductor fab" },
};

// Military bases share the "infra" data shape/toggle but pick their icon
// from `subtype` (air/naval/army/missile/joint/logistics/radar) instead of
// `type` -- see backend/infrastructure.py's MILITARY_BASES.
const MILITARY_SUBTYPE_STYLE = {
  air: { svg: SVG.planeMilitary, color: "#ff4d4d", label: "Air base" },
  naval: { svg: SVG.ship, color: "#ffd60a", label: "Naval base" },
  army: { svg: SVG.armyBase, color: "#9be15d", label: "Army base" },
  missile: { svg: SVG.missileBase, color: "#ff8c3a", label: "Missile / space base" },
  joint: { svg: SVG.jointBase, color: "#d8b9ff", label: "Joint base" },
  logistics: { svg: SVG.logisticsBase, color: "#8aa0ad", label: "Logistics base" },
  radar: { svg: SVG.radarBase, color: "#6fe3ff", label: "Radar / early-warning site" },
};

export function decorateInfra(d, { hot, nearbyEvents } = {}) {
  const style = d.type === "military"
    ? MILITARY_SUBTYPE_STYLE[d.subtype] || MILITARY_SUBTYPE_STYLE.joint
    : INFRA_STYLE[d.type] || INFRA_STYLE.port;
  const tooltip = `<b>${esc(d.name)}</b><br/>${esc(style.label)}${hot ? " &middot; HOT ZONE" : ""}`;
  const events = nearbyEvents || [];
  const activitySection = hot
    ? `<div class="popup-events"><div class="meta">Recent activity within 75km</div>${events
        .map((e) => `<div class="event-row">${esc(e.headline)}<div class="event-meta">${esc(e.source)}</div></div>`)
        .join("")}</div>`
    : "";
  const detail = `
    <h3>${esc(d.name)}${hot ? ' <span class="infra-hot-badge">HOT ZONE</span>' : ""}</h3>
    <div class="meta">${esc(style.label)}</div>
    ${d.note ? `<p>${esc(d.note)}</p>` : ""}
    ${activitySection}
    <p class="meta">Source: publicly documented location (open-source reference), approximate.</p>`;
  const cls = `infra-marker${hot ? " infra-hot" : ""}`;
  return { icon: icon(style.svg, style.color, 18, 0, cls), tooltip, detail };
}

// ---------- satellites ----------

const SATELLITE_GROUP_LABEL = {
  stations: "Space station",
  military: "Military satellite",
};

export function decorateSatellite(d) {
  const groupLabel = SATELLITE_GROUP_LABEL[d.group] || "Satellite";
  const tooltip = `<b>${esc(d.name || `NORAD ${d.norad_id}`)}</b><br/>${esc(groupLabel)} &middot; ${Math.round(d.alt_km || 0)} km`;
  const detail = `
    <h3>${esc(d.name || `NORAD ${d.norad_id}`)}</h3>
    <div class="meta">${esc(groupLabel)} &middot; NORAD catalog ID ${esc(d.norad_id)}</div>
    <div>Altitude: ${Math.round(d.alt_km || 0)} km</div>
    <p class="meta">Position computed from CelesTrak's public orbital elements via SGP4 propagation -- a real orbit, not a live telemetry confirmation.</p>
    <div class="meta">Source: CelesTrak (NORAD GP data)</div>`;
  return { icon: icon(SVG.satellite, "#6fe3ff", 24, 0, "satellite-marker"), tooltip, detail };
}
