// Pure logic behind AirfieldActivityPanel.jsx -- the sort and the
// military-share arithmetic, split into a plain module for the same reason
// intelPanelLogic.js/placeInfoCardGrouping.js are: the panel itself is JSX,
// and this project's headless test suite (`node --test`, no build step)
// cannot import JSX at all. This file imports nothing, so it needs none of
// those two modules' own window/Leaflet stubs -- see
// frontend/tests/airfieldPanel.test.js.
//
// The one document this reads is backend/sources/airfield_activity.py's own
// {code: {code, name, military_field, aircraft, military_aircraft, hourly,
// hourly_military?, top_types?}} -- see storage.airfield_activity's
// docstring for why it is ranked and capped the way it is, and why a field
// with genuinely no military movement in the window carries no
// `hourly_military`/`top_types` key at all rather than an empty one.

/**
 * {code: entry} -> a plain array, the shape every table/sort function below
 * actually wants to work with.
 */
export function airfieldRows(activity) {
  return Object.values(activity || {});
}

/**
 * The fraction of a field's 24h movements that were military, or null when
 * there is no traffic at all to take a fraction of -- 0/0 is not "0% military",
 * it is "nothing observed here", and the two must never render the same way.
 */
export function militaryShare(entry) {
  if (!entry || !Number.isFinite(entry.aircraft) || entry.aircraft <= 0) return null;
  const military = Number.isFinite(entry.military_aircraft) ? entry.military_aircraft : 0;
  return military / entry.aircraft;
}

// Sentinel a null military share sorts by -- below every real share (which is
// always in [0, 1]) rather than above every one of them, so a field with no
// traffic at all never floats to the top of a "busiest by military share" sort.
const NO_SHARE = -1;

const SORT_VALUE = {
  aircraft: (e) => (Number.isFinite(e.aircraft) ? e.aircraft : 0),
  military_aircraft: (e) => (Number.isFinite(e.military_aircraft) ? e.military_aircraft : 0),
  militaryShare: (e) => militaryShare(e) ?? NO_SHARE,
  name: (e) => (e.name || e.code || "").toLowerCase(),
};

export const AIRFIELD_SORT_KEYS = Object.keys(SORT_VALUE);

/**
 * `rows`, ordered by `sortKey` -- a new array, never mutating the input (the
 * caller almost always holds the same array across renders/polls). Ties break
 * on `code` so two fields tied on the sorted figure always render in the same
 * relative order rather than swapping places on every re-render.
 */
export function sortAirfields(rows, sortKey = "aircraft", direction = "desc") {
  const valueOf = SORT_VALUE[sortKey] || SORT_VALUE.aircraft;
  const factor = direction === "asc" ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    return (a.code || "").localeCompare(b.code || "");
  });
}

/**
 * Busier in the second half of the 24h window than the first, the same
 * "arithmetic over what the backend already gave us, not a real second
 * series" disclosure IntelPanel's own EscalationMiniBar makes about its
 * baseline bars -- there is no hour-by-hour comparison against a week ago
 * behind this, only this one day's own two halves. "flat" also covers a
 * field with no movements at all in the window, which is not a claim this
 * function has any way to tell apart from a genuinely even 12-and-12 split --
 * both correctly read as "nothing changed" rather than as up or down.
 */
export function trafficTrend(hourly) {
  if (!Array.isArray(hourly) || hourly.length < 2) return null;
  const mid = Math.floor(hourly.length / 2);
  const sum = (values) => values.reduce((total, v) => total + (Number.isFinite(v) ? v : 0), 0);
  const firstHalf = sum(hourly.slice(0, mid));
  const secondHalf = sum(hourly.slice(mid));
  if (secondHalf > firstHalf) return "up";
  if (secondHalf < firstHalf) return "down";
  return "flat";
}
