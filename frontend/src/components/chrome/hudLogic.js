// What the bottom status strip is allowed to say.
//
// Every reader here returns `{ text, title, … }` where `text` is "—" when the
// answer is not known yet, and never `0`. That distinction is the whole point
// of this module: "no aircraft are being tracked" and "the aircraft feed has
// not answered" render identically as a zero, and on a map whose entire claim
// is that it says where its numbers came from, a confident 0 over a dead feed
// is the worst thing a status strip can do. It is the same rule the refine
// panels already follow through components/refinePanelStatus.js, applied to a
// row of numbers instead of a panel.
//
// Pure, and given plain data rather than hooks, so all of it is testable under
// `node --test` with no DOM.

// Extension included: this module is imported straight by `node --test`, which
// does not do Vite's extensionless resolution.
import { STALE_AFTER_SECONDS } from "../../utils/tempo.js";
import {
  sourceState, sourceStateLabel, sourceLatenessNote,
  SOURCE_OK, SOURCE_STATE_ORDER, STALE_MULTIPLIER,
} from "../../utils/sourceState.js";

/** The value every cell shows when it does not know. */
export const UNKNOWN = "—";

const unknown = (title) => ({ text: UNKNOWN, title, known: false });

/**
 * Escalation: the hottest zone's ratio against its own baseline, from
 * backend/escalation.py's ranking (the same array IntelPanel's Escalation tab
 * lists row by row).
 *
 * `needle` is a 0..1 position along the strip's gradient, not the ratio: the
 * gradient runs calm-to-critical and a ratio is unbounded, so it is clamped
 * against a ceiling above which "worse" stops being a distinction anyone can
 * act on. Returns null when there is nothing ranked, so the caller draws the
 * bar empty rather than parking the needle at the calm end -- which would read
 * as "measured, and fine".
 */
export const ESCALATION_CEILING = 5;

// What each number means, as opposed to what it currently is.
//
// Every cell in the strip used to say only the second, and every one of them was
// legible only to someone who already knew the metric. "Kashmir is running 3.1×
// its own 7-day baseline" assumes the reader knows what is being counted and
// whether 3.1 is a lot; "100% of aircraft reporting bad GPS fixes" reads as an
// emergency when it can be two aircraft in one hex on yesterday's data; "150
// events" reads as how many exist rather than how many are on screen; and
// Freshness and Sources answer two genuinely different questions in numbers that
// look like the same question asked twice.
//
// So every title leads with the explanation and ends with the live reading, under
// "Right now:". The order matters: a tooltip that opens with today's number
// teaches nothing on the second read, and this text is read once and then relied
// on for the rest of a session.
//
// Exported, and collected into STATUS_STRIP_EXPLAINERS below, because the Legend
// prints the same sentences (see its "Status strip" section): a native `title`
// never fires on a touch screen, which is the same reason the attribution
// disclaimer is repeated there. Two hand-written copies of an explanation are two
// explanations that can disagree, and the drift that actually happens is a new
// cell whose explainer the reference panel never learns about.
export const ESCALATION_EXPLAINER =
  "How much busier the worst conflict zone is than it usually is -- not how bad it is. "
  + "Conflict events in the last 24 hours, against that zone's own average over the "
  + "previous 7 days. 1× is a normal week; 3× is three times its own usual rate.\n\n"
  + "Every zone is judged against itself, because absolute counts are not comparable: "
  + "a zone that always sees 40 events a day is not escalating, and one that normally "
  + "sees 2 and just saw 9 is. So a quiet region can top this with a handful of events "
  + "while a heavily contested one sits at 1×. A zone needs at least 3 events in the "
  + "window to be ranked at all, and the bar next to the number tops out at 5×.";

export const JAMMING_EXPLAINER =
  "Where GPS is being interfered with, from aircraft that report their own fix "
  + "quality. Each cell is a hex about 45 km across; the figure is the share of "
  + "aircraft inside the worst one that reported a bad fix.\n\n"
  + "The worst single cell, not an average -- averaged across a mostly-quiet world "
  + "grid the number would be small, true, and useless. Read it with the aircraft "
  + "count beside it: 100% of 3 aircraft is a thin sample, 60% of 200 is not. "
  + "Cells below 25% affected are dropped as background noise and only the worst 100 "
  + "are kept, so an empty reading means no cell cleared that bar, not that GPS is "
  + "fine everywhere. Updated once a day by the publisher, so this is yesterday's "
  + "picture rather than a live one.";

