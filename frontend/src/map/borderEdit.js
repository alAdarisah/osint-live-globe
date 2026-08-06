// Dragging a national boundary with the mouse.
//
// The gestures, and nothing else to learn:
//
//   drag a filled square      move that vertex
//   drag a hollow square      insert a vertex there, and keep dragging it
//   alt-click / right-click   delete that vertex
//
// Undo, escape and persistence belong to the caller (see createMapController's
// border session and useAppSettings' setBorderRings); this module's whole job
// is the geometry under the pointer.
//
// Why the handles are markers in their own pane rather than anything attached
// to the country shapes: the shapes are pointer-events:none by deliberate
// design (style.css, and the 23-line rationale at the top of countryHitTest.js
// -- an interactive full-viewport L.Canvas above the countries pane made every
// country unclickable, and no pane ordering fixes that without breaking marker
// clicks instead). That rule targets an SVG <path>; a marker is a div, in a
// pane above the canvas, and is unaffected. The one thing it costs is the
// "click the line to add a point" gesture -- a path that is not an event target
// can never offer one -- which is why midpoint handles are not merely the
// familiar idiom here but the only route to inserting a vertex at all.
//
// Why a shared vertex moves both countries at once: Natural Earth's 1:110m
// admin-0 set preserves the topology it was generated from, so neighbours hold
// byte-identical coordinates along a common boundary. Editing one side alone
// would tear a visible gap the length of the drag. See buildColocationIndex in
// settings/borderOverrides.js for what that looks like in the actual data.

import { L } from "./leafletGlobal";
import {
  buildColocationIndex,
  cloneGeometry,
  coordKey,
  countryKeyOfFeature,
  geometryFingerprint,
  q,
} from "../settings/borderOverrides";

const EDIT_PANE = "borderEditPane";
// Above markerPane (600) and tooltipPane (650), below popupPane (700) and the
// controls (800). Set explicitly because Leaflet's own .leaflet-pane rule
// defaults every custom pane to 400 -- the same plane as the FIRMS/jamming
// L.canvas click targets, where stacking would come down to DOM order.
const EDIT_PANE_Z = 660;

// A legibility floor, not a performance one. The whole planet is only 10,654
// vertices and the median country is 37; the reason not to draw handles at
// world zoom is that Russia's 625 points sit a pixel or two apart there and
// cannot be hit with a mouse.
const MIN_EDIT_ZOOM = 4;

// Vertex plus midpoint handles. Unreachable for 173 of the 177 countries --
// only Canada (794 vertices), Antarctica (661), Russia (625) and the USA (447)
// can approach it, and only with the whole country on screen.
const MAX_HANDLES = 1200;

// Handles are built for a viewport this much larger than the visible one, so a
// small pan does not have to wait for the rebuild to show its edge.
const BOUNDS_PAD = 0.35;

// Screen-space snap radius. This is the repair path for a boundary whose two
// sides have come apart -- link mode keeps them together in the first place.
const SNAP_PX = 10;

// buildCountryIndex and representativePointOf both skip a ring shorter than
// this, so a country edited below it would vanish from hit-testing and from the
// geometry the outage pins are placed from, with nothing on screen to say why.
const MIN_RING_POINTS = 4;

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

/** A geometry's rings as the nested LatLng arrays L.Polygon.setLatLngs wants. */
function geometryToLatLngs(geometry) {
  const polygons = ringsOf(geometry);
  const converted = polygons.map((rings) =>
    rings.map((ring) => ring.map(([lon, lat]) => L.latLng(lat, lon)))
  );
  // L.GeoJSON builds one L.Polygon per feature either way, but the nesting it
  // expects differs: a Polygon is [ring, ...holes], a MultiPolygon is
  // [[ring, ...holes], ...].
  return geometry.type === "Polygon" ? converted[0] : converted;
}

