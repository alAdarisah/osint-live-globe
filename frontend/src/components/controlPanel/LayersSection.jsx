import { SVG } from "../../map/svgIcons";
import { SATELLITE_STYLE } from "../../map/decorators";
import LayerIcon from "./LayerIcon";

export default function LayersSection({
  counts, zoomNotes, layerVisibility, onToggleLayer, infraFilterText, onInfraFilterChange,
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
        <LayerIcon svg={SVG.burst} color="#ff3b30" /> Conflict &amp; Violence (ACLED + UCDP + GDELT)
        <span className="count">{counts.events} ({counts.eventsTotal})</span>
      </label>
      <div className="sublegend">
        ACLED (where an account is configured) + UCDP GED Candidate + GDELT, cross-referenced and merged
        into one pin per real incident. <b>Violence only</b> &mdash; armed clashes, assaults and mass
        violence; verbal and diplomatic conflict (accusations, demands, protests) is excluded here and
        appears under News instead. Pin size and colour follow severity; blue means independently
        corroborated by 2+ sources. Only the last 3 days show on the map.
      </div>
      <div className="sublegend">
        <span><LayerIcon svg={SVG.burst} color="#ff1a1a" />Critical</span>
        <span><LayerIcon svg={SVG.burst} color="#ff5c2a" />High</span>
        <span><LayerIcon svg={SVG.burst} color="#ff9500" />Moderate</span>
        <span><LayerIcon svg={SVG.burst} color="#ffd11a" />Low</span>
        <span><LayerIcon svg={SVG.burst} color="#3ac1ff" />Corroborated</span>
      </div>
      <div id="conflictZoomNote" className={`sublegend${zoomNotes.events ? " visible" : ""}`}>
        Zoom in to show conflict events
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
        Verified-outlet headlines. Excludes anything already shown as a Conflict &amp; Violence pin above --
        no headline shows twice.
      </div>
      <div id="gdeltZoomNote" className={`sublegend${zoomNotes.gdelt ? " visible" : ""}`}>
        Zoom in to show news
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
          <LayerIcon svg={SVG.planeMilitary} color="#ff4d4d" />Fighter
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
        Includes military bases (air/naval/army/missile/joint/logistics/radar).
      </div>
      <input
        type="text"
        className="infra-filter-input"
        placeholder="Filter infrastructure/bases by name..."
        value={infraFilterText}
        onChange={(e) => onInfraFilterChange(e.target.value)}
      />

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
