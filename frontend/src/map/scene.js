// What the map should be showing, given where the camera is.
//
// This file replaces a decision that used to be spread across three places and
// made once, globally, for every reader: a table of shipped zoom gates in
// createMapController.js, a table of default checkbox states in App.jsx, and a
// third restatement of the same gate numbers in settings/defaults.js. Each of
// those was well argued. The problem was that between them they gave a single
// answer to a question whose real answer depends on where the reader is
// looking: at world zoom the map drew things nobody could read, and over one
// town it withheld things it already had in hand.
//
// So the numbers move here, together with the arguments that produced them --
// those comments are the asset, and they are reproduced rather than summarised.
// One table, one pure function, and two thin readers (minZoomFor in the
// controller, gateFor in useOsintData) that ask it what to draw and what to
// fetch. Because both readers consult the same entry, a layer's fetch gate can
// never drift from its draw gate, which is a class of bug the old arrangement
// had to prevent by hand (see the note App.jsx keeps about the two agreeing).
//
// ---------------------------------------------------------------------------
// THE ONE RULE
//
//   `detail` is a function of the zoom band ALONE. Never of the viewport
//   profile, never of the focus.
//
// Profile and focus may change which layers are active and how hard they are
// capped. They may never change what an icon looks like. The profile changes on
// every pan, and an icon's appearance is compiled into the HTML string that
// updateMarker diffs to decide whether to rebuild a marker's DOM element (see
// createMapController.js's updateMarker and svgIcons.js's buildDivIcon). If
// detail depended on the profile, that string would flip on every pan and the
// map would tear down and rebuild every visible marker continuously -- the
// exact regression updateMarker's diff exists to prevent.
// ---------------------------------------------------------------------------

/**
 * Five bands, each a range of Leaflet zoom levels that answers a different
 * question. The map's own minimum is 2 and it opens at 3 (see the L.map call in
 * createMapController.js), so WORLD is where every session starts.
 *
 *   WORLD    the situation: what is happening anywhere that matters from here
 *   THEATRE  a region: several countries and the sea between them
 *   COUNTRY  one country or province
 *   LOCAL    one town
 *   SITE     one street, one facility
 */
export const BANDS = ["WORLD", "THEATRE", "COUNTRY", "LOCAL", "SITE"];

const BAND_FLOOR = { WORLD: 2, THEATRE: 4, COUNTRY: 6, LOCAL: 9, SITE: 12 };

/** Band index, so promotion is arithmetic rather than a lookup table. */
export const BAND_INDEX = Object.fromEntries(BANDS.map((band, i) => [band, i]));

/**
 * Which band a zoom level falls in.
 *
 * Rounded first: a pinch-zoom gesture reports fractional levels while it is in
 * flight, and a band boundary crossed at 5.5 and again at 5.4 would flip the
 * whole scene twice inside one gesture.
 */
export function bandFor(zoom) {
  const z = Math.round(Number.isFinite(zoom) ? zoom : BAND_FLOOR.WORLD);
  for (let i = BANDS.length - 1; i > 0; i--) {
    if (z >= BAND_FLOOR[BANDS[i]]) return BANDS[i];
  }
  return "WORLD";
}

/** The zoom at which a band begins. */
export function floorOf(band) {
  return BAND_FLOOR[band] ?? BAND_FLOOR.WORLD;
}

/** Move `band` `steps` shallower (negative) or deeper (positive), clamped. */
function shiftBand(band, steps) {
  const i = BAND_INDEX[band] ?? 0;
  return BANDS[Math.min(BANDS.length - 1, Math.max(0, i + steps))];
}

// Detail once had two levels, with the boundary on the COUNTRY floor -- a dot
// below it, the full glyph at or above. The engineering argument was sound: ~230
// characters of diffed icon HTML instead of ~900, and a boundary sitting exactly
// on DECLUTTER_MIN_ZOOM so the detail system and the placement system were never
// live at the same zoom.
//
// It is gone anyway, because a stronger argument beats it. Every pin on this map
// is supposed to state what kind of evidence it is -- a strike, a news story, a
// tanker, a modelled flood centroid -- and that distinction is carried by the
// shape. A dot carries colour, which is severity, and nothing else. Spending the
// three shallowest zoom levels not saying what a thing is contradicts the reason
// the map draws pins at all.
//
// The thinning the dot was doing is now done entirely by the caps below (events
// 150, gdelt 120, hazards 60 at WORLD), which is the better instrument for it:
// a cap reports itself in the panel and a dot does not.
//
// Kept as a function of the band rather than folded away to a constant at every
// call site, so that reintroducing a shallow-zoom detail level is one edit here
// -- and so the rule below still has something to be a rule *about*.
const ICON_DETAIL = "glyph";

/**
 * "glyph" -- the full icon: shape, rotation, badges, flare. The only level.
 *
 * The decorators still understand "dot" (see the icon() forwarder and
 * detailSize in decorators.js); nothing asks for it. Whatever this returns must
 * remain a function of the band alone -- see THE ONE RULE at the top of the file.
 */
export function detailForBand(_band) {
  return ICON_DETAIL;
}

// Fetch dispositions that are not a band.
//
//   ALWAYS  poll from boot, at every zoom. Not a judgement that the payload is
//           small -- it is a statement that something other than the map reads
//           this feed, and gating it would silently break that reader. See the
//           note above FETCH_ALWAYS_BECAUSE below.
//   MANUAL  never polled until something explicitly asks for it.
export const FETCH_ALWAYS = "ALWAYS";
export const FETCH_MANUAL = "MANUAL";

/**
 * Why each always-fetched feed is always fetched. Kept as data rather than as
 * prose because the consequence of getting one of these wrong is invisible:
 * buildLivePicture in popups.js counts raw.firms and raw.jamming inside a
 * country's bbox, and statRow omits a zero -- so gating either one does not
 * produce an error or a blank, it makes two rows of the country card quietly
 * disappear. A future reader deciding "this layer is map-only, it can be gated"
 * needs to be able to check that claim against this list.
 */
