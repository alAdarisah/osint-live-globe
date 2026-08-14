// Task 44: "the scrubber shows which kinds actually have history for the
// window" -- the plan's own central rule for this task, restated in
// task-44-brief.md. /api/replay?kind=<name> (backend/app.py, task 44a)
// answers this per kind with three distinguishable states -- "ok" (has
// history; the window itself may still be empty, which is a different,
// honest "nothing happened" answer this module never has to represent,
// since it's carried straight through in `items`), "no_history" (this kind
// has never recorded a row -- reads as "no data", never as "nothing
// happened"), "unavailable" (the database itself could not be reached).
// This module turns that per-kind status into the labels and sentences the
// scrubber shows, kept out of TimelineBar.jsx (a .jsx file node --test
// cannot import) so the wording has headless coverage -- see
// frontend/tests/replayAvailability.test.js.
//
// A fourth state exists only on this side of the wire: "refused". The
// backend's window ceiling (see backend/app.py's _REPLAY_MAX_WINDOW_SECONDS)
// 400s a kind whose configured replay window exceeds what entity_history's
// three-day retention can answer for a single request -- and "events" is
// exactly such a kind today (a 7-day configured window against the 3-day
// ceiling), reported as a known asymmetry by task-44a-report.md: the legacy
// no-kind bundle still replays events fine, but asking for it by name via
// ?kind=events is refused outright. That is a real, structural fact about
// this deployment, not a network hiccup or an empty table, so it gets its
// own state and its own honest sentence below rather than being folded into
// "unavailable" (which would claim the database is down, false) or silently
// dropped from the readout (which would claim the kind was never asked
// about at all).
//
// A fifth, "error", covers everything else a fetch can do wrong -- a 5xx, a
// network failure -- distinct from all of the above because none of them
// are a statement the backend actually made; the request just didn't
// complete.

/**
 * The kinds the scrubber's readout covers: exactly the five the legacy
 * no-kind bundle replays (backend/app.py's replay_at, the branch with no
 * `kind` argument) -- these are the kinds playback actually paints onto the
 * map frame by frame, so they're what "does this window have data" needs to
 * answer about. A kind with no independent existence on the bundle (e.g.
 * `conflict_history`, which is fused into `events` before either reaches the
 * map) has nothing separate to report here.
 */
export const REPLAY_KINDS = [
  { key: "events", label: "Conflict events" },
  { key: "firms", label: "Fires (FIRMS)" },
  { key: "gdelt", label: "News (GDELT)" },
  { key: "ais", label: "Ships (AIS)" },
  { key: "adsb", label: "Aircraft (ADS-B)" },
];

const KIND_LABELS = Object.fromEntries(REPLAY_KINDS.map((k) => [k.key, k.label]));

/** The label a kind key shows in the scrubber, or the raw key if this build
 *  is ever asked about one REPLAY_KINDS doesn't list. */
export function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}

/** A short badge word for the kind row -- what fits next to the dot, not the
 *  full sentence (that's describeKindAvailability below, read from the
 *  badge's own title/tooltip). */
export function kindStatusBadge(status) {
  switch (status) {
    case "ok":
      return "history";
    case "no_history":
      return "no data";
    case "unavailable":
      return "unavailable";
    case "refused":
      return "config limit";
    case "error":
      return "check failed";
    default:
      return "checking…";
  }
}

/**
 * The full sentence a kind row's tooltip/title reads, one per status. Plain
 * language, no provenance claim about any entity (this describes the
 * *availability check itself*, not a position or an event) -- but still
 * exact about what each state actually means, per this project's "attribution
 * beats recall" rule: a reader hovering this must come away knowing whether
 * "no data" means the kind never recorded anything at all, or something
 * else entirely.
 */
export function describeKindAvailability(kind, status) {
  const label = kindLabel(kind);
  switch (status) {
    case "ok":
      return `${label}: has recorded history -- the scrubber can replay it across this window.`;
    case "no_history":
      return `${label}: no data -- this kind has never recorded a row here, which is a different claim than an empty window.`;
    case "unavailable":
      return `${label}: unavailable -- the history database could not be reached, so this could not be checked.`;
    case "refused":
      return (
        `${label}: not checked here -- its configured replay window is wider than a single request ` +
        "is allowed to query, so the backend refuses it by name. The live map's own replay (no kind " +
        "named) still serves it; only this per-kind check cannot."
      );
    case "error":
      return `${label}: the availability check itself failed -- try again, this isn't a statement about whether data exists.`;
    default:
      return `${label}: checking…`;
  }
}

/**
 * One line summarising however many kinds are still being checked, out of
 * how many total -- what the scrubber shows while fetchKindAvailability is
 * still awaiting some of REPLAY_KINDS. Returns null once nothing is pending,
 * so a caller can render nothing rather than a stale "checking" line.
 */
export function describeAvailabilityLoading(pendingCount, totalCount) {
  if (pendingCount <= 0) return null;
  return `Checking which of ${totalCount} kinds have history… (${pendingCount} left)`;
}

/**
 * The sentence TimelineBar shows when playback has degraded to a coarser
 * step than settings configured -- the "observable, not a silent lie" half
 * of task-44-brief.md's prefetch requirement. `configuredMinutes` is what
 * settings.replay.stepMinutes actually asked for; `currentMinutes` is what
 * playback is actually running at right now, which nextDegradeState
 * (replay/playback.js) may have doubled one or more times since. Returns
 * null when they match, i.e. nothing to say.
 */
export function describePlaybackDegraded(configuredMinutes, currentMinutes) {
  if (!(currentMinutes > configuredMinutes)) return null;
  return (
    `Playback slowed to ${currentMinutes}min steps (configured: ${configuredMinutes}min) -- ` +
    "responses are arriving slower than the frame rate can wait for it, so the sweep is showing " +
    "fewer, wider-spaced moments instead of stalling."
  );
}
