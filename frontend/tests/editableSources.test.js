// What the data editor claims it can edit, checked against the map.
//
// An edit is stored under `record[idField]` and re-applied to every poll (see
// applyOverrides.js). If that field is not the one the map identifies the record
// by, the edit is written and then silently never matches anything: the panel
// shows the row as edited, the pin never changes, and nothing anywhere raises an
// error. That is the failure this file exists for.
//
// settings/defaults.js cannot be imported under `node --test` -- it reaches
// map/iconTheme and map/scene through extensionless specifiers only Vite
// resolves -- so its two tables are read out of the source text instead. Cruder
// than an import and it still catches the drift, which is the point.
//
// The map's own identity table is a real import now. It used to be scraped from
// createMapController.js the same way, which broke the moment the table moved
// house; it lives in map/recordIds.js, which imports nothing precisely so that
// readers like this one can load it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ID_FIELD } from "../src/map/recordIds.js";

const defaults = readFileSync(new URL("../src/settings/defaults.js", import.meta.url), "utf8");

/** `{ key: "x", label: "…", idField: "y", titleField: "z" }` rows. */
function editableSources() {
  const block = defaults.match(/export const EDITABLE_SOURCES = \[([\s\S]*?)\n\];/)[1];
  return [...block.matchAll(/\{ key: "(\w+)", label: "([^"]+)", idField: "(\w+)", titleField: "(\w+)" \}/g)]
    .map(([, key, label, idField, titleField]) => ({ key, label, idField, titleField }));
}

/** The controller's own `key: "field"` identity table. */
function mapIdFields() {
  const block = controller.match(/const ID_FIELD = \{([\s\S]*?)\n\};/)[1];
  return Object.fromEntries(
    [...block.matchAll(/(\w+): "(\w+)"/g)].map(([, key, field]) => [key, field])
  );
}

function editableFieldKeys() {
  const block = defaults.match(/export const EDITABLE_FIELDS = \{([\s\S]*?)\n\};/)[1];
  return [...block.matchAll(/^ {2}(\w+): \[/gm)].map(([, key]) => key);
}

const SOURCES = editableSources();

test("the editable-source table", async (t) => {
  await t.test("was parsed at all", () => {
    // Guards the regexes above: a formatting change that stopped them matching
    // would otherwise turn every assertion below into a vacuous pass over an
    // empty list.
    assert.ok(SOURCES.length >= 18, `only parsed ${SOURCES.length} sources`);
    assert.ok(Object.keys(ID_FIELD).length >= 15);
  });

  // The one that actually bites. `cities` is the live example: the renderer
  // falls back to a composite key, but an edit has to be stored against
  // GeoNames' own id or it will not survive the next poll.
  await t.test("identifies records the same way the map does", () => {
    for (const source of SOURCES) {
      const mapField = ID_FIELD[source.key];
      if (!mapField) continue; // drawn by its own renderer, not the generic one
      assert.equal(
        source.idField,
        mapField,
        `${source.key}: editor stores edits under "${source.idField}", map keys markers on "${mapField}"`
      );
    }
  });

  await t.test("gives every source a field table", () => {
    const withFields = new Set(editableFieldKeys());
    for (const source of SOURCES) {
      assert.ok(withFields.has(source.key), `${source.key} has no EDITABLE_FIELDS entry`);
    }
  });

  // Everything the editor offers is a point, and a record the map cannot place
  // is a record it cannot draw -- so the two coordinate fields have to be on
  // offer everywhere, which is what the shared COORDS spread is for.
  await t.test("offers coordinates on every source", () => {
    const block = defaults.match(/export const EDITABLE_FIELDS = \{([\s\S]*?)\n\};/)[1];
    const tables = block.split(/^ {2}(?=\w+: \[)/m).filter((chunk) => /^\w+: \[/.test(chunk));
    assert.equal(tables.length, SOURCES.length);
    for (const table of tables) {
      const key = table.match(/^(\w+):/)[1];
      assert.ok(/\.\.\.COORDS/.test(table), `${key} does not offer lat/lon`);
    }
  });

  await t.test("names no source twice", () => {
    const keys = SOURCES.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  // The live-position feeds are the ones an override actively lies about: an
  // edit keyed by MMSI is re-applied to every poll, so it would pin a moving
  // vessel in place while the pin went on claiming to be live.
  await t.test("excludes the feeds an override would misrepresent", () => {
    const keys = new Set(SOURCES.map((s) => s.key));
    for (const key of ["ais", "adsb", "satellites", "firms", "jamming"]) {
      assert.ok(!keys.has(key), `${key} must not be editable`);
    }
  });

  await t.test("explains every exclusion to the reader", () => {
    const block = defaults.match(/export const UNEDITABLE_SOURCES = \[([\s\S]*?)\n\];/)[1];
    const reasons = [...block.matchAll(/reason:/g)].length;
    const labels = [...block.matchAll(/label:/g)].length;
    assert.ok(labels >= 5, `only ${labels} exclusions documented`);
    assert.equal(reasons, labels, "every excluded feed needs a reason");
  });
});
