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
// extends it: Window, Minimum severity and the verification floor used to be
// three separate admin-only controls in ControlPanel, each editing the same
// shared `eventFilter` App.jsx also hands to the map. They still edit that
// exact object (via `onEventFilterChange`), just from controls a reader can
// reach without Admin Mode -- and Window is now the *only* place that sets
// `eventFilter.maxAgeDays`: this panel's own Window control pushes it (see
// the effect below), and ControlPanel no longer has a competing copy that
// could disagree with it (Task 12's review, Important 3 -- see
// LayersSection.jsx's own note where that select used to sit). There is one
// `eventFilter`, not a panel copy and a map copy that could drift apart.
//
// All the pure filtering/scoping/grouping logic lives in intelPanelLogic.js,
// a plain-JS sibling module, for the same reason placeInfoCardGrouping.js
// does: this file is JSX, and the project's headless frontend test suite
// (`node --test`, no build step) cannot import it at all -- see
// frontend/tests/intelPanel.test.js.
//
// A row here can open the same card a map pin (or a country-card row) opens
// -- App.jsx's own openRecordDetail(kind, id) -> mapApi.recordDetail, the
// generic "one record's full detail, by layer and id" createMapController.js
// already exposes. See intelRecordRef in intelPanelLogic.js for which kind a
// row belongs to (Escalation has none -- a zone is a region aggregate, not a
// record with an id of its own) and which field its id lives under.
//
// Opening the card does *not* also fly the map to it. Every row already
// carries its own "Show on map" button (the LocateIcon one, `onLocate`) --
// this app's one locate precedent, reused unchanged here rather than
// invented a second time -- and the card itself repeats that same button in
// its header when the record has a coordinate (EventDetailCard.jsx). A click
// that both opened a card *and* silently recentred the map underneath it
// would either double up on a reader's explicit "show me where" request or
// make one click do two different things depending on which affordance is
// hovered; every other place this same card opens from (CountryInfoCard,
// WaterInfoCard, SubdivisionInfoCard, DistrictInfoCard) already keeps map
// movement and card-opening as two separate, explicit actions, and this
// keeps that agreement rather than drawing a second rule for one more panel.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import LocateIcon from "./icons/LocateIcon";
import DetailIcon from "./icons/DetailIcon";
import {
  severityBand, severityColor, reliabilityBand, reliabilityColor,
  DEFAULT_EVENT_FILTER, CONFIDENCE_THRESHOLD, placementNote,
} from "../map/severity";
import { OFFICIALS_KIND_LABEL } from "../map/decorators";
import { eventLeadLine } from "../map/eventLead";
import { safeUrl, timeAgoFromDateAdded, timeAgoFromUnix } from "../utils/format";
import Watchlist from "./feed/Watchlist";
import FilterChipRow from "./feed/FilterChipRow";
import { selectActivityItems, filterByChip, activityEmptyMessage } from "./feed/feedItemLogic";
import { visibleCount, hasMore, feedCountReadout, pagingResetKey } from "./feed/feedPaging";
import {
  SCOPE_OPTIONS, SCOPE_WORLD, SCOPE_VIEWPORT, SCOPE_COUNTRY, SCOPE_REGION, SCOPE_WATER,
  WINDOW_OPTIONS, DEFAULT_WINDOW_HOURS, windowOptionValue, windowHoursFromValue,
  GROUP_BY_OPTIONS, UNKNOWN_GROUP,
  makeIntelScope, groupItems, intelPanelIsEmpty,
  selectEscalationZones, selectEventItems, selectNewsItems, selectOfficialsItems,
  escalationMiniBarTitle, eventReliabilityTooltip, intelRecordRef,
  escalationEmptyMessage, eventsEmptyMessage, newsEmptyMessage, officialsEmptyMessage,
} from "./intelPanelLogic";

// The migratePanelPosition call that used to sit here is gone with the drag:
// this panel is a fixed rail now and has no stored position to migrate. The
// records themselves are left in storage rather than deleted -- see
// useDraggablePanel.js, which still clears them on an explicit layout reset.

