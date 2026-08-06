// Pops up whenever a conflict zone is picked from RegionBar (see
// onSelectRegion in App.jsx) -- a quick-read briefing (event/fatality
// tally + dominant activity type, derived from the same ACLED/GDELT data
// already reactive in state for the news panel and the "Choose Conflict
// Zone" activity ranking) plus that zone's latest headlines, so picking a
// zone answers "what's actually happening here" without also opening the
// separate news ticker.
import { useMemo } from "react";
import { timeAgoFromDateAdded } from "../utils/format";
import { boundsContainsPoint } from "../utils/geo";
import { passesEventFilter, DEFAULT_EVENT_FILTER } from "../map/severity";
import { useDraggablePanel } from "../hooks/useDraggablePanel";

const NEWS_MAX_ITEMS = 5;
const TOP_EVENTS_MAX = 4;

export default function ConflictBriefingCard({
  zone, eventsRaw, eventFilter = DEFAULT_EVENT_FILTER, gdeltRaw, onClose, onLocate,
}) {
  const { panelRef, style, handleProps } = useDraggablePanel("conflictBriefing");

  const bounds = useMemo(() => {
    if (!zone?.bounds) return null;
    const [south, west, north, east] = zone.bounds;
    return { south, west, north, east };
  }, [zone]);

  // Filtered the same way the map is: the tally under a zone's name has to
  // count the pins the reader can actually see in it, or the briefing and the
  // map state two different things about the same place.
  const eventsInZone = useMemo(() => {
    if (!bounds) return [];
    return eventsRaw.filter(
      (e) => typeof e.lat === "number" && typeof e.lon === "number"
        && boundsContainsPoint(bounds, e.lat, e.lon)
        && passesEventFilter(e, eventFilter)
    );
  }, [eventsRaw, eventFilter, bounds]);

  const newsInZone = useMemo(() => {
    if (!bounds) return [];
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
  }, [gdeltRaw, bounds]);

  const briefing = useMemo(() => {
    const fatalities = eventsInZone.reduce((sum, e) => sum + (e.fatalities || 0), 0);
    // Most events in a zone are GDELT-derived and carry no casualty count at
    // all (see event_fusion's fatalities_reported). Summing them to 0 and
    // printing "0 fatalities" would state that nobody died, when the truth is
    // that nobody counted -- so the total is only shown when at least one
    // event in the zone actually reported one.
    const anyReported = eventsInZone.some((e) => e.fatalities_reported !== false);
    const typeCounts = {};
    for (const e of eventsInZone) {
      if (!e.event_type) continue;
      typeCounts[e.event_type] = (typeCounts[e.event_type] || 0) + 1;
    }
    const topType = Object.entries(typeCounts).sort(([, a], [, b]) => b - a)[0]?.[0] || null;
    const topEvents = [...eventsInZone]
      .sort((a, b) => (b.fatalities || 0) - (a.fatalities || 0) || (b.date || "").localeCompare(a.date || ""))
      .slice(0, TOP_EVENTS_MAX);
    return { count: eventsInZone.length, fatalities, anyReported, topType, topEvents };
  }, [eventsInZone]);

  if (!zone) return null;

  return (
    <aside id="conflictBriefing" ref={panelRef} style={style}>
      <div {...handleProps} className={`briefing-header ${handleProps.className || ""}`}>
        <span className="live-dot" />
        <span className="briefing-title">BRIEFING &mdash; {zone.label}</span>
        <button type="button" className="briefing-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div className="briefing-body">
        <p className="briefing-summary">
          {briefing.count === 0
            ? "No recorded conflict events in this zone for the current window."
            : `${briefing.count} conflict event${briefing.count === 1 ? "" : "s"} recorded${
                briefing.anyReported
                  ? `, ${briefing.fatalities} fatalit${briefing.fatalities === 1 ? "y" : "ies"}`
                  : "; no casualty figures reported"
              }.${briefing.topType ? ` Dominant activity: ${briefing.topType}.` : ""}`}
        </p>

        {briefing.topEvents.length > 0 && (
          <ul className="briefing-events">
            {briefing.topEvents.map((e, i) => (
              <li key={i}>
                <span className="briefing-event-type">{e.event_type || "Event"}</span>
                {e.country ? ` — ${e.country}` : ""}
                {e.fatalities ? ` (${e.fatalities} killed)` : ""}
                {e.notes && <div className="briefing-event-notes">{e.notes}</div>}
              </li>
            ))}
          </ul>
        )}

        <div className="briefing-news-heading">Latest news</div>
        <div className="news-list briefing-news-list">
          {newsInZone.length === 0 ? (
            <div className="news-empty">No recent headlines for this zone.</div>
          ) : (
            newsInZone.map((item) => (
              <BriefingNewsItem key={item.source_url || item.event_id} item={item} onLocate={onLocate} />
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

function BriefingNewsItem({ item, onLocate }) {
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
        {typeof item.lat === "number" && typeof item.lon === "number" && (
          <button
            type="button"
            className="news-locate-btn"
            title="Show on map"
            aria-label="Show on map"
            onClick={() => onLocate(item.lat, item.lon)}
          >
            &#9678;
          </button>
        )}
      </div>
      {meta && <div className="news-item-meta">{meta}</div>}
    </div>
  );
}
