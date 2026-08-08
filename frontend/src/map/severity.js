import { parseGdeltDateAdded } from "../utils/format";
import { paletteColor } from "./iconTheme";

// The one severity scale.
//
// This lived in four places -- decorators.js (hex), NotableEventsPanel.jsx (CSS
// class names), LayersSection.jsx (legend swatches), and style.css (chip
// backgrounds) -- and they had already started to drift. CSS cannot import JS,
// so the chip and legend colours are now applied inline from these objects,
// which is the only way to make one definition genuinely authoritative.
//
// Scores come from backend/sources/event_fusion.py's _severity_for.

// `color` is the shipped default; `token` is the palette entry Admin Mode can
// override (see map/iconTheme.js). Always read a band's colour through
// severityColor() below rather than off `.color` -- reading the field directly
// is what would put the map's pins and a panel's chips back out of step, which
// is the exact drift this module was created to end.
// One hue, four lightnesses. This ramp used to run red -> orange -> yellow, and
// that was a real cost paid for a real gain: four bands are easier to tell apart
// across a hue sweep than down a single hue. What it bought was not worth what
// it spent, because the two colours it borrowed both mean something else on this
// map -- orange is what a regulator's airspace warning is drawn in, and yellow
// is a navy hull. A reader glancing at an amber pin had no way to know whether
// they were looking at a moderate incident, a warning or a warship.
//
// So violence is red, always, and severity is carried by how bright the red is.
// The distinction survives because colour was never carrying it alone: the pin
// is also sized 13-31px from the same score (see eventIconSize), and the band
// cap at world zoom already keeps the most severe first. Colour now answers
// "what kind of thing is this" before it answers "how bad", which is the order a
// reader actually asks them in.
//
// Not a darkening ramp into black: #7f1d1d is the floor because anything below
// it stops being separable from the dark basemap, and a low-severity event that
// cannot be seen at all is a different editorial act from one drawn quietly.
export const SEVERITY_BANDS = [
  { min: 75, key: "critical", label: "Critical", color: "#ff1a1a", token: "severity.critical" },
  { min: 55, key: "high", label: "High", color: "#e03131", token: "severity.high" },
  { min: 40, key: "moderate", label: "Moderate", color: "#b02525", token: "severity.moderate" },
  { min: 0, key: "low", label: "Low", color: "#7f1d1d", token: "severity.low" },
];

// Corroboration keeps its own colour: "independently confirmed" is a different
// axis from "how bad", and both are worth reading at a glance.
export const CORROBORATED_COLOR = "#3ac1ff";

// --- reliability -------------------------------------------------------
//
// Who is behind the report, as opposed to how big the report is. Scored by
// backend/sources/reliability.py; these are only the words and colours.
//
// This exists because the popup's "How much to trust this" panel was drawing
// the *severity* bar, and the two are not the same question. A mass-casualty
// claim from a domain nobody has heard of scores high on severity for exactly
// the reason it should score low here, and a reader had no way to tell those
// apart -- the bar said the same thing in both cases.
//
// The green/amber/orange/red ramp is deliberately not the severity ramp's
// yellow-to-red: two bars stacked in one popup that shared a colour language
// would read as one measurement drawn twice.
export const RELIABILITY_BANDS = [
  { min: 70, key: "high", label: "Reliable", color: "#3ddc84", token: "reliability.high" },
  { min: 45, key: "medium", label: "Mixed", color: "#ffd11a", token: "reliability.medium" },
  { min: 25, key: "low", label: "Weak", color: "#ff9500", token: "reliability.low" },
  { min: 0, key: "very_low", label: "Unreliable", color: "#ff4d4d", token: "reliability.veryLow" },
];

// The backend's own band name is authoritative: it is what the screen in
// reliability.py gates on, so a threshold that drifted here would let the map
// call something "Mixed" that the backend was busy deleting. The numeric
// fallback is for records archived before the field shipped, which replay can
// still hand us.
export function reliabilityBand(item) {
  const named = RELIABILITY_BANDS.find((b) => b.key === item?.reliability_band);
  if (named) return named;
  const score = Number.isFinite(item?.reliability) ? item.reliability : null;
  if (score === null) return null;
  return RELIABILITY_BANDS.find((b) => score >= b.min) || RELIABILITY_BANDS[RELIABILITY_BANDS.length - 1];
}

export function reliabilityColor(band) {
  return paletteColor(band?.token, band?.color);
}

// The two bottom bands -- the ones the backend's screen looks at, and the ones
// worth saying on hover rather than only on click. A reader scanning a busy map
// should not have to open a pin to find out that nothing vouches for it.
const WEAK_BANDS = new Set(["low", "very_low"]);