const SOURCE_BADGE = { acled: "ACLED", ucdp: "UCDP", gdelt: "GDELT" };

const TABS = [
  { key: "escalation", label: "Escalation" },
  // The stream, as against Events' ranking -- see feedItemLogic.js on why both
  // exist. Placed second because "what has just happened" is the question a
  // reader arrives with; "what matters most" is the one they stay for.
  { key: "activity", label: "Activity" },
  { key: "events", label: "Events" },
  { key: "news", label: "News" },
  { key: "officials", label: "Officials" },
  // Not a feed of its own -- SanctionsBoard renders its own body here, keeping
  // its own polling, sort and every caveat string. It is a tab rather than a
  // board because what it lists is records, which is what this rail is for.
  { key: "sanctions", label: "Sanctions" },
];

/** The two tabs the chip row can filter. The other three are either already
 *  grouped (Escalation is per region) or carry no event type to filter on. */
const CHIPPABLE_TABS = new Set(["activity", "events"]);

// Group by is a per-record axis (country/event-type/actor/outlet), and an
// escalation zone is a region-level aggregate with none of those fields --
// it is already grouped, by region. Offering the control there would either
// no-op silently or need a fifth, zone-shaped set of axes for one tab; doing
// neither is the honest answer for a first pass.
const GROUPABLE_TABS = new Set(["activity", "events", "news", "officials"]);

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
 *
 * That claim is disclosed three ways, not just one: the six baseline bars get
 * a hatched fill and the "today" bar a solid one (CSS, `.escalation-minibar-
 * bar`/`.today`), the caller prints a persistent one-line caption once above
 * the whole Escalation list (not per-row, and not only on hover), and this
 * element's own `title=` repeats the numbers for anyone who does hover it.
 * The first review pass shipped only the third of these -- `title` needs
 * hover, which never fires on the touch screens this panel explicitly
 * supports (`isMobile`) -- so a phone reader saw what looked like a week of
 * real daily readings and had no way to learn six of the seven were
 * arithmetic. The pattern and the caption are what fix that; the tooltip is
 * now only ever a supplement to them, never the only copy of the claim.
 */
