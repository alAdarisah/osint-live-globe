// Persistent country details panel -- replaces the old Leaflet popup on
// country click (see createMapController.js's countriesLayer click
// handler) so the map keeps panning/zooming freely while it's open, instead
// of the popup auto-closing/panning on every interaction. Reuses the same
// countryPopupHtml() markup the old popup rendered, just hosted in a React
// panel instead of a layer-bound Leaflet popup.
//
// Positioned as a widget popping out of the clicked country rather than a
// fixed corner panel: `country.point` is the country's current on-screen
// pixel (kept live across pan/zoom by onCountryPointChange, see
// useLeafletMap.js), and the card centers itself above that point with a
// CSS arrow (.country-info-tail) pointing back down at it. Clamped to the
// viewport so a country near a screen edge doesn't push the card off-screen.
const CARD_WIDTH = 320;
const CARD_MARGIN = 14;

export default function CountryInfoCard({ country, onClose }) {
  if (!country?.point) return null;
  const { x, y } = country.point;
  const left = Math.min(Math.max(x - CARD_WIDTH / 2, CARD_MARGIN), window.innerWidth - CARD_WIDTH - CARD_MARGIN);
  const tailLeft = Math.min(Math.max(x - left, 16), CARD_WIDTH - 16); // tail stays under the actual anchor even after clamping
  const flip = y < 220; // not enough room above the anchor near the top edge -- open downward instead
  const style = flip
    ? { left, top: y + 18 }
    : { left, bottom: window.innerHeight - y + 18 };
  return (
    <aside id="countryInfoCard" className={flip ? "flip" : ""} style={style}>
      <button type="button" className="country-info-close" onClick={onClose} aria-label="Close">
        &times;
      </button>
      <div className="country-info-body" dangerouslySetInnerHTML={{ __html: country.html }} />
      <div className="country-info-tail" style={{ left: tailLeft }} />
    </aside>
  );
}
