// Is a source healthy? One answer, for every surface that asks.
//
// There were two copies of this predicate -- one in components/chrome/hudLogic.js
// for the status strip, one in components/controlPanel/SourceStatusSection.jsx for
// the admin drawer -- identical by hand rather than by import, and both wrong in
// the same way:
//
//   let state = "err";
//   if (!info.key_configured && info.last_error) state = "warn";
//   if (info.last_success && info.seconds_since_success < STALE_AFTER_SECONDS) state = "ok";
//
// STALE_AFTER_SECONDS is 1800, and it was applied to all 57 sources. Only 24 of
// them poll at or under half an hour. The rest run on one-hour to seven-day
// cadences -- countries daily, railways and dams weekly, admin boundaries weekly,
// osm_infra daily -- so each was green for thirty minutes after a successful fetch
// and red for the remainder of its own correct interval. At any instant a couple
// happened to be inside their window, which is how the HUD came to read
// "Sources 26/57" on a deployment where essentially one source was actually
// broken. The drawer's tooltip said `railways: failing` about a reference set that
// had fetched successfully three hours earlier, on a seven-day schedule, with
// last_error null.
//
// The backend has always known better -- mirror.health_verdict judges a mirrored
// source against `expected_every * INGEST_STALE_MULTIPLIER` -- and simply never
// sent the number. It does now (see cache.SourceState.expected_every, and
// storage.observed_cadence for why it is measured rather than declared), so this
// asks the only question worth asking: is this source late *by its own standards*.

/** The multiplier the backend's own staleness check uses
 *  (config.INGEST_STALE_MULTIPLIER). Kept in step deliberately: a source the API
 *  is about to describe as frozen should not still be green here. */
export const STALE_MULTIPLIER = 2.5;

/** The fallback window for a source whose cadence nothing has measured yet, and
 *  the floor under every computed one. A fast source that reports every 10s must
 *  not be called late at 25s -- a single missed poll is not an outage. */
export const MIN_STALE_SECONDS = 1800;

export const SOURCE_OK = "ok";
export const SOURCE_WARN = "warn";
export const SOURCE_ERR = "err";
/** Has not reported yet, and nothing says it should have. Distinct from `err` on
 *  purpose: "no answer yet" and "answered badly" are different facts, and calling
 *  the first one a failure is the same mistake as a confident 0 over a dead feed. */
export const SOURCE_WAITING = "waiting";

/**
 * How long this source may go quiet before it is late.
 *
 * @param {{expected_every?: number}} info  one /api/health row
 * @returns {number} seconds
 */
export function staleAfter(info) {
  const cadence = Number(info?.expected_every);
  if (!Number.isFinite(cadence) || cadence <= 0) return MIN_STALE_SECONDS;
  return Math.max(MIN_STALE_SECONDS, cadence * STALE_MULTIPLIER);
}

/**
 * One source's state.
 *
 * @param {object} info  one /api/health row
 * @returns {"ok"|"warn"|"err"|"waiting"}
 */
export function sourceState(info) {
  if (!info || typeof info !== "object") return SOURCE_WAITING;

  if (info.last_success) {
    const age = Number(info.seconds_since_success);
    if (Number.isFinite(age) && age < staleAfter(info)) return SOURCE_OK;
  }

  // A credential this deployment has not set. Amber, not red: nothing is broken
  // and nobody needs to fix anything -- it is a layer this deployment has chosen
  // not to carry. Unreachable until recently, because key_configured was
  // hardcoded true for every mirrored source (see backend/mirror.py's
  // credential_missing), so an unconfigured source rendered the same red as a
  // collector that had actually failed.
  if (info.key_configured === false) return SOURCE_WARN;

  // An error is evidence that something was attempted and did not work, whatever
  // else is or is not known about this source. Checked before the "waiting" case
  // below, because a source that has never succeeded *and* is carrying an error has
  // not gone unasked -- it has answered badly.
  if (info.last_error) return SOURCE_ERR;

  // Never reported, no error, and nothing has established how often it should
  // report. Two real cases: a source whose first fetch has not landed yet, and one
  // with no schedule at all (the weather proxy answers on demand). Neither is a
  // failure, and calling either one red is the same mistake as a confident 0 over a
  // feed nobody has queried.
  if (!info.last_success && !Number.isFinite(Number(info.expected_every))) return SOURCE_WAITING;

  return SOURCE_ERR;
}

/** Worst first, for a strip with room for five dots out of fifty-seven sources. */
export const SOURCE_STATE_ORDER = {
  [SOURCE_ERR]: 0,
  [SOURCE_WARN]: 1,
  [SOURCE_WAITING]: 2,
  [SOURCE_OK]: 3,
};

/** What to say about a source that is not ok, in a tooltip with no room to
 *  explain. Each names the thing to *do* about it, which "failing" never did. */
export function sourceStateLabel(state) {
  switch (state) {
    case SOURCE_WARN:
      return "not configured here";
    case SOURCE_WAITING:
      return "no report yet";
    case SOURCE_ERR:
      return "failing";
    default:
      return "reporting";
  }
}

/**
 * How late a source is against its own cadence, as a sentence, or null when it is
 * on time. For the tooltip that used to read "railways: failing" about a source
 * three hours into a seven-day interval.
 */
export function sourceLatenessNote(info) {
  const age = Number(info?.seconds_since_success);
  if (!info?.last_success || !Number.isFinite(age)) return null;
  const limit = staleAfter(info);
  const hours = (seconds) => (seconds >= 3600 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 60)}m`);
  if (age < limit) return `last reported ${hours(age)} ago, within its usual ${hours(limit)}`;
  return `last reported ${hours(age)} ago, and it usually reports within ${hours(limit)}`;
}
