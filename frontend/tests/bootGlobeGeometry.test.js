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
