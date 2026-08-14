// GPU-batched sprite rendering for AIS/ADS-B markers -- the one marker type
// in the app not already canvas-batched (FIRMS/jamming use L.canvas()+
// L.heatLayer; see layers.js), and the actual source of observed pan/zoom
// jank with many ships/aircraft on screen. Everything else (satellites,
// infra, countries, FIRMS, jamming, trails, popups, replay, region-fly)
// stays on plain Leaflet rendering, untouched.
//
// Deliberately hand-rolled rather than built on leaflet-pixi-overlay: that
// bridge library is a UMD build expecting either a CDN global `window.L`
// (the pattern index.html already uses for leaflet.heat/markercluster/
// velocity) or an npm-resolved `leaflet` module -- and npm-installing it
// here would pull in leaflet-pixi-overlay's own transitive copy of Leaflet,
// which would attach `.pixiOverlay` to *that* copy's `L`, not the shared
// `window.L` every other layer in this app already depends on (see
// leafletGlobal.js). pixi.js itself has zero Leaflet coupling, so it's safe
// to npm-import directly; this module extends L.Layer by hand instead, the
// same primitive every other custom layer in layers.js is already built
// from, and gets full control over hit-testing as a side benefit (needed
// for click-to-select/hover anyway).
import { L } from "./leafletGlobal";
import { nearestLon, worldCopyOffsets, worldCopyKey } from "../utils/geo";

// Pixi is loaded on demand rather than bundled into the main chunk: it is by
// far the heaviest dependency here (~13 MB installed, and the dominant share
// of the built bundle), yet nothing it draws exists until AIS/ADS-B data has
// actually arrived. Keeping it out of the initial chunk means the map, panel
// and basemap parse and paint without waiting on a renderer that has nothing
// to render yet; Vite emits it as a separate chunk automatically.
//
// Every module-level use of PIXI below sits inside a function body, so a
// mutable binding filled in after the import resolves is all that's needed --
// the L.Layer subclass itself can still be declared eagerly.
let PIXI = null;
let pixiPromise = null;

function loadPixi() {
  if (!pixiPromise) {
    pixiPromise = import("pixi.js").then((mod) => {
      PIXI = mod;
      return mod;
    });
  }
  return pixiPromise;
}

// Rasterizes an SVG glyph (from svgIcons.js's SVG dict, `currentColor` swapped
// for a real hex value) into a PIXI.Texture once per distinct (name, color,
// size) combination -- shared across every sprite that uses it, which is
// what makes thousands of sprites a handful of GPU-batched draw calls
// instead of thousands of individual ones. ~14 total combinations across
// ship/aircraft styles (see decorators.js's SHIP_STYLE/AIRCRAFT_STYLE), not
// one per live entity.
const SUPERSAMPLE = 3;

// Minimum half-size of a sprite's tap target, regardless of how small the
// sprite itself is drawn -- a 13px "other aircraft" icon is a ~6px radius
// target, far below the ~44px finger-friendly minimum, and was effectively
// untappable on a phone.
const TOUCH_SLOP_PX = 11; // rasterize above the on-screen size so icons stay crisp when zoomed