export function escalationReadout(zones) {
  if (!Array.isArray(zones) || zones.length === 0) {
    return {
      ...unknown(`${ESCALATION_EXPLAINER}\n\nRight now: no zone is running above its own baseline, or the ranking has not loaded.`),
      needle: null,
    };
  }
  const ratios = zones.map((zone) => Number(zone?.ratio)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ratios.length) {
    return {
      ...unknown(`${ESCALATION_EXPLAINER}\n\nRight now: the escalation ranking carried no usable ratio.`),
      needle: null,
    };
  }
  const worst = Math.max(...ratios);
  const top = zones.find((zone) => Number(zone?.ratio) === worst);
  return {
    text: `${worst % 1 === 0 ? worst : worst.toFixed(1)}×`,
    title:
      `${ESCALATION_EXPLAINER}\n\nRight now: ` +
      `${top?.label || "the hottest ranked zone"} is running ${worst}× its own 7-day baseline` +
      `${top?.current != null && top?.baseline_per_day != null ? ` (${top.current} in the last 24h against ${top.baseline_per_day}/day)` : ""}.`,
    known: true,
    needle: Math.min(1, worst / ESCALATION_CEILING),
  };
}

/**
 * GPS jamming: the worst tracked cell, as the share of aircraft in it
 * reporting bad fixes (`jam_ratio`, straight off backend/sources/jamming.py).
 *
 * Deliberately "the worst cell", not an average over cells: averaging a
 * global grid of mostly-quiet squares produces a small number that is true and
 * says nothing, and the question this cell answers is whether interference is
 * happening anywhere the map is currently drawing.
 */
export function jammingReadout(cells) {
  if (!Array.isArray(cells) || cells.length === 0) {
    return unknown(`${JAMMING_EXPLAINER}\n\nRight now: no interference cells are loaded.`);
  }
  const ratios = cells.map((cell) => Number(cell?.jam_ratio)).filter((n) => Number.isFinite(n));
  if (!ratios.length) {
    return unknown(`${JAMMING_EXPLAINER}\n\nRight now: the interference feed carried no usable ratio.`);
  }
  const worst = Math.max(...ratios);
  const cell = cells.find((c) => Number(c?.jam_ratio) === worst);
  // The sample size behind the percentage, which is the fact the old wording left
  // out and the one that decides how much the number is worth. jamming.py carries
  // per-cell good/bad aircraft counts and nothing was reading them; a cell can
  // qualify on two aircraft (MIN_TRAFFIC), so "100%" with no denominator was the
  // most alarming way to say the least.
  const bad = Number(cell?.bad);
  const good = Number(cell?.good);
  const sample = Number.isFinite(bad) && Number.isFinite(good) && bad + good > 0
    ? ` -- ${bad} of ${bad + good} aircraft in it`
    : "";
  return {
    text: `${Math.round(worst * 100)}%`,
    title:
      `${JAMMING_EXPLAINER}\n\nRight now: the worst tracked cell is ${Math.round(worst * 100)}%`
      + `${sample}, out of ${cells.length} cell${cells.length === 1 ? "" : "s"} loaded (GPSJam).`,
    known: true,
  };
}

/**
 * A plain count off mapApi.counts, showing visible and global the way every
 * layer row in the drawer already does -- a thinned view must never read as a
 * broken feed.
 *
 * `counts` starts as a table of real zeroes before the first payload lands, so
 * "is this known" cannot be read off the number. It is known once the total is
 * above zero, or once the feed has reported success; below that this says so.
 */
