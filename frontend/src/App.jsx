// Top-level orchestrator. Wires the map (useLeafletMap), the data/region
// layer (useOsintData), and a handful of small standalone hooks (theme,
// clock, health, viewport) together, then hands their state down to plain
// presentational components. No component below this one talks to the
// network or to Leaflet directly -- see src/map/ and src/hooks/ for that.
import { useCallback, useRef, useState } from "react";

import { useLeafletMap } from "./map/useLeafletMap";
import { useOsintData } from "./hooks/useOsintData";
import { useReplay } from "./hooks/useReplay";
import { useTheme } from "./hooks/useTheme";
import { useHealth } from "./hooks/useHealth";
import { useIsMobileViewport } from "./hooks/useIsMobileViewport";

import LoadingScreen from "./components/LoadingScreen";
import MapView from "./components/MapView";
import TitleBar from "./components/TitleBar";
import RegionBar from "./components/RegionBar";
import NewsBroadcastPanel from "./components/NewsBroadcastPanel";
import PanelToggle from "./components/PanelToggle";
import ControlPanel from "./components/controlPanel/ControlPanel";
import TimelineBar from "./components/TimelineBar";
import Attribution from "./components/Attribution";

const DEFAULT_LAYER_VISIBILITY = {
  acled: true, firms: true, ais: true, gdelt: true, adsb: true,
  countries: true, cities: true,
  precip: true, clouds: false, wind: false, windArrows: true,
};

export default function App() {
  const mapContainerRef = useRef(null);
  const { theme, toggleTheme } = useTheme();
  const isMobileViewport = useIsMobileViewport();

  // Panel starts open on desktop, but an 85vw-wide open drawer would cover
  // most of a small screen on first load, so it starts closed on phones
  // (see the mobile media query in style.css, where the panel becomes an
  // overlay instead of pushing the map).
  const [panelOpen, setPanelOpen] = useState(() => !isMobileViewport);

  // useLeafletMap and useOsintData each need something the *other* produces
  // (the map needs to tell data-land about an auto-reset; data-land needs
  // the map's flyToRegion/applyData) -- broken via one ref-indirection
  // instead of merging the two hooks into one, so each still reads as a
  // single, focused concern to `git blame`/skim.
  const regionAutoResetRef = useRef(() => {});
  const mapApi = useLeafletMap(mapContainerRef, {
    theme,
    onRegionAutoReset: () => regionAutoResetRef.current(),
  });

  // While the replay timeline is scrubbed back, live poller ticks must not
  // overwrite whatever past moment is on screen -- this ref (rather than a
  // useOsintData prop) is the gate, so useOsintData itself stays unaware
  // replay even exists. Cheap ref instead of state since flipping it never
  // needs to trigger a re-render on its own.
  const replayActiveRef = useRef(false);
  const dataApi = useOsintData({
    onData: (key, data) => {
      if (!replayActiveRef.current) mapApi.applyData(key, data);
    },
    flyToRegion: mapApi.flyToRegion,
  });
  regionAutoResetRef.current = dataApi.resetRegionToWorld;

  const replayApi = useReplay({
    applyData: mapApi.applyData,
    currentRegionKey: dataApi.currentRegionKey,
    onExitReplay: dataApi.refetchAllNow,
  });
  replayActiveRef.current = replayApi.isReplaying;

  const { health, owmConfigured } = useHealth();

  const [layerVisibility, setLayerVisibility] = useState(DEFAULT_LAYER_VISIBILITY);
  const onToggleLayer = useCallback(
    (key, visible) => {
      setLayerVisibility((prev) => ({ ...prev, [key]: visible }));
      mapApi.setLayerVisible(key, visible);
    },
    [mapApi.setLayerVisible]
  );

  const togglePanel = useCallback(() => {
    setPanelOpen((prev) => {
      const next = !prev;
      setTimeout(() => mapApi.invalidateSize(), 230); // after the CSS transition finishes
      return next;
    });
  }, [mapApi.invalidateSize]);

  const onLocateNewsItem = useCallback(
    (lat, lon) => mapApi.flyTo(lat, lon, 7),
    [mapApi.flyTo]
  );

  return (
    <>
      <LoadingScreen sources={dataApi.bootSources} />

      <MapView containerRef={mapContainerRef} panelOpen={panelOpen} />

      <TitleBar theme={theme} onToggleTheme={toggleTheme} />

      <RegionBar regions={dataApi.regions} currentRegionKey={dataApi.currentRegionKey} onSelect={dataApi.selectRegion} />

      <NewsBroadcastPanel
        gdeltRaw={dataApi.gdeltRaw}
        mapBounds={mapApi.mapBounds}
        regionLabel={dataApi.currentRegionLabel}
        isMobileViewport={isMobileViewport}
        onLocate={onLocateNewsItem}
      />

      <PanelToggle open={panelOpen} onToggle={togglePanel} />

      <ControlPanel
        open={panelOpen}
        counts={mapApi.counts}
        zoomNotes={mapApi.zoomNotes}
        layerVisibility={layerVisibility}
        onToggleLayer={onToggleLayer}
        health={health}
        owmConfigured={owmConfigured}
      />

      <TimelineBar
        isReplaying={replayApi.isReplaying}
        isPlaying={replayApi.isPlaying}
        replayAt={replayApi.replayAt}
        bounds={replayApi.bounds}
        onScrub={replayApi.scrubTo}
        onTogglePlay={replayApi.togglePlay}
        onGoLive={replayApi.goLive}
      />

      <Attribution />
    </>
  );
}
