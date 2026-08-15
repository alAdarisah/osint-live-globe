// Pure logic behind AlertToast.jsx (Task 42) -- split into a plain module
// for the same reason squawkAlertsLogic.js is: the toast itself is JSX, and
// this project's headless test suite (`node --test`, no build step) cannot
// import JSX at all -- see frontend/tests/alertToastLogic.test.js.
//
// The toast's whole text is `alert.detail`, composed server-side by
// backend/alert_rules.py's evaluate_rules -- there is deliberately nothing
// here that builds a sentence out of the alert's fields. That keeps the one
// user-authored piece of a rule (its name) out of frontend string
// concatenation entirely; the backend is what already has to treat it as
// untrusted text on the way to a webhook (see that module's own note), and
// composing a second copy of the same sentence here would just be a second
// place that discipline could slip.

/** Does this /api/health alert belong to a Task 42 rule, as opposed to a
 *  source-health condition (Redis, a stalled producer, ...)? Both ride the
 *  same `alerts` array (see backend/app.py's health()), told apart only by
 *  the "rule:" subject prefix backend/alert_rules.py's SUBJECT_PREFIX
 *  stamps on every one it fires. */
export function isRuleAlert(alert) {
  return typeof alert?.subject === "string" && alert.subject.startsWith("rule:");
}

function alertKey(alert) {
  return `${alert.subject}::${alert.condition}`;
}

/**
 * Fold one /api/health poll into the running "which rule alerts has this
 * tab already toasted" record.
 *
 * `prevShown` and the returned `shown` are both a plain {key: true} set,
 * the same shape squawkAlertsLogic.js's dismissed record uses and for the
 * same reason: a key is dropped the moment its alert is no longer in
 * `alerts` at all (resolved), not merely because a toast for it already
 * fired -- so a rule that resolves and later fires again (this task's own
 * required behaviour, and backend/alert_rules.py's whole reason for being
 * level-triggered) reaches this tab as fresh, not as something already
 * shown once, weeks ago, and suppressed for ever after.
 *
 * `fresh` is every currently-firing rule alert this tab has not yet
 * toasted -- what the caller actually pushes onto the visible stack. Bounded
 * the same way `shown` is: only alerts presently in `alerts` are ever kept,
 * so this can never grow across a session the way an unbounded per-entity
 * memo would (the exact defect this plan's own brief calls out).
 */
export function foldHealthAlerts(prevShown, alerts) {
  const ruleAlerts = (Array.isArray(alerts) ? alerts : []).filter(isRuleAlert);
  const shown = {};
  const fresh = [];
  for (const alert of ruleAlerts) {
    const key = alertKey(alert);
    shown[key] = true;
    if (!prevShown || !prevShown[key]) fresh.push({ key, alert });
  }
  // Every key not rebuilt above (an alert that resolved since the last poll)
  // is simply absent from `shown` -- that is the prune. A rule that later
  // fires again is therefore indistinguishable from one firing for the
  // first time, which is exactly the point: see this function's own note.
  return { shown, fresh };
}
