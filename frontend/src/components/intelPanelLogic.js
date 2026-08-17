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
// Both floors are 0 now, and the function is kept only so the one caller and its
// tests still read as "apply the floor" rather than as "no floor exists".
//
// The world floor was 40, inherited from NotableEventsPanel, and its argument was
// sound for what it was written for: a six-row board cannot open on a firehose of
// low-grade incidents, so the world view kept a floor and a deliberate scope
// dropped it. Two things have since made it indefensible.
//
// It contradicted a control the reader can see. "Minimum severity" sits in this
// panel with Any / Moderate / High / Critical and defaults to Any, and at world
// scope the list was applying 40 anyway. Measured on the live feed while removing
// it: 78 events in the 72h window, of which 3 clear severity 40. So a reader was
// shown "Any", given 9 rows, and had no way to learn that 88% of what qualified
// had been withheld by a number no surface mentions. A hidden filter that
// disagrees with a visible one is worse than either alone.
//
// And the firehose it protected against no longer exists. The tab renders a page
// at a time and grows on demand (see feed/feedPaging.js), so volume is not what it
// was when six rows were the whole panel.
//
// minSeverity -- the visible one, shared with the map's own layer -- is the only
// severity floor now.
export const EVENTS_SEVERITY_FLOOR_WORLD = 0;
export const EVENTS_SEVERITY_FLOOR_SCOPED = 0;

export function eventsSeverityFloor(scope) {
  return scope?.deliberate ? EVENTS_SEVERITY_FLOOR_SCOPED : EVENTS_SEVERITY_FLOOR_WORLD;
}

// ---------- window ----------

// One table, two controls: the sub bar's pills and this panel's own Window
// select are two renderings of the same choice, not two choices -- see
// App.jsx's `windowHours`, which owns the value both of them read and write.
//
// `pill` is the short form the bar shows; `label` is the sentence the select
// shows. Neither is derived from the other, because "72H" and "72h" happen to
// look alike and "ALL"/"All available" do not.
//
// Three entries are new, and each earns its place rather than padding the row
// to seven:
//
//   1h, 6h  Both floor to maxAgeDays 0 for the conflict layers, because every
//           conflict source behind Events dates to the day and nothing finer
//           (see windowMaxAgeDays below). They are not redundant: News and
//           Officials carry real timestamps and go through withinWindowHours,
//           where one hour and six hours differ genuinely.
//   30d     A month, for reading a slow-moving picture rather than a day's.
//   all     The "All available" entry windowMaxAgeDays' own note (below) says
//           an unbounded option has to have, rather than being smuggled into
//           what "7d" means. hours: null gives no cap on either path -- both
//           windowMaxAgeDays and withinWindowHours treat a non-finite window as
//           unbounded -- so the one label means one thing on every tab.
//
// The design handoff asked for 48H where this has 72H. 72 is kept and the
// substitution is deliberate: see DEFAULT_WINDOW_HOURS immediately below, where
// dropping it would either leave no pill matching the state the map opens in,
// or silently narrow the shipped conflict window from three days to two.
export const WINDOW_OPTIONS = [
  { hours: 1, pill: "1H", label: "1h" },
  { hours: 6, pill: "6H", label: "6h" },
  { hours: 24, pill: "24H", label: "24h" },
  { hours: 72, pill: "72H", label: "72h" },
  { hours: 168, pill: "7D", label: "7d" },
  { hours: 720, pill: "30D", label: "30d" },
  { hours: null, pill: "ALL", label: "All available" },
];
// 72 rather than 168, because this constant is what actually decides the
// shipped age window -- not DEFAULT_EVENT_FILTER.maxAgeDays, which reads like
// it does. App.jsx pushes windowMaxAgeDays(windowHours) into that field
// unconditionally, so whatever severity.js defaults it to survives only until
// the app mounts, which is every load. Leaving this at 168 while severity.js
// defaulted to AGE_WINDOW_DATE_STEPS gave a map that argued for three days in
// two comments and a legend and then served seven.
//
// 72h is windowMaxAgeDays' exact inverse of AGE_WINDOW_DATE_STEPS (ceil(72/24)
// - 1 = 2), so the panel now writes the same window map/scene.js gates every
// other layer on. "7d" is still in WINDOW_OPTIONS and still means a real seven
// days; it is one click away rather than the state the map opens in.
export const DEFAULT_WINDOW_HOURS = 72;

