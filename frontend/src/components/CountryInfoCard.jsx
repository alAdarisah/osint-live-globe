// Persistent country details panel -- replaces the old Leaflet popup on
// country click (see createMapController.js's countriesLayer click
// handler) so the map keeps panning/zooming freely while it's open, instead
// of the popup auto-closing/panning on every interaction. Reuses the same
// countryPopupHtml() markup the old popup rendered, just hosted in a fixed
// React panel instead of a layer-bound Leaflet popup.
export default function CountryInfoCard({ country, onClose }) {
  if (!country) return null;
  return (
    <aside id="countryInfoCard">
      <button type="button" className="country-info-close" onClick={onClose} aria-label="Close">
        &times;
      </button>
      <div className="country-info-body" dangerouslySetInnerHTML={{ __html: country.html }} />
    </aside>
  );
}