function loadTexture(svgInner, color, size) {
  const px = Math.round(size * SUPERSAMPLE);
  const filled = svgInner.replace(/currentColor/g, color);
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${px}" height="${px}">${filled}</svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      canvas.getContext("2d").drawImage(img, 0, 0, px, px);
      resolve(PIXI.Texture.from(canvas));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

class TextureCache {
  constructor() {
    this._textures = new Map(); // key -> PIXI.Texture (once loaded)
    this._pending = new Map(); // key -> Promise, so the same style is never rasterized twice
  }

  // Fire-and-forget: kicks off rasterization if not already cached/pending,
  // and calls onReady() once it resolves so callers can trigger a redraw.
  // get() itself is synchronous and returns undefined until ready -- sprites
  // just render one frame later once the (small, one-time) rasterization
  // completes, not per-entity or per-frame.
  ensure(style, onReady) {
    const key = `${style.name}|${style.color}|${style.size}`;
    if (this._textures.has(key) || this._pending.has(key)) return key;
    const promise = loadTexture(style.svg, style.color, style.size).then((texture) => {
      this._textures.set(key, texture);
      this._pending.delete(key);
      onReady?.();
    });
    this._pending.set(key, promise);
    return key;
  }

  get(style) {
    const key = `${style.name}|${style.color}|${style.size}`;
    return this._textures.get(key);
  }

  destroy() {
    for (const texture of this._textures.values()) texture.destroy(true);
    this._textures.clear();
    this._pending.clear();
  }
}

// One entry per live entity: a Container so the highlight ring (drawn
// underneath, only visible while selected) doesn't rotate along with the
// glyph sprite itself.
function createEntry(app) {
  const container = new PIXI.Container();
  const highlight = new PIXI.Graphics();
  highlight.visible = false;
  const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
  sprite.anchor.set(0.5);
  // No eventMode/cursor: Pixi's EventSystem never receives anything, since
  // the canvas is pointer-events:none (see onAdd) -- hit-testing and cursor
  // are handled from the map container instead.
  container.addChild(highlight, sprite);
  app.stage.addChild(container);
  return { container, highlight, sprite, size: 0 };
}

function drawHighlight(entry, size, color) {
  const g = entry.highlight;
  g.clear();
  g.lineStyle(2, color, 0.9);
  g.drawCircle(0, 0, size * 0.72);
}

const EntityWebglLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    const size = map.getSize();

    // `leaflet-zoom-animated` is not decoration: that class carries
    // `transform-origin: 0 0` (leaflet.css) and the `transform` transition that
    // makes an overlay glide with the basemap during a zoom gesture. Without
    // it the canvas falls back to the browser default origin of `50% 50%`,
    // while _onAnimZoom below computes its offset with maths that assumes
    // 0 0 -- so every sprite was displaced by (1 - scale) * (width/2, height/2),
    // i.e. 640x360 px on a single zoom-in of a 1280x720 map, and snapped
    // instantly instead of animating. That was the "planes and ships move
    // when zooming" bug.
    this._canvas = L.DomUtil.create("canvas", "leaflet-webgl-entity-layer leaflet-zoom-animated");
    this._canvas.style.position = "absolute";
    // Permanently click-through. The canvas is always sized to the FULL map
    // viewport (see _reset below), so any other value puts it in front of
    // every pixel -- including the vast majority with no sprite on them --
    // and swallows clicks meant for whatever is underneath (country shapes,
    // the map's own background-click deselect). Nothing about the gesture
    // can be re-routed once the browser has hit-tested it, so the canvas
    // must never be an event target in the first place; all sprite
    // interaction is done by our own hit-testing on the map container
    // instead (see _onContainerClick/_onContainerMove below), which is also
    // why Pixi's own EventSystem is unused here.
    this._canvas.style.pointerEvents = "none";
    this.getPane().appendChild(this._canvas);

    // Capture phase on the map *container*: this fires before any country
    // path's own handler and before Leaflet's own bubble-phase container
    // click handler, so a sprite hit can stopPropagation() and take the
    // gesture, while a miss propagates on to the country/map completely
    // untouched. Works identically for mouse and touch, since a tap
    // synthesizes a click.
    this._container = map.getContainer();
    this._onContainerClick = this._onContainerClick.bind(this);
    this._onContainerMove = this._onContainerMove.bind(this);
    this._container.addEventListener("click", this._onContainerClick, { capture: true });
    this._container.addEventListener("mousemove", this._onContainerMove);

    this._app = new PIXI.Application({
      view: this._canvas,
      width: size.x,
      height: size.y,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });

    // Draw order is by container.zIndex (set per sprite in updateEntities from
    // its icon size) rather than by insertion order, so a small sprite is never
    // stuck permanently behind a large one it happens to overlap.
    this._app.stage.sortableChildren = true;

    this._textureCache = new TextureCache();
    this._buckets = new Map(); // bucketKey -> Map(entityId -> entry)
    this._visibleBuckets = new Set();
    this._topLeft = L.point(0, 0);
    this._redrawScheduled = false;
    // Hover hit-test throttle state -- see _onContainerMove.
    this._moveFrame = null;
    this._pendingMove = null;
    // Per-bucket dimming, so a newly created sprite inherits whatever emphasis
    // is already in force rather than appearing at full opacity in a view that
    // has receded around it. See setBucketAlpha.
    this._bucketAlpha = new Map();
    // Sprites created before their style's texture finished rasterizing --
    // ensure()'s onReady only fires once per distinct style (see TextureCache
    // above), so without this, a sprite built during that brief loading
    // window would stay an invisible 1x1 placeholder until the *next* full
    // updateEntities call for its bucket ever touched it again (fine at the
    // normal 10-60s poll cadence, but a real bug: nothing else fixes it up
    // in between). Keyed by the same texture cache key as TextureCache uses.
    this._pendingSprites = new Map(); // styleKey -> Set(entry)

    this._reset = this._reset.bind(this);
    this._onAnimZoom = this._onAnimZoom.bind(this);
    map.on("moveend resize", this._reset);
    // Without this, the canvas stays static (unscaled) for the whole
    // duration of a pinch/scroll-wheel zoom animation while the basemap
    // tiles scale smoothly underneath -- sprites visually "swim" apart
    // from the map instead of zooming with it, only snapping to their
    // correct spot once the animation finishes and moveend's _reset()
    // runs. This mirrors the CSS-transform-during-gesture technique
    // Leaflet's own L.Renderer (the base of L.Canvas/L.SVG) uses.
    map.on("zoomanim", this._onAnimZoom);
    this._reset();
    if (import.meta.env.DEV) window.__webglLayerDebug = this;
  },

  _applyStyle(entry, style) {
    // An entity can leave the viewport (and have its sprite destroyed, see
    // updateEntities' sweep) while it is still queued in _pendingSprites
    // waiting for its texture to rasterize. Setting .width on a destroyed
    // Pixi sprite reads through a nulled .scale and throws inside the
    // texture-ready promise -- an unhandled rejection in the console, and the
    // rest of that batch's sprites never get their texture.
    if (!entry.sprite || entry.sprite.destroyed) return;
    const key = `${style.name}|${style.color}|${style.size}`;
    const texture = this._textureCache.get(style);
    if (texture) {
      entry.sprite.visible = true;
      entry.sprite.texture = texture;
      entry.sprite.width = style.size;
      entry.sprite.height = style.size;
      return;
    }
    entry.sprite.visible = false;
    let waiting = this._pendingSprites.get(key);
    if (!waiting) {
      waiting = new Set();
      this._pendingSprites.set(key, waiting);
      this._textureCache.ensure(style, () => {
        for (const pendingEntry of waiting) this._applyStyle(pendingEntry, style);
        waiting.clear();
        this._scheduleRender();
      });
    }
    waiting.add(entry);
  },

  onRemove() {
    this._map.off("moveend resize", this._reset);
    this._map.off("zoomanim", this._onAnimZoom);
    this._container.removeEventListener("click", this._onContainerClick, { capture: true });
    this._container.removeEventListener("mousemove", this._onContainerMove);
    // A queued hover frame outlives the listener that queued it, and it would
    // run against a destroyed Pixi app.
    if (this._moveFrame != null) {
      cancelAnimationFrame(this._moveFrame);
      this._moveFrame = null;
    }
    this._pendingMove = null;
    this._hideTooltip();
    this._textureCache.destroy();
    // `true` tears down the WebGL context along with the view -- without
    // this, React StrictMode's dev-only mount->unmount->remount cycle (see
    // useLeafletMap.js's mount-once effect / createMapController's destroy())
    // leaks one WebGL context per remount until the browser's hard per-page
    // context limit is hit.
    this._app.destroy(true, { children: true, texture: true, baseTexture: true });
    L.DomUtil.remove(this._canvas);
    this._app = null;
    this._buckets.clear();
  },

  getEvents() {
    return {};
  },

  _reset() {
    const map = this._map;
    // Pixi loads asynchronously (see createEntityWebglLayer's dynamic import),
    // so onAdd -- and therefore this -- can run after the controller has
    // already torn the map down: Leaflet deletes layer._map on removal, and
    // this used to throw "Cannot read properties of null (reading
    // 'containerPointToLayerPoint')" into the console on every such teardown.
    // Nothing to reposition when there is no map; the next onAdd does it.
    if (!map || !this._app) return;
    const size = map.getSize();
    if (this._canvas.width !== size.x || this._canvas.height !== size.y) {
      this._app.renderer.resize(size.x, size.y);
    }
    this._topLeft = map.containerPointToLayerPoint([0, 0]);
    // setPosition alone (no scale) is also what clears any leftover
    // zoom-animation transform from _onAnimZoom below once the gesture ends.
    L.DomUtil.setPosition(this._canvas, this._topLeft);
    this._repositionAll();
    // Reference point _onAnimZoom scales/translates relative to during the
    // *next* zoom gesture -- must be refreshed on every real reposition.
    this._animZoom = map.getZoom();
    this._animCenter = map.getCenter();
    // Every sprite just moved under a pointer that did not, and a wheel-zoom or
    // a keyboard pan emits no mousemove to correct it -- so without this the
    // tooltip stays open, at the pane pixel it was written to before the
    // reprojection, naming a ship that is no longer anywhere near the cursor
    // (and the cursor stays `pointer` over open water). Re-answered rather than
    // just hidden, so a tooltip that is still legitimately under the pointer
    // survives the zoom instead of blinking out.
    if (this._pendingMove) this._resolveHoverAt(this._pendingMove.x, this._pendingMove.y);
  },

  // Cheap bounding-box test against currently visible sprites (a handful to
  // a few hundred, never the whole raw dataset -- buckets only ever hold
  // what's already been bounds/zoom-filtered), returning the *nearest* hit
  // so overlapping sprites resolve to the one actually aimed at rather than
  // whichever bucket happened to be iterated first. Touch targets get a
  // floor of TOUCH_SLOP_PX so a small sprite is still tappable on a phone.
  // Returns {entry, opts} or null.
  _hitTestAt(clientX, clientY) {
    // Divided by the canvas's live CSS scale, not just offset by its position.
    // For the ~250ms of every zoom gesture _onAnimZoom below CSS-scales this
    // canvas to track the basemap, so its bounding rect is in *screen* pixels
    // while entry.container.position is in unscaled canvas pixels. Subtracting
    // the rect alone mixes the two: on a single wheel step (scale 2) a click at
    // the centre of a 1200px viewport hit-tested 600px away from where the
    // reader was pointing, and at the far edge a full viewport away -- which is
    // what made a click or hover during a zoom land on an unrelated ship or
    // aircraft. getScale is Leaflet's own helper for this (rect.width /
    // offsetWidth, falling back to 1 when the element has no layout), so at rest
    // this is exactly the old arithmetic.
    const { x: scaleX, y: scaleY, boundingClientRect: rect } = L.DomUtil.getScale(this._canvas);
    const x = (clientX - rect.left) / scaleX;
    const y = (clientY - rect.top) / scaleY;
    let best = null;
    let bestDist = Infinity;
    for (const [bucketKey, entries] of this._buckets) {
      if (!this._visibleBuckets.has(bucketKey)) continue;
      const opts = this._optsByBucket?.get(bucketKey);
      if (!opts) continue;
      for (const entry of entries.values()) {
        if (!entry.container.visible || !entry.sprite.visible) continue;
        const half = Math.max((entry.sprite.width || 16) / 2, TOUCH_SLOP_PX);
        const dx = x - entry.container.position.x;
        const dy = y - entry.container.position.y;
        if (Math.abs(dx) > half || Math.abs(dy) > half) continue;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = { entry, opts };
        }
      }
    }
    return best;
  },

  // Capture phase on the map container (see onAdd). A hit takes the gesture
  // entirely -- stopPropagation here means neither the country path beneath
  // nor Leaflet's own bubble-phase container click handler ever sees it, so
  // tapping a plane can't also select the country under it. A miss does
  // nothing at all, leaving the event to propagate exactly as it would if
  // this layer didn't exist.
  _onContainerClick(e) {
    // Never steal a click that genuinely landed on a real DOM marker
    // (infra/satellite/event pins, an open popup, a zoom control) -- those
    // sit in panes above this canvas and own their own clicks. Country
    // shapes are deliberately NOT excluded here: they're the case sprites
    // *should* win over, since they cover whole landmasses.
    if (e.target.closest?.(".leaflet-marker-icon, .leaflet-popup, .leaflet-control")) return;
    const hit = this._hitTestAt(e.clientX, e.clientY);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    this._hideTooltip();
    hit.opts.onSelect(hit.entry.item);
  },

  // rAF-throttled, because _hitTestAt is a linear scan over every visible
  // sprite in all six buckets and a mousemove fires far faster than the screen
  // refreshes -- so sweeping the pointer across a busy sea used to run the
  // whole scan hundreds of times per second to produce, at most, sixty distinct
  // tooltips. The pointer position is stashed and the newest one wins, which is
  // the same pattern the country hover uses in createMapController.js.
  //
  // Click is deliberately left unthrottled: a click has to hit-test against the
  // position the reader actually clicked, not the last one a frame happened to
  // sample.
  _onContainerMove(e) {
    this._pendingMove = { x: e.clientX, y: e.clientY };
    if (this._moveFrame != null) return;
    this._moveFrame = requestAnimationFrame(() => {
      this._moveFrame = null;
      const at = this._pendingMove;
      // onRemove can land between the frame being queued and it running.
      if (!at || !this._app) return;
      this._resolveHoverAt(at.x, at.y);
    });
  },

  // What the tooltip and the cursor should say for a pointer at this client
  // position. Shared with _reset above, which has to re-answer the same question
  // after a reprojection has moved every sprite out from under a stationary
  // pointer.
  _resolveHoverAt(clientX, clientY) {
    const hit = this._hitTestAt(clientX, clientY);
    if (hit) {
      this._showTooltip(hit.entry, hit.opts.getTooltip(hit.entry.item));
      this._container.style.cursor = "pointer";
    } else {
      this._hideTooltip();
      this._container.style.cursor = "";
    }
  },

  // Same technique L.Renderer._onAnimZoom/L.GridLayer._animateZoom use:
  // CSS-transform the whole canvas to approximate the in-progress zoom
  // level so it visually tracks the basemap during the animation, then let
  // the moveend-triggered _reset() above snap it back to an exact,
  // untransformed reprojection once the gesture settles.
  _onAnimZoom(e) {
    const map = this._map;
    if (!map || !this._canvas) return; // same teardown race as _reset above
    const scale = map.getZoomScale(e.zoom, this._animZoom);
    const position = L.DomUtil.getPosition(this._canvas);
    const viewHalf = map.getSize().multiplyBy(0.5);
    const currentCenterPoint = map.project(this._animCenter, e.zoom);
    const destCenterPoint = map.project(e.center, e.zoom);
    const centerOffset = destCenterPoint.subtract(currentCenterPoint);
    const topLeftOffset = viewHalf.multiplyBy(-scale).add(position).add(viewHalf).subtract(centerOffset);
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  },

  // The stored longitude is shifted onto the copy of the world the camera is
  // looking at before it is projected. Without it every sprite drew in the
  // primary copy only, so panning east past the antimeridian left the ships and
  // aircraft behind on the previous world while the basemap carried on -- the
  // "empty map" either side. See nearestLon in utils/geo.js.
  // `copy` (a multiple of 360, see _copyOffsets) then moves it on again to a
  // neighbouring copy, which is how one entity becomes one sprite per copy of the
  // world on screen instead of stopping dead at the edge of the primary one.
  _project(lat, lon, copy = 0) {
    const refLon = this._map.getCenter().lng;
    const p = this._map.latLngToLayerPoint([lat, nearestLon(lon, refLon) + copy]);
    return { x: p.x - this._topLeft.x, y: p.y - this._topLeft.y };
  },

  /**
   * Which copies of the world are on screen. See worldCopyOffsets in utils/geo.js.
   *
   * Read once per updateEntities/_repositionAll pass rather than per entity:
   * getBounds and getCenter are both live reads off the map and these loops run
   * over every ship and aircraft in view.
   */
  _copyOffsets() {
    const bounds = this._map.getBounds();
    return worldCopyOffsets(bounds.getWest(), bounds.getEast(), this._map.getCenter().lng);
  },

  // One key format for the whole map, shared with the Leaflet marker layers --
  // see worldCopyKey in utils/geo.js.
  _entryKey(id, copy) {
    return worldCopyKey(id, copy);
  },

  // Declutter offsets come from createMapController's single cross-layer
  // placement pass (see declutter.js) rather than being computed per bucket
  // here -- the previous per-bucket version could not see that a tanker and a
  // navy ship, or a ship and a conflict pin, were landing on the same pixel.
  _offsetFor(bucketKey, item) {
    return this._offsetsByBucket?.get(bucketKey)?.get(this._idOf(bucketKey, item));
  },

  // The declutter nudge is looked up on the bare id, so every copy of an entity
  // gets the same one and the copies stay identical to each other rather than
  // drifting apart under a per-copy placement pass.
  _placeEntry(entry, bucketKey, item, copy = 0) {
    const p = this._project(item.lat, item.lon, copy);
    const off = this._offsetFor(bucketKey, item);
    entry.container.position.set(p.x + (off?.dx || 0), p.y + (off?.dy || 0));
  },

  _repositionAll() {
    const offsets = this._copyOffsets();
    for (const [bucketKey, entries] of this._buckets) {
      const items = this._lastItems?.get(bucketKey);
      if (!items) continue;
      for (const item of items) {
        const id = this._idOf(bucketKey, item);
        for (const copy of offsets) {
          const entry = entries.get(this._entryKey(id, copy));
          // A copy can be missing here: this runs on every pan, and a pan that
          // brings a new copy into view has not reached updateEntities yet. The
          // moveend that follows creates it.
          if (entry) this._placeEntry(entry, bucketKey, item, copy);
        }
      }
    }
  },

  _idOf(bucketKey, item) {
    return this._idFieldByBucket?.get(bucketKey)?.(item);
  },

  _scheduleRender() {
    if (this._redrawScheduled) return;
    this._redrawScheduled = true;
    requestAnimationFrame(() => {
      this._redrawScheduled = false;
      if (this._app) this._app.renderer.render(this._app.stage);
    });
  },

  setVisible(bucketKey, visible) {
    if (visible) this._visibleBuckets.add(bucketKey);
    else this._visibleBuckets.delete(bucketKey);
    const entries = this._buckets.get(bucketKey);
    if (entries) for (const entry of entries.values()) entry.container.visible = visible;
    this._scheduleRender();
  },

  /**
   * Dim a whole bucket without hiding it.
   *
   * The DOM layers get this for free from a CSS rule keyed on the map
   * container's data-emphasis attribute, but a sprite has no stylesheet -- so
   * clicking a conflict pin has to reach the ships and aircraft through here or
   * they would be the only things on the map that failed to recede. Alpha only:
   * the sprites stay in place, stay hit-testable and keep their textures, so
   * this is one property write per entity and nothing is rebuilt.
   */
  setBucketAlpha(bucketKey, alpha) {
    const next = Number.isFinite(alpha) ? alpha : 1;
    if (this._bucketAlpha.get(bucketKey) === next) return;
    this._bucketAlpha.set(bucketKey, next);
    const entries = this._buckets.get(bucketKey);
    if (entries) {
      for (const entry of entries.values()) entry.container.alpha = (entry.themeAlpha ?? 1) * next;
    }
    this._scheduleRender();
  },

  /**
   * @param {string} bucketKey - "aisCivilian" | "aisTanker" | "aisNavy" | "aisDigitraffic" | "adsbCivilian" | "adsbMilitary"
   * @param {object[]} items - visible entities for this bucket (already bounds/zoom filtered)
   * @param {object} opts
   *   idField: (item) => string|number
   *   heading: (item) => number
   *   style: (item) => {svg,color,size,name} -- per-item, since e.g. adsbCivilian mixes helicopter/commercial/other
   *   isSelected: (item) => boolean
   *   onSelect: (item) => void -- caller owns the popup; this only reports the tap
   *   getTooltip: (item) => string (HTML), shown on hover
   *   offsets: Map(id -> {dx, dy}) | undefined -- declutter nudges from the
   *     shared cross-layer placement pass; drawn position only, entry.item
   *     (used for clicks/popups/tooltips) keeps the real lat/lon.
   */
  updateEntities(bucketKey, items, opts) {
    if (!this._app) return;
    this._offsetsByBucket = this._offsetsByBucket || new Map();
    this._offsetsByBucket.set(bucketKey, opts.offsets || new Map());
    this._idFieldByBucket = this._idFieldByBucket || new Map();
    this._idFieldByBucket.set(bucketKey, opts.idField);
    this._lastItems = this._lastItems || new Map();
    this._lastItems.set(bucketKey, items);
    // Read back by _hitTestAt to dispatch onSelect/getTooltip for whichever
    // bucket the hit sprite belongs to (each bucket has its own callbacks).
    this._optsByBucket = this._optsByBucket || new Map();
    this._optsByBucket.set(bucketKey, opts);

    let entries = this._buckets.get(bucketKey);
    if (!entries) {
      entries = new Map();
      this._buckets.set(bucketKey, entries);
    }
    const visible = this._visibleBuckets.has(bucketKey);

    // One sprite per entity per copy of the world in view. `seen` therefore holds
    // composite keys, which is also what makes zooming back in safe: the copies
    // that just left the screen are no longer in it, so the sweep at the bottom
    // destroys their sprites instead of leaking them.
    const offsets = this._copyOffsets();
    const seen = new Set();
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const id = opts.idField(item);
      // Asked once per entity, not once per drawn copy: every copy of a ship is
      // the same ship, so it has the same glyph, heading and selection state, and
      // these are the callbacks that actually cost something.
      const style = opts.style(item);
      const heading = opts.heading(item);
      const selected = opts.isSelected(item);
      for (const copy of offsets) {
        const entryKey = this._entryKey(id, copy);
        seen.add(entryKey);
        let entry = entries.get(entryKey);
        if (!entry) {
          entry = createEntry(this._app);
          entry.container.visible = visible;
          entries.set(entryKey, entry);
        }

        this._applyStyle(entry, style);
        // Per-layer opacity from Admin Mode (see map/iconTheme.js's themedStyle).
        // Set on the container rather than baked into the texture, so turning a
        // layer down does not mint a second texture for every glyph in it.
        //
        // Multiplied by the bucket's emphasis alpha rather than replacing it:
        // these answer different questions ("how solid should this layer be" and
        // "is the reader looking at something else right now") and whichever
        // wrote the property last would otherwise silently win. Kept on the entry
        // so setBucketAlpha can recombine them without re-reading the style.
        entry.themeAlpha = Number.isFinite(style.opacity) ? style.opacity : 1;
        entry.container.alpha = entry.themeAlpha * (this._bucketAlpha.get(bucketKey) ?? 1);
        entry.sprite.rotation = Number.isFinite(heading) ? (heading * Math.PI) / 180 : entry.sprite.rotation;

        // Selecting a ship highlights it on every copy, because the reader
        // selected the ship, not one of its pictures.
        entry.highlight.visible = selected;
        if (selected) drawHighlight(entry, style.size, 0xffffff);

        this._placeEntry(entry, bucketKey, item, copy);
        // A smaller sprite draws in front of a bigger one, so a 13px "other"
        // aircraft can't end up completely buried under a 30px bomber with no
        // way to tap it. Mirrors applyStacking on the Leaflet-marker side.
        entry.container.zIndex = -Math.round(style.size || 16);

        // The real record, on every copy -- so a tap or hover on any of them
        // reports the entity itself and _hitTestAt needs no copy awareness at all.
        entry.item = item;
      }
    }

    // Over entry keys, not record ids -- an entity that is still present but whose
    // outer copies have just left the screen has to lose those sprites here, which
    // is the only thing standing between a zoom-out/zoom-in cycle and a sprite leak.
    for (const [entryKey, entry] of entries) {
      if (!seen.has(entryKey)) {
        this._app.stage.removeChild(entry.container);
        // Drop it from any texture-ready queue before destroying it, so the
        // callback isn't left holding a dead sprite (see _applyStyle's guard,
        // which is the belt to this braces).
        for (const waiting of this._pendingSprites.values()) waiting.delete(entry);
        entry.container.destroy({ children: true });
        entries.delete(entryKey);
      }
    }

    this._scheduleRender();
  },

  _showTooltip(entry, html) {
    if (!this._tooltipEl) {
      this._tooltipEl = document.createElement("div");
      this._tooltipEl.className = "map-tooltip leaflet-tooltip leaflet-tooltip-top webgl-entity-tooltip";
      this._tooltipEl.style.position = "absolute";
      this._tooltipEl.style.pointerEvents = "none";
      this._tooltipEl.style.transform = "translate(-50%, -100%)";
      this.getPane().appendChild(this._tooltipEl);
    }
    this._tooltipEl.innerHTML = html;
    // Appended directly to the pane (a sibling of the canvas, not a child of
    // it), so it needs the canvas's own pane-relative offset added back in
    // -- entry positions are canvas-local (see _project's topLeft subtraction).
    this._tooltipEl.style.left = `${entry.container.position.x + this._topLeft.x}px`;
    this._tooltipEl.style.top = `${entry.container.position.y + this._topLeft.y - 12}px`;
    this._tooltipEl.style.display = "block";
  },

  _hideTooltip() {
    if (this._tooltipEl) this._tooltipEl.style.display = "none";
  },

  // Kept for createMapController.js's map-click handler, but now always
  // false: _onContainerClick stopPropagation()s a sprite hit during the
  // container's capture phase, so Leaflet's own bubble-phase click handler
  // never runs for a tap that hit a sprite -- there's nothing left to
  // suppress after the fact.
  consumeSuppressedClick() {
    return false;
  },
});