export const FETCH_ALWAYS_BECAUSE = {
  events: "news panel, notable events, regionActivity, the briefing card",
  gdelt: "news ticker, briefing card, regionActivity, mergedNewsIds",
  officials: "country card, mergedNewsIds",
  escalation: "notable events, the choropleth",
  countries: "the hit-test index, choropleth, war flare, city scoping, border editing",
  outages: "the choropleth and the country card",
  outagesRegions: "the state-target choropleth, the admin-1 badge layer, and the state/district cards",
  conflictStats: "the choropleth and the country card",
  conflictDistricts: "the choropleth and the country card",
  humanitarian: "the country card",
  energyFlows: "the country card",
  foodTrade: "the country card",
  foodPriceIndex: "the country card",
  firms: "the country card's live picture counts fires in the country bbox",
  jamming: "the country card's live picture counts jamming cells in the country bbox",
  ais: "the country card counts navy hulls and tankers; Navy is ungated anyway",
  adsb: "the country card counts military aircraft; flagged and military are ungated anyway",
  infra: "the country card counts infrastructure sites",
  satellites: "drawn at every zoom",
};

/**
 * Disposition -- who is allowed to switch a layer on.
 *
 *   auto           the resolver may. Ordinary observation.
 *   corroborating  only a reader gesture may: focusing a country, or clicking
 *                  the thing this layer corroborates. See the long note below.
 *   manual         admin only.
 *
 * `corroborating` is the load-bearing one and it exists to preserve a principle
 * the old default-off checkboxes encoded. Two layers here -- darkVessels and
 * gfwGaps -- were off by default not because they are dense but because, as
 * App.jsx put it, "every pin in it is an inference drawn from an absence, and
 * that should be something a reader chooses to look at rather than something
 * the map asserts at them."
 *
 * A resolver with only auto and manual destroys that principle in either
 * direction: auto makes the map assert an inference nobody asked for, manual
 * deletes the layer from a reader's world. Corroborating keeps it. The reader
 * still chooses -- they just choose by engaging with the thing the inference is
 * about, in the place they are already looking, instead of by finding a
 * checkbox in a drawer. That is a stronger form of the principle, not a weaker
 * one: the choice is now about a specific hull or a specific country rather
 * than a global assertion.
 *
 * Two rules keep it honest, and both are enforced in resolveScene:
 *   1. A profile promotion may never activate a corroborating layer. Promotion
 *      changes the band, not the disposition. Otherwise a camera position
 *      becomes the choosing, which is exactly what the principle forbids.
 *   2. A corroborating layer's pins must keep stating what kind of claim they
 *      are. Every one of them draws at COUNTRY or deeper, so they are never
 *      reduced to a bare dot -- see DETAIL_BOUNDARY_BAND.
 */
export const AUTO = "auto";
export const CORROBORATING = "corroborating";
export const MANUAL = "manual";

/**
 * The table.
 *
 * Per entry:
 *   draw    { band, z? }  the band at which the layer starts drawing. `z` is the
 *                         exact zoom when the argued-for number is not the band
 *                         floor -- 7 for airfields because it is 40k rows, 9 for
 *                         OSM infrastructure because it is crowd-sourced
 *                         geometry. Bands decide promotion arithmetic and
 *                         detail; `z` decides the threshold. Rounding those
 *                         numbers to band floors would throw away the argument
 *                         that produced them.
 *   fetch   band | ALWAYS | MANUAL
 *   cap     { [band]: n } how many may be drawn, highest-ranked first
 *   rank    (item) => n   what "highest" means; defaults to severity
 *   collapse              proximity or key grouping, per band ceiling
 *   disposition           see above
 *   scoped  true          send a snapped viewport bbox with the fetch
 */
