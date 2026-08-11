import { dotPeriod } from "../../utils/tempo";

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
          let cls = "err";
          if (!info.key_configured && info.last_error) cls = "warn";
          if (info.last_success && info.seconds_since_success < 1800) cls = "ok";
          const age = info.seconds_since_success != null ? `${info.seconds_since_success}s ago` : "never";
          const period = dotPeriod(info.seconds_since_success);
          return (
            <li key={name}>
              <span
                className={`dot ${cls}${period ? " breathing" : ""}`}
                style={period ? { "--period": period } : undefined}
              />{" "}
              {name.toUpperCase()}: {info.item_count} items, updated {age}
              {info.last_error ? ` — ${info.last_error}` : ""}
            </li>
          );
        })}
      </ul>
    </>
  );
}
