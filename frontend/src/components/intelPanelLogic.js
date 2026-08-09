// Pure data-shaping for IntelPanel.jsx: the scope predicate for each of its
// five header scopes, the window/severity/verification controls it shares
// with the map's own event filter, the group-by bucketing, and the "nothing
// qualifies" rule that decides whether the panel renders at all.
//
// Pulled out into its own plain-JS sibling module for the same reason
// placeInfoCardGrouping.js is: IntelPanel.jsx is JSX, and this project's
// frontend suite runs under plain `node --test` with no build step, so
// anything that needs a headless test has to live somewhere that harness can
// import -- see frontend/tests/intelPanel.test.js.
import { padBounds, boundsContainsPoint } from "../utils/geo";
import { insideWaterFeature, bboxesOverlap } from "../map/popups.js";
import { passesEventFilter, ageHoursFromDateAdded, confidenceDimmed } from "../map/severity.js";
import { officialsAgeHours } from "../map/decorators.js";

// ---------- scope ----------
//
// One predicate, `contains(lat, lon)`, that every tab applies -- so a reader
// who has picked "selected water body" sees the same records in Events, News
// and Officials rather than three independently-approximated ideas of what
// "the Black Sea" means. `intersectsBounds` is the bounds-shaped counterpart,
// for escalation zones (which have a region box, not a point).

export const SCOPE_WORLD = "world";
export const SCOPE_VIEWPORT = "viewport";
export const SCOPE_COUNTRY = "country";
export const SCOPE_REGION = "region";
export const SCOPE_WATER = "water";

export const SCOPE_OPTIONS = [
  { value: SCOPE_WORLD, label: "World" },
  { value: SCOPE_VIEWPORT, label: "Current view" },
  { value: SCOPE_COUNTRY, label: "Selected country" },
  { value: SCOPE_REGION, label: "Selected region" },
  { value: SCOPE_WATER, label: "Selected water body" },
];

const WORLD_SCOPE = {
  kind: SCOPE_WORLD,
  label: "World",
  // Not "deliberate": World is what every session opens on, so it must not
  // trip the "a reader asked a direct question" half of intelPanelIsEmpty
  // below, the same way NotableEventsPanel's own `scoped` never fired for it.
  deliberate: false,
  contains: () => true,
  intersectsBounds: () => true,
};

/**
 * @param {string} kind one of the SCOPE_* constants
 * @param {object} ctx
 * @param {{south:number,west:number,north:number,east:number}} [ctx.mapBounds] the live viewport
 * @param {object} [ctx.countryScope] makeCountryScope's own output (map/countryScope.js)
 * @param {{label:string, bounds:number[]}} [ctx.region] the RegionBar selection (dataApi.regions[currentRegionKey])
 * @param {{label:string, entry:object, bounds:object}} [ctx.water] the selected water body (mapApi.selectedWater)
 * @returns {{kind:string, label:string, deliberate:boolean,
 *            contains:(lat:number,lon:number)=>boolean,
 *            intersectsBounds:(bounds:number[])=>boolean}}
 *   Falls back to World whenever the requested scope's underlying selection
 *   does not exist yet (nothing clicked, no viewport reported yet) -- the
 *   header's <select> can keep showing the reader's last choice, and the
 *   moment the selection reappears this starts filtering again on its own,
 *   with no separate "reset the dropdown" effect required anywhere.
 */
export function makeIntelScope(kind, ctx = {}) {
  switch (kind) {
    case SCOPE_VIEWPORT: {
      if (!ctx.mapBounds) return WORLD_SCOPE;
      // Same 25% pad every viewport-filtered reader of mapBounds already
      // applies (NewsBroadcastPanel did; every renderer's own
      // map.getBounds().pad(0.25)) -- a record just off-screen is still "in
      // view" for this purpose.
      const bounds = padBounds(ctx.mapBounds, 0.25);
      const boundsArr = [bounds.south, bounds.west, bounds.north, bounds.east];
      return {
        kind, label: "Current view", deliberate: false,
        contains: (lat, lon) => boundsContainsPoint(bounds, lat, lon),
        intersectsBounds: (b) => bboxesOverlap(boundsArr, b),
      };
    }
    case SCOPE_COUNTRY: {
      if (!ctx.countryScope?.active) return WORLD_SCOPE;
      const cs = ctx.countryScope;
      return {
        kind, label: cs.label, deliberate: true,
        contains: cs.contains, intersectsBounds: cs.intersectsBounds,
      };
    }
    case SCOPE_REGION: {
      if (!ctx.region?.bounds) return WORLD_SCOPE;
      const [south, west, north, east] = ctx.region.bounds;
      const rect = { south, west, north, east };
      return {
        kind, label: ctx.region.label, deliberate: true,
        contains: (lat, lon) => boundsContainsPoint(rect, lat, lon),
        intersectsBounds: (b) => bboxesOverlap(ctx.region.bounds, b),
      };
    }
    case SCOPE_WATER: {
      if (!ctx.water?.entry) return WORLD_SCOPE;
      const { entry, bounds, label } = ctx.water;
      return {
        kind, label: label || entry.name || "Selected water",
        deliberate: true,
        contains: (lat, lon) => insideWaterFeature(entry, bounds, lat, lon),
        // A handful of marine features (the Bering Sea, the Pacific...) wrap
        // the antimeridian and carry no simple bbox for that case -- see
        // buildWaterIndex's own note in map/water.js. Rather than get that
        // wrong, an entry with no rawBbox keeps every zone in scope, which is
        // the same "generous on overlap" choice countryScope.js makes for
        // escalation zones straddling a border.
        intersectsBounds: (b) => (entry.rawBbox ? bboxesOverlap(entry.rawBbox, b) : true),
      };
    }
    default:
      return WORLD_SCOPE;
  }
}

