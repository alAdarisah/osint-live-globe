import { useEffect, useRef, useState } from "react";

import Attribution, { ATTRIBUTION_TEXT } from "../Attribution";
import { setCursorReadoutSink } from "../../map/cursorReadout";
import {
  UNKNOWN,
  CURSOR_EXPLAINER,
  escalationReadout,
  jammingReadout,
  countReadout,
  layerCountReadout,
  latencyReadout,
  sourceReadout,
  formatCursorCoords,
  liveReadout,
} from "./hudLogic";

// How often the strip re-reads the imperative feeds it cannot be handed as
// props (the jamming cells live in the map controller's `raw` table, not in
// React). The same cadence SanctionsBoard already polls mapApi.recordsFor at,
// for the same reason: it is a readout of something changing on a scale of
// minutes, and a re-render per animation frame would buy nothing.
const IMPERATIVE_POLL_MS = 15000;

function Cell({ label, readout, tone, id, children }) {
  return (
    <div className={`hud-cell${readout && !readout.known ? " unknown" : ""}`} id={id} title={readout?.title}>
      <span className="hud-label">{label}</span>
      {children}
      {readout && <span className={`hud-value${tone ? ` ${tone}` : ""}`}>{readout.text}</span>}
    </div>
  );
}

/**
 * The bottom status strip: how bad it is, how fresh it is, how much of it is on
 * screen, and where the pointer is.
 *
 * Every figure here derives from something real and says so when it cannot --
 * see hudLogic.js. The design prototype this was built from hard-codes all of
 * them, which is fine in a mock and would be a lie on a map whose entire claim
 * is that it shows where its numbers came from.
 *
 * The attribution footer folds in as the last content cell rather than keeping
 * its own strip across the bottom of the map. It says who the data belongs to
 * and that this is not authoritative military intelligence -- both of which
 * belong beside the freshness figures, and neither of which should cost a
 * second permanent band of screen.
 */
export default function Hud({
  counts,
  layerVisibility,
  health,
  escalation,
  recordsFor,
  isReplaying,
  replayAt,
}) {
  // Written straight into the DOM, never through state -- see
  // map/cursorReadout.js for why a setState per pointer pixel is the one
  // interaction guaranteed to feel broken on a map this size.
  const coordsRef = useRef(null);
  useEffect(() => {
    setCursorReadoutSink((lat, lon) => {
      if (coordsRef.current) coordsRef.current.textContent = formatCursorCoords(lat, lon);
    });
    return () => setCursorReadoutSink(null);
  }, []);

  // The one feed this strip has to go and fetch rather than being handed.
  const [jammingCells, setJammingCells] = useState([]);
  useEffect(() => {
    if (!recordsFor) return undefined;
    const read = () => setJammingCells(recordsFor("jamming"));
    read();
    const timer = setInterval(read, IMPERATIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [recordsFor]);

  const escalationCell = escalationReadout(escalation);
  const sources = sourceReadout(health);
  const live = liveReadout({ isReplaying, replayAt });

  return (
    <footer id="hud">
      <Cell label="Escalation" readout={escalationCell} tone="danger">
        <span className="esc-bar" aria-hidden="true">
          {escalationCell.needle != null && <i style={{ left: `${escalationCell.needle * 100}%` }} />}
        </span>
      </Cell>

      <Cell label="GPS jam" readout={jammingReadout(jammingCells)} tone="warn" />
      <Cell label="Events" readout={countReadout(counts, "events", "conflict events")} tone="accent" />
      <Cell label="Layers" readout={layerCountReadout(layerVisibility)} />
      <Cell label="Freshness" readout={latencyReadout(health)} />

      <Cell label="Sources" readout={sources}>
        <span className="hud-dots" aria-hidden="true">
          {sources.dots.map((dot) => (
            <i key={dot.name} className={`hud-dot ${dot.state}`} />
          ))}
        </span>
      </Cell>

      {/* Only while it is true. A permanent "LIVE" cell would be a cell a
          reader learns to stop reading, which is exactly the wrong habit for
          the one signal that matters when it changes. */}
      {!live.live && (
        <div className="hud-cell not-live" title={live.title} aria-live="polite">
          <span className="hud-label">Replay</span>
          <span className="hud-value danger">{live.text}</span>
        </div>
      )}

      {/* The title chrome.css has claimed twice, in two comments, that this cell
          carried -- and did not. This is the one cell allowed to ellipsis away,
          and the disclaimer is the last thing in it, so on anything narrower than
          about 1400px the sentence that says this is not authoritative military
          intelligence was the first casualty, with nothing to recover it.
          A tooltip alone would still leave out every touch reader, so the Legend
          repeats the full text as well (see Legend.jsx). */}
      <div className="hud-cell hud-attribution" title={ATTRIBUTION_TEXT}>
        <Attribution />
      </div>

      <div className="hud-cell hud-coords" title={CURSOR_EXPLAINER}>
        <span className="hud-label">Cursor</span>
        <span className="hud-value accent" ref={coordsRef}>{UNKNOWN}</span>
      </div>
    </footer>
  );
}
