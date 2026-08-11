// Task 29: /api/airfield-activity has existed since before this plan and
// nothing in the frontend has ever called it (backend/sources/
// airfield_activity.py already derives it from this app's own ADS-B history;
// see that module's own docstring for why the military axis is the point of
// the whole aggregate). This is that panel: a sortable table of every field
// the backend's own ranking kept, by 24h movements and by military share,
// each with its own trend and top aircraft types where the backend supplied
// them.
//
// NOTAM (Notice to Air Missions) coverage is deliberately absent from this
// panel and from this map generally: there is no free global NOTAM feed with
// a licence this project can use (ICAO's own aggregation and the commercial
// resellers built on it are both closed). What this panel shows instead is
// recorded traffic -- what actually flew, derived from this map's own ADS-B
// history -- which is a different claim from "what a regulator has closed",
// and is never presented as a substitute for one.
//
// All the sort/share/trend arithmetic lives in airfieldPanelLogic.js, a
// plain-JS sibling module, for the same reason intelPanelLogic.js does: this
// file is JSX, and the project's headless test suite (`node --test`, no
// build step) cannot import it at all -- see frontend/tests/airfieldPanel.test.js.
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { fetchJson } from "../api";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import {
  AIRFIELD_SORT_KEYS, airfieldRows, militaryShare, sortAirfields, trafficTrend,
} from "./airfieldPanelLogic";

const SORT_LABEL = {
  aircraft: "Total movements", military_aircraft: "Military movements",
  militaryShare: "Military share", name: "Name",
};

const TREND_LABEL = { up: "busier in the last 12h", down: "quieter in the last 12h", flat: "steady" };

function AirfieldRow({ entry, airport, onLocate }) {
  const share = militaryShare(entry);
  const trend = trafficTrend(entry.hourly);
  const canLocate = airport && Number.isFinite(airport.lat) && Number.isFinite(airport.lon);

  return (
    <div className="notable-item">
      <div className="notable-item-row">
        {entry.military_field && (
          <span className="notable-chip" style={{ background: "#ff8c3a" }} title="OurAirports lists this as a military airfield">
            MIL
          </span>
        )}
        <span className="notable-line">{entry.name || entry.code}</span>
        {canLocate && (
          <button
            type="button" className="news-locate-btn" title="Show on map"
            aria-label={`Show ${entry.name || entry.code} on map`}
            onClick={() => onLocate(airport.lat, airport.lon)}
          >
            <LocateIcon />
          </button>
        )}
      </div>
      <div className="notable-item-meta">
        {entry.aircraft} movement{entry.aircraft === 1 ? "" : "s"}/24h
        {share != null ? ` · ${Math.round(share * 100)}% military (${entry.military_aircraft})` : ""}
        {trend && trend !== "flat" ? ` · ${TREND_LABEL[trend]}` : ""}
      </div>
      {entry.top_types?.length ? (
        <div className="notable-item-meta">
          Top types: {entry.top_types.map((t) => `${t.type_code} (${t.aircraft})`).join(", ")}
        </div>
      ) : null}
    </div>
  );
}

// The backend recomputes this document every 30 minutes (see
// airfield_activity.REFRESH_INTERVAL) -- polling faster would only re-serve
// the same bytes, the identical reasoning useOsintData.js's own POLL_CONFIG
// comment gives for the map's airfieldActivity row. This panel is not wired
// through that hook (see the module note above): it is a self-contained
// widget a reader opts into, and threading its one document through
// useOsintData's carefully-guarded ref/poller plumbing for a single fetch
// would be a lot of shared-hook surface for one panel's own data.
const REFRESH_INTERVAL_MS = 30 * 60000;

export default function AirfieldActivityPanel({ onLocate, isMobile }) {
  // Starts collapsed -- unlike IntelPanel, this is a niche instrument a
  // reader opts into, not the panel that answers "what should I look at".
  const [collapsed, setCollapsed] = useState(true);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const { panelRef, style, handleProps } = useDraggablePanel("airfieldPanel", {
    onClick: toggleCollapsed,
    enabled: !isMobile,
  });

  const [sortKey, setSortKey] = useState("aircraft");
  const [sortDir, setSortDir] = useState("desc");

  const [activity, setActivity] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJson("/api/airfield-activity")
        .then((data) => {
          if (!cancelled) setActivity(data || {});
        })
        .catch(() => {}); // an empty panel on a failed fetch, not an error banner
    };
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Coordinates for "click to fly", fetched once rather than read off the
  // map's own airports layer: that layer is zoom/viewport-scoped (see
  // map/scene.js's own entry for it), so it cannot be trusted to already hold
  // every field this ranking names -- a reader can open this panel from the
  // world view, long before panning near half of what is listed in it.
  const [airportsByCode, setAirportsByCode] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/airports")
      .then((data) => {
        if (cancelled || !Array.isArray(data)) return;
        const byCode = {};
        for (const a of data) {
          if (a.id) byCode[a.id] = a;
          if (a.icao) byCode[a.icao] = a;
          if (a.iata) byCode[a.iata] = a;
        }
        setAirportsByCode(byCode);
      })
      .catch(() => {}); // "click to fly" degrades to absent, not an error banner
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(
    () => sortAirfields(airfieldRows(activity), sortKey, sortDir),
    [activity, sortKey, sortDir]
  );

  if (!rows.length) return null;

  return (
    <aside id="airfieldPanel" ref={panelRef} className={collapsed ? "collapsed" : ""} style={style}>
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
        <span className="notable-title">AIRFIELDS</span>
        <span className="news-updated">{rows.length} tracked</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && (
        <>
          <div className="intel-controls">
            <label>
              Sort by
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                {AIRFIELD_SORT_KEYS.map((key) => (
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
            24-hour movement counts, derived from this map&rsquo;s own recorded ADS-B traffic -- not NOTAMs
            (no free global feed publishes those under a usable licence). A training field with a handful of
            movements, nearly all military, ranks by <i>share</i> the same way a busy civil hub ranks by volume.
          </p>
          <div className="notable-list">
            {rows.map((entry) => (
              <AirfieldRow key={entry.code} entry={entry} airport={airportsByCode?.[entry.code]} onLocate={onLocate} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
