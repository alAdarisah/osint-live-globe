export default function PlacesSection({ counts, zoomNotes, layerVisibility, onToggleLayer }) {
  return (
    <>
      <h2>Places</h2>
      <label className="layer-row" data-layer="countries">
        <input
          type="checkbox"
          checked={layerVisibility.countries}
          onChange={(e) => onToggleLayer("countries", e.target.checked)}
        />
        <span className="swatch swatch-countries" /> Countries
        <span className="count">{counts.countries} ({counts.countriesTotal})</span>
      </label>
      <label className="layer-row" data-layer="cities">
        <input
          type="checkbox"
          checked={layerVisibility.cities}
          onChange={(e) => onToggleLayer("cities", e.target.checked)}
        />
        <span className="swatch swatch-cities" /> Cities (100k+)
        <span className="count">{counts.cities} ({counts.citiesTotal})</span>
      </label>
      <div id="citiesZoomNote" className={`sublegend${zoomNotes.cities ? " visible" : ""}`}>
        {zoomNotes.citiesScoped ? "Zoom in to show cities" : "Select a country or conflict zone to show cities"}
      </div>
    </>
  );
}
