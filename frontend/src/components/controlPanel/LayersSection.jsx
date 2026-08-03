export default function LayersSection({ counts, zoomNotes, layerVisibility, onToggleLayer }) {
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

      <label className="layer-row" data-layer="ais">
        <input type="checkbox" checked={layerVisibility.ais} onChange={(e) => onToggleLayer("ais", e.target.checked)} />
        <span className="swatch swatch-ais" /> Maritime / AIS
        <span className="count">{counts.ais}</span>
      </label>

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

      <label className="layer-row" data-layer="adsb">
        <input
          type="checkbox"
          checked={layerVisibility.adsb}
          onChange={(e) => onToggleLayer("adsb", e.target.checked)}
        />
        <span className="swatch swatch-adsb" /> Aircraft (ADS-B)
        <span className="count">{counts.adsb}</span>
      </label>
      <div id="adsbZoomNote" className={`sublegend${zoomNotes.adsb ? " visible" : ""}`}>
        Zoom in to show aircraft (military shown at every zoom)
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
