import { SVG, OFFICIALS_KIND_ICON } from "../../map/svgIcons";
import {
  SATELLITE_STYLE, INFRA_STYLE, MILITARY_SUBTYPE_STYLE, PIPELINE_ROUTE_COLOR,
  MILITARY_ROLE_STYLE, MILITARY_ROLE_ORDER, HAZARD_STYLE, HAZARD_KIND_ORDER,
  AIRCRAFT_FLAG_STYLE, AIRCRAFT_FLAG_ORDER, AIRFIELD_STYLE, AIRFIELD_ORDER, AIRFIELD_MILITARY_STYLE,
  SANCTION_COLOR, DARK_VESSEL_STYLE, DARK_VESSEL_ORDER, CABLE_LANDING_STYLE, CABLE_PLANNED_STYLE,
  LAUNCH_STYLE, LAUNCH_ORDER, OSM_INFRA_STYLE, OSM_INFRA_ORDER, OUTAGE_STYLE,
  GFW_GAP_STYLE, GFW_DETECTION_STYLE, GFW_DETECTION_ORDER,
  CZIB_STYLE, CZIB_ORDER, FLOOD_STYLE, PORT_STYLE, DAM_STYLE, DEFLOCK_STYLE, RAILWAY_STYLE,
} from "../../map/decorators";
import { SEVERITY_BANDS, CORROBORATED_COLOR, CONFIDENCE_THRESHOLD } from "../../map/severity";
import LayerIcon from "./LayerIcon";
import LayerCheck from "./LayerCheck";
import { PanelGroup, LayerDetails } from "./Collapsible";
import CountUp from "../CountUp";

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
  // The two GFW layers sit directly after darkVessels: same subject, different
  // publisher, and a reader comparing this map's inference against somebody
  // else's record should not have to hunt for the second one.
  traffic: [
    "aisNavy", "aisTanker", "aisCivilian", "aisDigitraffic", "darkVessels", "gfwGaps", "gfwDetections",
    "adsbMilitary", "adsbCivilian", "adsbFlagged",
  ],
  // Airfields sit with infrastructure rather than with the aircraft layers:
  // it is a place layer, and the aircraft that need it already get their
  // nearest field named inside their own popup.
  ground: ["infra", "osmInfra", "airports", "ports", "dams", "deflock", "railways", "cables", "firms", "jamming"],
  // Its own group rather than a ninth row under traffic: a regulator's ruling
  // about a volume of airspace is neither traffic nor infrastructure, and
  // traffic already carries nine layers.
  airspace: ["czib"],
  hazards: ["hazards", "floods"],
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

// Short names for the cap note above. Only the layers that declare a cap in
// map/scene.js need one; anything else falls back to its key, which is ugly but
// never wrong, and is the signal that a layer gained a cap without gaining a
// name here.
const LAYER_LABEL = {
  gdelt: "News", officials: "Officials", conflictHistory: "UCDP record",
  hazards: "Earthquakes & volcanoes", floods: "Floods", airports: "Airfields",
  cities: "Cities", dams: "Dams", ports: "Ports", osmInfra: "OSM infrastructure",
  gfwGaps: "AIS disabling", gfwDetections: "Vessel detections",
  aisCivilian: "Civilian ships", adsbCivilian: "Civilian aircraft",
  aisDigitraffic: "Baltic ships",
};