export const COUNT_EXPLAINER =
  "Two numbers, and the second is the one that stops the first from misleading you: "
  + "what is drawn on screen right now, out of everything received for the current "
  + "time window.\n\n"
  + "They differ for reasons that are all deliberate -- records outside the viewport, "
  + "layers below their own zoom gate, per-zoom caps that thin a crowded board, and "
  + "whatever you have set in the panel's own filters. So this figure falling as you "
  + "zoom in is the map scoping to what you are looking at, not a feed going quiet. "
  + "The pair is the only way to tell those apart, which is why no cell here ever "
  + "shows a bare count.";

export function countReadout(counts, key, label) {
  const visible = counts?.[key];
  const total = counts?.[`${key}Total`];
  if (!Number.isFinite(total) || total === 0) {
    return unknown(`${COUNT_EXPLAINER}\n\nRight now: no ${label} have been received yet.`);
  }
  return {
    text: Number(visible ?? 0).toLocaleString(),
    title:
      `${COUNT_EXPLAINER}\n\nRight now: ${Number(visible ?? 0).toLocaleString()} ${label} `
      + `drawn here, of ${Number(total).toLocaleString()} held.`,
    known: true,
  };
}

/**
 * The same, over several count keys at once -- "Aircraft" is ADS-B civilian
 * plus military, "Vessels" is three AIS classes. Unknown unless at least one of
 * them has actually received something, so a partial outage still reports the
 * feeds that are up rather than blanking the whole cell.
 */
