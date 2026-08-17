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

export function escalationReadout(zones) {
  if (!Array.isArray(zones) || zones.length === 0) {
    return { ...unknown("No zone is currently running above its own baseline, or the ranking has not loaded."), needle: null };
  }
  const ratios = zones.map((zone) => Number(zone?.ratio)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ratios.length) {
    return { ...unknown("The escalation ranking carried no usable ratio."), needle: null };
  }
  const worst = Math.max(...ratios);
  const top = zones.find((zone) => Number(zone?.ratio) === worst);
  return {
    text: `${worst % 1 === 0 ? worst : worst.toFixed(1)}×`,
    title:
      `${top?.label || "The hottest ranked zone"} is running ${worst}× its own 7-day baseline` +
      `${top?.current != null && top?.baseline_per_day != null ? ` (${top.current} in 24h vs ${top.baseline_per_day}/day)` : ""}.`,
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
    return unknown("No GPS interference cells are loaded.");
  }
  const ratios = cells.map((cell) => Number(cell?.jam_ratio)).filter((n) => Number.isFinite(n));
  if (!ratios.length) return unknown("The interference feed carried no usable ratio.");
  const worst = Math.max(...ratios);
  return {
    text: `${Math.round(worst * 100)}%`,
    title:
      `Worst tracked cell: ${Math.round(worst * 100)}% of aircraft in it reporting bad GPS fixes ` +
      `(GPSJam, ${cells.length} cell${cells.length === 1 ? "" : "s"} loaded).`,
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
export function countReadout(counts, key, label) {
  const visible = counts?.[key];
  const total = counts?.[`${key}Total`];
  if (!Number.isFinite(total) || total === 0) {
    return unknown(`No ${label} have been received yet.`);
  }
  return {
    text: Number(visible ?? 0).toLocaleString(),
    title: `${Number(visible ?? 0).toLocaleString()} ${label} drawn here, of ${Number(total).toLocaleString()} held.`,
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
  if (held === 0) return unknown(`No ${label} have been received yet.`);
  const visible = keys.map((key) => Number(counts?.[key])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
  return {
    text: visible.toLocaleString(),
    title: `${visible.toLocaleString()} ${label} drawn here, of ${held.toLocaleString()} held.`,
    known: true,
  };
}

/**
 * How many layers are currently drawn. Counted off what the map reports it is
 * doing (mapApi.layerState.on), not off the wish table -- a layer pinned on and
 * held back by its own zoom gate is not a layer on screen, and this cell claims
 * to say what is.
 */
export function layerCountReadout(layerVisibility) {
  if (!layerVisibility || typeof layerVisibility !== "object") {
    return unknown("The map has not reported which layers it is drawing.");
  }
  const on = Object.values(layerVisibility).filter(Boolean).length;
  return {
    text: String(on),
    title: `${on} layer${on === 1 ? "" : "s"} currently drawn. A layer switched on but held back by its own zoom gate is not counted here.`,
    known: true,
  };
}

/**
 * Freshness: how long ago the *stalest* source that is otherwise healthy last
 * succeeded. Not an average and not the fastest -- a strip that reports the
 * best number it can find is a strip that hides the feed that stopped.
 */
export function latencyReadout(health) {
  const ages = sourceRows(health)
    .map(([, info]) => Number(info?.seconds_since_success))
    .filter((n) => Number.isFinite(n));
  if (!ages.length) return unknown("No source has reported a successful fetch yet.");
  const worst = Math.max(...ages);
  return {
    text: worst >= 3600 ? `${Math.round(worst / 3600)}h` : worst >= 90 ? `${Math.round(worst / 60)}m` : `${worst}s`,
    title: `The stalest source last succeeded ${worst}s ago. Sources are considered stale past ${STALE_AFTER_SECONDS}s.`,
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
export function sourceReadout(health, dotLimit = 5) {
  const rows = sourceRows(health);
  if (!rows.length) return { ...unknown("/api/health has not answered yet."), dots: [], ok: null, total: 0 };

  const states = rows.map(([name, info]) => {
    let state = "err";
    if (!info.key_configured && info.last_error) state = "warn";
    if (info.last_success && info.seconds_since_success < STALE_AFTER_SECONDS) state = "ok";
    return { name, state };
  });
  const ok = states.filter((s) => s.state === "ok").length;

  // Worst first, so the handful of dots that fit are the ones worth seeing. A
  // strip with room for five dots out of twelve sources must not spend them on
  // the five that are fine.
  const order = { err: 0, warn: 1, ok: 2 };
  const dots = [...states].sort((a, b) => order[a.state] - order[b.state]).slice(0, dotLimit);

  return {
    text: `${ok}/${states.length}`,
    title: states
      .filter((s) => s.state !== "ok")
      .map((s) => `${s.name}: ${s.state === "warn" ? "no key" : "failing"}`)
      .join(" · ") || `All ${states.length} sources reporting fresh data.`,
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
export function liveReadout({ isReplaying, replayAt } = {}) {
  if (!isReplaying) return { live: true, text: "LIVE", title: "Every layer is showing its latest data." };
  const at = Number.isFinite(replayAt) ? new Date(replayAt) : null;
  return {
    live: false,
    text: "NOT LIVE",
    title: at
      ? `Replaying ${at.toISOString().replace("T", " ").slice(0, 16)} UTC. Live updates are paused until you go live.`
      : "Replaying a past moment. Live updates are paused until you go live.",
  };
}
