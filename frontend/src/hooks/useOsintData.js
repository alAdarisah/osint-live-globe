// Owns everything about *what data the app has* and *which region it's
// scoped to* -- polling every /api/* source, tracking first-load status for
// the boot screen, and region selection. Deliberately knows nothing about
// Leaflet: every fetched payload is handed off via the onData(key, data)
// callback (wired to the map controller's applyData in App.jsx) rather than
// stored as React state, since most of these sources (FIRMS alone can be
// 100k+ points) would make every poll a wasteful full-tree re-render for no
// UI that actually needs it reactively. GDELT and ACLED are the exceptions
// -- the news broadcast panel and the "Choose Conflict Zone" activity
// ranking need them reactively, and both payloads are small, bounded
// (days-wide) windows, not the FIRMS/cities scale this comment warns about.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, urlForRegion, urlWithBbox, urlWithQuery } from "../api";
import {
  resolveScene, fetchZoomFor, isScoped, sourceQueryFor, bboxSnapDegrees, bandFor,
} from "../map/scene";

/**
 * The one order that keeps `raw.fetchCoverage` from ever describing a fetch
 * that `raw[key]` doesn't reflect yet: record coverage first, publish the
 * data second.
 *
 * `onData` (wired to the map controller's `applyData` in App.jsx) runs
 * synchronously, and for a key in `COUNTRY_CARD_FEEDS` that synchronously
 * rebuilds an open country card from `raw` -- which reads `raw.fetchCoverage`.
 * Publishing data before recording coverage left a window, on exactly the
 * refresh this mechanism exists for (a gated feed's first delivery while a
 * card is open), where the card rendered fresh data next to a coverage line
 * still reading "not loaded". Same class of false claim the coverage fix
 * itself was written to prevent, reintroduced by call order -- see the Task 9
 * review that caught it.
 *
 * Pulled out as its own pure function, with the two publishers passed in
 * rather than closed over, specifically so this ordering can be asserted by
 * a test: the hook it's called from is a real React effect with real timers,
 * which this project's test setup (`node --test`, no jsdom/React harness)
 * cannot exercise end to end, so the invariant is tested here instead, at the
 * one seam that is plain JS.
 *
 * `dataPublishes` is a list rather than a single [key, data] pair because two
 * of the three call sites (the cables and infrastructure one-shot fetches)
 * split one response across two `raw` slots and one coverage record.
 */
export function publishFetchOutcome(recordCoverage, onData, coverageKey, coveragePatch, dataPublishes) {
  recordCoverage(coverageKey, coveragePatch);
  for (const [key, data] of dataPublishes) onData(key, data);
}

const BOOT_SOURCES = [
  { key: "countries", label: "Country boundaries" },
  { key: "cities", label: "City index" },
  { key: "events", label: "Conflict & violence events (ACLED + UCDP + GDELT, fused)" },
  { key: "firms", label: "Thermal anomaly feed (NASA FIRMS)" },
  { key: "gdelt", label: "Global news stream (GDELT)" },
  { key: "ais", label: "Maritime traffic (AIS)" },
  { key: "adsb", label: "Aircraft tracking (ADS-B)" },
  { key: "jamming", label: "GPS/radio jamming (GPSJam)" },
  { key: "satellites", label: "Satellite tracking (CelesTrak)" },
  // Task 24: the three client-propagated groups on by default (see
  // map/scene.js) -- same footing as "satellites" above, the server-
  // propagated pair. The other four groups are off by default and fetched
  // on demand instead (see createMapController.js's setLayerVisible), so
  // they never belong on this list -- nothing should make the boot screen
  // wait on a layer nobody has asked to see yet.
  { key: "satNavigation", label: "Satellite tracking: navigation (CelesTrak, browser-propagated)" },
  { key: "satWeather", label: "Satellite tracking: weather (CelesTrak, browser-propagated)" },
  { key: "satImaging", label: "Satellite tracking: Earth imaging (CelesTrak, browser-propagated)" },
];