// ---------- severity floor (Events tab) ----------
//
// Preserved from NotableEventsPanel.jsx: the world board keeps a floor so it
// is never a firehose of low-grade incidents, but once a reader has said
// what they want to look at -- any deliberate scope now, not only a country
// -- the floor drops to nothing and the reader's own Minimum severity control
// is what thins the list from here.
export const EVENTS_SEVERITY_FLOOR_WORLD = 40;
export const EVENTS_SEVERITY_FLOOR_SCOPED = 0;

export function eventsSeverityFloor(scope) {
  return scope?.deliberate ? EVENTS_SEVERITY_FLOOR_SCOPED : EVENTS_SEVERITY_FLOOR_WORLD;
}

// ---------- window ----------

export const WINDOW_OPTIONS = [
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 72, label: "72h" },
  { hours: 168, label: "7d" },
];
export const DEFAULT_WINDOW_HOURS = 168;

/**
 * The panel's hour-based window, translated into ageDays' whole-day units --
 * the same unit `eventFilter.maxAgeDays` already uses, because this is what
 * IntelPanel.jsx writes into that field. Task 12's review (Important 3)
 * caught two independent Window controls -- this one and ControlPanel's own
 * day-granular admin-only select -- that could silently disagree, both
 * claiming to gate the same Conflict & Violence layer. There is one Window
 * control now: this one, in the panel's header. ControlPanel no longer has
 * its own; see LayersSection.jsx's note where that select used to sit.
 *
 * Every conflict source behind the Events tab dates to the day and nothing
 * finer (see map/severity.js's own note on ageDays), so an hours-based
 * window cannot mean anything finer than that here -- 6h and 24h both round
 * to "today". Ceil-then-subtract-one is what makes the boundary inclusive: a
 * 72h window is meant to keep today, yesterday and the day before (ageDays
 * 0-2), and ceil(72/24)-1 = 2.
 *
 * The widest option (7 days, DEFAULT_WINDOW_HOURS) maps to `null` -- "no
 * cap" -- rather than to 6. That is deliberate, not an off-by-one: `null` is
 * `DEFAULT_EVENT_FILTER.maxAgeDays`'s own shipped value, chosen there
 * because the backend already decides what is recent enough to serve and a
 * client-side cap would silently hide some of what it was just sent (see
 * that constant's own comment). Mapping the widest window to the same `null`
 * keeps that guarantee intact at the panel's own default, instead of
 * quietly reintroducing a cap the map never had before this control existed.
 */
export function windowMaxAgeDays(hours) {
  if (!Number.isFinite(hours) || hours >= DEFAULT_WINDOW_HOURS) return null;
  return Math.max(0, Math.ceil(hours / 24) - 1);
}

/** For News and Officials, which carry a real timestamp rather than a bare
 *  date, the window is just an hours comparison. An item this app cannot
 *  date is kept rather than silently dropped -- same rule passesEventFilter
 *  applies to a dateless event. */
export function withinWindowHours(ageHours, windowHours) {
  if (!Number.isFinite(windowHours)) return true;
  if (!Number.isFinite(ageHours)) return true;
  return ageHours <= windowHours;
}

// ---------- group by ----------

export const GROUP_BY_OPTIONS = [
  { value: "none", label: "None" },
  { value: "country", label: "Country" },
  { value: "eventType", label: "Event type" },
  { value: "actor", label: "Actor" },
  { value: "outlet", label: "Outlet" },
];

export const UNKNOWN_GROUP = "__unknown__";

