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
