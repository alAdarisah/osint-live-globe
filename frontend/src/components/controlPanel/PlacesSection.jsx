import { SVG } from "../../map/svgIcons";
import { CITY_COLOR, CITY_TIERS } from "../../map/decorators";
import LayerIcon from "./LayerIcon";

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
        <LayerIcon svg={SVG.globe} color="#6fe3ff" /> Countries
        <span className="count">{counts.countries} ({counts.countriesTotal})</span>
      </label>
      <label className="layer-row" data-layer="cities">
        <input
          type="checkbox"
          checked={layerVisibility.cities}
          onChange={(e) => onToggleLayer("cities", e.target.checked)}
        />
        <LayerIcon svg={SVG.city} color={CITY_COLOR} /> Cities (100k+)
        <span className="count">{counts.cities} ({counts.citiesTotal})</span>
      </label>
      {/* Driven straight off CITY_TIERS, so the legend cannot drift from what
          the map draws -- the swatch above used to be green while every city on
          the map was pink. */}
      <div className="sublegend">
        {CITY_TIERS.map((tier) => (
          <span key={tier.key}>
            <LayerIcon svg={tier.svg} color={CITY_COLOR} />
            {tier.label}
          </span>
        ))}
      </div>
      <div id="citiesZoomNote" className={`sublegend${zoomNotes.cities ? " visible" : ""}`}>
        {zoomNotes.citiesScoped ? "Zoom in to show cities" : "Select a country or conflict zone to show cities"}
      </div>
    </>
  );
}
