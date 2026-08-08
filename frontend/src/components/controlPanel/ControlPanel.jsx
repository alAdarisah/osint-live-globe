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
  open, counts, zoomNotes, layerVisibility, layerWish, sceneBypass, onSceneBypassChange,
  onToggleLayer, health, owmConfigured, windStatus, infraFilterText, onInfraFilterChange, eventFilter, onEventFilterChange, historyAsOf,
  imageryKey, imageryDate, onImageryChange,
  choropleth, onChoroplethChange,
}) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN);

  return (
    <aside id="controlPanel" className={open ? "open" : ""}>
      {/* Top of the panel, above everything, because it changes what every
          row below it means.

          An empty layer has four possible causes -- the feed is dead, the
          viewport filter caught everything, it is below its zoom gate, or the
          scene resolver decided against it -- and without a way to defeat the
          resolver an operator can only tell the first three apart. Switching
          this on makes every layer eligible, returns each gate to its shipped
          number rather than any the camera has promoted, and lifts the caps, so
          the panel behaves exactly as it did before the resolver existed. That
          is the point: a known state to compare against. */}
      <div className="scene-bypass-row">
        <label className="layer-row">
          <input
            type="checkbox"
            checked={!!sceneBypass}
            onChange={(e) => onSceneBypassChange?.(e.target.checked)}
          />
          <span>Ignore the scene resolver</span>
        </label>
        <p className="layer-note">
          {sceneBypass
            ? "Every layer is eligible at its shipped zoom gate, uncapped. This is the pre-resolver behaviour, for comparison."
            : "Layers are chosen by zoom, by what the camera is over, and by what you have clicked. A checkbox here overrides that layer until you clear it."}
        </p>
      </div>
      <LayersSection
        layerWish={layerWish}
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
        layerWish={layerWish}
        counts={counts}
        zoomNotes={zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        choropleth={choropleth}
        onChoroplethChange={onChoroplethChange}
        isOpen={isOpen}
        setOpen={setOpen}
      />
      <ImagerySection imageryKey={imageryKey} imageryDate={imageryDate} onImageryChange={onImageryChange} />
      <WeatherSection layerVisibility={layerVisibility} layerWish={layerWish} onToggleLayer={onToggleLayer} owmConfigured={owmConfigured} windStatus={windStatus} />
      <SourceStatusSection health={health} />
    </aside>
  );
}
