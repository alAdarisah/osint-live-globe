// The one severity scale.
//
// This lived in four places -- decorators.js (hex), NotableEventsPanel.jsx (CSS
// class names), LayersSection.jsx (legend swatches), and style.css (chip
// backgrounds) -- and they had already started to drift. CSS cannot import JS,
// so the chip and legend colours are now applied inline from these objects,
// which is the only way to make one definition genuinely authoritative.
//
// Scores come from backend/sources/event_fusion.py's _severity_for.

export const SEVERITY_BANDS = [
  { min: 75, key: "critical", label: "Critical", color: "#ff1a1a" },
  { min: 55, key: "high", label: "High", color: "#ff5c2a" },
  { min: 40, key: "moderate", label: "Moderate", color: "#ff9500" },
  { min: 0, key: "low", label: "Low", color: "#ffd11a" },
];

// Corroboration keeps its own colour: "independently confirmed" is a different
// axis from "how bad", and both are worth reading at a glance.
export const CORROBORATED_COLOR = "#3ac1ff";

export function severityBand(severity) {
  const score = Number.isFinite(severity) ? severity : 0;
  return SEVERITY_BANDS.find((b) => score >= b.min) || SEVERITY_BANDS[SEVERITY_BANDS.length - 1];
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
