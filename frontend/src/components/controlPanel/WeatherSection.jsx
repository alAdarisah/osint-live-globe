export default function WeatherSection({ layerVisibility, onToggleLayer, owmConfigured }) {
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
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="wind">
        <input
          type="checkbox"
          disabled={!owmConfigured}
          checked={layerVisibility.wind}
          onChange={(e) => onToggleLayer("wind", e.target.checked)}
        />
        <span className="swatch swatch-wind" /> Wind Speed (heatmap)
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className="layer-row" data-layer="windArrows">
        <input
          type="checkbox"
          checked={layerVisibility.windArrows}
          onChange={(e) => onToggleLayer("windArrows", e.target.checked)}
        />
        <span className="swatch swatch-wind-arrows" /> Wind Flow
      </label>
    </>
  );
}
