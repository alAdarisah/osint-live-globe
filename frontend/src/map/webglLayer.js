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
import { declutterPoints } from "./declutter";

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

    this._canvas = L.DomUtil.create("canvas", "leaflet-webgl-entity-layer");
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

    this._textureCache = new TextureCache();
    this._buckets = new Map(); // bucketKey -> Map(entityId -> entry)
    this._visibleBuckets = new Set();
    this._topLeft = L.point(0, 0);
    this._redrawScheduled = false;
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
  },

  // Cheap bounding-box test against currently visible sprites (a handful to
  // a few hundred, never the whole raw dataset -- buckets only ever hold
  // what's already been bounds/zoom-filtered), returning the *nearest* hit
  // so overlapping sprites resolve to the one actually aimed at rather than
  // whichever bucket happened to be iterated first. Touch targets get a
  // floor of TOUCH_SLOP_PX so a small sprite is still tappable on a phone.
  // Returns {entry, opts} or null.
  _hitTestAt(clientX, clientY) {
    const rect = this._canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
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

  _onContainerMove(e) {
    const hit = this._hitTestAt(e.clientX, e.clientY);
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
    const scale = map.getZoomScale(e.zoom, this._animZoom);
    const position = L.DomUtil.getPosition(this._canvas);
    const viewHalf = map.getSize().multiplyBy(0.5);
    const currentCenterPoint = map.project(this._animCenter, e.zoom);
    const destCenterPoint = map.project(e.center, e.zoom);
    const centerOffset = destCenterPoint.subtract(currentCenterPoint);
    const topLeftOffset = viewHalf.multiplyBy(-scale).add(position).add(viewHalf).subtract(centerOffset);
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  },

  _project(lat, lon) {
    const p = this._map.latLngToLayerPoint([lat, lon]);
    return { x: p.x - this._topLeft.x, y: p.y - this._topLeft.y };
  },

  _repositionAll() {
    for (const [bucketKey, entries] of this._buckets) {
      const items = this._lastItems?.get(bucketKey);
      if (!items) continue;
      const projected = items.map((item) => this._project(item.lat, item.lon));
      const placed = declutterPoints(projected);
      for (let idx = 0; idx < items.length; idx++) {
        const entry = entries.get(this._idOf(bucketKey, items[idx]));
        if (!entry) continue;
        const { x, y } = placed[idx];
        entry.container.position.set(x, y);
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
   * @param {string} bucketKey - "aisCivilian" | "aisTanker" | "aisNavy" | "adsbCivilian" | "adsbMilitary"
   * @param {object[]} items - visible entities for this bucket (already bounds/zoom filtered)
   * @param {object} opts
   *   idField: (item) => string|number
   *   heading: (item) => number
   *   style: (item) => {svg,color,size,name} -- per-item, since e.g. adsbCivilian mixes helicopter/commercial/other
   *   isSelected: (item) => boolean
   *   onSelect: (item) => void -- caller owns the popup; this only reports the tap
   *   getTooltip: (item) => string (HTML), shown on hover
   */
  updateEntities(bucketKey, items, opts) {
    if (!this._app) return;
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

    // Same declutter pass createMapController.js's renderMarkerLayer applies
    // to plain Leaflet markers -- ships/aircraft cluster at ports/airports
    // just as easily as conflict events cluster in a city, and this is the
    // one bucket-scoped place per-bucket item positions are all known at
    // once. Only affects the sprite's drawn position; entry.item (used for
    // clicks/popups/tooltips) keeps the item's real lat/lon.
    const projected = items.map((item) => this._project(item.lat, item.lon));
    const placed = declutterPoints(projected);

    const seen = new Set();
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const id = opts.idField(item);
      seen.add(id);
      let entry = entries.get(id);
      if (!entry) {
        entry = createEntry(this._app);
        entry.container.visible = visible;
        entries.set(id, entry);
      }

      const style = opts.style(item);
      this._applyStyle(entry, style);
      const heading = opts.heading(item);
      entry.sprite.rotation = Number.isFinite(heading) ? (heading * Math.PI) / 180 : entry.sprite.rotation;

      const selected = opts.isSelected(item);
      entry.highlight.visible = selected;
      if (selected) drawHighlight(entry, style.size, 0xffffff);

      const { x, y } = placed[idx];
      entry.container.position.set(x, y);

      entry.item = item;
    }

    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        this._app.stage.removeChild(entry.container);
        entry.container.destroy({ children: true });
        entries.delete(id);
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

  loadPixi()
    .then(() => {
      layer = new EntityWebglLayer();
      layer.addTo(map);
      for (const [bucketKey, visible] of pendingVisibility) layer.setVisible(bucketKey, visible);
      for (const [bucketKey, [items, opts]] of pendingEntities) layer.updateEntities(bucketKey, items, opts);
      pendingVisibility.clear();
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
    updateEntities(bucketKey, items, opts) {
      if (layer) layer.updateEntities(bucketKey, items, opts);
      else pendingEntities.set(bucketKey, [items, opts]);
    },
    consumeSuppressedClick() {
      return layer ? layer.consumeSuppressedClick() : false;
    },
  };
}
