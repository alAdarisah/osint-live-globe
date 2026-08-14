// A monotonic per-key generation counter, for telling "is this the response
// to the request I most recently started" apart from "an older request's
// response, arriving late". Extracted out of map/createMapController.js's
// loadVesselDetail/loadPortTraffic (Task 17's vessel-card and port-card
// fetches), which both had the same latent race: re-opening the same
// popup (same MMSI, same port_id) before an earlier fetch for it resolves
// puts two requests for the same key in flight together, and responses are
// not guaranteed to arrive in request order (an ordinary flaky-connection
// case, not a hypothetical one) -- so without something like this, the
// earlier request's answer landing *after* the later one's would silently
// overwrite a fresher render with staler data.
//
// A plain "am I still selected" check (createMapController.js's
// stillSelected) is not enough on its own: it answers "is this key still
// the one the reader is looking at", which is still true for *both*
// requests when the same key was re-fetched twice in a row. This answers a
// narrower, ordering-specific question instead: "of every fetch started for
// this key, am I the newest one" -- which needs nothing beyond a counter,
// no promise cancellation, no AbortController, no knowledge of what the
// fetch itself was for.
//
// Pure and DOM/Leaflet-free on purpose, unlike the closures that use it --
// this is the seam the two fetch functions' race can actually be tested
// through headlessly (see frontend/tests/fetchGeneration.test.js).
export function createGenerationGuard() {
  const gens = new Map();
  return {
    // Call once per fetch, before awaiting it. The returned token is what
    // that fetch's completion callback later hands to isCurrent.
    start(key) {
      const next = (gens.get(key) || 0) + 1;
      gens.set(key, next);
      return next;
    },
    // True only if no later start(key) has run since this token was issued
    // -- i.e. this really is the most recently started fetch for `key`,
    // whether or not it is the one that happens to be resolving right now.
    isCurrent(key, token) {
      return gens.get(key) === token;
    },
  };
}
