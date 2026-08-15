import { useEffect, useState } from "react";

import { GLOBE_SIZE, graticulePaths } from "./bootGlobeGeometry.js";

// Radians per second. Slow enough to read as a globe turning rather than a
// spinner: a full rotation takes about eighteen seconds, which is longer than
// the boot screen's own nine-second ceiling, so the reader never sees it loop.
const SPIN_RATE = 0.35;

// The same pair useCountUp.js checks -- the in-app setting (useAppSettings.js
// puts the class on the root element) or the OS-level preference. Read at
// effect time rather than through a subscription: this component lives for a
// few seconds at boot, and a reader toggling the setting mid-splash is not a
// case worth wiring for.
function motionOff() {
  return (
    document.documentElement.classList.contains("reduce-motion") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// The wire globe behind the boot log. Unlike the radar sweep it replaces, the
// motion here is JavaScript rather than a CSS animation, so reduced motion has
// to be honoured in the component -- a stylesheet cannot switch off a rAF loop.
// (The sweep was never exempted in either reduced-motion block, so it spun
// regardless of the setting. This does not.)
export default function BootGlobe({ hidden }) {
  const [spin, setSpin] = useState(0);

  useEffect(() => {
    // Nothing to animate behind a screen that is already fading out, and
    // nothing to animate for a reader who asked for stillness.
    if (hidden || motionOff()) return undefined;

    let raf = 0;
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setSpin((s) => (s + SPIN_RATE * dt) % (Math.PI * 2));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  const { meridians, parallels } = graticulePaths(spin, GLOBE_SIZE);
  const centre = GLOBE_SIZE / 2;
  const radius = GLOBE_SIZE / 2 - 1;

  return (
    <svg
      className="boot-globe"
      width={GLOBE_SIZE}
      height={GLOBE_SIZE}
      viewBox={`0 0 ${GLOBE_SIZE} ${GLOBE_SIZE}`}
      // Decorative: the log underneath is what actually reports boot progress,
      // and a screen reader announcing a rotating grid would add nothing.
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="bootGlobeFill" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="rgba(111, 227, 255, 0.16)" />
          <stop offset="100%" stopColor="rgba(111, 227, 255, 0.02)" />
        </radialGradient>
      </defs>
      <circle cx={centre} cy={centre} r={radius} fill="url(#bootGlobeFill)" />
      {parallels.map((d, i) => (
        <path key={`p${i}`} className="boot-globe-line" d={d} />
      ))}
      {meridians.map((d, i) => (
        <path key={`m${i}`} className="boot-globe-line" d={d} />
      ))}
      <circle className="boot-globe-rim" cx={centre} cy={centre} r={radius} />
    </svg>
  );
}
