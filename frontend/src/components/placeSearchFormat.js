// Small, pure formatting/navigation helpers for the title bar's place-search
// dropdown (Task 34). Kept separate from PlaceSearch.jsx (JSX, not importable
// under plain `node --test` -- see placeInfoCard.test.js's own note on why)
// so the parts of it that are pure functions of the /api/places response
// shape stay headlessly testable.

// GeoNames' own nine feature classes
// (https://www.geonames.org/export/codes.html), spelled out because a single
// letter means nothing to a reader choosing between search results -- "P"
// versus "A" is not obviously "town" versus "region". cities500 (the table
// /api/places searches) is overwhelmingly P, with the admin1/admin2 division
// rows gazetteer.py adds from GeoNames' code tables carrying A.
const FEATURE_CLASS_LABELS = {
  A: "administrative area",
  H: "water feature",
  L: "area",
  P: "populated place",
  R: "road or railroad",
  S: "site or building",
  T: "hill or mountain",
  U: "undersea feature",
  V: "forest or heath",
};

export function featureClassLabel(featureClass) {
  return FEATURE_CLASS_LABELS[featureClass] || featureClass || "place";
}

/**
 * Index wrap-around for ArrowUp/ArrowDown over a results list of `length`
 * items. `current` is -1 when nothing is highlighted yet; `direction` is +1
 * (down) or -1 (up). Wraps at both ends so the list reads as a loop, the same
 * as region-zone-menu's own keyboard picker. Returns -1 (nothing highlighted)
 * for an empty list, so a caller never has to special-case "no results" apart
 * from checking the length itself.
 */
export function nextHighlightedIndex(current, length, direction) {
  if (length <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : length - 1;
  return (current + direction + length) % length;
}

/**
 * "Name (CC-ADMIN1)" -- e.g. "Kyiv (UA-30)". admin1 is GeoNames' own code,
 * not a looked-up division name (the frontend has no admin1-name index to
 * resolve it against -- see the Task 34 report), but a code still disambig-
 * uates: two identically-named places in the same country almost never share
 * one, and combined with country_code this is already enough to tell two
 * Springfields or two Tripolis apart, which is the honesty bar the brief sets.
 */
export function placeResultTitle(result) {
  const cc = result?.country_code || "";
  const admin1 = result?.admin1 || "";
  const code = admin1 ? `${cc}-${admin1}` : cc;
  return code ? `${result?.name ?? ""} (${code})` : (result?.name ?? "");
}

/**
 * "populated place · pop. 2,797,553" -- the feature-class label always
 * present, population appended only when GeoNames actually reported one.
 * Zero is not shown as "pop. 0": cities500 carries real zero-population
 * administrative seats (see gazetteer.py's own comment on this), and
 * printing the figure would read as a measurement rather than as "not
 * stated" -- the same reasoning format.js's fmtNumber leaves to its callers.
 */
export function placeResultSubtitle(result) {
  const parts = [featureClassLabel(result?.feature_class)];
  const population = result?.population;
  if (typeof population === "number" && population > 0) {
    parts.push(`pop. ${population.toLocaleString()}`);
  }
  return parts.join(" · ");
}
