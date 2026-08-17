// Thin host for the Leaflet map -- all the actual map logic lives in
// useLeafletMap.js + src/map/createMapController.js. This component just gives
// them a DOM node to mount into.
//
// It used to carry a `panelOpen` prop and mirror it onto a `.panel-open` class,
// which is how the map knew to shift its left edge by the drawer's 320px. There
// are now two things that can claim the left rail (the drawer and the intel
// feed) and both express it as one custom property, --chrome-left, which the
// map's own rule reads directly -- so there is nothing left for this component
// to reflect. See hooks/chromeLayout.js.
export default function MapView({ containerRef }) {
  return <div id="map" ref={containerRef} />;
}
