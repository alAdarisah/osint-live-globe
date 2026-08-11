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
// Review note (worth carrying forward, not just fixing): reusing "unlawful
// interference (hijack)" verbatim was the right call for wording, but this
// task moves that parenthetical from a popup someone chose to open onto a
// strip that is visible to everyone, unasked, the moment it applies. The
// exposure of that phrase went up even though its wording did not change --
// see the header caveat and squawkAnnouncement below, both of which exist
// specifically to keep the qualifier attached to it everywhere it appears.
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
import { useEffect, useRef, useState } from "react";
import { aircraftEmergencyLine, AIRCRAFT_FLAG_NOTE } from "../map/decorators.js";
import {
  trackEmergencySquawks, dismissAlert, pruneDismissed, visibleAlerts, formatSquawkDuration,
  alertLabel, squawkAnnouncement,
} from "./squawkAlertsLogic.js";

// Independent of any network poll cadence -- this only needs to be frequent
// enough that "3m" becomes "4m" without a reader noticing the lag, not tied
// to when fresh data happens to arrive.
const DURATION_TICK_MS = 30000;

function AlertRow({ entry, nowMs, onSelect, onDismiss }) {
  const d = entry.aircraft;
  const label = alertLabel(entry);
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
        <span className="squawk-alert-callsign">{label}</span>
        {d.registration && d.registration !== label && (
          <span className="meta">{d.registration}</span>
        )}
        {d.type_desc && <span className="meta">{d.type_desc}</span>}
        <button
          type="button"
          className="squawk-alert-dismiss"
          // Matches the actual dismissal key (icao24 + signature, which folds
          // in both the squawk digits and the transponder's own `emergency`
          // field -- see squawkAlertsLogic.js's squawkSignature), not only
          // "squawk" on its own.
          title="Dismiss until this airframe's squawk or emergency status changes"
          // The qualifier belongs in the accessible name itself, not only in
          // a sibling header a screen reader may never visit while tabbing
          // through controls -- see the review note this file's own module
          // comment carries forward.
          aria-label={`Dismiss the emergency squawk alert for ${label} — squawks are occasionally set by mistake, not a confirmed incident`}
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

export default function SquawkAlertStrip({ aircraft, onSelect, panelOpen }) {
  const [tracked, setTracked] = useState({});
  const [dismissed, setDismissed] = useState({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The visually-hidden live region's own text -- see squawkAnnouncement's
  // own module note in squawkAlertsLogic.js for why this exists separately
  // from the visible strip's markup.
  const [announcement, setAnnouncement] = useState("");

  // trackEmergencySquawks needs the *previous* tracked snapshot to know
  // which entries are genuinely fresh -- kept in a ref rather than read from
  // the `tracked` state var so this effect does not need `tracked` in its
  // own dependency array (which would re-run it, and recompute a fresh
  // object, on every render this effect itself causes).
  const trackedRef = useRef({});

  useEffect(() => {
    const now = Date.now();
    const next = trackEmergencySquawks(trackedRef.current, aircraft, now);
    const prev = trackedRef.current;
    trackedRef.current = next;
    setTracked(next);
    // Critical fix: a dismissal must not outlive the tracking episode it was
    // recorded against, or an airframe that clears its squawk and later
    // squawks the identical code again stays silently suppressed -- see
    // pruneDismissed's own note in squawkAlertsLogic.js.
    setDismissed((d) => pruneDismissed(d, next));

    // Announce only entries whose firstSeenMs is *this* pass -- i.e. genuinely
    // fresh (a new icao24, or a changed signature, or a return after having
    // left `tracked` entirely) -- never merely because this effect re-ran or
    // the duration tick below forced a re-render. Otherwise a screen-reader
    // user would hear the same sentence repeated every poll for as long as
    // an aircraft kept squawking.
    const fresh = Object.values(next).filter((entry) => entry.firstSeenMs === now && (!prev[entry.icao24] || prev[entry.icao24].signature !== entry.signature));
    if (fresh.length) setAnnouncement(fresh.map(squawkAnnouncement).join(" "));
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

  return (
    <>
      {/* Always mounted, even with nothing to say -- a live region that only
          appears in the DOM once it already has content is a common
          accessibility trap: several screen readers announce *changes* to an
          existing node, not a freshly-inserted node that arrives
          pre-populated. Kept entirely separate from the visible strip below
          (which carries no aria-live of its own -- see that div's own note)
          because relying on the visible markup's own mutations was exactly
          the bug this was written to fix: several screen readers announce
          only the node that changed, which for a plain per-row squawk-meaning
          string means the caveat, sitting in a sibling header, is never
          heard. squawkAnnouncement (squawkAlertsLogic.js) builds one
          self-contained sentence per fresh alert instead, caveat included. */}
      <div aria-live="polite" role="status" className="sr-only">{announcement}</div>

      {/* No visible footprint at all when nothing is squawking -- matching
          every other panel on this map (e.g. AirfieldActivityPanel's own
          `if (!rows.length) return null`), and doubly right here: a strip
          that is always present, empty or not, would train a reader to stop
          looking at it. */}
      {alerts.length > 0 && (
        // Offsets clear of #controlPanel (Admin Mode's own drawer, open by
        // default on desktop, 320px wide, z-index 1000 -- above this strip's
        // own 970) the same way #map itself does: see #map.panel-open in
        // style.css, whose comment explains why the fixed 320px shift holds
        // regardless of the drawer's own content. Without this the strip's
        // header, caveat and leftmost cards render underneath the drawer for
        // exactly the reader -- an operator in Admin Mode -- most likely to
        // have it open.
        <div
          id="squawkAlertStrip"
          className={panelOpen ? "panel-open" : ""}
          role="region"
          aria-label="Emergency squawk alerts"
        >
          <div className="squawk-alert-header">
            <span className="squawk-alert-title">
              Emergency squawk{alerts.length === 1 ? "" : "s"} &middot; {alerts.length}
            </span>
            {/* The caveat appears once, here, rather than once per row below
                -- see the module note above. Pre-escaped HTML from
                decorators.js, same as aircraftEmergencyLine. */}
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
      )}
    </>
  );
}
