// Reuses the GDELT data already fetched for the map markers (see
// useOsintData.js) -- no separate polling loop. Filtered to the current
// viewport (same pattern the map controller's renderers use) so it always
// reflects whatever region is currently in view/selected, not just the
// initial selection.
import { useEffect, useMemo, useState } from "react";
import { gdeltSentence } from "../map/decorators";
import { timeAgoFromDateAdded } from "../utils/format";
import { padBounds, boundsContainsPoint } from "../utils/geo";
import LocateIcon from "./icons/LocateIcon";

const NEWS_MAX_ITEMS = 8;

export default function NewsBroadcastPanel({ gdeltRaw, mapBounds, regionLabel, isMobileViewport, onLocate }) {
  // Only the *initial* viewport decides the default -- an 85vw-wide open
  // drawer would cover most of a small screen, but we don't want to fight a
  // user's manual toggle if they later resize the window.
  const [collapsed, setCollapsed] = useState(isMobileViewport);

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

  return (
    <aside id="newsBroadcast" className={collapsed ? "collapsed" : ""}>
      <div className="news-header" onClick={() => setCollapsed((c) => !c)}>
        <span className="live-dot" />
        <span className="news-title">
          LIVE &mdash; <span>{regionLabel}</span>
        </span>
        <span className="news-updated">{updatedText}</span>
        <span className="news-caret" aria-hidden="true">
          &#9662;
        </span>
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