// ACLED/FIRMS refresh server-side every 30/15 minutes respectively (see
// backend/config.py) -- polling their large payloads every 60s bought
// nothing but redundant fetch/parse work, since the underlying data was
// still the same one most of the time. 3 minutes still feels current.
const POLL_CONFIG = [
  { key: "events", url: "/api/events", intervalMs: 60000 }, // GDELT-driven (event_fusion.py), same cadence as gdelt below
  { key: "firms", url: "/api/fires", intervalMs: 180000 },
  { key: "gdelt", url: "/api/news", intervalMs: 60000 },
  // Officials & Diplomacy. Slower than news on purpose: its GDELT half moves on
  // the same 15-minute poll as everything else GDELT, and its other half is
  // government press feeds that publish a handful of times a day.
  { key: "officials", url: "/api/officials", intervalMs: 2 * 60000 },
  { key: "countries", url: "/api/countries", intervalMs: 5 * 60000 },
  { key: "cities", url: "/api/cities", intervalMs: 5 * 60000 },
  { key: "ais", url: "/api/ships", intervalMs: 10000 },
  // Aircraft, and the biggest single payload the frontend takes: ~6.6 MB of
  // roughly seventeen thousand airframes.
  //
  // Be careful about what this interval does and does not cost, because the
  // obvious arithmetic is wrong. Twenty seconds against 6.6 MB looks like
  // ~1.2 GB an hour, and it is not: backend/config.py refreshes ADS-B every
  // 120s (ADSB_POLL_INTERVAL_AUTH; 900s unauthenticated), and fetchJson sends
  // If-None-Match, so every poll between two refreshes 304s at zero bytes.
  // Measured against the running backend: four consecutive 304s, then one
  // 6,582,858-byte 200. The bytes are set by the server's refresh rate, and a
  // client polling slower than that rate cannot save any of them -- it can only
  // arrive later. So this pacing buys round-trips, not megabytes: 180 requests
  // an hour down to 60 while the reader is zoomed out. Real, and small.
  //
  // Worth having anyway, because above COUNTRY band almost none of the payload
  // can be drawn: civilian traffic is gated at zoom 9, leaving the military,
  // flagged and emergency buckets, which are hundreds of aircraft moving
  // imperceptibly at that scale. Checking three times a minute for a change
  // nobody could see is work with no reader behind it.
  //
  // What would actually cut the megabytes is making each body smaller rather
  // than asking for it less often -- a class filter or a viewport bbox on the
  // endpoint. Neither exists yet; the feed cannot simply be gated off, because
  // the country card counts military aircraft inside a country bbox (see
  // FETCH_ALWAYS_BECAUSE in map/scene.js).
  //
  // One cost, stated rather than hidden: trails accumulate one point per poll,
  // and military aircraft *are* drawn at world zoom. At 60 seconds a cruising
  // airframe lays a point every ~15 km -- sub-pixel where it is recorded, but a
  // visibly coarser segment if the reader later zooms in on that track, and a
  // hole in a track can never be refilled.
  { key: "adsb", url: "/api/aircraft", intervalMs: 20000, intervalByBand: { WORLD: 60000, THEATRE: 60000 } },
  { key: "jamming", url: "/api/jamming", intervalMs: 30 * 60000 }, // gpsjam.org itself only updates once/day
  // Task 20a: the AIS traffic grid (backend/refine/lane_density.py). The grid
  // itself only moves once an hour (config.LANE_DENSITY_INTERVAL) and decays
  // slowly on top of that, so a poll much faster than that would just re-serve
  // the same cells -- five minutes is close enough to "current" for a heat wash
  // that is honest about covering the last thirty days, not the last minute.
  { key: "laneDensity", url: "/api/lanes", intervalMs: 5 * 60000 },
  // Earthquakes and volcanic activity. Paced to the faster of its two inputs:
  // USGS refreshes every ~5 minutes and a felt earthquake is the kind of thing
  // a reader expects to appear while they are watching. The volcano half of the
  // same payload only changes weekly (see backend/sources/hazards.py).
  { key: "hazards", url: "/api/hazards", intervalMs: 5 * 60000 },
  // Airfields. Reference data that only refreshes once a day server-side and is
  // browser-cached for an hour (see /api/airports) -- polled at all only so a
  // client left open overnight picks up the new file.
  { key: "airports", url: "/api/airports", intervalMs: 60 * 60000 },
  // AIS gaps and possible ship-to-ship transfers. The backend recomputes these
  // from three days of its own recorded history every 15 minutes, so polling
  // faster would only re-serve the same answer.
  { key: "darkVessels", url: "/api/dark-vessels", intervalMs: 5 * 60000 },
  // Country-level internet outage scores (IODA). Recomputed server-side every
  // 15 minutes over a trailing 24h window -- see backend/sources/outages.py.
  { key: "outages", url: "/api/outages", intervalMs: 5 * 60000 },
  // The same poll's sub-national pass -- IODA's region-level scores, matched
  // to admin-1 boundaries by name server-side (Task 26). Same cadence as
  // "outages" above, since it comes off the same backend poller.
  { key: "outagesRegions", url: "/api/outages/regions", intervalMs: 5 * 60000 },
  // Orbital launches. The backend refetches every 30 minutes and no faster --
  // Launch Library rate-limits anonymous callers to roughly 15 requests an hour
  // (see backend/sources/launches.py).
  { key: "launches", url: "/api/launches", intervalMs: 10 * 60000 },
  // Displacement and food security. Both publishers update on the order of
  // months; this is polled at all only so a long-lived tab eventually notices.
  { key: "humanitarian", url: "/api/humanitarian", intervalMs: 60 * 60000 },
  // OpenStreetMap infrastructure. Swept server-side once a day over the conflict
  // theatres and browser-cached for an hour, so the interval is only about
  // picking up a new sweep, not about freshness.
  //
  // The fetch gate that used to be declared here now lives in map/scene.js,
  // together with the drawing gate it has to agree with -- and it is no longer
  // the exception it was. Every source below is gated by the same table, so a
  // world-zoom session no longer fetches megabytes of geometry purely to filter
  // them back out.
  { key: "osmInfra", url: "/api/osm-infrastructure", intervalMs: 30 * 60000 },
  { key: "satellites", url: "/api/satellites", intervalMs: 10000 }, // position, not elements -- see backend/sources/satellites.py
  // Task 24: element sets (not positions -- propagation happens client-side,
  // see map/satPropagate.js) for the three groups on by default. The
  // backend only refreshes these every six hours (elements barely change --
  // see ELEMENTS_REFRESH_INTERVAL in backend/sources/satellites.py), so this
  // interval is not about freshness in the way the 10s "satellites" row
  // above is; it exists so a tab left open for a long session eventually
  // notices a launch or a decay, the same reasoning airports'/osmInfra's own
  // reference-data polls already use. Each lands in createMapController.js
  // through applyData's "key in SAT_ELEMENT_CELESTRAK_GROUP" branch, which
  // feeds the shared propagation tracker rather than a `raw[key]` array.
  { key: "satNavigation", url: "/api/satellites/elements?groups=navigation", intervalMs: 30 * 60000 },
  { key: "satWeather", url: "/api/satellites/elements?groups=weather", intervalMs: 30 * 60000 },
  { key: "satImaging", url: "/api/satellites/elements?groups=imaging", intervalMs: 30 * 60000 },
  { key: "conflictStats", url: "/api/conflict-stats", intervalMs: 60 * 60000 }, // HDX file itself only changes weekly -- see backend/sources/hdx_conflict_stats.py
  // Server-side aggregate over a week of history (backend/escalation.py),
  // already cached for 120s there -- polling it faster would just re-serve
  // the same object, and the underlying signal moves on the order of hours.
  { key: "escalation", url: "/api/escalation", intervalMs: 3 * 60000 },
  // UCDP's reviewed record and ACLED's district-level monthly counts. Both are
  // historical by nature -- UCDP's candidate file lags a month or more and the
  // ACLED aggregates run to the end of last month -- so they change on the
  // order of weeks and are polled accordingly. Neither is a live feed and
  // neither is rendered as one.
  { key: "conflictHistory", url: "/api/conflict-history", intervalMs: 6 * 60 * 60000 },
  { key: "conflictDistricts", url: "/api/conflict-districts", intervalMs: 6 * 60 * 60000 },
  // Recorded traffic per airfield, derived from our own ADS-B history by the
  // refine process every 30 minutes (see backend/sources/airfield_activity.py).
  // Polled on the same cadence it is recomputed -- asking faster only re-serves
  // the same document. Not zoom-gated despite attaching to a zoom-gated layer:
  // it is ~180 kB once, and the airfields toggle can be switched on at any time.
  { key: "airfieldActivity", url: "/api/airfield-activity", intervalMs: 30 * 60000 },
  // Global Fishing Watch's AIS disabling events. Refetched server-side every six
  // hours, and the batch itself is five or more days behind, so the hourly poll
  // is only about a long-lived tab noticing a new batch. Most of these return
  // 304 on the ETag.
  { key: "gfwGaps", url: "/api/gfw-gaps", intervalMs: 60 * 60000 },
  // Radar and optical vessel detections, same six-hour server cadence.
  // Detections cluster inside the AIS watch boxes, so the payload is far denser
  // than its row count suggests -- see its scene.js entry for the gate.
  { key: "gfwDetections", url: "/api/gfw-detections", intervalMs: 60 * 60000 },
  // EASA conflict-zone bulletins. Refetched twice a day server-side; an hour is
  // the finest resolution the server can honestly offer, and a newly issued
  // bulletin is the kind of thing worth arriving inside the hour.
  { key: "czib", url: "/api/czib", intervalMs: 60 * 60000 },
  // GDACS flood alerts, refetched every 30 minutes server-side. Same
  // server-cadence-over-three ratio darkVessels uses above.
  { key: "floods", url: "/api/floods", intervalMs: 10 * 60000 },
  // Two published gazetteers, neither of which is a feed. NGA refetches monthly
  // and Global Dam Watch has not moved since 2024 -- these are polled only so a
  // tab left open across a release picks it up.
  { key: "ports", url: "/api/ports", intervalMs: 6 * 60 * 60000 },
  { key: "dams", url: "/api/dams", intervalMs: 6 * 60 * 60000 },
  // DeFlock ALPR camera locations. Refreshed once a day server-side (a mirror of
  // one Overpass query, see backend/sources/deflock.py), so a daily poll is all
  // it warrants. Its LOCAL fetch gate (map/scene.js) keeps this ~125k-point,
  // unscoped body off cold world/theatre paints: it is only fetched once the
  // reader is zoomed to a town, which is also the only zoom it draws at.
  { key: "deflock", url: "/api/deflock", intervalMs: 24 * 60 * 60000 },
  // Cross-border electricity. Swept hourly server-side; the underlying 15-minute
  // metering resolution is invisible to a client sitting behind that sweep.
  { key: "energyFlows", url: "/api/energy-flows", intervalMs: 20 * 60000 },
  // FAO's balance sheets and price index. The publishers issue these about ten
  // times a year and monthly respectively -- same slot and same reasoning as
  // humanitarian above.
  { key: "foodTrade", url: "/api/food-trade", intervalMs: 60 * 60000 },
  { key: "foodPriceIndex", url: "/api/food-price-index", intervalMs: 60 * 60000 },
  // Task 27: Digitraffic's live Finnish train positions (~111 trains). The
  // backend itself refreshes every 60s (config.DIGITRAFFIC_RAIL_POLL_INTERVAL)
  // and answers If-None-Match, so polling somewhat faster than that costs
  // round-trips rather than bytes -- the same trade adsb's own note above
  // makes about its interval versus the server's refresh rate. Ungated
  // (LAYER_MANIFEST's railLive has no draw gate), so this fetch is not either.
  { key: "railLive", url: "/api/rail-live", intervalMs: 20000 },
];

