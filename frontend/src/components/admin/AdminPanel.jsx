// Admin Mode: everything that used to require editing source.
//
// One draggable panel, folded into the same accordion sections the control
// panel uses, and rendered *only* while Admin Mode is on -- which is the whole
// safety model. There is no editable control anywhere else in the app, so a
// reader who has not deliberately turned Admin Mode on cannot change an icon
// size or a record by any sequence of clicks.
//
// Each fold is its own file under sections/ -- see that directory's shared.jsx
// for what more than one of them needs. What each owns:
//   Icons    the one global size multiplier, and the reset buttons
//   Layers   everything else about how a layer draws -- its size, its opacity,
//            its zoom gate, and the colour of every kind of pin in it. Grouped
//            by layer rather than split across two sections, because split is
//            how the same dial ended up offered twice (see LayerDialsSection)
//   Water    fill opacity, outline weight, which marine classes draw, and
//            the highlight colours (see WaterSection.jsx)
//   Tiles    filter + colour tint for the raster basemap/imagery/weather panes
//            (see BasemapSection.jsx and map/tileTint.js)
//   Filters  the vessel/aircraft filter bars and the conflict event filter,
//            plus saved filter presets (see FiltersSection.jsx)
//   Inference  the three-state switch per inferred product, and the
//            read-only thresholds behind each one (see InferenceSection.jsx)
//   Data     the records themselves (see DataEditor.jsx)
//   Cards    which sections a country/water/state/district card shows, in
//            what order, and whether each starts open (see CardsSection.jsx)
//   Performance  WebGL sprite cap, satellite propagation cadence, poll
//            interval multiplier, pause-when-hidden, trail point budgets
//            (see PerformanceSection.jsx)
//   Display  panel opacity, accent, text size, motion, leader lines
//   Config   export / import / reset, and the panel layout
//
// Every change is live and saved as it is made -- there is no Apply button,
// because a settings panel with unsaved state is a settings panel that loses
// work when it is closed.
import { useState } from "react";
import { useAccordion } from "../../hooks/useAccordion";
import { useDraggablePanel } from "../../hooks/useDraggablePanel";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { matchesQuery } from "./sections/adminSearch";
import { SyncBadge } from "./sections/shared";
import IconsSection, { SEARCH_TERMS as ICONS_TERMS } from "./sections/IconsSection";
import StackSection, { SEARCH_TERMS as STACK_TERMS } from "./sections/StackSection";
import LayerDialsSection, { SEARCH_TERMS as LAYERS_TERMS } from "./sections/LayerDialsSection";
import WaterSection, { SEARCH_TERMS as WATER_TERMS } from "./sections/WaterSection";
import CityZonesSection, { SEARCH_TERMS as ZONES_TERMS } from "./sections/CityZonesSection";
import BasemapSection, { SEARCH_TERMS as TILES_TERMS } from "./sections/BasemapSection";
import FiltersSection, { SEARCH_TERMS as FILTERS_TERMS } from "./sections/FiltersSection";
import InferenceSection, { SEARCH_TERMS as INFERENCE_TERMS } from "./sections/InferenceSection";
import DataSection, { SEARCH_TERMS as DATA_TERMS } from "./sections/DataSection";
import CardsSection, { SEARCH_TERMS as CARDS_TERMS } from "./sections/CardsSection";
import PerformanceSection, { SEARCH_TERMS as PERFORMANCE_TERMS } from "./sections/PerformanceSection";
import BordersSection, { SEARCH_TERMS as BORDERS_TERMS } from "./sections/BordersSection";
import InterfaceSection, { SEARCH_TERMS as UI_TERMS } from "./sections/InterfaceSection";
import ConfigSection, { SEARCH_TERMS as CONFIG_TERMS } from "./sections/ConfigSection";
import AlertRulesSection, { SEARCH_TERMS as ALERT_RULES_TERMS } from "./sections/AlertRulesSection";

const DEFAULT_OPEN = { "adm-icons": true };
const STORAGE_KEY = "osint-admin-accordion";

