// "Decorators" turn one raw API item (an ACLED event, a ship, a plane, a
// news event) into the trio a Leaflet marker needs: {icon, tooltip, detail}.
// Kept separate from map/renderers.js (which handles *when* to build/update
// a marker) so the "what does this thing look like" logic reads as a flat,
// self-contained reference for each data source.

import { L } from "./leafletGlobal";
import { SVG, buildDivIcon } from "./svgIcons";
import { esc, timeAgoFromDateAdded } from "../utils/format";

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

// ACLED's own 6 top-level event_type categories, plus the UCDP violence-type
// labels (see acled.py's UCDP_VIOLENCE_TYPE) and event_fusion.py's local
// classifier -- all three sources land in this one shared taxonomy, so one
// lookup covers every item this glyph function will ever see. Matched by
// substring (lowercased) rather than exact string since UCDP/event_fusion
// labels ("State-based armed conflict") don't spell ACLED's own wording.
const ACLED_EVENT_ICON = [
  [/battle/i, SVG.battle],
  [/explosion|remote violence/i, SVG.explosion],
  [/violence against civilians|one-sided/i, SVG.violenceCivilians],
  [/riot/i, SVG.riot],
  [/protest/i, SVG.protest],
  [/strategic development/i, SVG.strategicDevelopment],
  [/state-based|non-state/i, SVG.battle],
];

function acledIcon(d) {
  const label = `${d.event_type || ""} ${d.sub_event_type || ""}`;
  for (const [re, svg] of ACLED_EVENT_ICON) {
    if (re.test(label)) return svg;
  }
  return SVG.burst;
}

// ---------- fused conflict/violence events (ACLED + UCDP + GDELT) ----------
//
// backend/sources/event_fusion.py collapses same real-world incidents
// reported by more than one of ACLED, UCDP, and GDELT's structured conflict
// events into ONE canonical record before this ever reaches the map --
// `corroborated_by` lists every source that independently reported it. This
// replaces the old decorateAcled/decorateConflictWatch pair, which used to
// render the same UCDP row (and the same GDELT headline) as two separate pins.

const SOURCE_LABEL = {
  acled: "ACLED", ucdp: "UCDP (GED Candidate)", gdelt: "GDELT (structured conflict event)",
};

// Goldstein is CAMEO's own -10 (max conflictual) .. +10 (max cooperative)
// intensity scale for the underlying action -- only ever present on a
// GDELT-sourced record (see event_fusion.py's _normalize_gdelt). A rough
// plain-language read is more useful in a popup than the bare number.
function goldsteinLabel(score) {
  if (score == null) return null;
  if (score <= -7) return "severe conflict intensity";
  if (score <= -3) return "significant conflict intensity";
  if (score < 0) return "mild conflict intensity";
  return "low conflict intensity"; // 0..+10 still reached this classifier (quad_class 3/4), so never reads as "cooperative"
}

// Severity (0-100, computed server-side in event_fusion.py's _severity_for)
// drives both size and colour, so a corroborated mass-casualty event is
// unmistakably louder than a single-source skirmish. It supersedes the old
// fatalities-only sizing, which rendered every GDELT event identically --
// GDELT never reports casualties, so that was most of the layer.
function severityBand(severity) {
  if (severity >= 75) return { label: "Critical", color: "#ff1a1a" };
  if (severity >= 55) return { label: "High", color: "#ff5c2a" };
  if (severity >= 40) return { label: "Moderate", color: "#ff9500" };
  return { label: "Low", color: "#ffd11a" };
}

