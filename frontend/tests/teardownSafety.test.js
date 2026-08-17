// A Leaflet layer's onRemove must not be able to throw.
//
// This is the fourth erosion test in the family (motionTokens, zIndexBands,
// mapOverlays, boundSetters), and it exists because of a crash that reached the
// admin deployment:
//
//   TypeError: Cannot read properties of undefined (reading 'destroy')
//       at e.onRemove ... at e.removeLayer ... at Object.destroy
//
// webglLayer's onAdd assigned _textureCache *after* `new PIXI.Application`, and
// Leaflet's addLayer registers a layer in map._layers before calling onAdd -- so a
// renderer that failed to start left a registered, half-built layer, and the next
// map.remove() called onRemove on it.
//
// What makes that worth a test rather than a one-line fix is the feedback loop.
// map.remove() removes layers in a loop, so a throw in one onRemove abandons the
// rest of the teardown -- including the `_app.destroy(true, ...)` that releases the
// WebGL context. The leaked context makes the next renderer likelier to fail, which
// throws again. A browser has a hard per-page context limit, so once it starts it
// runs until the tab is closed.
//
// The rule this enforces: inside onRemove, every `this._field` dereference is
// optional-chained or guarded. Static, because the alternative needs Leaflet, Pixi
// and a WebGL context, and this suite has none of the three.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const resolvePath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Every .js file under src/map/, as [name, text]. */
function mapModules() {
  const root = resolvePath("../src/map");
  return readdirSync(root)
    .filter((name) => name.endsWith(".js"))
    .map((name) => [name, readFileSync(path.join(root, name), "utf8")]);
}

/** The body of an `onRemove(...) {` method, by brace matching. */
function onRemoveBody(source) {
  const start = source.search(/\bonRemove\s*\([^)]*\)\s*\{/);
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Comments removed, strings left alone.
 *
 * Stripping string literals as well was the obvious next step, and it silently ate
 * the file: one unbalanced backtick and the template-literal pattern matched across
 * 15,000 characters, taking `new PIXI.Application` with it — so the ordering check
 * below found nothing and reported the constructor "missing" rather than
 * mis-ordered. Measured while writing this: 17,547 characters in, 2,783 out.
 *
 * Comments are the only thing that has to go, because this module discusses
 * `this._app.destroy()` in prose constantly. A dereference hiding inside a string
 * literal is not a thing that happens.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("onRemove dereferences nothing it has not checked", () => {
  const offenders = [];

  for (const [name, source] of mapModules()) {
    const body = onRemoveBody(source);
    if (body == null) continue;
    const code = stripComments(body);

    // Fields proven non-null earlier in the same body by an `if (this._x)` or an
    // `if (this._x != null)` guard. Narrow on purpose: a guard that is not this
    // simple should be written as optional chaining instead of taught to a regex.
    const guarded = new Set(
      [...code.matchAll(/if\s*\(\s*this\.(_[\w$]+)\s*(?:!=\s*null\s*)?\)/g)].map((m) => m[1]),
    );

    // `this._field.` or `this._field[` -- a plain dereference. `?.` is the fix, so
    // it must not match.
    for (const m of code.matchAll(/this\.(_[\w$]+)\s*(\?\.|\.|\[)/g)) {
      const [, field, accessor] = m;
      if (accessor === "?.") continue;
      if (guarded.has(field)) continue;
      const line = body.slice(0, m.index).split("\n").length;
      offenders.push(`${name}: onRemove line ${line}: this.${field}${accessor} is not guarded`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a teardown path can throw. map.remove() removes layers in a loop, so this does not "
    + "break one unmount -- it abandons every teardown after it, and for the WebGL layer "
    + `that means leaking a context per unmount until the page can render nothing:\n${offenders.join("\n")}`,
  );
});

test("the scan actually reaches the layer this was written for", () => {
  // A static test that silently matches nothing passes forever. webglLayer.js is
  // the module whose onRemove crashed; if this stops finding it, the scan is broken
  // rather than the code being clean.
  const modules = mapModules();
  const webgl = modules.find(([name]) => name === "webglLayer.js");
  assert.ok(webgl, "webglLayer.js is not where this test thinks it is");
  const body = onRemoveBody(webgl[1]);
  assert.ok(body, "webglLayer.js has no onRemove any more");
  assert.match(body, /_app\?\./, "the Pixi teardown lost its guard");
  assert.match(body, /_textureCache\?\./, "the texture cache teardown lost its guard");
});

test("the fields onRemove needs are assigned before the renderer that can fail", () => {
  // The other half, and the actual root cause: ordering inside onAdd. Leaflet
  // registers a layer before calling onAdd, so a throw leaves it registered and
  // half-built. Anything onRemove touches has to exist before the one call in
  // onAdd that can realistically fail.
  const source = readFileSync(resolvePath("../src/map/webglLayer.js"), "utf8");
  const code = stripComments(source);
  const pixi = code.indexOf("new PIXI.Application");
  assert.ok(pixi > 0, "the Pixi application is not constructed where this test expects");

  for (const field of ["_textureCache", "_buckets"]) {
    const assigned = code.indexOf(`this.${field} = `);
    assert.ok(assigned > 0, `${field} is never assigned`);
    assert.ok(
      assigned < pixi,
      `this.${field} is assigned after new PIXI.Application, so a renderer that fails to `
      + "start leaves it undefined for onRemove -- which is exactly the crash this file pins",
    );
  }
});
