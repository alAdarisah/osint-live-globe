// "What matters right now", ranked -- so significance doesn't depend on the
// user spotting the biggest pin among hundreds.
//
// Reuses the /api/events payload already fetched for the map (see
// useOsintData.js's eventsRaw), same as NewsBroadcastPanel does for GDELT:
// no extra polling loop, and the list can never disagree with what the map
// is drawing, because it's the same array.
import { useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import { severityBand, isImprecise } from "../map/severity";

const MAX_ITEMS = 6;

// Below this, an event isn't worth interrupting anyone for. Severity is
// server-computed (event_fusion.py's _severity_for) and already accounts for
// event type, casualties, corroboration and reporting volume.
const MIN_SEVERITY = 40;

const SOURCE_BADGE = { acled: "ACLED", ucdp: "UCDP", gdelt: "GDELT" };

function daysOld(dateStr) {
  if (!dateStr) return 0;
  const then = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (Date.now() - then) / 86400000);
}

// Severity decayed by age: a 3-day-old massacre shouldn't outrank today's
// fighting forever, but recency alone shouldn't let a minor fresh event top
// the list either -- hence a gentle multiplier rather than a hard cutoff.
function rankScore(event) {
  const severity = Number.isFinite(event.severity) ? event.severity : 0;
  return severity * (1 / (1 + daysOld(event.date) * 0.35));
}

// Escalating zones sit above the event list on purpose: "where should I be
// looking" is the higher-order question, and it's the one a map of pins
// genuinely cannot answer -- a region running 3x its own baseline looks
// identical to a busy-but-normal one until something compares them over
// time. Both live in one panel rather than two, so there's a single place to
// look rather than competing alert surfaces.
function EscalationRow({ zone, onLocate }) {
  const [south, west, north, east] = zone.bounds;
  return (
    <div className="escalation-item">
      <div className="notable-item-row">
        <span className="escalation-ratio">{zone.ratio}&times;</span>
        <span className="notable-line">{zone.label}</span>
        <button
          type="button"
          className="news-locate-btn"
          title="Show on map"
          aria-label={`Show ${zone.label} on map`}
          onClick={() => onLocate((south + north) / 2, (west + east) / 2)}
        >
          <LocateIcon />
        </button>
      </div>
      <div className="notable-item-meta">
        {zone.current} in 24h vs {zone.baseline_per_day}/day baseline
        {zone.top_events?.[0]?.country ? ` · ${zone.top_events[0].country}` : ""}
      </div>
    </div>
  );
}

export default function NotableEventsPanel({ eventsRaw, escalation, onLocate, isMobile }) {
  // Expanded by default on desktop -- this is the panel that answers "what
  // should I look at", so hiding it defeats the point. Collapsed on mobile,
  // where it would otherwise cover most of the map.
  const [collapsed, setCollapsed] = useState(() => !!isMobile);

  const items = useMemo(() => {
    const scored = [];
    for (const e of eventsRaw || []) {
      const severity = Number.isFinite(e.severity) ? e.severity : 0;
      if (severity < MIN_SEVERITY) continue;
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      scored.push({ event: e, score: rankScore(e) });
    }
    // id is the tiebreak so equal-scoring events can't swap places between
    // polls -- a list that reshuffles on its own is unreadable.
    scored.sort((a, b) => b.score - a.score || String(a.event.id).localeCompare(String(b.event.id)));
    return scored.slice(0, MAX_ITEMS).map((s) => s.event);
  }, [eventsRaw]);

  const zones = escalation || [];

  // Nothing worth showing -- render nothing at all rather than an empty
  // widget claiming to be a threat board. Note that an empty escalation list
  // is the normal state (it means nothing is above baseline, or there isn't
  // enough history yet to say), so it alone never justifies the panel.
  if (!items.length && !zones.length) return null;

  return (
    <aside id="notableEvents" className={collapsed ? "collapsed" : ""}>
      <button
        type="button"
        className="notable-header"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="notable-pulse" />
        <span className="notable-title">NOTABLE ACTIVITY</span>
        <span className="notable-count">{zones.length ? `${zones.length}↑ ${items.length}` : items.length}</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </button>
      <div className="notable-list">
        {zones.length > 0 && (
          <>
            <div className="notable-section">ESCALATING VS OWN BASELINE</div>
            {zones.map((z) => (
              <EscalationRow key={z.region} zone={z} onLocate={onLocate} />
            ))}
          </>
        )}
        {items.length > 0 && (
          <>
            {zones.length > 0 && <div className="notable-section">TOP EVENTS</div>}
            {items.map((e) => (
              <NotableItem key={e.id} event={e} onLocate={onLocate} />
            ))}
          </>
        )}
      </div>
    </aside>
  );
}

function NotableItem({ event, onLocate }) {
  const severity = Number.isFinite(event.severity) ? event.severity : 0;
  const band = severityBand(severity);
  const sources = (event.corroborated_by && event.corroborated_by.length ? event.corroborated_by : [event.source])
    .filter(Boolean)
    .map((s) => SOURCE_BADGE[s] || s.toUpperCase());
  const where = event.location || event.country || "Location unknown";
  const actors = [event.actor1, event.actor2].filter(Boolean).join(" vs ");
  // The scraped headline when there is one, otherwise the CAMEO actor pair --
  // never a bare event type, which tells the reader nothing they can't see
  // from the severity chip.
  const line = (event.notes || "").trim() || actors || event.event_type || "Conflict event";

  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span
          className="notable-chip"
          style={{ background: band.color }}
          title={`Severity ${severity}/100`}
        >
          {band.label.toUpperCase()}
        </span>
        <span className="notable-line">{line}</span>
        <button
          type="button"
          className="news-locate-btn"
          title="Show on map"
          aria-label="Show on map"
          onClick={() => onLocate(event.lat, event.lon)}
        >
          <LocateIcon />
        </button>
      </div>
      <div className="notable-item-meta">
        {where}
        {event.fatalities ? ` · ${event.fatalities} killed` : ""}
        {event.date ? ` · ${event.date}` : ""}
        {` · ${sources.join("+")}`}
        {event.corroborated ? " · corroborated" : ""}
      </div>
    </div>
  );
}
