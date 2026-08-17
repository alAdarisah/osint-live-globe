// The sprite layer has to work under this deployment's own Content-Security-Policy.
//
// The fifth erosion test in the family (motionTokens, zIndexBands, mapOverlays,
// boundSetters, teardownSafety), and the one with the widest live symptom. Pixi 7
// builds its uniform-group upload functions and shader sync code at runtime with
// `new Function`. security-headers.conf serves `script-src 'self'` with no
// `unsafe-eval`, so the browser refused, `new PIXI.Application` threw
//
//   Current environment does not allow unsafe-eval, please use @pixi/unsafe-eval
//   module to enable support.
//
// ...and every ship, aircraft and satellite stopped drawing on the deployment while
// the dev server -- which ships no CSP -- was perfect. What makes that worth a test
// rather than a fixed line is how it presented: the feeds landed, the counts beside
// every layer read correctly, the sprites were created and positioned, and none of
// it was rasterized. The canvas stayed at its default 300x150 because the resize
// lives behind `if (!this._app) return`. Nothing in the suite could see any of it,
// because the suite has no browser and therefore no CSP.
//
// So the rule this enforces is static and narrow: the shim is a dependency, it is
// installed into Pixi before anything can construct a renderer, and the CSP it
// exists for still says what it said. Any of the three drifting brings the whole
// symptom back.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Comments removed, strings left alone -- the same rule, and the same reason, as
 * teardownSafety.test.js's own stripComments (see its note on the 15,000 characters
 * an over-eager version ate).
 *
 * Required rather than tidy: this module discusses `new PIXI.Application` in prose
 * twice, both times *above* the constructor, so an ordering check run against the
 * raw text finds a comment and concludes the install happens too late.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const LAYER = stripComments(read("../src/map/webglLayer.js"));
const PACKAGE = JSON.parse(read("../package.json"));
const HEADERS = read("../security-headers.conf");

test("the CSP shim is installed into Pixi before any renderer is constructed", () => {
  const install = LAYER.indexOf(".install(");
  assert.ok(install > 0, "@pixi/unsafe-eval is never installed");
  const application = LAYER.indexOf("new PIXI.Application");
  assert.ok(application > 0, "the Pixi application is not constructed where this test expects");
  assert.ok(
    install < application,
    "install() runs after new PIXI.Application. Pixi does its systemCheck in the "
    + "constructor, so installing afterwards is installing into a renderer that already "
    + "threw -- which is indistinguishable from not installing at all",
  );
});

test("the shim is imported in the same step as Pixi itself", () => {
  // Not a separate later import. The layer loads Pixi lazily as its own chunk, and
  // onAdd runs the moment that promise resolves -- so a shim imported on any other
  // schedule can lose the race, and the failure it loses to is silent.
  assert.match(LAYER, /import\("@pixi\/unsafe-eval"\)/, "the shim is not dynamically imported");
  const pixi = LAYER.indexOf('import("pixi.js")');
  const shim = LAYER.indexOf('import("@pixi/unsafe-eval")');
  assert.ok(pixi > 0 && shim > 0);
  const between = LAYER.slice(Math.min(pixi, shim), Math.max(pixi, shim));
  assert.ok(
    between.length < 200,
    "the two imports are far apart, so they are probably not awaited together",
  );
});

test("the shim is a real dependency at a version that matches Pixi", () => {
  const pixi = PACKAGE.dependencies["pixi.js"];
  const shim = PACKAGE.dependencies["@pixi/unsafe-eval"];
  assert.ok(pixi, "pixi.js is not a dependency");
  assert.ok(shim, "@pixi/unsafe-eval is not a dependency -- the import would fail to resolve");
  // Pixi's own requirement: the shim reaches into renderer internals, so a major
  // mismatch silently installs the wrong hooks rather than erroring.
  const major = (range) => range.replace(/^[^\d]*/, "").split(".")[0];
  assert.equal(major(shim), major(pixi), `@pixi/unsafe-eval ${shim} against pixi.js ${pixi}`);
});

test("the policy this exists for still refuses unsafe-eval", () => {
  // If a future CSP gains 'unsafe-eval', the shim stops being load-bearing and this
  // whole file is arguing about nothing -- which is worth knowing, because the next
  // reader will otherwise take the import for a stray dependency and remove it.
  const csp = HEADERS.match(/add_header Content-Security-Policy "([^"]+)"/);
  assert.ok(csp, "the CSP is not where this test thinks it is");
  const scriptSrc = csp[1].split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc, "there is no script-src directive");
  assert.ok(
    !scriptSrc.includes("unsafe-eval"),
    "script-src now permits unsafe-eval. That is a bigger change than it looks -- read "
    + "security-headers.conf's own note on why script-src is 'self' and nothing else -- "
    + "and if it is deliberate, this test and the shim's comment both need rewriting "
    + "rather than the shim being dropped",
  );
});

test("a renderer that fails anyway still says so out loud", () => {
  // The shim fixes the one cause we found. The console.error is what let it be found
  // at all: before it, a refused renderer was silent and the layer simply drew
  // nothing for ever. Any other cause -- a driver refusing a context, a browser out
  // of them -- lands in the same catch, and has to keep naming the consequence.
  assert.match(
    LAYER,
    /console\.error\(\s*"WebGL entity layer: no renderer, ships and aircraft will not draw:"/,
    "the renderer failure is no longer reported, or no longer names what stops drawing",
  );
});
