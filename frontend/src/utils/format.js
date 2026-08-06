// Small, stateless string/number formatting helpers shared across marker
// popups, tooltips, and the news panel. Nothing here touches the DOM or
// Leaflet -- pure functions only, so they're trivially testable/reusable.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function fmtNumber(n) {
  return typeof n === "number" ? n.toLocaleString() : "n/a";
}

export function fmtFrp(frp) {
  if (frp == null || frp === "") return "n/a"; // Number(null) is 0, not NaN -- must check before coercing
  const n = Number(frp);
  return Number.isFinite(n) ? `${n.toFixed(1)} MW` : "n/a";
}

// VIIRS confidence is categorical ("l"/"n"/"h" = low/nominal/high), unlike
// MODIS which reports a 0-100% number -- handle both since FIRMS can serve
// either depending on the satellite/source.
export function fmtConfidence(c) {
  if (c == null || c === "") return "n/a";
  const label = { l: "Low", n: "Nominal", h: "High" }[String(c).toLowerCase()];
  if (label) return label;
  const n = Number(c);
  return Number.isFinite(n) ? `${n}%` : esc(c);
}

export function fmtFirmsDateTime(date, time) {
  if (!date) return "n/a";
  const t = String(time ?? "").padStart(4, "0");
  return `${date} ${t.slice(0, 2)}:${t.slice(2)} UTC`; // FIRMS acq_date/acq_time are UTC
}

// GDELT's date_added is "YYYYMMDDHHMMSS" UTC, no separators.
export function parseGdeltDateAdded(s) {
  if (!s || s.length < 14) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(8, 10), mi = +s.slice(10, 12), se = +s.slice(12, 14);
  const dt = new Date(Date.UTC(y, mo, d, h, mi, se));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Shared by both "how long ago" helpers below. GDELT stamps its own
// YYYYMMDDHHMMSS string; every other source in the backend carries plain unix
// seconds, and both should read the same way to a user.
function timeAgoFromMillis(ms) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function timeAgoFromDateAdded(s) {
  const dt = parseGdeltDateAdded(s);
  if (!dt) return "";
  return timeAgoFromMillis(dt.getTime());
}

/** "3h ago" from a unix timestamp in *seconds*, or "" if there isn't one. */
export function timeAgoFromUnix(seconds) {
  if (!Number.isFinite(seconds)) return "";
  return timeAgoFromMillis(seconds * 1000);
}

/**
 * The same instant as a fixed clock reading: "13:31:04 UTC" within the last
 * day, "2026-08-05 13:31 UTC" beyond it.
 *
 * The companion to timeAgoFromUnix rather than a replacement for it. "2m ago"
 * is what a reader wants and what goes stale the moment it is written -- marker
 * popups are not re-rendered while they are open (see createMapController.js),
 * and a replayed contact's card is read against a moment that isn't now. The
 * absolute form stays true in both cases, and the date appears exactly when it
 * starts to matter.
 */
export function utcClockFromUnix(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const dt = new Date(seconds * 1000);
  if (Number.isNaN(dt.getTime())) return "";
  const iso = dt.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const withinADay = Math.abs(Date.now() - dt.getTime()) < 86400000;
  return withinADay ? `${iso.slice(11, 19)} UTC` : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
