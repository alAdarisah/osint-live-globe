# Admin Mode Layer Grouping Design

**Goal:** File Admin Mode's flat 46-row layer list under the same six subject headings the reader's own control panel already uses, so that two feeds of the same subject — ships from aisstream and ships from Fintraffic, infrastructure from three separate OpenStreetMap sweeps — sit together instead of being scattered by whichever API produced them.

**Scope:** Presentation only. No layer changes what it draws, what it fetches, or what it is called. No setting changes shape, so no stored `admin_config.json` needs migrating.

## The problem

`frontend/src/components/admin/sections/LayerDialsSection.jsx` renders `SETTINGS_LAYERS` (`frontend/src/settings/defaults.js`) as one flat list of 46 collapsible rows, in declaration order and under no headings at all. Declaration order is roughly the order layers were added to the app, which means the subject a row belongs to is scattered:

| Subject | Rows, in the order the admin list shows them |
|---|---|
| Ships | `aisNavy`, `aisTanker`, `aisCivilian`, `aisDigitraffic` … then `darkVessels` … then `gfwGaps`, `gfwDetections` |
| Infrastructure | `infra` … then `osmInfra`, `powerPlants` … `airDefense` |
| Rail | `railways` … then `railLive` |

An operator looking for "everything about ships" reads the whole list. The split is not arbitrary — each of those rows is a genuinely different feed with its own dials — but the *reason* they are apart is which publisher they came from, which is not a question an operator tuning pin sizes is asking.

The reader's control panel does not have this problem. `LayersSection.jsx` already groups the same layers under six subject headings, and its own comments show the grouping was designed against exactly this failure: the two Global Fishing Watch layers are placed directly after `darkVessels` because "same subject, different publisher, and a reader comparing this map's inference against somebody else's record should not have to hunt for the second one."

Admin Mode simply never got the same treatment.

## The taxonomy, and where it lives

The six groups already exist as `GROUP_LAYERS`, a private const at `frontend/src/components/controlPanel/LayersSection.jsx:118`. Copying that table into the admin section would be the same mistake `LayerDialsSection.jsx`'s own header comment records — "split is how the same dial ended up offered twice" — one tier up: two grouping tables that agree today and drift the first time a layer is added to one of them.

So the table moves to a new module, `frontend/src/settings/layerGroups.js`, and both screens read it.

```js
export const LAYER_GROUPS = [
  { id: "conflict", title: "Conflict & Events", keys: [
    "events", "gdelt", "conflictHistory", "officials",
  ] },
  { id: "traffic", title: "Air & Sea Traffic", keys: [
    "aisNavy", "aisTanker", "aisCivilian", "aisDigitraffic",
    "darkVessels", "gfwGaps", "gfwDetections",
    "adsbMilitary", "adsbCivilian", "adsbFlagged",
  ] },
  { id: "ground", title: "Infrastructure & Environment", keys: [
    "infra", "osmInfra", "powerPlants", "airDefense",
    "cities", "airports", "ports", "dams", "deflock",
    "railways", "railLive", "powerLines", "shippingLanes",
    "water", "cables", "firms", "jamming", "laneDensity", "terminator",
    "coverage",
  ] },
  { id: "airspace", title: "Airspace & Aviation", keys: ["czib"] },
  { id: "hazards", title: "Natural Hazards", keys: ["hazards", "floods"] },
  { id: "space", title: "Space", keys: [
    "satellites", "satNavigation", "satWeather", "satImaging",
    "satScience", "satGeo", "satStarlink", "satOneweb", "launches",
  ] },
];
```

Four, ten, twenty, one, two and nine: forty-six, which is every row `SETTINGS_LAYERS` defines and is the count test 1 below enforces.

Two placements inside those lists are deliberate rather than alphabetical, and both are the reader's own. `gdelt` sits directly after `events` because that is where the reader draws it, as a sub-row of the layer it qualifies. `coverage` stays last in `ground` for the reason the reader's comment gives: it is a diagnostic instrument for reading every other row above it, not one more subject alongside them. `cities` is new to the table and goes with the other place layers, immediately before `airports`.

The module imports nothing from the map or from React, so `node --test` can read it directly — the same constraint `map/scene.js` already meets, and the reason the coverage test below is possible at all.

Titles and order are the reader's, unchanged. Two screens that group the same things should name the groups the same way; an operator who has just read "Air & Sea Traffic" in the control panel should not have to work out that "Vessels & Aircraft" in Admin Mode means the same set.

