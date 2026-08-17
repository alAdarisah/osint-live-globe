// Task 37: GET /api/infra-risk has a document (backend/refine/
// infra_risk.py) and nothing in the frontend called it until this panel --
// the same gap ChokepointPanel.jsx closed for chokepoint traffic (Task 36),
// and this follows its shape closely: a sortable table over a small
// refine-derived document, self-contained (its own fetch/interval) rather
// than threaded through useOsintData's poller table for a single widget's
// own data.
//
// map/eventDetail.js's "Nearby infrastructure" block on the event detail
// card (Task 13) is the other half of the brief: one event's own circle,
// searched client-side against whatever layers are loaded. This panel is
// every event in the map's active window, ranked by which infrastructure
// site has the most of them nearby.
//
// All the sort/row arithmetic lives in infraRiskPanelLogic.js, a plain-JS
// sibling module, for the same reason chokepointPanelLogic.js does: this
// file is JSX, and the project's headless test suite (`node --test`, no
// build step) cannot import it at all -- see
// frontend/tests/infraRiskPanel.test.js.
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { fetchJson } from "../api";
import { fmtNumber } from "../utils/format";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import {
  CATEGORY_LABEL, INFRA_RISK_SORT_KEYS, emptyCategories, hasInfraRiskDocument, infraRiskRows, sortInfraRisk,
} from "./infraRiskPanelLogic";
import { REFINE_PANEL_STATUS, REFINE_PANEL_STATUS_BADGE, REFINE_PANEL_STATUS_TEXT, classifyRefinePanelStatus } from "./refinePanelStatus";

const SORT_LABEL = { event_count: "Events nearby", name: "Name" };

function InfraRiskRow({ site, onLocate }) {
  const canLocate = Number.isFinite(site.lat) && Number.isFinite(site.lon);
  const count = site.event_count;
  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span className="notable-line">{site.name}</span>
        {canLocate && (
          <button
            type="button" className="news-locate-btn" title="Show on map"
            aria-label={`Show ${site.name} on map`}
            onClick={() => onLocate(site.lat, site.lon)}
          >
            <LocateIcon />
          </button>
        )}
      </div>
      <div className="notable-item-meta">
        {CATEGORY_LABEL[site.category] || site.category}
        {" · "}
        {fmtNumber(count)} event{count === 1 ? "" : "s"} inside its uncertainty radius
      </div>
    </div>
  );
}

// backend/refine/infra_risk.py recomputes this document on its own
// INFRA_RISK_INTERVAL cadence (an hour by default) -- polling faster would
// only re-serve the same bytes, the same reasoning ChokepointPanel's own
// REFRESH_INTERVAL_MS comment gives.
const REFRESH_INTERVAL_MS = 20 * 60000;

export default function InfraRiskPanel({ onLocate, isMobile, docked = false }) {
  // Starts collapsed -- a niche instrument a reader opts into, the same
  // footing ChokepointPanel and AirfieldActivityPanel both take.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  // `docked` is the board stack: a card inside a flex column has nowhere to
  // drag to, and a stored position from when it floated would fight the column
  // for where it sits. Everything else about this panel is unchanged.
  const { panelRef, style, handleProps } = useDraggablePanel("infraRiskPanel", {
    onClick: toggleCollapsed,
    enabled: !isMobile && !docked,
  });

  // Who owns a click on the header -- see ChokepointPanel.jsx, which carries the
  // full note. The hook handles it while the panel is draggable and returns an
  // empty handleProps when it is not, so a docked or mobile board needs its own
  // handler or it cannot be opened at all.
  const headerToggle = handleProps.onPointerDown ? undefined : toggleCollapsed;

  const [sortKey, setSortKey] = useState("event_count");
  const [sortDir, setSortDir] = useState("desc");

  const [doc, setDoc] = useState(null);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJson("/api/infra-risk")
        .then((data) => {
          if (cancelled) return;
          setDoc(data || {});
          setHasFetchedOnce(true);
          setFetchFailed(false);
        })
        .catch(() => {
          // Task 37 review (Minor, escalated): a failed fetch used to render
          // identically to "nothing to show yet" -- see
          // refinePanelStatus.js and ChokepointPanel.jsx's identical note.
          // Only flips the flag when no earlier attempt has ever succeeded
          // changes what renders, so a transient hiccup after a working
          // panel does not blank out data the reader already has.
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
    hasFetchedOnce, fetchFailed, hasDocument: hasInfraRiskDocument(doc),
  });

  const rows = useMemo(() => sortInfraRisk(infraRiskRows(doc), sortKey, sortDir), [doc, sortKey, sortDir]);
  const missingCategories = useMemo(() => emptyCategories(doc), [doc]);

  // LOADING: unchanged from before -- nothing renders until the first
  // response (success or failure) lands.
  if (status === REFINE_PANEL_STATUS.LOADING) return null;

  // ERROR and MISSING both mean "there is nothing to rank", for two
  // different reasons a reader must be able to tell apart -- see
  // ChokepointPanel.jsx's identical handling, worded consistently with it
  // on purpose (refinePanelStatus.js is the shared source for both).
  if (status === REFINE_PANEL_STATUS.ERROR || status === REFINE_PANEL_STATUS.MISSING) {
    return (
      <aside id="infraRiskPanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
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
          onClick={headerToggle}
        >
          <span className="notable-pulse" />
          <span className="notable-title">INFRASTRUCTURE AT RISK</span>
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
    <aside id="infraRiskPanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
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
        onClick={headerToggle}
      >
        <span className="notable-pulse" />
        <span className="notable-title">INFRASTRUCTURE AT RISK</span>
        <span className="news-updated">{rows.length} ranked</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && (
        <>
          <p className="meta" style={{ padding: "4px 10px" }}>
            {doc.note}
          </p>
          <p className="meta" style={{ padding: "0 10px 4px" }}>
            Last {doc.window_days ?? 30} days: {fmtNumber(doc.events_searched ?? 0)} event
            {(doc.events_searched ?? 0) === 1 ? "" : "s"} had a stated uncertainty radius and
            were searched; {fmtNumber(doc.events_without_radius ?? 0)} had none and could not be.
            {missingCategories.length > 0 && (
              <>
                {" "}Not indexed yet in this window: {missingCategories.map((c) => CATEGORY_LABEL[c] || c).join(", ")}.
              </>
            )}
          </p>
          {rows.length === 0 ? (
            <p className="meta" style={{ padding: "0 10px 8px" }}>
              No site had a searched event inside its radius in this window.
            </p>
          ) : (
            <>
              <div className="intel-controls">
                <label>
                  Sort by
                  <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                    {INFRA_RISK_SORT_KEYS.map((key) => (
                      <option key={key} value={key}>{SORT_LABEL[key] || key}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Order
                  <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
                    <option value="desc">Highest first</option>
                    <option value="asc">Lowest first</option>
                  </select>
                </label>
              </div>
              <div className="notable-list">
                {rows.map((site) => (
                  <InfraRiskRow key={site.site_id} site={site} onLocate={onLocate} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
