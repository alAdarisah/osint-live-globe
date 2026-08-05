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
export const SEVERITY_BANDS = [
  { min: 75, key: "critical", label: "Critical", color: "#ff1a1a", token: "severity.critical" },
  { min: 55, key: "high", label: "High", color: "#ff5c2a", token: "severity.high" },
  { min: 40, key: "moderate", label: "Moderate", color: "#ff9500", token: "severity.moderate" },
  { min: 0, key: "low", label: "Low", color: "#ffd11a", token: "severity.low" },
];

// Corroboration keeps its own colour: "independently confirmed" is a different
// axis from "how bad", and both are worth reading at a glance.
export const CORROBORATED_COLOR = "#3ac1ff";

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

/** Age in hours, from the backend's ingested_at (unix seconds) or its date. */
export function ageHours(item) {
  if (Number.isFinite(item?.ingested_at)) {
    return (Date.now() - item.ingested_at * 1000) / HOUR_MS;
  }
  if (item?.date) {
    const parsed = Date.parse(`${item.date}T00:00:00Z`);
    if (!Number.isNaN(parsed)) return (Date.now() - parsed) / HOUR_MS;
  }
  return NaN;
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
