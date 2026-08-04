import { SVG } from "../../map/svgIcons";
import LayerIcon from "./LayerIcon";

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
        <LayerIcon svg={SVG.raindrop} color="#3ba0ff" /> Precipitation Radar
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="clouds">
        <input
          type="checkbox"
          disabled={!owmConfigured}
          checked={layerVisibility.clouds}
          onChange={(e) => onToggleLayer("clouds", e.target.checked)}
        />
        <LayerIcon svg={SVG.cloud} color="#c9d6dd" /> Cloud Cover
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className="layer-row" data-layer="windArrows">
        <input
          type="checkbox"
          checked={layerVisibility.windArrows}
          onChange={(e) => onToggleLayer("windArrows", e.target.checked)}
        />
        <LayerIcon svg={SVG.wind} color="#7ee0c9" /> Wind
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
