// A number that changes is worth noticing. A number that changes by rolling to
// its new value is worth noticing without anyone having been watching it.
//
// Deliberately not applied to anything that counts people -- see CountUp.jsx.

import { useEffect, useRef, useState } from "react";

// Matches --t-settle. Stated here rather than read from the stylesheet because
// reading a custom property means a getComputedStyle call per tween, which is a
// layout read in a requestAnimationFrame loop -- the exact thing this feature
// is not allowed to do. The token test does not cover this; the comment is the
// only thing keeping the two in step, so change both or neither.
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
  // First load hands these counters their first real value at once -- a source
  // going from 0 to 150,000 must not spend 420ms visibly spinning through six
  // digits, which reads as a loading state rather than as an update.
  const seeded = useRef(false);

  useEffect(() => {
    if (!seeded.current) {
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
      setShown(value);
      if (value !== target) frame = requestAnimationFrame(step);
      else from.current = target;
    });
    return () => {
      cancelAnimationFrame(frame);
      // Whatever was on screen is where the next tween starts, so a target that
      // changes mid-tween continues from here instead of snapping back.
      from.current = shown;
    };
    // `shown` is deliberately not a dependency: it changes every frame, and
    // depending on it would restart the tween on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return shown;
}
