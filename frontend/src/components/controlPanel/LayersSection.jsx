import { SVG, OFFICIALS_KIND_ICON } from "../../map/svgIcons";
import {
  SATELLITE_STYLE, INFRA_STYLE, MILITARY_SUBTYPE_STYLE, PIPELINE_ROUTE_COLOR,
  MILITARY_ROLE_STYLE, MILITARY_ROLE_ORDER, HAZARD_STYLE, HAZARD_KIND_ORDER,
  AIRCRAFT_FLAG_STYLE, AIRCRAFT_FLAG_ORDER, AIRFIELD_STYLE, AIRFIELD_ORDER, AIRFIELD_MILITARY_STYLE,
  SANCTION_COLOR, DARK_VESSEL_STYLE, DARK_VESSEL_ORDER, CABLE_LANDING_STYLE, CABLE_PLANNED_STYLE,
  LAUNCH_STYLE, LAUNCH_ORDER, OSM_INFRA_STYLE, OSM_INFRA_ORDER, OUTAGE_STYLE,
} from "../../map/decorators";
import { SEVERITY_BANDS, CORROBORATED_COLOR, CONFIDENCE_THRESHOLD } from "../../map/severity";
import LayerIcon from "./LayerIcon";
import { PanelGroup, LayerDetails } from "./Collapsible";

// What each conflict glyph means. Drawn from the same SVG table the map pins
// use, so a shape can never appear in one place and not the other.
const EVENT_TYPE_LEGEND = [
  [SVG.airstrike, "Air strike"],
  [SVG.artillery, "Artillery / shelling"],
  [SVG.droneStrike, "Drone strike"],
  [SVG.smallArms, "Small-arms fire"],
  [SVG.blast, "Bombing / IED"],
  [SVG.clash, "Armed clash"],
  [SVG.civilianHarm, "Violence against civilians"],
  [SVG.abduction, "Abduction / hostage-taking"],
  [SVG.occupation, "Territory taken"],
  [SVG.siege, "Siege / blockade"],
  [SVG.riot, "Riot"],
  [SVG.protest, "Protest"],
  [SVG.unknownViolence, "Violence, kind unspecified"],
];

// The Officials & Diplomacy glyphs, read from the same table the map uses
// (OFFICIALS_KIND_ICON) with the same two-colour scheme decorators.js applies:
// cool for cooperative acts, warm for hostile ones. The colour describes the
// act's direction, not whether it is good -- a signed arms deal is teal.
const OFFICIALS_COOPERATIVE = "#7ee0c9";
const OFFICIALS_HOSTILE = "#ff9500";
const OFFICIALS_NEUTRAL = "#c9b6ff";
const OFFICIALS_LEGEND = [
  [OFFICIALS_KIND_ICON.meeting, "Meeting, call or visit", OFFICIALS_COOPERATIVE],
  [OFFICIALS_KIND_ICON.agreement, "Agreement / de-escalation", OFFICIALS_COOPERATIVE],
  [OFFICIALS_KIND_ICON.aid, "Aid or support", OFFICIALS_COOPERATIVE],
  [OFFICIALS_KIND_ICON.statement, "Statement or remarks", OFFICIALS_NEUTRAL],
  [OFFICIALS_KIND_ICON.demand, "Demand or condemnation", OFFICIALS_HOSTILE],
  [OFFICIALS_KIND_ICON.threat, "Threat or ultimatum", OFFICIALS_HOSTILE],
  [OFFICIALS_KIND_ICON.rupture, "Sanctions / ties cut", OFFICIALS_HOSTILE],
  [OFFICIALS_KIND_ICON.posture, "Force posture", OFFICIALS_HOSTILE],
];

// Per-type sub-ticker rows. The swatch is the real glyph in the real colour,
// read straight from INFRA_STYLE/MILITARY_SUBTYPE_STYLE, because the previous
// hand-written colour squares had drifted a whole row out of step against the
// map: only Refineries matched.
// The spread comes first so the row's own `label` wins over INFRA_STYLE's
// singular map-popup wording ("Refinery" vs "Oil Refineries").
const INFRA_ROWS = [
  // Military bases roll seven differently-coloured subtypes into one row, so
  // this glyph deliberately inherits the panel's text colour rather than
  // picking one subtype's colour and implying it stands for all of them. The
  // per-subtype colours are in the legend directly below the list.
  { key: "infraMilitary", label: "Military Bases", svg: SVG.armyBase, color: "currentColor" },
  { ...INFRA_STYLE.refinery, key: "infraRefinery", label: "Oil Refineries" },
  { ...INFRA_STYLE.lng_terminal, key: "infraLng", label: "LNG Terminals" },
  { ...INFRA_STYLE.port, key: "infraPort", label: "Ports & Naval Terminals" },
  { ...INFRA_STYLE.desalination, key: "infraDesalination", label: "Desalination Plants" },
  { ...INFRA_STYLE.nuclear, key: "infraNuclear", label: "Nuclear Facilities" },
  { ...INFRA_STYLE.fab, key: "infraFab", label: "Semiconductor Fabs" },
  { ...INFRA_STYLE.pipeline, key: "infraPipelineNode", label: "Pipeline Nodes" },
  // Shares the pipeline node's palette token, same as the routes themselves do
  // on the map (see pipelineRouteColor in decorators.js).
  { key: "pipelineRoutes", label: "Pipeline Routes", svg: SVG.pipeline, color: PIPELINE_ROUTE_COLOR, token: "infra.pipeline" },
];