export function sumCountReadout(counts, keys, label) {
  const totals = keys.map((key) => Number(counts?.[`${key}Total`])).filter(Number.isFinite);
  const held = totals.reduce((a, b) => a + b, 0);
  if (held === 0) return unknown(`${COUNT_EXPLAINER}

Right now: no ${label} have been received yet.`);
  const visible = keys.map((key) => Number(counts?.[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
  return {
    text: visible.toLocaleString(),
    title:
      `${COUNT_EXPLAINER}

Right now: ${visible.toLocaleString()} ${label} drawn here, `
      + `of ${held.toLocaleString()} held.`,
    known: true,
  };
}

/**
 * How many layers are currently drawn. Counted off what the map reports it is
 * doing (mapApi.layerState.on), not off the wish table -- a layer pinned on and
 * held back by its own zoom gate is not a layer on screen, and this cell claims
 * to say what is.
 */
export const LAYERS_EXPLAINER =
  "How many of the map's layers are actually being drawn -- counted off what the map "
  + "reports it is doing, not off what has been switched on.\n\n"
  + "It moves as you zoom, and that is the scene resolver rather than anything "
  + "breaking: most layers are gated to a zoom band, so panning out drops them and "
  + "zooming in brings them back. A layer you have ticked but which is still below its "
  + "own gate is not counted here, because it is not on screen -- its checkbox goes "
  + "amber and says so. Use the pills along the top to see which layers those are.";

export function layerCountReadout(layerVisibility) {
  // `{}` has to be caught as well as null, and it is the *only* case the guard was
  // ever going to see: useLeafletMap seeds layerState as { on: {}, wish: {} }, so
  // between mount and the map's first report this cell was handed an empty object,
  // passed the typeof check, and rendered a confident "0 layers currently drawn"
  // over a map that had not answered yet. Precisely what this module's own header
  // calls the worst thing a status strip can do.
  if (!layerVisibility || typeof layerVisibility !== "object" || !Object.keys(layerVisibility).length) {
    return unknown(`${LAYERS_EXPLAINER}

Right now: the map has not reported which layers it is drawing.`);
  }
  const on = Object.values(layerVisibility).filter(Boolean).length;
  return {
    text: String(on),
    title: `${LAYERS_EXPLAINER}

Right now: ${on} layer${on === 1 ? "" : "s"} drawn.`,
    known: true,
  };
}

/**
 * Freshness: how long ago the stalest source that is otherwise healthy last
 * succeeded. Not an average and not the fastest -- a strip that reports the
 * best number it can find is a strip that hides the feed that stopped.
 */
export const FRESHNESS_EXPLAINER =
  "How long ago the stalest source last managed a successful fetch -- the worst "
  + "one, not an average and not the best. A strip that reports the best number it "
  + "can find is a strip that hides the feed that stopped.\n\n"
  + "So a large figure here does not mean the map is stale; it means one source is, "
  + "and it does not by itself mean anything is wrong. The feeds run on wildly "
  + "different clocks -- aircraft every few seconds, a country-boundary set once a "
  + "week -- and this cell judges them all against one flat "
  + `${STALE_AFTER_SECONDS}s mark, so a weekly reference file three hours past its `
  + "last fetch reads as hours old and is perfectly healthy. Sources, next along, is "
  + "the cell that judges each feed against its own cadence; that is the one to read "
  + "for whether something is actually broken.";

export function latencyReadout(health) {
  const ages = sourceRows(health)
    .map(([, info]) => Number(info?.seconds_since_success))
    .filter((n) => Number.isFinite(n));
  if (!ages.length) {
    return unknown(`${FRESHNESS_EXPLAINER}

Right now: no source has reported a successful fetch yet.`);
  }
  const worst = Math.max(...ages);
  return {
    text: worst >= 3600 ? `${Math.round(worst / 3600)}h` : worst >= 90 ? `${Math.round(worst / 60)}m` : `${worst}s`,
    title: `${FRESHNESS_EXPLAINER}

Right now: the stalest source last succeeded ${worst}s ago.`,
    known: true,
  };
}

/**
 * /api/health's per-source rows. Same shape filter SourceStatusSection uses --
 * anything without an item_count is not a source row, so a future addition to
 * that payload cannot render as a source with undefined everything.
 */
export function sourceRows(health) {
  if (!health || typeof health !== "object") return [];
  return Object.entries(health).filter(
    ([name, info]) => name !== "owm_weather" && info && typeof info === "object" && "item_count" in info,
  );
}

/**
 * The dots, and the "n/m" beside them. Status per source uses exactly the
 * classification SourceStatusSection renders in the drawer, so a reader who
 * checks the detailed list never finds it disagreeing with the strip.
 */
export const SOURCES_EXPLAINER =
  "How many of the map's data sources are currently reporting on schedule, out of "
  + "how many it carries. The dots beside the number are the worst-off sources, worst "
  + "first -- there is room for five and they are never spent on five that are fine."
  + "\n\nEach source is judged against its own cadence rather than one shared "
  + `deadline: it is late once it has gone quiet for ${STALE_MULTIPLIER}x as long as `
  + "it normally takes, with a half-hour floor. That is the difference between this "
  + "cell and Freshness beside it, and it is the whole reason this number is "
  + "trustworthy: this cell once judged every source against one half-hour deadline "
  + "and reported 26 of 57 working on a deployment with a single broken feed, because "
  + "most sources are not supposed to report every half hour."
  + "\n\nNot everything short of the total is a fault. A source can be waiting for "
  + "its first fetch, or be a feed this deployment has deliberately not configured a "
  + "key for -- neither is broken, and both are named in the list rather than counted "
  + "as failures. Hover reads them out; the control drawer has the same list in full.";

export function sourceReadout(health, dotLimit = 5) {
  const rows = sourceRows(health);
  if (!rows.length) {
    return {
      ...unknown(`${SOURCES_EXPLAINER}

Right now: /api/health has not answered yet.`),
      dots: [], ok: null, total: 0,
    };
  }

  // Imported rather than restated. This predicate existed twice, by hand, in this
  // file and in the drawer's SourceStatusSection -- and both copies judged all 57
  // sources against one flat half-hour threshold, which is why this cell read
  // 26/57 on a deployment with one genuinely broken source. See
  // utils/sourceState.js.
  const states = rows.map(([name, info]) => ({ name, state: sourceState(info), info }));
  const ok = states.filter((s) => s.state === SOURCE_OK).length;

  // Worst first, so the handful of dots that fit are the ones worth seeing. A
  // strip with room for five dots out of fifty-seven sources must not spend them
  // on the five that are fine.
  const dots = [...states]
    .sort((a, b) => SOURCE_STATE_ORDER[a.state] - SOURCE_STATE_ORDER[b.state])
    .slice(0, dotLimit);

  return {
    text: `${ok}/${states.length}`,
    // Each troubled source says what kind of trouble, and how late it is against
    // its *own* cadence. The old wording was `name: failing` for everything that
    // was not green, which is how a seven-day reference set three hours past its
    // last fetch came to be described as a failure.
    title: `${SOURCES_EXPLAINER}

Right now: ${states
      .filter((s) => s.state !== SOURCE_OK)
      .map((s) => {
        const note = sourceLatenessNote(s.info);
        return `${s.name} -- ${sourceStateLabel(s.state)}${note ? ` (${note})` : ""}`;
      })
      .join(" · ") || `all ${states.length} sources reporting within their own cadence.`}`,
    known: true,
    dots,
    ok,
    total: states.length,
  };
}

/**
 * `26.000°N 30.000°E`. Three decimals is about 110m at the equator -- fine
 * enough to read a position off the map, coarse enough not to imply the map
 * knows where something is to the metre.
 */
export function formatCursorCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return UNKNOWN;
  // Wrapped, because Leaflet reports longitudes past ±180 once the reader pans
  // into a repeated world copy, and "412.500°E" is not a place.
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return (
    `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? "N" : "S"} ` +
    `${Math.abs(wrapped).toFixed(3)}°${wrapped >= 0 ? "E" : "W"}`
  );
}

/**
 * Whether the map is showing now or a moment in the past. The strip's job here
 * is to make "not live" impossible to miss -- see App.jsx's own note on why
 * replay used to be Admin-Mode-only, and what replaced that argument.
 */
export const CURSOR_EXPLAINER =
  "Where the pointer is, in WGS84 latitude and longitude -- the same coordinates "
  + "every popup and every export uses.\n\n"
  + "Three decimals, which is about 110 m at the equator: fine enough to read a "
  + "position off the map, and deliberately too coarse to imply this map knows where "
  + "anything is to the metre. Most of what it draws is placed far less precisely "
  + "than that, and a pin's own popup is where that is stated.";

export const REPLAY_EXPLAINER =
  "Shown only when the map is not live. Every other figure in this strip -- the "
  + "counts, the escalation ratio, the interference reading -- then describes the "
  + "moment being replayed rather than now, which is the reason this cell exists at "
  + "all rather than a quiet indicator somewhere.";

/**
 * Every cell's explanation, in the order the strip draws them.
 *
 * The Legend walks this rather than naming each constant, which is what makes the
 * two surfaces impossible to drift apart -- including in the direction that actually
 * happens: a cell added to the strip with an explainer of its own, and the Legend
 * left listing the old set. Labels match the cells' own <span className="hud-label">
 * text, because a reader arrives here having read one of those.
 *
 * Cursor is in the table and Replay is not. Replay's cell exists only while the map
 * is not live, so a permanent entry in a reference panel would explain a control
 * most readers never see; its tooltip carries the same text when it appears. The
 * attribution cell has no entry either -- the Legend already prints that text in
 * full, one section down, which is why the cell was given a tooltip in the first
 * place.
 */
export const STATUS_STRIP_EXPLAINERS = [
  { label: "Escalation", text: ESCALATION_EXPLAINER },
  { label: "GPS jam", text: JAMMING_EXPLAINER },
  { label: "Events", text: COUNT_EXPLAINER },
  { label: "Layers", text: LAYERS_EXPLAINER },
  { label: "Freshness", text: FRESHNESS_EXPLAINER },
  { label: "Sources", text: SOURCES_EXPLAINER },
  { label: "Cursor", text: CURSOR_EXPLAINER },
];

export function liveReadout({ isReplaying, replayAt } = {}) {
  if (!isReplaying) return { live: true, text: "LIVE", title: "Every layer is showing its latest data." };
  const at = Number.isFinite(replayAt) ? new Date(replayAt) : null;
  return {
    live: false,
    text: "NOT LIVE",
    title: at
      ? `${REPLAY_EXPLAINER}

Right now: replaying ${at.toISOString().replace("T", " ").slice(0, 16)} UTC. Live updates are paused until you go live.`
      : `${REPLAY_EXPLAINER}

Right now: replaying a past moment. Live updates are paused until you go live.`,
  };
}
