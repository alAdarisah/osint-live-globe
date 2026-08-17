// Task 41: every OFAC- and OpenSanctions-matched vessel and aircraft this
// map's own live feed currently carries, aggregated into one panel a reader
// can scan instead of having to click every hull and airframe to find the
// listed ones. The matching itself is already done per entity -- see
// backend/sources/sanctions.py and backend/sources/maritime_watchlists.py --
// this only reads item.sanctions/item.watchlist off records already in hand.
//
// All the row-building, sort, and status/coverage wording lives in
// sanctionsBoardLogic.js, a plain-JS sibling module, for the same reason
// every other panel in this plan does: this file is JSX, and the project's
// headless test suite (`node --test`, no build step) cannot import it at all
// -- see frontend/tests/sanctionsBoard.test.js.
//
// **Data source, and why it is not another useOsintData poller row.** Ships
// and aircraft are drawn through the WebGL entity layer, not React state --
// createMapController.js holds the live raw.ais/raw.adsb arrays itself and
// hands them out, by reference, through mapApi.recordsFor(key) (the same
// method AdminPanel's DataEditor already uses to browse a feed). This panel
// polls that on its own short timer rather than threading a new push
// callback through useLeafletMap.js the way SquawkAlertStrip's emergency
// subset does: recordsFor is already wired end to end for exactly this
// "give me the current snapshot of one feed" need, and a second plumbing
// path to the same data would be duplication for no gain.
//
// **Scope.** Neither /api/ships nor /api/aircraft is bbox-scoped (see
// sanctionsBoardLogic.js's own header note), so this board covers this map's
// entire live feed -- every matched hull and airframe currently held,
// regardless of camera position or which layers are switched on. Said once,
// plainly, in the panel's own caption below, rather than left for a reader
// to assume from the word "visible."
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import {
  BOARD_STATUS, CLAIM_CLASS_COLOR, MATCHED_ON_NOTE, SANCTIONS_BOARD_SORT_KEYS,
  buildSanctionsBoardRows, canLocate, claimSummaryLine, classifyBoardStatus, coverageLine, emptyStateText,
  lastSeenLine, listedAsLine, matchedOnLine, positionLine, provenanceLine, secondaryIdLine, sortSanctionsBoard,
  undatedNote,
} from "./sanctionsBoardLogic";

const SORT_LABEL = { updated: "Last seen", name: "Name" };

// Cheap to recompute (a filter/flatMap over feeds already in memory, not a
// fetch) -- picked between AIS's own 10s poll and ADS-B's 20-60s one
// (useOsintData.js's POLL_CONFIG) so a fresh listing shows up within one
// reasonable beat of either feed updating, without re-deriving the whole
// board on every animation frame.
const REFRESH_INTERVAL_MS = 15000;

function SanctionsRow({ row, onLocate }) {
  const locatable = canLocate(row);
  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span
          className="notable-chip"
          style={{ background: row.source === "ofac" ? "#ff3b30" : CLAIM_CLASS_COLOR[row.claimClass] }}
          title={row.sourceFullLabel}
        >
          {row.sourceLabel}
        </span>
        <span className="notable-line">{row.name}</span>
        {locatable && (
          <button
            type="button" className="news-locate-btn" title="Show on map"
            aria-label={`Show ${row.name} on map`}
            onClick={() => onLocate(row.lat, row.lon)}
          >
            <LocateIcon />
          </button>
        )}
      </div>
      <div className="notable-item-meta">{claimSummaryLine(row)}</div>
      <div className="notable-item-meta">{listedAsLine(row)}</div>
      <div className="notable-item-meta">{matchedOnLine(row)}</div>
      <p className="meta">{MATCHED_ON_NOTE[row.matchedOn] || ""}</p>
      {row.claimNote && <p className="meta">{row.claimNote}</p>}
      {undatedNote(row) && <p className="meta"><b>Undated list:</b> {undatedNote(row)}</p>}
      {secondaryIdLine(row) && <div className="notable-item-meta">{secondaryIdLine(row)}</div>}
      <div className="notable-item-meta">{lastSeenLine(row)} · {positionLine(row)}</div>
      <p className="meta">{provenanceLine(row)}</p>
    </div>
  );
}

