// Client-side SGP4 propagation for the satellite layers the server no
// longer computes positions for (see backend/sources/satellites.py's
// ELEMENT_LAYER_GROUPS and the /api/satellites/elements endpoint). The
// server still SGP4s "stations"/"military" itself, every ten seconds,
// exactly as before Task 24 -- this module exists for everything else,
// which can run to several thousand objects and is not a cost a single
// backend process should carry on a ten-second loop for every client at
// once. The browser only ever has to propagate what is actually on screen,
// and only as often as its own frame budget allows.
//
// satellite.js's json2satrec reads exactly the field names CelesTrak's own
// GP JSON uses (NORAD_CAT_ID, EPOCH, MEAN_MOTION, ECCENTRICITY,
// INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR,
// MEAN_MOTION_DOT, MEAN_MOTION_DDOT), so the OMM records this app already
// stores and serves (see satellites.py's `omm` dicts) go into it unchanged
// -- there is no TLE-line round-trip or unit conversion in between.
//
// Imported from satellite.js's own submodules rather than its package root:
// the root barrel (`export * from './wasm/index.js'` in its dist/index.js)
// unconditionally re-exports a WebAssembly build meant for Node's
// multi-threaded runtime (eclipse/shadow-fraction calculators nothing here
// calls), which pulls in `node:worker_threads` and a top-level `await`.
// Vite's build cannot bundle that for this app's output format -- "Module
// format 'iife' does not support top-level await" -- even though tree-
// shaking would otherwise drop it entirely, since nothing here imports from
// it. json2satrec/propagate/gstime/eciToGeodetic/degreesLat/degreesLong
// live in three plain submodules with no WASM dependency of their own (see
// node_modules/satellite.js/dist/{io,propagation,transforms}.js).
//
// Reached by relative path, not by the bare specifier "satellite.js/dist/
// io.js": the package's package.json declares only "." in its "exports"
// map, so a bare subpath is rejected by Node/Vite's resolver
// (ERR_PACKAGE_PATH_NOT_EXPORTED) even though the file is really there --
// only a plain relative path sidesteps that map entirely. Pinned to the
// exact version installed (see frontend/package.json), so an update that
// reorganises satellite.js's dist/ layout fails a build rather than
// silently importing the wrong (or a stale) file.
import { json2satrec } from "../../node_modules/satellite.js/dist/io.js";
import { propagate, gstime } from "../../node_modules/satellite.js/dist/propagation.js";
import { eciToGeodetic, degreesLat, degreesLong } from "../../node_modules/satellite.js/dist/transforms.js";

/** A satellite.js satrec, built from one CelesTrak GP JSON element set. */
export function satrecFromElements(omm) {
  return json2satrec(omm);
}

/**
 * The satellite's true ECI position (km) and velocity (km/s) at `date`, from
 * a real SGP4 run -- what a "fix" is, elsewhere in this module.
 *
 * Returns null rather than throwing on a decayed or otherwise unpropagable
 * orbit: satellite.js reports that as `position: false` (not an exception),
 * and a null fix is a caller's cue to skip drawing the object rather than
 * plot whatever `false` would coerce to.
 */
export function propagateEci(satrec, date) {
  const pv = propagate(satrec, date);
  if (!pv || !pv.position) return null;
  return { position: pv.position, velocity: pv.velocity || null, time: date };
}

/** ECI position (km) -> geodetic {lat, lon, alt_km} (degrees, degrees, km). */
export function eciToLatLonAlt(position, date) {
  const gmst = gstime(date);
  const geo = eciToGeodetic(position, gmst);
  return {
    lat: degreesLat(geo.latitude),
    lon: degreesLong(geo.longitude),
    alt_km: geo.height,
  };
}

/**
 * One call: element set + instant -> geodetic position, or null if SGP4
 * can't propagate this object at all (decayed, or a malformed element set).
 * What the small, always-live layers (navigation/weather/science, on the
 * same ten-second cadence stations/military already use -- see
 * backend/sources/satellites.py's cadence_seconds) call directly, with no
 * need for the interpolation machinery below: a handful of objects
 * recomputed every ten seconds is cheap enough to just do.
 */
export function propagateToLatLonAlt(satrec, date) {
  const fix = propagateEci(satrec, date);
  return fix ? eciToLatLonAlt(fix.position, date) : null;
}

