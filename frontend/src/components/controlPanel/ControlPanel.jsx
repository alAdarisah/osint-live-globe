import LayersSection from "./LayersSection";
import PlacesSection from "./PlacesSection";
import WeatherSection from "./WeatherSection";
import SourceStatusSection from "./SourceStatusSection";

export default function ControlPanel({
  open, counts, zoomNotes, layerVisibility, onToggleLayer, onToggleConflictLayers, health, owmConfigured, windStatus, infraFilterText, onInfraFilterChange,
}) {
  return (
    <aside id="controlPanel" className={open ? "open" : ""}>
      <LayersSection
        counts={counts}
        zoomNotes={zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        onToggleConflictLayers={onToggleConflictLayers}
        infraFilterText={infraFilterText}
        onInfraFilterChange={onInfraFilterChange}
      />
      <PlacesSection counts={counts} zoomNotes={zoomNotes} layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} />
      <WeatherSection layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} owmConfigured={owmConfigured} windStatus={windStatus} />
      <SourceStatusSection health={health} />
    </aside>
  );
}