const MILITARY_SUBTYPE_ORDER = ["air", "naval", "army", "missile", "joint", "logistics", "radar"];

// How many of a group's layers are currently on, shown on the group's own
// heading so a collapsed group still reports whether it is doing anything.
function activeCount(layerVisibility, keys) {
  return keys.filter((k) => layerVisibility[k]).length;
}

// `gdelt` is deliberately absent: news is a sub-ticker of Conflict & Violence,
// not a layer in its own right, and the group heading counts layers.
const GROUP_LAYERS = {
  conflict: ["events", "conflictHistory", "officials"],
  traffic: ["aisNavy", "aisTanker", "aisCivilian", "darkVessels", "adsbMilitary", "adsbCivilian", "adsbFlagged"],
  // Airfields sit with infrastructure rather than with the aircraft layers:
  // it is a place layer, and the aircraft that need it already get their
  // nearest field named inside their own popup.
  ground: ["infra", "osmInfra", "airports", "cables", "firms", "jamming"],
  hazards: ["hazards"],
  space: ["satellites", "launches"],
};

// Per-kind rows under the hazards toggle. Same "the swatch is the real glyph"
// discipline as INFRA_ROWS above -- read from the map's own table, and left in
// the panel's text colour because the map colours these by severity, not by
// kind (see decorateHazard).
const HAZARD_ROWS = HAZARD_KIND_ORDER.map((kind) => ({
  key: kind,
  countKey: kind === "volcano" ? "hazardsVolcano" : "hazardsQuake",
  ...HAZARD_STYLE[kind],
}));

