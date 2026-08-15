# Admin Layer Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File Admin Mode's flat 46-row layer list under the same six subject headings the reader's control panel already uses, so two feeds of one subject sit together instead of being scattered by which API produced them.

**Architecture:** The grouping table already exists as a private const inside the reader's `LayersSection.jsx`. It moves to a new dependency-free module, `frontend/src/settings/layerGroups.js`, which both screens import. The admin section then renders its existing rows in that table's order, under plain (non-collapsible) headings. Nothing about what a layer draws, fetches, or is called changes.

**Tech Stack:** React 18, plain ES modules, `node --test` (no build step in tests), Vite.

Design spec: `docs/superpowers/specs/2026-08-15-admin-layer-groups-design.md`.

## Global Constraints

- Frontend is dependency-free under test: `frontend/tests/*.test.js` run under `node --test` with nothing installed. **Any module a test imports must not import anything browser-shaped**, and must use explicit `.js` extensions in its own imports. `frontend/src/settings/layerGroups.js` must import nothing at all.
- Run frontend tests with `cd frontend && npm test`. All must pass.
- `cd frontend && npm run build` must stay clean.
- No new runtime dependencies.
- This change is presentation only. No setting changes shape, so no stored `admin_config.json` needs migrating, and no default changes value.
- Group titles and their order are the reader's, copied verbatim: `Conflict & Events`, `Air & Sea Traffic`, `Infrastructure & Environment`, `Airspace & Aviation`, `Natural Hazards`, `Space`.
- Comment style in this codebase explains *why*, at length, in prose. Match it. Copy the reasoning already written above `GROUP_LAYERS` and inside it rather than summarising it away.

---

### Task 1: The shared grouping table

Creates the single source of truth and the test that keeps it complete. Nothing renders differently yet — this task is the table plus its guard.

**Files:**
- Create: `frontend/src/settings/layerGroups.js`
- Create: `frontend/tests/layerGroups.test.js`

**Interfaces:**
- Consumes: `SETTINGS_LAYERS` from `frontend/src/settings/defaults.js` (array of `{key, label, ...}`) — read by the test only, never by the new module.
- Produces:
  - `LAYER_GROUPS` — ordered `Array<{id: string, title: string, keys: string[]}>`
  - `NOT_COUNTED_IN_READER` — `string[]`
  - `layerGroupOf(key: string) => string | null` — the group id a layer key belongs to, or `null`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/layerGroups.test.js`:

```js
// The grouping table's completeness, asserted.
//
// Admin Mode's layer list is rendered by walking LAYER_GROUPS rather than
// SETTINGS_LAYERS, so a layer missing from the table is a layer with no
// heading to render under -- which, in a grouped list, means a dial an
// operator cannot find at all. That is a silent failure: the row does not
// error, it simply is not there. This is the test that makes adding a layer
// without filing it a red build instead.

import test from "node:test";
import assert from "node:assert/strict";

import { LAYER_GROUPS, NOT_COUNTED_IN_READER, layerGroupOf } from "../src/settings/layerGroups.js";
import { SETTINGS_LAYERS } from "../src/settings/defaults.js";

const ALL_GROUPED = LAYER_GROUPS.flatMap((g) => g.keys);
const SETTINGS_KEYS = SETTINGS_LAYERS.map((l) => l.key);

test("every layer with a dial row is filed in exactly one group", () => {
  const missing = SETTINGS_KEYS.filter((k) => !ALL_GROUPED.includes(k));
  assert.deepEqual(missing, [], "these layers have a dial row but no group to render it under");

  const duplicated = ALL_GROUPED.filter((k, i) => ALL_GROUPED.indexOf(k) !== i);
  assert.deepEqual(duplicated, [], "these layers are filed in more than one group");
});

test("no group names a layer that does not exist", () => {
  const unknown = ALL_GROUPED.filter((k) => !SETTINGS_KEYS.includes(k));
  assert.deepEqual(unknown, [], "these keys are grouped but have no SETTINGS_LAYERS row");
});

