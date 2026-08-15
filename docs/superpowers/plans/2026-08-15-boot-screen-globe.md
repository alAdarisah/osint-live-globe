# Boot Screen Globe and Honest Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the boot screen's radar sweep with a rotating orthographic graticule globe, and give every source line in the boot log a record count, an elapsed time, and a reason when it did not load.

**Architecture:** All the maths and all the string formatting live in two plain-JS modules with no React and no DOM, so they are covered by the existing `node --test` suite. `BootGlobe.jsx` is a thin renderer over the geometry module. `useOsintData.js` widens its three existing `markSource*` call sites to carry timing, counts and failure detail; `LoadingScreen.jsx` renders that detail. `api.js` gains one property on the error it already throws.

**Tech Stack:** React 18, Vite 5, inline SVG, Node's built-in test runner (`node --test` with `node:test` / `node:assert/strict`). No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-15-boot-screen-globe-design.md`

## Global Constraints

- **No new dependencies.** No 3D or charting library. The globe is inline SVG plus arithmetic. The repo has just moved Leaflet to same-origin hosting and tightened its content policy; a CDN-delivered or WebGL globe library runs against that.
- **Tests are `node --test`, not Vitest.** Import `test` from `node:test` and `assert` from `node:assert/strict`. Run from the `frontend/` directory.
- **Test files must not import React, JSX, or anything touching `document`/`window` at module scope.** The suite's existing promise (see the comment at the top of `frontend/tests/scene.test.js`) is that it stays free of React and the DOM. This is why the pure logic is split into its own modules.
- **Timing constants are not to be changed.** `MIN_VISIBLE_MS = 1400`, `MAX_VISIBLE_MS = 9000`, and the `700` ms removal delay in `LoadingScreen.jsx` stay exactly as they are.
- **`.loading-inner` stays at `max-width: 380px`.** The new detail is made to fit that column.
- **The boot screen stays theme-independent (always dark).** Do not introduce `var(--bg)`, `var(--text)` or any other theme token into `#loadingScreen`'s subtree. The existing hard-coded cyan family is deliberate.
- **Separator character in meta lines is `·` (U+00B7 MIDDLE DOT)**, with a single space either side.
- **Number grouping is `toLocaleString("en-US")`**, never bare `toLocaleString()` — the latter varies with the machine's locale and would make the tests environment-dependent.

---

### Task 1: Boot source meta module

The pure functions that turn a fetch outcome into the text a log line shows. Nothing else in this plan can be tested until these exist, so this is first.

**Files:**
- Create: `frontend/src/hooks/bootSourceMeta.js`
- Test: `frontend/tests/bootSourceMeta.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `countOf(data) -> number | null`
  - `failureDetail(err) -> string`
  - `formatBootMeta(source) -> string | null` where `source` is `{ status, ms, count, detail }`

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/bootSourceMeta.test.js`:

```js
// The boot log claims three things about each source: how many rows it
// returned, how long it took, and -- when it did not return -- why. These are
// the shapes those three claims have to survive, including the ones where the
// honest answer is "no number to show" rather than zero.

import test from "node:test";
import assert from "node:assert/strict";

import { countOf, failureDetail, formatBootMeta } from "../src/hooks/bootSourceMeta.js";

test("counts the rows of a payload that has rows", () => {
  assert.equal(countOf([1, 2, 3]), 3);
  assert.equal(countOf([]), 0);
  assert.equal(countOf({ type: "FeatureCollection", features: [{}, {}] }), 2);
  assert.equal(countOf({ type: "FeatureCollection", features: [] }), 0);
});

test("says nothing rather than zero when a payload has no rows to count", () => {
  // An absent count and a count of zero are different claims, and the log has
  // to be able to make the first one. A string in particular must not be
  // counted by its .length -- that would report a character total as a row
  // total.
  assert.equal(countOf(null), null);
  assert.equal(countOf(undefined), null);
  assert.equal(countOf("abcd"), null);
  assert.equal(countOf(7), null);
  assert.equal(countOf({ as_of: "2026-08-15" }), null);
  assert.equal(countOf({ features: "not-an-array" }), null);
});

test("reports an HTTP status when the response carried one", () => {
  const err = new Error("/api/fires: 503");
  err.status = 503;
  assert.equal(failureDetail(err), "HTTP 503");
});

test("does not call a transport failure an HTTP error", () => {
  // fetch() rejecting outright (DNS, offline, blocked) never produced a
  // response, so there is no status -- and printing "HTTP undefined" would be
  // inventing one.
  assert.equal(failureDetail(new TypeError("fetch failed")), "unreachable");
  assert.equal(failureDetail(undefined), "unreachable");
});

test("formats a loaded source as its count and its elapsed time", () => {
  assert.equal(
    formatBootMeta({ status: "ok", ms: 340, count: 12480, detail: null }),
    "12,480 rows · 340ms"
  );
  assert.equal(formatBootMeta({ status: "ok", ms: 12, count: 0, detail: null }), "0 rows · 12ms");
});

test("shows the time alone when the payload had nothing countable", () => {
  assert.equal(formatBootMeta({ status: "ok", ms: 90, count: null, detail: null }), "90ms");
});

test("switches to seconds once a source takes longer than a second", () => {
  assert.equal(formatBootMeta({ status: "ok", ms: 1500, count: null, detail: null }), "1.5s");
  assert.equal(formatBootMeta({ status: "ok", ms: 999, count: null, detail: null }), "999ms");
});

test("gives the reason instead of the numbers when a source did not load", () => {
  assert.equal(
    formatBootMeta({ status: "warn", ms: 40, count: null, detail: "HTTP 503" }),
    "HTTP 503"
  );
  assert.equal(
    formatBootMeta({ status: "timeout", ms: null, count: null, detail: "still waiting" }),
    "still waiting"
  );
  assert.equal(
    formatBootMeta({ status: "deferred", ms: null, count: null, detail: "below zoom gate" }),
    "below zoom gate"
  );
});

test("says nothing at all about a source still in flight", () => {
  // A pending line has no true statement available to it yet, and a blank is
  // the honest rendering of that.
  assert.equal(formatBootMeta({ status: "pending", ms: null, count: null, detail: null }), null);
  assert.equal(formatBootMeta({ status: "ok", ms: null, count: null, detail: null }), null);
  assert.equal(formatBootMeta(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`:

