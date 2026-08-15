// Which subject each layer belongs to, for both screens that list layers.
//
// This table used to live inside controlPanel/LayersSection.jsx, where only
// the reader's own checkboxes could see it. Admin Mode's dial list therefore
// had no grouping at all: it walked SETTINGS_LAYERS in declaration order,
// which is roughly the order layers were added to the app, so a subject was
// scattered across the list by whichever publisher it came from. Ships from
// aisstream sat four rows above ships from Fintraffic; the three OpenStreetMap
// infrastructure sweeps sat well below the infrastructure layer they extend.
//
// Copying the table into the admin section would have been the same mistake
// LayerDialsSection.jsx's own header comment already records one tier down --
// "split is how the same dial ended up offered twice" -- so it moves here
// instead and both screens read it. One table, one order, one set of titles.
//
// Imports nothing, deliberately: frontend/tests/*.test.js run under plain
// `node --test` with no build step, and a module that reaches for anything
// browser-shaped cannot be tested there. See map/scene.js for the same rule.

/**
 * The six groups, in the order both screens show them, with the titles the
 * reader's control panel has always used. Two screens that group the same
 * things should name the groups the same way: an operator who has just read
 * "Air & Sea Traffic" in the drawer should not have to work out that some
 * other wording in Admin Mode means the same set.
 *
 * Within a group, key order is display order.
 */
export const LAYER_GROUPS = [
  {
    id: "conflict",
    title: "Conflict & Events",
    // gdelt sits directly after events because that is where the reader draws
    // it -- a sub-row of the layer it qualifies, not a subject of its own. It
    // still needs a dial row of its own here, which is why it is in the table
    // at all; see NOT_COUNTED_IN_READER for what that costs the reader.
    keys: ["events", "gdelt", "conflictHistory", "officials"],
  },
  {
    id: "traffic",
    title: "Air & Sea Traffic",
    // The two GFW layers sit directly after darkVessels: same subject,
    // different publisher, and a reader comparing this map's inference against
    // somebody else's record should not have to hunt for the second one. The
    // Fintraffic feed sits with the aisstream ones for exactly the same
    // reason -- it is the case this whole table was moved here to fix.
    keys: [
      "aisNavy", "aisTanker", "aisCivilian", "aisDigitraffic",
      "darkVessels", "gfwGaps", "gfwDetections",
      "adsbMilitary", "adsbCivilian", "adsbFlagged",
    ],
  },
  {
    id: "ground",
    title: "Infrastructure & Environment",
    // Airfields sit with infrastructure rather than with the aircraft layers:
    // it is a place layer, and the aircraft that need it already get their
    // nearest field named inside their own popup. cities joins them for the
    // same reason -- it is new to this table, since the reader keeps its
    // checkbox in the Places section rather than in Layers.
    //
    // coverage is last, deliberately: it is a diagnostic instrument for
    // reading every other row above it, not one more subject alongside them.
    keys: [
      "infra", "osmInfra", "powerPlants", "airDefense",
      "cities", "airports", "ports", "dams", "deflock",
      "railways", "railLive", "powerLines", "shippingLanes",
      "water", "cables", "firms", "jamming", "laneDensity", "terminator",
      "coverage",
    ],
  },
  {
    id: "airspace",
    title: "Airspace & Aviation",
    // Its own group rather than an eleventh row under traffic: a regulator's
    // ruling about a volume of airspace is neither traffic nor infrastructure,
    // and traffic already carries ten layers.
    keys: ["czib"],
  },
  {
    id: "hazards",
    title: "Natural Hazards",
    keys: ["hazards", "floods"],
  },
  {
    id: "space",
    title: "Space",
    keys: [
      "satellites", "satNavigation", "satWeather", "satImaging",
      "satScience", "satGeo", "satStarlink", "satOneweb", "launches",
    ],
  },
];

/**
 * Filed in a group above, because Admin Mode gives them a dial row, but not
 * drawn as a top-level row in the reader's own Layers section -- so not part
 * of its "n of m" group counts.
 *
 * Two different reasons, both the reader's: gdelt draws as a sub-ticker of
 * Conflict & Violence rather than as a layer in its own right, and cities has
 * its checkbox in the Places section entirely. Counting either would put a
 * denominator on a heading that is larger than the number of checkboxes
 * underneath it, which reads as a missing control.
 *
 * Named here rather than kept as a second array of counted keys: two lists
 * that look alike are two lists that can disagree, which is the failure this
 * whole module exists to stop.
 */
export const NOT_COUNTED_IN_READER = ["gdelt", "cities"];

/** The group id this layer is filed under, or null if it is filed nowhere.
 *  Null is a real answer for an unknown key, not an error -- but for a key
 *  that has a dial row it is a bug, which tests/layerGroups.test.js catches. */
export function layerGroupOf(key) {
  const group = LAYER_GROUPS.find((g) => g.keys.includes(key));
  return group ? group.id : null;
}
