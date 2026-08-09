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

const ETA_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The crew-entered ETA (backend/sources/ais.py's _eta_from_static, kept as
 * the {month, day, hour, minute} AIS actually sends) as words a reader can
 * act on, or null if nothing usable survived.
 *
 * Never returns anything that reads as a full date: AIS's ETA field carries
 * no year at all, so a voyage crossing New Year has no honest absolute date
 * to give, and the caller's job is to say that explicitly rather than let
 * "Jan 4" be mistaken for a date this formatter invented a year for.
 *
 * Re-validates ITU-R M.1371's own "not available" sentinels rather than
 * trusting the caller to have already dropped them -- month 0 or 13+, day 0,
 * hour 24 and minute 60 all appear on the wire. ais.py's collector already
 * filters these before storing, but a formatter that assumed clean input
 * would print one of them as a date the moment it saw a record from anywhere
 * else, and this is a pure helper with no way to know where its argument
 * came from.
 */
export function formatAisEta(eta) {
  if (!eta || typeof eta !== "object") return null;
  const month = Number(eta.month);
  const day = Number(eta.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  let text = `${ETA_MONTH_NAMES[month - 1]} ${day}`;
  const hour = Number(eta.hour);
  const minute = Number(eta.minute);
  const hasHour = Number.isInteger(hour) && hour >= 0 && hour <= 23;
  const hasMinute = Number.isInteger(minute) && minute >= 0 && minute <= 59;
  if (hasHour && hasMinute) {
    text += `, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return text;
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