export default function LayersSection({
  counts, zoomNotes, layerVisibility, onToggleLayer, infraFilterText, onInfraFilterChange,
  eventFilter, onEventFilterChange, historyAsOf,
  // See Collapsible.jsx: defaulted so a half-applied hot reload cannot take the
  // whole panel down through the error boundary.
  isOpen = () => true, setOpen = () => {},
}) {
  const groupCount = (id) => `${activeCount(layerVisibility, GROUP_LAYERS[id])}/${GROUP_LAYERS[id].length}`;

  return (
    <>
      <h2>Layers</h2>

      <PanelGroup id="grp-conflict" title="Conflict & Events" count={groupCount("conflict")}
        open={isOpen("grp-conflict")} onToggle={setOpen}>
        <label className="layer-row" data-layer="events">
          <input
            type="checkbox"
            checked={layerVisibility.events}
            onChange={(e) => onToggleLayer("events", e.target.checked)}
          />
          <LayerIcon svg={SVG.clash} color="#ff3b30" token="severity.critical" /> Conflict &amp; Violence (ACLED + UCDP + GDELT)
          <span className="count">{counts.events} ({counts.eventsTotal})</span>
        </label>

        {/* News is the same incidents one step short of being fused into a pin
            -- the leftovers no conflict or officials record absorbed -- so it
            reads as a sub-ticker of this layer rather than a layer of its own.
            Switching Conflict & Violence off takes the news with it (see
            setLayerVisible in createMapController.js). */}
        <label className="layer-row sub-row" data-layer="gdelt">
          <input
            type="checkbox"
            checked={layerVisibility.gdelt}
            onChange={(e) => onToggleLayer("gdelt", e.target.checked)}
          />
          <LayerIcon svg={SVG.news} color="#ffd60a" token="news.pin" /> Show news reports (GDELT)
          <span className="count">{counts.gdelt} ({counts.gdeltTotal})</span>
        </label>
        <div id="gdeltZoomNote" className={`sublegend${zoomNotes.gdelt ? " visible" : ""}`}>
          Zoom in to show news
        </div>

        {/* The window/severity selects stay outside the fold: they are controls,
            not reference, and burying a control is how a panel gets worse. */}
        <div className="event-filters">
          {/* Whole dates, not hours. Every source behind this layer dates
              events to the day and nothing finer (see event_fusion.py's
              _parse_gdelt_dt and _parse_structured_dt), so an hours-based
              window was a control the data could not honour: "last 6 hours"
              excluded every ACLED/UCDP event unless the UTC hour happened to
              be under 6. */}
          <label>
            Window
            <select
              value={eventFilter.maxAgeDays ?? "all"}
              onChange={(e) => onEventFilterChange({
                maxAgeDays: e.target.value === "all" ? null : Number(e.target.value),
              })}
            >
              <option value="0">Today</option>
              <option value="1">Last 2 days</option>
              <option value="2">Last 3 days</option>
              <option value="all">All available</option>
            </select>
          </label>
          <label>
            Minimum severity
            <select
              value={eventFilter.minSeverity}
              onChange={(e) => onEventFilterChange({ minSeverity: Number(e.target.value) })}
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
              checked={eventFilter.showImprecise}
              onChange={(e) => onEventFilterChange({ showImprecise: e.target.checked })}
            />
            Show approximate locations
          </label>
          {/* Fades rather than hides, which is why it is a separate control
              from the one above rather than another value on it. Nearly every
              event scores below the threshold (the backend checks a coordinate
              only when the reporting gives it something to check against), so
              hiding on this would empty the layer and read as a broken feed
              instead of as an answer. */}
          <label className="event-filter-check">
            <input
              type="checkbox"
              checked={eventFilter.minConfidence >= CONFIDENCE_THRESHOLD}
              onChange={(e) => onEventFilterChange({
                minConfidence: e.target.checked ? CONFIDENCE_THRESHOLD : 0,
              })}
            />
            Fade weakly-placed events
          </label>
        </div>

        {/* Where each pin's *coordinate* stands, as opposed to how severe or
            how well-sourced the event is. Totals, not the on-screen count: this
            answers "what is this layer made of", which does not change as the
            reader pans. Kept out of the fold because the answer is lopsided and
            a reader who never opens the details would otherwise never learn it. */}
        {counts.eventsTotal > 0 && (
          <div className="sublegend placement-tally">
            <span>
              {`Placement: ${counts.eventsVerifiedTotal || 0} verified · `
                + `${counts.eventsDoubtedTotal || 0} doubted · `
                + `${counts.eventsUnverifiedTotal || 0} unchecked`}
            </span>
          </div>
        )}

        <div id="conflictZoomNote" className={`sublegend${zoomNotes.events ? " visible" : ""}`}>
          Zoom in to show conflict events
        </div>

        {/* Why the drawn count can sit far below the backend total. The cap is
            deliberate (see capBySeverity), but applying it silently is what
            made a thinned layer read as a broken one. Gated on the layer being
            on as well as capped: the controller keeps rendering (and so keeps
            capping) a layer that has been removed from the map, and a note
            about pins nobody can see explains nothing. */}
        <div
          id="conflictCapNote"
          className={`sublegend${layerVisibility.events && zoomNotes.eventsCapped ? " visible" : ""}`}
        >
          Showing the {zoomNotes.eventsCapped} most severe here &mdash; zoom in for the rest.
        </div>

        <LayerDetails id="det-events" open={isOpen("det-events")} onToggle={setOpen}>
          <div className="sublegend">
            ACLED (where an account is configured) + UCDP GED Candidate + GDELT, cross-referenced and merged
            into one pin per real incident. <b>Violence only</b> &mdash; armed clashes, assaults and mass
            violence; verbal and diplomatic conflict (accusations, demands, threats) is excluded here and
            has its own layer, Officials &amp; Diplomacy, below. Pin size and colour follow severity; blue
            means independently corroborated. Pins fade as they age. The backend keeps roughly the last
            three days; <b>Window</b> above narrows that further and defaults to showing all of it. Events
            are dated to the day by every source here, so the window counts whole dates rather than hours.
            Where a pin absorbed the news coverage of its incident, the headlines are listed inside it.
          </div>
          <div className="sublegend">
            {SEVERITY_BANDS.map((band) => (
              <span key={band.key}><LayerIcon svg={SVG.clash} color={band.color} token={band.token} />{band.label}</span>
            ))}
            <span><LayerIcon svg={SVG.clash} color={CORROBORATED_COLOR} token="event.corroborated" />Corroborated</span>
          </div>
          <div className="sublegend">Colour is severity; the shape is what happened.</div>
          <div className="sublegend event-type-legend">
            {EVENT_TYPE_LEGEND.map(([svg, label]) => (
              <span key={label}><LayerIcon svg={svg} color="#ff9500" />{label}</span>
            ))}
          </div>
          <div className="sublegend">
            <span className="imprecise-swatch" /> Dashed ring &mdash; don&rsquo;t read this dot as a
            location: either it is only a country or region centroid, or the reporting names
            somewhere else and the position is contested. The pin is never moved to settle that
            &mdash; open it for what was checked and why.
          </div>
          <div className="sublegend">
            <LayerIcon svg={SVG.news} color="#ffd60a" token="news.pin" />
            <b>Show news reports</b> adds the coverage no pin above absorbed &mdash; headlines from vetted
            outlets only, for the last 24 hours, on their own fixed window rather than the one selected
            above. Older stories fade rather than disappear. Where several land on the same spot they share
            one pin showing how many &mdash; click it for the list, or zoom in to separate them.
          </div>
          <div className="sublegend">
            A headline already shown as a Conflict &amp; Violence or Officials pin is not drawn twice: it
            appears inside that pin's own popup instead, under "Coverage".
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="conflictHistory">
          <input
            type="checkbox"
            checked={layerVisibility.conflictHistory}
            onChange={(e) => onToggleLayer("conflictHistory", e.target.checked)}
          />
          <LayerIcon svg={SVG.recordMark} color="#8f9bb3" token="event.history" /> Verified record (UCDP)
          <span className="count">{counts.conflictHistory} ({counts.conflictHistoryTotal})</span>
        </label>
        <div id="historyZoomNote" className={`sublegend${zoomNotes.conflictHistory ? " visible" : ""}`}>
          Zoom in to show the verified record
        </div>
        <LayerDetails id="det-history" open={isOpen("det-history")} onToggle={setOpen}>
          <div className="sublegend">
            UCDP GED Candidate &mdash; peer-reviewed conflict deaths, the most rigorous dataset available
            without a paid key. <b>Not live:</b> it lags real time by a month or more{historyAsOf ? `, currently complete to ${historyAsOf}` : ""}.
            Drawn hollow and grey so it can never be mistaken for a current report. Off by default.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="officials">
          <input
            type="checkbox"
            checked={layerVisibility.officials}
            onChange={(e) => onToggleLayer("officials", e.target.checked)}
          />
          <LayerIcon svg={SVG.handshake} color="#7ee0c9" token="officials.cooperative" /> Officials &amp; Diplomacy
          <span className="count">{counts.officials} ({counts.officialsTotal})</span>
        </label>
        <div id="officialsZoomNote" className={`sublegend${zoomNotes.officials ? " visible" : ""}`}>
          Zoom in to show officials &amp; diplomacy
        </div>
        <LayerDetails id="det-officials" open={isOpen("det-officials")} onToggle={setOpen}>
          <div className="sublegend">
            What presidents, foreign ministries and international bodies are saying and doing -- statements,
            calls, state visits, demands, threats, sanctions. Cool glyphs are cooperative acts, warm ones
            hostile.
          </div>
          <div className="legend officials-legend">
            {OFFICIALS_LEGEND.map(([svg, label, color]) => (
              <span className="legend-item" key={label}>
                <LayerIcon svg={svg} color={color} /> {label}
              </span>
            ))}
          </div>
          <div className="sublegend">
            A ringed pin is the government's own press release -- a primary source, published with no
            newsroom in between and not independently verified. Unringed pins are machine-coded from
            vetted reporting, so the actors and the action are inferred from an article's wording rather
            than quoted from it. Every popup says which it is.
          </div>
          <div className="sublegend">
            Where an event was reported only at country level, it is shown at that country's capital and
            says so. Several at one capital share a single pin with a count.
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-traffic" title="Air & Sea Traffic" count={groupCount("traffic")}
        open={isOpen("grp-traffic")} onToggle={setOpen}>
        <label className="layer-row" data-layer="aisNavy">
          <input
            type="checkbox"
            checked={layerVisibility.aisNavy}
            onChange={(e) => onToggleLayer("aisNavy", e.target.checked)}
          />
          <LayerIcon svg={SVG.ship} color="#ffd60a" token="ship.navy" /> Navy &amp; MSC Ships
          <span className="count">{counts.aisNavy} ({counts.aisNavyTotal})</span>
        </label>
        <LayerDetails id="det-aisNavy" open={isOpen("det-aisNavy")} onToggle={setOpen}>
          <div className="sublegend">Identified by AIS ship-type code or USS/USNS naming. Shown at every zoom.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="aisTanker">
          <input
            type="checkbox"
            checked={layerVisibility.aisTanker}
            onChange={(e) => onToggleLayer("aisTanker", e.target.checked)}
          />
          <LayerIcon svg={SVG.tanker} color="#ffb347" token="ship.tanker" /> Oil Tankers
          <span className="count">{counts.aisTanker} ({counts.aisTankerTotal})</span>
        </label>
        <label className="layer-row sub-row" data-layer="aisTankerTrails">
          <input
            type="checkbox"
            checked={layerVisibility.aisTankerTrails}
            onChange={(e) => onToggleLayer("aisTankerTrails", e.target.checked)}
          />
          Show tanker trails
        </label>
        <LayerDetails id="det-aisTanker" open={isOpen("det-aisTanker")} onToggle={setOpen}>
          <div className="sublegend">AIS ship-type code 80-89. Its own ticker, not mixed into Civilian Ships.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="aisCivilian">
          <input
            type="checkbox"
            checked={layerVisibility.aisCivilian}
            onChange={(e) => onToggleLayer("aisCivilian", e.target.checked)}
          />
          <LayerIcon svg={SVG.ship} color="#35c2ff" token="ship.other" /> Civilian Ships (AIS)
          <span className="count">{counts.aisCivilian} ({counts.aisCivilianTotal})</span>
        </label>
        <div id="aisZoomNote" className={`sublegend${zoomNotes.ais ? " visible" : ""}`}>
          Zoom in to show civilian ships
        </div>

        {/* Not a layer -- a count across all three ship classes at once, since a
            designated hull is most often an ordinary cargo ship and the question
            is asked of the whole feed. It has no toggle for that reason: hiding
            it would mean hiding whichever class each vessel belongs to. */}
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.ship + SVG.sanctionRing} color={SANCTION_COLOR} token="sanctions.designated" />
            OFAC-designated vessels
            <span className="count">{counts.aisSanctioned} ({counts.aisSanctionedTotal})</span>
          </div>
        </div>
        <LayerDetails id="det-aisSanctioned" open={isOpen("det-aisSanctioned")} onToggle={setOpen}>
          <div className="sublegend">
            Cross-referenced against the US Treasury's Specially Designated Nationals list, refreshed daily.
            A designated vessel keeps its own glyph and gains a double ring &mdash; a designated tanker is
            still a tanker.
          </div>
          <div className="sublegend">
            Every popup says <b>which identifier matched</b>, and the difference matters: an IMO number is
            permanent and specific to the hull; an MMSI belongs to the radio licence and is reissued on
            reflagging; a call sign is free text the crew typed in. Nothing is ever matched on the vessel's
            name.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="darkVessels">
          <input
            type="checkbox"
            checked={layerVisibility.darkVessels}
            onChange={(e) => onToggleLayer("darkVessels", e.target.checked)}
          />
          <LayerIcon svg={SVG.darkShip} color={DARK_VESSEL_STYLE.ais_gap.color} token={DARK_VESSEL_STYLE.ais_gap.token} />
          {" "}Dark Vessels &amp; Transfers <span className="inferred-tag">inferred</span>
          <span className="count">{counts.darkVessels} ({counts.darkVesselsTotal})</span>
        </label>
        <div className="subticker-list">
          {DARK_VESSEL_ORDER.map((kind) => (
            <div className="subticker-row" key={kind}>
              <LayerIcon svg={DARK_VESSEL_STYLE[kind].svg} color={DARK_VESSEL_STYLE[kind].color} token={DARK_VESSEL_STYLE[kind].token} />
              {DARK_VESSEL_STYLE[kind].label}
              <span className="count">
                {counts[kind === "sts_pair" ? "darkSts" : "darkGaps"]}{" "}
                ({counts[kind === "sts_pair" ? "darkStsTotal" : "darkGapsTotal"]})
              </span>
            </div>
          ))}
        </div>
        <LayerDetails id="det-darkVessels" open={isOpen("det-darkVessels")} onToggle={setOpen}>
          <div className="sublegend">
            The only layer here derived from <b>this map's own recorded history</b> rather than fetched from a
            publisher, and the only one whose evidence is an absence. Both pins are drawn broken, and both
            popups lead with what else could explain the same signature.
          </div>
          <div className="sublegend">
            <b>Went dark</b> &mdash; a vessel stopped reporting for at least {"4"} hours inside one of the
            watched chokepoints, then reappeared. The popup gives the implied speed across the gap: a figure
            no merchant hull can make means the track that came back is not the one that left.
          </div>
          <div className="sublegend">
            <b>Ship-to-ship</b> &mdash; two vessels within 500 m of each other, both at almost zero speed, for
            over an hour, away from any port on the curated list. Moored vessels are excluded.
          </div>
          <div className="sublegend">
            <b>An AIS receiver outage looks identical to a transponder switched off.</b> Gaps spanning a
            measured drop in our own feed are suppressed, but thin coverage offshore is not something that
            check can fix. Treat every pin here as worth a look, never as a finding.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="adsbMilitary">
          <input
            type="checkbox"
            checked={layerVisibility.adsbMilitary}
            onChange={(e) => onToggleLayer("adsbMilitary", e.target.checked)}
          />
          <LayerIcon svg={SVG.planeMilitary} color="#ff4d4d" token="aircraft.military" /> Military Aircraft
          <span className="count">{counts.adsbMilitary} ({counts.adsbMilitaryTotal})</span>
        </label>
        <label className="layer-row sub-row" data-layer="adsbMilitaryTrails">
          <input
            type="checkbox"
            checked={layerVisibility.adsbMilitaryTrails}
            onChange={(e) => onToggleLayer("adsbMilitaryTrails", e.target.checked)}
          />
          Show military aircraft trails
        </label>
        <LayerDetails id="det-adsbMilitary" open={isOpen("det-adsbMilitary")} onToggle={setOpen}>
          <div className="sublegend">Shown at every zoom.</div>
          {/* Driven straight off MILITARY_ROLE_STYLE, so the legend cannot drift
              from what the map draws -- every glyph and colour here used to be
              restated by hand. */}
          <div className="sublegend">
            {MILITARY_ROLE_ORDER.map((role) => (
              <span key={role}>
                <LayerIcon svg={MILITARY_ROLE_STYLE[role].svg} color={MILITARY_ROLE_STYLE[role].color} />
                {MILITARY_ROLE_STYLE[role].label}
              </span>
            ))}
          </div>
          <div className="sublegend">
            Role is inferred from the aircraft type airplanes.live reports &mdash; a best-effort
            read, not a confirmed mission. Aircraft with no type on file keep the plain
            military glyph.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="adsbFlagged">
          <input
            type="checkbox"
            checked={layerVisibility.adsbFlagged}
            onChange={(e) => onToggleLayer("adsbFlagged", e.target.checked)}
          />
          <LayerIcon svg={SVG.planeMilitary + SVG.alertRing} color="#ff1a1a" /> Emergency &amp; Hidden Aircraft
          <span className="count">{counts.adsbFlagged} ({counts.adsbFlaggedTotal})</span>
        </label>
        <div className="subticker-list">
          {AIRCRAFT_FLAG_ORDER.map((flag) => (
            <div className="subticker-row" key={flag}>
              <LayerIcon
                svg={SVG.planeOther + AIRCRAFT_FLAG_STYLE[flag].ring}
                color={AIRCRAFT_FLAG_STYLE[flag].color}
              />
              {AIRCRAFT_FLAG_STYLE[flag].label}
              <span className="count">
                {counts[AIRCRAFT_FLAG_STYLE[flag].countKey]}{" "}
                ({counts[`${AIRCRAFT_FLAG_STYLE[flag].countKey}Total`]})
              </span>
            </div>
          ))}
        </div>
        <LayerDetails id="det-adsbFlagged" open={isOpen("det-adsbFlagged")} onToggle={setOpen}>
          <div className="sublegend">
            Its own always-on layer, at every zoom, because either signal would otherwise be invisible: an
            airliner squawking 7700 would be hidden by the civilian toggle, and a world view would hide it
            anyway. The airframe glyph underneath is unchanged &mdash; the ring is the status, the shape is
            still what it is.
          </div>
          <div className="sublegend">
            <b>Emergency</b> means one of the three reserved transponder codes: 7500 unlawful interference,
            7600 radio failure, 7700 general emergency. Codes get set by mistake and cleared moments later,
            so this is what the aircraft is broadcasting, not a confirmed incident.
          </div>
          <div className="sublegend">
            <b>Display-limited</b> means the operator asked to be limited in public feeds (the FAA's LADD
            programme) or the aircraft is flying under a rotating Privacy ICAO Address. airplanes.live is
            unfiltered and publishes both. It is a fact about the registry entry and says nothing about the
            flight.
          </div>
          <div className="sublegend">
            <b>OFAC-designated</b> means the airframe's tail number appears on the US Treasury's Specially
            Designated Nationals list. Tail numbers are reassigned after a sale, so a match is the airframe
            OFAC named &mdash; not necessarily this operator. An aircraft carrying more than one of these
            counts once, under the most consequential.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="adsbCivilian">
          <input
            type="checkbox"
            checked={layerVisibility.adsbCivilian}
            onChange={(e) => onToggleLayer("adsbCivilian", e.target.checked)}
          />
          <LayerIcon svg={SVG.planeCommercial} color="#d8b9ff" token="aircraft.commercial" /> Civilian Aircraft (ADS-B)
          <span className="count">{counts.adsbCivilian} ({counts.adsbCivilianTotal})</span>
        </label>
        <div id="adsbZoomNote" className={`sublegend${zoomNotes.adsb ? " visible" : ""}`}>
          Zoom in to show civilian aircraft
        </div>
        <LayerDetails id="det-adsbCivilian" open={isOpen("det-adsbCivilian")} onToggle={setOpen}>
          <div className="sublegend">
            <span>
              <LayerIcon svg={SVG.planeCommercial} color="#d8b9ff" token="aircraft.commercial" />Commercial
            </span>
            <span>
              <LayerIcon svg={SVG.helicopter} color="#9be15d" token="aircraft.helicopter" />Helicopter
            </span>
            <span>
              <LayerIcon svg={SVG.planeOther} color="#8aa0ad" token="aircraft.other" />Other/GA
            </span>
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-ground" title="Infrastructure & Environment" count={groupCount("ground")}
        open={isOpen("grp-ground")} onToggle={setOpen}>
        <label className="layer-row" data-layer="infra">
          <input
            type="checkbox"
            checked={layerVisibility.infra}
            onChange={(e) => onToggleLayer("infra", e.target.checked)}
          />
          <LayerIcon svg={SVG.refinery} color="#ff9500" token="infra.refinery" /> Critical Infrastructure
          <span className="count">{counts.infra} ({counts.infraTotal})</span>
        </label>
        {/* Search box and the live per-type counts stay outside the fold --
            both are things a reader operates and watches, not reference. */}
        <input
          type="text"
          className="infra-filter-input"
          placeholder="Filter infrastructure/bases by name..."
          value={infraFilterText}
          onChange={(e) => onInfraFilterChange(e.target.value)}
        />
        <div className="subticker-list">
          {INFRA_ROWS.map((row) => (
            <div className="subticker-row" key={row.key}>
              <LayerIcon svg={row.svg} color={row.color} token={row.token} /> {row.label}
              <span className="count">{counts[row.key]} ({counts[`${row.key}Total`]})</span>
            </div>
          ))}
        </div>
        <LayerDetails id="det-infra" open={isOpen("det-infra")} onToggle={setOpen}>
          <div className="sublegend">
            Publicly documented sites relevant to the selected conflict zone; flares when a nearby event is reported.
          </div>
          <div className="sublegend">
            {MILITARY_SUBTYPE_ORDER.map((subtype) => (
              <span key={subtype}>
                <LayerIcon svg={MILITARY_SUBTYPE_STYLE[subtype].svg} color={MILITARY_SUBTYPE_STYLE[subtype].color} />
                {MILITARY_SUBTYPE_STYLE[subtype].label}
              </span>
            ))}
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="osmInfra">
          <input
            type="checkbox"
            checked={layerVisibility.osmInfra}
            onChange={(e) => onToggleLayer("osmInfra", e.target.checked)}
          />
          <LayerIcon svg={SVG.powerPlant} color={OSM_INFRA_STYLE.power_plant.color} token={OSM_INFRA_STYLE.power_plant.token} />
          {" "}Infrastructure (OpenStreetMap)
          <span className="count">{counts.osmInfra} ({counts.osmInfraTotal})</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.military_area.svg} color={OSM_INFRA_STYLE.military_area.color} token={OSM_INFRA_STYLE.military_area.token} />
            Military sites &amp; airfields
            <span className="count">{counts.osmMilitary} ({counts.osmMilitaryTotal})</span>
          </div>
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.power_plant.svg} color={OSM_INFRA_STYLE.power_plant.color} token={OSM_INFRA_STYLE.power_plant.token} />
            Power plants
            <span className="count">{counts.osmPower} ({counts.osmPowerTotal})</span>
          </div>
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.border_control.svg} color={OSM_INFRA_STYLE.border_control.color} token={OSM_INFRA_STYLE.border_control.token} />
            Border crossings
            <span className="count">{counts.osmBorder} ({counts.osmBorderTotal})</span>
          </div>
        </div>
        <div id="osmInfraZoomNote" className={`sublegend${zoomNotes.osmInfra ? " visible" : ""}`}>
          Zoom in to show OpenStreetMap infrastructure
        </div>
        <LayerDetails id="det-osmInfra" open={isOpen("det-osmInfra")} onToggle={setOpen}>
          <div className="sublegend">
            The wider, noisier picture behind Critical Infrastructure above: thousands of features
            contributed by OpenStreetMap mappers, swept once a day across the conflict theatres only.
          </div>
          <div className="sublegend">
            <b>Kept deliberately separate from the curated list.</b> That one promises coordinates a person
            checked; this one does not, and every popup here names OpenStreetMap so the two can never be
            confused. Where both know the same site, the curated pin keeps its position.
          </div>
          <div className="sublegend">
            Positions are the feature's computed centre, so a large base reads as the middle of its area
            rather than any particular building. Unnamed military polygons are excluded &mdash; they are
            mostly perimeter fragments and were drowning everything else.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="airports">
          <input
            type="checkbox"
            checked={layerVisibility.airports}
            onChange={(e) => onToggleLayer("airports", e.target.checked)}
          />
          <LayerIcon svg={SVG.airfield} color="#7f93a8" token="airfield.civil" /> Airfields (OurAirports)
          <span className="count">{counts.airports} ({counts.airportsTotal})</span>
        </label>
        <div id="airportsZoomNote" className={`sublegend${zoomNotes.airports ? " visible" : ""}`}>
          Zoom in to show airfields
        </div>
        <LayerDetails id="det-airports" open={isOpen("det-airports")} onToggle={setOpen}>
          <div className="sublegend">
            {AIRFIELD_ORDER.map((kind) => (
              <span key={kind}>
                <LayerIcon svg={AIRFIELD_STYLE[kind].svg} color={AIRFIELD_STYLE[kind].color} token={AIRFIELD_STYLE[kind].token} />
                {AIRFIELD_STYLE[kind].label}
              </span>
            ))}
            <span>
              <LayerIcon svg={AIRFIELD_MILITARY_STYLE.svg} color={AIRFIELD_MILITARY_STYLE.color} token={AIRFIELD_MILITARY_STYLE.token} />
              {AIRFIELD_MILITARY_STYLE.label}
            </span>
          </div>
          <div className="sublegend">
            The OurAirports open dataset. Heliports, seaplane bases and closed fields are excluded. Aircraft
            below 10,000 ft, and any on the ground, name their nearest field in their own popup &mdash; you do
            not have to switch this layer on to get that.
          </div>
          <div className="sublegend">
            <b>Military is a reading of the name</b> (&ldquo;Air Base&rdquo;, &ldquo;RAF&rdquo;, &ldquo;AFB&rdquo;
            and similar), not a field in the dataset. It misses civil-named military fields and can over-reach.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="cables">
          <input
            type="checkbox"
            checked={layerVisibility.cables}
            onChange={(e) => onToggleLayer("cables", e.target.checked)}
          />
          <LayerIcon svg={SVG.cableLanding} color={CABLE_LANDING_STYLE.color} token={CABLE_LANDING_STYLE.token} />
          {" "}Submarine Cables
          <span className="count">{counts.cables} ({counts.cablesTotal})</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.cableLanding} color={CABLE_LANDING_STYLE.color} token={CABLE_LANDING_STYLE.token} />
            {CABLE_LANDING_STYLE.label}
            <span className="count">{counts.cableLandings} ({counts.cableLandingsTotal})</span>
          </div>
        </div>
        <div id="cableLandingsZoomNote" className={`sublegend${zoomNotes.cableLandings ? " visible" : ""}`}>
          Zoom in to show cable landing points
        </div>
        <LayerDetails id="det-cables" open={isOpen("det-cables")} onToggle={setOpen}>
          <div className="sublegend">
            Nearly all traffic between continents runs through these, and the places they come ashore are a
            short published list of specific buildings. Routes keep TeleGeography's own per-cable colour;
            landing points appear from zoom 5.
          </div>
          <div className="sublegend">
            <b>Routes are schematic.</b> They show roughly where a cable runs, not its surveyed position on
            the seabed. A <LayerIcon svg={SVG.cableLanding} color={CABLE_PLANNED_STYLE.color} token={CABLE_PLANNED_STYLE.token} />
            {" "}grey landing is <b>planned</b> &mdash; the site is not settled and nothing is there yet.
          </div>
          <div className="sublegend">
            A <LayerIcon svg={SVG.connectivityLoss} color={OUTAGE_STYLE.color} token={OUTAGE_STYLE.token} />
            {" "}pin marks a country whose connectivity has collapsed in the last 24 hours, from IODA
            (Georgia Tech), which also carries a line in that country&apos;s card. That is a
            {" "}<b>country-level</b> measurement: the pin sits at the middle of the country because the layer
            has to draw somewhere, and says nothing about where inside it the network went away.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="firms">
          <input
            type="checkbox"
            checked={layerVisibility.firms}
            onChange={(e) => onToggleLayer("firms", e.target.checked)}
          />
          <LayerIcon svg={SVG.fire} color="#ff9500" /> Fires / Thermal Anomalies (FIRMS)
          <span className="count">{counts.firms} ({counts.firmsTotal})</span>
        </label>
        <div id="firmsZoomNote" className={`sublegend${zoomNotes.firms ? " visible" : ""}`}>
          Zoom in to inspect individual fire points
        </div>
        <LayerDetails id="det-firms" open={isOpen("det-firms")} onToggle={setOpen}>
          <div className="sublegend">Heat intensity = Fire Radiative Power (FRP). Click a point for detail.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="jamming">
          <input
            type="checkbox"
            checked={layerVisibility.jamming}
            onChange={(e) => onToggleLayer("jamming", e.target.checked)}
          />
          <LayerIcon svg={SVG.jammingSignal} color="#b833e0" /> GPS/Radio Jamming (GPSJam)
          <span className="count">{counts.jamming} ({counts.jammingTotal})</span>
        </label>
        <div id="jammingZoomNote" className={`sublegend${zoomNotes.jamming ? " visible" : ""}`}>
          Zoom in to inspect individual cells
        </div>
        <LayerDetails id="det-jamming" open={isOpen("det-jamming")} onToggle={setOpen}>
          <div className="sublegend">
            Data: gpsjam.org, derived from ADS-B aircraft GPS-quality reports. Updated once/day, not real-time.
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-hazards" title="Natural Hazards" count={groupCount("hazards")}
        open={isOpen("grp-hazards")} onToggle={setOpen}>
        <label className="layer-row" data-layer="hazards">
          <input
            type="checkbox"
            checked={layerVisibility.hazards}
            onChange={(e) => onToggleLayer("hazards", e.target.checked)}
          />
          <LayerIcon svg={SVG.earthquake} color="currentColor" /> Earthquakes &amp; Volcanoes
          <span className="count">{counts.hazards} ({counts.hazardsTotal})</span>
        </label>
        <div className="subticker-list">
          {HAZARD_ROWS.map((row) => (
            <div className="subticker-row" key={row.key}>
              <LayerIcon svg={row.svg} color="currentColor" /> {row.label}
              <span className="count">{counts[row.countKey]} ({counts[`${row.countKey}Total`]})</span>
            </div>
          ))}
        </div>
        <div id="hazardsZoomNote" className={`sublegend${zoomNotes.hazards ? " visible" : ""}`}>
          Zoom in to show natural hazards
        </div>
        <LayerDetails id="det-hazards" open={isOpen("det-hazards")} onToggle={setOpen}>
          <div className="sublegend">
            Earthquakes of magnitude 2.5 and above over the past 24 hours, from the USGS feed, refreshed
            every few minutes. Colour and size follow the same severity scale the conflict layer uses:
            where USGS has issued a <b>PAGER</b> impact alert it drives the colour, otherwise magnitude
            does &mdash; every popup says which.
          </div>
          <div className="sublegend">
            {SEVERITY_BANDS.map((band) => (
              <span key={band.key}><LayerIcon svg={SVG.earthquake} color={band.color} token={band.token} />{band.label}</span>
            ))}
          </div>
          <div className="sublegend">
            Volcanic activity comes from the Smithsonian Global Volcanism Program's <b>weekly</b> report,
            issued each Thursday with the USGS. A volcano pin describes a week, not this moment, and says
            so &mdash; it is not a live sensor reading. Reports published without a coordinate are dropped
            rather than placed by guesswork.
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-space" title="Space" count={groupCount("space")}
        open={isOpen("grp-space")} onToggle={setOpen}>
        <label className="layer-row" data-layer="satellites">
          <input
            type="checkbox"
            checked={layerVisibility.satellites}
            onChange={(e) => onToggleLayer("satellites", e.target.checked)}
          />
          <LayerIcon svg={SVG.satellite} color="#6fe3ff" token="satellite.stations" /> Satellites (stations + military)
          <span className="count">{counts.satellites} ({counts.satellitesTotal})</span>
        </label>
        <label className="layer-row sub-row" data-layer="satellitesMilitary">
          <input
            type="checkbox"
            checked={layerVisibility.satellitesMilitary}
            onChange={(e) => onToggleLayer("satellitesMilitary", e.target.checked)}
          />
          Show military satellites
        </label>
        <label className="layer-row sub-row" data-layer="satellitesTrails">
          <input
            type="checkbox"
            checked={layerVisibility.satellitesTrails}
            onChange={(e) => onToggleLayer("satellitesTrails", e.target.checked)}
          />
          Show satellite trails
        </label>
        <LayerDetails id="det-satellites" open={isOpen("det-satellites")} onToggle={setOpen}>
          <div className="sublegend">
            Position computed via SGP4 from CelesTrak's public orbital elements. Always shown, any zoom.
          </div>
          <div className="sublegend">
            <span>
              <LayerIcon svg={SATELLITE_STYLE.stations.svg} color={SATELLITE_STYLE.stations.color} token={SATELLITE_STYLE.stations.token} />Station
            </span>
            <span>
              <LayerIcon svg={SATELLITE_STYLE.military.svg} color={SATELLITE_STYLE.military.color} token={SATELLITE_STYLE.military.token} />Military
            </span>
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="launches">
          <input
            type="checkbox"
            checked={layerVisibility.launches}
            onChange={(e) => onToggleLayer("launches", e.target.checked)}
          />
          <LayerIcon svg={SVG.launchPad} color={LAUNCH_STYLE.upcoming.color} token={LAUNCH_STYLE.upcoming.token} />
          {" "}Orbital Launches
          <span className="count">{counts.launches} ({counts.launchesTotal})</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.launchPad} color={LAUNCH_STYLE.upcoming.color} token={LAUNCH_STYLE.upcoming.token} />
            Still to come
            <span className="count">{counts.launchesUpcoming} ({counts.launchesUpcomingTotal})</span>
          </div>
        </div>
        <LayerDetails id="det-launches" open={isOpen("det-launches")} onToggle={setOpen}>
          <div className="sublegend">
            Drawn at the pad, not in flight &mdash; this marks a place on the ground. Where the objects in the
            satellite layer above came from, and where the next ones go up.
          </div>
          <div className="sublegend">
            {LAUNCH_ORDER.map((key) => (
              <span key={key}>
                <LayerIcon svg={LAUNCH_STYLE[key].svg} color={LAUNCH_STYLE[key].color} token={LAUNCH_STYLE[key].token} />
                {LAUNCH_STYLE[key].label}
              </span>
            ))}
          </div>
          <div className="sublegend">
            A countdown is only shown where the provider has committed to a time <b>to the hour or better</b>.
            Anything looser reads as &ldquo;no earlier than&rdquo;, because scheduled dates weeks out routinely
            move. Data: Launch Library 2 (The Space Devs).
          </div>
        </LayerDetails>
      </PanelGroup>
    </>
  );
}