/**
 * @param {boolean} [asTab]  render only the body, for the intel feed's own
 *   Sanctions tab. Everything above the body -- the floating card, its header,
 *   its collapse -- belongs to the panel this used to be; the tab supplies its
 *   own. The body, the caption, the status handling and every caveat string are
 *   the same in both.
 */
export default function SanctionsBoard({ recordsFor, health, onLocate, isMobile, asTab = false }) {
  // Starts collapsed -- a niche instrument a reader opts into, the same
  // footing every other self-contained panel in this corner takes
  // (AirfieldActivityPanel, ChokepointPanel, InfraRiskPanel, CableOutagePanel).
  // Irrelevant as a tab, where the tab bar is the collapse.
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const { panelRef, style, handleProps } = useDraggablePanel("sanctionsBoard", {
    onClick: toggleCollapsed,
    enabled: !isMobile && !asTab,
  });

  // See ChokepointPanel.jsx for the full note. Only reachable on the floating
  // path below (App renders this as a tab, which returns before it), but kept in
  // step with its four siblings so the floating path is not the one that is
  // silently broken if it is ever used again.
  const headerToggle = handleProps.onPointerDown ? undefined : toggleCollapsed;

  const [sortKey, setSortKey] = useState("updated");
  const [sortDir, setSortDir] = useState("desc");

  const [vessels, setVessels] = useState([]);
  const [aircraft, setAircraft] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setVessels(recordsFor("ais"));
      setAircraft(recordsFor("adsb"));
    };
    tick();
    const id = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [recordsFor]);

  const rows = useMemo(
    () => sortSanctionsBoard(buildSanctionsBoardRows(vessels, aircraft), sortKey, sortDir),
    [vessels, aircraft, sortKey, sortDir]
  );

  const status = classifyBoardStatus(health);
  // Before /api/health has answered even once, there is nothing honest to
  // say yet about *why* the board might be empty -- same footing
  // InfraRiskPanel's own LOADING state takes (render nothing rather than a
  // panel that might be about to contradict itself a moment later).
  if (status === BOARD_STATUS.LOADING) return null;

  const empty = emptyStateText(health, rows.length);

  // The body, shared by the floating panel and the feed's Sanctions tab. Pulled
  // out rather than duplicated: the caption below carries this board's whole
  // provenance argument -- matched by identifier and never by name, the whole
  // live feed rather than what is on screen, one row per source rather than one
  // merged row -- and two copies of that is two places for it to drift.
  const body = (
    <>
      <p className="meta" style={{ padding: "4px 10px" }}>
        Every vessel and aircraft in this map&rsquo;s current AIS/ADS-B feed that OFAC&rsquo;s Specially
        Designated Nationals list or the OpenSanctions maritime collection matches by identifier &mdash;
        never by name, since a name is the easiest field in either feed to change. Covers the whole live
        feed, not only what is drawn on screen: the camera position and layer toggles do not change what
        is checked here. A vessel can carry a hit from both sources at once; each is its own row below,
        never combined into one.
      </p>
      {empty ? (
        <p className="meta" style={{ padding: "0 10px 8px" }}>{empty}</p>
      ) : (
        <>
          <p className="meta" style={{ padding: "0 10px 4px" }}>{coverageLine(health)}</p>
          <div className="intel-controls">
            <label>
              Sort by
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                {SANCTIONS_BOARD_SORT_KEYS.map((key) => (
                  <option key={key} value={key}>{SORT_LABEL[key] || key}</option>
                ))}
              </select>
            </label>
            <label>
              Order
              <select value={sortDir} onChange={(e) => setSortDir(e.target.value)}>
                <option value="desc">{sortKey === "name" ? "Z to A" : "Most recent first"}</option>
                <option value="asc">{sortKey === "name" ? "A to Z" : "Oldest first"}</option>
              </select>
            </label>
          </div>
          <div className="notable-list">
            {rows.map((row) => (
              <SanctionsRow key={row.id} row={row} onLocate={onLocate} />
            ))}
          </div>
        </>
      )}
    </>
  );

  if (asTab) return body;

  return (
    <aside id="sanctionsBoard" ref={panelRef} className={collapsed ? "collapsed" : ""} style={style}>
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
        <span className="notable-title">SANCTIONS WATCHBOARD</span>
        <span className="news-updated">{rows.length} matched</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && body}
    </aside>
  );
}
