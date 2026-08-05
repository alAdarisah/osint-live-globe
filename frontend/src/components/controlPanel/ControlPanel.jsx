import LayersSection from "./LayersSection";
import PlacesSection from "./PlacesSection";
import WeatherSection from "./WeatherSection";
import ImagerySection from "./ImagerySection";
import SourceStatusSection from "./SourceStatusSection";
import { useAccordion } from "../../hooks/useAccordion";

// What is expanded the first time someone opens the panel.
//
// Conflict & Events only. It is the layer set the map exists for, and it is the
// one already on by default -- so the panel opens showing the controls that
// match what is on screen, rather than every group at once, which is the state
// that made it 5.3 screens tall. Every per-layer "About this layer" fold starts
// shut: that material is read once and then never again.
const DEFAULT_OPEN = { "grp-conflict": true };

export default function ControlPanel({
  open, counts, zoomNotes, layerVisibility, onToggleLayer, health, owmConfigured, windStatus, infraFilterText, onInfraFilterChange, eventFilter, onEventFilterChange, historyAsOf,
  imageryKey, imageryDate, onImageryChange,
}) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN);

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
        isOpen={isOpen}
        setOpen={setOpen}
      />
      <PlacesSection
        counts={counts}
        zoomNotes={zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        isOpen={isOpen}
        setOpen={setOpen}
      />
      <ImagerySection imageryKey={imageryKey} imageryDate={imageryDate} onImageryChange={onImageryChange} />
      <WeatherSection layerVisibility={layerVisibility} onToggleLayer={onToggleLayer} owmConfigured={owmConfigured} windStatus={windStatus} />
      <SourceStatusSection health={health} />
    </aside>
  );
}
