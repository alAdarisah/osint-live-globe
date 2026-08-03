export default function WeatherSection({ layerVisibility, onToggleLayer, owmConfigured, windStatus }) {
  return (
    <>
      <h2>Weather</h2>
      <label className="layer-row" data-layer="precip">
        <input
          type="checkbox"
          checked={layerVisibility.precip}
          onChange={(e) => onToggleLayer("precip", e.target.checked)}
        />
        <span className="swatch swatch-precip" /> Precipitation Radar
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="clouds">
        <input
          type="checkbox"
          disabled={!owmConfigured}
          checked={layerVisibility.clouds}
          onChange={(e) => onToggleLayer("clouds", e.target.checked)}
        />
        <span className="swatch swatch-clouds" /> Cloud Cover
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className="layer-row" data-layer="windArrows">
        <input
          type="checkbox"
          checked={layerVisibility.windArrows}
          onChange={(e) => onToggleLayer("windArrows", e.target.checked)}
        />
        <span className="swatch swatch-wind-arrows" /> Wind
      </label>
      <div className="sublegend">Flowing particles, colored by speed (Open-Meteo) -- merges the old separate heatmap toggle.</div>
      {windStatus && !windStatus.ok && (
        <div className="sublegend wind-unavailable">
          Wind data unavailable right now (Open-Meteo's free tier has a daily request cap -- this usually clears up
          within a day).
        </div>
      )}
    </>
  );
}