test("group ids and titles are unique", () => {
  const ids = LAYER_GROUPS.map((g) => g.id);
  const titles = LAYER_GROUPS.map((g) => g.title);
  assert.equal(new Set(ids).size, ids.length, "two groups share an id");
  assert.equal(new Set(titles).size, titles.length, "two groups share a title");
});

// The group id "hazards" and the layer key "hazards" are the same string, and
// that is fine: headings key off `grp-<id>` and rows off `adm-layer-<key>`, so
// the two never share a namespace. Asserted so nobody "fixes" the collision by
// renaming one of them and breaking the other's DOM id.
test("a group id may equal a layer key -- they are different namespaces", () => {
  assert.ok(LAYER_GROUPS.some((g) => g.id === "hazards"));
  assert.ok(SETTINGS_KEYS.includes("hazards"));
});

test("NOT_COUNTED_IN_READER names only real, grouped layers", () => {
  for (const key of NOT_COUNTED_IN_READER) {
    assert.ok(SETTINGS_KEYS.includes(key), `${key} is not a layer`);
    assert.ok(ALL_GROUPED.includes(key), `${key} is not in any group`);
  }
});

test("layerGroupOf answers with the group id, or null for an unknown key", () => {
  assert.equal(layerGroupOf("aisDigitraffic"), "traffic");
  assert.equal(layerGroupOf("cities"), "ground");
  assert.equal(layerGroupOf("gdelt"), "conflict");
  assert.equal(layerGroupOf("nosuchlayer"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test tests/layerGroups.test.js`

Expected: FAIL — `Cannot find module .../src/settings/layerGroups.js`

- [ ] **Step 3: Write the module**

Create `frontend/src/settings/layerGroups.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --test tests/layerGroups.test.js`

Expected: PASS, 6 tests.

If "every layer with a dial row is filed in exactly one group" fails, the assertion message names the unfiled keys — add each to the group its subject belongs to. Do not delete the assertion.

- [ ] **Step 5: Run the whole suite**

Run: `cd frontend && npm test`

Expected: all pass. Nothing imports the new module yet, so nothing else can have moved.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/settings/layerGroups.js frontend/tests/layerGroups.test.js
git commit -m "Give both layer lists one table to group by"
```

---

### Task 2: Point the reader at the shared table

The reader keeps its exact current behaviour, including its counts, but stops owning the table. This task is behaviour-preserving by design: if any group's count changes, something is wrong.

**Files:**
- Modify: `frontend/src/components/controlPanel/LayersSection.jsx:110-148` (delete the local `GROUP_LAYERS`, import the shared one) and `:208` (`groupCount`)
- Modify: `frontend/tests/layerGroups.test.js` (add the counting test)

**Interfaces:**
- Consumes: `LAYER_GROUPS`, `NOT_COUNTED_IN_READER` from Task 1.
- Produces: `countedKeysFor(groupId: string) => string[]`, exported from `frontend/src/settings/layerGroups.js` — the keys a reader-side count should include.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/layerGroups.test.js`:

```js
// The reader's group headings show "n of m" where m is the number of
// checkboxes under them. Two layers are filed in groups here but have no
// checkbox there, so m has to exclude them -- otherwise a heading reads 3/4
// while showing three rows, and the missing one is unfindable because it does
// not exist.
test("countedKeysFor drops the layers the reader does not draw as rows", () => {
  const conflict = countedKeysFor("conflict");
  assert.ok(!conflict.includes("gdelt"), "gdelt is a sub-row, not a counted layer");
  assert.deepEqual(conflict, ["events", "conflictHistory", "officials"]);

  const ground = countedKeysFor("ground");
  assert.ok(!ground.includes("cities"), "cities lives in the Places section");
});

test("countedKeysFor leaves a group with no exceptions untouched", () => {
  assert.deepEqual(countedKeysFor("hazards"), ["hazards", "floods"]);
  assert.deepEqual(countedKeysFor("nosuchgroup"), []);
});
```

Add `countedKeysFor` to that file's existing import from `../src/settings/layerGroups.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test tests/layerGroups.test.js`

Expected: FAIL — `countedKeysFor is not a function`

- [ ] **Step 3: Add the helper**

Append to `frontend/src/settings/layerGroups.js`:

```js
/** The keys a reader-side "n of m" count for this group should include:
 *  everything filed in it, less the rows the reader does not draw. An unknown
 *  group id answers with an empty list rather than throwing -- a heading that
 *  reports 0/0 is a smaller failure than a panel that will not render. */
export function countedKeysFor(groupId) {
  const group = LAYER_GROUPS.find((g) => g.id === groupId);
  if (!group) return [];
  return group.keys.filter((key) => !NOT_COUNTED_IN_READER.includes(key));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --test tests/layerGroups.test.js`

Expected: PASS, 8 tests.

- [ ] **Step 5: Rewire the reader**

In `frontend/src/components/controlPanel/LayersSection.jsx`:

Delete the whole `const GROUP_LAYERS = { ... };` block (roughly lines 117-148) **and the comment directly above it** that begins "`gdelt` is deliberately absent" — that reasoning now lives on `NOT_COUNTED_IN_READER` in the shared module, and leaving a copy behind is how two statements of one rule start to disagree.

Add to the imports at the top of the file:

```js
import { countedKeysFor } from "../../settings/layerGroups";
```

Replace the `groupCount` definition (line 208) with:

```js
  // The table behind this moved to settings/layerGroups.js so Admin Mode's
  // dial list could group by the same one -- see that module. countedKeysFor
  // is what keeps this denominator equal to the number of checkboxes actually
  // rendered under the heading.
  const groupCount = (id) => {
    const keys = countedKeysFor(id);
    return `${activeCount(layerVisibility, keys)}/${keys.length}`;
  };
```

Leave `activeCount` and every `<PanelGroup ... count={groupCount("...")}>` call exactly as they are.

- [ ] **Step 6: Verify nothing about the reader moved**

Run: `cd frontend && npm test`

Expected: all pass.

Run: `cd frontend && npm run build`

Expected: clean (the "chunks larger than 500 kB" notice is pre-existing and not an error).

Then confirm by eye that the six group headings still read the same denominators they did before this task: Conflict & Events `n/3`, Air & Sea Traffic `n/10`, Infrastructure & Environment `n/19`, Airspace & Aviation `n/1`, Natural Hazards `n/2`, Space `n/9`. A changed denominator means a key landed in the wrong group in Task 1.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/controlPanel/LayersSection.jsx frontend/src/settings/layerGroups.js frontend/tests/layerGroups.test.js
git commit -m "Read the reader's layer groups from the table both lists share"
```

---

### Task 3: Render the headings in Admin Mode

The visible change. The 46 rows are unchanged; they are emitted group by group with a heading before each.

**Files:**
- Modify: `frontend/src/components/admin/sections/LayerDialsSection.jsx` (header comment, `SEARCH_TERMS`, the render body around lines 40-66)
- Modify: `frontend/src/style.css` (one new class, near `.admin-note` at line 3879)
- Modify: `frontend/tests/layerSearchTerms.test.js` (group titles reach the search box)

**Interfaces:**
- Consumes: `LAYER_GROUPS` from Task 1; `SETTINGS_LAYERS` from `frontend/src/settings/defaults.js`.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/layerSearchTerms.test.js`:

```js
// Admin Mode's Layers section is filed under six subject headings, and the
// admin search hides a whole section unless one of its terms matches. A
// heading an operator can read on screen but cannot search for is a control
// that only works if you already knew where it was.
test("group titles are searchable", async (t) => {
  const { LAYER_GROUPS } = await import("../src/settings/layerGroups.js");
  const { SEARCH_TERMS } = await import("../src/components/admin/sections/layerSectionTerms.js");

  for (const group of LAYER_GROUPS) {
    assert.ok(SEARCH_TERMS.includes(group.title), `"${group.title}" is not searchable`);
  }

  await t.test("and findable by the words an operator would actually type", () => {
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "space")));
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "hazards")));
    assert.ok(SEARCH_TERMS.some((term) => matchesQuery(term, "sea traffic")));
  });
});
```

Note the import path: `LayerDialsSection.jsx` is JSX and cannot be imported under `node --test` (this is exactly why the file's existing header comment says so). Step 3 extracts the term list into a plain `.js` module so it can be.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --test tests/layerSearchTerms.test.js`

