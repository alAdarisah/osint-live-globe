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
import * as PIXI from "pixi.js";
import { L } from "./leafletGlobal";

// Rasterizes an SVG glyph (from svgIcons.js's SVG dict, `currentColor` swapped
// for a real hex value) into a PIXI.Texture once per distinct (name, color,
// size) combination -- shared across every sprite that uses it, which is
// what makes thousands of sprites a handful of GPU-batched draw calls
// instead of thousands of individual ones. ~14 total combinations across
// ship/aircraft styles (see decorators.js's SHIP_STYLE/AIRCRAFT_STYLE), not
// one per live entity.
const SUPERSAMPLE = 3; // rasterize above the on-screen size so icons stay crisp when zoomed

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
  sprite.eventMode = "static";
  sprite.cursor = "pointer";
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
    this._canvas.style.pointerEvents = "auto";
    this.getPane().appendChild(this._canvas);

    this._app = new PIXI.Application({
      view: this._canvas,
      width: size.x,
      height: size.y,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    // Container's default eventMode ("auto") already passes hit-testing
    // through to children, so individual sprites setting eventMode="static"
    // (see createEntry below) is enough -- Pixi's EventSystem attaches its
    // own pointer listeners to the renderer's canvas automatically.

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
    map.on("moveend resize", this._reset);
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
    L.DomUtil.setPosition(this._canvas, this._topLeft);
    this._repositionAll();
  },

  _project(lat, lon) {
    const p = this._map.latLngToLayerPoint([lat, lon]);
    return { x: p.x - this._topLeft.x, y: p.y - this._topLeft.y };
  },

  _repositionAll() {
    for (const [bucketKey, entries] of this._buckets) {
      const items = this._lastItems?.get(bucketKey);
      if (!items) continue;
      for (const item of items) {
        const entry = entries.get(this._idOf(bucketKey, item));
        if (!entry) continue;
        const { x, y } = this._project(item.lat, item.lon);
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

    let entries = this._buckets.get(bucketKey);
    if (!entries) {
      entries = new Map();
      this._buckets.set(bucketKey, entries);
    }
    const visible = this._visibleBuckets.has(bucketKey);

    const seen = new Set();
    for (const item of items) {
      const id = opts.idField(item);
      seen.add(id);
      let entry = entries.get(id);
      if (!entry) {
        entry = createEntry(this._app);
        entry.container.visible = visible;
        entries.set(id, entry);
        // entry persists across updateEntities calls (see the `if (!entry)`
        // guard above) but these handlers are only attached once -- reading
        // entry.item (refreshed on every call, below) rather than the `item`
        // captured in this closure is what keeps clicks/hovers acting on
        // the entity's current position/data instead of its position when
        // the sprite was first created.
        entry.sprite.on("pointertap", (e) => {
          e.stopPropagation();
          this._suppressMapClick = true;
          opts.onSelect(entry.item);
        });
        entry.sprite.on("pointerover", () => this._showTooltip(entry, opts.getTooltip(entry.item)));
        entry.sprite.on("pointerout", () => this._hideTooltip());
      }

      const style = opts.style(item);
      this._applyStyle(entry, style);
      const heading = opts.heading(item);
      entry.sprite.rotation = Number.isFinite(heading) ? (heading * Math.PI) / 180 : entry.sprite.rotation;

      const selected = opts.isSelected(item);
      entry.highlight.visible = selected;
      if (selected) drawHighlight(entry, style.size, 0xffffff);

      const { x, y } = this._project(item.lat, item.lon);
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

  // Whether the most recent sprite tap should suppress the map's own
  // background-click deselect handler -- Pixi's interaction manager doesn't
  // share a stopPropagation chain with the DOM click Leaflet's map listener
  // also receives on the same canvas element, so createMapController.js
  // checks+clears this flag itself right after a map click.
  consumeSuppressedClick() {
    const suppressed = this._suppressMapClick;
    this._suppressMapClick = false;
    return suppressed;
  },
});

export function createEntityWebglLayer(map) {
  const layer = new EntityWebglLayer();
  layer.addTo(map);
  return layer;
}
