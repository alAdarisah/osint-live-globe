// Client-side solar position and day/night terminator maths for Task 46.
//
// Deliberately reimplemented here rather than pulled from a library: the
// task brief is explicit that this is short enough not to need one, and
// every formula below is the standard "low precision" solar coordinates
// algorithm (good to roughly 0.01 degree in declination/right ascension for
// dates within a couple of centuries of J2000 -- see e.g. the Astronomical
// Almanac's own low-precision sun position section, or Meeus, *Astronomical
// Algorithms*, ch. 25) rather than anything measured or reported.
//
// Everything this module returns is DERIVED, in the four-word provenance
// vocabulary this map uses everywhere else: arithmetic over the clock and a
// set of coordinates, never an observation, and never dressed up as one.
//
// frontend/tests/terminator.test.js checks this module's output against
// values generated with Skyfield (already a server-side dependency of this
// project) rather than against anything typed from memory -- see that
// file's own header for the exact generation script, the ephemeris used,
// and the instants checked.

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const MINUTE_MS = 60000;

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/** Julian date for a JS Date, treating its UTC clock as UT1 -- the small
 * (sub-second) UT1/UTC difference is far below this algorithm's own
 * precision floor, so it is not worth carrying a leap-second table for. */
function julianDate(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * The sun's declination and right ascension (equinox of date, i.e. no
 * separate nutation/precession correction -- again below this algorithm's
 * own precision floor), plus the two intermediate values the rest of this
 * module reuses (`n`, the day count `subsolarPoint`/`sunPosition` both need
 * for the sidereal-time step).
 */
function sunEquatorialCoords(date) {
  const jd = julianDate(date);
  const n = jd - 2451545.0; // days since J2000.0

  const meanLongitude = normalizeDeg(280.46 + 0.9856474 * n);
  const meanAnomalyRad = normalizeDeg(357.528 + 0.9856003 * n) * DEG;

  const eclipticLongitude = normalizeDeg(
    meanLongitude + 1.915 * Math.sin(meanAnomalyRad) + 0.02 * Math.sin(2 * meanAnomalyRad)
  );
  const obliquity = 23.439 - 0.0000004 * n; // of the ecliptic, degrees

  const lambdaRad = eclipticLongitude * DEG;
  const obliquityRad = obliquity * DEG;

  const declination = Math.asin(Math.sin(obliquityRad) * Math.sin(lambdaRad)) * RAD;
  const rightAscension = normalizeDeg(
    Math.atan2(Math.cos(obliquityRad) * Math.sin(lambdaRad), Math.cos(lambdaRad)) * RAD
  );

  return { declination, rightAscension, n };
}

/** Greenwich Mean Sidereal Time, in degrees, `n` days since J2000.0. */
function gmstDegrees(n) {
  return normalizeDeg(280.46061837 + 360.98564736629 * n);
}

/** The sun's Greenwich hour angle, in degrees, at `date`. Shared by every
 * function below that needs "where is the sun relative to the Greenwich
 * meridian right now" -- the subsolar longitude, a given point's local hour
 * angle, and the terminator ring all reduce to this same number. */
function sunGreenwichHourAngle(date) {
  const { declination, rightAscension, n } = sunEquatorialCoords(date);
  const gha = normalizeDeg(gmstDegrees(n) - rightAscension);
  return { declination, gha };
}

/**
 * The subsolar point: where on Earth the sun is directly overhead, right
 * now. Latitude is the sun's declination; longitude comes from the
 * Greenwich hour angle -- the angle between the Greenwich meridian and the
 * point on Earth currently facing the sun.
 */
export function subsolarPoint(date) {
  const { declination, gha } = sunGreenwichHourAngle(date);
  let lon = -gha;
  if (lon <= -180) lon += 360;
  if (lon > 180) lon -= 360;
  return { lat: declination, lon };
}

/**
 * Sun elevation, in degrees above the horizon (negative below it), as seen
 * from (lat, lon) at `date`. The one calculation every other function in
 * this module is built from -- "current sun elevation" on a place card
 * reads it directly, and sunrise/sunset/twilight below all just ask where
 * this function crosses a threshold.
 */
