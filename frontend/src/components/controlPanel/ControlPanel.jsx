import LayersSection from "./LayersSection";
import PlacesSection from "./PlacesSection";
import WeatherSection from "./WeatherSection";
import SourceStatusSection from "./SourceStatusSection";

export default function ControlPanel({
  open, counts, zoomNotes, layerVisibility, onToggleLayer, health, owmConfigured, windStatus, infraFilterText, onInfraFilterChange, eventFilter, onEventFilterChange, historyAsOf,
}) {
  return (
    <aside id="controlPanel" className={open ? "open" : ""}>
      <LayersSection
        counts={counts}
        zoomNotes={zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        infraFilterText={infraFilterText}
        eventFilter={eventFilter}
        onEventFilterChange={onEventFilterChange}
        historyAsOf={historyAsOf}
        onInfraFilterChange={onInfraFilterChange}
      />
      <PlacesSection counts={counts} zoomNotes={zoomNotes} layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} />
      <WeatherSection layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} owmConfigured={owmConfigured} windStatus={windStatus} />
      <SourceStatusSection health={health} />
    </aside>
  );
}
