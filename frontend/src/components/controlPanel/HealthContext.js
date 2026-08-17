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
//
// The provider moved from ControlPanel.jsx up to App.jsx when the same
// LayerCheck rows appeared a second time, in the top bar's category pills. Two
// providers would have been two copies of one value; a provider on the drawer
// alone would have meant the pills' rows silently reading `{}` -- and a
// freshness tooltip that is simply absent is the kind of failure nobody
// notices, because a tooltip that never appears looks exactly like one that has
// nothing to say.
import { createContext, useContext } from "react";

const HealthContext = createContext({});

export const HealthProvider = HealthContext.Provider;

export function useLayerHealth() {
  return useContext(HealthContext);
}

// ---------------------------------------------------------------------------
// Which store a tick from a given surface lands in.
//
// The drawer writes to the shared data/admin_config.json and reaches every
// reader of this deployment; the category pills write to the session's own
// override table and reach nobody else. LayerCheck has to say which, and the
// two surfaces are far apart in the tree with 34 hand-authored rows in between,
// so this rides beside the health context rather than being threaded as a prop
// through every one of them -- the same fan-out argument, the same answer.
//
// Defaults to "session": the safe direction. A surface that forgets to declare
// itself understates its reach rather than promising a reader they have changed
// what everyone else sees.
const LayerScopeContext = createContext("session");

export const LayerScopeProvider = LayerScopeContext.Provider;

export function useLayerScope() {
  return useContext(LayerScopeContext);
}