Expected: FAIL — `Cannot find module .../sections/layerSectionTerms.js`

- [ ] **Step 3: Extract the search terms into a testable module**

Create `frontend/src/components/admin/sections/layerSectionTerms.js`:

```js
// The Layers section's search terms, in a plain .js module rather than beside
// the component.
//
// LayerDialsSection.jsx is JSX, which plain `node --test` cannot import (see
// tokenSearchTerms.js and adminSearch.js, both here for the same reason). The
// terms are what the admin search box actually matches against, so they are
// worth a test; the component that renders them is not importable, so they
// move to where a test can reach them.

import { SETTINGS_LAYERS } from "../../../settings/defaults.js";
import { LAYER_GROUPS } from "../../../settings/layerGroups.js";
import { ALL_TOKEN_LABELS } from "./tokenSearchTerms.js";

/** The section title, the six group headings, the four generic dial names,
 *  every layer's own name, and every pin type's own label -- a heading, a
 *  layer row and a pin type are all real controls a search should find. */
export const SEARCH_TERMS = [
  "Layers",
  ...LAYER_GROUPS.map((g) => g.title),
  "Size",
  "Opacity",
  "Shows from zoom",
  "Hides past zoom",
  "Only with a country selected",
  "Shared colours",
  ...SETTINGS_LAYERS.map((l) => l.label),
  ...ALL_TOKEN_LABELS,
];
```

