// The country selection, turned into a predicate the read-out panels can
// apply.
//
// Clicking a country on the map already scopes the cities layer and the war
// flare (see createMapController.js's selectCountryEntry). This is the same
// selection expressed as "is this record in scope", so the notable-activity
// board and the live news ticker can answer for the selected country instead
// of for the whole viewport.
//
// Scoping is by geometry rather than by whatever country string a feed happens
// to carry: ACLED writes country names, GDELT writes FIPS 10-4 codes, and the
// two disagree often enough (and about exactly the contested places this map
// is for) that matching on either would quietly drop events. A point-in-polygon
// test against the shape the reader actually clicked cannot disagree with the
// map, which is the same reason NotableEventsPanel reuses the map's own
// severity filter rather than reimplementing one.
//
// This narrows the *presentation* only. Nothing here touches what the map
// draws or what the poller fetches -- deselect the country and the full picture
// is still there, unfetched and unfiltered.
import { countryContainsPoint } from "./countryHitTest";

const INACTIVE = {
  active: false,
  label: null,
  keys: "",
  contains: () => true,
  intersectsBounds: () => true,
};

/** Do two [south, west, north, east] / bbox pairs overlap at all? */
function bboxIntersects(bbox, south, west, north, east) {
  return !(
    bbox.maxLat < south || bbox.minLat > north || bbox.maxLon < west || bbox.minLon > east
  );
}

/**
 * @param {Array} selection  mapApi.countrySelection -- {key, name, bbox, polygons}
 * @returns {{active: boolean, label: ?string, keys: string,
 *            contains: (lat: number, lon: number) => boolean,
 *            intersectsBounds: (bounds: number[]) => boolean}}
 *   An inactive scope when nothing is selected (or the geometry hasn't landed
 *   yet), whose predicates pass everything -- so a caller can apply the scope
 *   unconditionally and get world-view behaviour for free.
 */
export function makeCountryScope(selection) {
  const countries = (selection || []).filter((c) => c?.bbox && c.polygons?.length);
  if (!countries.length) return INACTIVE;

  return {
    active: true,
    // One country is named; several are counted, because three country names
    // in a panel header is a header nobody reads. The chips in
    // CountrySelectionBar are where the full list lives.
    label: countries.length === 1 ? countries[0].name : `${countries.length} countries`,
    // A stable identity for the current scope, for effects that should fire
    // once per selection change rather than once per render.
    keys: countries.map((c) => c.key).join(","),
    contains(lat, lon) {
      if (typeof lat !== "number" || typeof lon !== "number") return false;
      return countries.some((c) => countryContainsPoint(c, lat, lon));
    },
    // For region-shaped things (escalation zones), which have bounds rather
    // than a point. Deliberately generous: a zone that merely overlaps the
    // country stays on the board, since "the fighting next door is spiking" is
    // exactly the context a country view should keep.
    intersectsBounds(bounds) {
      if (!Array.isArray(bounds) || bounds.length !== 4) return false;
      const [south, west, north, east] = bounds;
      return countries.some((c) => bboxIntersects(c.bbox, south, west, north, east));
    },
  };
}