export function sunElevation(lat, lon, date) {
  const { declination, gha } = sunGreenwichHourAngle(date);
  const hourAngleRad = normalizeDeg(gha + lon) * DEG; // local hour angle; 0 at local solar noon

  const latRad = lat * DEG;
  const decRad = declination * DEG;

  return (
    Math.asin(
      Math.sin(latRad) * Math.sin(decRad) +
        Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngleRad)
    ) * RAD
  );
}

/**
 * When, within one day at (lat, lon), the sun's elevation there crosses
 * `thresholdDeg` -- the building block for sunrise/sunset (threshold -0.833,
 * the standard allowance for atmospheric refraction plus the sun's own
 * angular radius) and for the three twilight bands (civil -6, nautical -12,
 * astronomical -18).
 *
 * The day scanned is the *place's* day, not the UTC calendar day: the window
 * runs from local solar midnight to local solar midnight, anchored on the UTC
 * date `date` falls in. That distinction is the whole of what this window has
 * to get right. A UTC-bounded scan is only the same thing near Greenwich; at
 * 85 degrees east the sun is already up when the UTC day begins and does not
 * rise again until after it ends, so such a scan finds the sunset, no
 * sunrise, and no polar flag to explain the absence -- an ordinary latitude
 * on an ordinary date reported as though the computation had failed.
 * Bounding on local midnight instead puts both crossings inside the window
 * for every non-polar place, because local midnight is when the sun is at its
 * lowest and a day either climbs away from that low point and returns to it
 * or does neither.
 *
 * A numeric scan-then-bisect over the day rather than the closed-form hour-
 * angle formula: it reuses sunElevation() directly, the same function "current
 * elevation" reads, so the two can never disagree about what the sun is doing
 * at a given instant, and it needs no separate equation-of-time term.
 *
 * The polar cases are answered explicitly rather than folded into `rise`/
 * `set` coming back null-and-unexplained: at high latitudes there are dates
 * with no sunrise and no sunset at all, and "the sun never sets today" is a
 * different fact from a computation that failed, so it gets its own field
 * (`alwaysAbove`/`alwaysBelow`) a caller has to read before assuming the
 * absence of a rise/set time means something went wrong.
 *
 * One crossing without the other survives that window fix and is also a real
 * answer, on the two dates a year a place near a polar circle changes regime:
 * the sun comes up and does not go down again (the first day of midnight sun)
 * or goes down and does not come up. Both flags are false there, because
 * neither is true -- the sun was on both sides of the horizon that day -- so a
 * caller reading rise/set must handle one of them being null even after
 * checking the flags. See buildSunSectionForPoint in map/popups.js, which
 * words all four cases.
 */
export function elevationCrossings(date, lat, lon, thresholdDeg, stepMinutes = 10) {
  // Local solar midnight for this date at this longitude: fifteen degrees of
  // longitude is one hour of solar time, and east of Greenwich local midnight
  // has already happened when UTC midnight arrives.
  const dayStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      - (lon / 15) * 60 * MINUTE_MS
  );
  const totalMinutes = 24 * 60;
  const samples = [];
  for (let m = 0; m <= totalMinutes; m += stepMinutes) {
    const t = new Date(dayStart.getTime() + m * MINUTE_MS);
    samples.push({ t, elevation: sunElevation(lat, lon, t) });
  }

  let rise = null;
  let set = null;
  for (let i = 1; i < samples.length && (!rise || !set); i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!rise && a.elevation < thresholdDeg && b.elevation >= thresholdDeg) {
      rise = bisectCrossing(lat, lon, a, b, thresholdDeg);
    }
    if (!set && a.elevation >= thresholdDeg && b.elevation < thresholdDeg) {
      set = bisectCrossing(lat, lon, a, b, thresholdDeg);
    }
  }

  if (!rise && !set) {
    const alwaysAbove = samples.every((s) => s.elevation >= thresholdDeg);
    return { rise: null, set: null, alwaysAbove, alwaysBelow: !alwaysAbove };
  }
  return { rise, set, alwaysAbove: false, alwaysBelow: false };
}

/** Bisects the [a, b] time bracket down to sub-second precision on the
 * instant sun elevation crosses `thresholdDeg`. 24 halvings of a
 * `stepMinutes`-wide bracket (the widest this module uses, 10 minutes)
 * lands well under a second. */