export default function LayersSection({
  counts, zoomNotes, layerVisibility, layerWish, onToggleLayer, infraFilterText, onInfraFilterChange,
  eventFilter, onEventFilterChange, historyAsOf,
  // See Collapsible.jsx: defaulted so a half-applied hot reload cannot take the
  // whole panel down through the error boundary.
  isOpen = () => true, setOpen = () => {},
}) {
  const groupCount = (id) => `${activeCount(layerVisibility, GROUP_LAYERS[id])}/${GROUP_LAYERS[id].length}`;

  // Every layer the band cap is currently thinning, other than events -- that
  // one keeps its own note beside its own row, where it has always been.
  //
  // The cap used to apply to events alone, so one note covered it. Now that any
  // layer can declare one, a layer quietly showing a fraction of its own count
  // would be back to reading as broken -- which is the exact failure the events
  // note was written to prevent. Listed rather than repeated per row: an
  // operator wants to know *that* something is thinned and which, and the
  // per-layer count is already in the ticker next to it.
  const cappedElsewhere = Object.entries(zoomNotes.capped || {})
    .filter(([key, n]) => key !== "events" && n && layerVisibility[key])
    .map(([key, n]) => `${LAYER_LABEL[key] || key} (${n})`);

  return (
    <>
      <h2>Layers</h2>

      <div className={`sublegend${cappedElsewhere.length ? " visible" : ""}`}>
        Thinned to the most significant at this zoom: {cappedElsewhere.join(", ")}.
        Zoom in for the rest.
      </div>

      <PanelGroup id="grp-conflict" title="Conflict & Events" count={groupCount("conflict")}
        open={isOpen("grp-conflict")} onToggle={setOpen}>
        <label className="layer-row" data-layer="events">
          <LayerCheck
            layerKey="events"
            on={layerVisibility.events}
            wish={layerWish?.events}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.clash} color="#ff3b30" token="severity.critical" /> Conflict &amp; Violence (ACLED + UCDP + GDELT)
          <span className="count"><CountUp value={counts.events} /> (<CountUp value={counts.eventsTotal} />)</span>
        </label>

        {/* News is the same incidents one step short of being fused into a pin
            -- the leftovers no conflict or officials record absorbed -- so it
            reads as a sub-ticker of this layer rather than a layer of its own.
            Switching Conflict & Violence off takes the news with it (see
            setLayerVisible in createMapController.js). */}
        <label className="layer-row sub-row" data-layer="gdelt">
          <LayerCheck
            layerKey="gdelt"
            on={layerVisibility.gdelt}
            wish={layerWish?.gdelt}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.news} color="#ffd60a" token="news.pin" /> Show news reports (GDELT)
          <span className="count"><CountUp value={counts.gdelt} /> (<CountUp value={counts.gdeltTotal} />)</span>
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
          <LayerCheck
            layerKey="conflictHistory"
            on={layerVisibility.conflictHistory}
            wish={layerWish?.conflictHistory}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.recordMark} color="#8f9bb3" token="event.history" /> Verified record (UCDP)
          <span className="count"><CountUp value={counts.conflictHistory} /> (<CountUp value={counts.conflictHistoryTotal} />)</span>
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
          <LayerCheck
            layerKey="officials"
            on={layerVisibility.officials}
            wish={layerWish?.officials}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.handshake} color="#7ee0c9" token="officials.cooperative" /> Officials &amp; Diplomacy
          <span className="count"><CountUp value={counts.officials} /> (<CountUp value={counts.officialsTotal} />)</span>
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
          <LayerCheck
            layerKey="aisNavy"
            on={layerVisibility.aisNavy}
            wish={layerWish?.aisNavy}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.warship} color="#ffd60a" token="ship.navy" /> Navy &amp; MSC Ships
          <span className="count"><CountUp value={counts.aisNavy} /> (<CountUp value={counts.aisNavyTotal} />)</span>
        </label>
        <LayerDetails id="det-aisNavy" open={isOpen("det-aisNavy")} onToggle={setOpen}>
          <div className="sublegend">Identified by AIS ship-type code or USS/USNS naming. Shown at every zoom.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="aisTanker">
          <LayerCheck
            layerKey="aisTanker"
            on={layerVisibility.aisTanker}
            wish={layerWish?.aisTanker}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.tanker} color="#ffb347" token="ship.tanker" /> Oil Tankers
          <span className="count"><CountUp value={counts.aisTanker} /> (<CountUp value={counts.aisTankerTotal} />)</span>
        </label>
        <label className="layer-row sub-row" data-layer="aisTankerTrails">
          <LayerCheck
            layerKey="aisTankerTrails"
            on={layerVisibility.aisTankerTrails}
            wish={layerWish?.aisTankerTrails}
            onToggle={onToggleLayer}
          />
          Show tanker trails
        </label>
        <LayerDetails id="det-aisTanker" open={isOpen("det-aisTanker")} onToggle={setOpen}>
          <div className="sublegend">AIS ship-type code 80-89. Its own ticker, not mixed into Civilian Ships.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="aisCivilian">
          <LayerCheck
            layerKey="aisCivilian"
            on={layerVisibility.aisCivilian}
            wish={layerWish?.aisCivilian}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.ship} color="#35c2ff" token="ship.other" /> Civilian Ships (AIS)
          <span className="count"><CountUp value={counts.aisCivilian} /> (<CountUp value={counts.aisCivilianTotal} />)</span>
        </label>
        <div id="aisZoomNote" className={`sublegend${zoomNotes.ais ? " visible" : ""}`}>
          Zoom in to show civilian ships
        </div>

        {/* A network, not a ship class -- which is why it sits below the three
            class toggles rather than among them. The three above split one
            global feed by what a hull is; this one is a different set of
            receivers, and its extent is the thing worth saying on the row. */}
        <label className="layer-row" data-layer="aisDigitraffic">
          <LayerCheck
            layerKey="aisDigitraffic"
            on={layerVisibility.aisDigitraffic}
            wish={layerWish?.aisDigitraffic}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.ship} color="#35c2ff" token="ship.other" /> Ships &mdash; Baltic (Fintraffic)
          <span className="count"><CountUp value={counts.aisDigitraffic} /> (<CountUp value={counts.aisDigitrafficTotal} />)</span>
        </label>
        <div id="aisDigitrafficZoomNote" className={`sublegend${zoomNotes.aisDigitraffic ? " visible" : ""}`}>
          Zoom in to show Baltic ships
        </div>
        <LayerDetails id="det-aisDigitraffic" open={isOpen("det-aisDigitraffic")} onToggle={setOpen}>
          <div className="sublegend">
            Fintraffic&apos;s own coastal receivers (digitraffic.fi), Finnish and Baltic waters only &mdash;
            a separate AIS network from the three layers above, so a vessel missing here may simply be
            outside its coverage rather than dark. Warships, tankers and merchantmen are drawn with the
            same glyphs; each popup names the network it was heard by. CC BY 4.0.
          </div>
        </LayerDetails>

        {/* Not a layer -- a count across all three ship classes at once, since a
            designated hull is most often an ordinary cargo ship and the question
            is asked of the whole feed. It has no toggle for that reason: hiding
            it would mean hiding whichever class each vessel belongs to. */}
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.ship + SVG.sanctionRing} color={SANCTION_COLOR} token="sanctions.designated" />
            OFAC-designated vessels
            <span className="count"><CountUp value={counts.aisSanctioned} /> (<CountUp value={counts.aisSanctionedTotal} />)</span>
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
          <LayerCheck
            layerKey="darkVessels"
            on={layerVisibility.darkVessels}
            wish={layerWish?.darkVessels}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.darkShip} color={DARK_VESSEL_STYLE.ais_gap.color} token={DARK_VESSEL_STYLE.ais_gap.token} />
          {" "}Dark Vessels &amp; Transfers <span className="inferred-tag">inferred</span>
          <span className="count"><CountUp value={counts.darkVessels} /> (<CountUp value={counts.darkVesselsTotal} />)</span>
        </label>
        <div className="subticker-list">
          {DARK_VESSEL_ORDER.map((kind) => (
            <div className="subticker-row" key={kind}>
              <LayerIcon svg={DARK_VESSEL_STYLE[kind].svg} color={DARK_VESSEL_STYLE[kind].color} token={DARK_VESSEL_STYLE[kind].token} />
              {DARK_VESSEL_STYLE[kind].label}
              <span className="count">
                <CountUp value={counts[kind === "sts_pair" ? "darkSts" : "darkGaps"]} />{" "}
                (<CountUp value={counts[kind === "sts_pair" ? "darkStsTotal" : "darkGapsTotal"]} />)
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

        <label className="layer-row" data-layer="gfwGaps">
          <LayerCheck
            layerKey="gfwGaps"
            on={layerVisibility.gfwGaps}
            wish={layerWish?.gfwGaps}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={GFW_GAP_STYLE.svg} color={GFW_GAP_STYLE.color} token={GFW_GAP_STYLE.token} />
          {" "}AIS Disabling (Global Fishing Watch) <span className="inferred-tag">GFW&apos;s finding</span>
          <span className="count"><CountUp value={counts.gfwGaps} /> (<CountUp value={counts.gfwGapsTotal} />)</span>
        </label>
        <div id="gfwGapsZoomNote" className={`sublegend${zoomNotes.gfwGaps ? " visible" : ""}`}>
          Zoom in to show AIS disabling events
        </div>
        <LayerDetails id="det-gfwGaps" open={isOpen("det-gfwGaps")} onToggle={setOpen}>
          <div className="sublegend">
            The independent second opinion on Dark Vessels above &mdash; and the reason both exist. That
            layer reads one AIS upstream, so when the upstream stops it does not degrade, it inverts: no
            feed means no gaps means an empty layer that looks like calm water. This one has no such
            coupling.
          </div>
          <div className="sublegend">
            <b>Both claims here are Global Fishing Watch&apos;s.</b> That a transmission stopped, measured
            against <i>their</i> satellite reception; and that the stop was deliberate, inferred by their
            published methodology. This map asserts neither &mdash; it reports that they assert them.
          </div>
          <div className="sublegend">
            <b>Nothing here is current.</b> Every event is five or more days old by the time it arrives,
            which is why the age is on the face of every popup. A gap on this layer and a gap on Dark
            Vessels can never be the same event, and neither confirms the other.
          </div>
          <div className="sublegend">
            Every row in the feed is flagged deliberate, so that flag describes GFW&apos;s inclusion
            criterion rather than singling any one event out. It is not shown as a distinguishing mark.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="gfwDetections">
          <LayerCheck
            layerKey="gfwDetections"
            on={layerVisibility.gfwDetections}
            wish={layerWish?.gfwDetections}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.hullDetection} color={GFW_DETECTION_STYLE.unmatched.color} token={GFW_DETECTION_STYLE.unmatched.token} />
          {" "}Satellite Vessel Detections (GFW)
          <span className="count"><CountUp value={counts.gfwDetections} /> (<CountUp value={counts.gfwDetectionsTotal} />)</span>
        </label>
        <div className="subticker-list">
          {GFW_DETECTION_ORDER.map((kind) => (
            <div className="subticker-row" key={kind}>
              <LayerIcon svg={SVG.hullDetection} color={GFW_DETECTION_STYLE[kind].color} token={GFW_DETECTION_STYLE[kind].token} />
              {GFW_DETECTION_STYLE[kind].label}
              <span className="count">
                <CountUp value={counts[kind === "matched" ? "gfwDetMatched" : "gfwDetUnmatched"]} />{" "}
                (<CountUp value={counts[kind === "matched" ? "gfwDetMatchedTotal" : "gfwDetUnmatchedTotal"]} />)
              </span>
            </div>
          ))}
        </div>
        {/* The only zoom note here that also has to explain a zero *total*.
            This layer's fetch is gated on the same zoom as its drawing, so above
            the gate nothing has been downloaded and the count reads 0 (0) --
            which without this line is indistinguishable from a dead feed. */}
        <div id="gfwDetectionsZoomNote" className={`sublegend${zoomNotes.gfwDetections ? " visible" : ""}`}>
          Zoom in to load satellite vessel detections &mdash; not fetched at this zoom, so the total
          reads zero until you do.
        </div>
        <LayerDetails id="det-gfwDetections" open={isOpen("det-gfwDetections")} onToggle={setOpen}>
          <div className="sublegend">
            The first thing in this map&apos;s maritime stack entitled to say <b>detected</b>. Everything
            else at sea is either a broadcast a vessel chose to make or an inference drawn from the shape of
            what it stopped broadcasting. A radar or optical return is neither &mdash; it is an
            instrument&apos;s reading of a hull, made whether or not anyone aboard wanted it made.
          </div>
          <div className="sublegend">
            <b>Two claims, stacked, and they must not merge.</b> That a hull was at this point at this time
            is a measurement. That it was not broadcasting AIS is Global Fishing Watch&apos;s inference,
            produced by correlating the return against AIS tracks. Every popup keeps them apart and names
            whose is whose.
          </div>
          <div className="sublegend">
            <b>Absence proves nothing here.</b> There is no footprint dataset, so this layer cannot
            distinguish water it looked at and found empty from water it never looked at.
          </div>
          <div className="sublegend">
            Two products share this layer. Optical (Sentinel-2) is currently the live one; the radar (SAR)
            product&apos;s batch has stalled and legitimately publishes nothing. Every record states which
            instrument saw it and how far behind that product was running.
          </div>
          <div className="sublegend">
            Off by default and gated by zoom, because a several-week-old return drawn at world zoom beside
            live ship positions is exactly the confusion this layer risks.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="adsbMilitary">
          <LayerCheck
            layerKey="adsbMilitary"
            on={layerVisibility.adsbMilitary}
            wish={layerWish?.adsbMilitary}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.planeMilitary} color="#ff4d4d" token="aircraft.military" /> Military Aircraft
          <span className="count"><CountUp value={counts.adsbMilitary} /> (<CountUp value={counts.adsbMilitaryTotal} />)</span>
        </label>
        <label className="layer-row sub-row" data-layer="adsbMilitaryTrails">
          <LayerCheck
            layerKey="adsbMilitaryTrails"
            on={layerVisibility.adsbMilitaryTrails}
            wish={layerWish?.adsbMilitaryTrails}
            onToggle={onToggleLayer}
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
          <LayerCheck
            layerKey="adsbFlagged"
            on={layerVisibility.adsbFlagged}
            wish={layerWish?.adsbFlagged}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.planeMilitary + SVG.alertRing} color="#ff1a1a" /> Emergency &amp; Hidden Aircraft
          <span className="count"><CountUp value={counts.adsbFlagged} /> (<CountUp value={counts.adsbFlaggedTotal} />)</span>
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
                <CountUp value={counts[AIRCRAFT_FLAG_STYLE[flag].countKey]} />{" "}
                (<CountUp value={counts[`${AIRCRAFT_FLAG_STYLE[flag].countKey}Total`]} />)
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
          <LayerCheck
            layerKey="adsbCivilian"
            on={layerVisibility.adsbCivilian}
            wish={layerWish?.adsbCivilian}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.planeCommercial} color="#d8b9ff" token="aircraft.commercial" /> Civilian Aircraft (ADS-B)
          <span className="count"><CountUp value={counts.adsbCivilian} /> (<CountUp value={counts.adsbCivilianTotal} />)</span>
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
          <LayerCheck
            layerKey="infra"
            on={layerVisibility.infra}
            wish={layerWish?.infra}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.refinery} color="#ff9500" token="infra.refinery" /> Critical Infrastructure
          <span className="count"><CountUp value={counts.infra} /> (<CountUp value={counts.infraTotal} />)</span>
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
              <span className="count"><CountUp value={counts[row.key]} /> (<CountUp value={counts[`${row.key}Total`]} />)</span>
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
          <LayerCheck
            layerKey="osmInfra"
            on={layerVisibility.osmInfra}
            wish={layerWish?.osmInfra}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.powerPlant} color={OSM_INFRA_STYLE.power_plant.color} token={OSM_INFRA_STYLE.power_plant.token} />
          {" "}Infrastructure (OpenStreetMap)
          <span className="count"><CountUp value={counts.osmInfra} /> (<CountUp value={counts.osmInfraTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.military_area.svg} color={OSM_INFRA_STYLE.military_area.color} token={OSM_INFRA_STYLE.military_area.token} />
            Military sites &amp; airfields
            <span className="count"><CountUp value={counts.osmMilitary} /> (<CountUp value={counts.osmMilitaryTotal} />)</span>
          </div>
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.power_plant.svg} color={OSM_INFRA_STYLE.power_plant.color} token={OSM_INFRA_STYLE.power_plant.token} />
            Power plants
            <span className="count"><CountUp value={counts.osmPower} /> (<CountUp value={counts.osmPowerTotal} />)</span>
          </div>
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.border_control.svg} color={OSM_INFRA_STYLE.border_control.color} token={OSM_INFRA_STYLE.border_control.token} />
            Border crossings
            <span className="count"><CountUp value={counts.osmBorder} /> (<CountUp value={counts.osmBorderTotal} />)</span>
          </div>
          <div className="subticker-row">
            <LayerIcon svg={OSM_INFRA_STYLE.railway_station.svg} color={OSM_INFRA_STYLE.railway_station.color} token={OSM_INFRA_STYLE.railway_station.token} />
            Railways (stations, halts, yards, crossings)
            <span className="count"><CountUp value={counts.osmRailway} /> (<CountUp value={counts.osmRailwayTotal} />)</span>
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
          <div className="sublegend">
            <b>A feature the Airfields or Dams layer already draws is drawn once, there.</b> OpenStreetMap
            maps military airfields OurAirports lists and hydro plants sitting on Global Dam Watch dams;
            three quarters of the OSM military airfields here are one of those. Nothing is discarded
            &mdash; the surviving pin names the OSM record, its own name for the place and how far apart
            the two sources put it. Switch the other layer off and these pins come back.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="airports">
          <LayerCheck
            layerKey="airports"
            on={layerVisibility.airports}
            wish={layerWish?.airports}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.airfield} color="#7f93a8" token="airfield.medium" /> Airfields (OurAirports)
          <span className="count"><CountUp value={counts.airports} /> (<CountUp value={counts.airportsTotal} />)</span>
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

        <label className="layer-row" data-layer="ports">
          <LayerCheck
            layerKey="ports"
            on={layerVisibility.ports}
            wish={layerWish?.ports}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={PORT_STYLE.svg} color={PORT_STYLE.color} token={PORT_STYLE.token} />
          {" "}Ports (NGA World Port Index)
          <span className="count"><CountUp value={counts.ports} /> (<CountUp value={counts.portsTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={PORT_STYLE.svg} color={PORT_STYLE.color} token={PORT_STYLE.token} />
            With an oil terminal
            <span className="count"><CountUp value={counts.portsOil} /> (<CountUp value={counts.portsOilTotal} />)</span>
          </div>
        </div>
        <div id="portsZoomNote" className={`sublegend${zoomNotes.ports ? " visible" : ""}`}>
          Zoom in to show ports
        </div>
        <LayerDetails id="det-ports" open={isOpen("det-ports")} onToggle={setOpen}>
          <div className="sublegend">
            NGA Pub 150 &mdash; every port with its own coordinate, harbour size and type, keyless and in
            the public domain as a work of the US Government. <b>A gazetteer, not a feed:</b> nothing in it
            is an event and nothing in it is current. Pins are sized by NGA&apos;s own coded harbour size.
          </div>
          <div className="sublegend">
            Served clipped to the union of this map&apos;s conflict theatres and the water it actually
            receives AIS from. That second clause is not redundant: ports sitting in watched water and in no
            theatre would otherwise have left the Eastern Mediterranean a coverage hole.
          </div>
          <div className="sublegend">
            <b>This is what stops the Dark Vessels layer guessing.</b> Its ship-to-ship inference is only as
            good as its answer to &ldquo;are these two simply in port&rdquo;, and before this arrived that
            answer came from a few dozen hand-curated harbours.
          </div>
          <div className="sublegend">
            <b>Vintage is stated, not implied.</b> The file carries no publication date of any kind, so this
            map treats it as roughly 2024 reference data and says so on every pin rather than letting a
            fetch timestamp imply freshness.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="dams">
          <LayerCheck
            layerKey="dams"
            on={layerVisibility.dams}
            wish={layerWish?.dams}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={DAM_STYLE.svg} color={DAM_STYLE.color} token={DAM_STYLE.token} />
          {" "}Dams &amp; Reservoirs (Global Dam Watch)
          <span className="count"><CountUp value={counts.dams} /> (<CountUp value={counts.damsTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={DAM_STYLE.svg} color={DAM_STYLE.color} token={DAM_STYLE.token} />
            Holding 100 million m&sup3; or more
            <span className="count"><CountUp value={counts.damsLarge} /> (<CountUp value={counts.damsLargeTotal} />)</span>
          </div>
        </div>
        <div id="damsZoomNote" className={`sublegend${zoomNotes.dams ? " visible" : ""}`}>
          Zoom in to show dams
        </div>
        <LayerDetails id="det-dams" open={isOpen("det-dams")} onToggle={setOpen}>
          <div className="sublegend">
            A dam is infrastructure whose failure is catastrophic downstream and whose deliberate targeting
            is a war crime. The useful record is not &ldquo;a dam is here&rdquo; but &ldquo;a dam is here and
            this is how much it holds&rdquo;, which is why the pins are sized by reservoir capacity and not
            by generation. Served clipped to the conflict theatres rather than worldwide.
          </div>
          <div className="sublegend">
            <b>Most of these coordinates are river snaps.</b> Global Dam Watch publishes a location for the
            structure on only about 15% of its rows; for the rest the point is the river reach the barrier
            regulates. Every popup says which it is, and the snapped ones carry the dashed ring. Nine in ten
            snaps land within 350 m &mdash; but one in the dataset is 92 km out, so the ring is not
            decoration.
          </div>
          <div className="sublegend">
            <b>No severity is assigned.</b> Every other severity on this map comes from something a publisher
            measured. Global Dam Watch publishes nothing of the kind, and deriving &ldquo;how dangerous is
            this dam&rdquo; from its capacity would be this app&apos;s claim dressed up as theirs. The
            capacity is on the pin; the conclusion is the reader&apos;s.
          </div>
          <div className="sublegend">
            Reservoir outlines &mdash; &ldquo;what floods if this fails&rdquo; &mdash; are the natural next
            question and are deliberately not drawn: the answer is tens of megabytes of polygon geometry
            needing a shapefile reader this project does not have.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="deflock">
          <LayerCheck
            layerKey="deflock"
            on={layerVisibility.deflock}
            wish={layerWish?.deflock}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={DEFLOCK_STYLE.svg} color={DEFLOCK_STYLE.color} token={DEFLOCK_STYLE.token} />
          {" "}ALPR Cameras (DeFlock)
          <span className="count"><CountUp value={counts.deflock} /> (<CountUp value={counts.deflockTotal} />)</span>
        </label>
        <div id="deflockZoomNote" className={`sublegend${zoomNotes.deflock ? " visible" : ""}`}>
          Zoom in to show ALPR cameras &mdash; a worldwide layer held back until you are over a town,
          so the total reads zero until you zoom in.
        </div>
        <LayerDetails id="det-deflock" open={isOpen("det-deflock")} onToggle={setOpen}>
          <div className="sublegend">
            Automated licence-plate reader locations &mdash; Flock Safety, Motorola and the rest &mdash;
            as OpenStreetMap has them, mirrored daily by DeFlock. <b>Location metadata only:</b> a pin
            says where a camera stands, not what it sees, and there is nothing to view.
          </div>
          <div className="sublegend">
            <b>Off by default, and only drawn once you are zoomed into a town.</b> The set is ~125,000
            points and 99.78% of them are in the United States, which has no theatre on this map &mdash;
            so it is only meaningfully visible on the unfiltered World view, and never dumped across a
            wide one.
          </div>
          <div className="sublegend">
            <b>The date on a pin is an OpenStreetMap edit time, not a sighting.</b> It is when the map
            object was last changed, not when the camera was seen or installed. Source: OpenStreetMap
            contributors (via DeFlock), ODbL.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="railways">
          <LayerCheck
            layerKey="railways"
            on={layerVisibility.railways}
            wish={layerWish?.railways}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={RAILWAY_STYLE.svg} color={RAILWAY_STYLE.color} token={RAILWAY_STYLE.token} />
          {" "}Railways (Natural Earth)
          <span className="count"><CountUp value={counts.railways} /> (<CountUp value={counts.railwaysTotal} />)</span>
        </label>
        <LayerDetails id="det-railways" open={isOpen("det-railways")} onToggle={setOpen}>
          <div className="sublegend">
            <b>Coarse basemap linework, 2021.</b> Natural Earth 1:10m railroads &mdash; public domain,
            unchanged since 2021, with no names, no operator and no gauge. It is drawn as a muted,
            dashed hairline because it is context, not survey data.
          </div>
          <div className="sublegend">
            <b>It will not sit exactly on the railway station points.</b> Those come from OpenStreetMap
            (the Infrastructure layer above); this linework is a different, coarser source and the two
            are not aligned. Clipped to this map&apos;s conflict theatres rather than drawn worldwide.
          </div>
        </LayerDetails>

        <label className="layer-row" data-layer="cables">
          <LayerCheck
            layerKey="cables"
            on={layerVisibility.cables}
            wish={layerWish?.cables}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.cableLanding} color={CABLE_LANDING_STYLE.color} token={CABLE_LANDING_STYLE.token} />
          {" "}Submarine Cables
          <span className="count"><CountUp value={counts.cables} /> (<CountUp value={counts.cablesTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.cableLanding} color={CABLE_LANDING_STYLE.color} token={CABLE_LANDING_STYLE.token} />
            {CABLE_LANDING_STYLE.label}
            <span className="count"><CountUp value={counts.cableLandings} /> (<CountUp value={counts.cableLandingsTotal} />)</span>
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
          <LayerCheck
            layerKey="firms"
            on={layerVisibility.firms}
            wish={layerWish?.firms}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.fire} color="#ff9500" /> Fires / Thermal Anomalies (FIRMS)
          <span className="count"><CountUp value={counts.firms} /> (<CountUp value={counts.firmsTotal} />)</span>
        </label>
        <div id="firmsZoomNote" className={`sublegend${zoomNotes.firms ? " visible" : ""}`}>
          Zoom in to inspect individual fire points
        </div>
        <LayerDetails id="det-firms" open={isOpen("det-firms")} onToggle={setOpen}>
          <div className="sublegend">Heat intensity = Fire Radiative Power (FRP). Click a point for detail.</div>
        </LayerDetails>

        <label className="layer-row" data-layer="jamming">
          <LayerCheck
            layerKey="jamming"
            on={layerVisibility.jamming}
            wish={layerWish?.jamming}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.jammingSignal} color="#b833e0" /> GPS/Radio Jamming (GPSJam)
          <span className="count"><CountUp value={counts.jamming} /> (<CountUp value={counts.jammingTotal} />)</span>
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

      <PanelGroup id="grp-airspace" title="Airspace &amp; Aviation" count={groupCount("airspace")}
        open={isOpen("grp-airspace")} onToggle={setOpen}>
        <label className="layer-row" data-layer="czib">
          <LayerCheck
            layerKey="czib"
            on={layerVisibility.czib}
            wish={layerWish?.czib}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={CZIB_STYLE.active.svg} color={CZIB_STYLE.active.color} token={CZIB_STYLE.active.token} />
          {" "}Airspace Warnings (EASA)
          <span className="count"><CountUp value={counts.czib} /> (<CountUp value={counts.czibTotal} />)</span>
        </label>
        <div className="subticker-list">
          {CZIB_ORDER.map((kind) => (
            <div className="subticker-row" key={kind}>
              <LayerIcon svg={CZIB_STYLE[kind].svg} color={CZIB_STYLE[kind].color} token={CZIB_STYLE[kind].token} />
              {CZIB_STYLE[kind].label}
              <span className="count">
                <CountUp value={counts[kind === "active" ? "czibActive" : "czibWithdrawn"]} />{" "}
                (<CountUp value={counts[kind === "active" ? "czibActiveTotal" : "czibWithdrawnTotal"]} />)
              </span>
            </div>
          ))}
        </div>
        <LayerDetails id="det-czib" open={isOpen("det-czib")} onToggle={setOpen}>
          <div className="sublegend">
            A CZIB is the European Union Aviation Safety Agency formally telling operators not to fly
            through a named airspace, with a bulletin number, an issue date and a review date. That makes it
            the <b>best-attributed evidence on this map</b>: a named regulator, a document you can look up,
            and a stated expiry.
          </div>
          <div className="sublegend">
            <b>These are country-precision pins and nothing finer.</b> A bulletin is about a national flight
            information region, so every pin carries the dashed ring and every popup says so. EASA ships a
            coordinate with each bulletin and this map ignores it &mdash; it geocodes the country&apos;s
            <i>name</i>, so Afghanistan&apos;s is Kabul, which is not where the bulletin is about.
          </div>
          <div className="sublegend">
            <b>A bulletin can be several pins.</b> One document naming eleven countries produces eleven
            identical pins, each carrying the full list and the count, so clicking any one of them shows it
            is one decision seen eleven times rather than eleven findings.
          </div>
          <div className="sublegend">
            <b>Withdrawn bulletins are kept, drawn grey, and never counted as warnings.</b> Over half of
            what EASA currently publishes is withdrawn, some of it for years. This map thins its
            presentation rather than deleting its data &mdash; the two tickers above are the honest version
            of that.
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-hazards" title="Natural Hazards" count={groupCount("hazards")}
        open={isOpen("grp-hazards")} onToggle={setOpen}>
        <label className="layer-row" data-layer="hazards">
          <LayerCheck
            layerKey="hazards"
            on={layerVisibility.hazards}
            wish={layerWish?.hazards}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.earthquake} color="currentColor" /> Earthquakes &amp; Volcanoes
          <span className="count"><CountUp value={counts.hazards} /> (<CountUp value={counts.hazardsTotal} />)</span>
        </label>
        <div className="subticker-list">
          {HAZARD_ROWS.map((row) => (
            <div className="subticker-row" key={row.key}>
              <LayerIcon svg={row.svg} color="currentColor" /> {row.label}
              <span className="count"><CountUp value={counts[row.countKey]} /> (<CountUp value={counts[`${row.countKey}Total`]} />)</span>
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

        <label className="layer-row" data-layer="floods">
          <LayerCheck
            layerKey="floods"
            on={layerVisibility.floods}
            wish={layerWish?.floods}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={FLOOD_STYLE.svg} color="currentColor" /> Floods (GDACS)
          <span className="count"><CountUp value={counts.floods} /> (<CountUp value={counts.floodsTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={FLOOD_STYLE.svg} color="currentColor" />
            Still open
            <span className="count"><CountUp value={counts.floodsCurrent} /> (<CountUp value={counts.floodsCurrentTotal} />)</span>
          </div>
        </div>
        <div id="floodsZoomNote" className={`sublegend${zoomNotes.floods ? " visible" : ""}`}>
          Zoom in to show floods
        </div>
        <LayerDetails id="det-floods" open={isOpen("det-floods")} onToggle={setOpen}>
          <div className="sublegend">
            GDACS &mdash; the European Commission&apos;s Joint Research Centre with the UN &mdash; runs the
            GLOFAS hydrological model over the world&apos;s river basins and issues a Green/Orange/Red alert
            per flood event. Keyless, and the reference feed most humanitarian responders already work from.
          </div>
          <div className="sublegend">
            <b>Kept out of the Earthquakes &amp; Volcanoes layer on purpose.</b> Those two carry measured
            positions &mdash; an instrument solution, a volcano&apos;s summit. This is a modelled centroid
            over an affected basin, GDACS&apos;s own word, so every pin here carries the dashed ring. And a
            quake is instantaneous where a flood event stays open for weeks and is revised across dozens of
            episodes; one layer cannot honestly age both.
          </div>
          <div className="sublegend">
            <b>Most of what this layer holds is over.</b> GDACS keeps closed events in the feed and this map
            keeps them too, drawn grey. The &ldquo;still open&rdquo; ticker above is how many are actually
            happening.
          </div>
          <div className="sublegend">
            Colour and size follow the same severity scale the conflict and earthquake layers use, from
            GDACS&apos;s alert level and nothing finer. Their numeric alert score is shown in each popup but
            does not drive the colour: it is a different quantity on a different scale, and deriving a
            0&ndash;100 from it would be a claim GDACS has not made.
          </div>
        </LayerDetails>
      </PanelGroup>

      <PanelGroup id="grp-space" title="Space" count={groupCount("space")}
        open={isOpen("grp-space")} onToggle={setOpen}>
        <label className="layer-row" data-layer="satellites">
          <LayerCheck
            layerKey="satellites"
            on={layerVisibility.satellites}
            wish={layerWish?.satellites}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.satellite} color="#6fe3ff" token="satellite.stations" /> Satellites (stations + military)
          <span className="count"><CountUp value={counts.satellites} /> (<CountUp value={counts.satellitesTotal} />)</span>
        </label>
        <label className="layer-row sub-row" data-layer="satellitesMilitary">
          <LayerCheck
            layerKey="satellitesMilitary"
            on={layerVisibility.satellitesMilitary}
            wish={layerWish?.satellitesMilitary}
            onToggle={onToggleLayer}
          />
          Show military satellites
        </label>
        <label className="layer-row sub-row" data-layer="satellitesTrails">
          <LayerCheck
            layerKey="satellitesTrails"
            on={layerVisibility.satellitesTrails}
            wish={layerWish?.satellitesTrails}
            onToggle={onToggleLayer}
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
          <LayerCheck
            layerKey="launches"
            on={layerVisibility.launches}
            wish={layerWish?.launches}
            onToggle={onToggleLayer}
          />
          <LayerIcon svg={SVG.launchPad} color={LAUNCH_STYLE.upcoming.color} token={LAUNCH_STYLE.upcoming.token} />
          {" "}Orbital Launches
          <span className="count"><CountUp value={counts.launches} /> (<CountUp value={counts.launchesTotal} />)</span>
        </label>
        <div className="subticker-list">
          <div className="subticker-row">
            <LayerIcon svg={SVG.launchPad} color={LAUNCH_STYLE.upcoming.color} token={LAUNCH_STYLE.upcoming.token} />
            Still to come
            <span className="count"><CountUp value={counts.launchesUpcoming} /> (<CountUp value={counts.launchesUpcomingTotal} />)</span>
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
