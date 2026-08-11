// Turning live data into a tempo.
//
// The three tempo tokens in motion.css are a sentence the map has been saying
// since long before they had names: motion means "now", and how fast something
// moves says how urgent it is. These functions are how data gets to say it.

// The same threshold SourceStatusSection has always drawn `ok` against. One
// idea, one number -- a second threshold invented for motion is how a dot ends
// up green and still.
export const STALE_AFTER_SECONDS = 1800;

const URGENT = 1.1;
const AMBIENT = 6;

/**
 * How often a source's status dot should pulse, given how long ago it last
 * landed data.
 *
 * @param {number|null} secondsSinceSuccess
 * @returns {string|null} a CSS duration, or null for "do not animate"
 */
export function dotPeriod(secondsSinceSuccess) {
  // Number(null) is 0, not NaN, so null needs its own guard here or a source
  // with no recorded success would read as "just arrived" instead of stale.
  if (secondsSinceSuccess == null) return null;
  const age = Number(secondsSinceSuccess);
  if (!Number.isFinite(age) || age < 0 || age >= STALE_AFTER_SECONDS) return null;

  // Logarithmic, because source cadences span three orders of magnitude -- AIS
  // lands every few seconds and ACLED daily -- and a linear map would put every
  // source except the fastest at the same indistinguishable crawl.
  const t = Math.log10(1 + age) / Math.log10(1 + STALE_AFTER_SECONDS);
  const period = URGENT + (AMBIENT - URGENT) * t;
  return `${Math.min(AMBIENT, Math.max(URGENT, period)).toFixed(2)}s`;
}
