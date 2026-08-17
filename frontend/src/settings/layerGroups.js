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
// instead and both screens read it: one table, one set of keys, one set of
// titles.
//
// Order is only one of those three, and deliberately not shared. Admin Mode
// walks this table directly, so its group order IS this table's order. The
// reader's control drawer does not: its six groups are still six hand-written
// PanelGroup elements in LayersSection.jsx, each full of its own hand-written
// checkbox rows, and reading that order out of this table would mean either
// restructuring 1500 lines of JSX to be generated from data, or maintaining a
// second ordering that could drift from the first. So the reader's *order* of
// groups is authored by hand, in LayersSection.jsx, where the PanelGroup
// elements happen to sit -- only each group's *title* and *membership* are
// read from here, via groupTitle() and countedKeysFor() below.
//
// Two of the eight groups have no reader-side PanelGroup at all -- weather's
// checkboxes are in WeatherSection.jsx and reference's are in PlacesSection.jsx.
// They are still groups: the pill strip and Admin Mode's dial list both walk
// this table, and a subject with no entry here is a subject those two screens
// cannot show. See each group's own note.
//
// Adding a layer is therefore a two-step job, not a one-step one: file the key
// in a group below, and -- if the reader draws no top-level checkbox for it,
// the way it does not for gdelt or cities -- also add it to
// NOT_COUNTED_IN_READER, or its group's reader-side heading will silently
// count a checkbox that is not there. tests/layerGroups.test.js pins each
// group's counted length as a fixture for exactly this reason: a change to
// that number should always be a deliberate line in a diff, matched by an
// added or removed checkbox in LayersSection.jsx, never a silent side effect
// of filing a new layer.
//
// Imports nothing, deliberately: frontend/tests/*.test.js run under plain
// `node --test` with no build step, and a module that reaches for anything
// browser-shaped cannot be tested there. See map/scene.js for the same rule.

/**
 * The eight groups, in the order Admin Mode shows them (see the header comment
 * above for why the reader's own group order is authored separately), with
 * the titles the reader's control panel has always used. Three screens that
 * group the same things should name the groups the same way: an operator who
 * has just read "Air & Sea Traffic" in the drawer should not have to work out
 * that some other wording in Admin Mode means the same set.
 *
 * Within a group, key order is display order on both screens.
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
      "aisNavy", "aisTanker", "aisCivilian", "aisDigitraffic", "marinesia",
      "darkVessels", "gfwGaps", "gfwDetections",
      "adsbMilitary", "adsbCivilian", "adsbFlagged",
    ],
  },
  {
    id: "ground",
    title: "Infrastructure & Environment",
    // Airfields sit with infrastructure rather than with the aircraft layers:
    // it is a place layer, and the aircraft that need it already get their
    // nearest field named inside their own popup. cities used to sit here for
    // the same reason and has moved to `reference` below, which is where a
    // reader looking for place labels actually looks.
    //
    // coverage is last, deliberately: it is a diagnostic instrument for
    // reading every other row above it, not one more subject alongside them.
    keys: [
      "infra", "osmInfra", "powerPlants", "airDefense",
      "airports", "ports", "dams", "deflock",
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
    id: "weather",
    // Between hazards and space, which is where the reader asked for it, and it
    // happens to be the right place on the merits too: an earthquake and a storm
    // front are both "the physical world doing something", and the pill order is
    // read left to right as roughly conflict -> traffic -> ground -> sky.
    //
    // Weather is the one group whose layers have no Admin Mode dial rows, because
    // six of the seven are raster tile overlays (OpenWeatherMap) and the seventh
    // is a particle field -- none has a pin size, a pin colour or a zoom gate to
    // dial. They are in this table anyway: the taxonomy's job is "which subject
    // is this layer", and weather has been a subject in the reader's drawer since
    // long before it was one here. LayerDialsSection.jsx skips a group with no
    // dial rows rather than drawing an empty heading.
    title: "Weather",
    keys: ["precip", "clouds", "wind", "precipitation", "temp", "pressure", "windArrows"],
  },
  {
    id: "space",
    title: "Space",
    keys: [
      "satellites", "satNavigation", "satWeather", "satImaging",
      "satScience", "satGeo", "satStarlink", "satOneweb", "launches",
    ],
  },
  {
    id: "reference",
    // The base map's own furniture: what a place is called and where the lines
    // around it are. Last, because it is the layer everything else is read
    // against rather than a subject of its own -- the same reasoning that puts
    // `coverage` last inside its group.
    //
    // Both keys were already in the app; neither had a home a reader could find.
    // countries was in no group at all, so Admin Mode's grouped dial list had no
    // heading to draw it under, and cities was filed under Infrastructure &
    // Environment -- which is where its *data* fits and not where anybody would
    // look for city labels.
    title: "Reference",
    keys: ["countries", "cities"],
  },
];

/**
 * Filed in a group above, because Admin Mode gives them a dial row, but not
 * drawn as a top-level row in the reader's own Layers section -- so not part
 * of its "n of m" group counts.
 *
 * One entry: gdelt draws as a sub-ticker of Conflict & Violence rather than as a
 * layer in its own right. Counting it would put a denominator on that heading
 * larger than the number of checkboxes underneath it, which reads as a missing
 * control.
 *
 * cities was the second entry and is not one any more. It was excluded because it
 * has no checkbox in the reader's *Layers* section -- its row is in Places -- and
 * the exclusion existed to protect Infrastructure & Environment's denominator
 * while cities was filed there. It now sits in `reference`, which has no
 * reader-side heading to protect at all, so excluding it would only zero out the
 * Reference pill's count and hide a control the reader does have.
 *
 * Named here rather than kept as a second array of counted keys: two lists
 * that look alike are two lists that can disagree, which is the failure this
 * whole module exists to stop.
 */
export const NOT_COUNTED_IN_READER = ["gdelt"];

/** The title to show for a group id -- the one string both screens' headings
 *  now read, instead of each hand-typing "Conflict & Events" et al. and
 *  hoping the two copies stay in step. An unknown id answers with "" rather
 *  than throwing, same reasoning as countedKeysFor below: a blank heading is
 *  a smaller failure than a panel that will not render. */
export function groupTitle(groupId) {
  const group = LAYER_GROUPS.find((g) => g.id === groupId);
  return group ? group.title : "";
}

/** The keys a reader-side "n of m" count for this group should include:
 *  everything filed in it, less the rows the reader does not draw. An unknown
 *  group id answers with an empty list rather than throwing -- a heading that
 *  reports 0/0 is a smaller failure than a panel that will not render. */
export function countedKeysFor(groupId) {
  const group = LAYER_GROUPS.find((g) => g.id === groupId);
  if (!group) return [];
  return group.keys.filter((key) => !NOT_COUNTED_IN_READER.includes(key));
}
