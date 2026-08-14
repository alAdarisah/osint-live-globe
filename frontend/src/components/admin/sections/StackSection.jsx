// What draws over what.
//
// Arrows rather than drag-and-drop. A drag needs pointer capture, an autoscroll
// and a drop indicator to be usable at all, and this list lives inside a panel
// that is itself draggable by its header -- two nested drag gestures is a bug
// report waiting to be filed. Two buttons per row are unambiguous, work from the
// keyboard, and are one click each for the only move anyone makes.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField } from "../fields";
import { defaultSettings } from "../../../settings/defaults";
import { STACK_LABEL } from "./shared";

const DEFAULTS = defaultSettings();

export const SEARCH_TERMS = [
  "Layer order",
  "Depth fade",
  "Pins",
  "Washes",
  "Back to the shipped order",
  ...Object.values(STACK_LABEL),
];

export default function StackSection({ settings, actions, isOpen, onToggle }) {
  const floor = settings.ui.stackFadeFloor;
  return (
    <PanelGroup id="adm-stack" title="Layer order" open={isOpen("adm-stack")} onToggle={onToggle}>
      <div className="admin-note">
        What draws over what, top of the list first. Position also sets how much a layer is faded:
        the top of a group is drawn at full strength and the bottom at the depth below, so pushing
        reference material down makes it recede behind the layers it is context for. That fade is a
        multiplier on each layer&apos;s own opacity, not a replacement for it.
      </div>
      <SliderField
        label="Depth fade"
        value={floor}
        defaultValue={DEFAULTS.ui.stackFadeFloor}
        min={0.1}
        max={1}
        step={0.05}
        format={(v) => (v >= 1 ? "off" : `${Math.round(v * 100)}% at the bottom`)}
        onChange={(value) => actions.setUi({ stackFadeFloor: value })}
      />

      <StackList
        group="pins"
        title="Pins"
        order={settings.layerStack.pins}
        floor={floor}
        onMove={actions.moveLayerInStack}
      />
      <StackList
        group="washes"
        title="Washes"
        order={settings.layerStack.washes}
        floor={1}
        onMove={actions.moveLayerInStack}
      />
      <div className="admin-note">
        Two lists because the map draws in two ways, and they do not interleave. Every pin is an
        element in one Leaflet pane; the washes are canvases in the pane below it, so a wash is
        always beneath every pin however either list is ordered. Country shapes and the district
        choropleth are not here at all &mdash; they are the substrate the rest is drawn on.
      </div>
      <button type="button" className="admin-wide-btn" onClick={actions.resetLayerStack}>
        Back to the shipped order
      </button>
    </PanelGroup>
  );
}

function StackList({ group, title, order, floor, onMove }) {
  return (
    <>
      <div className="admin-subhead">{title}</div>
      {order.map((key, index) => (
        <div className="admin-stack-row" key={key}>
          <span className="admin-stack-rank">{index + 1}</span>
          <span className="admin-stack-name">{STACK_LABEL[key] || key}</span>
          <span className="admin-stack-fade">
            {order.length < 2
              ? "100%"
              : `${Math.round((1 - (1 - floor) * (index / (order.length - 1))) * 100)}%`}
          </span>
          <button
            type="button"
            disabled={index === 0}
            onClick={() => onMove(group, key, -1)}
            aria-label={`Move ${STACK_LABEL[key] || key} up`}
            title="Draw this over the layer above it"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={index === order.length - 1}
            onClick={() => onMove(group, key, 1)}
            aria-label={`Move ${STACK_LABEL[key] || key} down`}
            title="Draw this under the layer below it"
          >
            ↓
          </button>
        </div>
      ))}
    </>
  );
}
