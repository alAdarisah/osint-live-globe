// Task 33: a live strip, above the map, listing every aircraft currently
// broadcasting one of the three reserved emergency squawks (7500/7600/7700)
// or a transponder-reported emergency status -- backend/sources/adsb.py has
// decoded these since before this task, and nothing surfaced them until now.
//
// The one thing this must not do is read like an incident report. Task 22
// already worked out the wording discipline for a single aircraft's own card
// (map/decorators.js's decorateAdsb): the emergency label appears once,
// always with its caveat, because 7500 is far more often a mis-set
// transponder than a hijacking. This strip is the same discipline applied to
// several aircraft at once -- the caveat (AIRCRAFT_FLAG_NOTE.emergency)
// appears once, in the header, rather than once per row, and every row's own
// squawk-meaning text is aircraftEmergencyLine(d), the identical string the
// card itself prints, not a second sentence composed to say the same thing.
//
// Data flows one way: createMapController.js's applyData reports the current
// emergency-squawking subset of raw.adsb the moment a fresh poll lands (see
// its own onEmergencySquawkChange note), useLeafletMap.js mirrors that into
// `emergencySquawks`, and App.jsx hands it here as `aircraft`. Nothing here
// fetches anything of its own -- there is no per-entity detail to fetch, only
// the already-live record every other aircraft popup already reads.
//
// "How long it has been squawking" is not a field the backend stores (a
// squawk is a snapshot of the current transponder state, not an event with a
// start time) -- so this strip is the one place that timestamp is derived,
// client-side, the moment a squawk is first seen in a poll. That means the
// clock resets on a page reload and is scoped to this browser tab, which is
// an honest limitation given there is nowhere upstream to read a real start
// time from. All of the tracking/dismissal/duration logic lives in the pure
// sibling module squawkAlertsLogic.js, for the same reason every other
// panel's own logic does: this file is JSX and frontend/tests/*.test.js
// (node --test, no build step) cannot import JSX at all.
import { useEffect, useState } from "react";
import { aircraftEmergencyLine, AIRCRAFT_FLAG_NOTE } from "../map/decorators.js";
import {
  trackEmergencySquawks, dismissAlert, visibleAlerts, formatSquawkDuration,
} from "./squawkAlertsLogic.js";

// Independent of any network poll cadence -- this only needs to be frequent
// enough that "3m" becomes "4m" without a reader noticing the lag, not tied
// to when fresh data happens to arrive.
const DURATION_TICK_MS = 30000;

function squawkAlertLabel(entry) {
  const d = entry.aircraft;
  return d.callsign || d.registration || d.icao24;
}

function AlertRow({ entry, nowMs, onSelect, onDismiss }) {
  const d = entry.aircraft;
  const hasPosition = Number.isFinite(d.lat) && Number.isFinite(d.lon);
  const seconds = Math.max(0, (nowMs - entry.firstSeenMs) / 1000);
  return (
    <div
      className="squawk-alert-item"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(d.icao24)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(d.icao24);
        }
      }}
    >
      <div className="squawk-alert-item-row">
        <span className="squawk-alert-callsign">{squawkAlertLabel(entry)}</span>
        {d.registration && d.registration !== squawkAlertLabel(entry) && (
          <span className="meta">{d.registration}</span>
        )}
        {d.type_desc && <span className="meta">{d.type_desc}</span>}
        <button
          type="button"
          className="squawk-alert-dismiss"
          title="Dismiss until this airframe's squawk changes"
          aria-label={`Dismiss the emergency alert for ${squawkAlertLabel(entry)}`}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(entry.icao24, entry.signature);
          }}
          // keydown bubbles even though click was stopped above -- without
          // this, pressing Enter/Space on the dismiss button also fires the
          // row's own onKeyDown and flies to/selects the aircraft the same
          // keypress was meant to dismiss.
          onKeyDown={(e) => e.stopPropagation()}
        >
          &times;
        </button>
      </div>
      <div
        className="squawk-alert-meaning"
        // aircraftEmergencyLine's own output -- pre-escaped HTML from
        // map/decorators.js, the same string decorateAdsb prints on the
        // aircraft card itself. See the module note above for why this is
        // never re-composed here.
        dangerouslySetInnerHTML={{ __html: aircraftEmergencyLine(d) }}
      />
      <div className="squawk-alert-item-row meta">
        <span>{hasPosition ? `${d.lat.toFixed(2)}, ${d.lon.toFixed(2)}` : "position not stated"}</span>
        <span>squawking for {formatSquawkDuration(seconds)}</span>
      </div>
    </div>
  );
}

export default function SquawkAlertStrip({ aircraft, onSelect }) {
  const [tracked, setTracked] = useState({});
  const [dismissed, setDismissed] = useState({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Folds each fresh snapshot into the running record -- see
  // trackEmergencySquawks's own note on why this is keyed by icao24 and what
  // resets a "since when" clock versus what carries it forward.
  useEffect(() => {
    setTracked((prev) => trackEmergencySquawks(prev, aircraft, Date.now()));
  }, [aircraft]);

  // Keeps the printed durations moving even between polls -- see
  // DURATION_TICK_MS above.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), DURATION_TICK_MS);
    return () => clearInterval(id);
  }, []);

  function handleDismiss(icao24, signature) {
    setDismissed((prev) => dismissAlert(prev, icao24, signature));
  }

  const alerts = visibleAlerts(tracked, dismissed);

  // No footprint at all when nothing is squawking -- matching every other
  // panel on this map (e.g. AirfieldActivityPanel's own `if (!rows.length)
  // return null`), and doubly right here: a strip that is always present,
  // empty or not, would train a reader to stop looking at it.
  if (!alerts.length) return null;

  return (
    // aria-live="polite" rather than role="alert" (which implies "assertive"
    // and interrupts whatever a screen-reader user is doing): the whole point
    // of the caveat this strip carries is that a fresh entry is more often a
    // mis-set transponder than an emergency, so it should announce the same
    // way any other panel update does, not the way a genuine interruption
    // would.
    <div id="squawkAlertStrip" role="region" aria-live="polite" aria-label="Emergency squawk alerts">
      <div className="squawk-alert-header">
        <span className="squawk-alert-title">
          Emergency squawk{alerts.length === 1 ? "" : "s"} &middot; {alerts.length}
        </span>
        {/* The caveat appears once, here, rather than once per row below --
            see the module note above. Pre-escaped HTML from decorators.js,
            same as aircraftEmergencyLine. */}
        <p
          className="squawk-alert-caveat meta"
          dangerouslySetInnerHTML={{ __html: AIRCRAFT_FLAG_NOTE.emergency }}
        />
      </div>
      <div className="squawk-alert-list">
        {alerts.map((entry) => (
          <AlertRow
            key={entry.icao24}
            entry={entry}
            nowMs={nowMs}
            onSelect={onSelect}
            onDismiss={handleDismiss}
          />
        ))}
      </div>
    </div>
  );
}