export function reliabilityWeak(item) {
  const band = reliabilityBand(item);
  return !!band && WEAK_BANDS.has(band.key);
}

export function severityBand(severity) {
  const score = Number.isFinite(severity) ? severity : 0;
  return SEVERITY_BANDS.find((b) => score >= b.min) || SEVERITY_BANDS[SEVERITY_BANDS.length - 1];
}

/** A band's current colour, honouring any Admin Mode override. */
export function severityColor(band) {
  return paletteColor(band?.token, band?.color);
}

/** The corroboration blue, honouring any Admin Mode override. */
export function corroboratedColor() {
  return paletteColor("event.corroborated", CORROBORATED_COLOR);
}

// How precisely an event is placed, from the backend's geo_precision field.
// "country" means the coordinate is a national centroid and the real location
// is unknown -- the map must not draw that as a point.
export const IMPRECISE_PRECISIONS = new Set(["country", "region", "unknown"]);

export function isImprecise(item) {
  return IMPRECISE_PRECISIONS.has(item?.geo_precision);
}

// --- placement verdicts ------------------------------------------------
//
// backend/sources/geoverify.py reads whatever text a row came with and says
// how much the coordinate can be trusted. Until now none of that reached the
// map: a pin the backend had already judged to be in the wrong country was
// drawn exactly like one it had confirmed.
//
// "contested" and "dateline_suspect" are the two verdicts that mean the
// coordinate is doubted. Both are drawn with the same dashed ring an imprecise
// pin gets, because they are saying the same thing to a reader -- do not read
// this dot as a location -- and inventing a second uncertainty vocabulary
// would make neither legible.
export const DOUBTFUL_VERDICTS = new Set(["contested", "dateline_suspect"]);

export function placementDoubtful(item) {
  return DOUBTFUL_VERDICTS.has(item?.geo_verdict);
}

/** Whether a pin's position should be drawn as uncertain, for any reason. */
export function positionUncertain(item) {
  return isImprecise(item) || placementDoubtful(item);
}

export const VERDICT_NOTE = {
  contested:
    "Placement contested — the reporting names somewhere else. The pin is where the source put it; it has not been moved.",
  dateline_suspect:
    "The only place the reporting names is where it was filed from, which is the newsroom rather than the event.",
  refined:
    "Position improved by this app: the source placed it only to a region or country, and the reporting named a specific place inside it.",
  confirmed: "Position corroborated against the reporting's own text.",
  structured: "Position coded by a human analyst from the underlying reporting.",
};

// --- placement confidence and radius ----------------------------------
//
// geoverify.py scores every coordinate 0-100 and states, in kilometres, how far
// out the real place could be. Both fields have been on the payload since the
// module shipped and neither reached the map, so a pin geocoded to a national
// centroid -- 400 km of slack, by the backend's own reckoning -- was drawn as a
// dot exactly like one confirmed to a street.
//
// The radius is a lookup per precision (locality 15, region 120, country 400)
// except where geoverify resolved a real place, in which case it is computed.
// That is why it is read off the record rather than mapped from geo_precision
// here: the computed values are the whole point of the confirmed/refined
// verdicts, and a local lookup table would throw them away.

/** The stated uncertainty radius in metres, or null when the record has none. */
export function uncertaintyRadiusMetres(item) {
  const km = Number(item?.geo_radius_km);
  return Number.isFinite(km) && km > 0 ? km * 1000 : null;
}

// The scores actually in use are 15 (country), 35 (region), 65 (locality) and
// 90 (confirmed), so a threshold anywhere in 40-64 separates "geocoded to a
// country or province" from "geocoded to a place". 50 is the middle of that
// gap and is not near any real value, which keeps the control from flickering
// a whole band in and out on an off-by-one.
export const CONFIDENCE_THRESHOLD = 50;

/**
 * Whether an event falls below the reader's confidence floor.
 *
 * Deliberately NOT part of passesEventFilter: this dims rather than hides. A
 * reader raising the floor is saying "show me which of these are weakly
 * placed", not "delete them" -- and most of the corpus scores below the
 * "geocoded to a place" mark, so hiding on this would empty the layer and look
 * like a broken feed rather than an answer. That is why this one is on by
 * default while showImprecise is off: fading a majority is a legible statement
 * about the layer, hiding a majority is indistinguishable from a dead feed.
 *
 * A record with no score is never dimmed. /api/replay serves snapshots written
 * before geoverify shipped, and fading those would state a doubt the pipeline
 * never actually expressed.
 */
