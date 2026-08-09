// "What is happening right now, and which of it matters most" -- one panel,
// four tabs, replacing NotableEventsPanel.jsx (escalation + events) and
// NewsBroadcastPanel.jsx (news). A fourth tab, Officials, covers the
// diplomatic-activity kind that has had an endpoint (/api/officials) and no
// panel of its own until now.
//
// Both predecessors reused the map's own live data and its own filters
// (eventsRaw/gdeltRaw already fetched for the map, passesEventFilter already
// applied to the Conflict & Violence layer) so a list could never disagree
// with what the map was drawing. This panel keeps that discipline and
// extends it: Minimum severity and the verification floor used to be two
// separate admin-only controls in ControlPanel, each editing the same shared
// `eventFilter` App.jsx also hands to the map -- they still edit that exact
// object (via `onEventFilterChange`), just from a control a reader can reach
// without Admin Mode. There is one `eventFilter`, not a panel copy and a map
// copy that could drift apart; see ControlPanel/LayersSection.jsx's own note
// on where the controls moved from.
//
// All the pure filtering/scoping/grouping logic lives in intelPanelLogic.js,
// a plain-JS sibling module, for the same reason placeInfoCardGrouping.js
// does: this file is JSX, and the project's headless frontend test suite
// (`node --test`, no build step) cannot import it at all -- see
// frontend/tests/intelPanel.test.js.
import { useCallback, useEffect, useMemo, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import {
  severityBand, severityColor, DEFAULT_EVENT_FILTER, CONFIDENCE_THRESHOLD,
} from "../map/severity";
import { OFFICIALS_KIND_LABEL } from "../map/decorators";
import { timeAgoFromDateAdded, timeAgoFromUnix } from "../utils/format";
import { useDraggablePanel, migratePanelPosition } from "../hooks/useDraggablePanel";
import {
  SCOPE_OPTIONS, SCOPE_WORLD, SCOPE_VIEWPORT, SCOPE_COUNTRY, SCOPE_REGION, SCOPE_WATER,
  WINDOW_OPTIONS, DEFAULT_WINDOW_HOURS, GROUP_BY_OPTIONS, UNKNOWN_GROUP,
  makeIntelScope, groupItems, intelPanelIsEmpty,
  selectEscalationZones, selectEventItems, selectNewsItems, selectOfficialsItems,
} from "./intelPanelLogic";

// Run once, at module scope rather than inside the component -- see
// migratePanelPosition's own docstring for why an effect would be one render
// too late to beat useDraggablePanel's own lazy-read of storage below.
migratePanelPosition("intelPanel", ["notableEvents", "newsBroadcast"]);

const SOURCE_BADGE = { acled: "ACLED", ucdp: "UCDP", gdelt: "GDELT" };

const TABS = [
  { key: "escalation", label: "Escalation" },
  { key: "events", label: "Events" },
  { key: "news", label: "News" },
  { key: "officials", label: "Officials" },
];

// Group by is a per-record axis (country/event-type/actor/outlet), and an
// escalation zone is a region-level aggregate with none of those fields --
// it is already grouped, by region. Offering the control there would either
// no-op silently or need a fifth, zone-shaped set of axes for one tab; doing
// neither is the honest answer for a first pass.
const GROUPABLE_TABS = new Set(["events", "news", "officials"]);

function groupLabel(key, groupBy, tabKind) {
  if (key === UNKNOWN_GROUP) return "Unknown";
  if (groupBy === "eventType" && tabKind === "officials") return OFFICIALS_KIND_LABEL[key] || key;
  if (groupBy === "outlet" && tabKind === "events") return SOURCE_BADGE[key] || key;
  return key;
}

/**
 * A 7-day mini-bar for one escalating region, from the two numbers the
 * backend's escalation ranking already carries (backend/escalation.py) --
 * `current` (this region's last 24h) and `baseline_per_day` (its own trailing
 * 7-day average). There is no day-by-day series behind this: adding one would
 * be a backend change, out of this task's scope. So this is a *derived*
 * sparkline, arithmetic over two measured/reported numbers rather than a real
 * daily series -- six bars at the steady baseline height, then a seventh,
 * today's, at `current`. It answers the same question a real 7-day chart
 * would ("is today unusual for this place") without claiming to know what any
 * of the other six days actually looked like.
 */
function EscalationMiniBar({ zone }) {
  const baseline = Math.max(0, zone.baseline_per_day || 0);
  const current = Math.max(0, zone.current || 0);
  const max = Math.max(baseline, current, 1);
  const bars = [0, 1, 2, 3, 4, 5].map(() => baseline).concat([current]);
  return (
    <div
      className="escalation-minibar"
      title={`${zone.current} events in the last 24h vs a ${zone.baseline_per_day}/day baseline over the trailing 7 days (baseline shown flat -- no day-by-day history behind this yet)`}
    >
      {bars.map((v, i) => (
        <span
          // eslint-disable-next-line react/no-array-index-key -- six identical baseline bars have no id of their own
          key={i}
          className={`escalation-minibar-bar${i === bars.length - 1 ? " today" : ""}`}
          style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

function EscalationRow({ zone, onLocate }) {
  const [south, west, north, east] = zone.bounds;
  return (
    <div className="escalation-item">
      <div className="notable-item-row">
        <span className="escalation-ratio">{zone.ratio}&times;</span>
        <span className="notable-line">{zone.label}</span>
        <EscalationMiniBar zone={zone} />
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

function EventRow({ event, onLocate }) {
  const severity = Number.isFinite(event.severity) ? event.severity : 0;
  const band = severityBand(severity);
  const sources = (event.corroborated_by && event.corroborated_by.length ? event.corroborated_by : [event.source])
    .filter(Boolean)
    .map((s) => SOURCE_BADGE[s] || s.toUpperCase());
  const where = event.location || event.country || "Location unknown";
  const actors = [event.actor1, event.actor2].filter(Boolean).join(" vs ");
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
        {/* Reuses the map's own confidenceDimmed rather than a hard filter --
            see selectEventItems' docstring on why the verification floor
            marks rather than hides. */}
        {event.weaklyPlaced ? " · weakly placed" : ""}
      </div>
    </div>
  );
}

function NewsRow({ item, onLocate }) {
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

function OfficialsRow({ item, onLocate }) {
  const kindLabel = OFFICIALS_KIND_LABEL[item.kind] || "Diplomatic activity";
  const lead = (item.headline || "").trim() || item.label || kindLabel;
  const where = item.location || item.country || "";
  const when = timeAgoFromUnix(item.published_at);
  const actors = [item.actor1, item.actor2].filter(Boolean).join(" → ");
  const publisher = item.outlet || item.government || "";
  const primary = item.origin === "official_feed";

  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span className="notable-chip officials-chip" title={kindLabel}>
          {kindLabel}
        </span>
        <span className="notable-line">{lead}</span>
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
      <div className="notable-item-meta">
        {actors ? `${actors} · ` : ""}
        {where ? `${where} · ` : ""}
        {publisher}
        {when ? ` · ${when}` : ""}
        {primary ? " · official source" : ""}
      </div>
    </div>
  );
}

// One shared "grouped or flat" renderer for the three record tabs -- the
// group headers are cosmetic, and duplicating the map/reduce over three
// near-identical tab bodies would be exactly the kind of drift this project's
// "one definition" rule (see map/severity.js's own note on SEVERITY_BANDS)
// exists to prevent.
function TabList({ items, groupBy, tabKind, Row, rowKey, onLocate }) {
  const groups = GROUPABLE_TABS.has(tabKind) ? groupItems(items, groupBy, tabKind) : null;
  if (!groups) {
    return items.map((item) => <Row key={rowKey(item)} event={item} item={item} onLocate={onLocate} />);
  }
  return groups.map((g) => (
    <div key={g.key} className="intel-group">
      <div className="notable-section">
        {groupLabel(g.key, groupBy, tabKind)} &middot; {g.items.length}
      </div>
      {g.items.map((item) => <Row key={rowKey(item)} event={item} item={item} onLocate={onLocate} />)}
    </div>
  ));
}

export default function IntelPanel({
  eventsRaw, gdeltRaw, officialsRaw, escalation,
  eventFilter = DEFAULT_EVENT_FILTER, onEventFilterChange,
  mapBounds, regions, currentRegionKey,
  countryScope, water, onLocate, isMobile,
}) {
  // Expanded by default on desktop -- this is the panel that answers "what
  // should I look at", so hiding it defeats the point; same reasoning
  // NotableEventsPanel gave. Collapsed on mobile, where it would otherwise
  // cover most of the map.
  const [collapsed, setCollapsed] = useState(() => !!isMobile);
  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const { panelRef, style, handleProps } = useDraggablePanel("intelPanel", {
    onClick: toggleCollapsed,
    enabled: !isMobile,
  });

  const [activeTab, setActiveTab] = useState("events");
  const [scopeKind, setScopeKind] = useState(SCOPE_WORLD);
  const [windowHours, setWindowHours] = useState(DEFAULT_WINDOW_HOURS);
  const [groupBy, setGroupBy] = useState("none");

  // Clicking a country is a request to read this whole panel for that
  // country -- opens it (mattering most on mobile, where it starts
  // collapsed) and switches the Scope control to match, the same automatic
  // behaviour NotableEventsPanel and NewsBroadcastPanel each gave a country
  // click on their own. Keyed on the selection itself so it fires once per
  // pick rather than fighting a reader who then collapses it again.
  const countryKeys = countryScope?.active ? countryScope.keys : null;
  useEffect(() => {
    if (countryKeys) {
      setCollapsed(false);
      setScopeKind(SCOPE_COUNTRY);
    }
  }, [countryKeys]);

  // If the scope a reader picked stops existing -- the country deselected,
  // the region cleared, the water card closed -- the <select> falls back to
  // World rather than keep naming a selection that is no longer there.
  // makeIntelScope already treats a missing selection as World either way;
  // this only keeps the control's own displayed value honest about it.
  useEffect(() => {
    if (scopeKind === SCOPE_COUNTRY && !countryScope?.active) setScopeKind(SCOPE_WORLD);
  }, [scopeKind, countryScope?.active]);
  useEffect(() => {
    if (scopeKind === SCOPE_REGION && !currentRegionKey) setScopeKind(SCOPE_WORLD);
  }, [scopeKind, currentRegionKey]);
  useEffect(() => {
    if (scopeKind === SCOPE_WATER && !water?.entry) setScopeKind(SCOPE_WORLD);
  }, [scopeKind, water?.entry]);

  const region = currentRegionKey && regions?.[currentRegionKey]
    ? { label: regions[currentRegionKey].label, bounds: regions[currentRegionKey].bounds }
    : null;
  const waterCtx = water?.entry ? { entry: water.entry, bounds: water.bounds, label: water.name } : null;

  const scope = useMemo(
    () => makeIntelScope(scopeKind, { mapBounds, countryScope, region, water: waterCtx }),
    // region/waterCtx are fresh object literals every render; their own
    // primitive identities (key/bounds, entry.id) are what actually change,
    // so those -- not the wrapper objects -- belong in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKind, mapBounds, countryScope, region?.label, region?.bounds, waterCtx?.entry?.id, waterCtx?.label]
  );

  const escalationZones = useMemo(
    () => selectEscalationZones(escalation, scope),
    [escalation, scope]
  );
  const eventItems = useMemo(
    () => selectEventItems(eventsRaw, { scope, eventFilter, windowHours }),
    [eventsRaw, scope, eventFilter, windowHours]
  );
  const newsItems = useMemo(
    () => selectNewsItems(gdeltRaw, { scope, windowHours }),
    [gdeltRaw, scope, windowHours]
  );
  const officialsItems = useMemo(
    () => selectOfficialsItems(officialsRaw, { scope, windowHours }),
    [officialsRaw, scope, windowHours]
  );

  const activeItems = activeTab === "escalation" ? escalationZones
    : activeTab === "events" ? eventItems
      : activeTab === "news" ? newsItems
        : officialsItems;

  // Ticks the "updated Ns ago" label independently of data actually
  // changing, so the panel visibly feels alive between polls -- same
  // treatment NewsBroadcastPanel gave its own ticker. Reset whenever the
  // *active tab's own* rows change, so switching tabs shows that tab's real
  // freshness rather than whichever feed happened to poll most recently.
  const [lastUpdateTs, setLastUpdateTs] = useState(() => Date.now());
  useEffect(() => {
    setLastUpdateTs(Date.now());
  }, [activeItems]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const updatedSec = Math.max(0, Math.floor((Date.now() - lastUpdateTs) / 1000));
  const updatedText = updatedSec < 5 ? "updated just now" : `updated ${updatedSec}s ago`;

  // Nothing worth showing anywhere -- render nothing at all rather than an
  // empty widget claiming to be a threat board. See intelPanelIsEmpty's own
  // docstring: a deliberate scope is the one case this never fires for,
  // because there "nothing here" is itself the answer to a direct question.
  if (intelPanelIsEmpty(
    { escalation: escalationZones.length, events: eventItems.length, news: newsItems.length, officials: officialsItems.length },
    scope.deliberate
  )) return null;

  const scopeAvailable = {
    [SCOPE_WORLD]: true,
    [SCOPE_VIEWPORT]: true,
    [SCOPE_COUNTRY]: !!countryScope?.active,
    [SCOPE_REGION]: !!region,
    [SCOPE_WATER]: !!waterCtx,
  };

  return (
    <aside id="intelPanel" ref={panelRef} className={collapsed ? "collapsed" : ""} style={style}>
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
        <span className="notable-title">INTEL</span>
        {scope.deliberate && (
          <span className="notable-scope" title={scope.label}>{scope.label}</span>
        )}
        <span className="news-updated">{updatedText}</span>
        <span className="notable-caret" aria-hidden="true">&#9662;</span>
      </div>

      {!collapsed && (
        <>
          <div className="intel-tabs" role="tablist">
            {TABS.map((t) => {
              const count = t.key === "escalation" ? escalationZones.length
                : t.key === "events" ? eventItems.length
                  : t.key === "news" ? newsItems.length
                    : officialsItems.length;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.key}
                  className={`intel-tab${activeTab === t.key ? " active" : ""}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label} <span className="intel-tab-count">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="intel-controls">
            <label>
              Scope
              <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value)}>
                {SCOPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={!scopeAvailable[opt.value]}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Window
              <select value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
                {WINDOW_OPTIONS.map((opt) => (
                  <option key={opt.hours} value={opt.hours}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label>
              Minimum severity
              <select
                value={eventFilter.minSeverity}
                onChange={(e) => onEventFilterChange?.({ minSeverity: Number(e.target.value) })}
              >
                <option value="0">Any</option>
                <option value="40">Moderate and above</option>
                <option value="55">High and above</option>
                <option value="75">Critical only</option>
              </select>
            </label>
            <label className="event-filter-check">
              <input
                type="checkbox"
                checked={eventFilter.minConfidence >= CONFIDENCE_THRESHOLD}
                onChange={(e) => onEventFilterChange?.({
                  minConfidence: e.target.checked ? CONFIDENCE_THRESHOLD : 0,
                })}
              />
              Fade weakly-placed events
            </label>
            <label>
              Group by
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                disabled={!GROUPABLE_TABS.has(activeTab)}
              >
                {GROUP_BY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="notable-list intel-list">
            {activeTab === "escalation" && (
              escalationZones.length ? (
                escalationZones.map((z) => <EscalationRow key={z.region} zone={z} onLocate={onLocate} />)
              ) : (
                <div className="notable-empty">
                  {scope.deliberate
                    ? `No zone inside ${scope.label} is currently running above its own baseline.`
                    : "No region is currently running above its own 7-day baseline."}
                </div>
              )
            )}

            {activeTab === "events" && (
              eventItems.length ? (
                <TabList items={eventItems} groupBy={groupBy} tabKind="events" Row={EventRow} rowKey={(e) => e.id} onLocate={onLocate} />
              ) : (
                <div className="notable-empty">
                  {scope.deliberate
                    ? `No recorded conflict activity in ${scope.label} in the current window. Widen the window, or clear the scope to see the world board.`
                    : "Nothing clears the significance bar right now. Narrow the scope to a place to see its own worst few regardless."}
                </div>
              )
            )}

            {activeTab === "news" && (
              newsItems.length ? (
                <TabList items={newsItems} groupBy={groupBy} tabKind="news" Row={NewsRow} rowKey={(i) => i.source_url || i.event_id} onLocate={onLocate} />
              ) : (
                <div className="notable-empty">
                  {scope.deliberate ? `No recent headlines for ${scope.label}.` : "No recent headlines for this area."}
                </div>
              )
            )}

            {activeTab === "officials" && (
              officialsItems.length ? (
                <TabList items={officialsItems} groupBy={groupBy} tabKind="officials" Row={OfficialsRow} rowKey={(i) => i.id || `${i.published_at}|${i.lat}|${i.lon}`} onLocate={onLocate} />
              ) : (
                <div className="notable-empty">
                  {scope.deliberate ? `No diplomatic activity recorded for ${scope.label}.` : "No diplomatic activity in the current window."}
                </div>
              )
            )}
          </div>
        </>
      )}
    </aside>
  );
}