function EscalationMiniBar({ zone }) {
  const baseline = Math.max(0, zone.baseline_per_day || 0);
  const current = Math.max(0, zone.current || 0);
  const max = Math.max(baseline, current, 1);
  const bars = [0, 1, 2, 3, 4, 5].map(() => baseline).concat([current]);
  return (
    <div
      className="escalation-minibar"
      title={escalationMiniBarTitle(zone)}
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

const EscalationRow = memo(function EscalationRow({ zone, onLocate }) {
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
});

// The row's own headline, as either the "open this record's detail card"
// button (the same card a map pin opens -- see intelRecordRef's own note on
// why the id/kind lookup lives in intelPanelLogic.js rather than here) or, for
// a row intelRecordRef could never resolve (Escalation has no card at all;
// News can lack event_id), a plain span. A row this can't open must not look
// clickable -- the whole point of returning `null` rather than guessing.
function RecordLine({ recordRef, onOpenRecord, children }) {
  if (!recordRef || !onOpenRecord) return <span className="notable-line">{children}</span>;
  return (
    <button
      type="button"
      className="notable-line notable-line-btn"
      onClick={() => onOpenRecord(recordRef.kind, recordRef.id)}
    >
      {children}
    </button>
  );
}

const EventRow = memo(function EventRow({ event, onLocate, onOpenRecord }) {
  const severity = Number.isFinite(event.severity) ? event.severity : 0;
  const band = severityBand(severity);
  // How much to trust the *report*, as distinct from how bad it is -- scored
  // by backend/sources/reliability.py and written onto every fused event by
  // event_fusion.py. Null on a record with no score at all (pre-reliability.py
  // replay snapshots), guarded the same way decorators.js's own
  // reliabilityBlock guards it, rather than inventing a band for a record
  // that was never scored.
  const trustBand = reliabilityBand(event);
  const sources = (event.corroborated_by && event.corroborated_by.length ? event.corroborated_by : [event.source])
    .filter(Boolean)
    .map((s) => SOURCE_BADGE[s] || s.toUpperCase());
  const where = event.location || event.country || "Location unknown";
  // The same line the map's tooltip, the popup and the detail card show -- see
  // map/eventLead.js. This used to fall back to `actor1 vs actor2` where the
  // other three fall back to `summary`, and since the backend writes `summary`
  // only when there is no headline, the fallback was the one case that mattered:
  // the row said "Russian armed forces vs Civilians" about a record whose card
  // read "Russian armed forces carried out an air strike on civilians in
  // Kharkiv."
  const line = eventLeadLine(event);
  // Same card recordDetail("events", id) builds for a map pin (see
  // eventDetail.js) -- resolved once, here, rather than re-derived inside
  // RecordLine, so a row with no usable id (never happens for a fused event,
  // which always carries one, but intelRecordRef is the one place that rule
  // lives) renders as plain text instead of a button that would do nothing.
  const placement = placementNote(event);
  const recordRef = intelRecordRef(event, "events");

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
        {trustBand && (
          <span
            className="notable-chip reliability-chip"
            style={{ background: reliabilityColor(trustBand) }}
            title={eventReliabilityTooltip(event, trustBand)}
          >
            {trustBand.label}
          </span>
        )}
        <RecordLine recordRef={recordRef} onOpenRecord={onOpenRecord}>{line}</RecordLine>
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
        {/* The map marks the same boolean (confidenceDimmed) by desaturating
            the pin (.weakly-sourced, decorators.js); this tab says it in
            words instead -- see selectEventItems' own note on why the
            verification floor marks rather than hides, and on the two being
            different presentations of one shared computation rather than
            identical treatments. */}
        {event.weaklyPlaced ? " · weakly placed" : ""}
        {/* A different axis from weaklyPlaced above, and the reason this row is
            visible at all: events placed to a national or regional centroid used
            to be filtered out of both the map and this tab by a default no reader
            could reach. They are shown now, so each one has to say what kind of
            coordinate it has and how much slack that is -- the map draws that as
            a dashed ring and a disc at the same radius, and a list has to write
            it. See placementNote in map/severity.js. */}
        {placement ? ` · ${placement}` : ""}
      </div>
    </div>
  );
});

const NewsRow = memo(function NewsRow({ item, onLocate, onOpenRecord }) {
  const headline = item.real_title.trim();
  const when = timeAgoFromDateAdded(item.date_added);
  const meta = [item.source_name, when, item.corroborated ? "corroborated" : null].filter(Boolean).join(" · ");
  // safeUrl returns "" for anything that is not http(s), so the headline falls
  // back to plain text rather than becoming a link to a scheme nobody vetted.
  // The URL is the publisher's, not this app's: React will render whatever
  // scheme a feed hands it, and `javascript:` in an href is the whole reason
  // this is not simply `item.source_url`. Same treatment ConflictBriefingCard
  // and map/popups.js give the same field.
  const link = safeUrl(item.source_url);
  // Unlike Events/Officials, News' own headline is already the row's primary
  // click target -- a real link to the cited article, which has to keep
  // working as a link (including middle-click and open-in-new-tab). Making
  // the headline itself open the detail card too would mean one element
  // doing two different things depending on exactly where the click landed,
  // so this gets its own explicit button next to Locate instead -- rendered
  // only when intelRecordRef actually resolves (a News row without its own
  // event_id, same as one with no coordinate, is a real state, not a bug).
  const recordRef = intelRecordRef(item, "news");

  return (
    <div className="news-item">
      <div className="news-item-row">
        {link ? (
          <a href={link} target="_blank" rel="noopener noreferrer">
            {headline}
          </a>
        ) : (
          <span>{headline}</span>
        )}
        {recordRef && onOpenRecord && (
          <button
            type="button"
            className="news-locate-btn"
            title="Open detail card"
            aria-label="Open detail card"
            onClick={() => onOpenRecord(recordRef.kind, recordRef.id)}
          >
            <DetailIcon />
          </button>
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
});

const OfficialsRow = memo(function OfficialsRow({ item, onLocate, onOpenRecord }) {
  const kindLabel = OFFICIALS_KIND_LABEL[item.kind] || "Diplomatic activity";
  const lead = (item.headline || "").trim() || item.label || kindLabel;
  const where = item.location || item.country || "";
  const when = timeAgoFromUnix(item.published_at);
  const actors = [item.actor1, item.actor2].filter(Boolean).join(" → ");
  const publisher = item.outlet || item.government || "";
  const primary = item.origin === "official_feed";
  const recordRef = intelRecordRef(item, "officials");

  return (
    <div className="notable-item">
      <div className="notable-item-row">
        <span className="notable-chip officials-chip" title={kindLabel}>
          {kindLabel}
        </span>
        <RecordLine recordRef={recordRef} onOpenRecord={onOpenRecord}>{lead}</RecordLine>
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
});

// One shared "grouped or flat" renderer for the three record tabs -- the
// group headers are cosmetic, and duplicating the map/reduce over three
// near-identical tab bodies would be exactly the kind of drift this project's
// "one definition" rule (see map/severity.js's own note on SEVERITY_BANDS)
// exists to prevent.
/**
 * One row of the merged stream, drawn in the idiom of whichever feed it came
 * from.
 *
 * A dispatcher rather than a fourth row layout: a conflict record still shows
 * its severity and reliability chips, a headline still links out to its outlet,
 * a statement still shows its kind. Flattening the three into one generic row
 * would cost exactly the provenance this map exists to show -- and the three
 * row components already say it correctly.
 */
const ActivityRow = memo(function ActivityRow({ item, onLocate, onOpenRecord }) {
  if (item.feed === "news") return <NewsRow item={item} onLocate={onLocate} onOpenRecord={onOpenRecord} />;
  if (item.feed === "officials") return <OfficialsRow item={item} onLocate={onLocate} onOpenRecord={onOpenRecord} />;
  return <EventRow event={item} onLocate={onLocate} onOpenRecord={onOpenRecord} />;
});

function TabList({ items, groupBy, tabKind, Row, rowKey, onLocate, onOpenRecord }) {
  const groups = GROUPABLE_TABS.has(tabKind) ? groupItems(items, groupBy, tabKind) : null;
  if (!groups) {
    return items.map((item) => (
      <Row key={rowKey(item)} event={item} item={item} onLocate={onLocate} onOpenRecord={onOpenRecord} />
    ));
  }
  return groups.map((g) => (
    <div key={g.key} className="intel-group">
      <div className="notable-section">
        {groupLabel(g.key, groupBy, tabKind)} &middot; {g.items.length}
      </div>
      {g.items.map((item) => (
        <Row key={rowKey(item)} event={item} item={item} onLocate={onLocate} onOpenRecord={onOpenRecord} />
      ))}
    </div>
  ));
}

export default function IntelPanel({
  tabs,
  eventsRaw, gdeltRaw, officialsRaw, escalation,
  eventFilter = DEFAULT_EVENT_FILTER, onEventFilterChange,
  // Owned by App.jsx and shared with the sub bar's time pills -- see the note
  // where this panel's own `windowHours` state used to be.
  windowHours = DEFAULT_WINDOW_HOURS, onWindowHoursChange,
  mapBounds, regions, currentRegionKey,
  countryScope, water, onLocate, onOpenRecord, isMobile,
  open = true, watchlist, onOpenSubject, sanctionsTab,
}) {
  // No collapse and no drag any more.
  //
  // This was a floating card that a reader placed and folded away; it is now a
  // fixed rail the map is inset for, opened and closed from the sub bar's ☰ FEED
  // button. Both of the old affordances have an answer in the new arrangement:
  // "get it out of the way" is the toggle, and "put it somewhere else" is moot
  // for a rail with one place to be. `open` is the toggle's state, held in
  // useChromeLayout beside the inset it drives, so the panel and the map cannot
  // disagree about whether there is a rail.

  // Which tabs this deployment carries, in this panel's own order. An absent
  // prop means all of them, so nothing that renders this panel without an
  // opinion has to supply one.
  //
  // Filtered from TABS rather than mapped from the prop, so the order on screen
  // is always this file's -- a caller cannot rearrange the tab bar by listing
  // the keys in a different sequence, which is not a decision the settings
  // shape was meant to carry.
  const shownTabs = useMemo(
    () => (tabs ? TABS.filter((t) => tabs.includes(t.key)) : TABS),
    [tabs]
  );

  const [activeTab, setActiveTab] = useState("events");
  // The selected tab can stop being carried while it is selected -- an operator
  // unticks Events in Admin Mode and the panel is still showing it. Falling
  // back to the first tab that is left keeps the body and the tab bar agreeing;
  // without it the bar would highlight nothing and the body would go on
  // rendering a tab nobody can reach.
  useEffect(() => {
    if (!shownTabs.length) return;
    if (!shownTabs.some((t) => t.key === activeTab)) setActiveTab(shownTabs[0].key);
  }, [shownTabs, activeTab]);
  const [scopeKind, setScopeKind] = useState(SCOPE_WORLD);
  const [groupBy, setGroupBy] = useState("none");
  const [chip, setChip] = useState("all");

  // `windowHours` is no longer this panel's state, and the effect that pushed
  // it into eventFilter.maxAgeDays is no longer here.
  //
  // It moved to App.jsx, unchanged in what it does, because the same choice is
  // now offered twice: here as a select, and in the sub bar as a row of pills.
  // Two controls each owning their own copy of the number is precisely the
  // arrangement Task 12's review (Important 3) removed when ControlPanel had a
  // second Window select -- two controls that could silently disagree about how
  // far back the Conflict & Violence layer looks. One value, held above both,
  // keeps that fixed: these are two views of one number, not two numbers.
  //
  // The single push into eventFilter lives beside it in App.jsx, so there is
  // still exactly one writer of maxAgeDays -- which is what urlState.js's own
  // module doc depends on when it explains why that field is not carried in a
  // link.

  // Clicking a country is a request to read this whole panel for that country,
  // so the Scope control follows the map -- the same automatic behaviour
  // NotableEventsPanel and NewsBroadcastPanel each gave a country click on their
  // own. Keyed on the selection itself so it fires once per pick rather than
  // fighting a reader who then changes the scope back.
  //
  // It used to open the panel as well, which is what the redesign broke: the rail
  // does not fold any more, `collapsed` and its setter went with the fold, and
  // this call to setCollapsed did not. An undefined identifier inside an effect
  // is a ReferenceError, and this effect fires on the *first* country click --
  // reportCountrySelection always supplies bbox and polygons, which is exactly
  // what makeCountryScope needs to report active -- so clicking any country took
  // the whole app down to main.jsx's CrashScreen. Nothing caught it because the
  // suite has no test that selects a country.
  const countryKeys = countryScope?.active ? countryScope.keys : null;
  useEffect(() => {
    if (countryKeys) setScopeKind(SCOPE_COUNTRY);
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
  // No `windowHours` here -- eventFilter.maxAgeDays *is* windowHours now (see
  // the effect above), and passesEventFilter (called inside selectEventItems)
  // already checks it. A second local re-check against windowHours directly
  // was the Important-3 bug: two computations of the same day-count that
  // could read the same control and still disagree, if either drifted from
  // the other. There is one now.
  const eventItems = useMemo(
    () => selectEventItems(eventsRaw, { scope, eventFilter }),
    [eventsRaw, scope, eventFilter]
  );
  const newsItems = useMemo(
    () => selectNewsItems(gdeltRaw, { scope, windowHours }),
    [gdeltRaw, scope, windowHours]
  );
  const officialsItems = useMemo(
    () => selectOfficialsItems(officialsRaw, { scope, windowHours }),
    [officialsRaw, scope, windowHours]
  );

  // The merged stream. Built from the three lists above rather than from the
  // raw feeds, so scope, window and every filter have been applied exactly once
  // and the stream cannot disagree with the tab a record also appears in.
  const activityStream = useMemo(
    () => selectActivityItems({ events: eventItems, news: newsItems, officials: officialsItems }),
    [eventItems, newsItems, officialsItems]
  );
  const activityItems = useMemo(
    () => filterByChip(activityStream, chip),
    [activityStream, chip]
  );
  const chippedEventItems = useMemo(
    () => filterByChip(eventItems, chip),
    [eventItems, chip]
  );

  const activeItems = activeTab === "escalation" ? escalationZones
    : activeTab === "activity" ? activityItems
      : activeTab === "events" ? chippedEventItems
        : activeTab === "news" ? newsItems
          : officialsItems;

  // ---------- how much of the active tab is in the DOM ----------
  //
  // The selectors above no longer truncate (see intelPanelLogic.js on why the
  // four caps are gone), so the lists here are the real ones -- hundreds of rows,
  // not six. This is what keeps that affordable: a page at a time, grown when the
  // reader reaches the end. See feed/feedPaging.js for the reasoning, including
  // why this is not virtualisation.
  const [pages, setPages] = useState(1);
  const listRef = useRef(null);
  const sentinelRef = useRef(null);

  // Reset on anything that changes what the list is *about* -- and on nothing
  // else. Emphatically not on new data: the rail refetches every 60 seconds, and
  // resetting there would drag a reader who had scrolled to row 300 back to the
  // top, once a minute, for no reason they could see.
  const resetKey = pagingResetKey({ tab: activeTab, scopeKind, windowHours, chip });
  useEffect(() => {
    setPages(1);
    // The scroll position belongs to the old list; leaving it makes a fresh
    // 40-row page open halfway down.
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resetKey]);

  const paged = useCallback((list) => list.slice(0, visibleCount(list.length, pages)), [pages]);
  const moreToReveal = hasMore(activeItems.length, pages);

  // Reveals the next page when the sentinel at the end of the list scrolls into
  // the rail. Rooted on the list rather than the viewport because the rail is its
  // own scroll container -- a viewport-rooted observer would see the sentinel as
  // permanently visible or permanently not, depending on where the rail sits.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || !moreToReveal) return undefined;
    if (typeof IntersectionObserver !== "function") {
      // No observer (a very old browser, or a test environment): reveal
      // everything rather than stranding the reader at row 40 with no way on.
      setPages(Number.MAX_SAFE_INTEGER);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setPages((prev) => prev + 1);
      },
      // A page ahead of the fold, so the next rows are already there by the time
      // the reader gets to them rather than appearing under the scrollbar.
      { root, rootMargin: "400px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [moreToReveal, activeTab, activeItems.length]);

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

  // This panel used to return null when nothing anywhere was worth showing --
  // "render nothing rather than an empty widget claiming to be a threat board".
  // That rule was right for a floating card, which could simply not be there.
  //
  // It cannot survive the panel becoming a fixed rail the map is inset for: a
  // 332px column that renders nothing leaves a 332px hole with the map shifted
  // off it, which is a worse lie than an honest empty tab. So the discipline
  // moves down a level rather than being dropped -- the rail always draws its
  // own chrome when open, and each tab body says, in its own words, whether it
  // looked and found nothing (escalationEmptyMessage and its four siblings,
  // which already existed for exactly this and already distinguish "nothing
  // qualifies" from "nothing here"). intelPanelIsEmpty is still what decides
  // whether the *header* claims to be reporting anything.
  const nothingAnywhere = intelPanelIsEmpty(
    {
      escalation: escalationZones.length,
      events: eventItems.length,
      news: newsItems.length,
      officials: officialsItems.length,
    },
    scope.deliberate
  );

  if (!open) return null;

  const scopeAvailable = {
    [SCOPE_WORLD]: true,
    [SCOPE_VIEWPORT]: true,
    [SCOPE_COUNTRY]: !!countryScope?.active,
    [SCOPE_REGION]: !!region,
    [SCOPE_WATER]: !!waterCtx,
  };

  return (
    <aside id="intelPanel" className="feed-rail" aria-label="Intel feed">
      <div className="notable-header feed-head">
        <span className="notable-pulse" />
        <span className="notable-title">INTEL</span>
        {scope.deliberate && (
          <span className="notable-scope" title={scope.label}>{scope.label}</span>
        )}
        {/* Only claims freshness when there is something to be fresh about. A
            rail that says "updated 3s ago" over five empty tabs is reporting on
            its own timer rather than on the world. */}
        {!nothingAnywhere && <span className="news-updated">{updatedText}</span>}
      </div>

      <Watchlist items={watchlist?.items} onRemove={watchlist?.remove} onOpen={onOpenSubject} />

      {(
        <>
          <div className="intel-tabs" role="tablist">
            {shownTabs.map((t) => {
              const total = t.key === "escalation" ? escalationZones.length
                : t.key === "activity" ? activityItems.length
                  : t.key === "events" ? chippedEventItems.length
                    : t.key === "news" ? newsItems.length
                      : t.key === "officials" ? officialsItems.length
                        : null;
              // `shown / total` on the tab a reader is looking at, the bare total
              // on the rest. These used to be the length of the array *after* the
              // selector's slice, so a tab with 334 articles behind it read "8"
              // and there was nothing to say otherwise -- a count that looks like
              // a total and is a page size.
              const count = total == null
                ? null
                : feedCountReadout(total, t.key === activeTab ? pages : Number.MAX_SAFE_INTEGER);
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.key}
                  className={`intel-tab${activeTab === t.key ? " active" : ""}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {/* A tab whose count this rail does not own says nothing
                      rather than showing a zero it did not compute. */}
                  {t.label}{" "}
                  {count && <span className="intel-tab-count" title={count.title}>{count.text}</span>}
                </button>
              );
            })}
          </div>

          {CHIPPABLE_TABS.has(activeTab) && (
            <FilterChipRow value={chip} onChange={setChip} />
          )}

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
            {/* selectEscalationZones never reads windowHours -- a zone is a
                fixed 24h-vs-7-day-baseline computation from the backend, not
                a record with its own timestamp to window (see that
                function's own comment). Disabled here for the same reason
                Minimum severity/verification are disabled outside Events:
                unlike those two, Window still has a real job while parked on
                Escalation (it keeps driving eventFilter.maxAgeDays, which the
                map's Conflict & Violence layer reads regardless of which tab
                is open), so only Escalation itself is excluded, not every
                non-Events tab. */}
            <label>
              Window
              {/* Exchanged as the pill string rather than the hour count: one
                  option is `null` ("no cap"), which a <select> cannot carry --
                  see windowOptionValue's own note. */}
              <select
                value={windowOptionValue(windowHours)}
                onChange={(e) => onWindowHoursChange?.(windowHoursFromValue(e.target.value))}
                disabled={activeTab === "escalation"}
              >
                {WINDOW_OPTIONS.map((opt) => (
                  <option key={opt.pill} value={opt.pill}>{opt.label}</option>
                ))}
              </select>
            </label>
            {/* Neither control has anything to act on outside Events: GDELT
                (News) and officials rows carry no `severity` or
                `geo_confidence` field at all -- reliability.py and
                geoverify.py only ever score conflict_events. Disabled here
                for the same reason Group by is below, so a reader cannot
                crank a dial that cannot move rather than discovering that by
                watching nothing happen. */}
            <label>
              Minimum severity
              <select
                value={eventFilter.minSeverity}
                onChange={(e) => onEventFilterChange?.({ minSeverity: Number(e.target.value) })}
                disabled={activeTab !== "events"}
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
                disabled={activeTab !== "events"}
              />
              Fade weakly-placed events
            </label>
            {/* The reader's half of the showImprecise decision -- see
                DEFAULT_EVENT_FILTER in map/severity.js for why it now ships on.
                A third of the conflict layer is placed to a national or regional
                centroid, and that third used to be hidden by a default whose only
                two controls were in Admin Mode: a reader could neither see the
                rows nor discover that anything was missing. Shown and marked is
                the honest arrangement, and this is the escape hatch for a reader
                who wants only coordinates the pipeline can stand behind.
                Worded as what it does rather than as the field name: "imprecise"
                is the backend's word for it and says nothing about what is being
                offered. */}
            <label className="event-filter-check">
              <input
                type="checkbox"
                checked={eventFilter.showImprecise !== false}
                onChange={(e) => onEventFilterChange?.({ showImprecise: e.target.checked })}
                disabled={activeTab !== "events" && activeTab !== "activity"}
              />
              Include country-level placements
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

          <div className="notable-list intel-list" ref={listRef}>
            {activeTab === "escalation" && (
              escalationZones.length ? (
                <>
                  {/* Persistent, not just the mini-bar's own title= (which
                      needs hover, and never fires on a touch screen this
                      panel explicitly supports -- see EscalationMiniBar's
                      own note). A reader on a phone reads this once, ahead
                      of every bar in the tab, rather than never. */}
                  <div className="notable-section">
                    Bars: hatched = flat 7-day baseline &middot; solid = last 24h (not a real daily history)
                  </div>
                  {paged(escalationZones).map((z) => <EscalationRow key={z.region} zone={z} onLocate={onLocate} />)}
                </>
              ) : (
                <div className="notable-empty">{escalationEmptyMessage(scope)}</div>
              )
            )}

            {activeTab === "activity" && (
              activityItems.length ? (
                <TabList
                  items={paged(activityItems)} groupBy={groupBy} tabKind="events" Row={ActivityRow}
                  rowKey={(i) => `${i.feed}:${i.id || i.source_url || i.event_id || i.published_at}`}
                  onLocate={onLocate} onOpenRecord={onOpenRecord}
                />
              ) : (
                <div className="notable-empty">
                  {chip === "all"
                    ? activityEmptyMessage(scope)
                    : `Nothing in the ${chip} category in the current window. Clear the filter to see the rest.`}
                </div>
              )
            )}

            {activeTab === "events" && (
              chippedEventItems.length ? (
                <TabList
                  items={paged(chippedEventItems)} groupBy={groupBy} tabKind="events" Row={EventRow}
                  rowKey={(e) => e.id} onLocate={onLocate} onOpenRecord={onOpenRecord}
                />
              ) : (
                <div className="notable-empty">
                  {chip === "all"
                    ? eventsEmptyMessage(scope)
                    : `Nothing in the ${chip} category clears the significance bar right now. Clear the filter to see the rest.`}
                </div>
              )
            )}

            {activeTab === "news" && (
              newsItems.length ? (
                <TabList
                  items={paged(newsItems)} groupBy={groupBy} tabKind="news" Row={NewsRow}
                  rowKey={(i) => i.source_url || i.event_id} onLocate={onLocate} onOpenRecord={onOpenRecord}
                />
              ) : (
                <div className="notable-empty">{newsEmptyMessage(scope)}</div>
              )
            )}

            {activeTab === "officials" && (
              officialsItems.length ? (
                <TabList
                  items={paged(officialsItems)} groupBy={groupBy} tabKind="officials" Row={OfficialsRow}
                  rowKey={(i) => i.id || `${i.published_at}|${i.lat}|${i.lon}`} onLocate={onLocate} onOpenRecord={onOpenRecord}
                />
              ) : (
                <div className="notable-empty">{officialsEmptyMessage(scope)}</div>
              )
            )}

            {/* The board's own body, unchanged -- see its `asTab` prop. It
                brings its own polling and its own empty/loading states, and it
                is deliberately not scoped or windowed by this rail's controls:
                what it covers is the whole live AIS/ADS-B feed, which its own
                caption says in as many words. */}
            {activeTab === "sanctions" && sanctionsTab}

            {/* The reveal sentinel, and also a button.
                Rendered only while there is something left, so a fully revealed
                list is not carrying an observer that fires on every scroll to the
                bottom. It says how many are left rather than being an invisible
                1px tripwire: a reader who has reached row 40 of 334 should be
                able to see that the list continues.
                A button rather than a bare div because scrolling cannot be the
                only way through. Keyboard and screen-reader readers never trip an
                IntersectionObserver, and an observer that does not fire -- for any
                reason -- would otherwise strand everyone at row 40 with no
                affordance and nothing to suggest one exists. */}
            {moreToReveal && (
              <button
                type="button"
                className="intel-more"
                ref={sentinelRef}
                onClick={() => setPages((prev) => prev + 1)}
              >
                Show more &middot; {activeItems.length - visibleCount(activeItems.length, pages)} left
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
