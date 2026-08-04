import { useEffect, useState } from "react";

// Covers the map from first paint until every source in `sources` has
// reported in once (or a safety timeout elapses, so one slow external API
// can never block the app forever), with a minimum display time so the boot
// sequence is actually visible on a fast connection instead of flashing by.
// See useOsintData.js for how `sources` gets its ok/warn/pending statuses.
const MIN_VISIBLE_MS = 1400;
const MAX_VISIBLE_MS = 9000;

const STATUS_GLYPH = { pending: "⋯", ok: "✓", warn: "―", timeout: "⚠" };

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
    ? sources.map((s) => (s.status === "pending" ? { ...s, status: "timeout" } : s))
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
        <div className="loading-radar">
          <div className="loading-radar-ring" />
          <div className="loading-radar-ring loading-radar-ring-2" />
          <div className="loading-radar-sweep" />
        </div>
        <div className="loading-title">OSINT LIVE GLOBE</div>
        <div className="loading-subtitle">Establishing live intelligence feeds&hellip;</div>
        <ul className="loading-log">
          {displaySources.map((s) => (
            <li key={s.key} className={`loading-log-line ${s.status}`}>
              <span className="loading-log-status">{STATUS_GLYPH[s.status]}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
        <div className="loading-bar">
          <div className="loading-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>
    </div>
  );
}