export function confidenceDimmed(item, filter = DEFAULT_EVENT_FILTER) {
  const floor = filter?.minConfidence || 0;
  if (floor <= 0) return false;
  const score = Number(item?.geo_confidence);
  return Number.isFinite(score) && score < floor;
}

// The three answers the legend gives about placement, in the order a reader
// cares about them. "Doubted" outranks "unverified" because it is a positive
// finding rather than an absence: the pipeline looked and disagreed.
export function verdictBucket(item) {
  if (placementDoubtful(item)) return "eventsDoubted";
  if (item?.geo_verdict === "confirmed" || item?.geo_verdict === "refined"
    || item?.geo_verdict === "structured") return "eventsVerified";
  return "eventsUnverified";
}

export const PRECISION_NOTE = {
  country:
    "Geocoded only to the country centroid — the true location within this country is unknown.",
  region: "Geocoded to a province or state, not a specific place.",
  unknown: "No usable geocode; position is approximate.",
  // Officials only. Deliberately absent from IMPRECISE_PRECISIONS above: that
  // set drives conflict-icon shrinking and the "hide imprecise" filter, neither
  // of which applies to a layer that has no severity. The note still belongs
  // here so there is one place a precision value is explained to a reader.
  // Interpolated with the capital's name by decorateOfficials.
  capital:
    "Reported only at country level — shown at the capital, not where the act took place.",
};

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// --- conflict-event age -----------------------------------------------
//
// One clock, read off `date`, for every source.
//
// This used to prefer the payload's `ingested_at`, which measured something
// else entirely and only for half the layer. `ingested_at` is min(seen_at)
// across the cluster (event_fusion.py's _merge_cluster), and `seen_at` is set
// only in _normalize_gdelt -- _normalize_structured has no such key, so it is
// null for every ACLED/UCDP-only record. That put two incomparable numbers
// through one comparison: ACLED and UCDP aged from midnight UTC of the event
// day, GDELT aged from whenever this backend process first polled the row.
// "Last 6 hours" therefore excluded every structured event unless the current
// UTC hour happened to be under 6, and a 29-day-old incident first reported
// today read as brand new (MAX_REPORT_LAG_DAYS is 30).
//
// There is no finer event time available to fix that with: _parse_gdelt_dt
// truncates to YYYYMMDD and _parse_structured_dt parses YYYY-MM-DD, so the
// `date` field is day-granular for every source. `ingested_at` stays on the
// payload as provenance -- "when we first saw this reported" is a real and
// useful thing to say -- but it is not this layer's age and must not filter it.
//
// `now` is a parameter rather than a call to Date.now() inside, so replay can
// pass the scrubbed timestamp and age events against the moment being shown.

