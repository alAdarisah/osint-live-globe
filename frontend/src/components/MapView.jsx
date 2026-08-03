// Thin host for the Leaflet map -- all the actual map logic lives in
// useLeafletMap.js + src/map/createMapController.js. This component just
// gives them a DOM node to mount into and reflects the side-panel state via
// the same CSS class the map's own transition (see #map.panel-open in
// style.css) already keys off.
export default function MapView({ containerRef, panelOpen }) {
  return <div id="map" ref={containerRef} className={panelOpen ? "panel-open" : ""} />;
}
