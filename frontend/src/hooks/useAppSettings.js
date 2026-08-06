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

const STORAGE_KEY = "osint-admin-settings";
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
  } catch {
    // Private mode or a full quota: the settings still apply for this session,
    // they just will not be remembered.
  }
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

  const toggleAdminMode = useCallback(() => {
    setAdminMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ADMIN_KEY, next ? "on" : "off");
      } catch {
        /* see saveSettings */
      }
      return next;
    });
  }, []);

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
        if (hasStored && !dirtyRef.current) {
          const merged = mergeSettings(body.config);
          setSettings(merged);
          saveSettings(merged); // keep the local cache in step for the next cold start
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
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
      layers: settings.layers,
    });
  }, [settings.icons, settings.layers]);

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
  }, [settings.ui]);

  useEffect(() => {
    document.documentElement.classList.toggle("admin-mode", adminMode);
  }, [adminMode]);

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

  const setLayerStyle = useCallback(
    (key, patch) =>
      update((prev) => ({
        ...prev,
        layers: { ...prev.layers, [key]: { ...prev.layers[key], ...patch } },
      })),
    [update]
  );

  const setUi = useCallback(
    (patch) => update((prev) => ({ ...prev, ui: { ...prev.ui, ...patch } })),
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
      setIconScale, setColor, resetColors, setTokenSize, resetSizes, setLayerStyle, setUi,
      editRecord, revertRecord, addRecord, removeAddedRecord, clearDataEdits,
      setBorderRings, revertBorderCountry, clearBorderEdits, clearBorderNotice,
      resetAll, exportSettings, importSettings,
    }),
    [
      setIconScale, setColor, resetColors, setTokenSize, resetSizes, setLayerStyle, setUi,
      editRecord, revertRecord, addRecord, removeAddedRecord, clearDataEdits,
      setBorderRings, revertBorderCountry, clearBorderEdits, clearBorderNotice,
      resetAll, exportSettings, importSettings,
    ]
  );

  return { settings, adminMode, toggleAdminMode, actions, sync, borderNotice };
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
