// Which transponder network heard a hull, and when it last reported.
//
// Its own module rather than a corner of decorators.js, for the reason
// scene.js documents about itself: decorators.js imports Leaflet and therefore
// cannot be reached from `node --test`, and these two facts are exactly the
// kind that rot silently. A pin drawn with the wrong network's name does not
// throw, does not look wrong in a screenshot, and misleads about coverage
// rather than about a hull.
//
// Two AIS networks reach this map and they are not interchangeable:
//
//   * aisstream.io -- a global aggregator, one worldwide subscription
//     (backend/sources/ais.py).
//   * Fintraffic / Digitraffic -- Finland's own coastal receivers, Finnish and
//     Baltic waters only (backend/sources/digitraffic_ais.py).
//
// A reader who cannot tell them apart reads an empty Mediterranean as an empty
// Mediterranean, when in fact no receiver in that layer was ever listening to
// it. That is the same reading error the dark-vessel layer exists to prevent,
// arriving through a popup instead of through an inference.

/**
 * Keyed on the `source` field the backend stamps on every Digitraffic record.
 * aisstream records carry no such field -- they predate the second network and
 * their storage kind was the only thing that said so -- which is why the
 * absence below is what identifies them rather than a value.
 */
export const AIS_NETWORKS = Object.freeze({
  digitraffic: Object.freeze({
    label: "Fintraffic / digitraffic.fi",
    // Stated on the pin, not left to a legend nobody opens. The coverage limit
    // is the one thing about this feed that changes how its absences read.
    coverage: "Finnish and Baltic waters only -- these are Fintraffic's own coastal receivers, "
      + "so a vessel missing from this layer may simply be outside the network rather than dark.",
  }),
});

/** The global aggregator, and the fallback for any record that names no source. */
export const AISSTREAM_NETWORK = Object.freeze({ label: "aisstream.io", coverage: null });

/** Which network broadcast this record, as {label, coverage}. Never null. */
export function aisNetwork(d) {
  return AIS_NETWORKS[d?.source] || AISSTREAM_NETWORK;
}

/**
 * When this hull last reported, whichever field its network calls it.
 *
 * aisstream records are stamped `updated` by ais.py; Digitraffic serves the
 * position report's own timestamp as `time`. Same fact, two spellings, and
 * reading only the first made every Digitraffic pin say the feed had stated no
 * time -- for a time the feed had in fact stated.
 *
 * Returns undefined when neither is present, which the popup renders as "not
 * stated by the feed" rather than as a stale or a live contact.
 */
export function shipPingSeconds(d) {
  return Number.isFinite(d?.updated) ? d.updated : d?.time;
}
