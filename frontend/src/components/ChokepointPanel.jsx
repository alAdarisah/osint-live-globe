// Task 36: GET /api/chokepoints has a document (backend/refine/
// lane_density.py's chokepoint accounting) and nothing in the frontend
// called it until this panel -- the same gap AirfieldActivityPanel.jsx
// closed for airfield traffic, and this follows its shape closely: a
// sortable table over a small refine-derived document, self-contained
// (its own fetch/interval) rather than threaded through useOsintData's
// poller table for a single widget's own data.
//
// The water card's "Chokepoint traffic" fold (map/popups.js,
// buildWaterChokepointTraffic) covers one box at a time, in context, when a
// reader opens that water body. This panel is the other half: all eight
// watched boxes at once, ranked, for a reader who wants to scan the whole
// picture rather than click into one sea at a time.
//
// All the sort/bar arithmetic lives in chokepointPanelLogic.js, a plain-JS
// sibling module, for the same reason airfieldPanelLogic.js does: this file
// is JSX, and the project's headless test suite (`node --test`, no build
// step) cannot import it at all -- see frontend/tests/chokepointPanel.test.js.
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { fetchJson } from "../api";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import {
  CHOKEPOINT_SORT_KEYS, boxCenter, chokepointRows, hasChokepointDocument, hullCountLine, sortChokepoints, todayEntry, trendBars,
} from "./chokepointPanelLogic";
import { REFINE_PANEL_STATUS, REFINE_PANEL_STATUS_BADGE, REFINE_PANEL_STATUS_TEXT, classifyRefinePanelStatus } from "./refinePanelStatus";

const SORT_LABEL = { total: "Today's hulls", label: "Name" };

// The seven cargo-class buckets backend/refine/vessel_profile.py's
// cargo_class() returns. A hull whose ship type was never decoded has no key
// in `by_class` at all (see lane_density.compute_chokepoints), so this table
// is never consulted for that case -- nothing here needs an "unknown" entry.
const CLASS_LABEL = {
  tanker: "Tanker", cargo: "Cargo", fishing: "Fishing", passenger: "Passenger",
  tug: "Tug", naval: "Naval", other: "Other",
};

// Bar colours by day status -- deliberately three different treatments, not
// three shades of the same one, so "still counting" and "no data" cannot be
// mistaken for a fainter version of a real, finished count at a glance.
const BAR_FILL = { counted: "rgba(255,140,58,0.75)", partial: "rgba(255,92,42,0.9)" };
const TODAY_FILL = "#ff5c2a";

function TrendStrip({ trend, height = 24 }) {
  const bars = useMemo(() => trendBars(trend, height), [trend, height]);
  if (!bars.length) return null;
  const w = 4;
  const gap = 1;
  const lastIdx = bars.length - 1;
  return (
    <svg
      className="cspark" viewBox={`0 0 ${bars.length * (w + gap)} ${height}`}
      preserveAspectRatio="none" role="img"
      aria-label={`${bars.length}-day trend, oldest to newest`}
    >
      {bars.map((b, i) => {
        const x = i * (w + gap);
        if (b.height == null) {
          // Missing: a short, low-opacity tick at the baseline -- present
          // (so the day still occupies its slot in the strip) but visually
          // nothing like a counted bar of any height, including zero.
          return <rect key={b.date || i} x={x} y={height - 2} width={w} height={2} fill="rgba(255,255,255,0.15)" rx="1" />;
        }
        const fill = i === lastIdx ? TODAY_FILL : BAR_FILL[b.status] || BAR_FILL.counted;
        return <rect key={b.date || i} x={x} y={height - b.height} width={w} height={b.height} fill={fill} rx="1" />;
      })}
    </svg>
  );
}

function ChokepointRow({ box, onLocate }) {
  const today = todayEntry(box);
  const center = boxCenter(box.bounds);
  const canLocate = !!center;
  const classEntries = today.by_class ? Object.entries(today.by_class).filter(([, n]) => n > 0) : [];

  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span className="notable-line">{box.label}</span>
        {canLocate && (
          <button
            type="button" className="news-locate-btn" title="Show on map"
            aria-label={`Show ${box.label} on map`}
            onClick={() => onLocate(center.lat, center.lon)}
          >
            <LocateIcon />
          </button>
        )}
      </div>
      <div className="notable-item-meta">
        {hullCountLine(today)}
        {classEntries.length
          ? ` · ${classEntries
              .sort((a, b) => b[1] - a[1])
              .map(([cls, n]) => `${CLASS_LABEL[cls] || cls} ${n}`)
              .join(", ")}`
          : ""}
      </div>
      <TrendStrip trend={box.trend} />
    </div>
  );
}

