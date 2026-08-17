import { dotPeriod } from "../../utils/tempo";
import { sourceState, sourceStateLabel, sourceLatenessNote } from "../../utils/sourceState";

export default function SourceStatusSection({ health }) {
  // /api/health carries the per-source states plus an `alerts` array from the
  // cache worker (see backend/cacheworker). Filtering on shape rather than on a
  // list of names: anything without an item_count is not a source row, so a
  // future addition to that payload can't render as a source with undefined
  // everything.
  const rows = Object.entries(health).filter(
    ([name, info]) => name !== "owm_weather" && info && typeof info === "object" && "item_count" in info,
  ); // owm_weather is driven into WeatherSection instead, not a polled source
  const alerts = Array.isArray(health.alerts) ? health.alerts : [];

  return (
    <>
      {alerts.length > 0 && (
        <>
          <h2>Alerts</h2>
          <ul id="alertList">
            {alerts.map((alert) => (
              <li key={`${alert.subject}:${alert.condition}`}>
                <span className={`dot ${alert.severity === "critical" ? "err" : "warn"}`} />{" "}
                {alert.subject.toUpperCase()}: {alert.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Source status</h2>
      <ul id="healthList">
        {rows.map(([name, info]) => {
          // Imported, not restated. This was a hand-copy of the strip's own
          // predicate, and both applied a flat half-hour threshold to sources
          // whose real cadences run from ten seconds to seven days -- so this list
          // called a weekly reference set "failing" three hours after it had
          // fetched successfully, with no error to show for it. See
          // utils/sourceState.js.
          const cls = sourceState(info);
          const age = info.seconds_since_success != null ? `${info.seconds_since_success}s ago` : "never";
          const period = dotPeriod(info.seconds_since_success);
          // How late it is by its own standards, which is the fact this row was
          // missing. Only worth saying when something is off; a source inside its
          // own window has the age above and needs no arithmetic.
          const lateness = cls === "ok" ? null : sourceLatenessNote(info);
          return (
            <li key={name}>
              <span
                className={`dot ${cls}${period ? " breathing" : ""}`}
                style={period ? { "--period": period } : undefined}
                title={sourceStateLabel(cls)}
              />{" "}
              {name.toUpperCase()}: {info.item_count} items, updated {age}
              {cls !== "ok" ? ` — ${sourceStateLabel(cls)}` : ""}
              {lateness ? ` (${lateness})` : ""}
              {info.last_error ? ` — ${info.last_error}` : ""}
            </li>
          );
        })}
      </ul>
    </>
  );
}