/**
 * The drawn position for `date`, given the two most recent true SGP4 fixes
 * that bracket it (or are the closest available).
 *
 * Interpolated in ECI cartesian space, not in lat/lon: a satellite's motion
 * over the sixty seconds between two fixes (see LARGE_CADENCE_SECONDS) is
 * close enough to a straight line in inertial space that a linear blend of
 * the two position vectors is an accurate stand-in for a third SGP4 run --
 * cheap enough to do every animation frame for thousands of objects, which
 * a real SGP4 call is not. Lat/lon has no such property: a straight-line
 * blend of two longitudes is wrong by up to 180 degrees the moment a pass
 * crosses the antimeridian, and breaks down completely near either pole
 * (exactly where a sun-synchronous imaging satellite's orbit spends real
 * time) -- interpolating the geodetic answer itself would have reintroduced
 * both of those bugs by construction. The geodetic conversion happens once,
 * after the blend, at the real requested time (its own correct sidereal
 * angle), not by blending two already-converted lat/lons.
 *
 * `date` outside [fixA.time, fixB.time] is clamped to whichever end is
 * closer rather than extrapolated -- a stale fix should freeze the last
 * known position, not fling it further along a straight line that stopped
 * matching the true orbit the moment the fix window ended.
 */
export function interpolateFixes(fixA, fixB, date) {
  const tA = fixA.time.getTime();
  const tB = fixB.time.getTime();
  const span = tB - tA;
  const frac = span === 0 ? 0 : (date.getTime() - tA) / span;
  const clamped = Math.max(0, Math.min(1, frac));
  const position = {
    x: fixA.position.x + (fixB.position.x - fixA.position.x) * clamped,
    y: fixA.position.y + (fixB.position.y - fixA.position.y) * clamped,
    z: fixA.position.z + (fixB.position.z - fixA.position.z) * clamped,
  };
  // The geodetic conversion's Earth-rotation angle (gstime) has to be taken
  // at the same clamped instant as the position blend above, not at the
  // caller's original (possibly out-of-window) `date` -- eciToGeodetic
  // rotates an ECI position by the sidereal angle at the time it's *told*
  // that position belongs to, so pairing a frozen (clamped) position with
  // the real, unclamped date's angle would silently rotate it to the wrong
  // longitude even though the position itself was correctly held in place.
  const effectiveDate = clamped === frac ? date : new Date(tA + clamped * span);
  return eciToLatLonAlt(position, effectiveDate);
}

/**
 * Tracks the last two true SGP4 fixes per satellite and answers "where is
 * this one right now" by interpolating between them (see interpolateFixes),
 * so a busy layer's render loop never has to run SGP4 more often than its
 * own cadence calls for (backend/sources/satellites.py's cadence_seconds --
 * this tracker doesn't read that value itself, the caller passes whatever
 * cadence applies to the objects it hands in).
 *
 * One tracker per layer, not one for the whole app: each layer's objects
 * come and go together (a toggle switching a whole layer on/off), and nothing
 * here needs to compare a Starlink satellite's fix against a GPS one's.
 */
export function createPropagationTracker() {
  const bySatnum = new Map(); // norad_id -> { satrec, epoch, prev: fix|null, last: fix }

  return {
    /**
     * Registers or refreshes one satellite's element set. A satrec is only
     * rebuilt when the epoch actually changed (a new element set landed) --
     * rebuilding it on every call would be free, but the fix history it
     * carries would not survive a rebuild that didn't need to happen every
     * time a layer's steady poll handed the same elements back again.
     */
    setElements(noradId, omm) {
      const existing = bySatnum.get(noradId);
      if (existing && existing.epoch === omm.EPOCH) return;
      bySatnum.set(noradId, { satrec: satrecFromElements(omm), epoch: omm.EPOCH, prev: null, last: null });
    },

    /** Drops satellites no longer in `noradIds` -- a layer toggled off, or narrowed by a filter. */
    prune(noradIds) {
      const keep = new Set(noradIds);
      for (const id of bySatnum.keys()) if (!keep.has(id)) bySatnum.delete(id);
    },

    /**
     * Runs one real SGP4 fix for every tracked satellite at `date`, shifting
     * the previous "last" fix into "prev" -- this is the only place SGP4
     * actually runs. Call it on the layer's own cadence (ten or sixty
     * seconds; see backend/sources/satellites.py's cadence_seconds), not on
     * every animation frame.
     */
    tick(date) {
      for (const entry of bySatnum.values()) {
        const fix = propagateEci(entry.satrec, date);
        if (!fix) continue; // decayed/unpropagable -- keep whatever fix history it had, draw nothing new
        entry.prev = entry.last;
        entry.last = fix;
      }
    },

    /**
     * The drawn geodetic position for one satellite at `date` -- interpolated
     * between its last two fixes when there are two, the single fix as-is
     * when there is only one (e.g. the first tick after setElements), or
     * null if tick() has never produced a usable fix for it at all.
     */
    positionAt(noradId, date) {
      const entry = bySatnum.get(noradId);
      if (!entry || !entry.last) return null;
      if (!entry.prev) return eciToLatLonAlt(entry.last.position, date);
      return interpolateFixes(entry.prev, entry.last, date);
    },

    size() {
      return bySatnum.size;
    },
  };
}
