import { GIBS_LAYERS, gibsDateFor } from "../../map/layers";

// Satellite imagery under the map, from NASA GIBS. A select rather than a set
// of checkboxes because the options are mutually exclusive -- two true-colour
// basemaps stacked on each other is not a state worth being able to reach.
//
// The date is deliberately not a control here: it follows the replay scrubber
// (see App.jsx), so there is one timeline for the whole map rather than two
// that can disagree.
const ORDER = ["modis", "viirs", "night"];

export default function ImagerySection({ imageryKey, imageryDate, onImageryChange }) {
  const active = imageryKey ? GIBS_LAYERS[imageryKey] : null;
  // What is actually on screen, which is not always what was asked for: the
  // day/night band runs about three days behind (see gibsDateFor).
  const shownDate = active ? gibsDateFor(imageryKey, imageryDate) : imageryDate;
  const clamped = active && shownDate !== imageryDate;
  return (
    <>
      <h2>Satellite imagery</h2>
      <label className="imagery-select">
        <select
          value={imageryKey || "off"}
          onChange={(e) => onImageryChange(e.target.value === "off" ? null : e.target.value)}
        >
          <option value="off">Off — vector basemap</option>
          {ORDER.map((key) => (
            <option key={key} value={key}>{GIBS_LAYERS[key].label}</option>
          ))}
        </select>
      </label>
      {active ? (
        <>
          <div className="sublegend">{active.note}</div>
          <div className="sublegend">
            Showing <b>{shownDate}</b> (UTC). The date follows the timeline at the bottom of the screen, so
            scrubbing back moves the imagery with everything else.{" "}
            {clamped
              ? `This product runs about ${active.lagDays} days behind, so ${imageryDate} is not published yet and the newest available day is shown instead.`
              : "Same-day coverage is partial — each product is built as the satellite’s passes come down, a few hours behind."}
          </div>
          <div className="sublegend">Source: NASA EOSDIS GIBS. Free, keyless, and the same imagery Worldview serves.</div>
        </>
      ) : (
        <div className="sublegend">
          Puts a real satellite pass under the map for a chosen day. Night lights is the one to reach for
          after a strike on a grid: a city bright last week and dark tonight shows up directly.
        </div>
      )}
    </>
  );
}
