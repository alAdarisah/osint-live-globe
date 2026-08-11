import { SVG } from "../../map/svgIcons";
import { CAPITAL_TIER, CITY_COLOR, CITY_TIERS } from "../../map/decorators";
import { metricById, metricsForTarget, rampSwatches } from "../../map/choropleth";
import LayerIcon from "./LayerIcon";
import LayerCheck from "./LayerCheck";
import { LayerDetails } from "./Collapsible";
import CountUp from "../CountUp";

export default function PlacesSection({
  counts, zoomNotes, layerVisibility, layerWish, onToggleLayer,
  choropleth = { metricId: null, target: "country", covered: 0, total: 0 }, onChoroplethChange,
  // Defaulted for the same reason LayersSection's are -- see Collapsible.jsx.
  isOpen = () => false, setOpen = () => {},
}) {
  // "country" whenever the controller has not reported a target yet (e.g. the
  // very first render, before onChoroplethChange has fired once) -- the
  // shipped default, same as choroplethTarget's own initial value in
  // createMapController.js.
  const target = choropleth.target === "state" ? "state" : "country";
  const metric = metricById(choropleth.metricId);
  const metrics = metricsForTarget(target);
  return (
    <>
      <h2>Places</h2>
      <label className="layer-row" data-layer="countries">
        <LayerCheck
            layerKey="countries"
            on={layerVisibility.countries}
            wish={layerWish?.countries}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.globe} color="#6fe3ff" /> Countries
        <span className="count"><CountUp value={counts.countries} /> (<CountUp value={counts.countriesTotal} />)</span>
      </label>

      {/* Started as country-only: several country-keyed datasets were already
          being fetched and shown only as sentences inside the country card,
          which is what a shape can express and a pin cannot. Task 26 added a
          target selector -- states paint from admin-1 boundaries the same
          way, once a country with subdivisions is selected. Off by default in
          either target: a permanently tinted world would compete with every
          pin drawn on top of it. */}
      <div className="event-filters choropleth-picker">
        <label>
          Paint by
          <select
            value={target}
            onChange={(e) => onChoroplethChange(null, e.target.value)}
          >
            <option value="country">Countries</option>
            <option value="state">States</option>
          </select>
        </label>
        <label>
          {/* No visibility flag gates the state option: unlike the countries
              layer, admin-1 shapes have no checkbox of their own -- selecting
              a country with subdivisions *is* the request for them (see
              subdivisions.js) -- so there is nothing here to disable against. */}
          <select
            value={choropleth.metricId || "none"}
            disabled={target === "country" && !layerVisibility.countries}
            onChange={(e) => onChoroplethChange(e.target.value === "none" ? null : e.target.value, target)}
          >
            <option value="none">Nothing</option>
            {metrics.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

      {metric && (
        <div className="sublegend choropleth-legend">
          <span className="choropleth-ramp">
            less
            {rampSwatches().map((s) => (
              <i key={s.t} style={{ background: s.color, opacity: s.opacity + 0.25 }} />
            ))}
            more
          </span>
          {/* The two numbers that decide whether a blank map means "nothing
              here" or "nobody looked". Most metrics cover only part of the
              world (or, for the state target, only the countries currently
              selected), and an unpainted shape is deliberately drawn the
              same as it always was -- distinct from one measured at zero. */}
          <span className="choropleth-coverage">
            {`${choropleth.covered} of ${choropleth.total} ${target === "state" ? "states" : "countries"} `
              + "have a value; the rest are unpainted"}
          </span>
          <span className="choropleth-note">{metric.note}</span>
        </div>
      )}
      {/* The admin-2 conflict archive has no row here, and that is deliberate.
          It is a monthly record weeks old by construction, over six countries,
          and as a tint it was a second choropleth competing with the live map
          for the same eye. It is now read where the question is actually asked:
          click a country, then a state, then one of its districts, and the card
          gives all four counts with its own month selector (see districts.js). */}

      <label className="layer-row" data-layer="cities">
        <LayerCheck
            layerKey="cities"
            on={layerVisibility.cities}
            wish={layerWish?.cities}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.city} color={CITY_COLOR} token="city.mega" /> Cities (100k+)
        <span className="count"><CountUp value={counts.cities} /> (<CountUp value={counts.citiesTotal} />)</span>
      </label>
      <div id="citiesZoomNote" className={`sublegend${zoomNotes.cities ? " visible" : ""}`}>
        {zoomNotes.citiesScoped ? "Zoom in to show cities" : "Select a country or conflict zone to show cities"}
      </div>
      {/* Driven straight off CITY_TIERS, so the legend cannot drift from what
          the map draws -- the swatch above used to be green while every city on
          the map was pink. */}
      <LayerDetails id="det-cities" open={isOpen("det-cities")} onToggle={setOpen}>
        <div className="sublegend">
          {/* Capital leads: it is not a population band, it is the one status
              that overrides them, and it is what the diplomacy layer anchors to. */}
          {[CAPITAL_TIER, ...CITY_TIERS].map((tier) => (
            <span key={tier.key}>
              <LayerIcon svg={tier.svg} color={CITY_COLOR} token={tier.token} />
              {tier.label}
            </span>
          ))}
        </div>
      </LayerDetails>
    </>
  );
}
