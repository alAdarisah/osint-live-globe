// "Decorators" turn one raw API item (an ACLED event, a ship, a plane, a
// news event) into the trio a Leaflet marker needs: {icon, tooltip, detail}.
// Kept separate from map/renderers.js (which handles *when* to build/update
// a marker) so the "what does this thing look like" logic reads as a flat,
// self-contained reference for each data source.

import { L } from "./leafletGlobal";
import { SVG, OFFICIALS_KIND_ICON, buildDivIcon } from "./svgIcons";
import { esc, timeAgoFromDateAdded } from "../utils/format";
import {
  severityBand, CORROBORATED_COLOR, isImprecise, PRECISION_NOTE, ageHours, ageOpacity,
  ageHoursFromDateAdded, newsAgeOpacity, newsAgeScale,
} from "./severity";

function icon(svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset) {
  return buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset);
}

// Icon sizes are needed twice: here, to draw the glyph, and in
// createMapController's placement pass, which has to know how much room each
// item takes before any of them are drawn. Exported so there is one formula
// rather than a copy that can drift.
//
// 13px at severity 0 up to ~31px at 100 -- a visible hierarchy at a glance
// without the largest pins swallowing their neighbours. Imprecise events are
// drawn smaller as well as ringed: they should not compete for attention with
// events we can actually place.
export function eventIconSize(d) {
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  return (13 + (severity / 100) * 18) * (isImprecise(d) ? 0.8 : 1);
}

// Sized by deaths, since UCDP always reports them -- but capped well below the
// live layer's largest pins so the record never dominates the map.
export function historicalIconSize(d) {
  return 10 + Math.min(Math.sqrt(d.fatalities || 0) * 2.2, 8);
}

// Reach sets the base size; age shrinks it. Rounded to whole pixels for the
// same reason opacity is quantised -- the number goes into the icon's HTML
// string, which updateMarker compares to decide whether to rebuild the DOM.
// A collapsed pin (see collapse.js) is drawn a little larger, because it now
// stands for several stories and has to carry a count badge.
export function gdeltIconSize(d) {
  const base = 14 + Math.min(Math.log10((d.mentions || 1) + 1), 3) * 2.5;
  const scaled = base * newsAgeScale(ageHoursFromDateAdded(d.date_added));
  return Math.round(d.collapsedCount > 1 ? scaled + 4 : scaled);
}

// Officials pins are sized by how widely the act was carried, not by severity:
// this layer has no severity scale, and "how many newsrooms picked this up" is
// the closest available read on whether a statement mattered. A government's
// own release has no outlet count by construction and sits at the base size.
export function officialsIconSize(d) {
  const base = 15 + Math.min(Math.log10((d.outlet_count || 0) + 1), 2) * 3.5;
  return Math.round(base * newsAgeScale(officialsAgeHours(d)));
}

export const INFRA_ICON_SIZE = 18;

// ---------- cities ----------

// Graduated symbols: population picks both the glyph and its size, so a
// megacity and a 100k town are no longer the same anonymous dot. Thresholds
// are the round numbers a reader already thinks in, and they split the ~6,200
// cities we carry into usefully unequal bands (roughly 60 / 500 / 1,200 /
// 3,800 at the time of writing) -- the rarest tier is the one that should
// stand out. Ordered largest-first; cityTier() takes the first match.
export const CITY_COLOR = "#ff6fb5";
export const CITY_TIERS = [
  { key: "mega", min: 5_000_000, label: "Megacity (5M+)", svg: SVG.city, size: 18 },
  { key: "large", min: 1_000_000, label: "Large city (1M-5M)", svg: SVG.cityLarge, size: 14 },
  { key: "medium", min: 250_000, label: "City (250k-1M)", svg: SVG.cityMedium, size: 11 },
  { key: "town", min: 0, label: "Town (100k-250k)", svg: SVG.cityTown, size: 8 },
];

