// Task 38: GET /api/cable-outage-risk has a document (backend/refine/
// cable_outage.py) and nothing in the frontend called it until this panel --
// the same gap InfraRiskPanel.jsx closed for Task 37, and this follows its
// shape closely: self-contained (its own fetch/interval) rather than
// threaded through useOsintData's poller table for a single widget's own
// data, which also keeps this feature off scene.js's REFERENCE_ONLY_FEEDS/
// UNGATED_FEEDS pairing entirely -- it never goes through createMapController
// at all, the same reason InfraRiskPanel and ChokepointPanel don't either.
//
// **This is a coincidence, not a cause.** The document's own `note` field is
// rendered verbatim, exactly once, so the one sentence this whole feature
// exists to attach to every entry can never drift between the panel and the
// raw JSON -- see backend/refine/cable_outage.py's own module docstring and
// backend/tests/test_cable_outage.py's banned-language assertion for why
// that sentence is worded the way it is.
//
// All the row/status arithmetic *and every string this panel composes* live
// in cableOutagePanelLogic.js, a plain-JS sibling module -- this file is
// JSX, and the project's headless test suite (`node --test`, no build step)
// cannot import it, or assert on strings buried in its markup, at all. See
// frontend/tests/cableOutagePanel.test.js, and cableOutagePanelLogic.js's
// own module note on why every composed sentence was pulled out here after
// Task 38 review (Important 1).
import { useCallback, useEffect, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { fetchJson } from "../api";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import {
  coincidenceRows, emptyStateText, eventLine, eventSearchLine, eventsHeaderLine,
  hasCableOutageDocument, landingAttributionNote, landingCoverageLine, landingsHeaderLine, scoreLine,
  statusSummaryLine,
} from "./cableOutagePanelLogic";
import { REFINE_PANEL_STATUS, REFINE_PANEL_STATUS_BADGE, REFINE_PANEL_STATUS_TEXT, classifyRefinePanelStatus } from "./refinePanelStatus";

function fmtTime(ts) {
  return Number.isFinite(ts) ? new Date(ts * 1000).toLocaleString() : "unknown time";
}

function CoincidenceCard({ entry, onLocate }) {
  const landings = Array.isArray(entry.landings) ? entry.landings : [];
  const events = Array.isArray(entry.events) ? entry.events : [];
  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span className="notable-line">{entry.country || entry.country_code}</span>
      </div>
      <div className="notable-item-meta">{scoreLine(entry)}</div>
      <div className="notable-item-meta">
        {landingsHeaderLine(landings.length)}{" "}
        {landings.map((l, i) => (
          <span key={l.id}>
            {i > 0 && ", "}
            {l.name}
            {landingAttributionNote(l) && (
              <em className="meta" style={{ fontStyle: "italic" }}>{landingAttributionNote(l)}</em>
            )}
            {Number.isFinite(l.lat) && Number.isFinite(l.lon) && (
              <button
                type="button" className="news-locate-btn" title="Show on map"
                aria-label={`Show ${l.name} on map`}
                onClick={() => onLocate(l.lat, l.lon)}
              >
                <LocateIcon />
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="notable-item-meta">{eventsHeaderLine(events.length)}</div>
      {events.map((e) => (
        <div className="notable-item-meta" key={e.id} style={{ paddingLeft: "8px" }}>
          {eventLine(e)} at {fmtTime(e.first_seen)}
          {Number.isFinite(e.lat) && Number.isFinite(e.lon) && (
            <button
              type="button" className="news-locate-btn" title="Show on map"
              aria-label="Show event on map"
              onClick={() => onLocate(e.lat, e.lon)}
            >
              <LocateIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// backend/refine/cable_outage.py recomputes this document on its own
// CABLE_OUTAGE_INTERVAL cadence (15 minutes by default, matched to
// outages.py's own poll) -- polling faster would only re-serve the same
// bytes, the same reasoning InfraRiskPanel's own REFRESH_INTERVAL_MS gives.
const REFRESH_INTERVAL_MS = 15 * 60000;

export default function CableOutagePanel({ onLocate, isMobile, docked = false }) {
  // Starts collapsed -- a niche instrument a reader opts into, the same
  // footing InfraRiskPanel and ChokepointPanel both take.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  // `docked` is the board stack: a card inside a flex column has nowhere to
  // drag to, and a stored position from when it floated would fight the column
  // for where it sits. Everything else about this panel is unchanged.
  const { panelRef, style, handleProps } = useDraggablePanel("cableOutagePanel", {
    onClick: toggleCollapsed,
    enabled: !isMobile && !docked,
  });

  const [doc, setDoc] = useState(null);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJson("/api/cable-outage-risk")
        .then((data) => {
          if (cancelled) return;
          setDoc(data || {});
          setHasFetchedOnce(true);
          setFetchFailed(false);
        })
        .catch(() => {
          // Same "a failed fetch must not render like nothing to show yet"
          // fix Task 37's review made for InfraRiskPanel/ChokepointPanel --
          // only flips the flag when no earlier attempt has ever succeeded,
          // so a transient hiccup after a working panel does not blank out
          // data the reader already has.
          if (!cancelled) setFetchFailed(true);
        });
    };
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const status = classifyRefinePanelStatus({
    hasFetchedOnce, fetchFailed, hasDocument: hasCableOutageDocument(doc),
  });

  const rows = coincidenceRows(doc);

  if (status === REFINE_PANEL_STATUS.LOADING) return null;

  if (status === REFINE_PANEL_STATUS.ERROR || status === REFINE_PANEL_STATUS.MISSING) {
    return (
      <aside id="cableOutagePanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
        <div
          {...handleProps}
          className={`notable-header ${handleProps.className || ""}`}
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleCollapsed();
            }
          }}
          onClick={isMobile ? toggleCollapsed : undefined}
        >
          <span className="notable-pulse" />
          <span className="notable-title">CABLE / OUTAGE COINCIDENCE</span>
          <span className={`news-updated panel-status-${status}`}>{REFINE_PANEL_STATUS_BADGE[status]}</span>
          <span className="notable-caret" aria-hidden="true">&#9662;</span>
        </div>
        {!collapsed && (
          <p className="meta" style={{ padding: "4px 10px" }}>{REFINE_PANEL_STATUS_TEXT[status]}</p>
        )}
      </aside>
    );
  }

  return (
    <aside id="cableOutagePanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
      <div
        {...handleProps}
        className={`notable-header ${handleProps.className || ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleCollapsed();
          }
        }}
        onClick={isMobile ? toggleCollapsed : undefined}
      >
        <span className="notable-pulse" />
        <span className="notable-title">CABLE / OUTAGE COINCIDENCE</span>
        <span className="news-updated">{rows.length} found</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && (
        <>
          <p className="meta" style={{ padding: "4px 10px" }}>{doc.note}</p>
          <p className="meta" style={{ padding: "0 10px 4px" }}>{statusSummaryLine(doc)}</p>
          <p className="meta" style={{ padding: "0 10px 8px" }}>{eventSearchLine(doc)}</p>
          {doc.landing_stats && (
            <p className="meta" style={{ padding: "0 10px 8px" }}>{landingCoverageLine(doc)}</p>
          )}
          {rows.length === 0 ? (
            <p className="meta" style={{ padding: "0 10px 8px" }}>{emptyStateText(doc)}</p>
          ) : (
            <div className="notable-list">
              {rows.map((entry) => (
                <CoincidenceCard key={entry.country_code} entry={entry} onLocate={onLocate} />
              ))}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