// backend/refine/lane_density.py's chokepoint accounting recomputes this
// document on lane_density's own LANE_DENSITY_INTERVAL cadence (an hour by
// default) -- polling faster would only re-serve the same bytes, the same
// reasoning AirfieldActivityPanel's own REFRESH_INTERVAL_MS comment gives.
const REFRESH_INTERVAL_MS = 20 * 60000;

export default function ChokepointPanel({ onLocate, isMobile, docked = false }) {
  // Starts collapsed -- a niche instrument a reader opts into, the same
  // footing AirfieldActivityPanel takes rather than IntelPanel's.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  // `docked` is the board stack: a card inside a flex column has nowhere to
  // drag to, and a stored position from when it floated would fight the column
  // for where it sits. Everything else about this panel is unchanged.
  const { panelRef, style, handleProps } = useDraggablePanel("chokepointPanel", {
    onClick: toggleCollapsed,
    enabled: !isMobile && !docked,
  });

  // Who owns a click on the header. While the panel is draggable the hook does:
  // it distinguishes a drag from a tap and calls the onClick above on pointerup.
  // While it is not -- on a phone, or docked in the board stack -- the hook
  // returns an empty handleProps and the header needs its own handler, or the
  // board cannot be opened at all. Derived from handleProps rather than
  // re-deriving `!isMobile && !docked`, so this cannot disagree with `enabled`
  // above: it did, and a docked board on a desktop got no click handler from
  // either side while still rendering a caret and `cursor: pointer`.
  const headerToggle = handleProps.onPointerDown ? undefined : toggleCollapsed;

  const [sortKey, setSortKey] = useState("total");
  const [sortDir, setSortDir] = useState("desc");

  const [doc, setDoc] = useState(null);
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJson("/api/chokepoints")
        .then((data) => {
          if (cancelled) return;
          setDoc(data || {});
          setHasFetchedOnce(true);
          setFetchFailed(false);
        })
        .catch(() => {
          // Task 37 review (Minor, escalated): a failed fetch used to render
          // identically to "nothing to show yet" -- no panel at all, no
          // distinction from the refine job simply not having run. See
          // refinePanelStatus.js: this only flips `fetchFailed`, and only
          // when no earlier attempt has ever succeeded does that change what
          // renders (a transient hiccup after a working panel must not blank
          // out data the reader already has).
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
    hasFetchedOnce, fetchFailed, hasDocument: hasChokepointDocument(doc),
  });

  const rows = useMemo(
    () => sortChokepoints(chokepointRows(doc), sortKey, sortDir),
    [doc, sortKey, sortDir]
  );

  // LOADING: the ordinary first instant after mount, before any response has
  // landed -- unchanged from before, nothing renders yet, no flash of an
  // error state that turns out not to be one.
  if (status === REFINE_PANEL_STATUS.LOADING) return null;

  // ERROR and MISSING both mean "there is nothing to list", for two
  // different reasons a reader must be able to tell apart -- so both mount
  // a real, visible header (not silence) with their own badge word and, once
  // expanded, their own sentence from refinePanelStatus.js, and neither
  // shows the sort controls or a list, since there is nothing computed to
  // sort. See ChokepointPanel's own review note and InfraRiskPanel.jsx's
  // identical handling -- worded consistently between the two on purpose.
  if (status === REFINE_PANEL_STATUS.ERROR || status === REFINE_PANEL_STATUS.MISSING) {
    return (
      <aside id="chokepointPanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
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
          <span className="notable-title">CHOKEPOINTS</span>
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
    <aside id="chokepointPanel" ref={panelRef} className={`${collapsed ? "collapsed" : ""}${docked ? " docked" : ""}`} style={style}>
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
        <span className="notable-title">CHOKEPOINTS</span>
        <span className="news-updated">{rows.length} watched</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && (
        <>
          <div className="intel-controls">
            <label>
              Sort by
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                {CHOKEPOINT_SORT_KEYS.map((key) => (
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
          <p className="meta" style={{ padding: "4px 10px" }}>
            Distinct hulls this map's own AIS coverage has recorded crossing each watched chokepoint box, per
            day, <i>derived</i> by counting distinct MMSIs -- never a traffic census. AIS reception is not
            uniform, so a quiet day can mean genuinely little traffic or it can mean this map's own receivers
            simply heard less that day. In each strip, the newest bar (today) is bright orange; a low pale
            tick at the baseline is a day this job never observed, not a day with no traffic --
            see the {doc?.window_days || 30}-day window below each row.
          </p>
          <div className="notable-list">
            {rows.map((box) => (
              <ChokepointRow key={box.label} box={box} onLocate={onLocate} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
