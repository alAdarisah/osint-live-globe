// Admin Mode's state: the whole configuration, plus whether Admin Mode itself
// is switched on.
//
// The configuration is one object (see settings/defaults.js) held in React
// state and pushed into the two places that actually consume it -- the CSS
// custom properties the panels are styled from, and the map's icon theme (see
// map/iconTheme.js).
//
// It is stored in two places, and they are not equal partners:
//
//   data/admin_config.json   the authority. Written through /api/admin-config
//                            (see backend/admin_config.py) on every change, and
//                            read back at startup before anything is painted
//                            from the local copy, so a configuration made on
//                            one machine is the configuration this deployment
//                            uses on all of them.
//   localStorage             a cache. It makes the first paint instant instead
//                            of waiting on a round trip, and it is what keeps
//                            the map configured when the backend is not there
//                            (a static build, a dev session with no server).
//
// Admin Mode's own on/off lives in its own storage key and is in neither. A
// configuration is meant to be shared; whether the person who receives it is
// editing at that moment is not a property of the configuration, and loading
// someone else's must never silently put a reader into an editing mode.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { defaultSettings, mergeSettings, EDITABLE_SOURCES } from "../settings/defaults";
import { borderStats, sanitizeRing, MAX_TOTAL_POINTS } from "../settings/borderOverrides";
import { setIconTheme } from "../map/iconTheme";
import { setCursorOptions } from "../map/cursor";
import { buildTileFilter, TILE_TINT_PRESETS } from "../map/tileTint";
import { setTileTintAtRest } from "../map/tileTintMotion";
import { setInferenceMode } from "../map/inferenceVisibility";
import { setUnitsPreference } from "../utils/format";
import { setPerformanceOptions } from "../map/createMapController";
import { MARINE_CLASSES } from "../map/water";

const STORAGE_KEY = "osint-admin-settings";
// When STORAGE_KEY was last written, in ms. See localIsNewerThan below.
const STAMP_KEY = "osint-admin-settings-at";
const ADMIN_KEY = "osint-admin-mode";
const CONFIG_URL = "/api/admin-config";

// Long enough that dragging a slider is one save rather than forty, short
// enough that letting go and looking at the panel shows "saved".
const SAVE_DEBOUNCE_MS = 700;

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return mergeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    // Unreadable, disabled or corrupt storage is not a reason to fail to
    // render -- the app simply starts from the shipped defaults.
    return defaultSettings();
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    // Written every time the cache is, and read once at startup to decide
    // whether the server's copy is actually newer than this one. See
    // localIsNewerThan below for what goes wrong without it.
    localStorage.setItem(STAMP_KEY, String(Date.now()));
  } catch {
    // Private mode or a full quota: the settings still apply for this session,
    // they just will not be remembered.
  }
}

/**
 * Is the local cache newer than the copy the server is offering?
 *
 * "Whatever the server holds wins" was too strong, and the way it failed was
 * silent and infuriating: untick a layer, refresh inside the save debounce, and
 * the change is not merely lost -- the stale server copy replaces the good local
 * one *and* overwrites the cache with it, so the layer ticks itself back on and
 * stays on. The setting was written correctly and then actively undone.
 *
 * The rule is now "whatever is newer wins", which is what the original intent
 * ("open the map on another browser and it comes up configured") actually needs.
 * A server copy saved after this browser last wrote still wins; one saved before
 * it does not, and the local copy is pushed up instead.
 *
 * `saved_at` is unix seconds, the stamp is milliseconds, and the comparison is
 * given a second of slack so the rounding cannot make an equal pair look like a
 * local win and start a pointless write on every cold start.
 */
function localIsNewerThan(serverSavedAt) {
  if (!Number.isFinite(serverSavedAt)) return false;
  const stamp = Number(localStorage.getItem(STAMP_KEY));
  if (!Number.isFinite(stamp) || stamp <= 0) return false;
  return stamp > (serverSavedAt + 1) * 1000;
}