// Highest for the largest tier. Used as a placement priority, so a megacity
// keeps its true position and the towns around it are the ones that yield.
export function cityTierRank(tier) {
  return CITY_TIERS.length - 1 - CITY_TIERS.indexOf(tier);
}

export function cityTier(population) {
  const pop = Number.isFinite(population) ? population : 0;
  return CITY_TIERS.find((t) => pop >= t.min) || CITY_TIERS[CITY_TIERS.length - 1];
}

export function decorateCity(city, { offset } = {}) {
  const tier = cityTier(city.population);
  return { tier, size: tier.size, icon: icon(tier.svg, CITY_COLOR, tier.size, 0, "city-marker", 1, "", offset) };
}

// ---------- ACLED / UCDP conflict events ----------

// ACLED's own 6 top-level event_type categories, plus the UCDP violence-type
// labels (see acled.py's UCDP_VIOLENCE_TYPE) and event_fusion.py's local
// classifier -- all three sources land in this one shared taxonomy, so one
// lookup covers every item this glyph function will ever see. Matched by
// substring (lowercased) rather than exact string since UCDP/event_fusion
// labels ("State-based armed conflict") don't spell ACLED's own wording.
// Order matters: the first match wins, so the specific CAMEO labels
// event_fusion now emits ("Aerial bombardment", "Mass killing") are listed
// ahead of the broader taxonomy words they contain.
const ACLED_EVENT_ICON = [
  [/drone|uav|unmanned/i, SVG.droneStrike],
  [/aerial bombardment|air ?strike|air raid/i, SVG.airstrike],
  [/artillery|armou?r|shelling|mortar|rocket/i, SVG.artillery],
  [/small-?arms|shooting|firefight|gun ?battle/i, SVG.smallArms],
  [/bombing|\bied\b|explosion|remote violence|weapons of mass destruction/i, SVG.blast],
  [/abduction|hostage|kidnap/i, SVG.abduction],
  [/blockade|siege/i, SVG.siege],
  [/occupation|territor/i, SVG.occupation],
  [/mass killing|ethnic cleansing|mass expulsion|mass violence/i, SVG.civilianHarm],
  [/violence against civilians|one-sided|assassination|killing|assault|torture/i, SVG.civilianHarm],
  [/riot/i, SVG.riot],
  [/protest|demonstration/i, SVG.protest],
  [/battle|conventional force|fighting|ceasefire|state-based|non-state|clash/i, SVG.clash],
  [/strategic development/i, SVG.occupation],
];

