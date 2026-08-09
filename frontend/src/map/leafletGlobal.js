// Leaflet core and its plugins (leaflet.markercluster, leaflet.heat,
// leaflet-velocity) are loaded as plain <script> tags in index.html instead
// of npm packages. Those three plugins predate ESM and work by mutating a
// global `L` (e.g. `L.markerClusterGroup = ...`) -- if we instead
// `import L from "leaflet"` here, the bundler gives every module its own
// copy of the leaflet module, and the CDN-loaded plugin scripts would be
// extending a *different* `L` than the one this app imports, silently
// breaking `L.markerClusterGroup(...)` etc. Reading the single shared
// `window.L` that all four scripts agree on sidesteps that entirely.
export const L = window.L;

if (!L) {
  throw new Error(
    "window.L is missing -- the Leaflet <script> tags in index.html must load before the app bundle."
  );
}

// leaflet-velocity's CanvasLayer arms two callbacks in onAdd that outlive the
// layer, and neither is cancelled by its onRemove:
//
//   setTimeout(() => this._onLayerDidMove(), 0)   -- the last line of onAdd
//   L.Util.requestAnimFrame(this.drawLayer, this) -- via needRedraw(), one line earlier
//
// Both dereference `this._map` with no null check, and Leaflet nulls a layer's
// `_map` the moment it is removed. So any add-and-remove inside a single tick
// leaves a callback that fires against a map that is gone -- React
// StrictMode's dev-only mount/unmount/remount is exactly that shape, which is
// why a plain page load produced a run of
//
//   Uncaught TypeError: Cannot read properties of null
//     (reading 'containerPointToLayerPoint')
//
// with no stack pointing at anything of ours (the plugin is served from a CDN,
// so the browser sanitises it to "Script error."). Harmless in that the map
// being drawn is the *second* one and it is fine -- but it is a torn-down
// map's work still running, it buries real errors in the console, and in
// production it fires on any future unmount too.
//
// The guard goes on the methods the stale callbacks call, because the handles
// are held in closures inside the plugin and cannot be cleared from outside.
// Same reasoning as safeHeatSetLatLngs in createMapController.js: an
// unmaintained plugin missing a null check, worked around at the one place it
// can be.
if (L.CanvasLayer?.prototype) {
  for (const method of ["_onLayerDidMove", "drawLayer"]) {
    const original = L.CanvasLayer.prototype[method];
    if (typeof original !== "function") continue;
    L.CanvasLayer.prototype[method] = function guardedAgainstTeardown(...args) {
      if (!this._map) return undefined; // removed since this was queued; nothing to draw onto
      return original.apply(this, args);
    };
  }
}
