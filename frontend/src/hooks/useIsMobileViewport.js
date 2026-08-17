import { useEffect, useState } from "react";

import { MOBILE_MAX_WIDTH } from "./chromeLayout";

// Built from the one exported constant rather than restating the number.
//
// chromeLayout.js exports MOBILE_MAX_WIDTH and says it is "exported so the three
// cannot drift about what a phone means" -- but this file, one of the three, had
// the 700 hard-coded and imported nothing. So the guard was a comment, not a
// mechanism: changing the breakpoint in one place would have left the JS and the
// CSS disagreeing, which is the exact state chromeLayout.js's own note calls a
// layout nobody can reason about. The stylesheets are the third reader and still
// carry their own literal, because a media query cannot read a JS constant -- that
// one is held by tests/chromeLayout.test.js instead.
const QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

export function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);

    // Re-read on attach, not only on change.
    //
    // There is a gap between the initializer above (first render) and this
    // effect (after paint), and a viewport that moves across the breakpoint
    // inside it fires its `change` before anything is listening -- so the value
    // stays wrong for the whole session, because nothing else ever recomputes
    // it. A window opened narrow and immediately sized up is the ordinary way
    // to hit that, and it used to cost little: this hook only disabled dragging
    // and pre-collapsed a few panels. It now decides whether the feed rail
    // exists and whether the map is inset for it, and a stale `true` puts the
    // JS and the CSS into exactly the disagreement chromeLayout.js's own note
    // says nobody can reason about -- a 332px rail drawn over a map that was
    // never moved out from under it.
    const sync = () => setIsMobile(mql.matches);
    sync();

    // Both events, and this is not belt-and-braces for its own sake: reading the
    // media query on attach is still a single reading, and a `change` that does
    // not arrive leaves it as the only one this hook will ever take. That was
    // observed -- a 1280px window, `matchMedia` reporting false, and this hook
    // still holding true from a narrower first paint, which drew the rail at
    // 332px over a map that had not been inset for it. `resize` is the coarser
    // signal but it is the one that actually fires whenever the box changes, so
    // it is what closes the hole; `change` stays because it also covers the
    // cases resize does not, such as a zoom or a device rotation that alters the
    // match without altering the window's own dimensions.
    mql.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      mql.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return isMobile;
}
