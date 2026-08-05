// Reuses the GDELT data already fetched for the map markers (see
// useOsintData.js) -- no separate polling loop. Filtered to the current
// viewport (same pattern the map controller's renderers use) so it always
// reflects whatever region is currently in view/selected, not just the
// initial selection.
import { useCallback, useEffect, useMemo, useState } from "react";
import { timeAgoFromDateAdded } from "../utils/format";
import { padBounds, boundsContainsPoint } from "../utils/geo";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import LocateIcon from "./icons/LocateIcon";

const NEWS_MAX_ITEMS = 8;

export default function NewsBroadcastPanel({ gdeltRaw, mapBounds, regionLabel, onLocate }) {
  // Starts collapsed on every viewport -- the news ticker is opt-in, same
  // "quiet by default" treatment as the layer checkboxes in App.jsx's
  // DEFAULT_LAYER_VISIBILITY.
  const [collapsed, setCollapsed] = useState(true);

  // Header doubles as drag handle and collapse toggle: a press that moves is a
  // drag, one that doesn't is a click. See useDraggablePanel, which is also
  // what remembers where this was dropped.
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const { panelRef, style, handleProps } = useDraggablePanel("newsBroadcast", { onClick: toggleCollapsed });

  const items = useMemo(() => {
    if (!mapBounds) return [];
    const bounds = padBounds(mapBounds, 0.25);
    const seen = new Set();
    const filtered = [];
    for (const d of gdeltRaw) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") continue;
      if (!boundsContainsPoint(bounds, d.lat, d.lon)) continue;
      // /api/news only ever serves items with a real scraped title (see
      // backend/app.py's _gdelt_filter) -- this re-check is a defensive
      // backstop, not an expected path.
      if (!(d.real_title && d.real_title.trim())) continue;
      const key = d.source_url || d.event_id;
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      filtered.push(d);
    }
    filtered.sort((a, b) => (b.date_added || "").localeCompare(a.date_added || ""));
    return filtered.slice(0, NEWS_MAX_ITEMS);
  }, [gdeltRaw, mapBounds]);

  const [lastUpdateTs, setLastUpdateTs] = useState(() => Date.now());
  useEffect(() => {
    setLastUpdateTs(Date.now());
  }, [items]);

  // Ticks the "updated Xs ago" label independently of data actually
  // changing, so the panel visibly feels alive even between polls.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const updatedSec = Math.max(0, Math.floor((Date.now() - lastUpdateTs) / 1000));
  const updatedText = updatedSec < 5 ? "updated just now" : `updated ${updatedSec}s ago`;

  return (
    <aside id="newsBroadcast" ref={panelRef} className={collapsed ? "collapsed" : ""} style={style}>
      <div {...handleProps} className={`news-header ${handleProps.className || ""}`}>
        <span className="live-dot" />
        <span className="news-title">
          LIVE &mdash; <span>{regionLabel}</span>
        </span>
        <span className="news-updated">{updatedText}</span>
        <button
          type="button"
          className="news-caret-btn"
          aria-label={collapsed ? "Expand news feed" : "Collapse news feed"}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={toggleCollapsed}
        >
          <span className="news-caret" aria-hidden="true">&#9662;</span>
        </button>
      </div>
      <div className="news-list">
        {items.length === 0 ? (
          <div className="news-empty">No recent headlines for this area.</div>
        ) : (
          items.map((item) => <NewsItem key={item.source_url || item.event_id} item={item} onLocate={onLocate} />)
        )}
      </div>
    </aside>
  );
}

function NewsItem({ item, onLocate }) {
  const headline = item.real_title.trim();
  const when = timeAgoFromDateAdded(item.date_added);
  const meta = [item.source_name, when, item.corroborated ? "corroborated" : null].filter(Boolean).join(" · ");

  return (
    <div className="news-item">
      <div className="news-item-row">
        {item.source_url ? (
          <a href={item.source_url} target="_blank" rel="noopener noreferrer">
            {headline}
          </a>
        ) : (
          <span>{headline}</span>
        )}
        <button
          type="button"
          className="news-locate-btn"
          title="Show on map"
          aria-label="Show on map"
          onClick={() => onLocate(item.lat, item.lon)}
        >
          <LocateIcon />
        </button>
      </div>
      {meta && <div className="news-item-meta">{meta}</div>}
    </div>
  );
}
