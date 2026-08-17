// Which supplier the ships layer is drawing from, and when the second one stands
// in for the first.
//
// There are two global AIS feeds behind this map. aisstream is the real one: on a
// working day the eight watched chokepoints alone produce ~140,000 movement rows.
// Marinesia advertises ~100,000 messages a day *worldwide*, so it is a thinner
// picture of the same water -- which is why backend/sources/marinesia.py gives it
// its own storage kind and this gives it its own layer, rather than merging the two
// under one name that would mean different things on different days.
//
// It exists because aisstream stops. It went silent on 2026-08-06 for days, and
// again from 2026-08-05, with five independent reports on aisstream's own tracker
// of a socket that connects, accepts a subscription and then sends nothing. The
// fallback was written for exactly that and then never wired: the collector ran,
// the health row was published, and no endpoint served it and no layer drew it, so
// during the outage the ships layer was simply empty.
//
// This is the rule that turns it into a fallback rather than a fourth vessel layer:
// off while aisstream is working, on while it is not, off again the moment it
// returns -- and always overridable, because it is expressed as a *wish* that the
// reader's own choice is applied on top of (see App.jsx's layerWishes).

/** A source is carrying data if it reported a positive count. */
function hasData(info) {
  const count = Number(info?.item_count);
  return Number.isFinite(count) && count > 0;
}

/**
 * Is the primary supplier actually delivering?
 *
 * Both halves matter, and the second is the one this outage needs: aisstream's
 * health row can look fine while the stream delivers nothing, because "connected"
 * and "sending frames" are different facts. `ais` reports item_count 0 with a
 * `last_error` of "no AIS frames received since this process started" -- healthy
 * plumbing, no data.
 */
export function primaryShipFeedWorking(health) {
  const info = health?.ais;
  if (!info) return false;
  return hasData(info);
}

/**
 * The layer wishes the supplier fallback contributes.
 *
 * Deliberately a sparse object rather than a boolean, and deliberately empty in
 * the ordinary case: an empty object leaves `marinesia` to the scene resolver,
 * which never switches it on by itself (`draw: null` in scene.js). So "aisstream is
 * working" is expressed as *having no opinion*, not as forcing the fallback off --
 * which is what lets a reader who deliberately switched Marinesia on keep it on.
 *
 * @param {object} health  /api/health
 * @returns {{marinesia?: boolean}}
 */
export function shipFallbackWish(health) {
  if (primaryShipFeedWorking(health)) return {};
  // No point drawing an empty layer over an empty layer. If the fallback has
  // nothing either -- no key configured here, or its own outage -- then the honest
  // state is the one the reader already has: no ships, and a red source light.
  if (!hasData(health?.marinesia)) return {};
  return { marinesia: true };
}

/**
 * Which supplier the map is currently drawing hulls from, for the legend and the
 * attribution.
 *
 * A thinner picture that does not say it is thinner is the dishonest case: a reader
 * looking at a near-empty sea has to be able to tell "there are no ships here" from
 * "we are on the backup feed today".
 *
 * @returns {{key: string, label: string, note: string|null}}
 */
export function shipSupplierReadout(health) {
  if (primaryShipFeedWorking(health)) {
    return { key: "ais", label: "aisstream.io", note: null };
  }
  if (hasData(health?.marinesia)) {
    return {
      key: "marinesia",
      label: "Marinesia",
      note: "aisstream is not delivering; ships are from Marinesia, a much thinner sample of the same water.",
    };
  }
  return {
    key: "none",
    label: "—",
    note: "No AIS supplier is delivering. The absence of a ship here is not evidence that there is none.",
  };
}
