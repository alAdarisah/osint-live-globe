// Task 31: fill opacity, outline weight, which marine classes draw, and the
// highlight colours for the water layer (Task 6) -- gathered into one place
// rather than left spread across LayerDialsSection's generic "Water bodies"
// row and the Shared Colours block at its foot (see shared.jsx's own note on
// why water.fill/water.outline/water.selected fall through to that shared
// block: they colour a polygon fill, not a pin, so TOKEN_LAYER has no entry
// for them).
//
// The colour pickers here are the same three tokens LayerDialsSection's
// Shared Colours block already offers, through the same actions.setColor --
// this section is a second, more discoverable place to reach them, not a
// second place they are stored.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, ColorField, CheckField } from "../fields";
import { DEFAULT_COLORS } from "../../../map/iconTheme";
import { MARINE_CLASSES } from "../../../map/water";

const CLASS_LABEL = {
  ocean: "Ocean", sea: "Sea", gulf: "Gulf", bay: "Bay", strait: "Strait",
  channel: "Channel", sound: "Sound", other: "Other marine",
};

export const SEARCH_TERMS = [
  "Water",
  "Fill opacity",
  "Outline weight",
  "Which classes to draw",
  "Highlight colour",
  "Label visibility",
  ...MARINE_CLASSES.map((c) => CLASS_LABEL[c]),
];

export default function WaterSection({ settings, actions, isOpen, onToggle }) {
  const water = settings.water;
  const hidden = new Set(water.hiddenClasses);

  return (
    <PanelGroup id="adm-water" title="Water" open={isOpen("adm-water")} onToggle={onToggle}>
      <div className="admin-note">
        Seas, lakes and rivers (Natural Earth, see backend/sources/water_bodies.py). A shape is
        invisible at rest and only fills in on hover or selection -- these two opacity dials are how
        solid that fill is once it does. Lake/river visibility rides its own control-drawer toggles
        (<b>Show lakes</b> / <b>Show rivers</b>, under Water bodies), not the checkboxes below --
        those cover marine sub-kinds only.
      </div>

      <SliderField
        label="Hover fill opacity"
        value={water.hoverFillOpacity}
        defaultValue={0.22}
        min={0}
        max={1}
        step={0.02}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => actions.setWater({ hoverFillOpacity: value })}
      />
      <SliderField
        label="Selected fill opacity"
        value={water.selectedFillOpacity}
        defaultValue={0.32}
        min={0}
        max={1}
        step={0.02}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(value) => actions.setWater({ selectedFillOpacity: value })}
      />
      <SliderField
        label="Outline weight"
        value={water.outlineWeight}
        defaultValue={1}
        min={0.2}
        max={4}
        step={0.1}
        format={(v) => `${v.toFixed(1)}px`}
        onChange={(value) => actions.setWater({ outlineWeight: value })}
      />

      <div className="admin-subhead">Which classes to draw</div>
      <div className="admin-note">
        Unticking a class hides it everywhere on the map, not just here -- a reader looking for
        straits and channels only, say, without the open ocean crowding the same water.
      </div>
      {MARINE_CLASSES.map((cls) => (
        <CheckField
          key={cls}
          label={CLASS_LABEL[cls] || cls}
          checked={!hidden.has(cls)}
          onChange={(checked) => actions.setWaterClassHidden(cls, !checked)}
        />
      ))}

      <div className="admin-subhead">Highlight colours</div>
      <ColorField
        label="Fill (hovered)"
        value={settings.icons.colors["water.fill"]}
        defaultValue={DEFAULT_COLORS["water.fill"]}
        onChange={(value) => actions.setColor("water.fill", value)}
      />
      <ColorField
        label="Outline"
        value={settings.icons.colors["water.outline"]}
        defaultValue={DEFAULT_COLORS["water.outline"]}
        onChange={(value) => actions.setColor("water.outline", value)}
      />
      <ColorField
        label="Selected fill"
        value={settings.icons.colors["water.selected"]}
        defaultValue={DEFAULT_COLORS["water.selected"]}
        onChange={(value) => actions.setColor("water.selected", value)}
      />

      {/* Label visibility is deliberately not offered. Every other shape on
          this map either carries a permanent text label or a Leaflet hover
          tooltip bound to a real DOM element -- water carries neither: it is
          drawn `interactive: false` and hit-tested by the map's own
          ray-cast rather than by the DOM (see map/water.js's own module
          note), so there is no hover event here for a tooltip to bind to and
          no persistent label layer to switch off. Building one is real new
          plumbing, not a dial on an existing feature, and out of this
          task's scope -- a dial that cannot move anything is worse than no
          dial, so this note stands in its place. A water body's name is
          still always available: click it and its card opens. */}
      <div className="admin-note">
        No label-visibility dial: nothing on this layer draws a hover label or a permanent name
        today (see the note in this section's own source for why), so there is nothing here for a
        switch to turn off. A shape's name is always reachable by clicking it open.
      </div>
    </PanelGroup>
  );
}