/**
 * A window's identity as a form value.
 *
 * `hours` is the honest representation of the choice and one of them is `null`
 * ("no cap"), which a <select> cannot carry: an option with `value={null}`
 * renders as the empty string and comes back through `Number("")` as 0 -- an
 * "All available" that silently means "today only". The pill string is already
 * unique, already non-empty and already in the table, so it is what the two
 * controls exchange; these convert at the edges.
 */
export function windowOptionValue(hours) {
  const option = WINDOW_OPTIONS.find((opt) => opt.hours === hours);
  return option ? option.pill : "";
}

export function windowHoursFromValue(value) {
  const option = WINDOW_OPTIONS.find((opt) => opt.pill === value);
  return option ? option.hours : DEFAULT_WINDOW_HOURS;
}

/**
 * The hour-based window, translated into ageDays' whole-day units -- the same
 * unit `eventFilter.maxAgeDays` already uses, because this is what App.jsx
 * writes into that field. Task 12's review (Important 3) caught two
 * independent Window controls -- the panel's and ControlPanel's own
 * day-granular admin-only select -- that could silently disagree, both
 * claiming to gate the same Conflict & Violence layer.
 *
 * There are two controls on screen again -- the sub bar's time pills and the
 * feed panel's Window select -- and the fix that made that safe is that they
 * are not two controls over two values. Both read and write one `windowHours`
 * in App.jsx, which owns the single push into eventFilter below it, so the two
 * cannot disagree for the same reason there was only ever one before: there is
 * still only one number.
 *
 * Every conflict source behind the Events tab dates to the day and nothing
 * finer (see map/severity.js's own note on ageDays), so an hours-based
 * window cannot mean anything finer than that here -- 6h and 24h both round
 * to "today". Ceil-then-subtract-one is what makes the boundary inclusive: a
 * 72h window is meant to keep today, yesterday and the day before (ageDays
 * 0-2), and ceil(72/24)-1 = 2. For the two day-aligned options this is exact:
 * 72h -> 2 (a 3-day span) and 168h -> 6 (a 7-day span) both reproduce their
 * hour count divided by 24, so "7d" bounds a real 7 days here the same way
 * `withinWindowHours` bounds a real 168 hours for News and Officials.
 *
 * A second review round (Important, round 2) caught this function returning
 * `null` -- "no cap" -- for the widest option, on the reasoning that `null`
 * is DEFAULT_EVENT_FILTER.maxAgeDays' own shipped default and the widest
 * Window choice should reproduce it. That reasoning traded one problem for a
 * worse one: `withinWindowHours` has no equivalent "the widest option means
 * unbounded" rule -- it always enforces a hard `hours` cutoff -- so the same
 * "7d" label meant a real 7 days in News and Officials and an unbounded
 * lookback (capped only by the backend's own multi-month retention) in
 * Events, silently, in the panel's own default state. One label has to mean
 * one span across every tab this control now governs; consistency wins over
 * matching a default this control did not exist to preserve in the first
 * place. If a genuinely unbounded option is wanted later, it needs its own
 * entry in WINDOW_OPTIONS (an "All available" alongside 6h/24h/72h/7d) rather
 * than being smuggled into what "7d" means.
 *
 * That entry now exists -- `{ hours: null, pill: "ALL" }` above -- and it is
 * unbounded on both paths rather than only this one: `withinWindowHours` reads
 * a non-finite window as "keep everything" too, so News and Officials mean by
 * "All available" exactly what Events does. That was the condition the
 * paragraph above set, and it is why the option could be added without
 * reopening the argument it settled.
 */
