// Task 31: WebGL sprite cap, satellite propagation cadence, the poll-
// interval multiplier, whether polling pauses on a backgrounded tab, and the
// per-class trail point budget -- six dials over what used to be bare
// constants inside map/createMapController.js (see that file's own note by
// SHIP_TRAIL_MAX_POINTS/setPerformanceOptions) plus useOsintData.js's own
// scheduling loop. Every default here matches this map's actual, pre-Task-31
// behaviour -- see settings/defaults.js's own note on the `performance`
// block for which values are a carried-forward constant and which (the
// sprite cap) never existed as a limit before this task.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { SliderField, CheckField } from "../fields";

export const SEARCH_TERMS = [
  "Performance",
  "WebGL sprite cap",
  "Satellite propagation cadence",
  "Poll interval multiplier",
  "Pause polling when the tab is hidden",
  "Track point budget",
  "Trail points",
];

export default function PerformanceSection({ settings, actions, isOpen, onToggle }) {
  const perf = settings.performance;

  return (
    <PanelGroup id="adm-performance" title="Performance" open={isOpen("adm-performance")} onToggle={onToggle}>
      <div className="admin-note">
        For a reader on weaker hardware or a metered connection. Every dial here defaults to exactly
        what this map already does -- opening this section and leaving it alone changes nothing.
      </div>

      <div className="admin-subhead">WebGL sprite cap</div>
      <div className="admin-note">
        A ceiling on how many ships/aircraft draw per bucket (civilian ships, tankers, navy hulls;
        civilian/military/flagged aircraft) -- on top of whatever LAYER_MANIFEST's own per-band cap
        already thins that bucket to, and applied per bucket, not as one combined total. No limit by
        default.
      </div>
      <SliderField
        label="Sprite cap per bucket"
        value={perf.webglSpriteCap ?? 20_000}
        defaultValue={20_000}
        min={50}
        max={20_000}
        step={50}
        format={(v) => (v >= 20_000 ? "no cap" : String(v))}
        onChange={(value) => actions.setPerformance({ webglSpriteCap: value >= 20_000 ? null : value })}
      />

      <div className="admin-subhead">Satellite propagation cadence</div>
      <div className="admin-note">
        How often a real SGP4 pass recomputes each satellite group's position (see
        map/satPropagate.js) -- not how often the drawn position redraws, which is a fixed 2s
        interpolation loop this dial does not reach.
      </div>
      <SliderField
        label="Small groups (navigation, weather, science, geostationary)"
        value={perf.satSmallCadenceMs}
        defaultValue={10_000}
        min={2_000}
        max={60_000}
        step={1_000}
        format={(v) => `${(v / 1000).toFixed(0)}s`}
        onChange={(value) => actions.setPerformance({ satSmallCadenceMs: value })}
      />
      <SliderField
        label="Large groups (imaging, Starlink, OneWeb)"
        value={perf.satLargeCadenceMs}
        defaultValue={60_000}
        min={10_000}
        max={300_000}
        step={5_000}
        format={(v) => `${(v / 1000).toFixed(0)}s`}
        onChange={(value) => actions.setPerformance({ satLargeCadenceMs: value })}
      />

      <div className="admin-subhead">Polling</div>
      <SliderField
        label="Poll interval multiplier"
        value={perf.pollIntervalMultiplier}
        defaultValue={1}
        min={0.25}
        max={10}
        step={0.25}
        format={(v) => `${v.toFixed(2)}x`}
        onChange={(value) => actions.setPerformance({ pollIntervalMultiplier: value })}
      />
      <CheckField
        label="Pause polling when the tab is hidden"
        note="On by default: a backgrounded tab skips its network round-trips and catches up the instant it is focused again. Switch off to keep a background tab (a second monitor, an always-on dashboard) current at the cost of the traffic this saves."
        checked={perf.pausePollingWhenHidden}
        onChange={(value) => actions.setPerformance({ pausePollingWhenHidden: value })}
      />

      <div className="admin-subhead">Track point budget</div>
      <div className="admin-note">
        How many recent positions the selected ship/aircraft trail (or the always-on tanker trails)
        keeps before trimming from the front -- also what /api/track is asked for, so a seed longer
        than this cap would just be eaten one point per poll.
      </div>
      <SliderField
        label="Ship trail"
        value={perf.shipTrailPoints}
        defaultValue={300}
        min={20}
        max={1200}
        step={20}
        onChange={(value) => actions.setPerformance({ shipTrailPoints: value })}
      />
      <SliderField
        label="Aircraft trail"
        value={perf.aircraftTrailPoints}
        defaultValue={400}
        min={20}
        max={1200}
        step={20}
        onChange={(value) => actions.setPerformance({ aircraftTrailPoints: value })}
      />
      <SliderField
        label="Tanker trail"
        value={perf.tankerTrailPoints}
        defaultValue={60}
        min={10}
        max={400}
        step={10}
        onChange={(value) => actions.setPerformance({ tankerTrailPoints: value })}
      />
      <SliderField
        label="Satellite trail"
        value={perf.satelliteTrailPoints}
        defaultValue={36}
        min={5}
        max={200}
        step={1}
        onChange={(value) => actions.setPerformance({ satelliteTrailPoints: value })}
      />
    </PanelGroup>
  );
}