export function decorateEvent(d) {
  const sources = (d.corroborated_by && d.corroborated_by.length ? d.corroborated_by : [d.source]).filter(Boolean);
  const sourceLine = sources.map((s) => SOURCE_LABEL[s] || s).join(", ");
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  const band = severityBand(severity);
  const tooltip = `<b>${esc(d.event_type || "Event")}</b> &middot; ${esc(band.label)}<br/>${esc(d.country || d.notes || "")}${d.date ? " &middot; " + esc(d.date) : ""}<br/>Fatalities: ${d.fatalities ?? 0}`;
  const intensity = goldsteinLabel(d.goldstein);
  // event_fusion's classifier assigns the same label to both fields for
  // GDELT-derived events, so only show the subtype when it adds something.
  const subtype = d.sub_event_type && d.sub_event_type !== d.event_type ? d.sub_event_type : null;
  const detail = `
    <h3>${esc(d.event_type || "Conflict event")}${subtype ? " &mdash; " + esc(subtype) : ""}</h3>
    <div class="meta">${esc(d.country || "")} &middot; ${esc(d.date || "")} &middot; Fatalities: ${d.fatalities ?? 0}</div>
    <div class="meta">Severity: ${severity}/100 (${esc(band.label)})</div>
    ${d.actor1 ? `<div>Actor 1: ${esc(d.actor1)}</div>` : ""}
    ${d.actor2 ? `<div>Actor 2: ${esc(d.actor2)}</div>` : ""}
    ${d.notes ? `<p>${esc(d.notes)}</p>` : `<p class="meta">No scraped headline for this incident yet -- shown from CAMEO actor/location data only.</p>`}
    ${d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    ${d.mentions ? `<div class="meta">Reported by ${d.mentions} GDELT mention${d.mentions === 1 ? "" : "s"}</div>` : ""}
    ${intensity ? `<div class="meta">Goldstein intensity: ${esc(intensity)} (${d.goldstein})</div>` : ""}
    <div class="meta">Source: ${esc(sourceLine)}${d.corroborated ? ` &middot; corroborated by ${sources.length} independent sources` : ""}</div>`;
  // 13px at severity 0 up to ~31px at 100 -- a visible hierarchy at a glance
  // without the largest pins swallowing their neighbours.
  const size = 13 + (severity / 100) * 18;
  // Corroboration keeps its distinct blue: "confirmed by a second source" is
  // a different axis from "how bad", and both are worth seeing at once.
  const color = d.corroborated ? "#3ac1ff" : band.color;
  return { icon: icon(acledIcon(d), color, size), tooltip, detail };
}

// ---------- GDELT news ----------

// The backend (backend/app.py's /api/news) only ever serves items with a
// real scraped article <title>/og:title -- title-less CAMEO-only candidates
// are filtered out before they reach the frontend. `|| ""` is a defensive
// guard, not an expected path: an empty headline here means that
// server-side guarantee was somehow violated (e.g. a stale cached
// response), and a blank line is a far better failure mode than crashing
// the whole map.
export function decorateGdelt(d) {
  const headline = (d.real_title || "").trim();
  const agency = d.source_name || null;
  const when = timeAgoFromDateAdded(d.date_added);
  const corroboratedNote = d.corroborated
    ? ` &middot; corroborated by ${esc((d.corroborated_by || []).join(", "))}`
    : "";
  const tooltip = `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${esc(when)}`;
  const detail = `
    <p class="news-sentence">${esc(headline)}</p>
    ${d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    <div class="meta">Source: ${agency ? esc(agency) : "GDELT"} &middot; ${esc(when)}${corroboratedNote}</div>`;
  const size = 14 + Math.min(Math.log10((d.mentions || 1) + 1), 3) * 2.5;
  const color = d.corroborated ? "#3ac1ff" : "#ffd60a";
  return { icon: icon(SVG.news, color, size), tooltip, detail };
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

// Per-role military glyphs -- military_role (see MILITARY_ROLE_LABEL above,
// backend/sources/adsb.py's own role heuristic) picks a distinct silhouette
// instead of every military aircraft sharing one generic plane icon.
// AIRCRAFT_STYLE.military (SVG.planeMilitary) stays the fallback for
// d.military===true/heuristic hits with no role guessed.
export const MILITARY_ROLE_STYLE = {
  fighter: { svg: SVG.planeMilitary, color: "#ff4d4d", size: 28, name: "plane-military-fighter" },
  bomber: { svg: SVG.planeBomber, color: "#ff4d4d", size: 30, name: "plane-military-bomber" },
  tanker: { svg: SVG.planeTanker, color: "#ff8c3a", size: 26, name: "plane-military-tanker" },
  awacs: { svg: SVG.planeAwacs, color: "#ffd60a", size: 28, name: "plane-military-awacs" },
  recon: { svg: SVG.planeRecon, color: "#d8b9ff", size: 24, name: "plane-military-recon" },
  patrol: { svg: SVG.planePatrol, color: "#6fe3ff", size: 26, name: "plane-military-patrol" },
  drone: { svg: SVG.planeDrone, color: "#9be15d", size: 18, name: "plane-military-drone" },
  transport: { svg: SVG.planeTransport, color: "#8aa0ad", size: 26, name: "plane-military-transport" },
  helicopter: { svg: SVG.helicopter, color: "#ff4d4d", size: 20, name: "plane-military-helicopter" },
};

export function decorateAdsb(d, { selectedIcao } = {}) {
  const type = classifyAircraft(d);
  const style = (type === "military" && d.military_role && MILITARY_ROLE_STYLE[d.military_role]) || AIRCRAFT_STYLE[type];
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
  air: { svg: SVG.airBase, color: "#ff4d4d", label: "Air base" },
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
