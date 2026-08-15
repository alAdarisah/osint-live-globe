// The two-part shim that lets plain `node --test` load app modules whose own
// imports were written for a bundler, not for Node's ESM resolver.
//
// registerHooks patches specifier resolution so an extensionless relative
// import (`import x from "./foo"`, as most of this codebase writes them)
// resolves the same way a bundler would resolve it -- Node itself requires
// the literal `.js`. The `window` stub covers the other half of the same
// problem: some import chains reach map/leafletGlobal.js, which reads
// `window.L` at import time, so importing them at all needs a window that
// looks enough like a browser's to not throw before any test body runs.
//
// This was three verbatim copies (layerGroups.test.js, layerSearchTerms.test.js,
// adminSettings.test.js) before it was one file. Import it first, and only
// for its side effects -- `import "./helpers/nodeTestEnv.js";` -- in any test
// that dynamically imports a module reaching into settings/defaults.js or
// map/water.js.
//
// Side-effect timing, and why this must be the FIRST import in the file:
// ESM hoists every static `import` above the rest of the module body and
// evaluates them in declaration order, before a single line of the test file
// itself runs. That means the registerHooks call and the window stub below
// take effect before any *other* static import in the file is resolved --
// but only if this import is textually first. Put it after some other
// static import and that other import resolves against the unpatched
// resolver, in a window-less environment, and fails exactly the way this
// file exists to prevent. (Static imports of already-node-safe modules --
// "node:test", "node:assert/strict" -- are harmless in front of this one;
// the ordering that matters is relative to imports that need the patch.)

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});

globalThis.window = {
  L: { Layer: { extend: () => ({}) }, DomUtil: {} },
  matchMedia: () => ({ matches: false }),
};