/**
 * The field one group-by axis reads off a record. Different tabs carry
 * different fields for the same idea -- an events row's "what happened" is
 * event_type, an officials row's is its CAMEO kind, and News carries neither
 * -- so this is a small per-tab table rather than one field name assumed to
 * exist everywhere. Returns null when the axis genuinely does not apply to
 * this tab (e.g. News has no event-type field at all); groupItems below reads
 * that as "bucket this record under the shared Unknown group" rather than
 * inventing a value the record never carried.
 */
export function groupKeyFor(item, groupBy, tabKind) {
  switch (groupBy) {
    case "country":
      // News (GDELT) carries no country field of its own -- see gdelt.py's
      // normalizer -- so every News row falls to the Unknown bucket under
      // this axis rather than a guess built from its coordinate.
      return item.country || null;
    case "eventType":
      if (tabKind === "officials") return item.kind || null;
      if (tabKind === "events") return item.event_type || null;
      return null;
    case "actor": {
      const actors = [item.actor1, item.actor2].filter(Boolean);
      return actors.length ? actors.join(" vs ") : null;
    }
    case "outlet":
      if (tabKind === "news") return item.source_name || null;
      if (tabKind === "officials") return item.outlet || item.government || null;
      if (tabKind === "events") return item.source || null;
      return null;
    default:
      return null;
  }
}

/**
 * Buckets `items` by `groupKeyFor`, preserving each bucket's relative order
 * from the already-sorted input (a stable single pass, not a re-sort) and
 * ranking buckets by size so the largest cluster leads -- the Unknown bucket
 * always trails, whatever its size, since it is an admission of a missing
 * field rather than a real cluster.
 *
 * Returns null for groupBy === "none": there is nothing to bucket, and the
 * caller renders the flat list it already had rather than one synthetic
 * group wrapping it.
 *
 * A record whose field is missing lands in the shared Unknown bucket rather
 * than being dropped -- this project's provenance rule is that an absent
 * field is stated, never treated as a reason to hide the record it belongs
 * to (see osint-trusted-sources-only).
 */
export function groupItems(items, groupBy, tabKind) {
  if (!groupBy || groupBy === "none") return null;
  const order = [];
  const buckets = new Map();
  for (const item of items || []) {
    const key = groupKeyFor(item, groupBy, tabKind) || UNKNOWN_GROUP;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, items: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.items.push(item);
  }
  const groups = order.map((key) => buckets.get(key));
  groups.sort((a, b) => {
    if (a.key === UNKNOWN_GROUP) return 1;
    if (b.key === UNKNOWN_GROUP) return -1;
    return b.items.length - a.items.length || String(a.key).localeCompare(String(b.key));
  });
  return groups;
}

// ---------- "nothing qualifies" ----------

/**
 * Whether the whole panel should render nothing at all -- the same rule
 * NotableEventsPanel.jsx applied to its own two lists, generalised from two
 * lists to four tabs. A quiet day at World (or Current view) scope is the
 * normal state and earns no widget; a deliberate scope (country, region or
 * water) is a direct question, and "nothing here" is an answer worth
 * printing rather than a reason to disappear and leave the click looking
 * broken.
 *
 * @param {{escalation:number, events:number, news:number, officials:number}} counts
 *   how many rows each tab currently holds
 * @param {boolean} deliberateScope scope.deliberate from makeIntelScope
 */
export function intelPanelIsEmpty(counts, deliberateScope) {
  if (deliberateScope) return false;
  return !counts.escalation && !counts.events && !counts.news && !counts.officials;
}

// ---------- per-tab selection ----------

function daysOld(dateStr) {
  if (!dateStr) return 0;
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (Date.now() - then) / 86400000);
}

/** Severity decayed by age -- see NotableEventsPanel.jsx's own note on why a
 *  gentle multiplier beats either a hard cutoff or recency alone: a 3-day-old
 *  massacre shouldn't outrank today's fighting forever, but recency alone
 *  shouldn't let a minor fresh event top the list either. */
export function rankScore(event) {
  const severity = Number.isFinite(event.severity) ? event.severity : 0;
  return severity * (1 / (1 + daysOld(event.date) * 0.35));
}

export const EVENTS_MAX_ITEMS = 6;
export const EVENTS_MAX_ITEMS_SCOPED = 8;
export const NEWS_MAX_ITEMS = 8;
export const OFFICIALS_MAX_ITEMS = 8;

/** Escalation zones are regions, not countries, so scope applies via
 *  intersectsBounds (overlap) rather than containment -- a spike straddling
 *  a border is still the answer to "where should I be looking" for the
 *  country next to it. World/Current view keep every zone; the Window and
 *  severity/verification controls do not apply here, since a zone is already
 *  a fixed 24h-vs-7-day-baseline computation from the backend, not a record
 *  with its own timestamp or severity score to filter by. */
