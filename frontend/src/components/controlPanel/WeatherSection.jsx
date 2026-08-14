import { SVG } from "../../map/svgIcons";
import LayerIcon from "./LayerIcon";
import LayerCheck from "./LayerCheck";
import { isOwmLayerDisabled } from "../../map/weatherLayers";

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
            disabled={isOwmLayerDisabled("clouds", owmConfigured)}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.cloud} color="#c9d6dd" /> Cloud Cover
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="wind">
        <LayerCheck
            layerKey="wind"
            on={layerVisibility.wind}
            wish={layerWish?.wind}
            disabled={isOwmLayerDisabled("wind", owmConfigured)}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.wind} color="#b39ddb" /> Wind Speed
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="precipitation">
        <LayerCheck
            layerKey="precipitation"
            on={layerVisibility.precipitation}
            wish={layerWish?.precipitation}
            disabled={isOwmLayerDisabled("precipitation", owmConfigured)}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.raindrop} color="#6a89ff" /> Precipitation Intensity
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="temp">
        <LayerCheck
            layerKey="temp"
            on={layerVisibility.temp}
            wish={layerWish?.temp}
            disabled={isOwmLayerDisabled("temp", owmConfigured)}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.thermometer} color="#ff8a65" /> Temperature
        <span className="key-note">{owmConfigured ? "" : "needs key"}</span>
      </label>
      <label className={`layer-row${owmConfigured ? "" : " disabled"}`} data-layer="pressure">
        <LayerCheck
            layerKey="pressure"
            on={layerVisibility.pressure}
            wish={layerWish?.pressure}
            disabled={isOwmLayerDisabled("pressure", owmConfigured)}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.pressureGauge} color="#ffd54f" /> Pressure
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
