import { SVG, OFFICIALS_KIND_ICON } from "../../map/svgIcons";
import {
  SATELLITE_STYLE, INFRA_STYLE, MILITARY_SUBTYPE_STYLE, PIPELINE_ROUTE_COLOR,
} from "../../map/decorators";
import { SEVERITY_BANDS, CORROBORATED_COLOR } from "../../map/severity";
import LayerIcon from "./LayerIcon";

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
  { key: "pipelineRoutes", label: "Pipeline Routes", svg: SVG.pipeline, color: PIPELINE_ROUTE_COLOR },
];

const MILITARY_SUBTYPE_ORDER = ["air", "naval", "army", "missile", "joint", "logistics", "radar"];

export default function LayersSection({
  counts, zoomNotes, layerVisibility, onToggleLayer, infraFilterText, onInfraFilterChange,
  eventFilter, onEventFilterChange, historyAsOf,
}) {
  return (
    <>
      <h2>Layers</h2>

      <h3 className="layer-group-heading">Conflict &amp; Events</h3>
      <label className="layer-row" data-layer="events">
        <input
          type="checkbox"
          checked={layerVisibility.events}
          onChange={(e) => onToggleLayer("events", e.target.checked)}
        />
        <LayerIcon svg={SVG.clash} color="#ff3b30" /> Conflict &amp; Violence (ACLED + UCDP + GDELT)
        <span className="count">{counts.events} ({counts.eventsTotal})</span>
      </label>
      <div className="sublegend">
        ACLED (where an account is configured) + UCDP GED Candidate + GDELT, cross-referenced and merged
        into one pin per real incident. <b>Violence only</b> &mdash; armed clashes, assaults and mass
        violence; verbal and diplomatic conflict (accusations, demands, threats) is excluded here and
        has its own layer, Officials &amp; Diplomacy, below. Pin size and colour follow severity; blue
        means independently corroborated. Pins fade as they age. Only the last 3 days show on the map.
        Where a pin absorbed the news coverage of its incident, the headlines are listed inside it.
      </div>
      <div className="sublegend">
        {SEVERITY_BANDS.map((band) => (
          <span key={band.key}><LayerIcon svg={SVG.clash} color={band.color} />{band.label}</span>
        ))}
        <span><LayerIcon svg={SVG.clash} color={CORROBORATED_COLOR} />Corroborated</span>
      </div>
      <div className="sublegend">Colour is severity; the shape is what happened.</div>
      <div className="sublegend event-type-legend">
        {EVENT_TYPE_LEGEND.map(([svg, label]) => (
          <span key={label}><LayerIcon svg={svg} color="#ff9500" />{label}</span>
        ))}
      </div>
      <div className="sublegend">
        <span className="imprecise-swatch" /> Dashed ring &mdash; approximate location only
      </div>

      <div className="event-filters">
        <label>
          Window
          <select
            value={eventFilter.maxAgeHours ?? "all"}
            onChange={(e) => onEventFilterChange({
              maxAgeHours: e.target.value === "all" ? null : Number(e.target.value),
            })}
          >
            <option value="6">Last 6 hours</option>
            <option value="24">Last 24 hours</option>
            <option value="72">Last 72 hours</option>
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
      </div>

      <div id="conflictZoomNote" className={`sublegend${zoomNotes.events ? " visible" : ""}`}>
        Zoom in to show conflict events
      </div>

      <label className="layer-row" data-layer="conflictHistory">
        <input
          type="checkbox"
          checked={layerVisibility.conflictHistory}
          onChange={(e) => onToggleLayer("conflictHistory", e.target.checked)}
        />
        <LayerIcon svg={SVG.recordMark} color="#8f9bb3" /> Verified record (UCDP)
        <span className="count">{counts.conflictHistory} ({counts.conflictHistoryTotal})</span>
      </label>
      <div className="sublegend">
        UCDP GED Candidate &mdash; peer-reviewed conflict deaths, the most rigorous dataset available
        without a paid key. <b>Not live:</b> it lags real time by a month or more{historyAsOf ? `, currently complete to ${historyAsOf}` : ""}.
        Drawn hollow and grey so it can never be mistaken for a current report. Off by default.
      </div>
      <div id="historyZoomNote" className={`sublegend${zoomNotes.conflictHistory ? " visible" : ""}`}>
        Zoom in to show the verified record
      </div>

      <label className="layer-row" data-layer="gdelt">
        <input
          type="checkbox"
          checked={layerVisibility.gdelt}
          onChange={(e) => onToggleLayer("gdelt", e.target.checked)}
        />
        <LayerIcon svg={SVG.news} color="#ffd60a" /> News (GDELT)
        <span className="count">{counts.gdelt} ({counts.gdeltTotal})</span>
      </label>
      <div className="sublegend">
        Headlines from vetted outlets only, for the last 24 hours. Older stories fade rather than
        disappear. Where several land on the same spot they share one pin showing how many -- click it
        for the list, or zoom in to separate them.
      </div>
      <div className="sublegend">
        A headline already shown as a Conflict &amp; Violence or Officials pin is not drawn twice: it
        appears inside that pin's own popup instead, under "Coverage".
      </div>
      <div id="gdeltZoomNote" className={`sublegend${zoomNotes.gdelt ? " visible" : ""}`}>
        Zoom in to show news
      </div>

      <label className="layer-row" data-layer="officials">
        <input
          type="checkbox"
          checked={layerVisibility.officials}
          onChange={(e) => onToggleLayer("officials", e.target.checked)}
        />
        <LayerIcon svg={SVG.handshake} color="#7ee0c9" /> Officials &amp; Diplomacy
        <span className="count">{counts.officials} ({counts.officialsTotal})</span>
      </label>
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
      <div id="officialsZoomNote" className={`sublegend${zoomNotes.officials ? " visible" : ""}`}>
        Zoom in to show officials &amp; diplomacy
      </div>

      <h3 className="layer-group-heading">Air &amp; Sea Traffic</h3>
      <label className="layer-row" data-layer="aisNavy">
        <input
          type="checkbox"
          checked={layerVisibility.aisNavy}
          onChange={(e) => onToggleLayer("aisNavy", e.target.checked)}
        />
        <LayerIcon svg={SVG.ship} color="#ffd60a" /> Navy &amp; MSC Ships
        <span className="count">{counts.aisNavy} ({counts.aisNavyTotal})</span>
      </label>
      <div className="sublegend">Identified by AIS ship-type code or USS/USNS naming. Shown at every zoom.</div>

      <label className="layer-row" data-layer="aisTanker">
        <input
          type="checkbox"
          checked={layerVisibility.aisTanker}
          onChange={(e) => onToggleLayer("aisTanker", e.target.checked)}
        />
        <LayerIcon svg={SVG.tanker} color="#ffb347" /> Oil Tankers
        <span className="count">{counts.aisTanker} ({counts.aisTankerTotal})</span>
      </label>
      <div className="sublegend">AIS ship-type code 80-89. Its own ticker, not mixed into Civilian Ships.</div>
      <label className="layer-row sub-row" data-layer="aisTankerTrails">
        <input
          type="checkbox"
          checked={layerVisibility.aisTankerTrails}
          onChange={(e) => onToggleLayer("aisTankerTrails", e.target.checked)}
        />
        Show tanker trails
      </label>

      <label className="layer-row" data-layer="aisCivilian">
        <input
          type="checkbox"
          checked={layerVisibility.aisCivilian}
          onChange={(e) => onToggleLayer("aisCivilian", e.target.checked)}
        />
        <LayerIcon svg={SVG.ship} color="#35c2ff" /> Civilian Ships (AIS)
        <span className="count">{counts.aisCivilian} ({counts.aisCivilianTotal})</span>
      </label>
      <div id="aisZoomNote" className={`sublegend${zoomNotes.ais ? " visible" : ""}`}>
        Zoom in to show civilian ships
      </div>

      <label className="layer-row" data-layer="adsbMilitary">
        <input
          type="checkbox"
          checked={layerVisibility.adsbMilitary}
          onChange={(e) => onToggleLayer("adsbMilitary", e.target.checked)}
        />
        <LayerIcon svg={SVG.planeMilitary} color="#ff4d4d" /> Military Aircraft
        <span className="count">{counts.adsbMilitary} ({counts.adsbMilitaryTotal})</span>
      </label>
      <div className="sublegend">Shown at every zoom.</div>
      <div className="sublegend">
        <span>
          <LayerIcon svg={SVG.planeFighter} color="#ff4d4d" />Fighter
        </span>
        <span>
          <LayerIcon svg={SVG.planeBomber} color="#ff4d4d" />Bomber
        </span>
        <span>
          <LayerIcon svg={SVG.planeTanker} color="#ff8c3a" />Tanker
        </span>
        <span>
          <LayerIcon svg={SVG.planeAwacs} color="#ffd60a" />AWACS
        </span>
        <span>
          <LayerIcon svg={SVG.planeRecon} color="#d8b9ff" />Recon
        </span>
        <span>
          <LayerIcon svg={SVG.planePatrol} color="#6fe3ff" />Patrol
        </span>
        <span>
          <LayerIcon svg={SVG.planeDrone} color="#9be15d" />Drone
        </span>
        <span>
          <LayerIcon svg={SVG.planeTransport} color="#8aa0ad" />Transport
        </span>
        <span>
          <LayerIcon svg={SVG.helicopter} color="#ff4d4d" />Helicopter
        </span>
      </div>
      <label className="layer-row sub-row" data-layer="adsbMilitaryTrails">
        <input
          type="checkbox"
          checked={layerVisibility.adsbMilitaryTrails}
          onChange={(e) => onToggleLayer("adsbMilitaryTrails", e.target.checked)}
        />
        Show military aircraft trails
      </label>

      <label className="layer-row" data-layer="adsbCivilian">
        <input
          type="checkbox"
          checked={layerVisibility.adsbCivilian}
          onChange={(e) => onToggleLayer("adsbCivilian", e.target.checked)}
        />
        <LayerIcon svg={SVG.planeCommercial} color="#d8b9ff" /> Civilian Aircraft (ADS-B)
        <span className="count">{counts.adsbCivilian} ({counts.adsbCivilianTotal})</span>
      </label>
      <div id="adsbZoomNote" className={`sublegend${zoomNotes.adsb ? " visible" : ""}`}>
        Zoom in to show civilian aircraft
      </div>
      <div className="sublegend">
        <span>
          <LayerIcon svg={SVG.planeCommercial} color="#d8b9ff" />Commercial
        </span>
        <span>
          <LayerIcon svg={SVG.helicopter} color="#9be15d" />Helicopter
        </span>
        <span>
          <LayerIcon svg={SVG.planeOther} color="#8aa0ad" />Other/GA
        </span>
      </div>

      <h3 className="layer-group-heading">Infrastructure &amp; Environment</h3>
      <label className="layer-row" data-layer="infra">
        <input
          type="checkbox"
          checked={layerVisibility.infra}
          onChange={(e) => onToggleLayer("infra", e.target.checked)}
        />
        <LayerIcon svg={SVG.refinery} color="#ff9500" /> Critical Infrastructure
        <span className="count">{counts.infra} ({counts.infraTotal})</span>
      </label>
      <div className="sublegend">
        Publicly documented sites relevant to the selected conflict zone; flares when a nearby event is reported.
      </div>
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
            <LayerIcon svg={row.svg} color={row.color} /> {row.label}
            <span className="count">{counts[row.key]} ({counts[`${row.key}Total`]})</span>
          </div>
        ))}
      </div>
      <div className="sublegend">
        {MILITARY_SUBTYPE_ORDER.map((subtype) => (
          <span key={subtype}>
            <LayerIcon svg={MILITARY_SUBTYPE_STYLE[subtype].svg} color={MILITARY_SUBTYPE_STYLE[subtype].color} />
            {MILITARY_SUBTYPE_STYLE[subtype].label}
          </span>
        ))}
      </div>

      <label className="layer-row" data-layer="firms">
        <input
          type="checkbox"
          checked={layerVisibility.firms}
          onChange={(e) => onToggleLayer("firms", e.target.checked)}
        />
        <LayerIcon svg={SVG.fire} color="#ff9500" /> Fires / Thermal Anomalies (FIRMS)
        <span className="count">{counts.firms} ({counts.firmsTotal})</span>
      </label>
      <div className="sublegend">Heat intensity = Fire Radiative Power (FRP). Click a point for detail.</div>
      <div id="firmsZoomNote" className={`sublegend${zoomNotes.firms ? " visible" : ""}`}>
        Zoom in to inspect individual fire points
      </div>

      <label className="layer-row" data-layer="jamming">
        <input
          type="checkbox"
          checked={layerVisibility.jamming}
          onChange={(e) => onToggleLayer("jamming", e.target.checked)}
        />
        <LayerIcon svg={SVG.jammingSignal} color="#b833e0" /> GPS/Radio Jamming (GPSJam)
        <span className="count">{counts.jamming} ({counts.jammingTotal})</span>
      </label>
      <div className="sublegend">
        Data: gpsjam.org, derived from ADS-B aircraft GPS-quality reports. Updated once/day, not real-time.
      </div>
      <div id="jammingZoomNote" className={`sublegend${zoomNotes.jamming ? " visible" : ""}`}>
        Zoom in to inspect individual cells
      </div>

      <h3 className="layer-group-heading">Space</h3>
      <label className="layer-row" data-layer="satellites">
        <input
          type="checkbox"
          checked={layerVisibility.satellites}
          onChange={(e) => onToggleLayer("satellites", e.target.checked)}
        />
        <LayerIcon svg={SVG.satellite} color="#6fe3ff" /> Satellites (stations + military)
        <span className="count">{counts.satellites} ({counts.satellitesTotal})</span>
      </label>
      <div className="sublegend">
        Position computed via SGP4 from CelesTrak's public orbital elements. Always shown, any zoom.
      </div>
      <div className="sublegend">
        <span>
          <LayerIcon svg={SATELLITE_STYLE.stations.svg} color={SATELLITE_STYLE.stations.color} />Station
        </span>
        <span>
          <LayerIcon svg={SATELLITE_STYLE.military.svg} color={SATELLITE_STYLE.military.color} />Military
        </span>
      </div>
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
    </>
  );
}