function bisectCrossing(lat, lon, a, b, thresholdDeg) {
  let lo = a;
  let hi = b;
  const loBelow = lo.elevation < thresholdDeg;
  for (let i = 0; i < 24; i++) {
    const midTime = new Date((lo.t.getTime() + hi.t.getTime()) / 2);
    const midElevation = sunElevation(lat, lon, midTime);
    const mid = { t: midTime, elevation: midElevation };
    if (midElevation < thresholdDeg === loBelow) lo = mid;
    else hi = mid;
  }
  return new Date((lo.t.getTime() + hi.t.getTime()) / 2);
}

// The standard sunrise/sunset threshold: the sun's centre sits about -0.833
// degrees below the geometric horizon at the moment its upper limb (allowing
// for its ~0.267 degree angular radius) clears the horizon under average
// atmospheric refraction (~0.567 degree) -- the same convention almanacs and
// NOAA's own sunrise/sunset calculator use, so "sunrise" here means the same
// thing it means anywhere else this map's readers have seen it.
export const SUNRISE_SUNSET_THRESHOLD_DEG = -0.833;

/** Sunrise/sunset for (lat, lon) on the UTC calendar day containing `date`.
 * A thin, named wrapper around elevationCrossings so callers don't have to
 * know or restate the -0.833 constant. */
export function sunriseSunset(date, lat, lon) {
  return elevationCrossings(date, lat, lon, SUNRISE_SUNSET_THRESHOLD_DEG);
}

// Twilight band thresholds -- sun elevation, in degrees, at their outer
// edge. Standard astronomical definitions: civil twilight (still light
// enough to work outdoors without artificial light), nautical (the horizon
// is still visible at sea), astronomical (the sky is fully dark).
export const CIVIL_TWILIGHT_DEG = -6;
export const NAUTICAL_TWILIGHT_DEG = -12;
export const ASTRONOMICAL_TWILIGHT_DEG = -18;

