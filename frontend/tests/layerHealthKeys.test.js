// Every health key the frontend looks up must be a name the backend registers.
//
// `railLive` and `railStations` both mapped to "digitraffic_rail" -- the module's
// filename, not a registered source name; digitraffic_rail.py registers "rail_live"
// and "rail_stations" separately. Nothing failed. A key that is not in the response
// is indistinguishable from a source with no health entry, which this file's own
// header notes several layers legitimately are, so two freshness badges quietly
// showed nothing for months. map/exportBuilder.js reads the same table, so an
// export containing live Finnish trains also carried a provenance block with no
// collection time -- which reads as an untracked curated feed rather than as a live
// one.
//
// This reads the backend's registrations out of the Python source. Coupling a
// frontend test to backend files is unusual and is the point: the failure being
// guarded against is precisely the two halves disagreeing, and a fixture copied
// from one of them could not see it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) return next(`${specifier}.js`, context);
    return next(specifier, context);
  },
});

const { LAYER_HEALTH_KEY } = await import("../src/components/controlPanel/layerHealthKeys.js");

const repoPath = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/** Every source name the backend registers, from the calls that register them. */
function registeredSourceNames() {
  const names = new Set();

  // registry.register("name", ...) / registry.ensure("name", ...) in every
  // collector. A handful pass a constant instead of a literal (SNAPSHOT_PREFIX,
  // SOURCE, SNAPSHOT_NAME); those are resolved from the same file below.
  const sourceDir = repoPath("../../backend/sources");
  for (const entry of readdirSync(sourceDir)) {
    if (!entry.endsWith(".py")) continue;
    const src = readFileSync(path.join(sourceDir, entry), "utf8");
    for (const m of src.matchAll(/registry\.(?:register|ensure)\(\s*(?:"([^"]+)"|([A-Z_][A-Z0-9_]*))/g)) {
      if (m[1]) {
        names.add(m[1]);
        continue;
      }
      const constant = src.match(new RegExp(`^${m[2]}\\s*=\\s*"([^"]+)"`, "m"));
      if (constant) names.add(constant[1]);
    }
  }

  // The ingest and refine job tables publish names the backend mirrors, and
  // app.py synthesises a few more.
  for (const rel of ["../../backend/ingest/__init__.py", "../../backend/refine/__init__.py", "../../backend/app.py"]) {
    const src = readFileSync(repoPath(rel), "utf8");
    for (const m of src.matchAll(/Published\(\s*name\s*=\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/health_name\s*=\s*"([^"]+)"/g)) names.add(m[1]);
    for (const m of src.matchAll(/_DERIVED_JOB_HEALTH_NAMES\s*=\s*\{([^}]*)\}/g)) {
      for (const n of m[1].matchAll(/"([^"]+)"/g)) names.add(n[1]);
    }
  }
  names.add("alert_rules"); // the cache worker's heartbeat, written from its own module

  return names;
}

test("the backend's registration list can actually be read", () => {
  // If the scan silently found nothing, every assertion below would pass
  // vacuously -- which is the failure mode of a test that reads another language's
  // source.
  const names = registeredSourceNames();
  assert.ok(names.size >= 40, `only found ${names.size} registered source names; the scan is broken`);
  for (const expected of ["gdelt", "acled", "firms", "ais", "rail_live", "rail_stations", "events"]) {
    assert.ok(names.has(expected), `the scan missed a name known to exist: ${expected}`);
  }
});

test("every layer's health key names a source the backend registers", () => {
  const names = registeredSourceNames();
  const wrong = Object.entries(LAYER_HEALTH_KEY)
    .filter(([, healthName]) => healthName && !names.has(healthName))
    .map(([layer, healthName]) => `${layer} -> "${healthName}"`);

  assert.deepEqual(
    wrong,
    [],
    "these layers look up a health key no backend source registers, which renders as " +
    `no badge and an export with no collection time rather than as an error:\n${wrong.join("\n")}`,
  );
});

test("the two rail layers point at their own sources, not at their shared module", () => {
  // The specific regression, named, so a future edit that reverts to the module
  // name fails with an explanation rather than with a list.
  assert.equal(LAYER_HEALTH_KEY.railLive, "rail_live");
  assert.equal(LAYER_HEALTH_KEY.railStations, "rail_stations");
  assert.notEqual(LAYER_HEALTH_KEY.railLive, LAYER_HEALTH_KEY.railStations);
});