export function useAppSettings() {
  const [settings, setSettings] = useState(loadSettings);
  const [adminMode, setAdminMode] = useState(() => {
    try {
      return localStorage.getItem(ADMIN_KEY) === "on";
    } catch {
      return false;
    }
  });

  // Whether this page was served by the public listener, which refuses admin
  // writes (see frontend/nginx.conf). Asked once, at startup: nginx is the only
  // thing that knows which of its two doors a request came through, so it is the
  // only thing that can answer.
  //
  // Defaults to false -- admin offered -- and stays false if the request fails.
  // That is deliberate: the write endpoint is already 403 on the public
  // listener, so this flag only decides whether the button is shown, and failing
  // closed would hide the panel from the operator over the SSH tunnel because of
  // one dropped request.
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/public-mode", { cache: "no-store" });
        if (!response.ok) return;
        const body = await response.json();
        if (!cancelled && body?.readonly === true) setReadOnly(true);
      } catch {
        /* offline, or the private listener answering 404 -- either way, admin
           stays available and the 403 remains the real boundary. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // What the admin panel reports about the file on disk:
  //   state    "loading" | "saved" | "saving" | "local-only" | "error"
  //   savedAt  unix seconds of the last successful write, or null
  //   detail   the server's own message when something went wrong
  const [sync, setSync] = useState({ state: "loading", savedAt: null, detail: null });

  // True once a *user* change has happened. Until then the server's copy is
  // allowed to replace what came out of localStorage; after it, it never is --
  // otherwise a slow round trip could land on top of a setting somebody just
  // changed and quietly undo it.
  const dirtyRef = useRef(false);
  // Nothing is written back to the server until its copy has been read, so a
  // client that loads while the backend is still starting cannot overwrite a
  // saved configuration with its own stale cache. `loadTick` is the render-time
  // half of that flag: it re-runs the save effect once the read completes, so a
  // change made during the first second (before the round trip landed) is still
  // saved rather than waiting for whatever the reader changes next.
  const loadedRef = useRef(false);
  const [loadTick, setLoadTick] = useState(0);

  // One writer for every change, so no update path can forget to persist.
  const update = useCallback((recipe) => {
    setSettings((prev) => {
      const next = recipe(prev);
      if (next === prev) return prev;
      dirtyRef.current = true;
      saveSettings(next);
      return next;
    });
  }, []);

  // Admin Mode as the rest of the app sees it. The stored preference survives in
  // localStorage either way, so an operator who visited the public link and then
  // opens the SSH tunnel gets their mode back rather than having it silently
  // switched off.
  const effectiveAdmin = adminMode && !readOnly;

  const toggleAdminMode = useCallback(() => {
    if (readOnly) return;
    setAdminMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ADMIN_KEY, next ? "on" : "off");
      } catch {
        /* see saveSettings */
      }
      return next;
    });
  }, [readOnly]);

  // --- the copy on disk -------------------------------------------------

  // Read once, at startup. Whatever the server holds wins over the local cache:
  // that is what "saved in the OSINT folder and applied from now on" means --
  // open the map on another browser, or after clearing this one, and it comes
  // up configured.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(CONFIG_URL, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (cancelled) return;
        loadedRef.current = true;
        // An empty object is the normal first-run state (no file yet), and is
        // not a reason to throw away a local configuration made offline -- the
        // next change saves it up to the server anyway.
        const hasStored = body.config && Object.keys(body.config).length > 0;
        // The third condition is the one that was missing. A change made just
        // before a refresh is written to localStorage immediately but reaches
        // the server on a 700ms debounce, so a quick reload finds the server
        // holding the *previous* configuration -- and without this it wins,
        // replaces the good local copy and overwrites the cache with itself.
        // That is what made an unticked layer tick itself back on.
        if (hasStored && !dirtyRef.current && !localIsNewerThan(body.saved_at)) {
          const merged = mergeSettings(body.config);
          setSettings(merged);
          saveSettings(merged); // keep the local cache in step for the next cold start
        } else if (hasStored && localIsNewerThan(body.saved_at)) {
          // This browser has the newer copy, so it owes the server one. Marking
          // it dirty is what makes the save effect below fire on loadTick.
          dirtyRef.current = true;
        }
        setSync({ state: "saved", savedAt: body.saved_at ?? null, detail: null });
        setLoadTick((n) => n + 1);
      } catch (err) {
        if (cancelled) return;
        // No backend (a static build, or the server is not up yet). The map
        // still works and still remembers settings -- in this browser only,
        // which is exactly what the panel then says.
        loadedRef.current = true;
        setSync({ state: "local-only", savedAt: null, detail: err.message });
        setLoadTick((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Write back on every change, debounced. No Save button: a settings panel
  // with unsaved state is a settings panel that loses work when it is closed.
  useEffect(() => {
    if (!loadedRef.current || !dirtyRef.current) return undefined;
    let cancelled = false;
    setSync((prev) => (prev.state === "local-only" ? prev : { ...prev, state: "saving" }));
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(CONFIG_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(detail || `HTTP ${response.status}`);
        }
        const body = await response.json();
        if (!cancelled) setSync({ state: "saved", savedAt: body.saved_at ?? null, detail: null });
      } catch (err) {
        if (!cancelled) setSync({ state: "error", savedAt: null, detail: err.message });
      }
    }, SAVE_DEBOUNCE_MS);
    // A refresh inside the debounce window would otherwise drop this write
    // entirely. `pagehide` is the last event that reliably fires on a navigation
    // away (including a phone backgrounding the tab, where `beforeunload` does
    // not), and sendBeacon is the one way to get a request out of a document
    // that is being torn down -- a normal fetch is cancelled with the page.
    //
    // Fire-and-forget by construction: there is no response to read and nothing
    // left to update if there were. The reconciliation above is what covers the
    // case where even this does not make it out.
    const flush = () => {
      if (!navigator.sendBeacon) return;
      navigator.sendBeacon(CONFIG_URL, new Blob([JSON.stringify(settings)], { type: "application/json" }));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [settings, loadTick]);

  // --- what the rest of the app reads -----------------------------------

  // Pushed into the map's module-level icon theme rather than passed down as
  // props: the map is imperative and its decorators are plain functions called
  // from deep inside a render pass (see map/iconTheme.js's own note). Repainting
  // afterwards is the caller's job -- App.jsx does it through mapApi.
  useEffect(() => {
    setIconTheme({
      scale: settings.icons.scale,
      colors: settings.icons.colors,
      sizes: settings.icons.sizes,
      zooms: settings.icons.zooms,
      zoomMaxes: settings.icons.zoomMaxes,
      glyphs: settings.icons.glyphs,
      layers: settings.layers,
      stack: settings.layerStack,
      stackFadeFloor: settings.ui.stackFadeFloor,
    });
    // The water layer's hover/selected states are CSS classes, never a
    // re-style (see map/water.js) -- so, unlike every other palette token,
    // these three have to reach the stylesheet itself, the same way --accent
    // does just below. Without this a colour picked for water.fill would only
    // ever show up on a shape drawn *after* the change (the next sync), never
    // on one already hovered or selected when it was made.
    const root = document.documentElement;
    root.style.setProperty("--water-fill", settings.icons.colors["water.fill"]);
    root.style.setProperty("--water-outline", settings.icons.colors["water.outline"]);
    root.style.setProperty("--water-selected-fill", settings.icons.colors["water.selected"]);
  }, [settings.icons, settings.layers, settings.layerStack, settings.ui.stackFadeFloor]);

  // Task 31's Water section. Same "CSS custom property, not a re-style"
  // reasoning the colours just above give -- weight, the two fill-opacity
  // dials and per-class visibility all have to reach an already-drawn shape
  // immediately, not on the layer's next sync. See style.css's `.water-shape`
  // rules and map/water.js's MARINE_CLASSES for the classes each
  // `--water-hide-<class>` property gates.
  useEffect(() => {
    const root = document.documentElement;
    const water = settings.water;
    root.style.setProperty("--water-weight", String(water.outlineWeight));
    root.style.setProperty("--water-hover-fill-opacity", String(water.hoverFillOpacity));
    root.style.setProperty("--water-selected-fill-opacity", String(water.selectedFillOpacity));
    const hidden = new Set(water.hiddenClasses);
    for (const cls of MARINE_CLASSES) {
      const prop = `--water-hide-${cls}`;
      // Set only when hidden; removed otherwise, so the property falls
      // through to CSS's own "declaration invalid, property unset" default
      // (visible) rather than needing an explicit "not none" value written
      // for every class this map ships.
      if (hidden.has(cls)) root.style.setProperty(prop, "none");
      else root.style.removeProperty(prop);
    }
  }, [settings.water]);

  // Task 31's Inference section, pushed into decorators.js's module-level
  // store the same way setIconTheme/setCursorOptions reach their own modules
  // above -- decorators.js's cargoSection/portCallsSection/routeSection are
  // plain functions called mid-popup-build, not components this could reach
  // as a prop. The two products backed by a real layer (dark-ship gaps and
  // lane density) do not come through here at all -- see InferenceSection.jsx,
  // which writes their tri-state straight into layerWish, the same as any
  // other layer checkbox.
  useEffect(() => {
    setInferenceMode(settings.inference.mode);
  }, [settings.inference.mode]);

  // Task 32 item 4, pushed into utils/format.js's own module-level store the
  // same way just above -- decorators.js's speed/altitude/distance/clock
  // renderers are plain functions called mid-popup-build too, and read the
  // preference directly (formatDistanceKm/formatSpeedKmh/formatAltitudeM/
  // formatClockAt's own default parameter) rather than needing it passed in.
  useEffect(() => {
    setUnitsPreference(settings.units);
  }, [settings.units]);

  // Task 31's Performance section, pushed into createMapController.js's own
  // module-level `let` bindings -- see that file's own note by
  // SHIP_TRAIL_MAX_POINTS for why a live reassignment is enough and no
  // interval needs re-registering for five of these six values.
  useEffect(() => {
    setPerformanceOptions(settings.performance);
  }, [settings.performance]);

  // UI settings reach the stylesheet as custom properties on <html>, which is
  // the only way a CSS file can be driven from JS state without restating every
  // affected rule inline on every panel.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ui-text-scale", String(settings.ui.textScale));
    root.style.setProperty("--panel-alpha", String(settings.ui.panelOpacity));
    if (settings.ui.accent) {
      root.style.setProperty("--accent", settings.ui.accent);
      root.style.setProperty("--accent-rgb", hexToRgbTriplet(settings.ui.accent));
    } else {
      // Removing the property (rather than writing a colour back) is what hands
      // the accent to the theme again, so light/dark each keep their own.
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-rgb");
    }
    root.classList.toggle("reduce-motion", settings.ui.reduceMotion);
    root.classList.toggle("hide-leaders", !settings.ui.showLeaderLines);
    // Pushed into the module rather than passed down, for the reason setIconTheme
    // above is: the map is imperative, the cursor is attached to a container
    // React does not own, and threading this through the controller would make
    // it a courier for something it never reads.
    setCursorOptions({
      enabled: settings.ui.cursorEnabled,
      style: settings.ui.cursorStyle,
      scale: settings.ui.cursorScale,
      color: settings.ui.cursorColor,
    });
    // Task 30: one filter value and three tint values per target, the same
    // "state in, custom property out" shape --accent/--ui-text-scale already
    // use above -- style.css's own rules for .leaflet-tile-pane/
    // .leaflet-imagery-pane/.leaflet-weather-pane read these, never this file
    // reaching into the DOM to restyle a pane directly.
    for (const target of ["basemap", "imagery", "weather"]) {
      const dial = settings.ui.tiles[target];
      root.style.setProperty(`--tile-${target}-filter`, buildTileFilter(dial));
      root.style.setProperty(`--tile-${target}-tint-color`, dial.tintColor);
      root.style.setProperty(`--tile-${target}-tint-strength`, String(dial.tintStrength));
      root.style.setProperty(`--tile-${target}-tint-blend`, dial.blendMode);
    }
    // Read from createMapController.js's movestart/moveend handlers -- see
    // map/tileTintMotion.js for why that is a module flag rather than a prop.
    setTileTintAtRest(settings.ui.tiles.applyAtRest);
  }, [settings.ui]);

  useEffect(() => {
    document.documentElement.classList.toggle("admin-mode", effectiveAdmin);
  }, [effectiveAdmin]);

  // --- update helpers ---------------------------------------------------

  const setIconScale = useCallback(
    (scale) => update((prev) => ({ ...prev, icons: { ...prev.icons, scale } })),
    [update]
  );

  const setColor = useCallback(
    (token, value) =>
      update((prev) => ({
        ...prev,
        icons: { ...prev.icons, colors: { ...prev.icons.colors, [token]: value } },
      })),
    [update]
  );

  const resetColors = useCallback(
    () => update((prev) => ({ ...prev, icons: { ...prev.icons, colors: defaultSettings().icons.colors } })),
    [update]
  );

  /** One kind of pin's own size multiplier, on top of the global and layer ones. */
  const setTokenSize = useCallback(
    (token, value) =>
      update((prev) => ({
        ...prev,
        icons: { ...prev.icons, sizes: { ...prev.icons.sizes, [token]: value } },
      })),
    [update]
  );

  const resetSizes = useCallback(
    () => update((prev) => ({ ...prev, icons: { ...prev.icons, sizes: defaultSettings().icons.sizes } })),
    [update]
  );

  /** One kind of pin's own minimum zoom. Null hands it back to its layer's gate. */
  const setTokenZoom = useCallback(
    (token, value) =>
      update((prev) => ({
        ...prev,
        icons: { ...prev.icons, zooms: { ...prev.icons.zooms, [token]: value } },
      })),
    [update]
  );

  /** One kind of pin's own ceiling. Null hands it back to "no ceiling". */
  const setTokenZoomMax = useCallback(
    (token, value) =>
      update((prev) => ({
        ...prev,
        icons: { ...prev.icons, zoomMaxes: { ...prev.icons.zoomMaxes, [token]: value } },
      })),
    [update]
  );

  /** One kind of pin's own glyph. Null hands it back to the shipped shape. */
  const setTokenGlyph = useCallback(
    (token, name) =>
      update((prev) => {
        const glyphs = { ...prev.icons.glyphs };
        if (name == null) delete glyphs[token];
        else glyphs[token] = name;
        return { ...prev, icons: { ...prev.icons, glyphs } };
      }),
    [update]
  );

  const resetZooms = useCallback(
    () =>
      update((prev) => ({
        ...prev,
        icons: {
          ...prev.icons,
          zooms: defaultSettings().icons.zooms,
          zoomMaxes: defaultSettings().icons.zoomMaxes,
        },
      })),
    [update]
  );

  const setLayerStyle = useCallback(
    (key, patch) =>
      update((prev) => ({
        ...prev,
        layers: { ...prev.layers, [key]: { ...prev.layers[key], ...patch } },
      })),
    [update]
  );

  /**
   * A layer checkbox in the control drawer, remembered.
   *
   * The drawer only exists in Admin Mode, so every toggle that reaches here is
   * an operator's standing decision rather than a reader's glance -- which is
   * what makes storing it in the shared configuration the right thing rather
   * than an overreach. `visible === null` forgets the decision and hands the
   * layer back to the scene resolver.
   */
  const setLayerWish = useCallback(
    (key, visible) =>
      update((prev) => {
        const next = { ...prev.layerWish };
        if (visible === null || visible === undefined) delete next[key];
        else next[key] = visible;
        return { ...prev, layerWish: next };
      }),
    [update]
  );

  /**
   * Move one layer up or down its group in the stack.
   *
   * `delta` rather than a target index: the panel offers two arrows per row, and
   * an index would make the caller responsible for a bounds check it is in no
   * position to do -- the group's length lives here.
   */
  const moveLayerInStack = useCallback(
    (group, key, delta) =>
      update((prev) => {
        const order = prev.layerStack[group];
        const from = order.indexOf(key);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= order.length) return prev;
        const next = [...order];
        next.splice(to, 0, next.splice(from, 1)[0]);
        return { ...prev, layerStack: { ...prev.layerStack, [group]: next } };
      }),
    [update]
  );

  const resetLayerStack = useCallback(
    () => update((prev) => ({ ...prev, layerStack: defaultSettings().layerStack })),
    [update]
  );

  const clearLayerWishes = useCallback(
    () => update((prev) => (Object.keys(prev.layerWish).length ? { ...prev, layerWish: {} } : prev)),
    [update]
  );

  const setUi = useCallback(
    (patch) => update((prev) => ({ ...prev, ui: { ...prev.ui, ...patch } })),
    [update]
  );

  /** One tile-tint target's dial (basemap/imagery/weather), patched in place. */
  const setTileDial = useCallback(
    (target, patch) =>
      update((prev) => ({
        ...prev,
        ui: {
          ...prev.ui,
          tiles: { ...prev.ui.tiles, [target]: { ...prev.ui.tiles[target], ...patch } },
        },
      })),
    [update]
  );

  /**
   * One target's dial, replaced wholesale by a shipped preset.
   *
   * A full replacement rather than a patch -- a preset is a complete
   * statement ("this is what Night looks like"), and patching would leave
   * behind whatever the reader had set before under fields the preset does
   * not mention, silently producing a result nobody chose.
   */
  const setTilePreset = useCallback(
    (target, presetKey) =>
      update((prev) => {
        const preset = TILE_TINT_PRESETS[presetKey];
        if (!preset) return prev;
        return {
          ...prev,
          ui: { ...prev.ui, tiles: { ...prev.ui.tiles, [target]: { ...preset.dial } } },
        };
      }),
    [update]
  );

  const setTilesApplyAtRest = useCallback(
    (value) => update((prev) => ({ ...prev, ui: { ...prev.ui, tiles: { ...prev.ui.tiles, applyAtRest: value } } })),
    [update]
  );

  const setCityZones = useCallback(
    (patch) => update((prev) => ({ ...prev, cityZones: { ...prev.cityZones, ...patch } })),
    [update]
  );

  /**
   * Which of the three reader panels the public page carries.
   *
   * A patch rather than a whole table, same as setUi above: the panel toggles
   * one checkbox at a time and has no business restating the other two.
   */
  const setPublicPanels = useCallback(
    (patch) => update((prev) => ({ ...prev, publicPanels: { ...prev.publicPanels, ...patch } })),
    [update]
  );

  // --- Task 31's Water section -------------------------------------------

  const setWater = useCallback(
    (patch) => update((prev) => ({ ...prev, water: { ...prev.water, ...patch } })),
    [update]
  );

  /** One marine class's checkbox in the "which classes to draw" list. */
  const setWaterClassHidden = useCallback(
    (cls, hidden) =>
      update((prev) => {
        const next = new Set(prev.water.hiddenClasses);
        if (hidden) next.add(cls);
        else next.delete(cls);
        return { ...prev, water: { ...prev.water, hiddenClasses: [...next] } };
      }),
    [update]
  );

  // --- Task 31's Filters section ------------------------------------------

  /**
   * Capture the reader's current vessel/aircraft/event filters as a named
   * preset. The three filters themselves are not read from `settings` --
   * they are App.jsx's own React state (see that file's eventFilter/
   * vesselFilter/aircraftFilter) -- so FiltersSection.jsx passes the live
   * values in rather than this reaching for a copy that does not exist here.
   */
  const saveFilterPreset = useCallback(
    (name, snapshot) =>
      update((prev) => ({
        ...prev,
        filters: {
          ...prev.filters,
          presets: [
            ...prev.filters.presets,
            {
              id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              createdAt: Date.now(),
              vesselFilter: snapshot.vesselFilter,
              aircraftFilter: snapshot.aircraftFilter,
              eventFilter: snapshot.eventFilter,
            },
          ],
        },
      })),
    [update]
  );

  const deleteFilterPreset = useCallback(
    (id) =>
      update((prev) => ({
        ...prev,
        filters: { ...prev.filters, presets: prev.filters.presets.filter((p) => p.id !== id) },
      })),
    [update]
  );

  // --- Task 42's alert rules ------------------------------------------

  /** Save a rule -- a new one if its id is not already in the list, an edit
   *  in place otherwise. One action for both, the same "one writer, no
   *  caller has to remember which path it is on" reasoning setLayerStyle
   *  and every other patch-style setter above already follows. */
  const saveAlertRule = useCallback(
    (rule) =>
      update((prev) => {
        const rules = prev.alertRules;
        const index = rules.findIndex((r) => r.id === rule.id);
        const next = index === -1 ? [...rules, rule] : rules.map((r, i) => (i === index ? rule : r));
        return { ...prev, alertRules: next };
      }),
    [update]
  );

  const deleteAlertRule = useCallback(
    (id) => update((prev) => ({ ...prev, alertRules: prev.alertRules.filter((r) => r.id !== id) })),
    [update]
  );

  /** The list row's own on/off switch -- a paused rule stays configured
   *  (geofence, condition, everything) but the cache worker's own
   *  parse_rules skips it, same as `enabled: false` anywhere else in this
   *  file. */
  const setAlertRuleEnabled = useCallback(
    (id, enabled) =>
      update((prev) => ({
        ...prev,
        alertRules: prev.alertRules.map((r) => (r.id === id ? { ...r, enabled } : r)),
      })),
    [update]
  );

  // --- Task 31's Inference section ----------------------------------------

  /**
   * One inferred product's tri-state switch. `effect: "layer"` products
   * (see settings/inferenceProducts.js) write into `layerWish` as well as
   * `inference.mode`, through the same setLayerWish this function already
   * exposes -- so InferenceSection.jsx calls this one action rather than
   * two, and the two settings can never disagree about what a "hide" or
   * "show" click on a layer-backed product actually did.
   */
  const setInferenceProductMode = useCallback(
    (product, value) =>
      update((prev) => {
        const next = {
          ...prev,
          inference: { ...prev.inference, mode: { ...prev.inference.mode, [product.key]: value } },
        };
        if (product.effect === "layer" && product.layerKey) {
          const wish = { ...next.layerWish };
          if (value === "labelled") delete wish[product.layerKey]; // hand back to the scene resolver
          else wish[product.layerKey] = value === "show";
          next.layerWish = wish;
        }
        return next;
      }),
    [update]
  );

  // --- Task 31's Cards section ---------------------------------------------

  const setCardSectionHidden = useCallback(
    (cardType, sectionId, hidden) =>
      update((prev) => {
        const current = new Set(prev.cards.hidden[cardType] || []);
        if (hidden) current.add(sectionId);
        else current.delete(sectionId);
        return { ...prev, cards: { ...prev.cards, hidden: { ...prev.cards.hidden, [cardType]: [...current] } } };
      }),
    [update]
  );

  /**
   * Move one section up or down within a card type's order. `shippedOrder`
   * is the full, already-repaired sequence (orderedCardSections's own
   * output) rather than whatever happens to be stored -- the same reason
   * moveLayerInStack needs the caller to have resolved a starting order
   * before it can compute a swap.
   */
  const moveCardSection = useCallback(
    (cardType, shippedOrder, sectionId, delta) =>
      update((prev) => {
        const from = shippedOrder.indexOf(sectionId);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= shippedOrder.length) return prev;
        const next = [...shippedOrder];
        next.splice(to, 0, next.splice(from, 1)[0]);
        return { ...prev, cards: { ...prev.cards, order: { ...prev.cards.order, [cardType]: next } } };
      }),
    [update]
  );

  const setCardSectionDefaultOpen = useCallback(
    (cardType, sectionId, value) =>
      update((prev) => {
        const current = { ...prev.cards.defaultOpen[cardType] };
        if (value === null) delete current[sectionId];
        else current[sectionId] = value;
        return {
          ...prev,
          cards: { ...prev.cards, defaultOpen: { ...prev.cards.defaultOpen, [cardType]: current } },
        };
      }),
    [update]
  );

  const resetCardSettings = useCallback(
    (cardType) =>
      update((prev) => ({
        ...prev,
        cards: {
          hidden: { ...prev.cards.hidden, [cardType]: [] },
          order: { ...prev.cards.order, [cardType]: [] },
          defaultOpen: { ...prev.cards.defaultOpen, [cardType]: {} },
        },
      })),
    [update]
  );

  // --- Task 31's Performance section ---------------------------------------

  const setPerformance = useCallback(
    (patch) => update((prev) => ({ ...prev, performance: { ...prev.performance, ...patch } })),
    [update]
  );

  // --- Task 44's replay cadence/step ----------------------------------------

  const setReplay = useCallback(
    (patch) => update((prev) => ({ ...prev, replay: { ...prev.replay, ...patch } })),
    [update]
  );

  /** Merge a field patch into one record's overrides. Passing {} is a no-op edit. */
  const editRecord = useCallback(
    (sourceKey, id, patch) =>
      update((prev) => {
        const source = prev.data[sourceKey] || { edits: {}, added: [] };
        return {
          ...prev,
          data: {
            ...prev.data,
            [sourceKey]: {
              ...source,
              edits: { ...source.edits, [id]: { ...source.edits[id], ...patch } },
            },
          },
        };
      }),
    [update]
  );

  /** Drop every override for one record, putting it back to what the feed says. */
  const revertRecord = useCallback(
    (sourceKey, id) =>
      update((prev) => {
        const source = prev.data[sourceKey];
        if (!source?.edits?.[id]) return prev;
        const edits = { ...source.edits };
        delete edits[id];
        return { ...prev, data: { ...prev.data, [sourceKey]: { ...source, edits } } };
      }),
    [update]
  );

  const addRecord = useCallback(
    (sourceKey, record) =>
      update((prev) => {
        const source = prev.data[sourceKey] || { edits: {}, added: [] };
        return {
          ...prev,
          data: { ...prev.data, [sourceKey]: { ...source, added: [...source.added, record] } },
        };
      }),
    [update]
  );

  const removeAddedRecord = useCallback(
    (sourceKey, id) =>
      update((prev) => {
        const source = prev.data[sourceKey];
        if (!source) return prev;
        const idField = EDITABLE_SOURCES.find((s) => s.key === sourceKey)?.idField || "id";
        return {
          ...prev,
          data: {
            ...prev.data,
            [sourceKey]: { ...source, added: source.added.filter((r) => r[idField] !== id) },
          },
        };
      }),
    [update]
  );

  const clearDataEdits = useCallback(
    () => update((prev) => ({ ...prev, data: defaultSettings().data })),
    [update]
  );

  // --- redrawn boundaries -----------------------------------------------

  // What the last border commit had to say for itself: null normally, a string
  // when a ring was refused. The editor is a direct-manipulation gesture, so a
  // refusal has to surface somewhere the hand that made it is looking.
  const [borderNotice, setBorderNotice] = useState(null);

  /**
   * Commit the rings one drag touched.
   *
   * The whole gesture arrives as one array rather than a call per ring, because
   * moving a shared vertex moves it in every country that owns it -- a single
   * drag on the Ukraine/Russia border legitimately rewrites two rings, and
   * committing them separately would be two localStorage writes, two debounce
   * windows, and a moment where the map on disk has a seam in it.
   *
   * @param {Array<{countryKey: string, fp: string|null, polygonIndex: number,
   *                ringIndex: number, ring: Array<[number, number]>}>} commits
   */
  const setBorderRings = useCallback(
    (commits) => {
      if (!Array.isArray(commits) || !commits.length) return;
      let refused = null;
      update((prev) => {
        const borders = { ...prev.borders };
        let total = borderStats(borders).points;

        for (const commit of commits) {
          const { countryKey, fp, polygonIndex, ringIndex, ring } = commit || {};
          if (!countryKey) continue;
          const clean = sanitizeRing(ring);
          if (!clean) {
            refused = `That edit would leave ${countryKey} with too few points to be a shape.`;
            continue;
          }
          const entry = borders[countryKey];
          const key = `${polygonIndex}:${ringIndex}`;
          // Replacing a ring already stored costs nothing new, so only a
          // genuinely new ring is measured against the ceiling.
          const previous = entry?.rings?.[key]?.length || 0;
          if (total - previous + clean.length > MAX_TOTAL_POINTS) {
            refused =
              `There is no room left for boundary edits (${MAX_TOTAL_POINTS.toLocaleString()} points). ` +
              `Revert a country in the Admin panel to make room.`;
            continue;
          }
          total = total - previous + clean.length;
          borders[countryKey] = {
            // The fingerprint is whatever the edit started from and never
            // changes as the ring does -- it identifies the *source* geometry
            // these ring keys address, not the shape being drawn.
            fp: entry?.fp ?? fp ?? null,
            rings: { ...(entry?.rings || {}), [key]: clean },
          };
        }

        return { ...prev, borders };
      });
      setBorderNotice(refused);
    },
    [update]
  );

  /** Put one country's boundary back to what the source serves. */
  const revertBorderCountry = useCallback(
    (countryKey) =>
      update((prev) => {
        if (!prev.borders?.[countryKey]) return prev;
        const borders = { ...prev.borders };
        delete borders[countryKey];
        return { ...prev, borders };
      }),
    [update]
  );

  const clearBorderEdits = useCallback(
    () => update((prev) => (Object.keys(prev.borders).length ? { ...prev, borders: {} } : prev)),
    [update]
  );

  const clearBorderNotice = useCallback(() => setBorderNotice(null), []);

  const resetAll = useCallback(() => update(() => defaultSettings()), [update]);

  /** The current config as a JSON string, for download. */
  const exportSettings = useCallback(() => JSON.stringify(settings, null, 2), [settings]);

  /**
   * Replace the whole config from a JSON string.
   * @returns {string|null} an error message, or null when it was applied.
   */
  const importSettings = useCallback(
    (text) => {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return `Not valid JSON: ${err.message}`;
      }
      if (!parsed || typeof parsed !== "object") return "That file does not contain a settings object.";
      update(() => mergeSettings(parsed));
      return null;
    },
    [update]
  );

  const actions = useMemo(
    () => ({
      setIconScale, setColor, resetColors, setTokenSize, resetSizes,
      setTokenZoom, setTokenZoomMax, setTokenGlyph, resetZooms, setLayerStyle, setLayerWish, clearLayerWishes,
      moveLayerInStack, resetLayerStack, setUi, setTileDial, setTilePreset, setTilesApplyAtRest, setCityZones,
      setPublicPanels,
      setWater, setWaterClassHidden,
      saveFilterPreset, deleteFilterPreset,
      setInferenceProductMode,
      setCardSectionHidden, moveCardSection, setCardSectionDefaultOpen, resetCardSettings,
      setPerformance, setReplay,
      editRecord, revertRecord, addRecord, removeAddedRecord, clearDataEdits,
      setBorderRings, revertBorderCountry, clearBorderEdits, clearBorderNotice,
      saveAlertRule, deleteAlertRule, setAlertRuleEnabled,
      resetAll, exportSettings, importSettings,
    }),
    [
      setIconScale, setColor, resetColors, setTokenSize, resetSizes,
      setTokenZoom, setTokenZoomMax, setTokenGlyph, resetZooms, setLayerStyle, setLayerWish, clearLayerWishes,
      moveLayerInStack, resetLayerStack, setUi, setTileDial, setTilePreset, setTilesApplyAtRest, setCityZones,
      setPublicPanels,
      setWater, setWaterClassHidden,
      saveFilterPreset, deleteFilterPreset,
      setInferenceProductMode,
      setCardSectionHidden, moveCardSection, setCardSectionDefaultOpen, resetCardSettings,
      setPerformance, setReplay,
      editRecord, revertRecord, addRecord, removeAddedRecord, clearDataEdits,
      setBorderRings, revertBorderCountry, clearBorderEdits, clearBorderNotice,
      saveAlertRule, deleteAlertRule, setAlertRuleEnabled,
      resetAll, exportSettings, importSettings,
    ]
  );

  // `adminMode` is the effective one, so no caller has to remember to combine it
  // with readOnly -- App.jsx gates a dozen things on it, and one missed check
  // would put an editor on the public page. `readOnly` is returned as well
  // because the title bar needs to hide the button rather than merely disable it.
  return { settings, adminMode: effectiveAdmin, readOnly, toggleAdminMode, actions, sync, borderNotice };
}

// "#6fe3ff" -> "111, 227, 255", the form the rgba(var(--accent-rgb), a) rules
// in style.css need. Three-digit hex is not accepted here on purpose: the
// accent picker is an <input type="color">, which always emits six.
function hexToRgbTriplet(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}
