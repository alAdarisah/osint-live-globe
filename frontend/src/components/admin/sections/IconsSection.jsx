// The one global size multiplier every marker inherits, and the three "start
// over" buttons. Narrower dials -- a single layer's own size, or a single pin
// type's -- live under Layers, beside the layer they belong to (see
// LayerDialsSection.jsx).
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField } from "../fields";

export const SEARCH_TERMS = [
  "Global icon size",
  "Icon size",
  "Reset all colours",
  "Reset all sizes",
  "Reset all zooms",
];

export default function IconsSection({ settings, actions, isOpen, onToggle }) {
  return (
    <PanelGroup id="adm-icons" title="Global icon size" open={isOpen("adm-icons")} onToggle={onToggle}>
      <SliderField
        label="Icon size"
        value={settings.icons.scale}
        defaultValue={1}
        min={0.4}
        max={3}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={actions.setIconScale}
      />
      <div className="admin-note">
        Scales every marker, and the spacing the declutter pass reserves for it, so pins stay
        separated at any size. Everything narrower than this &mdash; a layer’s own size, its
        opacity, its zoom gate, and the colour of each kind of pin in it &mdash; lives under
        <b> Layers</b> below, beside the layer it belongs to.
      </div>
      <div className="admin-row">
        <button type="button" onClick={actions.resetColors}>Reset all colours</button>
        <button type="button" onClick={actions.resetSizes}>Reset all sizes</button>
        <button type="button" onClick={actions.resetZooms}>Reset all zooms</button>
      </div>
    </PanelGroup>
  );
}