/**
 * @param onData      called with every payload, after `transform`
 * @param flyToRegion the map's own region fly-to
 * @param transform   (key, data) => data. Admin Mode's record overrides are
 *   applied here, between the fetch and everything downstream, so the map and
 *   the panels can never be looking at differently-edited copies of one feed
 *   (see settings/applyOverrides.js).
 * @param zoom        the map's current zoom, or null before the map reports one.
 *   Read only by the fetch gate below -- this hook still knows nothing about
 *   Leaflet, just about how deep the reader has gone.
 * @param zoomOverrides Admin Mode's per-layer zoom gates, the same object the
 *   map controller is given (see setLayerZoomOverrides in App.jsx). Honoured
 *   here too, so lowering a gate in the admin panel actually fetches the layer
 *   at the zoom it now claims to draw at.
 * @param focus       what the reader has clicked, or null. A focused country is
 *   a request for that country's whole picture, so map/scene.js lifts the fetch
 *   gate on its feeds however far out the camera happens to be.
 */
export function useOsintData({ onData, flyToRegion, transform, zoom = null, zoomOverrides, focus = null, mapBounds = null }) {
  const [regions, setRegions] = useState({});
  const [currentRegionKey, setCurrentRegionKey] = useState(null); // null == world/unscoped
  const [currentRegionLabel, setCurrentRegionLabel] = useState("World");
  const [gdeltRaw, setGdeltRaw] = useState([]);
  const [eventsRaw, setEventsRaw] = useState([]);
  // Reactive like gdelt/events, and for the same two reasons: the country card
  // reads it, and Admin Mode's data editor can only list a feed the app is
  // actually holding. The payload is one bounded day of diplomatic items.
  const [officialsRaw, setOfficialsRaw] = useState([]);
  // Regions running above their own baseline (backend/escalation.py).
  // Reactive like gdelt/events because a panel renders it directly.
  const [escalation, setEscalation] = useState([]);
  // Only the cut-off date, not the rows: the UCDP payload is thousands of
  // records that only the map needs, but the date has to reach the control
  // panel so the layer can state its own staleness.
  const [conflictHistoryAsOf, setConflictHistoryAsOf] = useState(null);
  const [bootSources, setBootSources] = useState(() => BOOT_SOURCES.map((s) => ({ ...s, status: "pending" })));

  // Read by poller ticks so a region switch is picked up on the very next
  // tick without having to tear down and recreate every poller.
  const currentRegionKeyRef = useRef(null);
  currentRegionKeyRef.current = currentRegionKey;

  const regionsRef = useRef({});

  // `onData` is a fresh inline function from App.jsx on every render (it
  // closes over `mapApi`) -- reading it through a ref, rather than putting
  // it in the effect's dependency array, is what actually makes the
  // pollers-registration effect below mount-once like its own comments say.
  // With `onData` in the deps, every App re-render (which happens on nearly
  // every poll, since reportCounts/reportZoomNotes flow into React state)
  // tore down and re-registered all 9 pollers, cancelling whichever fetches
  // hadn't resolved yet -- the short-interval sources (satellites, AIS) lost
  // that race almost every time and could go long stretches never actually
  // delivering data, even though every individual fetch succeeded.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  // Same ref treatment, same reason: `transform` closes over the current
  // settings and changes identity whenever they do, and the pollers must not
  // be torn down for that.
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Each value is a zero-arg fn that re-runs that source's fetch immediately
  // (cancelling its own pending scheduled tick first) -- see registerPoller
  // below. refetchAllNow calls every one of them, which is what makes a
  // region switch feel instant instead of waiting up to intervalMs. Keyed
  // rather than a flat list because the zoom gate below has to reach one
  // specific source's tick the moment its gate opens.
  const tickersRef = useRef(new Map());

  const refetchAllNow = useCallback(() => {
    tickersRef.current.forEach((tick) => tick());
  }, []);

  // Read inside tick(), which is registered once and must see the current
  // values rather than the ones from the render that created it -- the same
  // ref treatment onData/transform get above.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomOverridesRef = useRef(zoomOverrides);
  zoomOverridesRef.current = zoomOverrides;

  // What the reader has clicked, read inside tick() for the same reason zoom is.
  // A focused country is a request for that country's whole picture, so the
  // resolver lifts the fetch gate on its feeds however far out the camera is.
  const focusRef = useRef(focus);
  focusRef.current = focus;

  /**
   * The zoom a source starts fetching at: null for "always", Infinity for
   * "never without an explicit request", a number otherwise.
   *
   * Resolved by map/scene.js, which is the same table minZoomFor in
   * createMapController.js reads for the *drawing*. That is the whole point of
   * the table: a source whose drawing is gated on a zoom has its fetch gated on
   * the same number, and the two used to be separate constants that had to be
   * kept in step by hand.
   */
  const sceneNow = useCallback(
    () =>
      resolveScene({
        zoom: zoomRef.current ?? 3,
        focus: focusRef.current,
        overrides: zoomOverridesRef.current || {},
      }),
    []
  );

  const gateFor = useCallback((key) => fetchZoomFor(sceneNow(), key), [sceneNow]);

  /**
   * The extra query a source asks for at this zoom, or null.
   *
   * Resolved from the same table as the gates (see sourceQueryFor in
   * map/scene.js), and read in two places that have to agree: the URL a poller
   * fetches, and the scope signature below that decides whether a held payload
   * is still the right one. If only the first knew about it, a reader zooming
   * out would keep serving the payload they fetched on the way in.
   */
  const sourceQuery = useCallback(
    (key) => sourceQueryFor(key, sceneNow(), zoomRef.current ?? 3),
    [sceneNow]
  );

  /**
   * The viewport as a snapped "south,west,north,east" string, or null.
   *
   * Snapped, and that is the whole design. An exact viewport would mint a new
   * URL -- and so a new ETag and a full download -- on every pixel of pan,
   * which would be strictly worse than shipping the payload whole. Rounded to a
   * grid, ordinary panning stays inside one cell and re-requests nothing; the
   * grid shrinks with the band because the question gets more local. This is
   * the same trade /api/wind has always made with _WIND_CACHE_GRID_DEG.
   *
   * Padded by 25% first, matching the margin every renderer already filters
   * against (`map.getBounds().pad(0.25)`), so a pin just off-screen is in hand
   * before the reader pans onto it.
   *
   * Under a country focus the box is that country's bounds rather than the
   * camera's: focusing a country is a request for its whole picture, and
   * clipping to the viewport would leave the parts they have not scrolled to
   * missing from a card that claims to describe the country.
   */
  const bboxCell = useMemo(() => {
    if (focus?.kind === "country" && focus.bounds) {
      const [s, w, n, e] = focus.bounds;
      return `${s.toFixed(2)},${w.toFixed(2)},${n.toFixed(2)},${e.toFixed(2)}`;
    }
    const b = mapBounds;
    if (!b) return null;
    const snap = bboxSnapDegrees(bandFor(zoom ?? 3));
    const padLat = (b.north - b.south) * 0.25;
    const padLon = (b.east - b.west) * 0.25;
    const south = Math.max(-90, Math.floor((b.south - padLat) / snap) * snap);
    const north = Math.min(90, Math.ceil((b.north + padLat) / snap) * snap);
    const west = Math.max(-180, Math.floor((b.west - padLon) / snap) * snap);
    const east = Math.min(180, Math.ceil((b.east + padLon) / snap) * snap);
    // A box covering essentially everything is not worth sending: it clips
    // nothing, and every distinct bbox string is its own cache entry on both
    // sides. Better one shared unscoped URL than a private full-world one.
    if (south <= -90 && north >= 90 && west <= -180 && east >= 180) return null;
    // west > east would be a box across the antimeridian, which the backend
    // refuses (see regions.parse_bbox) -- so it is not sent at all.
    if (west > east || south > north) return null;
    return `${south},${west},${north},${east}`;
  }, [mapBounds, zoom, focus]);

  // The pollers are registered once and read this through a ref, the same way
  // they read the region and the zoom.
  const bboxCellRef = useRef(bboxCell);
  bboxCellRef.current = bboxCell;

  // The last payload each source delivered, exactly as the server sent it.
  // Holding it costs nothing extra -- the map controller keeps the same objects
  // alive in its own `raw` -- and it is what lets an Admin Mode edit show up
  // immediately instead of at the next poll, without re-fetching feeds that
  // have not changed. Re-running the transform from the *fetched* payload
  // rather than the previous transformed one is what makes unhiding a record
  // possible: an override is a view of the source, not an edit to it.
  const fetchedRef = useRef({});
  const reapplyTransformRef = useRef(() => {});
  const reapplyTransform = useCallback((keys) => reapplyTransformRef.current(keys), []);

  /**
   * Per-feed fetch coverage, threaded into `raw.fetchCoverage` (via
   * onData("fetchCoverage", ...)) so the country card's honesty section
   * (buildCoverage, map/popups.js) can tell "checked this country's bbox and
   * found nothing" apart from "never fetched" and from "fetched, but for a
   * different area" -- three states a raw array's own emptiness cannot carry,
   * since `raw[key]` starts as `[]` at construction (see createMapController.js)
   * and never distinguishes "swept and empty" from "not swept yet".
   *
   * `status` is the most recent tick's outcome for `key` ("gated" | "fetched" |
   * "error"); `fetchedAt`/`bbox` describe the data actually sitting in
   * `raw[key]` right now and are only touched on a real success, so a gated or
   * failed tick does not erase what an earlier successful one already proved.
   * `bbox` is the "south,west,north,east" cell (see bboxCell above) that
   * fetch was scoped to, or `null` for a source with no bbox restriction at
   * all (isScoped(key) === false, or the computed cell was "essentially the
   * whole world" -- both mean the same thing to a reader: nothing was clipped).
   */
  const fetchCoverageRef = useRef({});
  const recordCoverageRef = useRef(() => {});

  /**
   * What scope each source's held payload was fetched under.
   *
   * The URL a poller asks for is a function of more than the endpoint: the
   * region key becomes a query parameter, and a country focus will scope it
   * further still. So "have we fetched this" is the wrong question and always
   * was -- "have we fetched this for the scope we are now in" is the right one,
   * and it is the difference between showing Ukraine's infrastructure and
   * showing Sudan's under Ukraine's camera.
   */
  const fetchedScopeRef = useRef({});
  const scopeSignatureRef = useRef(() => "");
  // Per-source, because the last term is: two sources can be under the same
  // region, focus and viewport and still be asking for different things (see
  // sourceQuery above). Generic rather than special-cased on "adsb", so a
  // future per-source parameter joins the signature by existing rather than by
  // someone remembering to add it here.
  scopeSignatureRef.current = (key) =>
    `${currentRegionKey ?? "world"}|${focus?.kind === "country" ? focus.key : ""}` +
    `|${bboxCell ?? ""}|${sourceQuery(key) ?? ""}`;

  useEffect(() => {
    let cancelled = false;
    const timeouts = [];

    // "deferred" is terminal for the boot screen but not for the source: a
    // deferred source that later gets deep enough to fetch upgrades to ok/warn,
    // which is why both statuses are accepted here as a starting point.
    const UNRESOLVED = new Set(["pending", "deferred"]);

    function markSourceLoaded(key, ok) {
      setBootSources((prev) =>
        prev.map((s) => (s.key === key && UNRESOLVED.has(s.status) ? { ...s, status: ok ? "ok" : "warn" } : s))
      );
    }

    function markSourceDeferred(key) {
      setBootSources((prev) =>
        prev.map((s) => (s.key === key && s.status === "pending" ? { ...s, status: "deferred" } : s))
      );
    }

    // Merges `patch` into this key's coverage record and republishes the whole
    // map. A shallow copy each time -- not a mutation of the object already
    // sitting in `raw.fetchCoverage` -- so nothing downstream that captured a
    // reference to a previous snapshot sees it change under it.
    recordCoverageRef.current = (key, patch) => {
      fetchCoverageRef.current = {
        ...fetchCoverageRef.current,
        [key]: { ...fetchCoverageRef.current[key], ...patch },
      };
      onDataRef.current("fetchCoverage", fetchCoverageRef.current);
    };

    function registerPoller(key, url, intervalMs, intervalByBand, onSuccess) {
      let timer = null;
      // Read at schedule time rather than closed over at registration, which is
      // what makes the cadence follow the camera: a source whose table names
      // the band the reader has just left is at most one interval behind, and
      // the band-change effect below closes even that gap on the way in.
      const intervalNow = () =>
        (intervalByBand && intervalByBand[bandFor(zoomRef.current ?? 3)]) || intervalMs;
      // Two flags, because they answer two different questions. `bootReported`
      // is whether the boot screen has been told anything about this source at
      // all, and a deferral counts. `firstFetchDone` is whether a real network
      // attempt has ever completed, which is what the backgrounded-tab guard
      // below needs -- a source that was only ever deferred has still never
      // fetched, and must not be treated as though it had.
      let bootReported = false;
      let firstFetchDone = false;
      async function tick() {
        if (timer) clearTimeout(timer);
        const gate = gateFor(key);
        if (gate != null) {
          const zoomNow = zoomRef.current;
          if (zoomNow == null || zoomNow < gate) {
            // Below the gate this source is not drawn at all, so fetching it
            // would be work nobody can see. Kept on the interval rather than
            // dropped: the scope effect below fires the moment the reader gets
            // deep enough, so this timer is only the fallback.
            //
            // A boot source that is deferred has to say so rather than stay
            // pending. LoadingScreen waits for every one of its sources to
            // resolve, and the "first load always goes through" guard below
            // covers a backgrounded tab, not a zoom gate -- so without this a
            // gated boot source (cities is one, and the map opens at zoom 3)
            // would leave the boot screen waiting forever for a fetch that is
            // correctly not happening.
            if (!bootReported) {
              bootReported = true;
              markSourceDeferred(key);
            }
            // Below its gate, this tick is not attempting a fetch at all --
            // scene.js already knows that, so buildCoverage doesn't have to
            // guess it from an empty array. fetchedAt/bbox are left alone: if
            // an earlier fetch (before the reader zoomed back out, say)
            // already covered some area, that fact is still true of what's
            // sitting in raw[key] right now.
            //
            // No publishFetchOutcome ordering concern here: this branch never
            // calls onDataRef.current at all (no fetch happened, nothing to
            // publish), so there is no synchronous card rebuild for this
            // write to race against.
            recordCoverageRef.current(key, { status: "gated", scoped: isScoped(key) });
            timer = setTimeout(tick, intervalNow());
            return;
          }
        }
        if (document.hidden && firstFetchDone) {
          // Nobody's looking at a backgrounded tab -- skip the network
          // round-trip and just re-check next interval. The visibilitychange
          // listener below calls refetchAllNow() the instant the tab comes
          // back, so this never shows stale data, just skips fetching while
          // it can't be seen. The very first load always goes through even
          // if the tab happens to start backgrounded, so the boot screen
          // can't hang waiting for data that never arrives.
          timer = setTimeout(tick, intervalNow());
          return;
        }
        try {
          // Captured before the await, so the signature recorded below is the
          // one this request was actually made under rather than whatever the
          // reader has moved to while it was in flight.
          const signature = scopeSignatureRef.current(key);
          const regionUrl = urlForRegion(url, currentRegionKeyRef.current);
          const scopedUrl = urlWithQuery(
            isScoped(key) ? urlWithBbox(regionUrl, bboxCellRef.current) : regionUrl,
            sourceQuery(key)
          );
          const fetched = await fetchJson(scopedUrl);
          if (cancelled) return;
          fetchedRef.current[key] = fetched;
          fetchedScopeRef.current[key] = signature;
          const data = transformRef.current ? transformRef.current(key, fetched) : fetched;
          onSuccess?.(data);
          // publishFetchOutcome records coverage before handing the data to
          // onDataRef.current -- see its own docstring for why the order,
          // not just the content, of these two writes matters.
          publishFetchOutcome(recordCoverageRef.current, onDataRef.current, key, {
            status: "fetched",
            fetchedAt: Date.now(),
            // The bbox this request actually carried -- null for an unscoped
            // source (isScoped(key) === false) or for a scoped one whose
            // computed cell was "essentially the whole world" (bboxCell's own
            // guard), both of which mean nothing was clipped.
            bbox: isScoped(key) ? bboxCellRef.current : null,
            scoped: isScoped(key),
          }, [[key, data]]);
          firstFetchDone = true;
          bootReported = true;
          // Unconditional: markSourceLoaded only touches rows still pending or
          // deferred, so this upgrades a deferred source once it really loads
          // and is a no-op on every poll after that.
          markSourceLoaded(key, true);
        } catch (err) {
          // Pre-existing: unlike the success path above, this branch does not
          // check `cancelled` before writing. Harmless today -- every write
          // here is a ref mutation with no React state and no onDataRef.current
          // call, so there is nothing for a cancelled effect to leave in a bad
          // state -- but noted rather than fixed as a drive-by, since it is
          // not part of what this pass was asked to change.
          console.warn(`Failed to fetch ${key}:`, err);
          firstFetchDone = true;
          if (!bootReported) {
            bootReported = true;
            markSourceLoaded(key, false);
          }
          // fetchedAt/bbox untouched -- an error says nothing about the data
          // already sitting in raw[key] from a previous success, if any.
          // No publishFetchOutcome ordering concern here either: no fetch
          // landed, so onDataRef.current is never called from this branch.
          recordCoverageRef.current(key, { status: "error", scoped: isScoped(key) });
        } finally {
          if (!cancelled) timer = setTimeout(tick, intervalNow());
        }
      }
      timeouts.push(() => clearTimeout(timer));
      tickersRef.current.set(key, tick);
      tick();
    }

    const REACTIVE_SETTERS = {
      gdelt: setGdeltRaw,
      events: setEventsRaw,
      officials: setOfficialsRaw,
      escalation: setEscalation,
      conflictHistory: (rows) =>
        setConflictHistoryAsOf((rows && rows.length && rows[0].as_of) || null),
    };
    for (const src of POLL_CONFIG) {
      registerPoller(src.key, src.url, src.intervalMs, src.intervalByBand, REACTIVE_SETTERS[src.key]);
    }

    // Defined inside the effect so it can see REACTIVE_SETTERS, and reached
    // from outside through a ref for the same reason the pollers are: this
    // effect mounts once.
    reapplyTransformRef.current = (keys) => {
      const wanted = keys || Object.keys(fetchedRef.current);
      for (const key of wanted) {
        const fetched = fetchedRef.current[key];
        if (fetched === undefined) continue;
        const data = transformRef.current ? transformRef.current(key, fetched) : fetched;
        REACTIVE_SETTERS[key]?.(data);
        onDataRef.current(key, data);
      }
    };

    // Static for the process lifetime -- fetched once, not part of the
    // regular poll cycle.
    fetchJson("/api/regions")
      .then((data) => {
        if (cancelled) return;
        regionsRef.current = data;
        setRegions(data);
      })
      .catch((err) => console.warn("Failed to load regions:", err));

    // Critical-infrastructure reference sites + pipeline routes -- also
    // static for the process lifetime, fetched once as one payload
    // ({sites, pipelines}, see backend/infrastructure.py) and split into two
    // onData calls so each has its own raw slot, same as every other source
    // (see onData/mapApi.applyData in App.jsx). This endpoint is cached by
    // the browser for 24h (see its Cache-Control in backend/app.py) --
    // a still-cached response from before pipelines existed would just be
    // the old bare sites array, so both shapes are handled rather than
    // assuming every cached copy already matches the current one.
    // Submarine cables: routes and landing points arrive as one payload and are
    // split into two raw slots, exactly as /api/infrastructure is below. Also
    // fetched once rather than polled -- new cables land a few times a year.
    fetchJson("/api/cables")
      .then((data) => {
        if (cancelled) return;
        // Whole-world, one-shot, never polled (fetch: FETCH_MANUAL in
        // scene.js) -- so this is the only moment cableLandings' coverage
        // ever changes from "not loaded" to "fetched". Not bbox-scoped, so
        // once this lands it covers every country's card equally.
        // publishFetchOutcome again, for the same reason as the generic
        // poller above -- coverage recorded before either onData call.
        publishFetchOutcome(
          recordCoverageRef.current, onDataRef.current, "cableLandings",
          { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: false },
          [["cables", data?.cables || []], ["cableLandings", data?.landings || []]]
        );
      })
      .catch((err) => console.warn("Failed to load submarine cables:", err));

    // Coarse railway linework -- a whole document ({lines, attribution,
    // provenance}, see backend/sources/railways.py), hard-cached for a day and
    // fetched once at boot rather than polled, exactly like the cables routes
    // above. The whole document is handed on so the popup can state its own
    // provenance rather than having it restated in the renderer.
    fetchJson("/api/railways")
      .then((data) => {
        if (cancelled) return;
        onDataRef.current("railways", data || { lines: [] });
      })
      .catch((err) => console.warn("Failed to load railway linework:", err));

    // Seas, gulfs, bays and straits -- marine only (see backend/sources/
    // water_bodies.py and backend/app.py's water_endpoint for why lakes and
    // rivers are not fetched here). Boot-fetched once like railways above,
    // not polled: the backend refreshes this weekly, which is not a cadence
    // worth a client-side timer for. Lakes and rivers are fetched on demand,
    // the first time their own control-panel sub-toggle is switched on -- see
    // setLayerVisible in createMapController.js.
    fetchJson("/api/water?kind=marine")
      .then((data) => {
        if (cancelled) return;
        onDataRef.current("water", data || { type: "FeatureCollection", features: [] });
      })
      .catch((err) => console.warn("Failed to load water bodies:", err));

    fetchJson("/api/infrastructure")
      .then((data) => {
        if (cancelled) return;
        const isLegacyArray = Array.isArray(data);
        // Same reasoning as cableLandings above: a whole-world, one-shot,
        // never-polled fetch (fetch: FETCH_ALWAYS but not in POLL_CONFIG --
        // see this endpoint's own 24h Cache-Control note), so this is the one
        // place its coverage record is ever written -- and again, before
        // either onData call, not after.
        publishFetchOutcome(
          recordCoverageRef.current, onDataRef.current, "infra",
          { status: "fetched", fetchedAt: Date.now(), bbox: null, scoped: false },
          [
            ["infra", (isLegacyArray ? data : data.sites) || []],
            ["pipelines", (isLegacyArray ? [] : data.pipelines) || []],
            // Task 20b: the ten named corridors (backend/infrastructure.py's
            // SHIPPING_LANES), riding the same one-shot payload as sites and
            // pipelines -- a cached response from before this field existed
            // is simply a document with no `lanes` key, same reasoning as
            // the legacy-array guard above.
            ["shippingLanes", (isLegacyArray ? [] : data.lanes) || []],
          ]
        );
      })
      .catch((err) => console.warn("Failed to load infrastructure sites:", err));

    function onVisibilityChange() {
      if (!document.hidden) refetchAllNow();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      timeouts.forEach((clear) => clear());
      tickersRef.current = new Map();
    };
    // Deliberately mount-once: pollers read the live region via
    // currentRegionKeyRef (and the latest onData via onDataRef) rather than
    // being recreated per region change or per App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A gated source's fetch, the moment the reader is deep enough for it to be
  // drawn -- without this it would wait out the rest of its interval (half an
  // hour, for osmInfra) staring at data it is now allowed to have.
  //
  // The guard used to be "has this source ever fetched", which was wrong in a
  // way nothing surfaced: a source fetched once over Sudan and then viewed over
  // Ukraine kept serving Sudan's payload forever, because its region-scoped URL
  // had changed but the guard only asked whether *something* had arrived. It
  // now compares a signature of everything that changes what the answer should
  // be, so a scope change re-ticks and a mere zoom step inside the same scope
  // does not.
  //
  // Debounced by the same 500ms the wind fetch uses: a scroll-wheel zoom
  // crosses several gates in one gesture, and each crossing would otherwise
  // fire its own round of catch-up fetches mid-flick.
  //
  // The same pass also re-ticks the band-paced sources on a band change, which
  // is the other half of intervalByBand: a reader zooming in from world band
  // would otherwise wait out the remainder of a sixty-second timer before the
  // aircraft they came to look at refreshed. Re-invoking the ticker is safe
  // because tick() clears its own pending timer first, so this replaces the
  // slow timer rather than racing it.
  const lastPollBandRef = useRef(null);
  useEffect(() => {
    if (zoom == null) return undefined;
    const timer = setTimeout(() => {
      const band = bandFor(zoom);
      // Null on the very first pass, when the pollers have only just started
      // and re-ticking every one of them would double the boot round-trips.
      const bandChanged = lastPollBandRef.current != null && lastPollBandRef.current !== band;
      lastPollBandRef.current = band;
      for (const src of POLL_CONFIG) {
        const gate = gateFor(src.key);
        // Infinity is "never without an explicit request"; null is "always
        // allowed", which is emphatically not a reason to skip -- focusing a
        // country is what turns a gate into null, and a source on a six-hour
        // interval would otherwise sit on another country's payload until
        // tomorrow.
        if (gate === Infinity) continue;
        if (gate != null && zoom < gate) continue;
        // Before the signature check, not after: the cadence changed even if
        // nothing about the URL did, and that is the whole point of the branch.
        if (src.intervalByBand && bandChanged) {
          tickersRef.current.get(src.key)?.();
          continue;
        }
        if (fetchedScopeRef.current[src.key] === scopeSignatureRef.current(src.key)) continue;
        tickersRef.current.get(src.key)?.();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [zoom, zoomOverrides, focus, bboxCell, gateFor]);

  const selectRegion = useCallback(
    (key) => {
      const entry = key === "world" ? null : regionsRef.current[key];
      const label = entry ? entry.label : "World";
      const newRegionKey = entry ? key : null;
      // Updated synchronously (not just via the state-mirroring assignment
      // above the effect) because refetchAllNow() below runs the pollers'
      // fetches *in this same call stack* -- React doesn't re-render
      // between setCurrentRegionKey and refetchAllNow, so without this the
      // pollers would still read the *previous* region for this round.
      currentRegionKeyRef.current = newRegionKey;
      setCurrentRegionKey(newRegionKey);
      setCurrentRegionLabel(label);
      flyToRegion(key, entry);
      refetchAllNow();
    },
    [flyToRegion, refetchAllNow]
  );

  // Called by the map controller (via useLeafletMap's onRegionAutoReset)
  // when the user pans away from a selected region on their own -- see
  // createMapController.js's moveend handler for why that has to snap back
  // to unscoped data.
  const resetRegionToWorld = useCallback(() => {
    currentRegionKeyRef.current = null; // see the comment in selectRegion
    setCurrentRegionKey(null);
    setCurrentRegionLabel("World");
    refetchAllNow();
  }, [refetchAllNow]);

  return {
    regions,
    currentRegionKey,
    currentRegionLabel,
    selectRegion,
    resetRegionToWorld,
    gdeltRaw,
    eventsRaw,
    officialsRaw,
    escalation,
    conflictHistoryAsOf,
    bootSources,
    // Exposed for useReplay.js: leaving replay mode needs one immediate
    // refetch of every live source instead of waiting out each poller's own
    // interval, same reasoning selectRegion/resetRegionToWorld already rely
    // on above.
    refetchAllNow,
    // Exposed for Admin Mode: re-runs the override transform over the payloads
    // already in hand, so an edit lands on the map as it is typed.
    reapplyTransform,
  };
}
