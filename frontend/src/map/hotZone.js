// How close a conflict event has to be before an infrastructure site is called a
// hot zone.
//
// Its own module because three places need the same number and two of them are
// sentences shown to a reader: the flare threshold in createMapController, the
// curated site's popup ("Recent activity within Nkm", decorators.js) and the
// country card's note about which pins carry the flare (popups.js). Those two
// strings had the number written into them by hand, so changing the threshold
// silently made the popups describe a radius the map was no longer using.
//
// 5km, down from 75km. The 75 was chosen deliberately -- its own note said infra
// strikes are "often geocoded to the nearest city/province rather than the
// facility itself", so a wide radius caught a strike reported against a city 40km
// away. The cost of that reach is what it flags: at 75km a single event lights up
// every site in a metropolitan area and several beyond it, and a flare that is
// almost always on says nothing about where anything happened.
//
// 5km is the other trade: only an event geocoded close to the facility flags it.
// A strike reported against the nearest city will no longer flare the site, which
// is a real loss of reach and the reason the popup states the radius rather than
// implying a certainty. The events themselves are unaffected -- they are still on
// the map, and still in the site's own popup list; this only governs the flare.
export const INFRA_HOT_RADIUS_KM = 5;
