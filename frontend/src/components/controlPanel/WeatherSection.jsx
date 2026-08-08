import { SVG } from "../../map/svgIcons";
import LayerIcon from "./LayerIcon";
import LayerCheck from "./LayerCheck";

export default function WeatherSection({ layerVisibility, layerWish, onToggleLayer, owmConfigured, windStatus }) {
  return (
    <>
      <h2>Weather</h2>
      <label className="layer-row" data-layer="precip">
        <LayerCheck
            layerKey="precip"
            on={layerVisibility.precip}
            wish={layerWish?.precip}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.raindrop} color="#3ba0ff" /> Precipitation Radar
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="clouds">
        <LayerCheck
            layerKey="clouds"
            on={layerVisibility.clouds}
            wish={layerWish?.clouds}
            disabled={!owmConfigured}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.cloud} color="#c9d6dd" /> Cloud Cover
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className="layer-row" data-layer="windArrows">
        <LayerCheck
            layerKey="windArrows"
            on={layerVisibility.windArrows}
            wish={layerWish?.windArrows}
            onToggle={onToggleLayer}
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
