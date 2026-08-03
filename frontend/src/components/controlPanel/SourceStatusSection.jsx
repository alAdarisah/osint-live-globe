export default function SourceStatusSection({ health }) {
  const rows = Object.entries(health).filter(([name]) => name !== "owm_weather"); // driven into WeatherSection instead, not a polled source

  return (
    <>
      <h2>Source status</h2>
      <ul id="healthList">
        {rows.map(([name, info]) => {
          let cls = "err";
          if (!info.key_configured && info.last_error) cls = "warn";
          if (info.last_success && info.seconds_since_success < 1800) cls = "ok";
          const age = info.seconds_since_success != null ? `${info.seconds_since_success}s ago` : "never";
          return (
            <li key={name}>
              <span className={`dot ${cls}`} /> {name.toUpperCase()}: {info.item_count} items, updated {age}
              {info.last_error ? ` — ${info.last_error}` : ""}
            </li>
          );
        })}
      </ul>
    </>
  );
}