```bash
node --test tests/bootSourceMeta.test.js
```

Expected: FAIL — `Cannot find module` for `../src/hooks/bootSourceMeta.js`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/hooks/bootSourceMeta.js`:

```js
// What a boot-screen log line is allowed to say about a source, derived from
// the outcome useOsintData.js recorded for it. Kept as plain functions in their
// own module rather than inside useOsintData.js or LoadingScreen.jsx so the
// claims can be tested directly -- the suite in frontend/tests stays free of
// React and the DOM.

// Rows in a payload, or null when the payload is not the kind of thing that has
// rows. Null and 0 are deliberately different answers: "nothing to count" is
// not "counted nothing", and the log renders them differently. Array.isArray is
// the guard rather than a truthy `.length` check, so a string is never reported
// by its character count.
export function countOf(data) {
  if (Array.isArray(data)) return data.length;
  if (data && Array.isArray(data.features)) return data.features.length;
  return null;
}

// Why a fetch failed, in the fewest words that are still true. A response that
// came back with a bad status has a number worth showing; a fetch that rejected
// before any response existed does not, and must not be given one.
export function failureDetail(err) {
  if (err && typeof err.status === "number") return `HTTP ${err.status}`;
  return "unreachable";
}

function formatElapsed(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// The dim second line under a source's label, or null when there is nothing
// true to put there yet. `detail` wins over the numbers because a source that
// failed has a reason worth more than the milliseconds it spent failing.
export function formatBootMeta(source) {
  if (!source || source.status === "pending") return null;
  if (source.detail) return source.detail;
  if (source.ms == null) return null;
  const elapsed = formatElapsed(source.ms);
  if (source.count == null) return elapsed;
  return `${source.count.toLocaleString("en-US")} rows · ${elapsed}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`:

```bash
node --test tests/bootSourceMeta.test.js
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/bootSourceMeta.js frontend/tests/bootSourceMeta.test.js
git commit -m "Decide what a boot line may claim about a source it has not counted"
```

---

### Task 2: Carry the HTTP status out of a failed fetch

**Files:**
- Modify: `frontend/src/api.js:43`
- Test: `frontend/tests/api.test.js` (create)

**Interfaces:**
- Consumes: `failureDetail` from Task 1 reads `err.status`; this task is what puts it there.
- Produces: `fetchJson` rejects with an `Error` whose `.status` is the numeric HTTP status when a response was received, and `undefined` when none was.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/api.test.js`:

```js
// fetchJson's rejection is the only thing that survives a failed poll, so
// whatever the boot screen wants to say about a failure has to be reachable
// from that error object. Parsing it back out of the message string would tie
// the UI to a log format and would put a full API URL on the splash screen.

import test from "node:test";
import assert from "node:assert/strict";

import { fetchJson } from "../src/api.js";

test("a bad response rejects with its numeric status attached", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    await assert.rejects(
      () => fetchJson("/api/test-bad-status"),
      (err) => {
        assert.equal(err.status, 503);
        // The message is unchanged from what it has always been, so anything
        // already reading it keeps working.
        assert.match(err.message, /\/api\/test-bad-status: 503$/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a transport failure rejects with no status at all", async () => {
  // There was no response, so there is no status. Defaulting to one would let
  // the boot screen report an HTTP error that never happened.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  try {
    await assert.rejects(
      () => fetchJson("/api/test-unreachable"),
      (err) => err.status === undefined
    );
  } finally {
    globalThis.fetch = original;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`:

```bash
node --test tests/api.test.js
```

Expected: FAIL — the first test fails on `err.status`, which is `undefined` because `api.js` throws a bare `Error`.

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/api.js`, replace line 43:

```js
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
```

with:

```js
  if (!resp.ok) {
    // The status is attached as a property, not left to be parsed back out of
    // the message: the boot screen wants to say "HTTP 503" without also putting
    // this URL on screen, and recovering a number from a log string would tie
    // that display to this message's exact format. The message itself is
    // unchanged, so every existing caller behaves as before.
    const err = new Error(`${url}: ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`:

```bash
node --test tests/api.test.js
```

Expected: PASS, 2 tests.

Then run the whole suite to confirm nothing else read this error:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api.js frontend/tests/api.test.js
git commit -m "Let a failed fetch say which status it got without printing its URL"
```

---

### Task 3: Globe geometry

**Files:**
- Create: `frontend/src/components/bootGlobeGeometry.js`
- Test: `frontend/tests/bootGlobeGeometry.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `GLOBE_SIZE` — number, `110`
  - `project(latDeg, lonDeg, spinRadians, size) -> { x, y, visible }`
  - `graticulePaths(spinRadians, size) -> { meridians: string[], parallels: string[] }`

**Note on the meridian count:** the spec says "six meridians", which is what a
viewer sees. Twelve meridian lines at 30° spacing are generated across the full
360°; roughly half face away from the viewer at any moment and are clipped. Do
not generate only six — that would leave the globe bald on one side as it turns.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/bootGlobeGeometry.test.js`:

```js
// An orthographic globe is only convincing if the far side is actually missing.
// These check the two things that make it read as a sphere rather than a flat
// grid -- where the centre of the disc really is, and that back-facing points
// are dropped instead of folded onto the visible face.

import test from "node:test";
import assert from "node:assert/strict";

import { GLOBE_SIZE, graticulePaths, project } from "../src/components/bootGlobeGeometry.js";

const SIZE = 110;
const CENTRE = SIZE / 2;

test("the tilt latitude, not the equator, sits at the centre of the disc", () => {
  // The projection is centred on 20N. Asserting 0N/0E lands in the middle would
  // be asserting that the tilt does not exist.
  const p = project(20, 0, 0, SIZE);
  assert.ok(Math.abs(p.x - CENTRE) < 1e-9, `x was ${p.x}`);
  assert.ok(Math.abs(p.y - CENTRE) < 1e-9, `y was ${p.y}`);
  assert.equal(p.visible, true);

  const equator = project(0, 0, 0, SIZE);
  assert.ok(equator.y > CENTRE, "the equator should sit below the middle of the disc");
});

test("half a turn brings the opposite meridian to the centre", () => {
  const p = project(20, 180, Math.PI, SIZE);
  assert.ok(Math.abs(p.x - CENTRE) < 1e-9, `x was ${p.x}`);
  assert.ok(Math.abs(p.y - CENTRE) < 1e-9, `y was ${p.y}`);
  assert.equal(p.visible, true);
});

test("the far side of the sphere is not visible", () => {
  assert.equal(project(20, 180, 0, SIZE).visible, false);
  assert.equal(project(-70, 180, 0, SIZE).visible, false);
  // ...and rotating it round brings it back.
  assert.equal(project(20, 180, Math.PI, SIZE).visible, true);
});

test("longitudes mirror about the vertical axis", () => {
  const east = project(35, 40, 0, SIZE);
  const west = project(35, -40, 0, SIZE);
  assert.ok(Math.abs((east.x - CENTRE) + (west.x - CENTRE)) < 1e-9);
  assert.ok(Math.abs(east.y - west.y) < 1e-9);
});

test("every point stays inside the disc", () => {
  const radius = SIZE / 2 - 1;
  for (let lat = -90; lat <= 90; lat += 10) {
    for (let lon = 0; lon < 360; lon += 10) {
      const p = project(lat, lon, 0.7, SIZE);
      const dist = Math.hypot(p.x - CENTRE, p.y - CENTRE);
      assert.ok(dist <= radius + 1e-9, `${lat},${lon} landed ${dist} from centre`);
    }
  }
});

test("emits well-formed paths for both families of lines", () => {
  const { meridians, parallels } = graticulePaths(0, SIZE);
  assert.ok(meridians.length >= 6, `only ${meridians.length} meridian runs`);
  assert.ok(parallels.length >= 1, "no parallels emitted");
  for (const d of [...meridians, ...parallels]) {
    assert.match(d, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/, `bad path: ${d}`);
    assert.ok(!d.includes("NaN"));
  }
});

test("a full turn returns to where it started", () => {
  // Holds because coordinates are rounded to one decimal before they reach the
  // path string, which absorbs the float dust left by sin(2*PI).
  const a = graticulePaths(0, SIZE);
  const b = graticulePaths(Math.PI * 2, SIZE);
  assert.deepEqual(b, a);
});

test("the exported size is the footprint the splash reserves", () => {
  assert.equal(GLOBE_SIZE, 110);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `frontend/`:

```bash
node --test tests/bootGlobeGeometry.test.js
```

Expected: FAIL — `Cannot find module` for `../src/components/bootGlobeGeometry.js`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/bootGlobeGeometry.js`:

```js
// The wire sphere on the boot screen, as arithmetic. Kept apart from
// BootGlobe.jsx so it can be tested without React or a DOM, the same split
// sanctionsBoardLogic.js and countryCompareLogic.js already use.
//
// Orthographic projection: the viewer is infinitely far away, so the sphere
// draws as a disc and a point's visibility is just the sign of its depth. That
// clipping is the whole trick -- a graticule with the back half still drawn is
// a flat grid, not a globe.

const RAD = Math.PI / 180;

// The latitude the projection is centred on. Non-zero on purpose: with the
// centre on the equator the parallels are straight lines and the thing reads as
// a badge. Twenty degrees is enough to curve them and put the north pole inside
// the disc rather than exactly on its rim.
const TILT_DEG = 20;
const SIN_TILT = Math.sin(TILT_DEG * RAD);
const COS_TILT = Math.cos(TILT_DEG * RAD);

// Matches the 110px footprint the radar this replaces occupied, so the vertical
// rhythm of the splash is unchanged.
export const GLOBE_SIZE = 110;

const MERIDIAN_STEP_DEG = 30; // 12 lines; about half face the viewer at a time
const PARALLEL_LATS = [-60, -30, 0, 30, 60]; // poles omitted -- they are points
const SAMPLE_STEP_DEG = 4; // fine enough that the polyline reads as a curve

export function project(latDeg, lonDeg, spinRadians, size = GLOBE_SIZE) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD - spinRadians;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const cosLon = Math.cos(lon);
  const radius = size / 2 - 1; // room for the rim stroke
  return {
    x: size / 2 + radius * cosLat * Math.sin(lon),
    y: size / 2 - radius * (COS_TILT * sinLat - SIN_TILT * cosLat * cosLon),
    // Depth relative to the viewing plane. Zero is exactly on the limb, which
    // is kept: dropping it would leave a visible gap where a line meets the rim.
    visible: SIN_TILT * sinLat + COS_TILT * cosLat * cosLon >= 0,
  };
}

// Walks a line's samples and emits one path per unbroken visible run, so a line
// that crosses the limb breaks in two rather than being drawn straight through
// the body of the globe. Coordinates are rounded to one decimal -- enough
// precision at this size, and it keeps the emitted strings stable frame to
// frame instead of jittering in the last float digit.
function pathsFromSamples(samples, spinRadians, size) {
  const paths = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) paths.push(`M${run.join("L")}`);
    run = [];
  };
  for (const [lat, lon] of samples) {
    const p = project(lat, lon, spinRadians, size);
    if (!p.visible) {
      flush();
      continue;
    }
    run.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  flush();
  return paths;
}

export function graticulePaths(spinRadians, size = GLOBE_SIZE) {
  const meridians = [];
  for (let lon = 0; lon < 360; lon += MERIDIAN_STEP_DEG) {
    const samples = [];
    for (let lat = -90; lat <= 90; lat += SAMPLE_STEP_DEG) samples.push([lat, lon]);
    meridians.push(...pathsFromSamples(samples, spinRadians, size));
  }

  const parallels = [];
  for (const lat of PARALLEL_LATS) {
    const samples = [];
    // Through 360 rather than stopping at 356, so a fully visible parallel
    // closes on itself. A partly hidden one breaks into two runs that meet at
    // the same screen point, which draws as one arc.
    for (let lon = 0; lon <= 360; lon += SAMPLE_STEP_DEG) samples.push([lat, lon]);
    parallels.push(...pathsFromSamples(samples, spinRadians, size));
  }

  return { meridians, parallels };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `frontend/`:

```bash
node --test tests/bootGlobeGeometry.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/bootGlobeGeometry.js frontend/tests/bootGlobeGeometry.test.js
git commit -m "Project a graticule onto a sphere and throw away the half facing away"
```

---

### Task 4: The globe component

No unit test — this is React and SVG, which the suite deliberately does not
cover. It is verified in the browser in Task 7.

**Files:**
- Create: `frontend/src/components/BootGlobe.jsx`

**Interfaces:**
- Consumes: `GLOBE_SIZE`, `graticulePaths` from Task 3.
- Produces: `export default function BootGlobe({ hidden })` — an `<svg class="boot-globe">` of `GLOBE_SIZE` square.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/BootGlobe.jsx`:

```jsx
import { useEffect, useState } from "react";

import { GLOBE_SIZE, graticulePaths } from "./bootGlobeGeometry.js";

// Radians per second. Slow enough to read as a globe turning rather than a
// spinner: a full rotation takes about eighteen seconds, which is longer than
// the boot screen's own nine-second ceiling, so the reader never sees it loop.
const SPIN_RATE = 0.35;

// The same pair useCountUp.js checks -- the in-app setting (useAppSettings.js
// puts the class on the root element) or the OS-level preference. Read at
// effect time rather than through a subscription: this component lives for a
// few seconds at boot, and a reader toggling the setting mid-splash is not a
// case worth wiring for.
function motionOff() {
  return (
    document.documentElement.classList.contains("reduce-motion") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// The wire globe behind the boot log. Unlike the radar sweep it replaces, the
// motion here is JavaScript rather than a CSS animation, so reduced motion has
// to be honoured in the component -- a stylesheet cannot switch off a rAF loop.
// (The sweep was never exempted in either reduced-motion block, so it spun
// regardless of the setting. This does not.)
export default function BootGlobe({ hidden }) {
  const [spin, setSpin] = useState(0);

  useEffect(() => {
    // Nothing to animate behind a screen that is already fading out, and
    // nothing to animate for a reader who asked for stillness.
    if (hidden || motionOff()) return undefined;

    let raf = 0;
    let last = performance.now();
    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setSpin((s) => (s + SPIN_RATE * dt) % (Math.PI * 2));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  const { meridians, parallels } = graticulePaths(spin, GLOBE_SIZE);
  const centre = GLOBE_SIZE / 2;
  const radius = GLOBE_SIZE / 2 - 1;

  return (
    <svg
      className="boot-globe"
      width={GLOBE_SIZE}
      height={GLOBE_SIZE}
      viewBox={`0 0 ${GLOBE_SIZE} ${GLOBE_SIZE}`}
      // Decorative: the log underneath is what actually reports boot progress,
      // and a screen reader announcing a rotating grid would add nothing.
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="bootGlobeFill" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="rgba(111, 227, 255, 0.16)" />
          <stop offset="100%" stopColor="rgba(111, 227, 255, 0.02)" />
        </radialGradient>
      </defs>
      <circle cx={centre} cy={centre} r={radius} fill="url(#bootGlobeFill)" />
      {parallels.map((d, i) => (
        <path key={`p${i}`} className="boot-globe-line" d={d} />
      ))}
      {meridians.map((d, i) => (
        <path key={`m${i}`} className="boot-globe-line" d={d} />
      ))}
      <circle className="boot-globe-rim" cx={centre} cy={centre} r={radius} />
    </svg>
  );
}
```

- [ ] **Step 2: Verify it builds**

Run from `frontend/`:

```bash
npm run build
```

Expected: build succeeds. It will report the component as unused-but-bundled only if something imports it; at this point nothing does, so this step is purely checking the file parses.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BootGlobe.jsx
git commit -m "Turn the globe the app is named after, and stop if asked to be still"
```

---

### Task 5: Record what each source actually did

**Files:**
- Modify: `frontend/src/hooks/useOsintData.js` — `BOOT_SOURCES` (lines 49-68), the `bootSources` initial state (line 330), `markSourceLoaded` (544-548), `markSourceDeferred` (550-554), and the three call sites in `tick()` (609, 677, 689).

**Interfaces:**
- Consumes: `countOf`, `failureDetail` from Task 1; `err.status` from Task 2.
- Produces: every entry of the `bootSources` array now carries `{ key, label, short, status, ms, count, detail }`. `status` is one of `pending`, `ok`, `warn`, `deferred`. `ms`, `count` and `detail` are `null` when not applicable.

- [ ] **Step 1: Add the import**

At the top of `frontend/src/hooks/useOsintData.js`, alongside the existing imports:

```js
import { countOf, failureDetail } from "./bootSourceMeta.js";
```

- [ ] **Step 2: Add short labels to BOOT_SOURCES**

Give every entry a `short`. Keep every existing `label` exactly as it is — the
long form names the upstream source, which is how a reader knows what kind of
evidence a layer is, and it survives as the row's hover text.

```js
const BOOT_SOURCES = [
  { key: "countries", label: "Country boundaries", short: "Country boundaries" },
  { key: "cities", label: "City index", short: "City index" },
  {
    key: "events",
    label: "Conflict & violence events (ACLED + UCDP + GDELT, fused)",
    short: "Conflict events",
  },
  { key: "firms", label: "Thermal anomaly feed (NASA FIRMS)", short: "Thermal anomalies" },
  { key: "gdelt", label: "Global news stream (GDELT)", short: "News stream" },
  { key: "ais", label: "Maritime traffic (AIS)", short: "Maritime traffic" },
  { key: "adsb", label: "Aircraft tracking (ADS-B)", short: "Aircraft tracking" },
  { key: "jamming", label: "GPS/radio jamming (GPSJam)", short: "GPS jamming" },
  { key: "satellites", label: "Satellite tracking (CelesTrak)", short: "Satellites" },
  // Task 24: the three client-propagated groups on by default (see
  // map/scene.js) -- same footing as "satellites" above, the server-
  // propagated pair. The other four groups are off by default and fetched
  // on demand instead (see createMapController.js's setLayerVisible), so
  // they never belong on this list -- nothing should make the boot screen
  // wait on a layer nobody has asked to see yet.
  {
    key: "satNavigation",
    label: "Satellite tracking: navigation (CelesTrak, browser-propagated)",
    short: "Satellites: navigation",
  },
  {
    key: "satWeather",
    label: "Satellite tracking: weather (CelesTrak, browser-propagated)",
    short: "Satellites: weather",
  },
  {
    key: "satImaging",
    label: "Satellite tracking: Earth imaging (CelesTrak, browser-propagated)",
    short: "Satellites: imaging",
  },
];
```

- [ ] **Step 3: Give the initial state its empty meta fields**

Replace line 330:

```js
  const [bootSources, setBootSources] = useState(() => BOOT_SOURCES.map((s) => ({ ...s, status: "pending" })));
```

with:

```js
  // ms/count/detail start null rather than absent so every row has the same
  // shape from first paint, and the boot screen never has to distinguish "not
  // measured yet" from "this key does not exist on this object".
  const [bootSources, setBootSources] = useState(() =>
    BOOT_SOURCES.map((s) => ({ ...s, status: "pending", ms: null, count: null, detail: null }))
  );
```

- [ ] **Step 4: Widen the two mark functions**

Replace `markSourceLoaded` and `markSourceDeferred`:

```js
    // `meta` carries what the boot log reports underneath the label: how long
    // the round trip took, how many rows came back, and -- on failure -- why.
    // The three fields are written unconditionally rather than spread, so a
    // deferred source that later loads for real has its "below zoom gate"
    // detail cleared instead of keeping a stale reason next to a green tick.
    function markSourceLoaded(key, ok, meta = {}) {
      setBootSources((prev) =>
        prev.map((s) =>
          s.key === key && UNRESOLVED.has(s.status)
            ? {
                ...s,
                status: ok ? "ok" : "warn",
                ms: meta.ms ?? null,
                count: meta.count ?? null,
                detail: meta.detail ?? null,
              }
            : s
        )
      );
    }

    function markSourceDeferred(key) {
      setBootSources((prev) =>
        prev.map((s) =>
          s.key === key && s.status === "pending"
            ? { ...s, status: "deferred", ms: null, count: null, detail: "below zoom gate" }
            : s
        )
      );
    }
```

- [ ] **Step 5: Time the fetch and report the outcome**

In `tick()`, move the clock start *above* the `try` so the `catch` branch can
read it too. Change:

```js
        try {
          // Captured before the await, so the signature recorded below is the
```

to:

```js
        // Above the try, not inside it, so the catch branch can measure a
        // failure as well as a success -- how long a source took to fail is as
        // much a fact about the boot as how long it took to load.
        const startedAt = Date.now();
        try {
          // Captured before the await, so the signature recorded below is the
```

Then replace the success call (currently line 677):

```js
          markSourceLoaded(key, true);
```

with:

```js
          markSourceLoaded(key, true, { ms: Date.now() - startedAt, count: countOf(data) });
```

And the failure call (currently line 689):

```js
            markSourceLoaded(key, false);
```

with:

```js
            markSourceLoaded(key, false, {
              ms: Date.now() - startedAt,
              detail: failureDetail(err),
            });
```

- [ ] **Step 6: Verify the suite and the build still pass**

Run from `frontend/`:

```bash
npm test && npm run build
```

Expected: PASS and a successful build. Nothing in the suite imports this module, so this is a regression check on the modules it does cover plus a syntax check on this one.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useOsintData.js
git commit -m "Measure what each boot source returned, not only that it returned"
```

---

### Task 6: Render the globe and the fuller log

**Files:**
- Modify: `frontend/src/components/LoadingScreen.jsx`
- Modify: `frontend/src/style.css` — the boot-screen block starting at line 3292, and the stagger ladder at lines 1644-1675.

**Interfaces:**
- Consumes: `BootGlobe` from Task 4, `formatBootMeta` from Task 1, and the widened `bootSources` shape from Task 5.
- Produces: nothing further downstream.

- [ ] **Step 1: Update the imports and the glyph table**

In `frontend/src/components/LoadingScreen.jsx`, add below the existing React import:

```js
import BootGlobe from "./BootGlobe.jsx";
import { formatBootMeta } from "../hooks/bootSourceMeta.js";
```

Replace the glyph table:

```js
const STATUS_GLYPH = { pending: "⋯", ok: "✓", warn: "―", timeout: "⚠" };
```

with:

```js
// "deferred" was missing here while useOsintData.js was already producing it
// for a source sitting below its zoom gate -- cities is one, and the map opens
// at zoom 3 -- so that row rendered a blank glyph in a class no rule matched.
// A source correctly not fetched is not a failure and does not get a warning
// mark; it gets a quiet dot and says why on the line beneath.
const STATUS_GLYPH = { pending: "⋯", ok: "✓", warn: "―", timeout: "⚠", deferred: "·" };
```

- [ ] **Step 2: Give the timed-out rows their reason**

Replace the `displaySources` expression:

```js
  const displaySources = forceDone
    ? sources.map((s) => (s.status === "pending" ? { ...s, status: "timeout" } : s))
    : sources;
```

with:

```js
  const displaySources = forceDone
    ? sources.map((s) =>
        s.status === "pending" ? { ...s, status: "timeout", detail: "still waiting" } : s
      )
    : sources;
```

- [ ] **Step 3: Replace the radar and rebuild the log rows**

Replace the radar markup:

```jsx
        <div className="loading-radar">
          <div className="loading-radar-ring" />
          <div className="loading-radar-ring loading-radar-ring-2" />
          <div className="loading-radar-sweep" />
        </div>
```

with:

```jsx
        <BootGlobe hidden={hidden} />
```

Replace the log list:

```jsx
        <ul className="loading-log">
          {displaySources.map((s) => (
            <li key={s.key} className={`loading-log-line ${s.status}`}>
              <span className="loading-log-status">{STATUS_GLYPH[s.status]}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
```

with:

```jsx
        <ul className="loading-log">
          {displaySources.map((s) => {
            const meta = formatBootMeta(s);
            return (
              // title carries the full upstream attribution -- the short name is
              // what fits the column, but which feed a layer came from is the
              // part a reader actually needs, so it stays one hover away rather
              // than being dropped.
              <li key={s.key} className={`loading-log-line ${s.status}`} title={s.label}>
                <span className="loading-log-status">{STATUS_GLYPH[s.status]}</span>
                <span className="loading-log-text">
                  <span className="loading-log-label">{s.short || s.label}</span>
                  {meta ? <span className="loading-log-meta">{meta}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
```

- [ ] **Step 4: Replace the radar styles**

In `frontend/src/style.css`, delete these rules entirely: `.loading-radar`,
`.loading-radar-ring`, `.loading-radar-ring-2`, `.loading-radar-sweep`, and the
`@keyframes loading-radar-spin` block (lines 3323-3349).

In their place:

```css
/* The wire globe. Its rotation lives in BootGlobe.jsx rather than in a CSS
   animation, because the far half of the sphere has to be clipped every frame
   and no transform can do that -- which is also why reduced motion is handled
   in the component instead of by an `animation: none` override down at the
   bottom of this file. */
.boot-globe {
  display: block;
  overflow: visible;
}
.boot-globe-line {
  fill: none;
  stroke: rgba(111, 227, 255, 0.22);
  stroke-width: 1;
}
.boot-globe-rim {
  fill: none;
  stroke: rgba(111, 227, 255, 0.34);
  stroke-width: 1;
}
```

- [ ] **Step 5: Style the two-line rows**

Replace the `.loading-log-line` rule's `align-items: center;` with
`align-items: flex-start;` — the glyph belongs beside the label, not centred
against a row that is now two lines tall.

Add, after the existing `.loading-log-line.timeout` rule:

```css
/* A source below its zoom gate was correctly not fetched. Colouring it with
   warn's orange would report a failure that did not happen, so it gets its own
   muted slate instead. */
.loading-log-line.deferred { opacity: 0.75; color: #93a7b4; }
```

Add, after the existing `.loading-log-line.timeout .loading-log-status` rule:

```css
.loading-log-line.deferred .loading-log-status { color: #93a7b4; }
```

And add the new text-column rules:

```css
.loading-log-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.loading-log-label { line-height: 1.35; }
/* Counts and timings sit below the label rather than beside it: the column is
   380px and the alternative was cutting the source names down further, which
   would have cost the attribution the labels exist to carry. Tabular figures so
   a column of numbers does not shimmer as it counts up. */
.loading-log-meta {
  font-size: 9.5px;
  letter-spacing: 0.4px;
  color: rgba(207, 232, 242, 0.45);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6: Extend the stagger ladder to twelve**

The ladder stops at `nth-child(8)`, so with twelve boot sources the last four
rows share one fallback delay and arrive together. After the existing
`.loading-log > :nth-child(8)` line, add:

```css
/* Four more than the shared ladder above covers: BOOT_SOURCES has twelve
   entries, and without these the last four rows all land on the fallback delay
   at once instead of continuing the cascade. */
.loading-log > :nth-child(9) { animation-delay: calc(var(--stagger-step) * 8); }
.loading-log > :nth-child(10) { animation-delay: calc(var(--stagger-step) * 9); }
.loading-log > :nth-child(11) { animation-delay: calc(var(--stagger-step) * 10); }
.loading-log > :nth-child(12) { animation-delay: calc(var(--stagger-step) * 11); }
```

- [ ] **Step 7: Verify the suite and the build still pass**

Run from `frontend/`:

```bash
npm test && npm run build
```

Expected: PASS and a successful build.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/LoadingScreen.jsx frontend/src/style.css
git commit -m "Show the globe, and let each boot line say what it loaded and why not"
```

---

### Task 7: Verify it in the browser

**Files:** none modified. This task is verification only, and produces the
screenshot that closes the work.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: nothing.

- [ ] **Step 1: Start the app**

Use the preview tooling rather than a bare shell. `.claude/launch.json` already
defines `frontend-dev` (`npm run dev` in `frontend/`, port 5173) — start that
one. The backend is `backend-dev` on port 8000 if the data feeds need to be
live, which Step 4 depends on.

- [ ] **Step 2: Confirm the globe turns and the log fills in**

Load the app and watch the boot screen. Check:
- the globe rotates, with lines disappearing at one limb and reappearing at the other rather than sliding across the face
- rows show counts and timings as they resolve
- the log does not overflow the 380px column at any label length

- [ ] **Step 3: Confirm the deferred row explains itself**

The map opens at zoom 3 and `cities` is zoom-gated, so its row should show the
`·` glyph in slate with `below zoom gate` beneath it — not a blank glyph, which
is what it rendered before this work.

- [ ] **Step 4: Confirm a failure reads correctly**

Check the console for any source that failed to fetch, and confirm its row shows
`HTTP <status>` or `unreachable` rather than a bare dash. If every source
succeeds, force one: stop the backend container and reload.

- [ ] **Step 5: Confirm reduced motion stops the globe**

Run in the page console, then reload:

```js
document.documentElement.classList.add("reduce-motion")
```

Expected: the globe renders as a static wireframe and does not turn. Check the
console has no `requestAnimationFrame` warnings.

- [ ] **Step 6: Confirm nothing animates behind the fade-out**

Let the boot screen dismiss normally and confirm there are no console errors
about setting state on an unmounted component.

- [ ] **Step 7: Capture a screenshot and finish**

Take a screenshot of the boot screen mid-load, showing the globe and a log with
a mix of resolved and pending rows.

---

## Notes for the implementer

**Why `setSpin` on every frame is acceptable.** `BootGlobe` re-renders roughly
sixty times a second while the boot screen is up, which is at most nine seconds
and at most seventeen short `<path>` elements. Mutating path `d` attributes
through refs would avoid the re-renders, but it trades readable code for a
saving nobody will measure on a screen that exists for a few seconds. If it ever
shows up in a profile, that is the change to make.

**The `title` attribute is the whole of the attribution fallback.** If a
`BOOT_SOURCES` entry is ever added without a `short`, `s.short || s.label`
renders the long label — the row gets wide rather than blank. That fallback is
deliberate and should not be tightened into a required field.