export function createBorderEditor({
  map,
  getFeatureCollection,
  replaceFeatureCollection,
  getLayerFor,
  onCommit,
  onStateChange,
  onGeometryChanged,
}) {
  if (!map.getPane(EDIT_PANE)) {
    map.createPane(EDIT_PANE).style.zIndex = EDIT_PANE_Z;
  }

  const handleGroup = L.layerGroup([], { pane: EDIT_PANE });

  let session = null;      // see begin()
  let dragActive = false;  // true between dragstart and dragend, exclusively
  let redrawFrame = null;
  let pendingRedraw = new Set();

  // --- geometry helpers, all against the live session -------------------

  function ringAt(countryKey, p, r) {
    const geometry = session?.geometries.get(countryKey);
    if (!geometry) return null;
    return ringsOf(geometry)[p]?.[r] || null;
  }

  /**
   * Write one coordinate into a ring, keeping the ring closed.
   *
   * GeoJSON repeats a ring's first coordinate as its last, and L.Polygon drops
   * that duplicate on the way in (_convertLatLngs pops it) -- so index 0 and
   * index len-1 are the same vertex to a reader and two entries to this array.
   * Writing only one of them leaves a ring that closes to somewhere else.
   */
  function writeVertex(ring, i, lon, lat) {
    ring[i] = [lon, lat];
    if (i === 0) ring[ring.length - 1] = [lon, lat];
  }

  /** Schedule one redraw per animation frame for each country touched. */
  function scheduleRedraw(countryKeys) {
    for (const key of countryKeys) pendingRedraw.add(key);
    if (redrawFrame != null) return;
    // L.Polygon.redraw() rebuilds the whole path's `d` string -- ~800 segments
    // for Canada -- and mousemove fires far faster than the map can repaint.
    // Same reason the country hover hit-test is already rAF-throttled.
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = null;
      for (const key of pendingRedraw) {
        const geometry = session?.geometries.get(key);
        const layer = getLayerFor(key);
        if (geometry && layer) layer.setLatLngs(geometryToLatLngs(geometry));
      }
      pendingRedraw.clear();
    });
  }

  /**
   * Every place this coordinate appears, as {countryKey, p, r, i}.
   *
   * With link mode off it is only the site under the pointer, so a boundary can
   * still be moved one side at a time on purpose.
   */
  function sitesFor(site) {
    if (!session.linkMode) return [site];
    const ring = ringAt(site.countryKey, site.p, site.r);
    if (!ring) return [site];
    const partners = session.colocation.get(coordKey(ring[site.i][0], ring[site.i][1]));
    if (!partners || partners.length < 2) return [site];
    // A neighbour only joins the session at the moment one of its vertices is
    // actually about to move -- so a session on Ukraine does not clone Russia
    // until the drag reaches the border they share.
    return partners.filter((partner) => !!adopt(partner.countryKey));
  }

  // --- the co-location index --------------------------------------------

  // The collection already carries every working geometry (see adopt), so a
  // vertex moved a moment ago is looked up where it is now rather than where it
  // started.
  function rebuildColocation() {
    session.colocation = buildColocationIndex(getFeatureCollection());
  }

  /**
   * Take a country's geometry into the session, as the session's own copy.
   *
   * Cloned all the way down, and installed through a *replaced* collection
   * rather than written back onto the feature in place. Both halves matter:
   * useOsintData keeps the server's payload in fetchedRef and re-derives from
   * it on every revert (which is what makes "put this border back" work at
   * all), and applyBorderOverrides hands that very object straight through by
   * identity whenever there is nothing stored yet -- so on the first edit of a
   * session the collection the map is holding *is* the pristine one. Mutating
   * either the feature or its coordinates would corrupt the copy the revert
   * reads, and the border would spring back to the edit it was meant to undo.
   */
  function adopt(countryKey) {
    if (session.geometries.has(countryKey)) return session.geometries.get(countryKey);
    const fc = getFeatureCollection();
    const index = fc?.features?.findIndex((f) => countryKeyOfFeature(f) === countryKey) ?? -1;
    if (index < 0) return null;
    const feature = fc.features[index];
    if (!feature.geometry) return null;

    // The fingerprint identifies the *source* geometry these ring indices
    // address. For a country that already carries an edit that is not the
    // geometry in hand -- an inserted or deleted vertex changed a ring's
    // length -- so applyBorderOverrides' record of what it drew over wins.
    session.fingerprints.set(
      countryKey,
      feature.__sourceFp ?? geometryFingerprint(feature.geometry)
    );
    const geometry = cloneGeometry(feature.geometry);
    session.geometries.set(countryKey, geometry);

    const features = fc.features.slice();
    features[index] = { ...feature, geometry };
    replaceFeatureCollection({ ...fc, features });
    return geometry;
  }

  // --- handles ----------------------------------------------------------

  function handleIcon(kind) {
    return L.divIcon({
      // An explicit className matters: L.divIcon defaults to "leaflet-div-icon",
      // which leaflet.css paints as a white box with a border.
      className: kind === "ghost" ? "border-handle ghost" : "border-handle",
      iconSize: kind === "ghost" ? [9, 9] : [11, 11],
      iconAnchor: kind === "ghost" ? [4.5, 4.5] : [5.5, 5.5],
    });
  }

  function rebuildHandles() {
    // A rebuild removes the marker whose Draggable is mid-gesture, and
    // Draggable's move/up listeners live on `document` -- the next mousemove
    // would then call setLatLng() on a marker with no _map and throw from
    // inside a document-level handler. moveend fires during a drag more often
    // than it looks: autoPan at the viewport edge, a wheel-zoom, a flyTo from a
    // news item, invalidateSize from the panel toggle.
    if (!session || dragActive) return;

    handleGroup.clearLayers();
    session.sites.clear();

    if (map.getZoom() < MIN_EDIT_ZOOM) {
      report({ tooFarOut: true, shown: 0, total: countVertices(), capped: false });
      return;
    }

    const bounds = map.getBounds().pad(BOUNDS_PAD);
    const geometry = session.geometries.get(session.countryKey);
    const polygons = ringsOf(geometry);
    let shown = 0;
    let total = 0;
    let capped = false;

    for (let p = 0; p < polygons.length; p++) {
      for (let r = 0; r < polygons[p].length; r++) {
        const ring = polygons[p][r];
        if (!Array.isArray(ring) || ring.length < MIN_RING_POINTS) continue;
        // Index len-1 is index 0 written twice; a handle on it would sit
        // exactly under handle 0 and drag the ring open.
        const last = ring.length - 1;
        total += last;

        for (let i = 0; i < last; i++) {
          const [lon, lat] = ring[i];
          if (!bounds.contains(L.latLng(lat, lon))) continue;
          if (shown >= MAX_HANDLES) { capped = true; break; }
          addHandle("vertex", lat, lon, { countryKey: session.countryKey, p, r, i });
          shown++;

          // One ghost per segment, including the closing one from the last
          // real vertex back to index 0.
          const next = ring[(i + 1) % last];
          const midLat = (lat + next[1]) / 2;
          const midLon = (lon + next[0]) / 2;
          if (!bounds.contains(L.latLng(midLat, midLon))) continue;
          if (shown >= MAX_HANDLES) { capped = true; break; }
          addHandle("ghost", midLat, midLon, { countryKey: session.countryKey, p, r, i });
          shown++;
        }
        if (capped) break;
      }
      if (capped) break;
    }

    report({ tooFarOut: false, shown, total, capped });
  }

  function countVertices() {
    let total = 0;
    for (const rings of ringsOf(session?.geometries.get(session?.countryKey))) {
      for (const ring of rings) if (ring.length >= MIN_RING_POINTS) total += ring.length - 1;
    }
    return total;
  }

  function addHandle(kind, lat, lon, site) {
    const marker = L.marker(L.latLng(lat, lon), {
      draggable: true,
      // 1,200 handles would otherwise be 1,200 tab stops between the map and
      // anything after it.
      keyboard: false,
      // Dragging toward the edge pans the map, which is how you move a vertex
      // further than one screen. Safe because rebuildHandles refuses to run
      // while a drag is live.
      autoPan: true,
      pane: EDIT_PANE,
      icon: handleIcon(kind),
      // Handles belong to whatever is being edited, not to a z-order race with
      // the country underneath.
      zIndexOffset: 1000,
    });
    marker.on("dragstart", () => onDragStart(marker, kind));
    marker.on("drag", () => onDrag(marker));
    marker.on("dragend", () => onDragEnd(marker));
    if (kind === "vertex") {
      marker.on("click", (event) => {
        // Alt-click is the primary delete: it works on every platform, needs no
        // native-menu suppression, and leaves the plain click free.
        if (event.originalEvent?.altKey) {
          L.DomEvent.stop(event.originalEvent);
          deleteVertex(marker);
        }
      });
      marker.on("contextmenu", (event) => {
        // Leaflet fires contextmenu on the marker but does not preventDefault,
        // so without this the browser menu opens over the deletion.
        L.DomEvent.preventDefault(event.originalEvent);
        L.DomEvent.stopPropagation(event.originalEvent);
        deleteVertex(marker);
      });
    }
    session.sites.set(L.Util.stamp(marker), { ...site, kind });
    handleGroup.addLayer(marker);
  }

  // --- the drag itself ---------------------------------------------------

  function onDragStart(marker, kind) {
    dragActive = true;
    const site = session.sites.get(L.Util.stamp(marker));
    if (!site) return;

    if (kind === "ghost") {
      // A ghost becomes real the moment it is dragged: splice a vertex in after
      // the segment's start, then carry on as an ordinary vertex drag. The
      // marker is re-targeted in place rather than through a rebuild, because a
      // rebuild here is exactly the mid-gesture teardown rebuildHandles refuses
      // to do.
      const inserted = insertVertexAt(site, marker.getLatLng());
      if (!inserted) { dragActive = false; return; }
      session.sites.set(L.Util.stamp(marker), { ...inserted.site, kind: "vertex" });
      // Restyled by hand rather than through marker.setIcon(). setIcon re-runs
      // _initIcon, which re-runs _initInteraction, which disables the marker's
      // MarkerDrag and builds a new one -- and disabling a Draggable that is
      // mid-gesture calls finishDrag, firing `dragend` synchronously from
      // inside this `dragstart` and leaving the pointer attached to listeners
      // that have just been removed. The vertex would appear and then refuse to
      // be dragged. Only the class differs between the two icons anyway.
      const el = marker.getElement();
      if (el) {
        el.classList.remove("ghost");
        el.style.width = el.style.height = "11px";
        el.style.marginLeft = el.style.marginTop = "-5.5px";
      }
      session.drag = {
        sites: inserted.sites,
        touched: new Set(inserted.sites.map((s) => s.countryKey)),
        snapTargets: collectSnapTargets(inserted.sites),
      };
      return;
    }

    const sites = sitesFor(site);
    // Snapshot every ring about to move before touching any of them, so one
    // undo step is one gesture.
    pushUndo(sites);
    session.drag = {
      sites,
      touched: new Set(sites.map((s) => s.countryKey)),
      snapTargets: collectSnapTargets(sites),
    };
  }

  function onDrag(marker) {
    if (!session?.drag) return;
    const latlng = snapped(marker.getLatLng());
    if (latlng !== marker.getLatLng()) marker.setLatLng(latlng);

    for (const site of session.drag.sites) {
      const ring = ringAt(site.countryKey, site.p, site.r);
      if (ring) writeVertex(ring, site.i, latlng.lng, latlng.lat);
    }
    scheduleRedraw(session.drag.touched);
  }

  function onDragEnd(marker) {
    dragActive = false;
    if (!session?.drag) { rebuildHandles(); return; }

    // Quantize once, at rest, onto the same lattice everything else is keyed
    // on -- a coordinate left at full float precision would stop matching its
    // neighbour's and the two sides would come apart on the next drag.
    const latlng = marker.getLatLng();
    const lon = q(latlng.lng);
    const lat = q(latlng.lat);
    for (const site of session.drag.sites) {
      const ring = ringAt(site.countryKey, site.p, site.r);
      if (ring) writeVertex(ring, site.i, lon, lat);
    }

    const touched = session.drag.sites;
    session.drag = null;
    commit(touched);
    scheduleRedraw(new Set(touched.map((s) => s.countryKey)));
    // A moved vertex moved both of its midpoints, and an inserted one added
    // two more.
    rebuildColocation();
    rebuildHandles();
  }

  /**
   * The dragged position, pulled onto a nearby vertex belonging to something
   * else if there is one within SNAP_PX.
   *
   * Deliberately excludes the sites currently being dragged (a vertex would
   * otherwise snap to its own linked partner, which is already exactly where it
   * is) and the country's own other vertices, so the gesture this serves is
   * "put this back on the boundary it came off".
   */
  function snapped(latlng) {
    const candidates = session.drag?.snapTargets;
    if (!candidates?.length) return latlng;
    const origin = map.latLngToContainerPoint(latlng);
    let best = null;
    let bestDistance = SNAP_PX;
    for (const point of candidates) {
      const distance = origin.distanceTo(map.latLngToContainerPoint(point));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = point;
      }
    }
    return best || latlng;
  }

  /**
   * The coordinates a drag is allowed to snap onto, resolved once when it
   * starts.
   *
   * Filtered here rather than per mousemove because the index holds ~7,500
   * coordinates and a drag fires far more move events than a frame can hold --
   * scanning the world each time would cost more than the gesture is worth.
   * Restricted to the visible viewport (a snap target off screen is not a thing
   * anyone is aiming at) and excluding the vertex being dragged along with
   * everything linked to it, which is already exactly where it is.
   */
  function collectSnapTargets(sites) {
    const dragging = new Set(sites.map((s) => `${s.countryKey}:${s.p}:${s.r}:${s.i}`));
    const bounds = map.getBounds();
    const targets = [];
    for (const [key, owners] of session.colocation) {
      if (owners.every((s) => dragging.has(`${s.countryKey}:${s.p}:${s.r}:${s.i}`))) continue;
      const comma = key.indexOf(",");
      const point = L.latLng(Number(key.slice(comma + 1)), Number(key.slice(0, comma)));
      if (bounds.contains(point)) targets.push(point);
    }
    return targets;
  }

  // --- insert and delete -------------------------------------------------

  /**
   * A new vertex after index i of a ring.
   *
   * Where both ends of the segment are shared with the same neighbour, the
   * neighbour's matching segment is split too -- otherwise adding detail to a
   * shared land border would put a bend in one side of it and leave the other
   * straight. Where they are not (a coastline, or a segment whose ends belong
   * to different countries) the vertex is genuinely new and has no partner.
   */
  function insertVertexAt(site, latlng) {
    const ring = ringAt(site.countryKey, site.p, site.r);
    if (!ring) return null;
    const lon = q(latlng.lng);
    const lat = q(latlng.lat);

    const partners = session.linkMode ? sharedSegmentPartners(site) : [];
    pushUndo([site, ...partners]);

    ring.splice(site.i + 1, 0, [lon, lat]);
    for (const partner of partners) {
      const other = ringAt(partner.countryKey, partner.p, partner.r);
      if (other) other.splice(partner.i + 1, 0, [lon, lat]);
    }

    // The new vertex sits one place further along than the segment's start, in
    // this country and in every neighbour split alongside it. Both ends of it
    // then drag together, which is the whole point of having split them.
    const sites = [{ ...site, i: site.i + 1 }, ...partners.map((p) => ({ ...p, i: p.i + 1 }))];
    // Every index after the splice has shifted.
    rebuildColocation();
    commit(sites);
    return { site: sites[0], sites };
  }

  /**
   * The other countries whose ring contains this exact segment, in either
   * direction -- a shared boundary is walked clockwise by one side and
   * anticlockwise by the other.
   */
  function sharedSegmentPartners(site) {
    const ring = ringAt(site.countryKey, site.p, site.r);
    if (!ring) return [];
    const last = ring.length - 1;
    const a = coordKey(ring[site.i][0], ring[site.i][1]);
    const b = coordKey(ring[(site.i + 1) % last][0], ring[(site.i + 1) % last][1]);

    const out = [];
    for (const candidate of session.colocation.get(a) || []) {
      if (candidate.countryKey === site.countryKey && candidate.p === site.p && candidate.r === site.r) continue;
      const other = ringAt(candidate.countryKey, candidate.p, candidate.r) || ringFromFeature(candidate);
      if (!other) continue;
      const otherLast = other.length - 1;
      const next = coordKey(other[(candidate.i + 1) % otherLast][0], other[(candidate.i + 1) % otherLast][1]);
      const previous = coordKey(
        other[(candidate.i - 1 + otherLast) % otherLast][0],
        other[(candidate.i - 1 + otherLast) % otherLast][1]
      );
      // Same direction: insert after the matched index. Opposite direction: the
      // segment runs backwards, so the new point goes after the *other* end.
      if (next === b) out.push({ ...candidate });
      else if (previous === b) out.push({ ...candidate, i: (candidate.i - 1 + otherLast) % otherLast });
    }
    // Only now, once we know which neighbours are actually involved, are their
    // geometries taken into the session.
    return out.filter((partner) => !!adopt(partner.countryKey));
  }

  function ringFromFeature(site) {
    const fc = getFeatureCollection();
    const feature = fc?.features?.find((f) => countryKeyOfFeature(f) === site.countryKey);
    return ringsOf(feature?.geometry)[site.p]?.[site.r] || null;
  }

  function deleteVertex(marker) {
    const site = session.sites.get(L.Util.stamp(marker));
    if (!site) return;
    const ring = ringAt(site.countryKey, site.p, site.r);
    if (!ring) return;

    const sites = sitesFor(site);
    // The floor is what keeps a country a shape. Refusing loudly beats
    // producing a ring that silently drops out of the hit-test index.
    for (const each of sites) {
      const target = ringAt(each.countryKey, each.p, each.r);
      if (target && target.length - 1 < MIN_RING_POINTS) {
        report({ notice: `That is the last of ${each.countryKey}'s shape -- a ring needs at least ${MIN_RING_POINTS} points.` });
        return;
      }
    }

    pushUndo(sites);
    for (const each of sites) {
      const target = ringAt(each.countryKey, each.p, each.r);
      if (!target) continue;
      target.splice(each.i, 1);
      // Removing index 0 promotes index 1, which must now also be the ring's
      // closing coordinate.
      if (each.i === 0) target[target.length - 1] = [target[0][0], target[0][1]];
    }

    commit(sites);
    scheduleRedraw(new Set(sites.map((s) => s.countryKey)));
    rebuildColocation();
    rebuildHandles();
  }

  // --- committing and undo ------------------------------------------------

  /** Hand the rings these sites live in up to the caller, to be persisted. */
  function commit(sites) {
    const seen = new Set();
    const commits = [];
    for (const site of sites) {
      const id = `${site.countryKey}:${site.p}:${site.r}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const ring = ringAt(site.countryKey, site.p, site.r);
      if (!ring) continue;
      commits.push({
        countryKey: site.countryKey,
        fp: session.fingerprints.get(site.countryKey) || null,
        polygonIndex: site.p,
        ringIndex: site.r,
        ring: ring.map(([lon, lat]) => [lon, lat]),
      });
      onGeometryChanged?.(site.countryKey);
    }
    if (commits.length) onCommit?.(commits);
  }

  /** One entry per gesture, holding every ring it is about to change. */
  function pushUndo(sites) {
    const seen = new Set();
    const snapshot = [];
    for (const site of sites) {
      const id = `${site.countryKey}:${site.p}:${site.r}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const ring = ringAt(site.countryKey, site.p, site.r);
      if (ring) {
        snapshot.push({
          countryKey: site.countryKey,
          p: site.p,
          r: site.r,
          ring: ring.map(([lon, lat]) => [lon, lat]),
        });
      }
    }
    if (snapshot.length) session.undo.push(snapshot);
  }

  function undo() {
    if (!session?.undo.length) return false;
    const snapshot = session.undo.pop();
    const touched = new Set();
    const sites = [];
    for (const entry of snapshot) {
      const geometry = session.geometries.get(entry.countryKey);
      const polygons = ringsOf(geometry);
      if (!polygons[entry.p]?.[entry.r]) continue;
      polygons[entry.p][entry.r] = entry.ring.map(([lon, lat]) => [lon, lat]);
      touched.add(entry.countryKey);
      sites.push({ countryKey: entry.countryKey, p: entry.p, r: entry.r, i: 0 });
    }
    commit(sites);
    scheduleRedraw(touched);
    rebuildColocation();
    rebuildHandles();
    return true;
  }

  // --- session lifecycle --------------------------------------------------

  function report(extra) {
    onStateChange?.({
      active: !!session,
      countryKey: session?.countryKey ?? null,
      linkMode: session?.linkMode ?? true,
      canUndo: !!session?.undo.length,
      minZoom: MIN_EDIT_ZOOM,
      ...extra,
    });
  }

  function begin(countryKey, { linkMode = true } = {}) {
    if (session) return false;
    const fc = getFeatureCollection();
    if (!fc?.features?.length) return false;

    session = {
      countryKey,
      linkMode,
      geometries: new Map(),
      fingerprints: new Map(),
      sites: new Map(),
      colocation: new Map(),
      undo: [],
      drag: null,
    };
    if (!adopt(countryKey)) {
      session = null;
      return false;
    }

    rebuildColocation();
    handleGroup.addTo(map);
    map.on("moveend zoomend", rebuildHandles);
    rebuildHandles();
    return true;
  }

  function end() {
    if (!session) return;
    map.off("moveend zoomend", rebuildHandles);
    handleGroup.clearLayers();
    handleGroup.remove();
    if (redrawFrame != null) {
      cancelAnimationFrame(redrawFrame);
      redrawFrame = null;
    }
    pendingRedraw.clear();
    dragActive = false;
    session = null;
    report({});
  }

  return {
    begin,
    end,
    undo,
    rebuildHandles,
    isActive: () => !!session,
    activeKey: () => session?.countryKey ?? null,
    setLinkMode(on) {
      if (!session) return;
      session.linkMode = !!on;
      report({});
    },
    destroy() {
      end();
      const pane = map.getPane(EDIT_PANE);
      if (pane?.parentNode) pane.parentNode.removeChild(pane);
    },
  };
}
