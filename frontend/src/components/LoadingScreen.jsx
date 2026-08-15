import { useEffect, useState } from "react";
import BootGlobe from "./BootGlobe.jsx";
import { formatBootMeta } from "../hooks/bootSourceMeta.js";

// Covers the map from first paint until every source in `sources` has
// reported in once (or a safety timeout elapses, so one slow external API
// can never block the app forever), with a minimum display time so the boot
// sequence is actually visible on a fast connection instead of flashing by.
// See useOsintData.js for how `sources` gets its ok/warn/pending statuses.
const MIN_VISIBLE_MS = 1400;
const MAX_VISIBLE_MS = 9000;

// "deferred" was missing here while useOsintData.js was already producing it
// for a source sitting below its zoom gate -- cities is one, and the map opens
// at zoom 3 -- so that row rendered a blank glyph in a class no rule matched.
// A source correctly not fetched is not a failure and does not get a warning
// mark; it gets a quiet dot and says why on the line beneath.
const STATUS_GLYPH = { pending: "⋯", ok: "✓", warn: "―", timeout: "⚠", deferred: "·" };

export default function LoadingScreen({ sources }) {
  const [mountedAt] = useState(() => Date.now());
  const [forceDone, setForceDone] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setForceDone(true), MAX_VISIBLE_MS);
    return () => clearTimeout(id);
  }, []);

  // The safety timeout exists so one dead upstream API can't hang first
  // paint forever -- but proceeding anyway shouldn't mean *pretending* every
  // source came back. Anything still pending when the timeout fires is
  // relabeled "timed out" (not silently counted as loaded) so the log stays
  // honest about what actually happened; the app still boots either way.
  const displaySources = forceDone
    ? sources.map((s) =>
        s.status === "pending" ? { ...s, status: "timeout", detail: "still waiting" } : s
      )
    : sources;

  const loadedCount = sources.filter((s) => s.status !== "pending").length;
  const allLoaded = loadedCount >= sources.length;

  useEffect(() => {
    if (!allLoaded && !forceDone) return undefined;
    const elapsed = Date.now() - mountedAt;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    const id = setTimeout(() => setHidden(true), wait);
    return () => clearTimeout(id);
  }, [allLoaded, forceDone, mountedAt]);

  useEffect(() => {
    if (!hidden) return undefined;
    const id = setTimeout(() => setRemoved(true), 700); // after the opacity transition finishes
    return () => clearTimeout(id);
  }, [hidden]);

  if (removed) return null;

  const progressPct = Math.round((loadedCount / sources.length) * 100);

  return (
    <div id="loadingScreen" className={hidden ? "hidden" : ""}>
      <div className="loading-inner">
        <BootGlobe hidden={hidden} />
        <div className="loading-title">OSINT LIVE GLOBE</div>
        <div className="loading-subtitle">Establishing live intelligence feeds&hellip;</div>
        <ul className="loading-log">
          {displaySources.map((s) => {
            const meta = formatBootMeta(s);
            return (
              // title carries the full upstream attribution -- the short name is
              // what fits the column, but which feed a layer came from is the
              // part a reader actually needs, so it stays one hover away rather
              // than being dropped.
              <li key={s.key} className={`loading-log-line ${s.status}`} title={s.label}>
                <span className="loading-log-status">{STATUS_GLYPH[s.status]}</span>
                <span className="loading-log-text">
                  <span className="loading-log-label">{s.short || s.label}</span>
                  {meta ? <span className="loading-log-meta">{meta}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="loading-bar">
          <div className="loading-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