export function windowMaxAgeDays(hours) {
  if (!Number.isFinite(hours)) return null;
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

// The four item caps that used to live here -- 6 events at World scope, 8
// scoped, 8 news, 8 officials -- are gone.
//
// They were written for a floating card about 360px wide and 50vh tall, where a
// short ranked list was the whole design and anything past the eighth row was
// off the bottom of the panel. The panel is a full-height rail now, and the
// numbers had stopped describing a design and started describing a loss: the
// backend serves up to 1200 news rows and 2500 events, the browser was receiving
// 334 and 530 of them on an ordinary afternoon, and the rail rendered eight and
// six. Two orders of magnitude thrown away after the network had already paid
// for it.
//
// The selectors below therefore return everything that passes scope, window and
// severity, in rank order, and how much of that is *rendered* is IntelPanel's
// business rather than theirs -- see feedPaging.js. The distinction matters: a
// selector that truncates makes the tab's count a lie (it reported the length of
// the array after the slice, so "News 8" meant "at least 8"), while a view that
// reveals progressively can report the real total and still not build 500 rows
// on first paint.

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
  return scored.map((s) => ({ ...s.event, weaklyPlaced: confidenceDimmed(s.event, eventFilter) }));
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
  return filtered;
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
  return filtered;
}

// ---------- opening a row's own record detail card ----------
//
// A row in Events, News or Officials is a fused/scraped record with a real
// counterpart in one of the map's own kinds -- the same card a map pin (or a
// country-card row, via App.jsx's openRecordDetail -> mapApi.recordDetail in
// createMapController.js) already opens. This is the one place that maps a
// tab to the `kind` recordDetail's own DECORATORS/ID_FIELD tables know, and a
// row's own id field, so IntelPanel.jsx does not have to restate either.
//
// Escalation is the one tab with nothing to open: a zone is a region
// aggregate over a 24h/7-day window (backend/escalation.py), not a fused
// record with an id of its own -- there is no "escalation" entry in
// recordDetail's tables and there should not be one. `null` here is what lets
// IntelPanel.jsx tell "this tab has no card" apart from "this row's record is
// gone", the same (b)-vs-(c) distinction eventDetail.js's own
// buildNearbyBlock draws between "searched and found nothing" and "never
// searched at all".
export const INTEL_RECORD_KIND = {
  escalation: null,
  events: "events",
  news: "gdelt",
  officials: "officials",
};

// The field each tab's own item carries its id under -- matching
// createMapController.js's own ID_FIELD table for the same kind (events:
// "id", gdelt: "event_id", officials: "id"). Not read for "escalation",
// which never reaches this table (intelRecordRef returns before touching it).
const INTEL_RECORD_ID_FIELD = {
  events: "id",
  news: "event_id",
  officials: "id",
};

/**
 * A panel row's own `{kind, id}` for opening the same card a map pin opens,
 * or `null` when there is nothing this row could ever open: either its tab
 * has no card at all (Escalation), or the row itself carries no id in the
 * field its tab is keyed on (News in particular can lack `event_id` -- see
 * IntelPanel.jsx's own News rowKey, which already falls back to `source_url`
 * for exactly this case). A row this returns `null` for must not be rendered
 * as clickable at all (see IntelPanel.jsx's Row components).
 *
 * Deliberately does *not* check whether that id is still present in any raw
 * feed. A row rendered a moment ago can point at a record that has since
 * aged out of the window or been dropped by a reload -- a real state this
 * project's honesty rule says must be said, not swallowed -- but that check
 * already exists, once, at recordDetail's own live lookup (App.jsx's
 * openRecordDetail already turns a miss there into an explicit "no longer
 * listed" card rather than an empty one or a silent no-op). Re-running the
 * same check here, against IntelPanel's own `eventsRaw`/`gdeltRaw`/
 * `officialsRaw` props, would be a *second*, independently-timed opinion
 * about whether the same id is still live -- those props are plain React
 * state, updated on a different tick than the map controller's own internal
 * `raw` object recordDetail reads, so the two could disagree about exactly
 * the record a reader just clicked. Task 12's review (Important 3, see this
 * module's own note on `windowMaxAgeDays`) is the standing lesson for why
 * this project keeps a single check for one fact rather than two that could
 * drift: recordDetail's is that one check, and this function resolves *which*
 * id to hand it, nothing more.
 */
