// "Decorators" turn one raw API item (an ACLED event, a ship, a plane, a
// news event) into the trio a Leaflet marker needs: {icon, tooltip, detail}.
// Kept separate from map/renderers.js (which handles *when* to build/update
// a marker) so the "what does this thing look like" logic reads as a flat,
// self-contained reference for each data source.

import { L } from "./leafletGlobal";
import { SVG, OFFICIALS_KIND_ICON, buildDivIcon } from "./svgIcons";
import { esc, fmtNumber, timeAgoFromDateAdded, timeAgoFromUnix, utcClockFromUnix } from "../utils/format";
import {
  severityBand, severityColor, CORROBORATED_COLOR, isImprecise, PRECISION_NOTE, ageHours, ageOpacity,
  placementDoubtful, positionUncertain, VERDICT_NOTE,
  reliabilityBand, reliabilityColor, reliabilityWeak,
  uncertaintyRadiusMetres,
  ageHoursFromDateAdded, newsAgeOpacity, newsAgeScale,
} from "./severity";
import { paletteColor, scaledSize, layerOpacity, themedStyle } from "./iconTheme";

// --- level of detail -------------------------------------------------------
//
// Two levels, and the boundary is the COUNTRY band floor -- which is also
// DECLUTTER_MIN_ZOOM. That coincidence is deliberate and it is what makes this
// safe: below the boundary the placement pass produces no offsets at all, so
// buildDivIcon's shift and leader-line terms are constant-empty there and a
// change of detail cannot interact with the rounded offsets that keep the
// diffed icon string stable. Above it there is exactly one level, so crossing
// zoom 9 or 12 changes nothing. Precisely one repaint of every visible marker
// happens, on crossing the boundary itself.
//
// Module-level rather than threaded through every decorator's signature, for
// the reason iconTheme.js gives for its own palette: these are plain functions
// called hundreds of times from deep inside an imperative render pass, and the
// controller sets this once per pass before any of them run. It also removes a
// whole class of bug -- buildMarker and updateMarker cannot disagree about the
// detail, because there is only one value for both to read.
//
// It must never depend on anything but the zoom band. The viewport profile and
// the reader's focus change on every pan and click; if either reached the icon
// string, updateMarker's diff would rebuild every marker's DOM continuously.
let iconDetail = "glyph";

/** A single filled circle. Colour still carries severity or type -- that is all
 *  a mark this size can honestly hold. ~90 characters of HTML against ~900 for
 *  a fighter silhouette, and that string is what gets diffed on every pan. */
const DOT_SVG = '<circle cx="12" cy="12" r="9" fill="currentColor"/>';

// Sizes are compressed toward a dot rather than flattened to one number.
// Flattening would throw away the severity hierarchy at exactly the zoom where
// the events cap makes it matter most -- a critical event should still read as
// larger than a minor one at world zoom, even when both are dots.
const DOT_SCALE = 0.55;
const DOT_MIN = 6;
const DOT_MAX = 13;

export function setIconDetail(next) {
  iconDetail = next === "dot" ? "dot" : "glyph";
}

export function currentIconDetail() {
  return iconDetail;
}

/**
 * The size a glyph is drawn at once the current detail level is applied.
 *
 * Exported because the placement pass has to reserve exactly what gets drawn:
 * reserving an 18px hole for a 7px dot is the mismatch the note at the top of
 * this file warns about. Harmless while the detail boundary sits on
 * DECLUTTER_MIN_ZOOM (placement is off on the dot side), and a silent
 * degradation of every collision decision the moment anyone moves it -- so the
 * controller wraps ICON_SIZE_FOR with this rather than relying on the
 * coincidence holding.
 *
 * Rounded, because the number lands in the icon's HTML string and a fractional
 * value would differ on every render (see scaledSize's own note).
 */
export function detailSize(size) {
  if (iconDetail !== "dot") return size;
  return Math.max(DOT_MIN, Math.min(DOT_MAX, Math.round(size * DOT_SCALE)));
}

// `badge` was missing from this forwarder, so decorateGdelt's collapsed-pin
// count was passed in and silently dropped: buildDivIcon has supported the
// chip all along, and a pin standing for nine stories drew as a plain pin.
//
// Every decorator in this file routes through here, which is why the detail
// swap lives here rather than in seventeen separate call sites. The badge
// survives at dot detail: a pin standing for nine stories has to say so at
// every zoom, and it is the one piece of information a dot cannot encode by
// being a dot. Rotation is dropped -- a circle has no heading to show, and
// keeping the transform would only churn the diffed string as vehicles turn.
function icon(svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset, badge) {
  if (iconDetail === "dot") {
    return buildDivIcon(L, DOT_SVG, color, detailSize(size), 0, extraClass, opacity, wrapClass, offset, badge);
  }
  return buildDivIcon(L, svgInner, color, size, rotateDeg, extraClass, opacity, wrapClass, offset, badge);
}

/**
 * Make a collapsed group say so, for the layers whose decorator does not.
 *
 * News and diplomacy have handled grouping since before it was general: both
 * render a count badge and list their members. When collapsing became a
 * property any layer can declare, the other seven inherited the grouping
 * without the telling -- and a head drawn as an ordinary pin with thirty-nine
 * members silently absent is exactly the kind of quiet subtraction this map
 * does not do.
 *
 * Applied centrally rather than by teaching seven more decorators, because the
 * thing to say is identical in all seven cases: how many are here, and how to
 * separate them. The count goes into the icon's HTML string rather than onto a
 * class, for the reason buildDivIcon states -- a badge expressed as a class
 * would never trigger the repaint that shows the number changing.
 */
export function applyCollapsedFallback(d, item) {
  const count = item?.collapsedCount || 0;
  if (count < 2 || !d?.icon?.options?.html) return d;
  const html = d.icon.options.html;
  if (html.includes("pin-badge")) return d; // the decorator already says it

  const chip = `<span class="pin-badge">${count > 99 ? "99+" : count}</span>`;
  const at = html.lastIndexOf("</div>");
  d.icon.options.html = at < 0 ? html + chip : html.slice(0, at) + chip + html.slice(at);

  // event_id before id, matching expandOpened in createMapController.js and
  // decorateGdelt's own button. The two have to agree or the button would ask
  // to open a group nothing is keyed under.
  const id = esc(String(item.event_id ?? item.id ?? ""));
  // `collapsedLabel` is set by whatever did the grouping when it can name the
  // basis for it -- a city zone can, pixel proximity cannot. Pre-escaped by its
  // producer, which is why it is interpolated rather than run through esc()
  // again: it carries an &mdash; on purpose (see collapseFor in
  // createMapController.js).
  const where = item.collapsedLabel || "at this location";
  d.detail =
    `<div class="coverage-head">${count} ${where}</div>` +
    (d.detail || "") +
    (item.collapsedLabel
      ? '<p class="meta">Grouped by city rather than by how close the pins landed. The radius is a '
        + "nominal urban footprint from the city's population band, not a boundary &mdash; every "
        + "report below keeps its own coordinate and its own record.</p>"
      : "") +
    `<div class="meta"><button type="button" class="cluster-expand" data-cluster-id="${id}">` +
    `Separate these pins</button></div>`;
  d.tooltip = `${count} ${where} &mdash; ${d.tooltip || ""}`;
  return d;
}

// Icon sizes are needed twice: here, to draw the glyph, and in
// createMapController's placement pass, which has to know how much room each
// item takes before any of them are drawn. Exported so there is one formula
// rather than a copy that can drift.
//
// Every one of these ends in scaledSize(), which applies Admin Mode's global
// and per-layer size multipliers (see map/iconTheme.js). Doing it here rather
// than at the point the glyph is built is what keeps the declutter/placement
// pass working off the size a pin is actually drawn at -- scaling only the
// drawing would leave 30px icons being routed around a 15px reservation.
//
// 13px at severity 0 up to ~31px at 100 -- a visible hierarchy at a glance
// without the largest pins swallowing their neighbours. Imprecise events are
// drawn smaller as well as ringed: they should not compete for attention with
// events we can actually place.
export function eventIconSize(d) {
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  // Sized through its own severity band's token, so the four bands can be
  // scaled apart from each other -- which is the point of a severity ramp that
  // is already four separate colours.
  return scaledSize(
    (13 + (severity / 100) * 18) * (isImprecise(d) ? 0.8 : 1),
    "events",
    severityBand(severity)?.token
  );
}

// Sized by deaths, since UCDP always reports them -- but capped well below the
// live layer's largest pins so the record never dominates the map.
export function historicalIconSize(d) {
  return scaledSize(10 + Math.min(Math.sqrt(d.fatalities || 0) * 2.2, 8), "conflictHistory", "event.history");
}

// Reach sets the base size; age shrinks it. Rounded to whole pixels for the
// same reason opacity is quantised -- the number goes into the icon's HTML
// string, which updateMarker compares to decide whether to rebuild the DOM.
// A collapsed pin (see collapse.js) is drawn a little larger, because it now
// stands for several stories and has to carry a count badge.
export function gdeltIconSize(d) {
  const base = 14 + Math.min(Math.log10((d.mentions || 1) + 1), 3) * 2.5;
  const scaled = base * newsAgeScale(ageHoursFromDateAdded(d.date_added));
  return scaledSize(d.collapsedCount > 1 ? scaled + 4 : scaled, "gdelt", "news.pin");
}

// Officials pins are sized by how widely the act was carried, not by severity:
// this layer has no severity scale, and "how many newsrooms picked this up" is
// the closest available read on whether a statement mattered. A government's
// own release has no outlet count by construction and sits at the base size.
export function officialsIconSize(d) {
  const base = 15 + Math.min(Math.log10((d.outlet_count || 0) + 1), 2) * 3.5;
  const scaled = base * newsAgeScale(officialsAgeHours(d));
  // Room for the count badge, same +4 gdeltIconSize gives a collapsed news pin.
  // Tokened by the act's own kind, matching officialsColor -- a cooperative and
  // a hostile act are already two colours and can now be two sizes.
  return scaledSize(d.collapsedCount > 1 ? scaled + 4 : scaled, "officials", officialsToken(d));
}

export const INFRA_ICON_SIZE = 18;

// Same shipped size, put through the icon theme. A function rather than a
// second const because the multipliers change at runtime, and both the pin and
// the placement pass have to read the current value (see createMapController).
//
// Takes the site so it can find that site's token: the seven infrastructure
// types are seven separately sizable pins, and a size the placement pass
// computed without knowing which type it was reserving for would leave a
// deliberately-enlarged refinery overlapping its neighbours.
export function infraIconSize(d) {
  return scaledSize(INFRA_ICON_SIZE, "infra", infraBaseStyle(d)?.token);
}

// The shipped style a site is drawn from, before the theme touches it. Military
// bases are keyed on `subtype` rather than `type` and carry no palette token of
// their own -- they follow the layer, which is what the admin panel says.
function infraBaseStyle(d) {
  if (!d) return null;
  return d.type === "military"
    ? MILITARY_SUBTYPE_STYLE[d.subtype] || MILITARY_SUBTYPE_STYLE.joint
    : INFRA_STYLE[d.type] || INFRA_STYLE.port;
}

// ---------- cities ----------

// Graduated symbols: population picks both the glyph and its size, so a
// megacity and a 100k town are no longer the same anonymous dot. Thresholds
// are the round numbers a reader already thinks in, and they split the ~6,200
// cities we carry into usefully unequal bands (roughly 60 / 500 / 1,200 /
// 3,800 at the time of writing) -- the rarest tier is the one that should
// stand out. Ordered largest-first; cityTier() takes the first match.
// `opacity` is the second graduated dimension, and it is doing a different job
// from `size`. Size says how big a place is; opacity says how much of the
// reader's attention it is entitled to. Cities are reference context -- they
// exist so that everything else on this map has somewhere to be -- and at 6,200
// of them a uniform pink dot field competes with the layers it is supposed to be
// backing. A town at 0.45 recedes into the basemap and is still perfectly
// legible when looked for; a megacity at full strength stays an anchor.
//
// The two ramps are deliberately steeper than they were. 7->24px against the old
// 8->18 widens the gap the graduated symbols exist to show, and it is affordable
// precisely because the small end is now also faint: a 7px dot at 0.45 takes far
// less of the eye than an 8px dot at full strength did.
export const CITY_COLOR = "#ff6fb5";
export const CITY_TIERS = [
  { key: "mega", min: 5_000_000, label: "Megacity (5M+)", svg: SVG.city, size: 24, opacity: 1 },
  { key: "large", min: 1_000_000, label: "Large city (1M-5M)", svg: SVG.cityLarge, size: 17, opacity: 0.82 },
  { key: "medium", min: 250_000, label: "City (250k-1M)", svg: SVG.cityMedium, size: 11, opacity: 0.62 },
  { key: "town", min: 0, label: "Town (100k-250k)", svg: SVG.cityTown, size: 7, opacity: 0.45 },
];

// Capital status is orthogonal to population, so it is not another row in
// CITY_TIERS -- Tokyo is a megacity *and* a capital, and a tier list can only
// answer one of those. It is a separate tier the population tier defers to,
// and it carries a floor size rather than a fixed one (see decorateCity) so a
// capital is never drawn smaller than the population band it belongs to.
//
// This is also what the Officials & Diplomacy layer anchors to: a capital
// snapped record (backend/sources/capitals.py) lands on exactly this point.
export const CAPITAL_TIER = {
  key: "capital",
  label: "Capital city",
  svg: SVG.capital,
  size: 18,
  // Never faded, whatever its population. A capital is the point the Officials
  // & Diplomacy layer draws on, so a reader has to be able to find it -- and a
  // 120k-population capital receding into the basemap like the town it is by
  // size would take the diplomatic record with it.
  opacity: 1,
};

// Highest for the largest tier. Used as a placement priority, so a megacity
// keeps its true position and the towns around it are the ones that yield.
// A capital outranks every population tier: it is the point diplomacy pins are
// drawn on, so it is the one that must not be nudged off its true coordinate.
export function cityTierRank(tier) {
  if (tier === CAPITAL_TIER) return CITY_TIERS.length;
  return CITY_TIERS.length - 1 - CITY_TIERS.indexOf(tier);
}

export function cityTier(population) {
  const pop = Number.isFinite(population) ? population : 0;
  return CITY_TIERS.find((t) => pop >= t.min) || CITY_TIERS[CITY_TIERS.length - 1];
}

