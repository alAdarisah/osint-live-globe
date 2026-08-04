// Reuses the GDELT data already fetched for the map markers (see
// useOsintData.js) -- no separate polling loop. Filtered to the current
// viewport (same pattern the map controller's renderers use) so it always
// reflects whatever region is currently in view/selected, not just the
// initial selection.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gdeltSentence } from "../map/decorators";
import { timeAgoFromDateAdded } from "../utils/format";
import { padBounds, boundsContainsPoint } from "../utils/geo";
import LocateIcon from "./icons/LocateIcon";

const NEWS_MAX_ITEMS = 8;

export default function NewsBroadcastPanel({ gdeltRaw, mapBounds, regionLabel, onLocate }) {
  // Starts collapsed on every viewport -- the news ticker is opt-in, same
  // "quiet by default" treatment as the layer checkboxes in App.jsx's
  // DEFAULT_LAYER_VISIBILITY.
  const [collapsed, setCollapsed] = useState(true);

  // Widget-style dragging: header is the drag handle. `pos` is null until
  // the user first drags, meaning "use the default fixed top-right CSS
  // position" -- once set, inline style takes over and pins the panel
  // wherever it was dropped (clamped to stay on-screen).
  const [pos, setPos] = useState(null);
  const dragRef = useRef(null); // { startX, startY, originX, originY, moved }

  const onHeaderPointerDown = useCallback((e) => {
    if (e.target.closest(".news-caret-btn")) return; // caret has its own click handler
    const rect = e.currentTarget.closest("#newsBroadcast").getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: rect.left,
      originY: rect.top,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onHeaderPointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const maxX = window.innerWidth - drag.width - 4;
    const maxY = window.innerHeight - drag.height - 4;
    setPos({
      x: Math.min(Math.max(drag.originX + dx, 4), Math.max(maxX, 4)),
      y: Math.min(Math.max(drag.originY + dy, 4), Math.max(maxY, 4)),
    });
  }, []);

  const onHeaderPointerUp = useCallback((e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (!drag.moved) setCollapsed((c) => !c); // plain click -- toggle like before
  }, []);

  const items = useMemo(() => {
    if (!mapBounds) return [];
    const bounds = padBounds(mapBounds, 0.25);
    const seen = new Set();
    const filtered = [];
    for (const d of gdeltRaw) {
      if (typeof d.lat !== "number" || typeof d.lon !== "number") continue;
      if (!boundsContainsPoint(bounds, d.lat, d.lon)) continue;
      const key = d.source_url || d.event_id;
      if (key == null || seen.has(key)) continue;
      seen.add(key);
      filtered.push(d);
    }
    // The scrape-backfill that fills in a real headline (see gdelt.py's
    // _backfill_titles) runs after each poll and lags the newest items the
    // most -- sorting on recency alone would mean the panel is dominated by
    // the CAMEO-generated fallback sentence. Prefer real titles first, and
    // only fall back to less-titled items when there aren't enough yet.
    const hasRealTitle = (d) => !!(d.real_title && d.real_title.trim());
    filtered.sort((a, b) => {
      const titleDiff = (hasRealTitle(b) ? 1 : 0) - (hasRealTitle(a) ? 1 : 0);
      if (titleDiff !== 0) return titleDiff;
      return (b.date_added || "").localeCompare(a.date_added || "");
    });
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

  const style = pos ? { left: pos.x, top: pos.y, right: "auto" } : undefined;

  return (
    <aside id="newsBroadcast" className={collapsed ? "collapsed" : ""} style={style}>
      <div
        className="news-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        title="Drag to move"
      >
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
          onClick={() => setCollapsed((c) => !c)}
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
  const headline = (item.real_title && item.real_title.trim()) || gdeltSentence(item);
  const when = timeAgoFromDateAdded(item.date_added);
  const meta = [item.source_name, item.location, when].filter(Boolean).join(" · ");

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
