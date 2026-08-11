// A number that changes is worth noticing. A number that changes by rolling to
// its new value is worth noticing without anyone having been watching it.
//
// Deliberately not applied to anything that counts people -- see CountUp.jsx.

import { useEffect, useRef, useState } from "react";

// Matches --t-settle. Stated here rather than read from the stylesheet because
// reading a custom property means a getComputedStyle call per tween, which is a
// layout read in a requestAnimationFrame loop -- the exact thing this feature
// is not allowed to do. motionTokens.test.js checks the two stay in step.
export const COUNT_DURATION_MS = 420;

/**
 * Where a counter sits partway through its tween.
 *
 * Eased rather than linear: a linear counter reads as a progress bar, and this
 * is a value landing, not work completing.
 */
export function tweenValue(from, to, elapsed, duration) {
  if (!Number.isFinite(to)) return Number.isFinite(from) ? from : 0;
  if (!Number.isFinite(from)) return to;
  if (!(duration > 0) || elapsed >= duration) return to;
  if (elapsed <= 0) return from;
  const t = elapsed / duration;
  const eased = 1 - (1 - t) ** 3;
  const value = from + (to - from) * eased;
  // Round toward the destination so the last visible frame before the end is
  // never one short of it.
  return to >= from ? Math.floor(value) : Math.ceil(value);
}

function motionIsReduced() {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.classList.contains("reduce-motion") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * @param {number} target
 * @returns {number} the value to display right now
 */
export function useCountUp(target) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const seeded = useRef(false);

  useEffect(() => {
    // Two cases snap rather than tween, and they are the same case wearing two
    // hats: a counter that has nothing to count up from.
    //
    // The mount run is the obvious one. The second is not: every counts object
    // in this app starts as EMPTY_COUNTS, every key literally zero (see
    // map/useLeafletMap.js), and the control panel mounts before the first poll
    // lands. So the mount run seeds zero and the *first real value* arrives as
    // an ordinary update -- which is how a source going from 0 to 150,000 spends
    // 420ms visibly spinning through six digits and reads as a loading state
    // rather than as an update.
    //
    // Hence: counting up from nothing is a load. The cost is that a layer
    // genuinely going 0 -> 3 snaps too, which is a fair price for never
    // spinning the odometer on page load.
    if (!seeded.current || from.current === 0) {
      seeded.current = true;
      from.current = target;
      setShown(target);
      return undefined;
    }
    // A CSS rule cannot stop a JavaScript tween, so the hook has to opt itself
    // out of reduced motion.
    if (motionIsReduced()) {
      from.current = target;
      setShown(target);
      return undefined;
    }

    const start = performance.now();
    const startedAt = from.current;
    let frame = requestAnimationFrame(function step(now) {
      const value = tweenValue(startedAt, target, now - start, COUNT_DURATION_MS);
      // Written here rather than in the cleanup, which is the subtle part.
      // React keeps the destroy function from the run that created it and does
      // not refresh it on renders where the deps did not change -- and setShown
      // re-renders this component ~25 times without `target` moving. A cleanup
      // that read `shown` would therefore read the value from before the tween
      // started, so a counts update arriving mid-tween would visibly jump the
      // number backwards before rolling up again. Counts change several times
      // inside 420ms during a pan, so that is the common path, not the corner.
      from.current = value;
      setShown(value);
      if (value !== target) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}