export const LAYER_MANIFEST = {
  // ---- conflict -----------------------------------------------------------
  events: {
    // The layer the map exists for, and the only one whose shipped gate is
    // untouched by this rewrite.
    draw: { band: "WORLD", z: 3 },
    fetch: FETCH_ALWAYS,
    cap: { WORLD: 150, THEATRE: 400, COUNTRY: 900 },
    rank: (d) => d.severity || 0,
    // Deliberately never collapsed. Capping removes the least significant and
    // says so in the panel, which is a stated editorial act. Collapsing would
    // merge two incident reports into one pin, and that asserts they were one
    // event -- a claim the data does not support.
    collapse: null,
    disposition: AUTO,
  },
  gdelt: {
    draw: { band: "WORLD", z: 3 },
    fetch: FETCH_ALWAYS,
    // New. A 24-hour news window's density is bounded by the window you chose,
    // not by the world, so on a busy day it needs a cap as well as the
    // proximity collapse it already had.
    cap: { WORLD: 120, THEATRE: 350 },
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: AUTO,
  },
  officials: {
    // Raised from 3. A press release snapped to a capital city says nothing on
    // the world board that the news layer is not already saying louder; it
    // becomes legible once the camera is on one theatre.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    cap: { THEATRE: 200 },
    collapse: { mode: "key", expandFrom: 8 },
    disposition: AUTO,
  },
  conflictHistory: {
    // Raised from 4. This is the layer whose own note calls it "a reviewed
    // monthly archive ... the one layer here whose newest data is weeks old by
    // construction". A month-old archive competing with live pins at world zoom
    // is precisely the confusion that note warns about.
    draw: { band: "COUNTRY" },
    // Fetched a band before it is drawn, so zooming in shows it immediately
    // rather than after a six-hour poll interval.
    fetch: "THEATRE",
    cap: { COUNTRY: 400 },
    collapse: { mode: "proximity", maxZoom: 8 },
    disposition: AUTO,
    scoped: true,
  },

  // ---- maritime -----------------------------------------------------------
  aisTanker: {
    // Unchanged. A designated tanker is the maritime fact this map is for.
    draw: { band: "WORLD", z: 3 },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  aisNavy: {
    // Ungated, and it keeps its existing exemption from the AIS gate.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  aisCivilian: {
    // Raised from 3. Ten thousand merchant hulls at world zoom is a texture,
    // not a layer.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    cap: { THEATRE: 800 },
    disposition: AUTO,
  },
  darkVessels: {
    // No zoom gate, and that is deliberate: there are only ever a handful
    // worldwide, and "somewhere a designated tanker went dark" is exactly the
    // thing worth seeing at world zoom. But every pin in it is an inference
    // drawn from an absence, so the resolver never switches it on by itself --
    // a reader reaches it by focusing a country or clicking a tanker.
    draw: null,
    fetch: "COUNTRY",
    disposition: CORROBORATING,
    // Not scoped: ~156 rows worldwide is already small, and a handful of pins
    // is exactly the payload where a viewport clip costs more in cache misses
    // than it saves in bytes.
  },
  gfwGaps: {
    // Raised from 5. A 30-day global window of AIS disabling events is ~20k
    // rows, every one of them five or more days old. Corroborating for the
    // reason App.jsx gave: that the inference is Global Fishing Watch's rather
    // than this app's does not change what kind of claim it is.
    draw: { band: "COUNTRY" },
    fetch: "COUNTRY",
    cap: { COUNTRY: 400 },
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: CORROBORATING,
    scoped: true,
  },
  gfwDetections: {
    // Gate unchanged at 6. These are measurements, and good ones -- but a radar
    // return several weeks old drawn beside live AIS is the confusion the layer
    // risks, so a reader arrives at it rather than being handed it.
    draw: { band: "COUNTRY" },
    fetch: "COUNTRY",
    cap: { COUNTRY: 400 },
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: CORROBORATING,
    scoped: true,
  },
  ports: {
    // Gate unchanged at 5. A harbour gazetteer is reference material for a
    // maritime question, which is why the maritime profile is what should raise
    // it rather than a checkbox.
    draw: { band: "THEATRE", z: 5 },
    fetch: "THEATRE",
    cap: { COUNTRY: 400 },
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: CORROBORATING,
    scoped: true,
  },
  cables: {
    // 718 routes is a dense mesh over every ocean. A cable is only legible as a
    // whole line, so the routes themselves stay ungated once the layer is
    // active -- it is reaching the layer that is gated, not drawing it.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: CORROBORATING,
  },
  railways: {
    // Task 27 layered an attributed OpenStreetMap overlay on top of the
    // Natural Earth linework (backend/sources/railways.py's own merge) --
    // both clipped to the same eleven conflict theatres, neither worldwide,
    // whatever "fallback" language a comment elsewhere uses for the coarser
    // of the two. The gate is unchanged: both halves are whole polylines,
    // drawn ungated once active, MANUAL and off by default for the same
    // reason as before --
    // this is basemap context a reader opts into, not something the resolver
    // should assert or a country focus should drag on. Fetched once at boot
    // as a whole document, same as cables, so FETCH_MANUAL keeps the poller
    // out of it.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  // Task 27: the station/halt/yard/border points osm_infra.py already swept,
  // pulled out of the generic OSM infrastructure layer and given a home next
  // to the rail linework they sit on -- one toggle for the whole rail
  // network instead of two unrelated checkboxes for one subject. No
  // disposition/checkbox of its own: it mirrors "railways"' visibility
  // exactly the way cableLandings mirrors "cables" (see
  // createMapController.js's setLayerVisible), it just needs its own draw
  // gate and collapse here because it is a dense point layer where its
  // parent is a small set of whole lines. Gate and cap are copied from
  // osmInfra's own entry unchanged -- this task did not ask to redraw when
  // OSM points are worth showing, only which toggle governs them.
  railwayPoints: {
    draw: { band: "LOCAL", z: 9 },
    fetch: "LOCAL",
    cap: { LOCAL: 800 },
    collapse: { mode: "proximity", maxZoom: 11 },
    disposition: MANUAL,
  },
  // Task 27: Digitraffic's live Finnish train positions
  // (backend/sources/digitraffic_rail.py, GET /api/rail-live) -- a genuine
  // sub-layer of the same rail group rather than a sub-ticker, because a
  // reader may want the (static) network without the (moving, Finland-only)
  // trains or the reverse. MANUAL and off by default, deliberately not tied
  // to "railways"' own checkbox: switching on the eleven-theatre rail
  // linework must never be read as "and also Finland's live trains are now
  // on" -- Finland sits outside every one of those eleven boxes (the
  // nearest, russia_ukraine, tops out at 56N; Finland runs 60-70N), so the
  // two checkboxes cover disjoint ground and conflating them would be
  // exactly the false impression of coverage this layer's own note in
  // LayersSection.jsx exists to head off. Ungated once switched on -- ~111
  // trains at most is legible at any zoom, the same argument aisNavy makes.
  railLive: {
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: MANUAL,
  },
  // Task 27 fix (post-review): the station gazetteer railLive needs to mean
  // anything -- Finland is outside every conflict theatre (see railLive's
  // own note just above), so railwayPoints above, which only ever sweeps
  // inside those theatres, can never place a station there. Mirrors
  // "railLive"'s own visibility exactly the way railwayPoints mirrors
  // "railways" -- one toggle for the whole Finnish picture, moving trains
  // and the network they move on.
  railStations: {
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: MANUAL,
  },
  shippingLanes: {
    // Task 20b: the ten named corridors (backend/infrastructure.py's
    // SHIPPING_LANES), drawn the same way as the pipeline/cable/railway
    // routes above -- a small curated set of whole polylines, fetched once
    // at boot (see useOsintData.js's /api/infrastructure fetch) rather than
    // polled. MANUAL and off by default for the same reason railways is: this
    // is a hand-drawn schematic a reader opts into, not a claim the resolver
    // or a country focus should push at them -- see the layer's own popup,
    // which says "schematic corridor, not a surveyed route" on every line.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  laneDensity: {
    // Task 20a: the AIS traffic grid (backend/refine/lane_density.py via
    // GET /api/lanes) -- where this map's own AIS coverage has actually seen
    // a hull, drawn as a heat wash exactly like FIRMS/jamming above. THEATRE
    // and z5, the same gate jamming ships with and for the same reason: a
    // world-zoom heat blur reads as an assertion about global shipping
    // lanes, which is precisely the claim the layer's own note (and its
    // legend) exists to disclaim. AUTO rather than CORROBORATING -- this is
    // a straight rendering of what this map recorded, not an inference drawn
    // from an absence, so it earns the same footing jamming has.
    draw: { band: "THEATRE", z: 5 },
    fetch: "THEATRE",
    disposition: AUTO,
    // /api/lanes takes a bbox (see backend/app.py's lanes_endpoint) and the
    // grid is unbounded in principle -- global AIS coverage, resolved to
    // 0.05deg/0.02deg cells -- so this earns the same viewport clip FIRMS and
    // jamming's own scoped siblings (ports, airports, gfwGaps...) do.
    scoped: true,
  },
  water: {
    // Natural Earth 1:10m marine polygons -- named oceans, seas, gulfs, bays,
    // straits, sounds, channels (backend/sources/water_bodies.py). The first
    // polygon layer on this map that is not an administrative boundary, and it
    // is given the same treatment as railways just above: coarse basemap
    // reference geometry, boot-fetched once rather than polled (see
    // useOsintData.js), MANUAL and off by default so drawing it is a reader's
    // choice, not the resolver's or a country focus's to make.
    //
    // Lakes and rivers ride this same key behind their own sub-toggles
    // (waterLakes/waterRivers, wired in createMapController.js) rather than
    // getting manifest entries of their own: neither is fetched at all until
    // its checkbox is ticked, so there is nothing here for the resolver to gate
    // -- and kind=rivers requires a bbox the resolver has no reason to compute
    // for a layer nobody has asked for yet (see backend/app.py's water_endpoint).
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  cableLandings: {
    // 1,922 landing points, most within a few km of another one.
    draw: { band: "THEATRE", z: 5 },
    fetch: FETCH_MANUAL,
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: CORROBORATING,
  },

  // ---- air ----------------------------------------------------------------
  adsbMilitary: { draw: null, fetch: FETCH_ALWAYS, disposition: AUTO },
  adsbFlagged: {
    // Ungated, and nothing in this redesign is allowed to weaken that. This is
    // the layer that shows an aircraft squawking 7500, or one an OFAC
    // designation attaches to. Both are rare, both are the point, and neither
    // should ever need switching on to be seen.
    //
    // The third status this bucket carries -- display-limited -- is gated, and
    // separately: see adsbDisplayLimited below.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  adsbDisplayLimited: {
    // Not a layer of its own: a gate holder for one of the three statuses the
    // flagged bucket carries. Virtual for the same reason firmsPoints is --
    // there is nothing to add to or remove from the map, only a threshold that
    // renderAdsbLayer reads.
    //
    // "The operator asked for this airframe to be limited in public feeds" is a
    // fact about a registry entry, not about a flight. It was sharing a bucket
    // with 7500 squawks and OFAC designations, and the ungated treatment those
    // two earn was carrying it along: measured at world zoom, the flagged
    // bucket held 641 aircraft, of which 641 were display-limited and zero were
    // emergencies. That is a fleet of business jets drawn over the whole planet
    // on the strength of an argument written about hijackings.
    //
    // Gated at the same LOCAL floor as ordinary traffic, because that is what
    // it is: a private aircraft, worth a dashed ring once a reader is looking
    // at one town, and worth nothing at world zoom. Below the gate the aircraft
    // is not deleted -- it falls back to the class it would otherwise be, so a
    // display-limited *military* airframe still draws at every zoom, in the
    // military bucket, which is the ungated promise this must not break.
    draw: { band: "LOCAL" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
    virtual: true,
  },
  adsbCivilian: {
    // Raised from 5, first to the COUNTRY floor and then to the LOCAL one.
    //
    // The two aircraft layers above are ungated and stay that way: an aircraft
    // squawking 7500, or one whose operator asked not to be listed, is a fact
    // about the world and needs no camera position to be worth seeing. Ordinary
    // traffic is not a fact about anywhere. It is the texture over a town, and
    // it starts meaning something -- a diversion, a hold, an airport that has
    // stopped moving -- only once the camera is on that town. Between COUNTRY
    // and LOCAL it was neither: several hundred anonymous airframes crossing a
    // whole country, redrawn every twenty seconds.
    draw: { band: "LOCAL" },
    fetch: FETCH_ALWAYS,
    // Declared at the band it draws in. It used to say COUNTRY, which after the
    // gate moved would have been a rule for a band this layer can never appear
    // in -- see the cap-band assertion in tests/scene.test.js.
    cap: { LOCAL: 400 },
    disposition: AUTO,
  },
  czib: {
    // Ungated, deliberately: "a regulator has told airlines to stop flying
    // through a national airspace" is precisely a world-zoom fact, and there
    // are only a few dozen of them.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  airports: {
    // Keeps its argued-for 7: the served slice is ~40k airfields worldwide,
    // which below this zoom is a texture rather than a layer. The fetch gate is
    // new -- an hourly poll of 40k rows that a world-zoom session never draws.
    draw: { band: "COUNTRY", z: 7 },
    fetch: "COUNTRY",
    cap: { COUNTRY: 500 },
    collapse: { mode: "proximity", maxZoom: 8 },
    disposition: CORROBORATING,
    scoped: true,
  },
  jamming: {
    // Keeps its 5. Its fetch cannot be gated -- the country card counts jamming
    // cells inside the country bbox -- so a viewport clip is the only lever
    // this layer has, which is the same trade FIRMS makes below.
    draw: { band: "THEATRE", z: 5 },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
    scoped: true,
  },

  // ---- ground -------------------------------------------------------------
  infra: {
    // Lowered from ungated to THEATRE. 79 curated sites, and the hot-zone flare
    // that fires when an event lands near one is a theatre-scale read.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  osmInfra: {
    // Unchanged at 9, and this entry is the precedent the whole file
    // generalises rather than an exception to it: crowd-sourced geometry
    // sitting next to a list whose coordinates a person checked, so it stays
    // off the overview entirely and only fills in once a reader has zoomed into
    // one place, where its provenance is stated on every pin. Its fetch has
    // been gated on the same number since before this file existed.
    draw: { band: "LOCAL", z: 9 },
    fetch: "LOCAL",
    cap: { LOCAL: 800 },
    collapse: { mode: "proximity", maxZoom: 11 },
    disposition: AUTO,
    scoped: true,
  },
  dams: {
    // Keeps its 7. 3,555 barriers clipped to eleven theatres is locally very
    // dense, and everything in the popup -- capacity, height, river -- is
    // structure-scale detail that means nothing at regional zoom.
    draw: { band: "COUNTRY", z: 7 },
    fetch: "COUNTRY",
    cap: { COUNTRY: 300 },
    collapse: { mode: "proximity", maxZoom: 9 },
    disposition: CORROBORATING,
    scoped: true,
  },
  deflock: {
    // ~125,000 ALPR camera locations worldwide, 99.78% of them in the United
    // States -- and backend/regions.py has no US theatre, so the layer is only
    // ever meaningfully populated on the unfiltered World view (a named region
    // clips it to almost nothing). MANUAL and gated deep, together: default off,
    // and even once a reader switches it on it draws nothing until they are
    // looking at one town, so 125k pins can never land on a theatre view or a
    // cold world paint. The proximity collapse and the LOCAL cap thin whatever
    // survives inside a city. Not scoped -- /api/deflock takes no viewport bbox.
    draw: { band: "LOCAL", z: 9 },
    fetch: "LOCAL",
    cap: { LOCAL: 800 },
    collapse: { mode: "proximity", maxZoom: 11 },
    disposition: MANUAL,
  },
  cities: {
    // Raised from 5 to the COUNTRY floor, and promoted a band under a country
    // focus so focusing a country brings its cities with it.
    draw: { band: "COUNTRY" },
    fetch: "THEATRE",
    cap: { COUNTRY: 400 },
    collapse: { mode: "proximity", maxZoom: 8 },
    disposition: AUTO,
    scoped: true,
  },
  countries: {
    // Never gated, in either half. The hit-test index, the choropleth, the war
    // flare, city scoping and the boundary editor all hang off this one feed.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  outagePoints: {
    // One pin per country, and the feed behind it also drives the choropleth
    // and the country card.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  outageRegionPoints: {
    // Gated the same as cities' own COUNTRY floor, and for the same reason: at
    // WORLD or THEATRE a reader has not zoomed in far enough to place a small
    // per-state badge meaningfully, and a bad week could otherwise paper the
    // map in them before that. Unlike outagePoints above, this is never drawn
    // ungated -- the country-level pin exists precisely because a national
    // reading is worth seeing from anywhere; a state-level one is the detail
    // a reader reaches by looking closer, not the headline.
    draw: { band: "COUNTRY" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },

  // ---- hazards ------------------------------------------------------------
  hazards: {
    // Keeps its 3 but gains a cap, and the cap is this layer's old default-off
    // argument restated as arithmetic: "an M3.1 tremor competing with a strike
    // for the eye is exactly the clutter the rest of these defaults avoid".
    // Ranking by magnitude and keeping the top sixty is that same judgement,
    // made by the resolver instead of by hiding the layer outright.
    draw: { band: "WORLD", z: 3 },
    fetch: FETCH_ALWAYS,
    cap: { WORLD: 60, THEATRE: 200 },
    rank: (d) => Number(d.magnitude) || 0,
    collapse: { mode: "proximity", maxZoom: 6 },
    disposition: AUTO,
  },
  floods: {
    // Raised from 3. A GLOFAS basin centroid is a modelled point, and it should
    // not sit beside instrument solutions at world zoom as though it were one.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    cap: { THEATRE: 60 },
    collapse: { mode: "proximity", maxZoom: 8 },
    disposition: AUTO,
    scoped: true,
  },

  // ---- space --------------------------------------------------------------
  satellites: {
    // ~46 curated objects on a 10s poll, and renderSatellites already returns
    // early when the layer is off.
    draw: null,
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  launches: {
    // Raised from ungated: a launch pad is a place, and a place needs a theatre
    // around it to mean anything.
    draw: { band: "THEATRE" },
    fetch: "THEATRE",
    disposition: AUTO,
  },

  // Task 24: client-propagated satellite layers. Stored CelesTrak element
  // sets, propagated in the browser (see map/satPropagate.js).
  //
  // The three on-by-default groups below (navigation/weather/imaging) are
  // zoom-gated at THEATRE, unlike `satellites` above. That is a deliberate
  // departure from `satellites`' own "ungated, because ~46 curated objects
  // is legible at any zoom" argument: navigation+weather+imaging land ~875
  // objects on the map together (~225 DOM markers, ~650 WebGL sprites) with
  // no cap and no collapse, on by default, at world zoom -- roughly the
  // count aisCivilian's own "raised from WORLD to THEATRE... a texture, not
  // a layer" argument was written about, not the ~46 stations/military is.
  // Reusing `satellites`' ungated treatment here would have been the map's
  // own stated philosophy (thin the presentation, never delete the data)
  // asking for an argument this task never made. `fetch: FETCH_ALWAYS`
  // still applies regardless of the draw gate -- elements have to already
  // be in hand, propagating, when a reader crosses into THEATRE, or the
  // gate would feel like a load spinner instead of an instant reveal (see
  // `floods`' identical fetch-always/draw-gated split just above for the
  // same reasoning already established in this file).
  //
  // The four off-by-default groups (science/geo/starlink/oneweb) are left
  // ungated: a reader who has already opted into one of them (starlink/
  // oneweb additionally past the control panel's own hard-gate warning
  // about their object count) has already made the "I want to see this"
  // decision a zoom gate exists to make on a reader's behalf for a layer
  // that is on without being asked. Gating a layer nobody sees until they
  // choose to enable it would not thin anything a reader has not already
  // chosen to look at.
  satNavigation: {
    // GPS/Galileo/GLONASS/Beidou, ~150 objects, DOM markers. On by default.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  satWeather: {
    // ~75 objects (weather + goes -- see satellites.py's note on why "noaa"
    // is not a real CelesTrak group), DOM markers. On by default.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  satImaging: {
    // resource/sarsat/spire/planet, ~650 objects. On by default per the task
    // brief, which is exactly why this one draws on the WebGL entity path
    // rather than as DOM markers (see createMapController.js) -- "on by
    // default" and "hundreds of markers" cannot coexist on the DOM path
    // without becoming the clutter this map's declutter philosophy exists
    // to prevent, and it is the single largest contributor to the ~875
    // ungated-at-world-zoom count the THEATRE gate above answers.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
  },
  satScience: {
    // Off by default (task brief): a curated-interest set (Hubble, Terra,
    // ...) a reader opts into rather than one the resolver asserts. Ungated
    // once on -- see this block's own note above on why the four
    // off-by-default groups stay that way.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  satGeo: {
    // Off by default (task brief). ~500+ geostationary objects -- WebGL.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  satStarlink: {
    // Off by default and hard-gated in the control panel (task brief):
    // several thousand objects. WebGL is not optional here -- it is the only
    // reason this toggle can exist at all. `active` (11,000 objects) is
    // deliberately not offered anywhere in this map, including here.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },
  satOneweb: {
    // Off by default and hard-gated (task brief), same reasoning as
    // satStarlink -- a few hundred to a thousand-odd objects, WebGL.
    draw: null,
    fetch: FETCH_MANUAL,
    disposition: MANUAL,
  },

  // ---- weather ------------------------------------------------------------
  // Weather answers a different question from the rest of this map, so none of
  // it is ever switched on by the resolver. windArrows additionally gates the
  // per-moveend /api/wind round trip, which used to run for every reader
  // whether or not the layer was on the map.
  precip: { draw: null, fetch: FETCH_MANUAL, disposition: MANUAL },
  clouds: { draw: null, fetch: FETCH_MANUAL, disposition: MANUAL },
  windArrows: { draw: null, fetch: FETCH_MANUAL, disposition: MANUAL },
  firms: {
    // One toggle covers two things -- the heat canvas and the interactive
    // per-point circles -- and only the second of them was ever gated. So this
    // entry is the *layer* gate and firmsPoints below is the detail gate; they
    // are separate because conflating them would take the heat canvas off the
    // world board, and leaflet.heat draws that as one canvas regardless of
    // point count.
    //
    // THEATRE rather than WORLD: at world zoom a global thermal feed is mostly
    // agricultural burning, which is a smear rather than a signal. Over one
    // theatre it is the layer that shows something burning that should not be.
    // The fetch cannot be gated at all -- the country card counts fires inside
    // the country bbox -- which is precisely why this feed earns a viewport
    // bbox instead of a band gate.
    draw: { band: "THEATRE" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
    scoped: true,
  },
  airfieldActivity: {
    // No pin of its own -- it is the recorded traffic that sizes an airfield's
    // glyph and fills its popup, so it is only ever read through the airports
    // layer and follows that layer's fetch gate exactly.
    //
    // Its old comment said it was "not zoom-gated despite attaching to a
    // zoom-gated layer: it is ~180 kB once, and the airfields toggle can be
    // switched on at any time". The second half of that reasoning is what has
    // changed: there is no toggle to switch on at any time now, so a session
    // that never reaches COUNTRY band can never draw an airfield and has no use
    // for the traffic behind one.
    draw: null,
    fetch: "COUNTRY",
    disposition: AUTO,
    virtual: true,
  },
  firmsPoints: {
    // Not a layer anyone can toggle: a gate holder, read by renderFirms to
    // decide whether to build the clickable per-point circles on top of the
    // heat. Raised from 5 to the COUNTRY floor -- a single fire's confidence
    // and radiative power is a per-fire question, not a regional one.
    draw: { band: "COUNTRY" },
    fetch: FETCH_ALWAYS,
    disposition: AUTO,
    virtual: true,
  },
};

/**
 * Keys applyScene may switch on and off directly.
 *
 * Excluded, and each for its own reason:
 *   firmsPoints    virtual -- a gate with no layer behind it
 *   cableLandings  has no toggle of its own; setLayerVisible("cables") mirrors
 *                  onto it, because a cable and the place it comes ashore are
 *                  one fact and being able to hide half of it helps nobody
 *   railwayPoints  same arrangement, one layer over: setLayerVisible("railways")
 *                  mirrors onto it -- see its own note in LAYER_MANIFEST above
 *   railStations   same arrangement again, one layer over from railLive
 *                  instead of railways -- see its own note in LAYER_MANIFEST
 */
const MIRRORED_LAYER_KEYS = new Set(["cableLandings", "railwayPoints", "railStations"]);
export const SCENE_APPLY_KEYS = Object.keys(LAYER_MANIFEST).filter(
  (key) => !LAYER_MANIFEST[key].virtual && !MIRRORED_LAYER_KEYS.has(key)
);

// Sub-toggles that have no independent existence: a trail is drawn wherever its
// parent is drawn. Kept out of the manifest so nobody has to remember to keep
// two entries in step, and listed here so the resolver still has an answer for
// them. The trail *history* keeps accumulating while hidden, which is a
// separate decision setLayerVisible already documents.
export const TRAIL_PARENT = {
  aisTankerTrails: "aisTanker",
  adsbMilitaryTrails: "adsbMilitary",
  satellitesTrails: "satellites",
};

/**
 * Feeds with no pin and no gate: country-keyed data read by the choropleth and
 * the country card, plus the two vehicle payloads whose buckets are gated
 * individually rather than at the fetch.
 *
 * This list exists to be *checked against*, not just to document. A source with
 * no manifest entry falls through to "fetch always", which is the safe default
 * but also a silent one -- airfieldActivity sat there unnoticed, polling ~180 kB
 * every half hour for a layer a world-zoom session can never draw. Naming the
 * legitimate cases means an omission is a warning rather than a shrug.
 *
 * Kept in step with COUNTRY_CARD_FEEDS in createMapController.js: if those two
 * disagree, the country card loses rows with no error at all.
 */
export const UNGATED_FEEDS = new Set([
  "escalation", "conflictStats", "conflictDistricts", "humanitarian",
  "energyFlows", "foodTrade", "foodPriceIndex", "outages",
  // One payload each, split across three toggles by their own renderers.
  "ais", "adsb",
]);

/** Every layer key the manifest knows about. */
export const LAYER_KEYS = Object.keys(LAYER_MANIFEST);

// --- promotion -------------------------------------------------------------
//
// What the camera is looking at may move a layer one band shallower or deeper.
// It may never change a layer's disposition -- see rule 1 in the disposition
// note above.

// Ocean under the camera. The maritime layers are the answer to that view; the
// ground layers are not, and demoting them is nearly free but takes them out of
// the render pass entirely.
const MARITIME_PROMOTE = [
  "aisCivilian", "aisTanker", "ports", "cables", "cableLandings",
  "gfwDetections", "gfwGaps", "darkVessels",
];
const MARITIME_DEMOTE = ["cities", "infra", "osmInfra", "airports", "dams"];

// An active war under the camera, by the same thresholds updateCountryWarFlare
// already uses -- not a second definition of "at war".
const HOT_PROMOTE = [
  "conflictHistory", "officials", "cities", "infra", "osmInfra",
];

// A country the reader has clicked. Narrower than the war promotion because
// focus is an explicit act: it may also make corroborating layers eligible,
// which no camera position may do.
const FOCUS_PROMOTE = ["cities", "conflictHistory", "infra", "osmInfra"];

/**
 * @param {object} ctx
 * @param {number} ctx.zoom            current Leaflet zoom
 * @param {object|null} ctx.profile    what the camera is looking at, or null
 *                                     before the country index has loaded (see
 *                                     viewportProfile.js). Null means apply no
 *                                     promotion and no demotion: layers popping
 *                                     in seconds after boot, for a reason a
 *                                     reader cannot see, is worse than a beat
 *                                     of nothing.
 * @param {object|null} ctx.focus      {kind:"country"|"layer", key}
 * @param {object} ctx.overrides       Admin Mode's per-layer minZoom overrides
 * @param {boolean} ctx.bypass         Admin Mode's "ignore the resolver" switch
 * @returns {{band:string, active:Set<string>, drawZoom:Map, fetchZoom:Map,
 *            detail:string, caps:Map, collapse:Map}}
 */
export function resolveScene(ctx = {}) {
  const { zoom = 3, profile = null, focus = null, overrides = {}, bypass = false } = ctx;
  const band = bandFor(zoom);
  const detail = detailForBand(band);

  const active = new Set();
  const drawZoom = new Map();
  const fetchZoom = new Map();
  const caps = new Map();
  const collapse = new Map();

  for (const key of LAYER_KEYS) {
    const entry = LAYER_MANIFEST[key];
    const drawBand = effectiveDrawBand(key, entry, { profile, focus, bypass });
    const drawZ = zoomForDraw(entry, drawBand, overrides[key], bypass);

    drawZoom.set(key, drawZ);
    fetchZoom.set(key, fetchZoomOf(key, entry, { focus, bypass }));
    if (entry.collapse) collapse.set(key, entry.collapse);

    const capBand = entry.cap ? nearestCapBand(entry.cap, band) : null;
    // The bypass exists so an admin can reach a known state; a cap still
    // applied under it would make "what the shipped table does" unreachable.
    caps.set(key, bypass || capBand == null ? Infinity : entry.cap[capBand]);

    if (isActive(key, entry, { band, drawBand, zoom, drawZ, focus, bypass })) active.add(key);
  }

  // Trails follow their parent exactly, so they are answered rather than
  // resolved.
  for (const [trailKey, parentKey] of Object.entries(TRAIL_PARENT)) {
    drawZoom.set(trailKey, drawZoom.get(parentKey) ?? null);
    if (active.has(parentKey)) active.add(trailKey);
  }

  return { band, detail, active, drawZoom, fetchZoom, caps, collapse };
}

/** The band a layer draws at once the camera has had its say. */
function effectiveDrawBand(key, entry, { profile, focus, bypass }) {
  const base = entry.draw?.band ?? null;
  if (base == null || bypass || !profile) return base;

  let steps = 0;
  if (profile.isMaritime) {
    if (MARITIME_PROMOTE.includes(key)) steps -= 1;
    else if (MARITIME_DEMOTE.includes(key)) steps += 1;
  }
  if (profile.hotCountries?.length && HOT_PROMOTE.includes(key)) steps -= 1;
  if (focus?.kind === "country" && FOCUS_PROMOTE.includes(key)) steps -= 1;

  // At most one band either way. Two promotions stacking would put a layer two
  // bands from where its own argument put it, and no argument in this file
  // survives being moved that far.
  return shiftBand(base, Math.max(-1, Math.min(1, steps)));
}

/**
 * The exact zoom a layer draws from, as a number or null for "no gate".
 *
 * Admin Mode's per-layer override wins over everything, which is what makes the
 * override a diagnostic rather than a suggestion. Under bypass the shipped
 * number is returned rather than the promoted one, so an admin comparing
 * against the old behaviour reaches it exactly.
 */
function zoomForDraw(entry, drawBand, override, bypass) {
  if (Number.isFinite(override)) return override;
  if (entry.draw == null) return null;
  if (bypass) return entry.draw.z ?? floorOf(entry.draw.band);
  // An explicit `z` is an argued-for threshold, so a promotion moves it by the
  // same distance the band moved rather than discarding it for a band floor.
  if (Number.isFinite(entry.draw.z)) {
    const shift = floorOf(drawBand) - floorOf(entry.draw.band);
    return Math.max(0, entry.draw.z + shift);
  }
  return floorOf(drawBand);
}

function fetchZoomOf(key, entry, { focus, bypass }) {
  if (entry.fetch === FETCH_ALWAYS) return null;
  if (entry.fetch === FETCH_MANUAL) return Infinity;
  if (bypass) return null;
  // A focused country is a request for that country's whole picture, so its
  // feeds are fetched regardless of how far out the camera happens to be.
  if (focus?.kind === "country" && FOCUS_PROMOTE.includes(key)) return null;
  return floorOf(entry.fetch);
}

function isActive(key, entry, { band, drawBand, zoom, drawZ, focus, bypass }) {
  if (entry.disposition === MANUAL) return false;
  if (bypass) return true;
  if (entry.disposition === CORROBORATING && !isCorroborationOpen(key, focus)) return false;
  // No gate means the layer is always drawn once it is active at all -- that is
  // what "deliberately ungated" means for adsbFlagged, czib and darkVessels.
  if (drawZ == null) return drawBand == null || BAND_INDEX[band] >= BAND_INDEX[drawBand];
  return zoom >= drawZ;
}

/**
 * Has the reader done the thing that lets a corroborating layer draw?
 *
 * Focusing a country opens all of them within that focus. Clicking a pin opens
 * the layers that corroborate the thing clicked -- a tanker is what a
 * dark-vessel gap is a claim about; a port and a cable landing are the places a
 * maritime picture is anchored to.
 */
const CORROBORATES = {
  aisTanker: ["darkVessels", "gfwGaps", "gfwDetections"],
  aisCivilian: ["gfwGaps", "gfwDetections"],
  aisNavy: ["darkVessels"],
  ports: ["cables", "cableLandings", "darkVessels"],
  cableLandings: ["cables"],
  darkVessels: ["gfwGaps", "gfwDetections"],
  airports: ["osmInfra"],
  infra: ["osmInfra", "dams"],
};

function isCorroborationOpen(key, focus) {
  if (!focus) return false;
  if (focus.kind === "country") return true;
  if (focus.kind === "layer") {
    if (focus.key === key) return true;
    return (CORROBORATES[focus.key] || []).includes(key);
  }
  return false;
}

/**
 * The deepest capped band at or below `band`, so a cap carries downward.
 *
 * If nothing is declared at or below, the *shallowest* declared cap is used
 * rather than none. That second clause is not symmetry for its own sake -- it
 * closes a hole a promotion can open. A maritime profile promotes aisCivilian
 * from THEATRE to WORLD, and its cap is declared at THEATRE, so a downward-only
 * walk from WORLD found nothing and handed back ten thousand merchant hulls,
 * uncapped, at the one zoom where they are least legible. Falling forward can
 * only ever tighten: a layer drawn shallower than any band its author wrote a
 * number for gets the strictest number they wrote.
 */
function nearestCapBand(cap, band) {
  for (let i = BAND_INDEX[band]; i >= 0; i--) {
    if (cap[BANDS[i]] != null) return BANDS[i];
  }
  for (let i = BAND_INDEX[band] + 1; i < BANDS.length; i++) {
    if (cap[BANDS[i]] != null) return BANDS[i];
  }
  return null;
}

// --- the two thin readers --------------------------------------------------

/**
 * The zoom `key` draws from, given a resolved scene. Null means no gate.
 * minZoomFor in createMapController.js is a one-line wrapper around this.
 */
export function drawZoomFor(scene, key) {
  return scene?.drawZoom?.get(key) ?? null;
}

/**
 * The zoom `key` is fetched from. Null means always; Infinity means never
 * without an explicit request. gateFor in useOsintData.js wraps this.
 */
export function fetchZoomFor(scene, key) {
  const value = scene?.fetchZoom?.get(key);
  if (value !== undefined) return value;
  // Falling through here means "poll it at every zoom", which is the right
  // answer for the feeds in UNGATED_FEEDS and a mistake for anything else --
  // so say so rather than let a new source quietly inherit the loosest
  // behaviour available. Dev-only: a warning is for whoever added the source,
  // and there is nothing a reader could do about it.
  if (import.meta.env?.DEV && !UNGATED_FEEDS.has(key)) {
    console.warn(
      `[scene] "${key}" has no LAYER_MANIFEST entry, so it will be fetched at every zoom. ` +
        `Add an entry, or add it to UNGATED_FEEDS if that is deliberate.`
    );
  }
  return null;
}

/**
 * Whether this source's fetch carries a viewport bbox.
 *
 * Exactly the eleven endpoints that accept one on the backend (see
 * `_cached_source_response`'s `bbox` parameter in backend/app.py). Sending it to
 * an endpoint that ignores it would be harmless but dishonest -- the URL would
 * claim a clip that never happened, and this predicate is what anything else
 * has to consult to know whether a payload is complete or viewport-shaped.
 *
 * A layer earns the flag by being either too large to ship whole (FIRMS is a
 * quarter of a million points, airfields ~48k, GFW gaps ~23k) or unable to take
 * a band gate at all because the country card reads it (firms, jamming).
 */
export function isScoped(key) {
  return LAYER_MANIFEST[key]?.scoped === true;
}

/**
 * Extra query string a source's fetch carries at this zoom, or null.
 *
 * The sibling of `isScoped`: that one narrows a payload by *where*, this one by
 * *what kind*. It lives here rather than in the polling hook for the reason
 * every other gate does -- the numbers it compares against are the same ones
 * the map draws on, and a copy of them anywhere else is a copy that can drift.
 *
 * Only ADS-B has one, and it is the largest payload the API serves: ~17,000
 * aircraft and ~6.6 MB. Below zoom 9 the map draws none of the ordinary traffic
 * and none of the display-limited airframes, which together are almost all of
 * it -- so at that zoom the client asks the server for the few hundred aircraft
 * it can actually draw. See `_aircraft_priority` in backend/app.py for the
 * matching predicate, and note that it is deliberately a superset of this rule.
 *
 * Asking for less is an opt-out (`civilian=0`) rather than an opt-in, so
 * anything that does not know about this parameter -- curl, a stale bundle --
 * still gets the whole feed. An admin who moves either layer's zoom override
 * below the current zoom gets the full payload back automatically, which is
 * what makes the panel's override a real diagnostic here and not just a
 * drawing gate.
 */
export function sourceQueryFor(key, scene, zoom) {
  if (key !== "adsb") return null;
  const drawsOrdinaryTraffic = ["adsbCivilian", "adsbDisplayLimited"].some((k) => {
    const gate = scene?.drawZoom?.get(k);
    return gate == null || zoom >= gate;
  });
  return drawsOrdinaryTraffic ? null : "civilian=0";
}

/**
 * How coarsely a viewport bbox is snapped at this band, in degrees.
 *
 * Coarse enough that ordinary panning stays inside one cell, which is the whole
 * point: a fresh cell is a cache miss and a full download, so the snapping is
 * what keeps this a trade of "a small thing more often" rather than "a huge
 * thing constantly". Deliberately the same idea as _WIND_CACHE_GRID_DEG on the
 * backend, and it shrinks as the reader goes deeper because the question they
 * are asking gets more local.
 */
export function bboxSnapDegrees(band) {
  return { WORLD: 8, THEATRE: 8, COUNTRY: 4, LOCAL: 2, SITE: 2 }[band] ?? 8;
}

/**
 * The shipped gate for a layer, ignoring profile, focus and admin overrides --
 * i.e. what the old MARKER_LAYER_MIN_ZOOM table held. Read by
 * settings/defaults.js so the admin panel's zoom sliders start from one number
 * rather than a third restatement of it.
 */
export function shippedDrawZoom(key) {
  const entry = LAYER_MANIFEST[key];
  if (!entry?.draw) return null;
  return entry.draw.z ?? floorOf(entry.draw.band);
}
