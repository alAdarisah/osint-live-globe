// "What matters right now", ranked -- so significance doesn't depend on the
// user spotting the biggest pin among hundreds.
//
// Reuses the /api/events payload already fetched for the map (see
// useOsintData.js's eventsRaw), same as NewsBroadcastPanel does for GDELT:
// no extra polling loop, and the list can never disagree with what the map
// is drawing, because it's the same array run through the same filter
// (map/severity.js's passesEventFilter).
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import {
  severityBand, severityColor, isImprecise, passesEventFilter, DEFAULT_EVENT_FILTER,
} from "../map/severity";
import { useDraggablePanel } from "../hooks/useDraggablePanel";
import CountUp from "./CountUp";
import { ratePeriod } from "../utils/tempo";

const MAX_ITEMS = 6;
// A country view has one country's worth of events to draw on, so it can
// afford (and needs) a longer list than the world board.
const MAX_ITEMS_SCOPED = 8;

// Below this, an event isn't worth interrupting anyone for. Severity is
// server-computed (event_fusion.py's _severity_for) and already accounts for
// event type, casualties, corroboration and reporting volume.
const MIN_SEVERITY = 40;

// The floor exists to keep the world board from being a firehose. Once a
// reader has clicked one country they have already said what they want to look
// at, and "nothing here clears the global bar" is a less useful answer than
// that country's actual worst few -- so the scoped list falls back to the
// user's own event filter alone. Ranking is unchanged, so the order still
// reads worst-first.
const MIN_SEVERITY_SCOPED = 0;

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

export default function NotableEventsPanel({
  eventsRaw, eventFilter = DEFAULT_EVENT_FILTER, escalation, countryScope, onLocate, isMobile,
}) {
  // Expanded by default on desktop -- this is the panel that answers "what
  // should I look at", so hiding it defeats the point. Collapsed on mobile,
  // where it would otherwise cover most of the map.
  const [collapsed, setCollapsed] = useState(() => !!isMobile);

  // Same header-is-the-handle arrangement as the news ticker. Dragging is off
  // on mobile, where this panel is a full-width overlay with nowhere to go.
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const { panelRef, style, handleProps } = useDraggablePanel("notableEvents", {
    onClick: toggleCollapsed,
    enabled: !isMobile,
  });

  const scoped = !!countryScope?.active;
  const scopeKeys = scoped ? countryScope.keys : null;

  // Same reasoning as the news ticker's: a country click is a request to read
  // this board for that country, so it opens on each new selection -- which
  // matters most on mobile, where it starts collapsed.
  useEffect(() => {
    if (scopeKeys) setCollapsed(false);
  }, [scopeKeys]);

  const { items, scoredCount } = useMemo(() => {
    const floor = scoped ? MIN_SEVERITY_SCOPED : MIN_SEVERITY;
    const scored = [];
    for (const e of eventsRaw || []) {
      const severity = Number.isFinite(e.severity) ? e.severity : 0;
      if (severity < floor) continue;
      if (typeof e.lat !== "number" || typeof e.lon !== "number") continue;
      // The panel's own floor above is a separate question from what the user
      // asked the layer to show -- this list must never name an event the map
      // is currently filtering out, or "show on map" leads nowhere.
      if (!passesEventFilter(e, eventFilter)) continue;
      // Point-in-country rather than the event's own `country` string: see
      // map/countryScope.js on why the feeds' country fields can't be trusted
      // to agree with the shape the reader clicked.
      if (scoped && !countryScope.contains(e.lat, e.lon)) continue;
      scored.push({ event: e, score: rankScore(e) });
    }
    // id is the tiebreak so equal-scoring events can't swap places between
    // polls -- a list that reshuffles on its own is unreadable.
    scored.sort((a, b) => b.score - a.score || String(a.event.id).localeCompare(String(b.event.id)));
    return {
      items: scored.slice(0, scoped ? MAX_ITEMS_SCOPED : MAX_ITEMS).map((s) => s.event),
      // The scoped, filtered, uncapped count -- what BUSY_EVENTS in tempo.js is
      // calibrated against. eventsRaw.length would count everything the server
      // sent regardless of severity, filter or scope, which is why the header
      // used to read "maximum" on a quiet board: it was measuring the feed, not
      // what this panel actually decided was worth showing.
      scoredCount: scored.length,
    };
  }, [eventsRaw, eventFilter, scoped, countryScope]);

  // Zones are regions, not countries, so they're kept on overlap rather than
  // containment -- a spike straddling the border is still the answer to "where
  // should I be looking" for the country next to it.
  const zones = useMemo(() => {
    const all = escalation || [];
    if (!scoped) return all;
    return all.filter((z) => countryScope.intersectsBounds(z.bounds));
  }, [escalation, scoped, countryScope]);

  // Nothing worth showing -- render nothing at all rather than an empty
  // widget claiming to be a threat board. Note that an empty escalation list
  // is the normal state (it means nothing is above baseline, or there isn't
  // enough history yet to say), so it alone never justifies the panel.
  //
  // A country selection is the exception: there the panel was asked a direct
  // question, and "nothing" is an answer worth printing rather than a reason
  // to disappear and leave the click looking broken.
  if (!items.length && !zones.length && !scoped) return null;

  return (
    <aside id="notableEvents" ref={panelRef} className={collapsed ? "collapsed" : ""} style={style}>
      {/* A div rather than the <button> it used to be: a drag handle that is
          also a button gets a click fired at the end of every drag, and the
          expanded/collapsed state now rides on the div's own ARIA instead. */}
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
        <span className="notable-pulse" style={{ "--period": ratePeriod(scoredCount) }} />
        <span className="notable-title">NOTABLE ACTIVITY</span>
        {/* Names the filter in the header, so a short list reads as "scoped to
            Sudan" rather than "the world went quiet". */}
        {scoped && <span className="notable-scope" title={countryScope.label}>{countryScope.label}</span>}
        <span className="notable-count">
          {zones.length ? <>{zones.length}&#8593; <CountUp value={items.length} /></> : <CountUp value={items.length} />}
        </span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>
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
        {!items.length && !zones.length && (
          <div className="notable-empty">
            No recorded conflict activity in {countryScope.label} in the current
            window. Widen the conflict filter, or clear the selection to see the
            world board.
          </div>
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
          style={{ background: severityColor(band) }}
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
