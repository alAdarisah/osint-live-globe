// Task 42: the toast half of "tell me when X happens here, and tell me
// once". A rule fires on the backend (backend/alert_rules.py, evaluated by
// the cache worker) and lands in the `alerts` array /api/health already
// serves -- this component is the only thing that watches that array for a
// "rule:" entry it has not shown yet and turns it into a card that appears,
// says its piece, and goes away on its own.
//
// It rides useHealth's existing poll (App.jsx already fetches /api/health
// for every session, admin or not -- see that hook's own note) rather than
// opening a second connection: a rule that starts firing shows up here
// within one poll cycle, exactly like "Redis is unreachable" shows up in
// the Source status fold today. There is no WebSocket, no SSE, nothing new
// to keep alive -- see backend/alert_rules.py's own module docstring for
// why that delivery path was the deliberate choice over building one.
//
// All of the tracking (which alerts this tab has already toasted, and why a
// resolved-then-refired alert must toast again) lives in the pure sibling
// module alertToastLogic.js, for the same reason every other panel's own
// logic does: this file is JSX and frontend/tests/*.test.js (node --test,
// no build step) cannot import JSX at all.
import { useEffect, useRef, useState } from "react";
import { foldHealthAlerts } from "./alertToastLogic";

// Long enough to read a sentence, short enough that a reader who fires
// several rules in a row is not staring at a wall of cards -- the same
// "coarse enough to be readable, not a live stopwatch" calibration
// squawkAlertsLogic.js's formatSquawkDuration uses for a different number.
const AUTO_DISMISS_MS = 12000;

export default function AlertToast({ alerts }) {
  // {key: {key, alert, id}}, insertion order -- a plain object rather than
  // an array so a toast can be removed by key (on its own timer, or by a
  // click) without hunting for its index.
  const [visible, setVisible] = useState({});
  const shownRef = useRef({});

  useEffect(() => {
    const { shown, fresh } = foldHealthAlerts(shownRef.current, alerts);
    shownRef.current = shown;
    if (!fresh.length) return;
    setVisible((prev) => {
      const next = { ...prev };
      for (const { key, alert } of fresh) next[key] = alert;
      return next;
    });
  }, [alerts]);

  function dismiss(key) {
    setVisible((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const entries = Object.entries(visible);
  // No footprint at all with nothing to say -- the same rule
  // SquawkAlertStrip.jsx's own visible list follows, so a reader is never
  // trained to keep glancing at an empty corner of the screen.
  if (!entries.length) return null;

  return (
    <div id="alertToastStack" role="region" aria-label="Rule alerts">
      {entries.map(([key, alert]) => (
        <AlertToastCard key={key} alertKey={key} alert={alert} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function AlertToastCard({ alertKey, alert, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(alertKey), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDismiss is a
    // stable setState wrapper from the parent's own useState identity, not
    // a value this timer needs to re-arm over.
  }, [alertKey]);

  return (
    <div className="alert-toast" role="status">
      <div className="alert-toast-row">
        <span className={`dot ${alert.severity === "critical" ? "err" : "warn"}`} />
        <span className="alert-toast-label">Alert</span>
        <button
          type="button"
          className="alert-toast-dismiss"
          aria-label="Dismiss this alert"
          onClick={() => onDismiss(alertKey)}
        >
          &times;
        </button>
      </div>
      {/* alert.detail is composed entirely server-side (backend/alert_rules.py's
          evaluate_rules) -- see this file's own module note and
          alertToastLogic.js's for why nothing here builds a second copy of
          the same sentence out of the rule's own fields. */}
      <p className="alert-toast-detail">{alert.detail}</p>
    </div>
  );
}
