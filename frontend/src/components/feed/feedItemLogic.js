// The Activity tab, and the chip row that filters it.
//
// Activity exists because Events answers a different question than it looks
// like it does. Events is *ranked*: it applies a significance floor and sorts by
// rankScore, so it is "what matters most right now" and a busy hour of small
// incidents can be entirely absent from it. Activity is the other reading --
// "what has happened, most recent first" -- across the three record feeds at
// once, with no floor.
//
// Both are worth having and neither substitutes for the other, which is why
// this is a real merge rather than the cheap version (Events again, with chips
// on top). A reader watching a place wants the stream; a reader asking what to
// look at wants the ranking.

import { SVG } from "../../map/svgIcons.js";

/**
 * The chip row's categories.
 *
 * Deliberately coarse. These are the shapes of thing a reader scans for, not
 * ACLED's own taxonomy -- which has dozens of sub-types and is already
 * available as the Group by control's "Event type" axis for anyone who wants
 * it. Six chips that each mean something at a glance beat thirty that need
 * reading.
 */
export const ACTIVITY_CHIPS = [
  { key: "all", label: "All" },
  { key: "strike", label: "Strike", glyph: SVG.airstrike },
  { key: "air", label: "Air", glyph: SVG.planeMilitary },
  { key: "naval", label: "Naval", glyph: SVG.warship },
  { key: "ground", label: "Gnd", glyph: SVG.clash },
  { key: "explosion", label: "Expl", glyph: SVG.blast },
];

// Matched against ACLED/UCDP event_type and sub_event_type text, lowercased.
// Ordered: the first hit wins, so the more specific patterns lead. A record
// that matches nothing is not forced into a bucket -- see activityCategory.
const CATEGORY_PATTERNS = [
  ["strike", /air strike|airstrike|shelling|artillery|missile|drone strike|bombard/],
  ["explosion", /explosion|ied|remote explosive|grenade|landmine|suicide bomb/],
  ["naval", /naval|maritime|vessel|ship|boat|port strike/],
  ["air", /aircraft|aerial|air-to-|helicopter|uav|drone/],
  ["ground", /armed clash|battle|attack|violence against civilians|abduction|arrest|riot|protest|clash|small arms/],
];

/**
 * Which chip a record belongs under, or null.
 *
 * Null rather than a catch-all bucket, and the caller shows it under "All"
 * only. A record whose type this does not recognise is not a record of unknown
 * shape being hidden -- it is one this coarse grouping has no honest claim
 * about, and filing it under "Ground" because that is the biggest bucket would
 * be inventing a fact.
 */
export function activityCategory(item) {
  if (!item || typeof item !== "object") return null;
  if (item.feed === "news") return null;
  if (item.feed === "officials") return null;
  const text = `${item.event_type || ""} ${item.sub_event_type || ""}`.toLowerCase();
  if (!text.trim()) return null;
  for (const [key, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return key;
  }
  return null;
}

/** Applies the chip row. "All" is everything, including the records
 *  activityCategory could not place. */
export function filterByChip(items, chip) {
  if (!chip || chip === "all") return items || [];
  return (items || []).filter((item) => activityCategory(item) === chip);
}

/**
 * Whatever timestamp a record actually carries, as epoch ms, or null.
 *
 * Three feeds with three conventions: conflict events date to the day
 * (`date`), GDELT carries a packed `date_added`, officials carry a unix
 * `published_at`. A record this cannot date sorts last rather than being
 * dropped -- the same rule passesEventFilter applies to a dateless event.
 */
export function activityTimestamp(item) {
  if (!item) return null;
  if (Number.isFinite(item.published_at)) return item.published_at * 1000;
  if (typeof item.date_added === "string" && item.date_added.length >= 14) {
    const s = item.date_added;
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
      `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof item.date === "string") {
    const ms = Date.parse(`${item.date}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** How many rows the stream shows. The same shape of cap the Events tab
 *  already applies, for the same reason: a rail is read, not scrolled through
 *  for a thousand rows. */
export const ACTIVITY_MAX_ITEMS = 120;

/**
 * The merged stream: conflict records, official statements and headlines, most
 * recent first.
 *
 * Each keeps a `feed` tag so a row can be rendered in its own idiom and so the
 * chip filter knows which records it has no claim about. The inputs are the
 * lists the other tabs have already selected, so scope, window and filters have
 * been applied exactly once and cannot disagree between tabs.
 */
export function selectActivityItems({ events = [], news = [], officials = [] } = {}) {
  const merged = [
    ...events.map((item) => ({ ...item, feed: "events" })),
    ...news.map((item) => ({ ...item, feed: "news" })),
    ...officials.map((item) => ({ ...item, feed: "officials" })),
  ];
  return merged
    .map((item) => ({ item, at: activityTimestamp(item) }))
    // Undateable records sort to the end rather than being dropped, and keep
    // their relative order among themselves.
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity))
    .slice(0, ACTIVITY_MAX_ITEMS)
    .map((entry) => entry.item);
}

/** The Activity tab's empty state, in the same voice as the other four. */
export function activityEmptyMessage(scope) {
  return scope?.deliberate
    ? `Nothing recorded in ${scope.label} in the current window.`
    : "Nothing recorded in the current window.";
}