function acledIcon(d) {
  const label = `${d.event_type || ""} ${d.sub_event_type || ""}`;
  for (const [re, svg] of ACLED_EVENT_ICON) {
    if (re.test(label)) return svg;
  }
  // Not a catch-all star: CAMEO's own 180 is "unconventional violence,
  // unspecified", and everything that lands here is genuinely "violent, kind
  // unknown". A hazard mark says that; a weapon glyph would be a guess.
  return SVG.unknownViolence;
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

// How the two axes of corroboration read in prose. `multi_dataset` means two
// independent datasets recorded the same incident; `multi_outlet` means one
// dataset but several independent newsrooms. Collapsing them into a single
// "corroborated by N sources" line (the old copy) conflated a count of
// datasets with a count of outlets and could read "by 1 independent sources".
function corroborationLine(d, sources) {
  const outlets = d.outlet_count || 0;
  const outletText = outlets > 1 ? `${outlets} independent outlets` : null;
  if (d.corroboration === "multi_dataset") {
    const datasets = `${sources.length} independent datasets`;
    return outletText ? `Corroborated by ${datasets}, and carried by ${outletText}` : `Corroborated by ${datasets}`;
  }
  if (d.corroboration === "multi_outlet") return `Carried by ${outletText}`;
  return outlets === 1 ? "Reported by a single outlet — uncorroborated" : "Uncorroborated";
}

// Which outlets, as opposed to how many. corroborationLine above owns the
// count; this line answers the question that count immediately raises, and
// which the popup used to leave unanswered for almost every event -- the old
// copy could only name outlets on the allowlist (verified_outlets), so a story
// carried by nine regional newsrooms listed none of them.
//
// The backend already caps and ranks the list (mastheads first -- see
// backend/sources/outlets.py), so this only decides how many of them fit.
// `outlets` is absent on records archived before it shipped, hence the
// verified_outlets fallback: an old record replayed on the timeline still names
// whatever it knew.
const OUTLETS_SHOWN = 6;

function outletLine(d) {
  const names = (d.outlets && d.outlets.length ? d.outlets : d.verified_outlets) || [];
  if (!names.length) return "";
  const shown = names.slice(0, OUTLETS_SHOWN);
  // Against the true total, not against the capped list -- "+31 more" is the
  // honest gap between what is listed and what outlet_count already claims.
  const more = Math.max((d.outlet_count || 0) - shown.length, 0);
  return `<div class="meta outlets">Outlets: ${esc(shown.join(", "))}${more ? ` <span class="outlets-more">+${more} more</span>` : ""}</div>`;
}

// Casualties. The distinction between "reported as none" and "nobody counted"
// is the whole point: GDELT never publishes a death toll, so a 0 on a
// GDELT-derived pin was an assertion the data does not support, and it was
// being printed on every one of them.
function casualtyLine(d) {
  if (d.fatalities_reported === false) return "Casualties: not reported by this source";
  const n = d.fatalities ?? 0;
  if (n === 0) return "Casualties: none reported";
  return `Casualties: ${n} killed`;
}

// What kind of record this is and how much of it is inference. Blunt on
// purpose: the summary sentence above it reads fluently, which is exactly why
// the reader needs telling that a machine assembled it out of two actor codes
// and an event code.
function provenanceFor(d) {
  if (d.source === "acled") return "Coded by ACLED from local and international reporting, and reviewed before release.";
  if (d.source === "ucdp") return "Peer-reviewed record from UCDP's Georeferenced Event Dataset.";
  if (d.source !== "gdelt") return null;
  // "a single news article" would contradict the corroboration line directly
  // above it when several outlets carried the story, so the wording follows the
  // outlet count rather than being fixed.
  const many = (d.outlet_count || 0) > 1;
  return `Machine-coded by GDELT from ${many ? "news reporting" : "a single news article"}. The actors and the action are inferred from ${
    many ? "that reporting's" : "that article's"
  } wording, not taken from a verified report; the location is where ${many ? "it is" : "the article says it"} said to have happened.`;
}

// The headlines this incident was reported under -- see event_fusion's
// _coverage_for. These used to be *deleted*: the backend dropped any news item
// it had folded into a conflict pin, so the article vanished from the news feed
// without ever appearing on the pin that absorbed it. The pin owns them now,
// which is what makes suppressing the duplicate marker honest.
const COVERAGE_SHOWN = 4;

function coverageBlock(d) {
  const items = d.coverage || [];
  if (!items.length) return "";
  const rows = items.slice(0, COVERAGE_SHOWN).map((c) => {
    const when = timeAgoFromDateAdded(c.published);
    const meta = [c.outlet, when].filter(Boolean).map(esc).join(" &middot; ");
    const title = esc(c.title || "");
    const link = c.url
      ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
      : title;
    return `<li>${link}${meta ? `<span class="coverage-meta">${meta}</span>` : ""}</li>`;
  }).join("");
  const more = items.length - Math.min(items.length, COVERAGE_SHOWN);
  return `
    <div class="coverage-block">
      <div class="coverage-head">Coverage</div>
      <ul class="coverage-list">${rows}</ul>
      ${more > 0 ? `<div class="meta">+${more} more ${more === 1 ? "report" : "reports"}</div>` : ""}
    </div>`;
}

export function decorateEvent(d, { offset } = {}) {
  const sources = (d.corroborated_by && d.corroborated_by.length ? d.corroborated_by : [d.source]).filter(Boolean);
  const sourceLine = sources.map((s) => SOURCE_LABEL[s] || s).join(", ");
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  const band = severityBand(severity);
  const imprecise = isImprecise(d);
  const where = d.location || d.country || "";
  const kind = d.event_type || "Conflict event";
  // The lead is whatever actually says what happened: a real scraped headline
  // first, then the sentence built from the coded fields, and only then the
  // bare taxonomy label -- which is where this used to start, and which on its
  // own ("Unconventional violence") tells a reader nothing.
  const lead = (d.notes || "").trim() || (d.summary || "").trim() || kind;
  const tooltip = `<b>${esc(kind)}</b> &middot; ${esc(band.label)}<br/>${esc(where)}${d.date ? " &middot; " + esc(d.date) : ""}` +
    `${imprecise ? '<br/><i>approximate location</i>' : ""}<br/>${esc(casualtyLine(d))}`;
  const intensity = goldsteinLabel(d.goldstein);
  // event_fusion's classifier assigns the same label to both fields for
  // GDELT-derived events, so only show the subtype when it adds something.
  const subtype = d.sub_event_type && d.sub_event_type !== d.event_type ? d.sub_event_type : null;
  const reasons = (d.severity_reasons || []).slice(0, 4);
  const provenance = provenanceFor(d);
  const detail = `
    <h3>${esc(lead)}</h3>
    <div class="meta">${esc(kind)}${subtype ? " &mdash; " + esc(subtype) : ""} &middot; ${esc(where)}${d.date ? " &middot; " + esc(d.date) : ""}</div>
    <div class="meta">${esc(casualtyLine(d))}</div>
    ${imprecise ? `<div class="meta imprecise-note">${esc(PRECISION_NOTE[d.geo_precision] || PRECISION_NOTE.unknown)}</div>` : ""}
    <div class="sev-block">
      <div class="sev-head">How much to trust this</div>
      <div class="sev-bar"><span style="width:${Math.max(2, severity)}%;background:${band.color}"></span></div>
      <div class="meta">Severity ${severity}/100 &mdash; ${esc(band.label)}</div>
      <div class="meta">${esc(corroborationLine(d, sources))}</div>
      ${reasons.length ? `<ul class="sev-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${outletLine(d)}
      ${d.jamming_nearby ? `<div class="meta evidence">GPS interference detected within 60 km (${Math.round(d.jamming_nearby * 100)}% bad fixes)</div>` : ""}
      ${d.thermal_nearby ? `<div class="meta evidence">Thermal anomaly detected within 10 km the same day</div>` : ""}
    </div>
    ${coverageBlock(d)}
    ${!d.coverage?.length && d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    ${!d.notes && d.summary ? '<p class="meta">Sentence above is assembled from the event’s coded fields, not quoted from an article.</p>' : ""}
    ${provenance ? `<p class="meta">${esc(provenance)}</p>` : ""}
    ${intensity ? `<div class="meta" title="CAMEO Goldstein scale, ${d.goldstein}">Coded intensity: ${esc(intensity)}</div>` : ""}
    <div class="meta">Source: ${esc(sourceLine)}</div>`;
  const size = eventIconSize(d);
  // Corroboration keeps its distinct blue: "confirmed by a second source" is
  // a different axis from "how bad", and both are worth seeing at once.
  const color = d.corroborated ? CORROBORATED_COLOR : band.color;
  // Older events fade rather than disappear, so "what is happening now" is
  // legible without hiding context.
  const opacity = ageOpacity(ageHours(d));
  return {
    icon: icon(acledIcon(d), color, size, 0, "", opacity, imprecise ? "imprecise" : "", offset),
    tooltip,
    detail,
  };
}

// ---------- UCDP verified historical record ----------
//
// A separate decorator rather than a flag on decorateEvent, because this data
// answers a different question. UCDP's GED Candidate file is reviewed rather
// than scraped, which makes it the most trustworthy conflict data available
// without a paid key -- and it lags real time by a month or more, which makes
// it the most misleading thing on the map if it is drawn like a live pin.
//
// So: hollow, desaturated, and every popup states the cut-off date. The layer
// is off by default (see layers.js) and its own toggle says so too.
const HISTORY_COLOR = "#8f9bb3";

export function decorateHistoricalEvent(d, { offset } = {}) {
  const asOf = d.as_of ? `Dataset current to ${d.as_of}` : "Historical record";
  const lag = Number.isFinite(d.lag_days) ? ` (${d.lag_days} days behind today)` : "";
  const tooltip = `<b>${esc(d.event_type || "Recorded event")}</b> &middot; verified record<br/>` +
    `${esc(d.country || "")}${d.date ? " &middot; " + esc(d.date) : ""}<br/>Deaths: ${d.fatalities ?? 0}`;
  const detail = `
    <h3>${esc(d.event_type || "Recorded event")}</h3>
    <div class="meta">${esc(d.country || "")} &middot; ${esc(d.date || "")} &middot; Deaths: ${d.fatalities ?? 0}</div>
    <div class="meta history-note">${esc(asOf)}${esc(lag)} &mdash; reviewed record, not a live report.</div>
    ${d.sub_event_type ? `<div>Conflict: ${esc(d.sub_event_type)}</div>` : ""}
    ${d.actor1 ? `<div>Side A: ${esc(d.actor1)}</div>` : ""}
    ${d.actor2 ? `<div>Side B: ${esc(d.actor2)}</div>` : ""}
    ${d.notes ? `<p>${esc(d.notes)}</p>` : ""}
    <div class="meta">Source: UCDP GED Candidate</div>`;
  return {
    icon: icon(SVG.recordMark, HISTORY_COLOR, historicalIconSize(d), 0, "", 0.75, "historical", offset),
    tooltip,
    detail,
  };
}

// ---------- GDELT news ----------

// The backend (backend/app.py's /api/news) only ever serves items with a
// real scraped article <title>/og:title -- title-less CAMEO-only candidates
// are filtered out before they reach the frontend. `|| ""` is a defensive
// guard, not an expected path: an empty headline here means that
// server-side guarantee was somehow violated (e.g. a stale cached
// response), and a blank line is a far better failure mode than crashing
// the whole map.
function newsLine(item) {
  const headline = esc((item.real_title || "").trim());
  const meta = [item.source_name, timeAgoFromDateAdded(item.date_added)]
    .filter(Boolean).map(esc).join(" &middot; ");
  const link = item.source_url
    ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">${headline}</a>`
    : headline;
  return `<li>${link}${meta ? `<span class="coverage-meta">${meta}</span>` : ""}</li>`;
}

// How many headlines a collapsed pin lists before it stops. Higher than the
// conflict popup's COVERAGE_SHOWN because these are genuinely different
// stories rather than repeat coverage of one, so truncating loses more.
const COLLAPSED_SHOWN = 8;

export function decorateGdelt(d, { offset } = {}) {
  const headline = (d.real_title || "").trim();
  const agency = d.source_name || null;
  const when = timeAgoFromDateAdded(d.date_added);
  const corroboratedNote = d.corroborated
    ? ` &middot; corroborated by ${esc((d.corroborated_by || []).join(", "))}`
    : "";
  // Set by collapse.js when several stories share a spot on screen -- see the
  // note there on why the news layer clusters and nothing else does.
  const collapsed = d.collapsed || null;
  const extra = collapsed ? collapsed.length - 1 : 0;

  const tooltip = collapsed
    ? `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${esc(when)}` +
      `<br/><i>+${extra} more ${extra === 1 ? "story" : "stories"} here</i>`
    : `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${esc(when)}`;

  const detail = collapsed
    ? `
    <div class="coverage-head">${collapsed.length} stories at this location</div>
    <ul class="coverage-list">${collapsed.slice(0, COLLAPSED_SHOWN).map(newsLine).join("")}</ul>
    ${collapsed.length > COLLAPSED_SHOWN
        ? `<div class="meta">+${collapsed.length - COLLAPSED_SHOWN} more &mdash; zoom in to separate them</div>`
        : '<div class="meta">Zoom in to see these as separate pins.</div>'}`
    : `
    <p class="news-sentence">${esc(headline)}</p>
    ${d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    <div class="meta">Source: ${agency ? esc(agency) : "GDELT"} &middot; ${esc(when)}${corroboratedNote}</div>`;

  const color = d.corroborated ? "#3ac1ff" : "#ffd60a";
  // News pins used to be drawn at a flat opacity of 1 regardless of age, which
  // was tolerable over a two-hour window and is not over twenty-four: without
  // this, a story from yesterday morning is as loud as one from ten minutes
  // ago and the map stops saying anything about what is happening now.
  const hours = ageHoursFromDateAdded(d.date_added);
  return {
    icon: icon(SVG.news, color, gdeltIconSize(d), 0, "", newsAgeOpacity(hours), "", offset, d.collapsedCount),
    tooltip,
    detail,
  };
}

// ---------- Officials & Diplomacy ----------
//
// Statements, meetings, state visits, demands and threats by heads of state,
// foreign ministries and international bodies. See backend/sources/officials.py.
//
// Two origins reach this decorator and it must keep them visibly apart:
//
//   official_feed  the government's own press release. Certain about who said
//                  it, published with no editor in between.
//   gdelt          CAMEO-coded from a trusted newsroom's reporting. Has reach
//                  and corroboration; can be wrong about who did what.
//
// Blending them into one "diplomacy" pin would hide the single thing a reader
// most needs in order to weigh a statement about a war, so the popup always
// says which it is, and the primary-source pins get their own ring.

// Cooperative acts read cool, hostile acts read warm. This is a description of
// the act's direction, not a judgement about whether it is good: a signed
// ceasefire and a signed arms deal are both teal.
const OFFICIALS_COOPERATIVE_COLOR = "#7ee0c9";
const OFFICIALS_HOSTILE_COLOR = "#ff9500";
const OFFICIALS_NEUTRAL_COLOR = "#c9b6ff";

const COOPERATIVE_KINDS = new Set(["meeting", "agreement", "aid"]);
const HOSTILE_KINDS = new Set(["demand", "threat", "rupture", "posture", "protest"]);

export const OFFICIALS_KIND_LABEL = {
  meeting: "Meeting, call or state visit",
  agreement: "Agreement signed / de-escalation",
  aid: "Aid or material support",
  statement: "Statement or remarks",
  demand: "Demand, criticism or rejection",
  threat: "Threat or ultimatum",
  rupture: "Sanctions, expulsions, ties cut",
  posture: "Force posture / mobilisation",
  protest: "Protest",
};

function officialsColor(d) {
  if (COOPERATIVE_KINDS.has(d.kind)) return OFFICIALS_COOPERATIVE_COLOR;
  if (HOSTILE_KINDS.has(d.kind)) return OFFICIALS_HOSTILE_COLOR;
  return OFFICIALS_NEUTRAL_COLOR;
}

// published_at is unix seconds here rather than GDELT's packed string, because
// officials.py normalises both origins onto one timestamp.
function officialsAgeHours(d) {
  if (!Number.isFinite(d?.published_at)) return NaN;
  return (Date.now() - d.published_at * 1000) / 3600000;
}

function officialsTimeAgo(d) {
  const hours = officialsAgeHours(d);
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  return `${Math.round(hours)}h ago`;
}

// The one line that tells a reader how to weigh this. Deliberately blunt in
// both directions: a press release is not journalism, and a CAMEO code is not
// a quote.
function officialsProvenance(d) {
  if (d.origin === "official_feed") {
    return `Published by ${d.government || d.outlet || "the issuing body"} itself — a primary source, ` +
      "not independently verified and not edited by a newsroom.";
  }
  const many = (d.outlet_count || 0) > 1;
  return `Machine-coded by GDELT from ${many ? "news reporting" : "a single news article"}. ` +
    "The actors and the action are inferred from that wording, not quoted from it.";
}

export function decorateOfficials(d, { offset } = {}) {
  const kindLabel = OFFICIALS_KIND_LABEL[d.kind] || "Diplomatic activity";
  // A real headline first, then the CAMEO label -- same precedence the
  // conflict popup uses, and for the same reason: "Consultation" on its own
  // tells a reader nothing.
  const lead = (d.headline || "").trim() || d.label || kindLabel;
  const where = d.location || d.country || "";
  const when = officialsTimeAgo(d);
  const publisher = d.outlet || d.government || (d.origin === "gdelt" ? "GDELT" : "");
  const primary = d.origin === "official_feed";

  const tooltip = `<b>${esc(lead)}</b><br/>${esc(kindLabel)}${where ? " &middot; " + esc(where) : ""}` +
    `<br/>${esc(publisher)}${when ? " &middot; " + esc(when) : ""}` +
    (primary ? "<br/><i>official source</i>" : "");

  const actors = [d.actor1, d.actor2].filter(Boolean);
  const detail = `
    <h3>${esc(lead)}</h3>
    <div class="meta">${esc(kindLabel)}${where ? " &middot; " + esc(where) : ""}${when ? " &middot; " + esc(when) : ""}</div>
    ${d.summary && d.summary !== d.headline ? `<p class="news-sentence">${esc(d.summary)}</p>` : ""}
    ${actors.length ? `<div class="meta">Parties: ${esc(actors.join(" &rarr; ").replace("&rarr;", "→"))}</div>` : ""}
    ${d.origin === "gdelt" && (d.outlet_count || 0) > 1
      ? `<div class="meta">Carried by ${d.outlet_count} independent outlets</div>` : ""}
    ${d.corroborated_by_primary_source
      ? '<div class="meta evidence">Also published by the government itself — primary source and news reporting agree.</div>' : ""}
    ${d.url ? `<div><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${primary ? "Read the statement" : "Open source article"}</a></div>` : ""}
    <p class="meta">${esc(officialsProvenance(d))}</p>
    <div class="meta">${primary
      ? "Placed at the seat of the issuing institution, not at the site of any event."
      : "Placed where the reporting says the act took place."}</div>`;

  return {
    icon: icon(
      OFFICIALS_KIND_ICON[d.kind] || SVG.podium,
      officialsColor(d),
      officialsIconSize(d),
      0,
      "",
      newsAgeOpacity(officialsAgeHours(d)),
      // The ring is what separates "the Kremlin said this" from "Reuters
      // reported the Kremlin said this" at a glance, without a second colour
      // axis fighting the cooperative/hostile one.
      primary ? "official-primary" : "",
      offset,
    ),
    tooltip,
    detail,
  };
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
  fighter: { svg: SVG.planeFighter, color: "#ff4d4d", size: 28, name: "plane-military-fighter" },
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

// Exported so the control panel's per-type sub-ticker draws its swatch from the
// same object the map draws its pin from. It previously restated the colours by
// hand and had drifted a whole row out of step -- every type except Refineries
// advertised a colour that appears nowhere on the map.
export const INFRA_STYLE = {
  refinery: { svg: SVG.refinery, color: "#ff9500", label: "Refinery" },
  pipeline: { svg: SVG.pipeline, color: "#ffb347", label: "Pipeline" },
  desalination: { svg: SVG.desalination, color: "#35c2ff", label: "Desalination plant" },
  lng_terminal: { svg: SVG.lng, color: "#9be15d", label: "LNG terminal" },
  nuclear: { svg: SVG.nuclear, color: "#ffd60a", label: "Nuclear power plant" },
  port: { svg: SVG.port, color: "#d8b9ff", label: "Port / oil terminal" },
  fab: { svg: SVG.fab, color: "#6fe3ff", label: "Semiconductor fab" },
};

// The colour the pipeline *routes* are drawn in (see renderPipelines), which is
// a polyline rather than an INFRA_STYLE marker but still needs a legend entry
// that matches.
export const PIPELINE_ROUTE_COLOR = "#ffb347";

// Military bases share the "infra" data shape/toggle but pick their icon
// from `subtype` (air/naval/army/missile/joint/logistics/radar) instead of
// `type` -- see backend/infrastructure.py's MILITARY_BASES.
export const MILITARY_SUBTYPE_STYLE = {
  air: { svg: SVG.airBase, color: "#ff4d4d", label: "Air base" },
  naval: { svg: SVG.ship, color: "#ffd60a", label: "Naval base" },
  army: { svg: SVG.armyBase, color: "#9be15d", label: "Army base" },
  missile: { svg: SVG.missileBase, color: "#ff8c3a", label: "Missile / space base" },
  joint: { svg: SVG.jointBase, color: "#d8b9ff", label: "Joint base" },
  logistics: { svg: SVG.logisticsBase, color: "#8aa0ad", label: "Logistics base" },
  radar: { svg: SVG.radarBase, color: "#6fe3ff", label: "Radar / early-warning site" },
};

export function decorateInfra(d, { hot, nearbyEvents, offset } = {}) {
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
  return { icon: icon(style.svg, style.color, INFRA_ICON_SIZE, 0, cls, 1, "", offset), tooltip, detail };
}

// ---------- satellites ----------

// Keyed by CelesTrak's own group name (see backend/sources/satellites.py's
// GROUPS) -- military objects get their own glyph and colour instead of the
// whole layer sharing one cyan satellite pin, so "which of these is a
// reconnaissance bird" is answerable at a glance. Exported so
// LayersSection.jsx's legend and the map draw from the same values.
export const SATELLITE_STYLE = {
  stations: { svg: SVG.satellite, color: "#6fe3ff", size: 24, label: "Space station" },
  military: { svg: SVG.satelliteMilitary, color: "#ff4d4d", size: 26, label: "Military satellite" },
};
const SATELLITE_FALLBACK = { svg: SVG.satellite, color: "#6fe3ff", size: 24, label: "Satellite" };

export function isMilitarySatellite(d) {
  return d.group === "military";
}

export function decorateSatellite(d, { offset } = {}) {
  const style = SATELLITE_STYLE[d.group] || SATELLITE_FALLBACK;
  const military = isMilitarySatellite(d);
  const tooltip = `<b>${esc(d.name || `NORAD ${d.norad_id}`)}</b><br/>${esc(style.label)} &middot; ${Math.round(d.alt_km || 0)} km`;
  const detail = `
    <h3>${esc(d.name || `NORAD ${d.norad_id}`)}</h3>
    <div class="meta">${esc(style.label)} &middot; NORAD catalog ID ${esc(d.norad_id)}</div>
    <div>Altitude: ${Math.round(d.alt_km || 0)} km</div>
    ${military ? '<p class="meta">Listed in CelesTrak\'s public "Miscellaneous Military" group (e.g. SAR-Lupe reconnaissance satellites) -- a catalogue classification, not a claim about what it is doing right now.</p>' : ""}
    <p class="meta">Position computed from CelesTrak's public orbital elements via SGP4 propagation -- a real orbit, not a live telemetry confirmation.</p>
    <div class="meta">Source: CelesTrak (NORAD GP data)</div>`;
  const cls = `satellite-marker${military ? " satellite-military-marker" : ""}`;
  return { icon: icon(style.svg, style.color, style.size, 0, cls, 1, "", offset), tooltip, detail };
}