// Returned synchronously so createMapController.js keeps its straight-line
// construction, while Pixi itself loads in the background. Until it lands,
// calls are recorded rather than queued as a growing list: every
// updateEntities call carries a *complete* snapshot for its bucket, so only
// the most recent one per bucket is worth replaying -- the same reason the
// live layer can be rebuilt from any single poll.
export function createEntityWebglLayer(map) {
  let layer = null;
  const pendingEntities = new Map(); // bucketKey -> [items, opts]
  const pendingVisibility = new Map(); // bucketKey -> boolean
  const pendingAlpha = new Map(); // bucketKey -> number, same deal as above

  loadPixi()
    .then(() => {
      // The map can already be gone by the time the Pixi chunk lands (a fast
      // unmount, or React's dev-mode double mount). Attaching to a removed map
      // leaves a layer wired to torn-down panes, which is where the
      // teardown-race guards in _reset/_onAnimZoom were firing from.
      //
      // Tested on the panes rather than on _loaded/_container: L.Map.remove()
      // leaves both of those exactly as they were and instead empties _panes
      // and deletes _mapPane, so the earlier check passed on a dead map and
      // onAdd then threw "Cannot read properties of undefined (reading
      // 'appendChild')" -- getPane() had nothing to return.
      if (!map._container || !map._mapPane || !map.getPane("overlayPane")) return;
      layer = new EntityWebglLayer();
      layer.addTo(map);
      for (const [bucketKey, visible] of pendingVisibility) layer.setVisible(bucketKey, visible);
      for (const [bucketKey, alpha] of pendingAlpha) layer.setBucketAlpha(bucketKey, alpha);
      for (const [bucketKey, [items, opts]] of pendingEntities) layer.updateEntities(bucketKey, items, opts);
      pendingVisibility.clear();
      pendingAlpha.clear();
      pendingEntities.clear();
    })
    .catch((err) => {
      // A failed chunk load costs the ship/aircraft layers, not the map --
      // every other layer is plain Leaflet and unaffected.
      console.error("Failed to load the WebGL entity renderer:", err);
    });

  return {
    setVisible(bucketKey, visible) {
      if (layer) layer.setVisible(bucketKey, visible);
      else pendingVisibility.set(bucketKey, visible);
    },
    setBucketAlpha(bucketKey, alpha) {
      if (layer) layer.setBucketAlpha(bucketKey, alpha);
      else pendingAlpha.set(bucketKey, alpha);
    },
    updateEntities(bucketKey, items, opts) {
      if (layer) layer.updateEntities(bucketKey, items, opts);
      else pendingEntities.set(bucketKey, [items, opts]);
    },
    consumeSuppressedClick() {
      return layer ? layer.consumeSuppressedClick() : false;
    },
    /**
     * The sprite canvas, or null before the renderer has finished loading.
     *
     * Exposed so the controller can put this layer's stack opacity and order on
     * it (see applyWashStack in createMapController.js). The six buckets share
     * this one element, which is exactly why they share one place in the stack.
     * Null is an ordinary answer rather than an error: Pixi is a dynamic import,
     * so a render can and does run before it lands.
     */
    canvas() {
      return layer?._canvas || null;
    },
  };
}