export function decorateCity(city, { offset } = {}) {
  const populationTier = cityTier(city.population);
  const tier = city.is_capital ? CAPITAL_TIER : populationTier;
  // max, not the capital tier's own size: shrinking Tokyo below Osaka because
  // it happens to be a capital would invert the one thing the graduated
  // symbols exist to show.
  const base = city.is_capital ? Math.max(CAPITAL_TIER.size, populationTier.size) : tier.size;
  const size = scaledSize(base, "cities", "city.marker");
  const color = paletteColor("city.marker", CITY_COLOR);
  // The tier's own fade, under whatever Admin Mode has set for the layer. Same
  // shape as every other multiplier here: the shipped judgement is the number,
  // the setting is the dial on top of it.
  const opacity = tier.opacity * layerOpacity("cities");
  return {
    tier,
    // The size the caller gets back is the size that is actually drawn, so
    // renderCities reserves the right amount of room for it in the placement
    // pass. icon() applies the same transform internally.
    size: detailSize(size),
    icon: icon(tier.svg, color, size, 0, "city-marker", opacity, "", offset),
  };
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

// A record the operator has changed in Admin Mode (or added outright) says so,
// in every popup that can show it. The whole point of this map is that a pin
// states what kind of evidence it is; a locally-edited pin that looked exactly
// like a fetched one would break that in the least recoverable way.
function editedNote(d) {
  if (!d.__edited) return "";
  const what = d.__added ? "added locally in Admin Mode" : "edited locally in Admin Mode";
  return `<div class="meta edited-note">Modified: this record was ${what} and no longer matches the source feed.</div>`;
}

// What the backend concluded about the coordinate, and why. Every fused event
// carries a verdict (geoverify.py always returns one), and until now not one of
// them reached the reader -- a pin the pipeline had judged to be in the wrong
// country was drawn and described exactly like a corroborated one.
//
// "unverified" is deliberately silent. It means nothing was checked, which is
// the default state and already implied by the source line; printing a note for
// it on most pins would bury the two verdicts that actually matter.
function placementLine(d) {
  const note = VERDICT_NOTE[d.geo_verdict];
  const spread = placementSpreadLine(d);
  if (!note) return spread;
  const doubted = placementDoubtful(d);
  const reason = (d.geo_reason || "").trim();
  return `
    <div class="meta placement-note${doubted ? " placement-doubted" : ""}">
      ${esc(note)}${reason ? ` <span class="placement-reason">(${esc(reason)})</span>` : ""}
    </div>${spread}`;
}

// The two numbers geoverify.py has always written and nobody could read:
// how far out the coordinate may be, and how sure the pipeline is of it.
//
// Stated in the popup even when the circle is drawn, because the circle is only
// on screen inside its legibility window (see uncertaintyOnScreen in
// createMapController.js) -- zoomed into a street, the 400 km disc is gone and
// this sentence is the only thing left saying the pin is a national centroid.
function placementSpreadLine(d) {
  const metres = uncertaintyRadiusMetres(d);
  const score = Number(d.geo_confidence);
  if (metres === null && !Number.isFinite(score)) return "";
  const parts = [];
  if (metres !== null) {
    const km = metres / 1000;
    // Sub-10 km values are geoverify's own computed ones and the decimal is
    // the difference between "this street" and "this district"; the lookup
    // values (15/120/400) are round and a decimal on them would imply a
    // precision the lookup does not have.
    parts.push(`could be up to ${km < 10 ? km.toFixed(1) : Math.round(km)} km away`);
  }
  if (Number.isFinite(score)) parts.push(`placement confidence ${score}/100`);
  return `<div class="meta placement-spread">${esc(parts.join(" · "))}</div>`;
}

// "How much to trust this", answering the question the heading actually asks.
//
// This block used to draw the severity bar, which measures how *consequential*
// an event is -- so a fabricated massacre and a confirmed one filled the bar
// identically, and the one number a reader was invited to read as credibility
// was the one number that said nothing about it. Scored by
// backend/sources/reliability.py; the reasons are its own, not restated here.
//
// Returns "" for a record with no score at all rather than inventing one. That
// is a real case: /api/replay serves snapshots written before this field
// existed, and a bar drawn from a missing value would be a confident-looking
// zero.
// `extra` is whatever the caller wants said between the score and the reasons.
// The conflict popup puts its corroboration sentence there; the news popup has
// no equivalent and passes nothing, because corroborationLine reads
// `corroboration` -- a field event_fusion writes on a *fused* record -- and off
// a single article it would print "Uncorroborated" over a story seven newsrooms
// carried. The reasons list already says the true version of that.
const RELIABILITY_REASONS_SHOWN = 4;

function reliabilityBlock(d, extra = "") {
  const band = reliabilityBand(d);
  if (!band) return "";
  const score = Number.isFinite(d.reliability) ? d.reliability : band.min;
  const reasons = (d.reliability_reasons || []).slice(0, RELIABILITY_REASONS_SHOWN);
  return `
    <div class="sev-block rel-block rel-${band.key}">
      <div class="sev-head">How much to trust this</div>
      <div class="sev-bar"><span style="width:${Math.max(2, score)}%;background:${reliabilityColor(band)}"></span></div>
      <div class="meta">Reliability ${score}/100 &mdash; ${esc(band.label)}</div>
      ${extra}
      ${reasons.length ? `<ul class="sev-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${outletLine(d)}
    </div>`;
}

// How far a pin recedes when it falls below the reader's confidence floor.
// Deep enough to sort the layer at a glance, shallow enough that the dimmed
// pins stay clickable -- the control answers "which of these are weakly
// placed", and a pin faded to nothing could not be interrogated for the answer.
const CONFIDENCE_DIM = 0.35;

export function decorateEvent(d, { offset, dimmed } = {}) {
  const sources = (d.corroborated_by && d.corroborated_by.length ? d.corroborated_by : [d.source]).filter(Boolean);
  const sourceLine = sources.map((s) => SOURCE_LABEL[s] || s).join(", ");
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  const band = severityBand(severity);
  const imprecise = isImprecise(d);
  // The backend's own verdict on the coordinate (geoverify.py). "contested"
  // means the reporting names somewhere else -- the pin has not been moved,
  // but it must stop being drawn as though it were known.
  const doubtful = placementDoubtful(d);
  const uncertain = positionUncertain(d);
  // How much the *reporting* can be trusted, which is a separate question from
  // whether the coordinate is right -- see backend/sources/reliability.py. Null
  // on records archived before it shipped, so every use below is guarded.
  const trustBand = reliabilityBand(d);
  const weak = reliabilityWeak(d);
  const where = d.location || d.country || "";
  const kind = d.event_type || "Conflict event";
  // The lead is whatever actually says what happened: a real scraped headline
  // first, then the sentence built from the coded fields, and only then the
  // bare taxonomy label -- which is where this used to start, and which on its
  // own ("Unconventional violence") tells a reader nothing.
  const lead = (d.notes || "").trim() || (d.summary || "").trim() || kind;
  // The tooltip leads with the same thing the popup's <h3> does, for the same
  // reason. It used to open with `kind` alone, so hovering a pin answered
  // "what category is this" ("Unconventional violence") while only a click
  // answered "what happened" -- and a reader scanning a busy map is asking the
  // second question. The taxonomy label drops to the meta line, where it is
  // still worth having: it is the vocabulary the legend and the icon share.
  //
  // `kind` is skipped there when the lead already is it -- an event with no
  // headline and no coded sentence falls back to the label, and printing it
  // twice reads as a bug.
  const meta = [lead === kind ? null : kind, band.label, where, d.date]
    .filter(Boolean).map(esc).join(" &middot; ");
  const tooltip = `<b>${esc(lead)}</b><br/>${meta}<br/>${esc(casualtyLine(d))}` +
    `${imprecise ? "<br/><i>approximate location</i>" : ""}` +
    // Said on hover, not only on click: this is the one thing that can make
    // the pin's own position wrong, and a reader scanning the map should not
    // have to open it to find that out.
    `${doubtful ? `<br/><i>${esc(d.geo_text_place ? `position doubted — the reporting names ${d.geo_text_place}` : "position doubted")}</i>` : ""}` +
    // Same argument as the line above, for the other thing that can make a pin
    // misleading. Who is behind a report decides how much of it to believe, and
    // making a reader click to discover that nothing vouches for this one puts
    // the weakest pins on equal footing with the strongest at a glance.
    `${weak ? `<br/><i>${esc(trustBand.label.toLowerCase())} sourcing — ${esc(d.reliability_outlet || "no newsroom we vouch for")}</i>` : ""}`;
  const intensity = goldsteinLabel(d.goldstein);
  // event_fusion's classifier assigns the same label to both fields for
  // GDELT-derived events, so only show the subtype when it adds something.
  const subtype = d.sub_event_type && d.sub_event_type !== d.event_type ? d.sub_event_type : null;
  const reasons = (d.severity_reasons || []).slice(0, 4);
  const provenance = provenanceFor(d);
  // Empty for records archived before reliability scoring shipped -- the
  // severity block below picks the corroboration and outlet lines back up in
  // that case, so an old record loses the bar and nothing else.
  const trust = reliabilityBlock(
    d,
    `<div class="meta">${esc(corroborationLine(d, sources))}</div>`
  );
  const detail = `
    <h3>${esc(lead)}</h3>
    <div class="meta">${esc(kind)}${subtype ? " &mdash; " + esc(subtype) : ""} &middot; ${esc(where)}${d.date ? " &middot; " + esc(d.date) : ""}</div>
    <div class="meta">${esc(casualtyLine(d))}</div>
    ${imprecise ? `<div class="meta imprecise-note">${esc(PRECISION_NOTE[d.geo_precision] || PRECISION_NOTE.unknown)}</div>` : ""}
    ${placementLine(d)}
    ${trust}
    <div class="sev-block">
      <div class="sev-head">How severe</div>
      <div class="sev-bar"><span style="width:${Math.max(2, severity)}%;background:${severityColor(band)}"></span></div>
      <div class="meta">Severity ${severity}/100 &mdash; ${esc(band.label)}</div>
      ${reasons.length ? `<ul class="sev-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${trust ? "" : `<div class="meta">${esc(corroborationLine(d, sources))}</div>${outletLine(d)}`}
      ${d.jamming_nearby ? `<div class="meta evidence">GPS interference detected within 60 km (${Math.round(d.jamming_nearby * 100)}% bad fixes)</div>` : ""}
      ${d.thermal_nearby ? `<div class="meta evidence">Thermal anomaly detected within 10 km the same day</div>` : ""}
    </div>
    ${editedNote(d)}
    ${coverageBlock(d)}
    ${!d.coverage?.length && d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    ${!d.notes && d.summary ? '<p class="meta">Sentence above is assembled from the event’s coded fields, not quoted from an article.</p>' : ""}
    ${provenance ? `<p class="meta">${esc(provenance)}</p>` : ""}
    ${intensity ? `<div class="meta" title="CAMEO Goldstein scale, ${d.goldstein}">Coded intensity: ${esc(intensity)}</div>` : ""}
    <div class="meta">Source: ${esc(sourceLine)}</div>`;
  const size = eventIconSize(d);
  // Corroboration keeps its distinct blue: "confirmed by a second source" is
  // a different axis from "how bad", and both are worth seeing at once.
  const color = d.corroborated ? paletteColor("event.corroborated", CORROBORATED_COLOR) : severityColor(band);
  // Older events fade rather than disappear, so "what is happening now" is
  // legible without hiding context.
  //
  // The confidence dim multiplies into the same number rather than adding a CSS
  // class, so it composes with age instead of overriding it: an old, weakly
  // placed pin should read as both. Multiplying by a constant keeps the result
  // as stable across renders as ageOpacity's own quantisation makes it, which
  // is what stops updateMarker rebuilding every icon on every pan.
  const opacity = ageOpacity(ageHours(d)) * layerOpacity("events") * (dimmed ? CONFIDENCE_DIM : 1);
  return {
    // Two independent doubts, two independent marks, because they are answers
    // to different questions and a pin can carry either, both or neither:
    //
    //   imprecise       dashed ring -- "do not read this dot as a location",
    //                   whether because the geocode is only national or because
    //                   the reporting contradicts it.
    //   weakly-sourced  desaturated -- "nothing much vouches for this", the
    //                   same visual argument .historical and .inferred already
    //                   make for records that are real but not live evidence.
    icon: icon(
      acledIcon(d), color, size, 0, "", opacity,
      [uncertain ? "imprecise" : "", weak ? "weakly-sourced" : ""].filter(Boolean).join(" "),
      offset
    ),
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
    icon: icon(
      SVG.recordMark,
      paletteColor("event.history", HISTORY_COLOR),
      historicalIconSize(d),
      0,
      "",
      0.75 * layerOpacity("conflictHistory"),
      "historical",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- natural hazards (backend/sources/hazards.py) ----------

// Two publishers under one layer key, told apart by `kind` all the way to the
// popup. Exported so LayersSection.jsx's legend draws the same glyphs the map
// does rather than restating them.
//
// Deliberately no palette token: a hazard pin is coloured by severity (see
// decorateHazard), exactly like a conflict pin, so the legend rows below draw
// in the panel's own text colour and the severity swatches carry the colour
// meaning. Giving these an overridable colour would offer a control that does
// not change what the map paints.
export const HAZARD_STYLE = {
  earthquake: { svg: SVG.earthquake, label: "Earthquake (USGS)" },
  volcano: { svg: SVG.volcano, label: "Volcanic activity (Smithsonian GVP)" },
};
const HAZARD_FALLBACK = { svg: SVG.earthquake, label: "Hazard" };
export const HAZARD_KIND_ORDER = ["earthquake", "volcano"];

export function hazardStyle(kind) {
  return HAZARD_STYLE[kind] || HAZARD_FALLBACK;
}

// Same 13-31px severity ramp the conflict layer uses, from the same field --
// the backend puts both publishers on the shared 0-100 scale (see
// _severity_for_quake) precisely so one size formula can serve both.
export function hazardIconSize(d) {
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  return scaledSize(13 + (severity / 100) * 18, "hazards");
}

// What the severity score was actually derived from, in the reader's words.
// A magnitude and a PAGER alert are different claims and the popup has to say
// which one coloured the pin -- otherwise an M7.1 drawn amber next to an M5.4
// drawn red just looks broken.
const HAZARD_SEVERITY_BASIS = {
  pager: "Coloured by USGS PAGER alert level (estimated impact), which outranks magnitude here.",
  magnitude: "Coloured by magnitude &mdash; USGS has not issued a PAGER impact alert for this event.",
  gvp_report_type: "Coloured by GVP's own report type; the weekly report carries no finer severity scale.",
};

function decorateEarthquake(d) {
  const magnitude = Number.isFinite(d.magnitude) ? `M${d.magnitude.toFixed(1)}` : "Magnitude unknown";
  const when = timeAgoFromUnix(d.time);
  const depth = Number.isFinite(d.depth_km) ? `${Math.round(d.depth_km)} km deep` : "depth unknown";
  const tooltip = `<b>${esc(magnitude)}</b> earthquake &middot; ${esc(depth)}<br/>` +
    `${esc(d.place || "")}${when ? ` &middot; ${esc(when)}` : ""}`;
  const detail = `
    <h3>${esc(magnitude)} earthquake</h3>
    <div class="meta">${esc(d.place || "Location not described")}${when ? ` &middot; ${esc(when)}` : ""}</div>
    <div>Depth: ${esc(depth)}</div>
    ${d.alert ? `<div>PAGER alert: <b>${esc(d.alert)}</b></div>` : ""}
    ${d.tsunami ? '<div class="hazard-tsunami">Tsunami evaluation issued for this event.</div>' : ""}
    ${Number.isFinite(d.felt) ? `<div>${fmtNumber(d.felt)} "Did You Feel It?" reports</div>` : ""}
    <p class="meta">${HAZARD_SEVERITY_BASIS[d.severity_basis] || ""}</p>
    <div class="meta">Source: ${esc(d.publisher || "USGS")}${
      d.url ? ` &middot; <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">event page</a>` : ""
    }</div>`;
  return { tooltip, detail };
}

function decorateVolcano(d) {
  const name = d.name || "Volcano";
  const headline = d.headline || "Activity report";
  const tooltip = `<b>${esc(name)}</b>${d.country ? ` (${esc(d.country)})` : ""}<br/>${esc(headline)}`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${esc(d.country || "")}${d.report_period ? ` &middot; ${esc(d.report_period)}` : ""}</div>
    <div><b>${esc(headline)}</b></div>
    ${d.summary ? `<p>${esc(d.summary)}</p>` : ""}
    <p class="meta">A <b>weekly</b> report, not a live sensor reading &mdash; the Global Volcanism Program
      issues these once every Thursday, so this describes a period rather than this moment.</p>
    ${
      d.geo_precision !== "locality"
        ? `<p class="meta">${esc(PRECISION_NOTE.region)} No coordinate was published with this report.</p>`
        : ""
    }
    <div class="meta">Source: ${esc(d.publisher || "Smithsonian GVP / USGS")}${
      d.url ? ` &middot; <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">weekly report</a>` : ""
    }</div>`;
  return { tooltip, detail };
}

export function decorateHazard(d, { offset } = {}) {
  const style = hazardStyle(d.kind);
  const { tooltip, detail } = d.kind === "volcano" ? decorateVolcano(d) : decorateEarthquake(d);
  // Severity picks the colour the same way it does for conflict pins, so the
  // two layers' colours mean the same thing side by side. The glyph, not the
  // colour, is what says which hazard it is.
  const band = severityBand(d.severity);
  return {
    icon: icon(
      style.svg,
      severityColor(band),
      hazardIconSize(d),
      0,
      `hazard-marker hazard-${esc(d.kind || "unknown")}`,
      layerOpacity("hazards"),
      "",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- GDACS floods (backend/sources/floods.py) ----------
//
// A separate layer key from hazards above, not a third `kind` inside it, and
// backend/sources/floods.py:9-40 is the argument for why. The short version is
// that a hazard pin promises a measured position -- a seismometer solution, a
// volcano's summit -- and a GDACS point is a modelled centroid over an affected
// river basin. Folding this in would weaken that promise for the whole layer.
//
// Deliberately no palette token, for the same reason hazards has none: the pin
// is coloured by severity, and offering a colour control for something the
// severity ramp paints would be a control that changes nothing.
export const FLOOD_STYLE = { svg: SVG.flooding, label: "Flood (GDACS)" };

// Same 13-31px ramp the conflict and earthquake layers use, from the same
// field. GDACS's Green/Orange/Red alert level is mapped onto the shared 0-100
// scale with the same numbers USGS PAGER alerts get (see floods.py), which is
// what makes a red flood and a red quake mean the same weight to a reader
// comparing them side by side.
export function floodIconSize(d) {
  const severity = Number.isFinite(d.severity) ? d.severity : 0;
  return scaledSize(13 + (severity / 100) * 18, "floods");
}

export function decorateFlood(d, { offset } = {}) {
  const name = d.name || "Flood event";
  const alert = d.alert_level ? `GDACS ${d.alert_level} alert` : "Alert level not stated";
  const from = d.from_time ? utcClockFromUnix(d.from_time).slice(0, 10) : "not stated";
  const to = d.to_time ? utcClockFromUnix(d.to_time).slice(0, 10) : "";
  const affected = Array.isArray(d.affected_iso3) ? d.affected_iso3 : [];
  const tooltip = `<b>${esc(name)}</b><br/>${esc(alert)}` +
    `${d.country ? ` &middot; ${esc(d.country)}` : ""}` +
    `${d.is_current ? "" : "<br/>Closed by GDACS"}`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${esc(d.country || "Location not stated")} &middot; ${esc(alert)}${
      Number.isFinite(d.episode) ? ` &middot; episode ${esc(d.episode)}` : ""
    }</div>
    ${d.is_current
      ? ""
      : '<p class="meta"><b>GDACS has closed this event.</b> It is kept because it happened, ' +
        "not because it is happening.</p>"}
    ${d.is_temporary
      ? '<p class="meta">Flagged <b>temporary</b> by GDACS &mdash; a provisional alert that may be ' +
        "revised or withdrawn.</p>"
      : ""}
    <div>Onset ${esc(from)}${to ? ` &mdash; ${esc(to)}` : ""}</div>
    ${d.updated ? `<div class="meta">GDACS last revised this ${esc(timeAgoFromUnix(d.updated))}.</div>` : ""}
    ${d.description ? `<p>${esc(d.description)}</p>` : ""}
    ${affected.length > 1 ? `<div class="meta">Countries affected: ${esc(affected.join(", "))}</div>` : ""}
    ${d.glide ? `<div class="meta">GLIDE ${esc(d.glide)} &mdash; the cross-agency id for this disaster.</div>` : ""}
    <p class="meta">Coloured by <b>GDACS's own Green/Orange/Red alert level</b>, mapped onto the same
      0&ndash;100 scale this map's earthquakes use, so a red flood and a red quake mean the same
      weight.${Number.isFinite(d.alert_score)
        ? ` GDACS's finer alert score (${esc(d.alert_score)}) is a different quantity on a different` +
          " scale and is shown, not used for colour."
        : ""}</p>
    <p class="meta"><b>This point is the middle of an affected river basin, not a place that
      flooded.</b> GDACS labels it a centroid itself, and the bounding box it ships is identical to
      the point, so nothing in the feed narrows it. The real extent is a polygon this map links
      rather than draws.</p>
    <div class="meta">Source: ${esc(d.publisher || "GDACS")} &mdash; a modelled alert from
      ${esc(d.model_source || "GLOFAS")}, a curated hydrological model run rather than an observed
      water level.${
        d.url ? ` &middot; <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">event report</a>` : ""
      }${
        d.footprint_url
          ? ` &middot; <a href="${esc(d.footprint_url)}" target="_blank" rel="noopener noreferrer">affected-area polygon</a>`
          : ""
      }</div>`;
  return {
    icon: icon(
      FLOOD_STYLE.svg,
      severityColor(severityBand(d.severity)),
      floodIconSize(d),
      0,
      "flood-marker",
      // Closed events fade the way the historical conflict record does: still
      // there, still counted, no longer competing with what is happening now.
      (d.is_current ? 1 : 0.75) * layerOpacity("floods"),
      // geo_precision is "region" on every row, so the dashed ring is not a
      // judgement call -- it is true by construction.
      d.is_current ? "imprecise" : "imprecise historical",
      offset
    ),
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
  // A collapsed pin is a list of separate stories from separate newsrooms, so
  // one bar under the whole list would be a score for nothing. Each row carries
  // its own band instead -- the word only, since eight bars stacked in a popup
  // read as a chart rather than as eight verdicts.
  const band = reliabilityBand(item);
  const bits = [item.source_name, timeAgoFromDateAdded(item.date_added)]
    .filter(Boolean).map(esc);
  if (band) {
    bits.push(`<span class="rel-chip" style="color:${reliabilityColor(band)}">${esc(band.label)}</span>`);
  }
  const meta = bits.join(" &middot; ");
  const link = item.source_url
    ? `<a href="${esc(item.source_url)}" target="_blank" rel="noopener noreferrer">${headline}</a>`
    : headline;
  return `<li>${link}${meta ? `<span class="coverage-meta">${meta}</span>` : ""}</li>`;
}

// How many headlines a collapsed pin lists before it stops. Higher than the
// conflict popup's COVERAGE_SHOWN because these are genuinely different
// stories rather than repeat coverage of one, so truncating loses more.
const COLLAPSED_SHOWN = 8;

// How many of them the *tooltip* names. A collapsed pin used to hover as one
// headline plus "+8 more stories here", which answered "how many" and left the
// question a reader is actually asking -- what are they? -- to a click. Three
// is what fits: the tooltip is capped at 320px and each headline clamps to two
// lines, so past three the box is taller than the pins it is covering.
const COLLAPSED_TOOLTIP_SHOWN = 3;

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

  // Hovering a news pin has to answer "what is this story", and for a collapsed
  // pin that means naming more than the one headline that happened to win the
  // head slot. The remainder still counts itself, so nothing is hidden -- the
  // tooltip just stops being a bare tally.
  const rest = collapsed ? collapsed.slice(1, COLLAPSED_TOOLTIP_SHOWN) : [];
  const restLeft = extra - rest.length;
  const tooltip = collapsed
    ? `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${esc(when)}` +
      rest.map((c) => `<br/><b>${esc((c.real_title || "").trim())}</b>`).join("") +
      (restLeft > 0
        ? `<br/><i>+${restLeft} more ${restLeft === 1 ? "story" : "stories"} here</i>`
        : "<br/><i>click to open all of them</i>")
    : `<b>${esc(headline)}</b><br/>${agency ? `${esc(agency)} &middot; ` : ""}${esc(when)}`;

  const detail = collapsed
    ? `
    <div class="coverage-head">${collapsed.length} stories at this location</div>
    <ul class="coverage-list">${collapsed.slice(0, COLLAPSED_SHOWN).map(newsLine).join("")}</ul>
    ${collapsed.length > COLLAPSED_SHOWN
        ? `<div class="meta">+${collapsed.length - COLLAPSED_SHOWN} more</div>`
        : ""}
    <div class="meta">
      <button type="button" class="cluster-expand" data-cluster-id="${esc(String(d.event_id ?? d.id ?? ""))}">
        Separate these pins
      </button>
    </div>`
    : `
    <h3>${esc(headline)}</h3>
    ${d.source_url ? `<div><a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Open source article</a></div>` : ""}
    ${editedNote(d)}
    <div class="meta">Source: ${agency ? esc(agency) : "GDELT"} &middot; ${esc(when)}${corroboratedNote}</div>
    ${reliabilityBlock(d)}`;

  const color = d.corroborated
    ? paletteColor("event.corroborated", CORROBORATED_COLOR)
    : paletteColor("news.pin", "#ffd60a");
  // News pins used to be drawn at a flat opacity of 1 regardless of age, which
  // was tolerable over a two-hour window and is not over twenty-four: without
  // this, a story from yesterday morning is as loud as one from ten minutes
  // ago and the map stops saying anything about what is happening now.
  const hours = ageHoursFromDateAdded(d.date_added);
  return {
    icon: icon(SVG.news, color, gdeltIconSize(d), 0, "", newsAgeOpacity(hours) * layerOpacity("gdelt"), "", offset, d.collapsedCount),
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

// Which of the three diplomatic tokens an act belongs to. Split out from
// officialsColor because the size dial reads it too, and a kind that was
// coloured hostile while being sized neutral would be one act drawn as two.
function officialsToken(d) {
  if (COOPERATIVE_KINDS.has(d?.kind)) return "officials.cooperative";
  if (HOSTILE_KINDS.has(d?.kind)) return "officials.hostile";
  return "officials.neutral";
}

const OFFICIALS_TOKEN_COLOR = {
  "officials.cooperative": OFFICIALS_COOPERATIVE_COLOR,
  "officials.hostile": OFFICIALS_HOSTILE_COLOR,
  "officials.neutral": OFFICIALS_NEUTRAL_COLOR,
};

function officialsColor(d) {
  const token = officialsToken(d);
  return paletteColor(token, OFFICIALS_TOKEN_COLOR[token]);
}

// published_at is unix seconds here rather than GDELT's packed string, because
// officials.py normalises both origins onto one timestamp.
//
// Exported because createMapController needs the same number for its age
// filter and its hub ranking. One formula read from three places beats three
// that agree today -- the same rule gdeltIconSize and eventIconSize follow.
export function officialsAgeHours(d) {
  if (!Number.isFinite(d?.published_at)) return NaN;
  return (Date.now() - d.published_at * 1000) / 3600000;
}

function officialsTimeAgo(d) {
  const hours = officialsAgeHours(d);
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  return `${Math.round(hours)}h ago`;
}

// Why this pin is where it is. Three genuinely different claims, and the map
// must not make the wrong one: before capital-snapping existed this said
// "Placed where the reporting says the act took place" for every GDELT record,
// which became false the moment a country-centroid row was moved to a capital.
// Asserting a precision we do not have is the failure geo_precision exists to
// prevent.
function officialsPlacement(d) {
  if (d.origin === "official_feed") {
    return "Placed at the seat of the issuing institution, not at the site of any event.";
  }
  if (d.snapped_to_capital) {
    const where = d.anchor?.name;
    return where
      ? `Reported only at country level — shown at ${where}, the capital, not where the act took place.`
      : PRECISION_NOTE.capital;
  }
  return "Placed where the reporting says the act took place.";
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

// One line in a capital hub's list. The counterpart of newsLine above.
function officialsLine(item) {
  const kindLabel = OFFICIALS_KIND_LABEL[item.kind] || "Diplomatic activity";
  const lead = esc((item.headline || "").trim() || item.label || kindLabel);
  const meta = [
    kindLabel,
    item.outlet || item.government,
    officialsTimeAgo(item),
    item.origin === "official_feed" ? "official source" : null,
  ].filter(Boolean).map(esc).join(" &middot; ");
  const link = item.url
    ? `<a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${lead}</a>`
    : lead;
  return `<li>${link}${meta ? `<span class="coverage-meta">${meta}</span>` : ""}</li>`;
}

// How many items a capital hub lists. Same count the collapsed news pin uses,
// for the same reason: these are genuinely different events rather than repeat
// coverage of one, so truncating loses more than it does on a conflict popup.
const OFFICIALS_COLLAPSED_SHOWN = 8;

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

  // Set by collapseByKey when several diplomatic items share an anchor -- a
  // capital they were all snapped to, or one institution's press feed. Unlike
  // the news layer's pixel proximity this is an exact grouping: they really are
  // one point, so the hub is describing a place rather than approximating one.
  const collapsed = d.collapsed || null;
  if (collapsed) return decorateOfficialsHub(d, collapsed, { offset });

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
    ${editedNote(d)}
    <p class="meta">${esc(officialsProvenance(d))}</p>
    <div class="meta">${esc(officialsPlacement(d))}</div>`;

  return {
    icon: icon(
      OFFICIALS_KIND_ICON[d.kind] || SVG.podium,
      officialsColor(d),
      officialsIconSize(d),
      0,
      "",
      newsAgeOpacity(officialsAgeHours(d)) * layerOpacity("officials"),
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

// A capital (or an institution) standing for everything said there.
//
// The glyph is the capital star rather than any one kind's icon: a hub whose
// members are a state visit, two demands and a sanctions announcement has no
// single kind, and picking one would be a lie about the other three. Colour
// follows the members only when they agree -- a capital showing nothing but
// threats should read as hostile at a glance; a mixed one should not pretend to.
function decorateOfficialsHub(d, members, { offset } = {}) {
  const anchorName = d.anchor?.name || d.country || d.location || "this location";
  const institution = d.anchor?.kind === "institution";
  const kinds = new Set(members.map((m) => m.kind));
  const color = kinds.size === 1 ? officialsColor(d) : paletteColor("officials.neutral", OFFICIALS_NEUTRAL_COLOR);
  // Newest first, which is a different question from which item won the head
  // slot: the pin answers "what matters most here", the list answers "what has
  // been happening here".
  const newest = [...members].sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  const extra = members.length - OFFICIALS_COLLAPSED_SHOWN;
  const noun = institution ? "statements" : "diplomatic items";

  const tooltip =
    `<b>${esc(anchorName)}</b><br/>${members.length} ${esc(noun)}` +
    `<br/><i>${officialsTimeAgo(newest[0]) ? `latest ${esc(officialsTimeAgo(newest[0]))}` : "click to read"}</i>`;

  const detail = `
    <div class="coverage-head">${members.length} ${esc(noun)} &mdash; ${esc(anchorName)}</div>
    <ul class="coverage-list">${newest.slice(0, OFFICIALS_COLLAPSED_SHOWN).map(officialsLine).join("")}</ul>
    ${extra > 0 ? `<div class="meta">+${extra} more</div>` : ""}
    <div class="meta">${esc(
      institution
        ? "Grouped at the seat of the issuing institution, not at the site of any event."
        : `Grouped at ${anchorName}. Each of these was reported only at country level, so the map shows them at the capital rather than where they took place.`
    )}</div>`;

  return {
    icon: icon(
      SVG.capital,
      color,
      officialsIconSize(d),
      0,
      "",
      newsAgeOpacity(officialsAgeHours(newest[0])) * layerOpacity("officials"),
      institution ? "official-primary" : "",
      offset,
      members.length,
    ),
    tooltip,
    detail,
  };
}

// ---------- OFAC designation (backend/sources/sanctions.py) ----------
//
// Applies to both ships and aircraft, so it lives above both. It is drawn as a
// ring on whatever glyph the vessel or airframe already has, never as a glyph
// of its own: a designated tanker is still a tanker, and losing that would cost
// more than the designation adds.

export const SANCTION_COLOR = "#ff3b30";

/** How strong the identifier behind a match actually is, in a reader's words. */
export const SANCTION_MATCH_NOTE = {
  imo: "Matched on <b>IMO number</b> &mdash; permanent and specific to the hull. It survives renaming, " +
    "reflagging and resale, which makes this the strongest match available.",
  mmsi: "Matched on <b>MMSI</b>. An MMSI belongs to the radio licence, not the hull, and is reissued when a " +
    "ship changes flag &mdash; something designated vessels do often. Treat as strong but not conclusive.",
  callsign: "Matched on <b>call sign</b> only, which AIS broadcasts as free text entered by the crew. This is " +
    "the weakest match this map will make and can be wrong; check the IMO before relying on it.",
  registration: "Matched on <b>registration</b> (tail number), which is how OFAC lists an aircraft. Tail " +
    "numbers are reassigned after a sale, so a match is the airframe OFAC named, not necessarily this operator.",
};

const SANCTION_MATCH_LABEL = {
  imo: "IMO number",
  mmsi: "MMSI",
  callsign: "call sign",
  registration: "registration",
};

export function isSanctioned(d) {
  return !!d?.sanctions;
}

/** A style wearing the designation ring, as its own sprite texture. */
export function withSanctionRing(style) {
  return {
    ...style,
    svg: `${style.svg}${SVG.sanctionRing}`,
    color: paletteColor("sanctions.designated", SANCTION_COLOR),
    size: (style.size || 16) + 6,
    name: `${style.name || "marker"}-sanctioned`,
  };
}

/** The popup block for a designated ship or aircraft, or "". */
export function sanctionDetail(d) {
  const listing = d?.sanctions;
  if (!listing) return "";
  const aliases = (listing.aliases || []).slice(0, 4);
  return `
    <div class="sanction-block">
      <div class="sanction-head">OFAC-designated &mdash; ${esc(listing.program || "programme not stated")}</div>
      <div>Listed as: ${esc(listing.listed_as)}</div>
      ${aliases.length ? `<div>Also listed as: ${aliases.map((a) => esc(a)).join(", ")}</div>` : ""}
      ${listing.flag ? `<div>Listed flag: ${esc(listing.flag)}</div>` : ""}
      ${listing.owner ? `<div>Listed owner: ${esc(listing.owner)}</div>` : ""}
      <div>Matched on: ${esc(SANCTION_MATCH_LABEL[listing.matched_on] || listing.matched_on)}</div>
      <p class="meta">${SANCTION_MATCH_NOTE[listing.matched_on] || ""}</p>
      <p class="meta">Source: US Treasury OFAC Specially Designated Nationals list, refreshed daily. A match
        is against the list as published; it is not legal advice and not a claim about what this
        ${esc(listing.sdn_type === "aircraft" ? "aircraft" : "vessel")} is doing now.</p>
    </div>`;
}

// ---------- last position report (AIS + ADS-B) ----------
//
// Also above both, and for a reason the other layers don't have: a ship or an
// aircraft icon can outlive the transmission it stands for. The AIS layer keeps
// a vessel for 30 minutes after its last report (STALE_AFTER in
// backend/sources/ais.py) and ADS-B keeps whatever the last successful poll
// returned for as long as the upstream is failing, so both layers can be
// drawing a position that was true a while ago -- and every replayed contact is
// old by definition. Stating the age on the pin is what lets a reader tell a
// live contact from a remembered one instead of having to trust that the map
// only draws current things.

/** Beyond this, a fix is old enough to be worth flagging rather than just noting. */
const STALE_PING_SECONDS = 15 * 60;

function pingAgeSeconds(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return Date.now() / 1000 - seconds;
}

/**
 * The popup line: how long ago the contact last reported, and the clock time it
 * reported at. Both, because these cards are not re-rendered while open (see
 * createMapController.js) so the relative half freezes the moment it is drawn.
 */
export function lastPingDetail(seconds) {
  const age = pingAgeSeconds(seconds);
  if (age === null) {
    // Not the same as "not heard from": OpenSky sends state vectors with no
    // position timestamp, and rows recorded before this field existed have none
    // either. Saying so beats implying the contact is stale or implying it's live.
    return '<div class="meta">Last position report: not stated by the feed</div>';
  }
  const cls = age > STALE_PING_SECONDS ? "meta stale-ping" : "meta";
  return `<div class="${cls}">Last position report: ${esc(timeAgoFromUnix(seconds))} &middot; ${esc(utcClockFromUnix(seconds))}</div>`;
}

/** The same fact for the hover tooltip, where only the age is worth the room. */
export function lastPingTooltip(seconds) {
  const age = pingAgeSeconds(seconds);
  if (age === null) return "";
  const cls = age > STALE_PING_SECONDS ? "stale-ping" : "ping-age";
  return `<br/><span class="${cls}">Last ping ${esc(timeAgoFromUnix(seconds))}</span>`;
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

// Same {svg,color,size} triples decorateAis picks below, pulled out so
// webglLayer.js can build its sprite texture cache from the same source of
// truth instead of re-deriving these values.
//
// `token` is the palette entry Admin Mode recolours (see map/iconTheme.js);
// `color` stays the shipped default and the fallback. Read these through
// themedStyle() wherever a marker is actually drawn -- reading the raw object
// gets the shipped colour and the shipped size, which is right for
// documentation (the control panel's legend explains what ships look like by
// default) and wrong for painting.
export const SHIP_STYLE = {
  navy: { svg: SVG.ship, color: "#ffd60a", size: 26, name: "ship-navy", token: "ship.navy" },
  tanker: { svg: SVG.tanker, color: "#ffb347", size: 20, name: "ship-tanker", token: "ship.tanker" },
  other: { svg: SVG.ship, color: "#35c2ff", size: 16, name: "ship-other", token: "ship.other" },
};

/** Which layer key a ship class belongs to -- its opacity/scale settings. */
export const SHIP_LAYER_KEY = { navy: "aisNavy", tanker: "aisTanker", other: "aisCivilian" };

export function decorateAis(d, { selectedMmsi } = {}) {
  const type = classifyShip(d);
  const navy = type === "navy";
  const tanker = type === "tanker";
  const typeLabel = navy ? " &middot; US Navy / MSC" : tanker ? " &middot; Oil/chemical tanker" : "";
  const designated = isSanctioned(d);
  const tooltip = `<b>${esc(d.name || "Unknown vessel")}</b>${typeLabel}` +
    `${designated ? `<br/><span class="sanction-flag">OFAC-designated &middot; ${esc(d.sanctions.program || "")}</span>` : ""}` +
    `<br/>MMSI ${esc(d.mmsi)}<br/>Speed ${esc(d.speed ?? "?")} kn` +
    lastPingTooltip(d.updated);
  const detail = `
    <h3>${esc(d.name || "Unknown vessel")}</h3>
    <div class="meta">MMSI ${esc(d.mmsi)}${d.imo ? ` &middot; IMO ${esc(d.imo)}` : ""}${
      d.callsign ? ` &middot; call sign ${esc(d.callsign)}` : ""
    }</div>
    ${sanctionDetail(d)}
    <div>Speed: ${esc(d.speed ?? "n/a")} kn &middot; Course: ${esc(d.course ?? "n/a")}&deg;</div>
    <div>Nav status code: ${esc(d.nav_status ?? "n/a")}</div>
    ${lastPingDetail(d.updated)}
    ${navy ? '<p class="meta">Identified as US Navy / Military Sealift Command from its AIS ship-type code (or USS/USNS naming when static data hasn\'t arrived yet). Most warships run AIS off underway for OPSEC -- this only shows vessels that broadcast it.</p>' : ""}
    ${tanker ? '<p class="meta">Identified as an oil/chemical tanker from its AIS ship-type code.</p>' : ""}
    <div class="meta">Source: aisstream.io (AIS)${designated ? " &middot; designations: US Treasury OFAC" : ""}</div>`;
  const heading = Number.isFinite(d.heading) && d.heading !== 511 ? d.heading : d.course;
  let cls = "ship-marker";
  if (navy) cls += " navy-marker";
  if (tanker) cls += " tanker-marker";
  if (designated) cls += " sanctioned-marker";
  if (d.mmsi === selectedMmsi) cls += " selected";
  // One table rather than three parallel ternaries -- the previous form
  // restated SHIP_STYLE's colours and sizes inline, which is how a themed
  // colour would have reached the sprites and not this icon.
  const base = themedStyle(SHIP_STYLE[type], SHIP_LAYER_KEY[type]);
  const style = designated ? withSanctionRing(base) : base;
  return { icon: icon(style.svg, style.color, style.size, heading, cls, style.opacity), tooltip, detail };
}

// ---------- OpenStreetMap infrastructure (backend/sources/osm_infra.py) ----
//
// A separate layer from the curated one above, and drawn to look like it:
// hollow, quieter, and with every popup naming OpenStreetMap. The curated list
// promises human-checked coordinates and this does not, so the two must never
// be mistaken for each other.
export const OSM_INFRA_STYLE = {
  military_airfield: { svg: SVG.airfieldMilitary, color: "#ff8c3a", size: 16, label: "Military airfield", token: "osm.military" },
  military_area: { svg: SVG.armyBase, color: "#ff8c3a", size: 14, label: "Military area", token: "osm.military" },
  power_plant: { svg: SVG.powerPlant, color: "#9be15d", size: 14, label: "Power plant", token: "osm.power" },
  border_control: { svg: SVG.borderCrossing, color: "#c9b6ff", size: 13, label: "Border crossing", token: "osm.border" },
};
const OSM_INFRA_FALLBACK = OSM_INFRA_STYLE.military_area;
export const OSM_INFRA_ORDER = ["military_airfield", "military_area", "power_plant", "border_control"];

export function osmInfraStyle(kind) {
  return themedStyle(OSM_INFRA_STYLE[kind] || OSM_INFRA_FALLBACK, "osmInfra");
}

export function osmInfraIconSize(d) {
  return osmInfraStyle(d?.kind).size;
}

export function decorateOsmInfra(d, { offset } = {}) {
  const style = osmInfraStyle(d.kind);
  const tooltip = `<b>${esc(d.name)}</b><br/>${esc(style.label)} &middot; OpenStreetMap`;
  const detail = `
    <h3>${esc(d.name)}</h3>
    <div class="meta">${esc(style.label)}${d.operator ? ` &middot; ${esc(d.operator)}` : ""}</div>
    ${Number.isFinite(d.output_mw) ? `<div>Output: ${esc(Math.round(d.output_mw))} MW</div>` : ""}
    ${d.source_tag ? `<div>Generating from: ${esc(d.source_tag)}</div>` : ""}
    ${!d.named ? '<p class="meta">Unnamed in OpenStreetMap &mdash; the label above is its type, not its name.</p>' : ""}
    <p class="meta">From <b>OpenStreetMap</b>, contributed by its mappers and not checked by hand. The
      separate Critical Infrastructure layer is the curated one; this is the wider, noisier picture.
      Position is the feature's computed centre, so for a large site it is the middle of the area rather
      than any particular building.</p>
    <div class="meta">Source: OpenStreetMap contributors (ODbL), via Overpass &middot;
      <a href="https://www.openstreetmap.org/${esc(d.osm_type)}/${esc(d.osm_id)}" target="_blank" rel="noopener noreferrer">view the raw feature</a></div>`;
  return {
    icon: icon(style.svg, style.color, style.size, 0, "osm-infra-marker", 0.75 * layerOpacity("osmInfra"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- EASA conflict-zone bulletins (backend/sources/czib.py) ----------
//
// The best-attributed evidence on this map: a named regulator's own document,
// with a bulletin number a reader can look up and a stated review date. It is
// also the least precisely placed -- a CZIB is about a national flight
// information region, so every pin here is country precision and nothing finer.
//
// Coloured by status rather than severity, deliberately. czib.py assigns 70 to
// a live bulletin and 0 to a withdrawn one, which is a status flag wearing a
// number: put on the shared severity ramp it would paint every live advisory
// the same orange and every withdrawn one yellow, and a rescinded document
// would read as a mild live warning.
export const CZIB_STYLE = {
  active: {
    svg: SVG.airspaceRestricted, color: "#ff4d6d", size: 19,
    label: "Airspace warning, active (EASA)", token: "czib.active",
  },
  withdrawn: {
    svg: SVG.airspaceRestricted, color: "#7f93a8", size: 15,
    label: "Airspace warning, withdrawn", token: "czib.withdrawn",
  },
};
export const CZIB_ORDER = ["active", "withdrawn"];

export function czibStyle(d) {
  return themedStyle(d?.active ? CZIB_STYLE.active : CZIB_STYLE.withdrawn, "czib");
}

export function czibIconSize(d) {
  return czibStyle(d).size;
}

export function decorateCzib(d, { offset } = {}) {
  const style = czibStyle(d);
  const name = d.name || "Conflict zone bulletin";
  const others = (Array.isArray(d.bulletin_countries) ? d.bulletin_countries : [])
    .filter((c) => c && c !== d.country);
  const count = Number(d.country_count) || 0;
  const issued = d.issued ? utcClockFromUnix(d.issued).slice(0, 10) : "";
  const expired = Number.isFinite(d.valid_until) && d.valid_until * 1000 < Date.now();
  const tooltip = `<b>${esc(name)}</b><br/>${esc(style.label)}` +
    `${d.reference ? `<br/>${esc(d.reference)}` : ""}`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${d.active ? "Active bulletin" : "Withdrawn"} &middot;
      ${esc(d.publisher || "EASA")}${d.reference ? ` &middot; ${esc(d.reference)}` : ""}</div>
    ${d.active
      ? ""
      : '<p class="meta"><b>This bulletin has been withdrawn.</b> It is shown because it happened ' +
        "&mdash; this airspace was restricted, by this regulator, between these dates &mdash; not " +
        "because anyone is being warned off it now.</p>"}
    <div>Airspace: <b>${esc(d.country || d.country_code || "not stated")}</b></div>
    ${count > 1
      ? `<p class="meta"><b>One bulletin, ${esc(count)} countries.</b> This pin is
          ${esc(d.country || "this country")}'s share of it; the same document also covers
          ${esc(others.join(", "))}, and there is an identical pin on each. It is one regulator's
          decision seen ${esc(count)} times, not ${esc(count)} findings.</p>`
      : ""}
    <div>Issued ${issued ? esc(issued) : "date not stated"}${
      d.valid_until_text ? ` &middot; valid until ${esc(d.valid_until_text)}` : " &middot; no expiry stated"
    }</div>
    ${expired
      ? '<div class="meta">The stated review date has passed. EASA revises rather than reissues, so ' +
        "a bulletin can outlive its own date &mdash; this is what the document says, not a judgement " +
        "about the airspace.</div>"
      : ""}
    ${d.valid_until_note ? `<p class="meta">${esc(d.valid_until_note)}</p>` : ""}
    ${d.updated ? `<div class="meta">Last revised ${esc(timeAgoFromUnix(d.updated))}.</div>` : ""}
    <p class="meta"><b>Measured for the whole country's airspace, not for this point.</b> A CZIB is
      about a national flight information region. This pin sits at the population-weighted centre of
      that country's towns so the layer has somewhere to draw, and says nothing about where inside
      the airspace the risk lies. EASA does publish a coordinate with these bulletins; it is their
      content system geocoding the country <i>name</i> &mdash; Afghanistan's is Kabul &mdash; so it
      is deliberately not read.</p>
    <div class="meta">Source: ${esc(d.publisher || "EASA")} Conflict Zone Information Bulletin
      &mdash; a primary source, a named regulator's own document with a quotable reference.${
        d.url ? ` <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Read the bulletin</a>.` : ""
      }</div>`;
  return {
    icon: icon(
      style.svg,
      style.color,
      czibIconSize(d),
      0,
      // czib-live is the flash, and it is deliberately narrower than
      // czib-active: `active` means the bulletin has not been withdrawn, which a
      // document whose own review date passed years ago still satisfies. Motion
      // on this map means "happening now", so a bulletin that has outlived its
      // stated date draws in the warning colour without pulsing -- see the
      // `expired` test above, which the popup already explains in words.
      `czib-marker czib-${d.active ? "active" : "withdrawn"}${d.active && !expired ? " czib-live" : ""}`,
      (d.active ? 1 : 0.8) * layerOpacity("czib"),
      // geo_precision is "country" on every row, so isImprecise() is true by
      // construction and the dashed ring is mandatory rather than conditional.
      d.active ? "imprecise" : "imprecise historical",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- NGA World Port Index (backend/sources/ports.py) ----------
//
// A gazetteer, not a feed: nothing in it is an event and nothing in it is
// current. It is here mostly because the Dark Vessels layer's ship-to-ship
// inference is only as good as its answer to "are these two simply in port",
// and before this arrived that answer came from a few dozen hand-curated
// harbours.
//
// Hollow anchor rather than the filled `port` glyph the curated infrastructure
// layer uses: same argument osmInfra makes against infra, a published gazetteer
// sitting underneath a hand-checked list.
export const PORT_STYLE = {
  svg: SVG.anchor, color: "#7fa8b8", size: 13, label: "Port (NGA World Port Index)", token: "port.wpi",
};

// The publisher's own coded harbour size, not a size this app invented.
const PORT_SIZE_PX = { L: 15, M: 13, S: 11, V: 9 };

export function portStyle() {
  return themedStyle(PORT_STYLE, "ports");
}

export function portIconSize(d) {
  const px = PORT_SIZE_PX[(d?.harbor_size || "").toUpperCase()] || PORT_STYLE.size;
  return scaledSize(px, "ports", PORT_STYLE.token);
}

export function decoratePort(d, { offset } = {}) {
  const style = portStyle();
  const name = d.name || "Port";
  const size = d.harbor_size_label || "Harbour size not coded";
  const type = d.harbor_type_label || d.harbor_type || "type not coded";
  const tooltip = `<b>${esc(name)}</b>${d.country ? ` &middot; ${esc(d.country)}` : ""}<br/>` +
    `${esc(size)} &middot; ${esc(type)}${d.oil_terminal ? "<br/>Oil terminal" : ""}`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${esc(d.country || "Country not stated")}${
      d.unlo_code ? ` &middot; UN/LOCODE ${esc(d.unlo_code)}` : ""
    }${d.port_number ? ` &middot; WPI ${esc(d.port_number)}` : ""}</div>
    <div>${esc(size)} &middot; ${esc(type)}</div>
    ${d.oil_terminal ? "<div><b>Has an oil terminal.</b></div>" : ""}
    ${d.nav_area ? `<div class="meta">NGA navigational area ${esc(d.nav_area)}.</div>` : ""}
    ${d.ais_watch
      ? '<p class="meta">Inside the water this map receives AIS from. Two vessels sitting alongside ' +
        "each other <i>here</i> are in a port, which is most of why this record exists: the Dark " +
        "Vessels layer excludes ship-to-ship candidates near a listed port, and before this " +
        "gazetteer arrived almost every real harbour on earth was open water to that detector.</p>"
      : ""}
    <p class="meta"><b>Reference data, not a feed. Nothing here is current.</b>${
      d.vintage ? ` ${esc(d.vintage)}.` : ""
    } For a port gazetteer that is acceptable &mdash; harbours are not built and demolished on a
      news cycle. It would not be acceptable for anything time-sensitive, and this layer makes no
      time-sensitive claim.</p>
    <div class="meta">Source: ${esc(d.publisher || "NGA World Port Index")} &mdash; a curated
      dataset${d.license ? `, ${esc(d.license)}` : ""}.</div>`;
  return {
    icon: icon(style.svg, style.color, portIconSize(d), 0, "port-marker", 0.85 * layerOpacity("ports"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- Global Dam Watch (backend/sources/dams.py) ----------
//
// A dam is infrastructure whose failure is catastrophic downstream and whose
// deliberate targeting is a war crime. The useful record is not "a dam is here"
// but "a dam is here and it holds this much", so the pin is sized by reservoir
// capacity rather than by generation.
//
// Two separate uncertainty fields have to reach a reader and they are not the
// same thing: `coord_source` is how the *point* was arrived at, and `quality`
// is the publisher's confidence in the *record*.
export const DAM_STYLE = {
  svg: SVG.dam, color: "#4a9fd8", size: 14, label: "Dam / reservoir (Global Dam Watch)", token: "dam.barrier",
};

export function damStyle() {
  return themedStyle(DAM_STYLE, "dams");
}

// 12-22px over six orders of magnitude of stored water, so log rather than
// linear -- a linear ramp here would draw one Kariba and forty thousand dots.
export function damIconSize(d) {
  const capacity = Number(d?.capacity_mcm);
  const px = 12 + Math.min(Math.log10((Number.isFinite(capacity) ? capacity : 0) + 1), 4) * 2.5;
  return scaledSize(px, "dams", DAM_STYLE.token);
}

export function decorateDam(d, { offset } = {}) {
  const style = damStyle();
  const name = d.name || "Barrier";
  const snapped = d.coord_source === "river_snap";
  const poor = Number(d.quality_rank) >= 4;
  const capacity = Number.isFinite(Number(d.capacity_mcm)) ? Number(d.capacity_mcm) : null;
  const tooltip = `<b>${esc(name)}</b>${d.river ? ` &middot; ${esc(d.river)}` : ""}<br/>` +
    `${capacity !== null ? `${esc(fmtNumber(capacity))} million m&sup3;` : "Capacity not published"}`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${esc(d.dam_type || "Barrier")}${d.river ? ` on the ${esc(d.river)}` : ""}${
      d.country ? ` &middot; ${esc(d.country)}` : ""
    }${d.year ? ` &middot; built ${esc(d.year)}` : ""}</div>
    ${d.named
      ? ""
      : '<p class="meta">Unnamed in Global Dam Watch &mdash; the label above is its type and its ' +
        "size, not its name.</p>"}
    ${capacity !== null
      ? `<div><b>${esc(fmtNumber(capacity))} million m&sup3;</b> standing behind it.</div>`
      : '<div class="meta">No reservoir capacity published for this barrier.</div>'}
    ${Number.isFinite(Number(d.height_m)) ? `<div>${esc(Math.round(Number(d.height_m)))} m high</div>` : ""}
    ${Number.isFinite(Number(d.area_skm)) ? `<div>Reservoir ${esc(fmtNumber(Number(d.area_skm)))} km&sup2;</div>` : ""}
    ${Number.isFinite(Number(d.catchment_skm))
      ? `<div>Catchment ${esc(fmtNumber(Number(d.catchment_skm)))} km&sup2;</div>` : ""}
    ${Number(d.power_mw) > 0 ? `<div>${esc(fmtNumber(Number(d.power_mw)))} MW installed</div>` : ""}
    ${d.main_use ? `<div class="meta">Primary use: ${esc(d.main_use)}</div>` : ""}
    ${snapped
      ? '<p class="meta"><b>This position is a snap onto a river network, not a published location ' +
        "for the structure.</b> Global Dam Watch publishes a dam coordinate for only about 15% of " +
        "its rows; for the rest &mdash; this one included &mdash; the point is the river reach the " +
        "barrier regulates. Across the rows carrying both, half agree exactly and nine in ten are " +
        "within 350 m, but the tail is real and the worst case is 92 km. Read this as the right " +
        "structure, not necessarily the right spot.</p>"
      : '<p class="meta">Position is the location Global Dam Watch publishes for the structure ' +
        "itself, not a river-network snap.</p>"}
    ${d.quality
      ? `<p class="meta">The publisher grades its own record <b>${esc(d.quality)}</b>${
          poor ? " &mdash; the bottom of its own five-point scale." : "."
        }</p>`
      : ""}
    <div class="meta">Source: ${esc(d.publisher || "Global Dam Watch")} &mdash; a curated dataset${
      d.license ? `, ${esc(d.license)}` : ""
    }.${d.orig_src ? ` Absorbed from ${esc(d.orig_src)}.` : ""}${
      d.grand_id ? ` GRanD ${esc(d.grand_id)}.` : ""
    }${d.url ? ` <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Record</a>.` : ""}${
      d.attribution ? `<br/>${esc(d.attribution)}` : ""
    }</div>`;
  return {
    icon: icon(
      style.svg,
      style.color,
      damIconSize(d),
      0,
      "dam-marker",
      0.85 * layerOpacity("dams"),
      // geo_precision is the constant "locality" on every row here, so
      // isImprecise() never fires -- the ring has to key on coord_source
      // explicitly or 85% of these pins would claim a precision they lack.
      `${snapped ? "imprecise" : ""}${poor ? " weakly-sourced" : ""}`.trim(),
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- orbital launches (backend/sources/launches.py) ----------

export const LAUNCH_STYLE = {
  upcoming: { svg: SVG.launchPad, color: "#ffd60a", size: 20, label: "Upcoming launch", token: "launch.upcoming" },
  flown: { svg: SVG.launchPad, color: "#8aa0ad", size: 15, label: "Recent launch (flown)", token: "launch.flown" },
};
export const LAUNCH_ORDER = ["upcoming", "flown"];

export function launchStyle(d) {
  return themedStyle(d?.upcoming ? LAUNCH_STYLE.upcoming : LAUNCH_STYLE.flown, "launches");
}

export function launchIconSize(d) {
  return launchStyle(d).size;
}

// How firm the scheduled T-0 actually is, in Launch Library's own vocabulary.
// A launch scheduled to the month must never be drawn with a live countdown.
const NET_PRECISION_LABEL = {
  SEC: "to the second",
  MIN: "to the minute",
  HOUR: "to the hour",
  DAY: "to the day",
  WEEK: "to the week",
  MONTH: "to the month",
  MO: "to the month",
  QUARTER: "to the quarter",
  YEAR: "to the year",
};

// Only these are precise enough for a countdown to mean anything.
const COUNTDOWN_PRECISIONS = new Set(["SEC", "MIN", "HOUR"]);

function launchTiming(d) {
  if (!Number.isFinite(d.net)) return "Launch time not set";
  const precise = COUNTDOWN_PRECISIONS.has(d.net_precision);
  const when = new Date(d.net * 1000).toISOString().replace("T", " ").slice(0, 16);
  if (!d.upcoming) return `${when} UTC`;
  if (!precise) {
    const note = NET_PRECISION_LABEL[d.net_precision];
    return `No earlier than ${when} UTC${note ? ` (${note})` : ""}`;
  }
  const seconds = d.net - Date.now() / 1000;
  if (seconds <= 0) return `${when} UTC &mdash; T-0 passed`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `T-${hours}h ${minutes}m &middot; ${when} UTC`;
}

export function decorateLaunch(d, { offset } = {}) {
  const style = launchStyle(d);
  const timing = launchTiming(d);
  const tooltip = `<b>${esc(d.name || "Launch")}</b><br/>${timing}<br/>${esc(d.site || d.pad || "")}`;
  const detail = `
    <h3>${esc(d.name || "Launch")}</h3>
    <div class="meta">${esc(style.label)}${d.status ? ` &middot; ${esc(d.status)}` : ""}</div>
    <div><b>${timing}</b></div>
    ${d.rocket ? `<div>Vehicle: ${esc(d.rocket)}</div>` : ""}
    ${d.provider ? `<div>Provider: ${esc(d.provider)}</div>` : ""}
    ${d.mission ? `<div>Mission: ${esc(d.mission)}${d.mission_type ? ` (${esc(d.mission_type)})` : ""}</div>` : ""}
    ${d.orbit ? `<div>Target orbit: ${esc(d.orbit)}</div>` : ""}
    <div class="meta">${esc(d.pad || "")}${d.site ? ` &middot; ${esc(d.site)}` : ""}</div>
    ${d.upcoming && !COUNTDOWN_PRECISIONS.has(d.net_precision)
      ? '<p class="meta">Scheduled dates this far out routinely move. The time above is the earliest the ' +
        "provider has committed to, not a countdown.</p>"
      : ""}
    <div class="meta">Source: Launch Library 2 (The Space Devs)</div>`;
  return {
    icon: icon(style.svg, style.color, style.size, 0, "launch-marker", layerOpacity("launches"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- submarine cables (backend/sources/cables.py) ----------

export const CABLE_ROUTE_COLOR = "#4fd1c5";
export const CABLE_LANDING_STYLE = {
  svg: SVG.cableLanding, color: "#4fd1c5", size: 14, label: "Cable landing point", token: "cable.landing",
};
export const CABLE_PLANNED_STYLE = {
  svg: SVG.cableLanding, color: "#7f93a8", size: 12, label: "Planned landing (site not settled)", token: "cable.planned",
};

export function cableRouteColor() {
  return paletteColor("cable.route", CABLE_ROUTE_COLOR);
}

export function cableLandingStyle(d) {
  return themedStyle(d?.planned ? CABLE_PLANNED_STYLE : CABLE_LANDING_STYLE, "cables");
}

export function cableLandingIconSize(d) {
  return cableLandingStyle(d).size;
}

export function decorateCableLanding(d, { offset } = {}) {
  const style = cableLandingStyle(d);
  const tooltip = `<b>${esc(d.name)}</b><br/>${esc(style.label)}`;
  const detail = `
    <h3>${esc(d.name)}</h3>
    <div class="meta">${esc(style.label)}</div>
    ${d.planned
      ? '<p class="meta">TeleGeography lists this landing as <b>to be determined</b> &mdash; a cable is planned to come ashore near here and the site is not settled. It is not an existing facility.</p>'
      : ""}
    <p class="meta">Cable routes on this map are drawn schematically, for legibility. They show roughly where
      a cable runs, not its surveyed position on the seabed.</p>
    <div class="meta">Source: TeleGeography submarine cable map</div>`;
  return {
    icon: icon(style.svg, style.color, style.size, 0, "cable-landing-marker", 0.85 * layerOpacity("cables"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- internet outages (backend/sources/outages.py) ----------
//
// IODA measures at national resolution and nothing finer. This used to be drawn
// as a tint over the whole country shape, which was wrong twice over: it read
// as a fact about the boundary rather than a measurement, and it was the same
// gesture (a filled country) the selection highlight already owned, so three
// countries appeared "selected" that nobody had clicked.
//
// A pin instead, at the country's representative interior point (see
// representativePointOf in countryHitTest.js). The point is where the layer is
// *drawn*, not where anything happened, and the popup leads with that rather
// than letting the pin imply a precision the data does not have.

export const OUTAGE_STYLE = {
  svg: SVG.connectivityLoss, color: "#4fd1c5", size: 20,
  // "Internet" spelled out, not "connectivity". This layer is IODA measuring
  // whether a country can be reached over the internet, and with an electricity
  // outage layer alongside it a bare "connectivity disruption" is a phrase a
  // reader can reasonably take either way -- power and network are exactly the
  // two things "the utilities are down" means.
  label: "Internet disruption (IODA)", token: "outage.country",
};

export function outageStyle() {
  return themedStyle(OUTAGE_STYLE, "outagePoints");
}

export function outageIconSize() {
  return outageStyle().size;
}

export function decorateOutage(d, { offset } = {}) {
  const style = outageStyle();
  const name = d.country || d.country_code || "Unknown country";
  // "ping-slash24.median" -> "ping-slash24": the suffix is IODA's aggregation,
  // not a fourth signal, and it only makes the list harder to read.
  const signals = Object.keys(d.signals || {}).map((key) => key.split(".")[0]);
  const tooltip = `<b>${esc(name)}</b><br/>${esc(style.label)} (country-wide)`;
  const detail = `
    <h3>${esc(name)}</h3>
    <div class="meta">${esc(style.label)}</div>
    <div>IODA composite score: ${fmtNumber(Math.round(d.score || 0))}${
      d.event_count ? ` &middot; ${esc(d.event_count)} event(s)` : ""
    }</div>
    ${signals.length ? `<div class="meta">Seen in: ${signals.map((s) => esc(s)).join(", ")}</div>` : ""}
    <p class="meta"><b>Measured for the whole country, not for this point.</b> IODA reports no location finer
      than the national level. This pin sits at the centre of the country's main landmass so the layer has
      somewhere to draw, and says nothing about where inside it connectivity was lost.</p>
    <p class="meta">The score is IODA's own composite and is unbounded &mdash; it is a comparison against the
      same country's normal and against other countries in the same window, not a share of the country
      offline.</p>
    <div class="meta">Source: IODA (Internet Outage Detection and Analysis, Georgia Tech)</div>`;
  return {
    icon: icon(style.svg, style.color, style.size, 0, "outage-marker", layerOpacity("outagePoints"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- dark vessels (backend/sources/dark_vessels.py) ----------
//
// The only layer on this map derived from our own recorded history rather than
// fetched from a publisher, and the only one whose evidence is an *absence*.
// Everything about how it is drawn says so: dashed glyphs, a muted palette, and
// a popup that leads with what else could explain the same signature.

export const DARK_VESSEL_STYLE = {
  ais_gap: { svg: SVG.darkShip, color: "#c9b6ff", size: 22, label: "Went dark (AIS gap)", token: "dark.gap" },
  sts_pair: { svg: SVG.stsTransfer, color: "#7ee0c9", size: 22, label: "Possible ship-to-ship transfer", token: "dark.sts" },
};
const DARK_VESSEL_FALLBACK = DARK_VESSEL_STYLE.ais_gap;
export const DARK_VESSEL_ORDER = ["ais_gap", "sts_pair"];

export function darkVesselStyle(kind) {
  return themedStyle(DARK_VESSEL_STYLE[kind] || DARK_VESSEL_FALLBACK, "darkVessels");
}

export function darkVesselIconSize(d) {
  // The *shipped* size, not darkVesselStyle()'s -- that one has already been
  // through scaledSize, and putting it through a second time squared every
  // multiplier, so a global icon size of 1.5 drew these hulls at 2.25x.
  const base = (DARK_VESSEL_STYLE[d?.kind] || DARK_VESSEL_FALLBACK).size || 22;
  // A designated hull is why anyone turned this layer on; it gets the larger
  // pin so it is findable among the ordinary gaps.
  return scaledSize(
    base * (d.sanctions ? 1.25 : 1),
    "darkVessels",
    (DARK_VESSEL_STYLE[d?.kind] || DARK_VESSEL_FALLBACK).token
  );
}

// What Global Fishing Watch has recorded about this *hull*, which is a
// different claim from anything on the record it is attached to. Their gaps
// batch runs five or more days behind and our AIS history is three days deep,
// so the two can never describe the same event -- the wording below has to keep
// saying so, because a reader who took it for confirmation would be reading a
// five-day-old fact as a live one. See backend/sources/gfw_gaps.py.
function gfwPriorDetail(prior) {
  if (!prior || !prior.events) return "";
  const intentional = Number(prior.intentional_events) || 0;
  const events = Number(prior.events) || 0;
  const when = prior.last_gap_at ? ` Most recent ${esc(timeAgoFromUnix(prior.last_gap_at))}.` : "";
  const call = intentional
    ? `<b>${intentional} of ${events}</b> judged deliberate by Global Fishing Watch.`
    : `None of the ${events} judged deliberate by Global Fishing Watch.`;
  return `
    <div class="prior-block">
      <div>This hull has ${events === 1 ? "one earlier" : `${events} earlier`} AIS
        ${events === 1 ? "disappearance" : "disappearances"} on record. ${call}${when}</div>
      <div class="meta">A separate organisation's record of this vessel &mdash; <b>not</b> a second
        sighting of the event above. Their data runs about five days behind, so it cannot describe
        the same gap.</div>
    </div>`;
}

function gfwPriorCredit(prior) {
  if (!prior || !prior.events) return "";
  return `<div class="meta">Prior from: Global Fishing Watch AIS disabling events (CC BY-NC 4.0)</div>`;
}

function decorateAisGap(d) {
  const vessel = d.name || `MMSI ${d.mmsi}`;
  const tooltip = `<b>${esc(vessel)}</b> &middot; went dark<br/>` +
    `${esc(d.gap_hours)} h silent &middot; reappeared ${esc(d.resumed_km_away)} km away`;
  // An implied speed a merchant hull cannot make is the one number here that
  // rules out the innocent explanation, so it is called out rather than listed.
  const impossible = Number(d.implied_speed_kn) > 25;
  const detail = `
    <h3>${esc(vessel)}</h3>
    <div class="meta">MMSI ${esc(d.mmsi)}${d.imo ? ` &middot; IMO ${esc(d.imo)}` : ""}</div>
    ${sanctionDetail(d)}
    <div class="inferred-block">
      <div><b>${esc(d.gap_hours)} hours</b> with no position reported.</div>
      <div>Reappeared ${esc(d.resumed_km_away)} km away, implying ${esc(d.implied_speed_kn)} knots${
        impossible ? " &mdash; faster than a merchant vessel makes" : ""
      }.</div>
      <div class="meta">Last heard ${esc(timeAgoFromUnix(d.went_dark_at))}, back ${esc(timeAgoFromUnix(d.resumed_at))}.</div>
    </div>
    ${gfwPriorDetail(d.gfw_prior)}
    <p class="meta"><b>This is an inference from our own AIS history, not a detection.</b> A receiver or
      upstream outage produces the identical signature; gaps spanning a measured drop in our own feed are
      suppressed, but thin coverage offshore is not something that check can fix.</p>
    <div class="meta">Derived from: aisstream.io position history recorded by this backend</div>
    ${gfwPriorCredit(d.gfw_prior)}`;
  return { tooltip, detail };
}

function decorateStsPair(d) {
  const vessels = d.vessels || [];
  const names = vessels.map((v) => v.name || `MMSI ${v.mmsi}`);
  const tooltip = `<b>Possible ship-to-ship transfer</b><br/>${esc(names.join(" + "))}<br/>` +
    `${esc(d.separation_m)} m apart for ${esc(d.together_hours)} h`;
  const detail = `
    <h3>Possible ship-to-ship transfer</h3>
    ${sanctionDetail(d)}
    <div class="inferred-block">
      <div>${esc(d.separation_m)} m apart, both under way at almost zero speed, for <b>${esc(d.together_hours)} hours</b>.</div>
      <ul class="coverage-list">
        ${vessels.map((v) => `<li>${esc(v.name || "Unknown vessel")} &middot; MMSI ${esc(v.mmsi)}${
          v.imo ? ` &middot; IMO ${esc(v.imo)}` : ""
        }${v.sanctions ? ' <span class="sanction-flag">OFAC-designated</span>' : ""}${
          // Per vessel, not per pair: a transfer is between two hulls and only
          // one of them may carry a history.
          v.gfw_prior && v.gfw_prior.intentional_events
            ? ` <span class="prior-flag">${esc(v.gfw_prior.intentional_events)}&times; GFW disabling</span>`
            : ""
        }</li>`).join("")}
      </ul>
    </div>
    <p class="meta"><b>This is an inference, not a detection.</b> Two vessels close together may be rafted for
      a pilot transfer, waiting out weather, or sitting in an anchorage this map does not know about &mdash;
      only a small curated list of ports is excluded, so an unlisted anchorage will appear here.</p>
    <div class="meta">Derived from: aisstream.io position history recorded by this backend</div>
    ${gfwPriorCredit(vessels.map((v) => v.gfw_prior).find((p) => p && p.events))}`;
  return { tooltip, detail };
}

export function decorateDarkVessel(d, { offset } = {}) {
  const style = darkVesselStyle(d.kind);
  const { tooltip, detail } = d.kind === "sts_pair" ? decorateStsPair(d) : decorateAisGap(d);
  const color = d.sanctions ? paletteColor("sanctions.designated", SANCTION_COLOR) : style.color;
  return {
    icon: icon(
      style.svg,
      color,
      darkVesselIconSize(d),
      0,
      `dark-vessel-marker dark-${esc(d.kind || "unknown")}`,
      0.9 * layerOpacity("darkVessels"),
      "inferred",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- Global Fishing Watch: AIS disabling (backend/sources/gfw_gaps.py) --
//
// The independent second opinion on the layer above, and the reason both exist:
// that one is derived from a single AIS upstream, so when the upstream stops it
// does not degrade, it inverts -- no feed means no gaps means an empty layer
// that looks like calm water. This one has no such coupling.
//
// Both claims in a record here are Global Fishing Watch's: that a transmission
// stopped, measured against *their* satellite reception, and that the stop was
// deliberate, inferred by their published methodology. This map asserts neither.
// It reports that they assert them, and the popup has to keep saying so.
export const GFW_GAP_STYLE = {
  svg: SVG.aisDisabling, color: "#c084fc", size: 20,
  label: "AIS disabling (Global Fishing Watch)", token: "gfw.gap",
};

export function gfwGapStyle() {
  return themedStyle(GFW_GAP_STYLE, "gfwGaps");
}

export function gfwGapIconSize() {
  return scaledSize(GFW_GAP_STYLE.size, "gfwGaps", GFW_GAP_STYLE.token);
}

export function decorateGfwGap(d, { offset } = {}) {
  const style = gfwGapStyle();
  const vessel = d.name || `MMSI ${d.mmsi}`;
  const age = Number.isFinite(Number(d.age_days)) ? Math.round(Number(d.age_days)) : null;
  const tooltip = `<b>${esc(vessel)}</b> &middot; AIS disabling (GFW)<br/>` +
    `${esc(d.gap_hours)} h dark${age !== null ? ` &middot; ${esc(age)} days ago` : ""}`;
  const detail = `
    <h3>${esc(vessel)}</h3>
    <div class="meta">MMSI ${esc(d.mmsi)}${d.flag ? ` &middot; flag ${esc(d.flag)}` : ""}${
      d.vessel_type ? ` &middot; ${esc(d.vessel_type)}` : ""
    }</div>
    <div class="inferred-block">
      <div><b>${esc(d.gap_hours)} hours</b> with no AIS position, as Global Fishing Watch heard it.</div>
      <div>Went quiet ${esc(timeAgoFromUnix(d.went_dark_at))}${
        d.resumed_at ? `, back ${esc(timeAgoFromUnix(d.resumed_at))}` : ""
      }.</div>
      ${Number.isFinite(Number(d.distance_km))
        ? `<div>Reappeared ${esc(fmtNumber(Number(d.distance_km)))} km away, implying
            ${esc(d.implied_speed_kn)} knots.</div>`
        : ""}
      ${Number.isFinite(Number(d.positions_per_day_sat))
        ? `<div class="meta">GFW normally hears this hull about
            ${esc(Math.round(Number(d.positions_per_day_sat)))} times a day by satellite.</div>`
        : ""}
      ${Number.isFinite(Number(d.distance_from_shore_km))
        ? `<div class="meta">${esc(Math.round(Number(d.distance_from_shore_km)))} km from shore${
            Number.isFinite(Number(d.distance_from_port_km))
              ? `, ${esc(Math.round(Number(d.distance_from_port_km)))} km from the nearest port`
              : ""
          } when it stopped.</div>`
        : ""}
    </div>
    <p class="meta"><b>Global Fishing Watch calls this a deliberate disabling. This map does not
      &mdash; it reports that they do.</b> Their reception model, not ours, is what separates a
      transponder switched off from a receiver that could not hear it; we have no such model.</p>
    <p class="meta"><b>${age !== null ? `This is ${esc(age)} days old and cannot` : "This cannot"}
      describe anything happening now.</b> GFW's gaps batch runs five or more days behind, and this
      map's own AIS history is three days deep &mdash; the two windows do not overlap, so nothing on
      the Dark Vessels layer is the same event as this, and neither confirms the other.</p>
    <div class="meta">Source: ${esc(d.publisher || "Global Fishing Watch")} &mdash; AIS disabling
      events${d.license ? ` (${esc(d.license)})` : ""}. A machine-derived finding by the publisher,
      not a measurement by this app.${d.attribution ? `<br/>${esc(d.attribution)}` : ""}</div>`;
  return {
    icon: icon(
      style.svg,
      style.color,
      gfwGapIconSize(d),
      0,
      "gfw-gap-marker",
      0.9 * layerOpacity("gfwGaps"),
      // Every record carries inferred: True from the backend, which states the
      // renderer contract explicitly. This is the honouring of it.
      "inferred",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- Global Fishing Watch: satellite detections (gfw_detections.py) ----
//
// The first thing in this map's maritime stack entitled to say *detected*.
// Everything else at sea is either a broadcast a vessel chose to make or an
// inference drawn from the shape of what it stopped broadcasting; a radar or
// optical return is neither.
//
// Two claims are stacked in every record and must not merge. That a hull was at
// this point at this time is a measurement. That it was not broadcasting AIS is
// GFW's inference from correlating the return against AIS tracks. The glyph
// carries the first (solid, no ring); the second lives in an inferred-block
// inside the popup, where it is attributed.
export const GFW_DETECTION_STYLE = {
  unmatched: {
    // The same dashed ring an aircraft whose operator asked not to be listed
    // wears, and for the same reason: present, and not in the public
    // transponder picture. Reused rather than reinvented so the two read as one
    // idea across two domains.
    svg: SVG.hullDetection + SVG.hiddenRing, color: "#ff3ea5", size: 17,
    label: "Satellite detection, no AIS match", token: "gfw.unmatched",
  },
  matched: {
    svg: SVG.hullDetection, color: "#8aa0ad", size: 13,
    label: "Satellite detection, matched to AIS", token: "gfw.matched",
  },
};
export const GFW_DETECTION_ORDER = ["unmatched", "matched"];

export function gfwDetectionStyle(d) {
  return themedStyle(
    d?.matched ? GFW_DETECTION_STYLE.matched : GFW_DETECTION_STYLE.unmatched,
    "gfwDetections"
  );
}

export function gfwDetectionIconSize(d) {
  return gfwDetectionStyle(d).size;
}

const GFW_SENSOR_LABEL = { sar: "Radar (SAR)", optical: "Optical (Sentinel-2)" };

export function decorateGfwDetection(d, { offset } = {}) {
  const style = gfwDetectionStyle(d);
  const sensor = GFW_SENSOR_LABEL[(d.sensor || "").toLowerCase()] || d.sensor || "Sensor not stated";
  const age = Number.isFinite(Number(d.age_days)) ? Math.round(Number(d.age_days)) : null;
  const heading = d.matched ? "Vessel detected" : "Unmatched vessel detection";
  const tooltip = `<b>${esc(heading)}</b><br/>${esc(sensor)}${
    age !== null ? ` &middot; ${esc(age)} days ago` : ""
  }`;
  const detail = `
    <h3>${esc(heading)}</h3>
    <div class="meta">${esc(sensor)}${
      d.time ? ` &middot; scene acquired ${esc(utcClockFromUnix(d.time))}` : ""
    }${age !== null ? `, ${esc(age)} days ago` : ""}</div>
    <div>A hull was at this point when the instrument looked. <b>That much is a measurement.</b></div>
    ${d.matched
      ? `<div>Global Fishing Watch matched it to a known AIS transmitter${
          d.vessel_id ? ` (vessel ${esc(d.vessel_id)})` : ""
        }.</div>`
      : '<div class="inferred-block"><b>Not matched to any AIS transmitter</b> &mdash; Global ' +
        "Fishing Watch's conclusion, not this map's. It does not mean the transponder was off: it " +
        "means their correlation found nothing to pair this return with.</div>"}
    ${d.match_basis ? `<div class="meta">Matching basis: ${esc(d.match_basis)}</div>` : ""}
    <p class="meta"><b>Empty water on this layer is not evidence of empty water.</b> There is no
      coverage or footprint dataset in the API, so this map cannot tell "imaged, nothing there" from
      "not imaged at all". Never read a gap here the way you would read an AIS gap.</p>
    <p class="meta">${age !== null ? `This scene is <b>${esc(age)} days old</b>` : "This scene is not live"}${
      Number.isFinite(Number(d.dataset_lag_days))
        ? ` and this product was running ${esc(Math.round(Number(d.dataset_lag_days)))} days behind when it was swept`
        : ""
    }. It is drawn beside live AIS and is not live.</p>
    <div class="meta">Source: ${esc(d.publisher || "Global Fishing Watch")} &mdash; satellite vessel
      presence${d.license ? ` (${esc(d.license)})` : ""}. Direct measurement (the detection);
      the publisher's inference (the AIS match).${
        d.attribution ? ` ${esc(d.attribution)}` : ""
      }${
        d.source_url
          ? ` <a href="${esc(d.source_url)}" target="_blank" rel="noopener noreferrer">Methodology</a>.`
          : ""
      }</div>`;
  return {
    icon: icon(
      style.svg,
      style.color,
      gfwDetectionIconSize(d),
      0,
      `gfw-detection-marker gfw-detection-${d.matched ? "matched" : "unmatched"}`,
      layerOpacity("gfwDetections"),
      // No uncertainty class. The detection's coordinate is the most precise
      // thing on the maritime map -- the doubt is entirely about the AIS match,
      // and that belongs in the popup where it can be attributed, not on the
      // icon where it would read as doubt about the position.
      "",
      offset
    ),
    tooltip,
    detail,
  };
}

// ---------- ADS-B aircraft ----------

// Best-effort only: OpenSky has no "military" field. This flags common
// military/government callsign prefixes and otherwise falls back to the
// ADS-B emitter category. Never treat this as confirmed identification.
export function classifyAircraft(d) {
  // Two independent claims, both answered by the record rather than worked out
  // here. `military` is a real flag (airplanes.live's dbFlags) about the
  // airframe; `callsign_military` is what the aircraft is calling itself on
  // this flight, which is the only signal OpenSky-only records carry.
  //
  // The callsign prefix list used to live in this file. It moved to
  // backend/sources/adsb.py when /api/aircraft gained ?civilian=0: the server
  // now decides which aircraft a zoomed-out reader is sent, and a client
  // holding a *wider* idea of "military" than the server would classify
  // aircraft the server had already dropped -- they would be missing from the
  // map with nothing to indicate it. One list, on the side that filters.
  if (d.military === true || d.callsign_military === true) return "military";
  if (d.category === 8) return "helicopter";
  if ([2, 3, 9, 10, 12].includes(d.category)) return "other";
  if ([4, 5, 6, 7].includes(d.category)) return "commercial";
  const cs = (d.callsign || "").trim().toUpperCase();
  if (/^[A-Z]{2,3}\d{2,4}[A-Z]?$/.test(cs)) return "commercial"; // airline-style callsign
  return "other";
}

// Exported so webglLayer.js's sprite texture cache draws from the same
// source of truth decorateAdsb below uses for its divIcon.
export const AIRCRAFT_STYLE = {
  military: { svg: SVG.planeMilitary, color: "#ff4d4d", size: 19, label: "Military", name: "plane-military", token: "aircraft.military" },
  helicopter: { svg: SVG.helicopter, color: "#9be15d", size: 16, label: "Helicopter", name: "plane-helicopter", token: "aircraft.helicopter" },
  commercial: { svg: SVG.planeCommercial, color: "#d8b9ff", size: 15, label: "Commercial / airline", name: "plane-commercial", token: "aircraft.commercial" },
  other: { svg: SVG.planeOther, color: "#8aa0ad", size: 13, label: "General aviation / other", name: "plane-other", token: "aircraft.other" },
};

/** Which layer key an aircraft class belongs to -- its opacity/scale settings. */
export const AIRCRAFT_LAYER_KEY = {
  military: "adsbMilitary", helicopter: "adsbCivilian", commercial: "adsbCivilian", other: "adsbCivilian",
};

const MILITARY_ROLE_LABEL = {
  tanker: "Aerial refueling tanker",
  bomber: "Bomber",
  fighter: "Fighter jet",
  awacs: "AWACS / airborne early warning",
  recon: "Reconnaissance",
  patrol: "Maritime patrol",
  drone: "Unmanned / drone",
  trainer: "Trainer",
  transport: "Transport",
  helicopter: "Military helicopter",
};

// Per-role military glyphs -- military_role (see MILITARY_ROLE_LABEL above,
// backend/sources/adsb.py's own role heuristic) picks a distinct silhouette
// instead of every military aircraft sharing one generic plane icon.
// AIRCRAFT_STYLE.military (SVG.planeMilitary) stays the fallback for
// d.military===true/heuristic hits with no role guessed.
//
// Sizes were 24-30px against 16 for an airliner and 13 for general aviation,
// which made a single tanker visually outweigh a whole airport and left the
// military layer dominating every view it appeared in. They now run 15-21,
// so a bomber is still the biggest aircraft on the map and still reads as
// bigger than an airliner -- the ordering is the information, not the absolute
// size. Both renderers take these numbers (webglLayer.js's sprite cache keys
// on style.size, and it also drives declutter's spacing), so this is the one
// place to change them.
// `label` is the short legend caption; MILITARY_ROLE_LABEL above is the long
// form the popup prints. The control panel maps straight over this object, so
// a role added here appears in the legend without a second edit -- the legend
// used to restate every svg and colour by hand, which is exactly how the cities
// swatch drifted a whole row out of step with the map.
export const MILITARY_ROLE_STYLE = {
  fighter: { svg: SVG.planeFighter, color: "#ff4d4d", size: 19, label: "Fighter", name: "plane-military-fighter" },
  bomber: { svg: SVG.planeBomber, color: "#ff4d4d", size: 21, label: "Bomber", name: "plane-military-bomber" },
  tanker: { svg: SVG.planeTanker, color: "#ff8c3a", size: 19, label: "Tanker", name: "plane-military-tanker" },
  awacs: { svg: SVG.planeAwacs, color: "#ffd60a", size: 20, label: "AWACS", name: "plane-military-awacs" },
  recon: { svg: SVG.planeRecon, color: "#d8b9ff", size: 18, label: "Recon", name: "plane-military-recon" },
  patrol: { svg: SVG.planePatrol, color: "#6fe3ff", size: 19, label: "Patrol", name: "plane-military-patrol" },
  drone: { svg: SVG.planeDrone, color: "#9be15d", size: 15, label: "Drone", name: "plane-military-drone" },
  // Trainers are the most numerous military type in the air on any given day
  // and the least consequential, so they sit at the bottom of the size range.
  trainer: { svg: SVG.planeTrainer, color: "#c9b6ff", size: 15, label: "Trainer", name: "plane-military-trainer" },
  transport: { svg: SVG.planeTransport, color: "#8aa0ad", size: 18, label: "Transport", name: "plane-military-transport" },
  helicopter: { svg: SVG.helicopter, color: "#ff4d4d", size: 16, label: "Helicopter", name: "plane-military-helicopter" },
};

// Legend order: combat first, then support, then the numerous-but-routine.
// Explicit rather than Object.keys so reordering the styles above for any other
// reason cannot silently reshuffle the panel.
export const MILITARY_ROLE_ORDER = [
  "fighter", "bomber", "tanker", "awacs", "recon", "patrol",
  "drone", "transport", "helicopter", "trainer",
];

// ---------- aircraft status: emergencies and display-limited programmes ----
//
// Two things the backend now reads that are about an aircraft's *status* rather
// than its position or its type (see backend/sources/adsb.py): the reserved
// emergency squawks, and the two programmes an operator can use to keep an
// aircraft out of public feeds. Both are rare, both outrank whatever else the
// aircraft is, and both get their own always-on layer for that reason -- a
// hijack squawk on a civil airliner must not be hidden by the civilian toggle.
export const AIRCRAFT_FLAG_STYLE = {
  sanctioned: {
    ring: SVG.sanctionRing,
    color: SANCTION_COLOR,
    suffix: "-sanctioned",
    countKey: "adsbSanctioned",
    label: "OFAC-designated airframe",
  },
  emergency: {
    ring: SVG.alertRing,
    color: "#ff1a1a",
    suffix: "-emergency",
    countKey: "adsbEmergency",
    label: "Emergency squawk (7500/7600/7700)",
  },
  displayLimited: {
    ring: SVG.hiddenRing,
    color: "#c9b6ff",
    suffix: "-hidden",
    countKey: "adsbHidden",
    label: "Display-limited (LADD / PIA)",
  },
};
// Most consequential first, which is also the precedence aircraftFlagBucket
// applies -- so the legend reads in the same order the buckets resolve.
export const AIRCRAFT_FLAG_ORDER = ["sanctioned", "emergency", "displayLimited"];

/** Which status flag an aircraft carries, most urgent first, or null. */
export function aircraftFlag(d) {
  if (d?.emergency || d?.emergency_squawk) return "emergency";
  if (d?.display_limited) return "displayLimited";
  return null;
}

/** Whether an aircraft belongs in the always-on flagged bucket. A designation
 *  qualifies on its own: an OFAC-listed airframe is usually a civil registration
 *  and would otherwise sit in the layer that is off by default. */
export function isFlaggedAircraft(d) {
  return aircraftFlagBucket(d) !== null;
}

/**
 * Which single sub-ticker an aircraft counts towards, or null.
 *
 * One aircraft can carry several of these at once (a designated airframe
 * squawking 7700 is exactly the case worth seeing), so the buckets are ordered
 * and exclusive rather than overlapping -- otherwise the sub-ticker counts
 * would sum to more than the layer's own total and the panel would look broken.
 * The precedence matches the ring the marker actually wears (see
 * withAircraftFlag), so the count and the glyph can never disagree.
 */
export function aircraftFlagBucket(d) {
  if (isSanctioned(d)) return "sanctioned";
  return aircraftFlag(d);
}

/**
 * A base aircraft style with its status ring applied.
 *
 * Returns a distinct `name` so webglLayer's texture cache (keyed on
 * name|color|size) treats the ringed variant as its own texture rather than
 * repainting the plain one. The airframe glyph is kept underneath: the ring
 * says what is happening, the silhouette still says what it is.
 */
export function withAircraftFlag(style, d) {
  const flag = aircraftFlag(d);
  // An OFAC designation outranks both: it is the rarest thing on this map and
  // the only one that says something about who the aircraft belongs to rather
  // than what it is doing this minute.
  if (isSanctioned(d)) return withSanctionRing(style);
  if (!flag) return style;
  const { ring, color, suffix } = AIRCRAFT_FLAG_STYLE[flag];
  return {
    ...style,
    svg: `${style.svg}${ring}`,
    // An emergency recolours the whole glyph -- it is the one status worth
    // taking the colour channel for. A display-limited aircraft keeps its own
    // colour and only gains the dashed outline, because "quietly listed" is
    // not "in trouble".
    color: flag === "emergency" ? color : style.color,
    size: (style.size || 16) + 5, // room for the ring, or it clips the wingtips
    name: `${style.name || "plane"}${suffix}`,
  };
}

const AIRCRAFT_FLAG_NOTE = {
  emergency:
    "Reserved emergency transponder codes: 7500 unlawful interference, 7600 radio failure, 7700 general " +
    "emergency. Squawks are occasionally set by mistake and cleared moments later &mdash; this is what the " +
    "aircraft is broadcasting, not a confirmed incident.",
  displayLimited:
    "The operator has asked for this aircraft to be limited in public feeds, or it is flying under a " +
    "rotating temporary address. airplanes.live publishes it anyway. That request is a fact about the " +
    "registry entry and says nothing about the flight itself.",
};

export function decorateAdsb(d, { selectedIcao } = {}) {
  const type = classifyAircraft(d);
  const base = (type === "military" && d.military_role && MILITARY_ROLE_STYLE[d.military_role]) || AIRCRAFT_STYLE[type];
  const style = withAircraftFlag(themedStyle(base, AIRCRAFT_LAYER_KEY[type]), d);
  const label = type === "military" ? (d.military === true ? "Military (confirmed)" : "Military (heuristic)") : style.label;
  // airplanes.live supplies a real type/description for aircraft it has
  // reference data for -- OpenSky has no such field at all, so this is
  // only ever present some of the time (see backend/sources/adsb.py).
  const hasRealType = !!(d.type_desc && d.type_desc.trim());
  const roleLabel = d.military_role ? MILITARY_ROLE_LABEL[d.military_role] : null;
  const aircraftLine = hasRealType ? `${d.type_desc}${roleLabel ? ` (${roleLabel})` : ""}` : null;
  const flag = aircraftFlag(d);
  // The two emergency signals are independent (see backend/sources/adsb.py):
  // the squawk is a code the aircraft is transmitting, the decoded status is a
  // separate transponder field only newer units send. Naming both, when both
  // are present, is the difference between "it says 7700" and "we inferred".
  const emergencyLine = [
    d.emergency_squawk ? `squawk ${esc(d.squawk)} &mdash; ${esc(d.emergency_squawk)}` : null,
    d.emergency ? `transponder reports ${esc(d.emergency)}` : null,
  ].filter(Boolean).join("; ");
  const airfield = d.nearest_airfield;
  const tooltip = `<b>${esc(d.callsign || d.icao24)}</b>${aircraftLine ? ` &middot; ${esc(aircraftLine)}` : ` &middot; ${esc(label)}`}` +
    `${emergencyLine ? `<br/><span class="aircraft-emergency">${emergencyLine}</span>` : ""}` +
    `<br/>${esc(d.origin_country || "")}<br/>Alt ${esc(Math.round(d.altitude || 0))} m &middot; ${esc(Math.round((d.velocity || 0) * 3.6))} km/h` +
    lastPingTooltip(d.updated);
  const detail = `
    <h3>${esc(d.callsign || d.icao24)}</h3>
    ${emergencyLine ? `<div class="aircraft-emergency"><b>Emergency:</b> ${emergencyLine}</div>` : ""}
    ${sanctionDetail(d)}
    ${aircraftLine ? `<div class="meta">Aircraft: ${esc(aircraftLine)}</div>` : ""}
    <div class="meta">Type: ${esc(label)} &middot; ${esc(d.origin_country || "")} &middot; ICAO24 ${esc(d.icao24)}</div>
    ${d.registration ? `<div>Registration: ${esc(d.registration)}</div>` : ""}
    ${d.operator ? `<div>Operator: ${esc(d.operator)}</div>` : ""}
    <div>Altitude: ${esc(Math.round(d.altitude || 0))} m</div>
    <div>Ground speed: ${esc(Math.round((d.velocity || 0) * 3.6))} km/h</div>
    <div>On ground: ${d.on_ground ? "yes" : "no"}</div>
    ${lastPingDetail(d.updated)}
    ${d.squawk && !d.emergency_squawk ? `<div>Squawk: ${esc(d.squawk)}</div>` : ""}
    ${d.display_limited ? `<div class="meta">Listed as: ${esc(d.display_limited_note || d.display_limited)}</div>` : ""}
    ${airfield
      ? `<div>Nearest airfield: ${esc(airfield.name)}${airfield.code ? ` (${esc(airfield.code)})` : ""} &middot; ${esc(airfield.km)} km` +
        `${airfield.military_name ? " &middot; military by name" : ""}</div>` +
        '<p class="meta">Nearest airfield is our own proximity lookup against the OurAirports index, not a ' +
        "filed origin or destination. Only shown below 10,000 ft or on the ground, where it means something.</p>"
      : ""}
    ${hasRealType
      ? '<p class="meta">Aircraft type/description from airplanes.live reference data.</p>'
      : '<p class="meta">Aircraft type is a best-effort guess from callsign pattern and ADS-B category when no confirmed source flag is available.</p>'}
    ${flag ? `<p class="meta">${AIRCRAFT_FLAG_NOTE[flag]}</p>` : ""}
    <div class="meta">Source: OpenSky Network + airplanes.live (ADS-B)${
      airfield ? " &middot; airfields: OurAirports" : ""
    }</div>`;
  let cls = "aircraft-marker";
  if (type === "military") cls += " military-marker";
  if (flag) cls += ` aircraft-flagged aircraft-${flag === "emergency" ? "emergency" : "hidden"}`;
  if (isSanctioned(d)) cls += " aircraft-flagged sanctioned-marker";
  if (d.icao24 === selectedIcao) cls += " selected";
  return { icon: icon(style.svg, style.color, style.size, d.heading, cls, style.opacity), tooltip, detail };
}

// ---------- airfields (backend/sources/airports.py) ----------

// Reference context, not a feed: these do not move and nothing about them is
// live, so they are drawn quietly and sized by how much traffic the field
// actually takes. The three tiers used to share one glyph and differ only in
// size, which told a reader nothing unless two fields happened to be adjacent;
// each now draws its own runway layout (see svgIcons.js). Exported for the
// control panel's legend.
export const AIRFIELD_STYLE = {
  large_airport: { svg: SVG.airfieldLarge, size: 17, label: "Large airport", token: "airfield.civil", color: "#7f93a8" },
  medium_airport: { svg: SVG.airfield, size: 14, label: "Medium airport", token: "airfield.civil", color: "#7f93a8" },
  // A point bigger than the old 11: the strip carries no surrounding circle,
  // so it needs the extra length to stay a runway rather than a tick mark.
  small_airport: { svg: SVG.airfieldSmall, size: 12, label: "Small airfield", token: "airfield.civil", color: "#7f93a8" },
};
const AIRFIELD_FALLBACK = AIRFIELD_STYLE.small_airport;
// Its own colour, because "which of these is military" is the whole reason an
// aircraft-watcher turns this layer on.
export const AIRFIELD_MILITARY_STYLE = {
  svg: SVG.airfieldMilitary, size: 17, label: "Military by name", token: "airfield.military", color: "#ff8c3a",
};
export const AIRFIELD_ORDER = ["large_airport", "medium_airport", "small_airport"];

export function airfieldStyle(d) {
  const base = d?.military_name ? AIRFIELD_MILITARY_STYLE : AIRFIELD_STYLE[d?.type] || AIRFIELD_FALLBACK;
  return themedStyle(base, "airports");
}

// How much bigger a field's glyph gets for the traffic we recorded at it.
//
// Log-scaled and capped: the busiest field in the window runs to ~780 aircraft
// against a long tail in single digits, so a linear factor would leave every
// field except a dozen hubs at its base size. Capped at +70% because this is a
// reference layer -- an airfield that dwarfs the conflict pins on top of it has
// stopped being context.
export function airfieldActivityScale(activity) {
  const count = activity?.aircraft;
  if (!Number.isFinite(count) || count <= 0) return 1;
  return 1 + Math.min(Math.log10(1 + count) / 4, 0.7);
}

export function airportIconSize(d, activity) {
  return Math.round(airfieldStyle(d).size * airfieldActivityScale(activity));
}

// 24 hourly counts as an inline SVG bar chart, the same technique the country
// card's fatality sparkline uses (see popups.js) and for the same reason: it is
// a handful of rects in a string the popup builder already returns, with no
// charting dependency and nothing to mount or tear down.
//
// Military movements are drawn as a second bar in front of the total rather
// than beside it, so the eye reads one column per hour and the military share
// as the filled part of it.
function airfieldSparkline(activity) {
  const hourly = activity?.hourly;
  if (!Array.isArray(hourly) || !hourly.some((v) => v > 0)) return "";
  const mil = Array.isArray(activity.hourly_military) ? activity.hourly_military : [];
  const peak = Math.max(...hourly, 1);
  const w = 6;
  const h = 26;
  const bars = hourly.map((v, i) => {
    const bh = Math.max(1, Math.round((v / peak) * h));
    const mh = Math.max(0, Math.round(((mil[i] || 0) / peak) * h));
    const x = i * w;
    return `<rect x="${x}" y="${h - bh}" width="${w - 1}" height="${bh}" fill="currentColor" opacity="0.45"/>`
      + (mh > 0 ? `<rect x="${x}" y="${h - mh}" width="${w - 1}" height="${mh}" fill="#ff8c3a"/>` : "");
  }).join("");
  return `<svg class="cspark" viewBox="0 0 ${hourly.length * w} ${h}" width="${hourly.length * w}" height="${h}"
    preserveAspectRatio="none" role="img" aria-label="Movements recorded per hour over the last 24 hours">${bars}</svg>`;
}

// What the numbers do and do not mean, stated wherever they are shown.
//
// These are movements *this system recorded*, which is not the same as
// movements that happened: ADS-B coverage is wherever its feeders are, and the
// collector itself has gaps (OpenSky rate-limits it). An empty hour is
// therefore "nothing reached us", not "nothing flew", and a field with no entry
// at all is one that did not rank rather than one that was quiet.
function airfieldActivityBlock(activity) {
  if (!activity) return "";
  const share = activity.aircraft
    ? Math.round((activity.military_aircraft / activity.aircraft) * 100)
    : 0;
  return `
    <div class="airfield-activity">
      <div class="sev-head">Recorded movements &middot; last ${activity.window_hours}h</div>
      ${airfieldSparkline(activity)}
      <div>${fmtNumber(activity.aircraft)} distinct aircraft${
        activity.military_aircraft
          ? ` &middot; <b>${fmtNumber(activity.military_aircraft)} military</b> (${share}%)`
          : ""
      }</div>
      <div class="meta">Counted from this app's own ADS-B log, not from a schedule. An empty hour means
        nothing reached us in it &mdash; coverage follows the receiver network, and the collector has
        its own gaps.</div>
    </div>`;
}

export function decorateAirport(d, { offset, activity } = {}) {
  const style = airfieldStyle(d);
  const code = d.icao || d.iata || d.id;
  const busy = activity?.aircraft
    ? `<br/>${fmtNumber(activity.aircraft)} aircraft in ${activity.window_hours}h${
        activity.military_aircraft ? ` &middot; ${fmtNumber(activity.military_aircraft)} military` : ""
      }`
    : "";
  const tooltip = `<b>${esc(d.name)}</b>${code ? ` &middot; ${esc(code)}` : ""}<br/>${esc(style.label)}${busy}`;
  const detail = `
    <h3>${esc(d.name)}</h3>
    <div class="meta">${esc(style.label)}${d.municipality ? ` &middot; ${esc(d.municipality)}` : ""}${
      d.country ? ` &middot; ${esc(d.country)}` : ""
    }</div>
    ${d.icao ? `<div>ICAO: ${esc(d.icao)}</div>` : ""}
    ${d.iata ? `<div>IATA: ${esc(d.iata)}</div>` : ""}
    <div>Scheduled airline service: ${d.scheduled_service ? "yes" : "no"}</div>
    ${airfieldActivityBlock(activity)}
    ${d.military_name
      ? '<p class="meta">Flagged military because its <b>name</b> says so (&ldquo;Air Base&rdquo;, &ldquo;RAF&rdquo;, ' +
        "&ldquo;AFB&rdquo; and similar). OurAirports has no military field, so this both misses civil-named " +
        "military fields and can over-reach &mdash; it is a reading of the name, nothing more.</p>"
      : ""}
    <div class="meta">Source: OurAirports (public domain)</div>`;
  return {
    icon: icon(
      style.svg, style.color, airportIconSize(d, activity), 0, "airfield-marker",
      0.8 * layerOpacity("airports"), "", offset
    ),
    tooltip,
    detail,
  };
}

// ---------- critical infrastructure ----------

// Exported so the control panel's per-type sub-ticker draws its swatch from the
// same object the map draws its pin from. It previously restated the colours by
// hand and had drifted a whole row out of step -- every type except Refineries
// advertised a colour that appears nowhere on the map.
export const INFRA_STYLE = {
  refinery: { svg: SVG.refinery, color: "#ff9500", label: "Refinery", token: "infra.refinery" },
  pipeline: { svg: SVG.pipeline, color: "#ffb347", label: "Pipeline", token: "infra.pipeline" },
  desalination: { svg: SVG.desalination, color: "#35c2ff", label: "Desalination plant", token: "infra.desalination" },
  lng_terminal: { svg: SVG.lng, color: "#9be15d", label: "LNG terminal", token: "infra.lng_terminal" },
  nuclear: { svg: SVG.nuclear, color: "#ffd60a", label: "Nuclear power plant", token: "infra.nuclear" },
  port: { svg: SVG.port, color: "#d8b9ff", label: "Port / oil terminal", token: "infra.port" },
  fab: { svg: SVG.fab, color: "#6fe3ff", label: "Semiconductor fab", token: "infra.fab" },
};

// The colour the pipeline *routes* are drawn in (see renderPipelines), which is
// a polyline rather than an INFRA_STYLE marker but still needs a legend entry
// that matches. It shares the pipeline node's palette token for exactly that
// reason: a recoloured node on a differently-coloured line would read as two
// unrelated things.
export const PIPELINE_ROUTE_COLOR = "#ffb347";

export function pipelineRouteColor() {
  return paletteColor("infra.pipeline", PIPELINE_ROUTE_COLOR);
}

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
  const style = themedStyle(infraBaseStyle(d), "infra");
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
  return {
    icon: icon(style.svg, style.color, infraIconSize(d), 0, cls, layerOpacity("infra"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- satellites ----------

// Keyed by CelesTrak's own group name (see backend/sources/satellites.py's
// GROUPS) -- military objects get their own glyph and colour instead of the
// whole layer sharing one cyan satellite pin, so "which of these is a
// reconnaissance bird" is answerable at a glance. Exported so
// LayersSection.jsx's legend and the map draw from the same values.
export const SATELLITE_STYLE = {
  stations: { svg: SVG.satellite, color: "#6fe3ff", size: 24, label: "Space station", token: "satellite.stations" },
  military: { svg: SVG.satelliteMilitary, color: "#ff4d4d", size: 26, label: "Military satellite", token: "satellite.military" },
};
const SATELLITE_FALLBACK = { svg: SVG.satellite, color: "#6fe3ff", size: 24, label: "Satellite", token: "satellite.stations" };

/** A satellite group's style with the current theme applied -- also what the
 *  controller's placement pass and trail colours read. */
export function satelliteStyle(group) {
  return themedStyle(SATELLITE_STYLE[group] || SATELLITE_FALLBACK, "satellites");
}

export function isMilitarySatellite(d) {
  return d.group === "military";
}

export function decorateSatellite(d, { offset } = {}) {
  const style = satelliteStyle(d.group);
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
  return {
    icon: icon(style.svg, style.color, style.size, 0, cls, layerOpacity("satellites"), "", offset),
    tooltip,
    detail,
  };
}

// ---------- which kind of pin is this? ----------

/**
 * The palette token one item resolves to, per layer.
 *
 * This is the same question the decorators above already answer on their way to
 * a colour and a size; it is asked separately here because Admin Mode's
 * per-pin-type zoom gate has to be answered *before* a marker is built, in the
 * loop that decides which items are drawn at all (see pinZoomGate in
 * createMapController.js). Every entry defers to the style picker the drawing
 * side uses rather than restating its test, so a pin cannot be gated as one
 * kind and drawn as another.
 *
 * Null means "this item has no configurable pin type", and it is a real answer
 * rather than a gap: a military base picks its glyph from MILITARY_SUBTYPE_STYLE
 * and a role-identified military aircraft from MILITARY_ROLE_STYLE, and neither
 * table carries a palette token, so neither appears in the panel and neither can
 * be given a gate. Hazards and floods have no token at all.
 */
export function aircraftToken(d) {
  const klass = classifyAircraft(d);
  if (klass !== "military") return AIRCRAFT_STYLE[klass]?.token ?? null;
  // A role picks its own silhouette and its own colour, so it is not the
  // "role unknown" swatch the panel offers -- see MILITARY_ROLE_STYLE.
  if (d?.military_role && MILITARY_ROLE_STYLE[d.military_role]) return null;
  return AIRCRAFT_STYLE.military.token;
}

export const TOKEN_FOR = {
  // A corroborated event is recoloured, not reclassified: event.corroborated
  // has no size and no gate of its own, so the severity band it would have
  // drawn as stays the pin type it is gated by.
  events: (d) => severityBand(d?.severity)?.token ?? null,
  conflictHistory: () => "event.history",
  gdelt: () => "news.pin",
  officials: officialsToken,
  cities: () => "city.marker",
  infra: (d) => infraBaseStyle(d)?.token ?? null,
  satellites: (d) => (isMilitarySatellite(d) ? "satellite.military" : "satellite.stations"),
  aisNavy: () => "ship.navy",
  aisTanker: () => "ship.tanker",
  aisCivilian: () => "ship.other",
  adsbMilitary: aircraftToken,
  adsbCivilian: aircraftToken,
  adsbFlagged: aircraftToken,
  airports: (d) => (d?.military_name ? "airfield.military" : "airfield.civil"),
  darkVessels: (d) => (DARK_VESSEL_STYLE[d?.kind] || DARK_VESSEL_FALLBACK).token,
  gfwGaps: () => "gfw.gap",
  gfwDetections: (d) => (d?.matched ? "gfw.matched" : "gfw.unmatched"),
  czib: (d) => (d?.active ? "czib.active" : "czib.withdrawn"),
  ports: () => "port.wpi",
  dams: () => "dam.barrier",
  launches: (d) => (d?.upcoming ? "launch.upcoming" : "launch.flown"),
  cableLandings: (d) => (d?.planned ? "cable.planned" : "cable.landing"),
  osmInfra: (d) => OSM_INFRA_STYLE[d?.kind]?.token ?? null,
};