// Section order, and the terms its search box checks against. Each list is
// the section's own title first, then its control labels -- see
// sections/adminSearch.js for the matching rule. A section is shown while any
// one of its terms matches the query, so the whole section disappears rather
// than leaving a fold with nothing inside it.
const SECTIONS = [
  { Component: IconsSection, terms: ICONS_TERMS },
  { Component: StackSection, terms: STACK_TERMS },
  { Component: LayerDialsSection, terms: LAYERS_TERMS },
  { Component: WaterSection, terms: WATER_TERMS },
  { Component: CityZonesSection, terms: ZONES_TERMS },
  { Component: BasemapSection, terms: TILES_TERMS },
  { Component: FiltersSection, terms: FILTERS_TERMS },
  { Component: InferenceSection, terms: INFERENCE_TERMS },
  { Component: DataSection, terms: DATA_TERMS },
  { Component: CardsSection, terms: CARDS_TERMS },
  { Component: PerformanceSection, terms: PERFORMANCE_TERMS },
  { Component: BordersSection, terms: BORDERS_TERMS },
  { Component: InterfaceSection, terms: UI_TERMS },
  { Component: AlertRulesSection, terms: ALERT_RULES_TERMS },
  { Component: ConfigSection, terms: CONFIG_TERMS },
];

export default function AdminPanel({
  settings, actions, recordsFor, sync, staleBorders, onClose,
  eventFilter, onEventFilterChange, vesselFilter, onVesselFilterChange,
  aircraftFilter, onAircraftFilterChange,
  // Task 42's Alert rules section: source-health status per layer plus the
  // rule engine's own heartbeat (health), the live REGIONS table for the
  // region picker (regions), and the three already-existing map selection
  // states that stand in for a geofence-drawing tool the rest of the app
  // does not otherwise need -- see AlertRulesSection.jsx's own module note
  // for why "click a country", "click a water body" and "pan/zoom the map"
  // were reused rather than building a fourth.
  health, regions, mapBounds, countrySelection, selectedWater,
}) {
  const { isOpen, setOpen } = useAccordion(DEFAULT_OPEN, STORAGE_KEY);
  const [query, setQuery] = useState("");
  // Resizable, and off on mobile where the panel is a full-width overlay whose
  // width the viewport already decides. A pin row here is a colour well, a
  // name, a size slider and three selects on one line: on a narrow panel the
  // name is the only part that can give, and it runs out.
  const isMobile = useIsMobileViewport();
  const { panelRef, style, handleProps, resizeProps } = useDraggablePanel("adminPanel", {
    enabled: !isMobile,
    resizable: true,
  });

  return (
    <aside id="adminPanel" ref={panelRef} style={style}>
      <div {...handleProps} className={`admin-header ${handleProps.className || ""}`}>
        <span className="admin-badge">ADMIN</span>
        <span className="admin-title">Configuration</span>
        <SyncBadge sync={sync} />
        <button type="button" className="admin-close" onClick={onClose} aria-label="Leave Admin Mode">
          &times;
        </button>
      </div>

      <div className="admin-body">
        <div className="admin-row">
          <input
            type="text"
            placeholder="Search settings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search admin settings"
          />
        </div>

        {SECTIONS.filter(({ terms }) => terms.some((term) => matchesQuery(term, query))).map(
          ({ Component }) => (
            <Component
              key={Component.name}
              settings={settings}
              actions={actions}
              recordsFor={recordsFor}
              sync={sync}
              staleBorders={staleBorders}
              isOpen={isOpen}
              onToggle={setOpen}
              eventFilter={eventFilter}
              onEventFilterChange={onEventFilterChange}
              vesselFilter={vesselFilter}
              onVesselFilterChange={onVesselFilterChange}
              aircraftFilter={aircraftFilter}
              onAircraftFilterChange={onAircraftFilterChange}
              health={health}
              regions={regions}
              mapBounds={mapBounds}
              countrySelection={countrySelection}
              selectedWater={selectedWater}
            />
          )
        )}
      </div>

      {/* Last child so it paints over the body's scrollbar rather than under
          it, and absent entirely on mobile (see useDraggablePanel). */}
      {resizeProps && <div {...resizeProps} aria-hidden="true" />}
    </aside>
  );
}