/** Midnight UTC of an item's event day, or null when it carries no usable date. */
function eventDayMs(item) {
  if (!item?.date) return null;
  const parsed = Date.parse(`${item.date}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whole UTC days between an item's event day and the reference day, or NaN.
 * This is what the window filter compares against: exact at the resolution the
 * data actually has, so "last 2 days" means two dates rather than a 48-hour
 * span whose edge lands mid-day and cuts a date in half.
 */
export function ageDays(item, now = Date.now()) {
  const day = eventDayMs(item);
  if (day === null) return NaN;
  const ref = new Date(now);
  const today = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  return Math.max(0, Math.round((today - day) / DAY_MS));
}

/**
 * Hours since the *end* of an item's event day, floored at 0, or NaN.
 *
 * Fading only -- ageDays above is what filters. Measuring from the end of the
 * day rather than its start is the honest reading of a day-granular record:
 * the latest moment the event could have happened. It also stops a pin dated
 * today from opening at 20 hours old simply because it is late in the day.
 */
export function ageHours(item, now = Date.now()) {
  const day = eventDayMs(item);
  if (day === null) return NaN;
  return Math.max(0, (now - (day + DAY_MS)) / HOUR_MS);
}

// --- the conflict filter ----------------------------------------------
//
// What the user asked the Conflict & Violence layer to show. It lives here
// rather than inside the map controller because the map is not the only thing
// that draws from /api/events: the notable-events panel and the zone briefing
// read the same array, and a list that disagrees with the map about what is in
// scope is worse than no list. Same "one definition" discipline as the
// severity bands at the top of this file, for the same reason.
//
// maxAgeDays counts dates, not hours -- see ageDays. null means no window, and
// it is the shipped default on purpose: the backend already decides what is
// recent enough to serve (acled.py's 3-day cutoff, event_fusion's 3-day
// violence accumulator), and a client-side default that hides some of what it
// was just sent is how this layer came to draw a fraction of its own count.
// GDELT rows in particular can carry an event date weeks before the report
// that surfaced them -- MAX_REPORT_LAG_DAYS is 30 -- so any finite default
// would silently drop real, deliberately-served events.
//
// minConfidence lives on this object even though passesEventFilter ignores it,
// and that is the point: it is one more thing the reader has said about this
// layer, and the map, the notable-events panel and the zone briefing all need
// to agree about it. See confidenceDimmed above for why it dims rather than
// filters.
//
// The two placement defaults below both start from the same position: the map
// opens showing what it can actually vouch for, and the reader opts back in to
// the rest. That is only affordable because the imprecise share is small --
// IMPRECISE_PRECISIONS covers "country", "region" and "unknown", and a row with
// no geo_precision at all is not in that set, so the default hides the pins the
// backend explicitly placed at a centroid rather than everything it did not
// verify. If a future source starts emitting "country" for the bulk of its
// rows, revisit this: a default that hides most of the layer reads as a broken
// feed, which is exactly why the confidence control fades instead of filtering.
export const DEFAULT_EVENT_FILTER = {
  maxAgeDays: null, minSeverity: 0, showImprecise: false,
  minConfidence: CONFIDENCE_THRESHOLD,
};

export function passesEventFilter(item, filter = DEFAULT_EVENT_FILTER, now = Date.now()) {
  if (!filter.showImprecise && isImprecise(item)) return false;
  if ((item.severity || 0) < filter.minSeverity) return false;
  if (filter.maxAgeDays != null) {
    const age = ageDays(item, now);
    // An event we can't date is kept: hiding it would silently drop data on
    // the basis of a missing field rather than of anything the user chose.
    if (Number.isFinite(age) && age > filter.maxAgeDays) return false;
  }
  return true;
}

// Quantised to 20 steps on purpose, and this is load-bearing rather than a
// micro-optimisation. Opacity is rendered into the icon's HTML string, and
// createMapController's updateMarker decides whether to repaint by comparing
// that string. A continuous function of Date.now() would differ on literally
// every render, so every marker's DOM element would be rebuilt on every pan --
// the exact cost that comparison exists to avoid.
export function ageOpacity(hoursOld) {
  if (!Number.isFinite(hoursOld)) return 1;
  const raw = hoursOld <= 6 ? 1 : Math.max(0.35, 1 - ((hoursOld - 6) / 66) * 0.65);
  return Math.round(raw * 20) / 20;
}

// --- news age ---------------------------------------------------------
//
// News carries its own clock. Conflict events are dated to the day and shown
// over 72 hours, so ageOpacity's 6-hour grace period and slow 66-hour ramp
// suit them. A news feed is the opposite: it holds 24 hours, and within that
// the difference between "20 minutes ago" and "19 hours ago" is the single
// most useful thing the map can express about an item.
//
// So: full strength for the first hour, then easing to a floor over the rest of
// the window. Nothing is hidden -- the tail recedes rather than disappearing,
// which is what keeps a widened window from reading as clutter.
export const NEWS_WINDOW_HOURS = 24;
const NEWS_FULL_HOURS = 1;
const NEWS_MIN_OPACITY = 0.3;

/** Age in hours from GDELT's "YYYYMMDDHHMMSS" date_added, or NaN. */
export function ageHoursFromDateAdded(dateAdded) {
  const dt = parseGdeltDateAdded(dateAdded);
  if (!dt) return NaN;
  return (Date.now() - dt.getTime()) / HOUR_MS;
}

function newsDecay(hoursOld) {
  if (!Number.isFinite(hoursOld) || hoursOld <= NEWS_FULL_HOURS) return 0;
  const span = NEWS_WINDOW_HOURS - NEWS_FULL_HOURS;
  return Math.min(Math.max((hoursOld - NEWS_FULL_HOURS) / span, 0), 1);
}

// Quantised to 20 steps for the same load-bearing reason ageOpacity is: the
// value is rendered into the icon's HTML string, and createMapController's
// updateMarker decides whether to repaint by comparing that string.
export function newsAgeOpacity(hoursOld) {
  if (!Number.isFinite(hoursOld)) return 1;
  const raw = 1 - newsDecay(hoursOld) * (1 - NEWS_MIN_OPACITY);
  return Math.round(raw * 20) / 20;
}

// Older news also shrinks. Opacity alone is not enough separation once a day's
// worth of pins share a view -- a dim pin at full size still occupies the eye,
// and it still costs the declutter pass a full-size slot to route around.
export function newsAgeScale(hoursOld) {
  if (!Number.isFinite(hoursOld)) return 1;
  return 1 - newsDecay(hoursOld) * 0.28;
}
