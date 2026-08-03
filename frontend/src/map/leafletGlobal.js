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
