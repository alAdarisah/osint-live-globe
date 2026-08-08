import { SVG } from "../../map/svgIcons";
import { CAPITAL_TIER, CITY_COLOR, CITY_TIERS } from "../../map/decorators";
import { CHOROPLETH_METRICS, metricById, rampSwatches } from "../../map/choropleth";
import { DISTRICT_METRICS, DISTRICT_COUNTRIES } from "../../map/districts";
import LayerIcon from "./LayerIcon";
import LayerCheck from "./LayerCheck";
import { LayerDetails } from "./Collapsible";

export default function PlacesSection({
  counts, zoomNotes, layerVisibility, layerWish, onToggleLayer,
  choropleth = { metricId: null, covered: 0, total: 0 }, onChoroplethChange,
  districts = { metricId: "fatalities", month: null, districts: 0 },
  districtMonths = [], onDistrictMetricChange, onDistrictMonthChange,
  // Defaulted for the same reason LayersSection's are -- see Collapsible.jsx.
  isOpen = () => false, setOpen = () => {},
}) {
  const metric = metricById(choropleth.metricId);
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
        <span className="count">{counts.countries} ({counts.countriesTotal})</span>
      </label>

      {/* Four country-keyed datasets were already being fetched and then shown
          only as sentences inside the country card. All of them are national
          aggregates, which is what a shape can express and a pin cannot.
          Off by default: a permanently tinted world would compete with every
          pin drawn on top of it. */}
      <div className="event-filters choropleth-picker">
        <label>
          Paint countries by
          <select
            value={choropleth.metricId || "none"}
            disabled={!layerVisibility.countries}
            onChange={(e) => onChoroplethChange(e.target.value === "none" ? null : e.target.value)}
          >
            <option value="none">Nothing</option>
            {CHOROPLETH_METRICS.map((m) => (
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
              here" or "nobody looked". Four of the six metrics cover only part
              of the world, and an unpainted country is deliberately drawn the
              same as it always was -- distinct from one measured at zero. */}
          <span className="choropleth-coverage">
            {`${choropleth.covered} of ${choropleth.total} countries have a value; the rest are unpainted`}
          </span>
          <span className="choropleth-note">{metric.note}</span>
        </div>
      )}
      {/* The reviewed district record, at admin-2. Its own month rather than
          the replay scrubber: that bar drives a 3-day hourly window over live
          layers and suppresses live polling while it runs, and this is a
          24-month monthly archive. One control with two incompatible clocks
          would be a mode flag pretending to be a timeline. */}
      <label className="layer-row" data-layer="districts">
        <LayerCheck
          layerKey="districts"
          on={!!layerVisibility.districts}
          wish={layerWish?.districts}
          onToggle={onToggleLayer}
        />
        <LayerIcon svg={SVG.globe} color="#c026d3" token="choropleth.high" /> Districts &mdash; conflict record
        <span className="count">{districts.districts}</span>
      </label>

      {layerVisibility.districts && (
        <>
          <div className="event-filters district-picker">
            <label>
              Show
              <select
                value={districts.metricId}
                onChange={(e) => onDistrictMetricChange(e.target.value)}
              >
                {DISTRICT_METRICS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label>
              Month
              <select
                value={districts.month || ""}
                disabled={!districtMonths.length}
                onChange={(e) => onDistrictMonthChange(e.target.value)}
              >
                {districtMonths.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
          <div className="sublegend choropleth-legend">
            <span className="choropleth-ramp">
              less
              {rampSwatches().map((s) => (
                <i key={s.t} style={{ background: s.color, opacity: s.opacity + 0.25 }} />
              ))}
              more
            </span>
            {/* Six countries, not the world -- and a district with no record is
                left unpainted while a district reporting zero is painted at the
                bottom of the ramp. Those are different claims and the layer
                draws them differently. */}
            <span className="choropleth-coverage">
              {`${districts.districts} districts reported in ${districts.month || "—"}`}
            </span>
            <span className="choropleth-note">
              {`ACLED via HDX HAPI, joined to OCHA district boundaries on p-code. Covers `
                + `${DISTRICT_COUNTRIES.join(", ")}. A reviewed monthly archive that runs to the end `
                + `of a past month — not the live conflict layer, and not comparable to it.`}
            </span>
          </div>
        </>
      )}

      <label className="layer-row" data-layer="cities">
        <LayerCheck
            layerKey="cities"
            on={layerVisibility.cities}
            wish={layerWish?.cities}
            onToggle={onToggleLayer}
          />
        <LayerIcon svg={SVG.city} color={CITY_COLOR} /> Cities (100k+)
        <span className="count">{counts.cities} ({counts.citiesTotal})</span>
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
              <LayerIcon svg={tier.svg} color={CITY_COLOR} />
              {tier.label}
            </span>
          ))}
        </div>
      </LayerDetails>
    </>
  );
}