### The two rows the reader's table does not cover

`GROUP_LAYERS` covers 44 of the 46 rows. The two it does not:

- **`gdelt`** — the reader draws it inside Conflict & Events, but as a sub-row of `events` rather than a top-level layer, so it is not in the counted array. It is filed under **Conflict & Events**.
- **`cities`** — the reader does not draw it in Layers at all; its checkbox lives in the separate Places section (`controlPanel/PlacesSection.jsx:100`). It is filed under **Infrastructure & Environment**, alongside the other place layers already there (Airfields, Ports, Dams).

### Keeping the reader's counts honest

`GROUP_LAYERS` does double duty today: it is both the grouping and the denominator behind each group's "n/m" count in the reader (`groupCount`, `LayersSection.jsx:208`). Filing `gdelt` and `cities` into the shared table would therefore make the reader count two rows it does not display — a Conflict group reading "2/4" when it shows three checkboxes.

The module exports the exception explicitly rather than keeping a second array:

```js
/** Filed in a group for Admin Mode's dial list, but not rendered as a
 *  top-level row in the reader's own Layers section, so not part of its
 *  "n of m" counts: gdelt draws as a sub-row of events, and cities lives
 *  in the Places section. */
export const NOT_COUNTED_IN_READER = ["gdelt", "cities"];
```

One taxonomy, one named exception whose reason is written down, rather than two lists that look alike and can quietly disagree.

## Rendering

`LayerDialsSection` maps over `LAYER_GROUPS`, emitting a heading per group followed by that group's `LayerBlock` rows, each row exactly as it renders today.

**Headings are plain headers, not a third accordion tier.** The section itself already collapses (`PanelGroup id="adm-layers"`), and every layer row already collapses (`adm-layer-<key>`). A collapsible middle tier would put two clicks between an operator and any dial, and would have to be force-opened whenever the admin search matched something inside it — a control that opens itself is not a control.

Under an active search, a heading whose group has no surviving rows is not rendered. An empty heading tells an operator a group exists but says nothing about why it is empty, which is worse than its absence.

Display order becomes group order, then key order within each group. `SETTINGS_LAYERS` remains the source of every row's key, label and defaults; `LAYER_GROUPS` supplies only the order and the heading it sits under.

## Search

`adminSearch.js` filters sections against each section's exported `SEARCH_TERMS`. `LayerDialsSection`'s list already carries every layer label and every pin-type label; the six group titles are added to it, so searching "Space" or "Hazards" finds the section rather than returning nothing.

Nothing else about search changes: with plain headings and no new collapse state, a matched row is as reachable as it is today.

## Testing

A new `frontend/tests/layerGroups.test.js` asserts the property that makes the grouping trustworthy rather than merely present:

1. **Every `SETTINGS_LAYERS` key appears in exactly one group.** This is the regression that matters. Without it, the next layer someone adds gets a dial row that renders under no heading — which, once the list is grouped, means it renders nowhere an operator will look. Not once, and not twice.
2. **No group names a key that `SETTINGS_LAYERS` does not define.** Catches a rename on one side only.
3. **Group ids and titles are unique.** Two groups sharing an id would collide in React keys and in any future per-group open state.

One collision is already latent and is called out here so nobody has to rediscover it: the group id `hazards` and the layer key `hazards` are the same string. They never share a namespace — group headings key off `grp-<id>` and layer rows off `adm-layer-<key>` — but a test written as "no id equals any key" would fail on a system that is correct, and a heading id written as bare `<id>` would collide for real. Test 2 compares group *keys* against `SETTINGS_LAYERS`, not group ids, and the heading element takes `grp-<id>`.

`frontend/tests/layerSearchTerms.test.js` is extended to assert the group titles reach `SEARCH_TERMS`, the same way it already covers layer and token labels.

The reader's counts get one test too: that no key in `NOT_COUNTED_IN_READER` is included in a group's displayed count, so the exception cannot be silently dropped when someone tidies the module.

## What is deliberately not in this change

- **Merging rows.** A "Ships" row carrying both AIS feeds was considered and rejected: each feed has its own size, opacity, zoom gate and colour set, and merging them would either lose dials or nest them one level deeper than the flat list they replace.
- **Regrouping the reader.** Its grouping is the one being adopted, not revised.
- **Moving `cities` in the reader.** It stays in Places there. The two screens disagree about that one row, which is a smaller cost than moving a control an operator already knows the location of.
- **Per-group open/closed state, or persisting it.** There is no collapse to persist.
