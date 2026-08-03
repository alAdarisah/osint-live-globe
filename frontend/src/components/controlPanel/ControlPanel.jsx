import LayersSection from "./LayersSection";
import PlacesSection from "./PlacesSection";
import WeatherSection from "./WeatherSection";
import SourceStatusSection from "./SourceStatusSection";

export default function ControlPanel({ open, counts, zoomNotes, layerVisibility, onToggleLayer, health, owmConfigured }) {
  return (
    <aside id="controlPanel" className={open ? "open" : ""}>
      <LayersSection counts={counts} zoomNotes={zoomNotes} layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} />
      <PlacesSection counts={counts} zoomNotes={zoomNotes} layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} />
      <WeatherSection layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} owmConfigured={owmConfigured} />
      <SourceStatusSection health={health} />
    </aside>
  );
}