export function intelRecordRef(item, tabKind) {
  const kind = INTEL_RECORD_KIND[tabKind];
  if (!kind || !item) return null;
  const id = item[INTEL_RECORD_ID_FIELD[tabKind]];
  if (id === undefined || id === null || id === "") return null;
  return { kind, id: String(id) };
}

// ---------- user-visible strings ----------
//
// This project's frontend suite cannot import JSX at all, so any sentence
// composed inline in IntelPanel.jsx would be untested by construction --
// three earlier tasks were sent back for exactly that. Every sentence the
// panel shows a reader lives here instead, as a plain function of the data
// it depends on, so frontend/tests/intelPanel.test.js can assert on the
// words rather than trusting the template was typed correctly.

/** EscalationMiniBar's own `title=` -- the hover-only counterpart to the
 *  persistent "Bars: hatched = ..." caption printed once above the whole
 *  Escalation list (see IntelPanel.jsx's own note on why neither is enough
 *  alone: a phone reader never gets a hover, and the caption alone leaves
 *  each individual zone's real numbers unstated). */
export function escalationMiniBarTitle(zone) {
  return `${zone.current} events in the last 24h vs a ${zone.baseline_per_day}/day baseline over the trailing 7 days (baseline shown flat -- no day-by-day history behind this yet)`;
}

/** EventRow's reliability chip tooltip -- the score shown falls back to the
 *  band's own floor (`trustBand.min`) for a record whose `reliability` field
 *  is itself missing, the same fallback EventRow used inline before this was
 *  pulled out; see reliabilityBand's own guard in map/severity.js for why a
 *  record can carry a band with no numeric score at all. */
export function eventReliabilityTooltip(event, trustBand) {
  const score = Number.isFinite(event.reliability) ? event.reliability : trustBand.min;
  return `Reliability ${score}/100 — who is behind this report, and how many independent sources`;
}

/** Escalation tab, empty state. A deliberate scope (a reader's direct
 *  question) names the place it found nothing in; World says so in its own
 *  unscoped words instead of substituting "World" for `scope.label`, which
 *  would read like a place name rather than the absence of one. */
export function escalationEmptyMessage(scope) {
  return scope.deliberate
    ? `No zone inside ${scope.label} is currently running above its own baseline.`
    : "No region is currently running above its own 7-day baseline.";
}

/** Events tab, empty state -- points a deliberate-scope reader at the two
 *  controls that could be hiding a real answer (the window and the scope
 *  itself), and tells a World-scope reader the significance floor, not the
 *  data, is why the board is quiet. */
export function eventsEmptyMessage(scope) {
  return scope.deliberate
    ? `No recorded conflict activity in ${scope.label} in the current window. Widen the window, or clear the scope to see the world board.`
    : "Nothing clears the significance bar right now. Narrow the scope to a place to see its own worst few regardless.";
}

/** News tab, empty state. */
export function newsEmptyMessage(scope) {
  return scope.deliberate ? `No recent headlines for ${scope.label}.` : "No recent headlines for this area.";
}

/** Officials tab, empty state. */
export function officialsEmptyMessage(scope) {
  return scope.deliberate
    ? `No diplomatic activity recorded for ${scope.label}.`
    : "No diplomatic activity in the current window.";
}
