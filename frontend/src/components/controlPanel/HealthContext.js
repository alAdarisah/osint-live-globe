// Task 32 item 1: "last-updated per layer" -- every layer row in the control
// panel shows how stale its data is, using the same /api/health this app
// already collects (source_health's last_success/seconds_since_success),
// which used to be Admin-Mode-only (see useHealth.js).
//
// A context rather than a `health` prop threaded through LayersSection and
// every one of its ~40 individual <LayerCheck> call sites: LayerCheck.jsx
// already receives `layerKey` at each of them, which is the only other thing
// a freshness lookup needs, and a prop-drilled `health` would mean touching
// every row in LayersSection.jsx for a value none of those rows otherwise
// cares about. ControlPanel.jsx provides it once, at the top of the panel;
// LayerCheck reads it, also once.
//
// No context exists anywhere else in this codebase (every other cross-
// component value is a prop, passed down from App.jsx) -- this is a
// deliberate, narrow exception for exactly the fan-out problem above, not a
// pattern this task means to generalise.
import { createContext, useContext } from "react";

const HealthContext = createContext({});

export const HealthProvider = HealthContext.Provider;

export function useLayerHealth() {
  return useContext(HealthContext);
}
