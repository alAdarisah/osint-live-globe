// The same erosion motionTokens.test.js watches for, one axis over.
//
// A thirty-first raw z-index does not break anything either. It just makes the
// stack slightly more arbitrary than it was yesterday, and the way that failure
// finally surfaces is a panel that is drawn correctly and cannot be clicked --
// which nobody attributes to a number in a stylesheet. This test is the thing
// that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel) => readFileSync(resolvePath(rel), "utf8");

// Same treatment motionTokens.test.js gives comments, and for the same reason:
// the prose in this codebase discusses z-index values by name and by number,
// and a comment that mentions "z-index: 1000" is not a declaration.
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Every .css file under src/, as [relative name, text]. */
function stylesheets() {
  const root = resolvePath("../src");
  const out = [];
  for (const entry of readdirSync(root, { recursive: true })) {
    const rel = entry.toString().replace(/\\/g, "/");
    if (!rel.endsWith(".css")) continue;
    out.push([rel, readFileSync(path.join(root, rel), "utf8")]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** Every `z-index: …;` declaration, as [file, line, value]. */
function zIndexDeclarations(files) {
  const out = [];
  for (const [name, raw] of files) {
    const css = blankComments(raw);
    const re = /z-index\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(css))) {
      out.push([name, css.slice(0, m.index).split("\n").length, m[1].trim()]);
    }
  }
  return out;
}

// Two sticky table/popup headers that stack against their own scroll container
// and nothing else. `1` here does not mean "first band", it means "one above
// the row underneath me" -- promoting either to a global band would be
// inventing a relationship that does not exist.
const LOCAL_STACKING = new Set([
  "style.css:.leaflet-popup-scrolled h3:first-child",
  "style.css:.compare-table thead th.compare-row-label",
]);

/** The selector a declaration belongs to, for the allow-list above. */
function selectorFor(raw, line) {
  const css = blankComments(raw);
  const upto = css.split("\n").slice(0, line).join("\n");
  const open = upto.lastIndexOf("{");
  const prev = Math.max(upto.lastIndexOf("}", open), upto.lastIndexOf("{", open - 1));
  return upto.slice(prev + 1, open).trim().replace(/\s+/g, " ");
}

test("zindex.css is the only place a stacking level is chosen", () => {
  const files = stylesheets();
  assert.ok(
    files.some(([name]) => name === "zindex.css"),
    "zindex.css has gone missing",
  );

  const bands = new Set([...read("../src/zindex.css").matchAll(/(--z-[\w-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(bands.size >= 20, `zindex.css declares only ${bands.size} bands; that is not the whole table`);

  const offenders = [];
  for (const [name, raw] of files) {
    if (name === "zindex.css") continue;
    for (const [, line, value] of zIndexDeclarations([[name, raw]])) {
      const token = value.match(/^var\((--z-[\w-]+)\)$/);
      if (token) {
        if (!bands.has(token[1])) offenders.push(`${name}:${line}: ${token[1]} is not declared in zindex.css`);
        continue;
      }
      if (LOCAL_STACKING.has(`${name}:${selectorFor(raw, line)}`)) continue;
      offenders.push(`${name}:${line}: z-index: ${value}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a stacking level was chosen outside zindex.css. Add a band there and " +
    `reference it, so the next reader can see what it sits above:\n${offenders.join("\n")}`,
  );
});

test("the bands are declared in the order they stack", () => {
  // The value of a band is arbitrary; its place in the list is the decision.
  // Declaring one out of order is how the file stops being readable as a
  // ladder -- and reading it as a ladder is the only reason it exists.
  const declared = [...read("../src/zindex.css").matchAll(/(--z-[\w-]+)\s*:\s*(\d+)\s*;/g)]
    .map((m) => [m[1], Number(m[2])]);
  assert.ok(declared.length >= 20, "zindex.css lost most of its bands");

  const outOfOrder = declared
    .map(([name, value], i) => [name, value, i === 0 ? value : declared[i - 1][1]])
    .filter(([, value, previous]) => value < previous)
    .map(([name, value, previous]) => `${name}: ${value} is declared after ${previous}`);

  assert.deepEqual(outOfOrder, [], `zindex.css is no longer in stacking order:\n${outOfOrder.join("\n")}`);
});

test("nothing sits under Leaflet's own stack", () => {
  // Leaflet's numbers are global here: #map sets position and no z-index, so it
  // is not a stacking context and vendor/leaflet/leaflet.css competes directly
  // with ours. Its highest is 1000 (the four control corners); its popup pane is
  // 700. A band under 900 is a band a marker popup draws over, which is the one
  // mistake this table exists to make impossible to write by accident.
  const leaflet = readFileSync(resolvePath("../public/vendor/leaflet/leaflet.css"), "utf8");
  const leafletTop = Math.max(...[...blankComments(leaflet).matchAll(/z-index\s*:\s*(\d+)\s*;/g)].map((m) => Number(m[1])));
  assert.equal(leafletTop, 1000, "Leaflet's top stacking level changed; re-check every band in zindex.css");

  const tooLow = [...read("../src/zindex.css").matchAll(/(--z-[\w-]+)\s*:\s*(\d+)\s*;/g)]
    .map((m) => [m[1], Number(m[2])])
    .filter(([, value]) => value < 900)
    .map(([name, value]) => `${name}: ${value}`);

  assert.deepEqual(tooLow, [], `these bands sit inside Leaflet's own pane range:\n${tooLow.join("\n")}`);
});