In `LayerDialsSection.jsx`, delete its own `export const SEARCH_TERMS = [ ... ];` block together with the comment above it, and re-export from the new module instead:

```js
// The terms live in a plain .js module so `node --test` can assert on them --
// this file is JSX and cannot be imported there. See layerSectionTerms.js.
export { SEARCH_TERMS } from "./layerSectionTerms";
```

Remove the now-unused `ALL_TOKEN_LABELS` import from `LayerDialsSection.jsx`. Keep its `SETTINGS_LAYERS` import — the render body still uses it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --test tests/layerSearchTerms.test.js`

Expected: PASS.

- [ ] **Step 5: Render the groups**

In `LayerDialsSection.jsx`, add to the imports:

```js
import { LAYER_GROUPS } from "../../../settings/layerGroups";
```

Replace the render body's flat map:

```jsx
      {SETTINGS_LAYERS.map((layer) => (
        <LayerBlock
          key={layer.key}
          layer={layer}
          settings={settings}
          actions={actions}
          open={isOpen(`adm-layer-${layer.key}`)}
          onToggle={onToggle}
        />
      ))}
```

with a group-by-group walk:

```jsx
      {LAYER_GROUPS.map((group) => (
        <div key={group.id} className="admin-layer-group">
          <h4 className="admin-group-heading" id={`grp-${group.id}`}>{group.title}</h4>
          {group.keys.map((key) => {
            const layer = LAYER_BY_KEY[key];
            // Filed in a group but with no SETTINGS_LAYERS row to render.
            // tests/layerGroups.test.js makes this impossible to ship, so this
            // is a guard against a half-applied hot reload rather than a state
            // the built app can reach.
            if (!layer) return null;
            return (
              <LayerBlock
                key={layer.key}
                layer={layer}
                settings={settings}
                actions={actions}
                open={isOpen(`adm-layer-${layer.key}`)}
                onToggle={onToggle}
              />
            );
          })}
        </div>
      ))}
