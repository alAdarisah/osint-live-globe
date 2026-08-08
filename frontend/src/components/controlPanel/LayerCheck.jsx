// One layer's checkbox, showing all three states it can actually be in.
//
// A layer is not on or off. It is on or off *for a reason*, and there are three:
//
//   the resolver decided     nobody has touched it; what is drawn follows the
//                            zoom, what the camera is over and what has been
//                            clicked (see map/scene.js). Drawn indeterminate --
//                            the standard idiom for "not your call".
//   pinned on                someone ticked it, and that outranks the resolver
//                            until it is handed back.
//   pinned off               someone unticked it, likewise.
//
// The panel had no way to tell the first from the other two. That mattered more
// once a tick started being saved to the shared configuration: a box that looked
// ticked because the resolver happened to want the layer here, and a box that
// was ticked because an operator decided it for every reader of this deployment,
// are very different facts and they looked identical.
//
// `checked` stays "what the map is actually doing" rather than "what was asked
// for", which is the contract useLeafletMap documents and the reason it mirrors
// controller state rather than a React copy. The pin marker carries the intent
// alongside it, so both are readable at once -- and the one case where they
// disagree is exactly the one worth seeing:
//
//   pinned on, drawing nothing -- held back by its own zoom gate, which is a
//   real arrangement (see applyScene) and used to look like a broken tick.

import { useEffect, useRef } from "react";

/**
 * @param {string} layerKey
 * @param {boolean} on         what the map is currently drawing
 * @param {boolean|undefined} wish  the reader's standing decision, if any
 * @param {(key: string, next: boolean|null) => void} onToggle  null hands it back
 * @param {boolean} [disabled]  the weather tiles with no API key configured
 */
export default function LayerCheck({ layerKey, on, wish, onToggle, ariaLabel, disabled = false }) {
  const ref = useRef(null);
  const pinned = wish !== undefined;

  // `indeterminate` is a DOM property, not an attribute -- React cannot set it
  // from JSX, so it has to be written after every render that could change it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !pinned;
  }, [pinned, on]);

  const withheld = wish === true && !on;
  const title = !pinned
    ? "Chosen by the scene: zoom, what the camera is over, and what you have clicked. Tick to override."
    : withheld
      ? "Pinned on, but held back by this layer's zoom gate — zoom in, or lower the gate in Admin Mode."
      : wish
        ? "Pinned on. Overrides the scene for every reader of this deployment."
        : "Pinned off. Overrides the scene for every reader of this deployment.";

  return (
    <>
      <input
        ref={ref}
        type="checkbox"
        className={`layer-check${pinned ? " pinned" : ""}${withheld ? " withheld" : ""}`}
        checked={!!on}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
        onChange={(e) => onToggle(layerKey, e.target.checked)}
      />
      {/* Only on a pinned row, because it is the only row with anything to hand
          back. Inside the <label> but with its own click handler: the label
          would otherwise forward the click to the checkbox and re-pin the layer
          the moment it was released. */}
      {pinned && !disabled && (
        <button
          type="button"
          className="layer-unpin"
          title="Hand this layer back to the scene"
          aria-label={`Hand ${ariaLabel || layerKey} back to the scene`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggle(layerKey, null);
          }}
        >
          ↺
        </button>
      )}
    </>
  );
}
