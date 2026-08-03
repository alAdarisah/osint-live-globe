export default function LayersSection({ counts, zoomNotes, layerVisibility, onToggleLayer, infraFilterText, onInfraFilterChange }) {
  return (
    <>
      <h2>Layers</h2>
      <label className="layer-row" data-layer="acled">
        <input
          type="checkbox"
          checked={layerVisibility.acled}
          onChange={(e) => onToggleLayer("acled", e.target.checked)}
        />
        <span className="swatch swatch-acled" /> Conflict &amp; Violence (ACLED + UCDP)
        <span className="count">{counts.acled}</span>
      </label>
      <div id="acledZoomNote" className={`sublegend${zoomNotes.acled ? " visible" : ""}`}>
        Zoom in to show conflict events
      </div>

      <label className="layer-row" data-layer="firms">
        <input
          type="checkbox"
          checked={layerVisibility.firms}
          onChange={(e) => onToggleLayer("firms", e.target.checked)}
        />
        <span className="swatch swatch-firms" /> Fires / Thermal Anomalies (FIRMS)
        <span className="count">{counts.firms}</span>
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
        <span className="swatch swatch-jamming" /> GPS/Radio Jamming (GPSJam)
        <span className="count">{counts.jamming}</span>
      </label>
      <div className="sublegend">
        Data: gpsjam.org, derived from ADS-B aircraft GPS-quality reports. Updated once/day, not real-time.
      </div>
      <div id="jammingZoomNote" className={`sublegend${zoomNotes.jamming ? " visible" : ""}`}>
        Zoom in to inspect individual cells
      </div>

      <label className="layer-row" data-layer="aisNavy">
        <input
          type="checkbox"
          checked={layerVisibility.aisNavy}
          onChange={(e) => onToggleLayer("aisNavy", e.target.checked)}
        />
        <span className="swatch swatch-ais" /> Navy &amp; MSC Ships
        <span className="count">{counts.aisNavy}</span>
      </label>
      <div className="sublegend">Identified by AIS ship-type code or USS/USNS naming. Shown at every zoom.</div>

      <label className="layer-row" data-layer="aisTanker">
        <input
          type="checkbox"
          checked={layerVisibility.aisTanker}
          onChange={(e) => onToggleLayer("aisTanker", e.target.checked)}
        />
        <span className="swatch" style={{ background: "#ffb347" }} /> Oil Tankers
        <span className="count">{counts.aisTanker}</span>
      </label>
      <div className="sublegend">AIS ship-type code 80-89. Its own ticker, not mixed into Civilian Ships.</div>

      <label className="layer-row" data-layer="aisCivilian">
        <input
          type="checkbox"
          checked={layerVisibility.aisCivilian}
          onChange={(e) => onToggleLayer("aisCivilian", e.target.checked)}
        />
        <span className="swatch swatch-ais" /> Civilian Ships (AIS)
        <span className="count">{counts.aisCivilian}</span>
      </label>
      <div id="aisZoomNote" className={`sublegend${zoomNotes.ais ? " visible" : ""}`}>
        Zoom in to show civilian ships
      </div>

      <label className="layer-row" data-layer="infra">
        <input
          type="checkbox"
          checked={layerVisibility.infra}
          onChange={(e) => onToggleLayer("infra", e.target.checked)}
        />
        <span className="swatch swatch-infra" /> Critical Infrastructure
        <span className="count">{counts.infra}</span>
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

      <label className="layer-row" data-layer="satellites">
        <input
          type="checkbox"
          checked={layerVisibility.satellites}
          onChange={(e) => onToggleLayer("satellites", e.target.checked)}
        />
        <span className="swatch swatch-satellites" /> Satellites (stations + military)
        <span className="count">{counts.satellites}</span>
      </label>
      <div className="sublegend">
        Position computed via SGP4 from CelesTrak's public orbital elements. Always shown, any zoom.
      </div>

      <label className="layer-row" data-layer="gdelt">
        <input
          type="checkbox"
          checked={layerVisibility.gdelt}
          onChange={(e) => onToggleLayer("gdelt", e.target.checked)}
        />
        <span className="swatch swatch-gdelt" /> News (GDELT)
        <span className="count">{counts.gdelt}</span>
      </label>
      <div id="gdeltZoomNote" className={`sublegend${zoomNotes.gdelt ? " visible" : ""}`}>
        Zoom in to show news
      </div>

      <label className="layer-row" data-layer="adsbMilitary">
        <input
          type="checkbox"
          checked={layerVisibility.adsbMilitary}
          onChange={(e) => onToggleLayer("adsbMilitary", e.target.checked)}
        />
        <span className="swatch swatch-adsb" /> Military Aircraft
        <span className="count">{counts.adsbMilitary}</span>
      </label>
      <div className="sublegend">Shown at every zoom.</div>

      <label className="layer-row" data-layer="adsbCivilian">
        <input
          type="checkbox"
          checked={layerVisibility.adsbCivilian}
          onChange={(e) => onToggleLayer("adsbCivilian", e.target.checked)}
        />
        <span className="swatch swatch-adsb" /> Civilian Aircraft (ADS-B)
        <span className="count">{counts.adsbCivilian}</span>
      </label>
      <div id="adsbZoomNote" className={`sublegend${zoomNotes.adsb ? " visible" : ""}`}>
        Zoom in to show civilian aircraft
      </div>
      <div className="sublegend">
        <span>
          <span className="swatch" style={{ background: "#d8b9ff" }} />Commercial
        </span>
        <span>
          <span className="swatch" style={{ background: "#ff4d4d" }} />Military
        </span>
        <span>
          <span className="swatch" style={{ background: "#9be15d" }} />Helicopter
        </span>
        <span>
          <span className="swatch" style={{ background: "#8aa0ad" }} />Other/GA
        </span>
      </div>
    </>
  );
}