/** The unique representative of an angle (radians) in (-pi, pi]. */
function wrapRad(a) {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

const HALF_PI = Math.PI / 2;

/**
 * The latitude in [-90, 90] degrees solving
 * A*sin(lat) + B*cos(lat) = C, i.e. R*sin(lat + phi) = C with
 * R = hypot(A, B), phi = atan2(B, A) -- or null if there is no such
 * latitude, which happens two different ways.
 *
 * First, `C/R` outside [-1, 1]: no angle at all satisfies sin(theta) = C/R,
 * so certainly no latitude does (see nightPolygonRings' own docstring on
 * what this means physically -- the whole meridian sits on one side of the
 * threshold).
 *
 * Second, and easy to miss: `C/R` inside [-1, 1] only guarantees a solution
 * exists *somewhere on the full circle* `lat + phi` ranges over, not that it
 * lands inside the physical [-90, 90] window latitude is confined to. That
 * window is only half the circle, so the two branches of
 * sin(theta) = C/R -- theta = asin(C/R) and theta = pi - asin(C/R), giving
 * lat = theta - phi for each -- are not guaranteed to put even one of them
 * in range; for some (A, B, C) combinations *neither* does, which is a
 * genuine "no crossing at this longitude" (e.g. at local noon on an ordinary
 * August day, the darkest point anywhere on that meridian, the south pole in
 * its own winter, may simply not yet be far enough into its dark season to
 * reach -18 degrees -- astronomical twilight is unreachable that day, not a
 * missing computation).
 *
 * Manually driving the running dev server for this task caught two bad
 * versions of this function in a row: the first tried only the first
 * branch, unconditionally, and produced a latitude of -118 degrees for a
 * real astronomical-twilight ring (not a latitude at all); the second
 * "fixed" that by clamping whichever branch was out of range back into
 * [-90, 90], which produced a *plausible-looking* but wrong ring -- 82
 * points all exactly at -90, when only two of them (the deliberate
 * pole-hugging closing points nightPolygonRings adds itself) were supposed
 * to be. Both failed the same way this map's own rules warn about:
 * Leaflet does not reject an invalid or merely-wrong coordinate with an
 * error, so neither bug crashed anything -- the ring just quietly drew the
 * wrong shape, or drew as an empty path. The fix is to trust "no branch
 * lands in range" as a real answer -- null, the same "no crossing here"
 * this function already returns for the first case -- not something to
 * force a number out of.
 */
function solveRingLatitude(A, B, C) {
  const R = Math.hypot(A, B);
  if (R < 1e-9 || Math.abs(C / R) > 1) return null;
  const phi = Math.atan2(B, A);
  const theta1 = Math.asin(C / R);
  const theta2 = Math.PI - theta1;
  const lat1 = wrapRad(theta1 - phi);
  const lat2 = wrapRad(theta2 - phi);
  if (Math.abs(lat1) <= HALF_PI + 1e-9) return lat1 * RAD;
  if (Math.abs(lat2) <= HALF_PI + 1e-9) return lat2 * RAD;
  return null;
}

/**
 * The night-side boundary at `thresholdDeg`, as one or more closed rings of
 * [lat, lon] points (Leaflet's own pair order) suitable for L.polygon.
 *
 * For a fixed longitude at a fixed instant, the local hour angle is fixed,
 * so "at what latitude does elevation cross thresholdDeg" reduces to
 * solveRingLatitude above with A = sin(dec), B = cos(dec)*cos(hourAngle),
 * C = sin(thresholdDeg) -- solved via the atan2 form (not the naive
 * tan(dec) form) so it stays numerically well-behaved through dec == 0.
 *
 * Not every longitude has a solution. Elevation at the poles is exactly
 * +-declination regardless of longitude (cos(lat) == 0 there kills the B
 * term), so for threshold <= 0 exactly one pole is always past the
 * threshold and the other never is -- "both poles past threshold" would need
 * threshold > 0, which none of the four callers of this function ever pass.
 * A longitude with no solution is therefore always one where the *entire*
 * meridian sits on the lit side of `thresholdDeg` (common for the twilight
 * bands outside their own hemisphere's dark season) -- it contributes
 * nothing to the night ring, and a run of longitudes that do have a
 * solution is closed off by hugging the pole that IS past the threshold
 * (`nightPoleLat`, itself longitude-independent for the same reason).
 *
 * For the plain terminator (thresholdDeg 0) every longitude has a solution
 * except momentarily at an exact equinox, so this always returns a single
 * ring spanning the whole globe; for the twilight bands it commonly returns
 * one or two smaller rings capping whichever pole is in its dark season.
 */
export function nightPolygonRings(date, thresholdDeg = 0, stepDeg = 2) {
  const { declination, gha } = sunGreenwichHourAngle(date);
  const decRad = declination * DEG;
  const C = Math.sin(thresholdDeg * DEG);
  // See this function's own docstring: longitude-independent by construction.
  const nightPoleLat = declination >= 0 ? -90 : 90;

  const lons = [];
  for (let lon = -180; lon < 180; lon += stepDeg) lons.push(lon);
  lons.push(180); // exact edge, so the ring reaches the antimeridian precisely

  const points = lons.map((lon) => {
    const hourAngleRad = normalizeDeg(gha + lon) * DEG;
    const A = Math.sin(decRad);
    const B = Math.cos(decRad) * Math.cos(hourAngleRad);
    const lat = solveRingLatitude(A, B, C);
    return lat == null ? null : { lon, lat };
  });

  // Split into contiguous runs of longitudes that do have a crossing.
  const runs = [];
  let current = [];
  for (const p of points) {
    if (p) current.push(p);
    else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  // A run that reaches both ends of the sweep (no gap at the antimeridian)
  // and a run that starts the sweep are the same physical run split by the
  // array boundary -- stitch them back together so the ring closes cleanly
  // instead of getting two separate pole-hugging caps at the seam.
  if (runs.length > 1 && points[0] && points[points.length - 1]) {
    const first = runs.shift();
    runs[runs.length - 1] = runs[runs.length - 1].concat(first);
  }

  return runs.map((run) => {
    const ring = run.map((p) => [p.lat, p.lon]);
    const first = run[0];
    const last = run[run.length - 1];
    // Close the ring by hugging the pole that is past the threshold -- see
    // this function's own docstring for why that pole is always the same
    // one, at every longitude, for the whole run.
    ring.push([nightPoleLat, last.lon]);
    ring.push([nightPoleLat, first.lon]);
    ring.push(ring[0]);
    return ring;
  });
}
