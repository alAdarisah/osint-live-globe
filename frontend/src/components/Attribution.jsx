// Who the data belongs to, and what this map is not.
//
// Two obligations in one cell, and they are not the same kind of thing: the
// source credits are a licence condition, and the last sentence is the one
// editorial statement on the whole screen that must never be lost.
//
// The plain text is exported because the cell it lives in shrinks. In the HUD it
// is `flex: 1 1 auto` with `text-overflow: ellipsis`, and on anything narrower
// than about 1400px the disclaimer is the part that goes -- it is at the end.
// chrome.css claimed twice, in two separate comments, that the full text was kept
// as a tooltip; it was not, and there was no title anywhere. So the string lives
// here, next to the markup it mirrors, and attribution.test.js holds the two to
// each other.

/** The disclaimer, on its own, because it is the part that has to survive. */
export const ATTRIBUTION_DISCLAIMER =
  "Not a source of authoritative military intelligence — verify before acting on anything shown here.";

/** Everything the footer says, as plain text: the tooltip, and the string the
 *  Legend repeats for readers on a touch screen, where a tooltip never fires. */
export const ATTRIBUTION_TEXT =
  "Data: ACLED · NASA FIRMS · aisstream.io · GDELT Project · OpenSky Network · World Bank · "
  + "GeoNames · Natural Earth. Weather data by RainViewer · OpenWeatherMap · Open-Meteo.com. "
  + `Map: © OpenStreetMap contributors © CARTO. ${ATTRIBUTION_DISCLAIMER}`;

export default function Attribution() {
  return (
    <footer id="attribution">
      Data: ACLED &middot; NASA FIRMS &middot; aisstream.io &middot; GDELT Project &middot; OpenSky Network &middot; World Bank &middot; GeoNames &middot; Natural Earth.
      Weather data by{" "}
      <a href="https://www.rainviewer.com" target="_blank" rel="noopener noreferrer">
        RainViewer
      </a>{" "}
      &middot; OpenWeatherMap &middot;{" "}
      <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer">
        Open-Meteo.com
      </a>
      . Map: &copy; OpenStreetMap contributors &copy; CARTO. Not a source of authoritative military intelligence &mdash; verify before acting on
      anything shown here.
    </footer>
  );
}