```

Add the lookup near the top of the file, beside the imports:

```js
// Keyed once at module scope rather than searched per row: the render walks
// LAYER_GROUPS now, which holds keys, while every row's label and defaults
// still come from SETTINGS_LAYERS.
const LAYER_BY_KEY = Object.fromEntries(SETTINGS_LAYERS.map((l) => [l.key, l]));
```

Update the file's header comment, which currently says the section is "Grouped by layer rather than split across two sections". It is still grouped by layer *within* a subject; say so and say why the subjects arrived:

```js
// Everything else about how a layer draws -- its size, its opacity, its zoom
// gate, and the colour of every kind of pin in it. One row per layer, filed
// under the six subject headings the reader's own control drawer uses (see
// settings/layerGroups.js, which both lists read).
//
// The rows are grouped by layer rather than split across two sections,
// because split is how the same dial ended up offered twice (see LayerBlock
// below). The subject headings are the opposite problem, arriving later: the
// list was flat and in the order layers were added to the app, so ships from
// one AIS feed sat rows away from ships from another and an operator looking
// for "everything about ships" read all 46 rows.
//
// The headings are plain headers, not a third collapsible tier: this section
// already collapses, and so does every layer row inside it. A middle tier
// would put two clicks between an operator and any dial, on a screen whose
// whole purpose is reaching one.
```

- [ ] **Step 6: Style the heading**

In `frontend/src/style.css`, immediately after the `.admin-note` block (line 3879):

```css
/* The subject headings in Admin Mode's Layers section. Deliberately quieter
   than a PanelGroup's own title: these separate rows, they do not open or
   close anything, and a heading that looks clickable but is not is worse than
   no heading. */
.admin-group-heading {
  margin: 12px 0 4px;
  font-size: calc(10px * var(--ui-text-scale));
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-dim);
}
.admin-layer-group:first-of-type .admin-group-heading { margin-top: 4px; }
```

- [ ] **Step 7: Run the full suite and build**

Run: `cd frontend && npm test`

Expected: all pass.

Run: `cd frontend && npm run build`

Expected: clean.

- [ ] **Step 8: Check it in the running app**

Start the dev server through the preview tooling (never `npm run dev` in a shell), open Admin Mode, and expand **Layers**. Confirm:

1. Six headings in this order: Conflict & Events, Air & Sea Traffic, Infrastructure & Environment, Airspace & Aviation, Natural Hazards, Space.
2. All four ship feeds — Navy & MSC, Oil tankers, Civilian ships, Ships — Baltic (Fintraffic) — sit together under Air & Sea Traffic, followed by Dark vessels and the two GFW rows.
3. `Critical infrastructure`, `Infrastructure (OpenStreetMap)`, `Power plants (OpenStreetMap)` and `Air defence & radar (OpenStreetMap)` sit together under Infrastructure & Environment, and `Cities` is with them.
4. Every row still opens to its own dials in one click.
5. Counting the rows on screen gives 46.
6. Typing "Space" in the admin search still shows the Layers section.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/admin/sections/LayerDialsSection.jsx frontend/src/components/admin/sections/layerSectionTerms.js frontend/src/style.css frontend/tests/layerSearchTerms.test.js
git commit -m "File the admin layer dials by subject, not by which API served them"
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Shared `layerGroups.js`, six groups, reader's titles and order | 1 |
| `gdelt` → Conflict, `cities` → Infrastructure & Environment | 1 |
| `NOT_COUNTED_IN_READER`, reader counts stay honest | 2 |
| Plain headings, not a third accordion | 3 |
| Display order = group order then key order | 3 |
| Group titles in `SEARCH_TERMS` | 3 |
| Test: every key in exactly one group | 1 |
| Test: no group names an unknown key | 1 |
| Test: ids and titles unique, `hazards` collision noted | 1 |
| Test: counted keys exclude the two | 2 |
| Test: group titles searchable | 3 |
| No empty-heading handling (search filters sections, not rows) | not implemented, by design |

**Names used across tasks:** `LAYER_GROUPS`, `NOT_COUNTED_IN_READER`, `layerGroupOf`, `countedKeysFor`, `LAYER_BY_KEY`, `SEARCH_TERMS`, `activeCount`, `groupCount`, `LayerBlock` — each defined in the task that first uses it, spelled the same in every later task.

**One thing the implementer should expect to be surprised by:** Task 3 moves `SEARCH_TERMS` out of the JSX file. That is not tidying — it is the only way `node --test` can assert on the group titles at all, because the section component cannot be imported there. The file's own header comment already says why.