export function selectEscalationZones(escalationRaw, scope) {
  // World's own intersectsBounds is unconditionally true, so applying it here
  // even at World scope is a no-op there and a real filter everywhere else --
  // including Current view, which (unlike the severity floor below) has just
  // as much claim to narrowing the escalation board as a country or region
  // pick does.
  const zones = (escalationRaw || []).filter((z) => scope.intersectsBounds(z.bounds));
  zones.sort((a, b) => (b.ratio || 0) - (a.ratio || 0) || String(a.region).localeCompare(String(b.region)));
  return zones;
}

/**
 * The Events tab: fused conflict events, ranked worst-first.
 *
 * `eventFilter` is the same object the map's Conflict & Violence layer reads
 * (map/severity.js's DEFAULT_EVENT_FILTER) -- Minimum severity is one shared
 * value, not a second copy the panel could disagree with the map about.
 * `eventFilter.maxAgeDays` is that same sharing applied to the Window
 * control: IntelPanel.jsx pushes its own Window selection into this field
 * (via windowMaxAgeDays), so `passesEventFilter` below is the *only* place
 * this tab's age window is checked -- there used to be a second, independent
 * day-count re-check here against the panel's own `windowHours`, and Task
 * 12's review (Important 3) is what caught that the two could disagree
 * (ControlPanel's admin-only Window select, at the time, was a *third* still
 * -- see LayersSection.jsx's note on why that one is gone now too).
 *
 * The verification floor (`eventFilter.minConfidence`) is deliberately NOT
 * applied as a hard filter here, for the same reason passesEventFilter itself
 * ignores it: most of the corpus scores below the "geocoded to a place" mark,
 * so filtering on it would empty this tab and read as a broken feed rather
 * than as an answer. It is surfaced instead as `weaklyPlaced` on each
 * returned event (via confidenceDimmed, the same function the map's own
 * dimming reads) -- the map expresses that by desaturating the pin
 * (`.weakly-sourced`, decorators.js), and this tab expresses the same
 * boolean as a plain "weakly placed" word in the row's meta line rather than
 * a style change, which needs no colour or saturation perception to read.
 */
export function selectEventItems(eventsRaw, { scope, eventFilter }) {
  const floor = eventsSeverityFloor(scope);
  const scored = [];
  for (const e of eventsRaw || []) {
    const severity = Number.isFinite(e.severity) ? e.severity : 0;
    if (severity < floor) continue;
    if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
    if (!passesEventFilter(e, eventFilter)) continue;
    if (!scope.contains(e.lat, e.lon)) continue;
    scored.push({ event: e, score: rankScore(e) });
  }
  scored.sort((a, b) => b.score - a.score || String(a.event.id).localeCompare(String(b.event.id)));
  const cap = scope?.deliberate ? EVENTS_MAX_ITEMS_SCOPED : EVENTS_MAX_ITEMS;
  return scored.slice(0, cap).map((s) => ({ ...s.event, weaklyPlaced: confidenceDimmed(s.event, eventFilter) }));
}

/** The News tab: GDELT rows with a real scraped title, most recent first.
 *  Deduplicated by source_url/event_id the same way NewsBroadcastPanel was,
 *  since the same story can appear in the feed more than once. */
export function selectNewsItems(gdeltRaw, { scope, windowHours }) {
  const seen = new Set();
  const filtered = [];
  for (const d of gdeltRaw || []) {
    if (typeof d.lat !== "number" || typeof d.lon !== "number") continue;
    if (!scope.contains(d.lat, d.lon)) continue;
    if (!(d.real_title && d.real_title.trim())) continue;
    if (!withinWindowHours(ageHoursFromDateAdded(d.date_added), windowHours)) continue;
    const key = d.source_url || d.event_id;
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    filtered.push(d);
  }
  filtered.sort((a, b) => (b.date_added || "").localeCompare(a.date_added || ""));
  return filtered.slice(0, NEWS_MAX_ITEMS);
}

/** The Officials tab: diplomatic activity, most recent first -- the kind
 *  today has an endpoint (/api/officials) and no panel at all. */
export function selectOfficialsItems(officialsRaw, { scope, windowHours }) {
  const filtered = [];
  for (const d of officialsRaw || []) {
    if (typeof d.lat !== "number" || typeof d.lon !== "number") continue;
    if (!scope.contains(d.lat, d.lon)) continue;
    if (!withinWindowHours(officialsAgeHours(d), windowHours)) continue;
    filtered.push(d);
  }
  filtered.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  return filtered.slice(0, OFFICIALS_MAX_ITEMS);
}
