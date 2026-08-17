import { useClock } from "../../hooks/useClock";
import { sumCountReadout, countReadout, liveReadout } from "./hudLogic";

/**
 * One of the right-hand figures. Dimmed and dashed when the feeds behind it
 * have not answered -- see hudLogic.js's own note on why a confident 0 over a
 * dead feed is the worst thing a status readout can do.
 */
function TopStat({ id, label, readout, tone }) {
  return (
    <span className={`top-stat${readout.known ? "" : " unknown"}`} title={readout.title}>
      <span className={`top-stat-value${tone ? ` ${tone}` : ""}`} id={id}>{readout.text}</span>
      <span className="top-stat-label">{label}</span>
    </span>
  );
}

/**
 * The top bar: who this is, whether it is live, what is on the map, and what
 * time it is there.
 *
 * Replaces TitleBar.jsx. Two things moved out rather than being dropped: the
 * place search, Copy link, Export and Admin all went down to the sub bar (they
 * are actions, and the sub bar is the row of actions), while the clock and the
 * theme toggle stayed here because they are facts about the page rather than
 * things done to it.
 *
 * `children` is the category pill strip. Passed in rather than imported so this
 * file stays a layout and the pills stay a control -- they own a great deal of
 * layer state and none of it belongs to a bar.
 */
export default function TopBar({ theme, onToggleTheme, counts, isReplaying, replayAt, children }) {
  const clock = useClock();
  const live = liveReadout({ isReplaying, replayAt });

  return (
    <header id="topBar">
      <span className="brand">OSINT LIVE GLOBE</span>

      {/* Not decoration. Once the replay scrubber became something a reader can
          reach (see App.jsx's note on what replaced the Admin-Mode-only rule),
          "is this now?" stopped being a question with one permanent answer, and
          this is the always-visible half of that answer -- the scrub strip and
          the HUD carry the other two. */}
      <span
        className={`brand-live${live.live ? "" : " replaying"}`}
        title={live.title}
        aria-live="polite"
      >
        <span className="brand-live-dot" />
        {live.text}
      </span>

      <span className="cat-strip">{children}</span>

      <span className="top-bar-right">
        <TopStat
          id="statAircraft"
          label="Aircraft"
          tone="accent"
          readout={sumCountReadout(counts, ["adsbCivilian", "adsbMilitary"], "aircraft")}
        />
        {/* All four vessel layers, including the Baltic one. aisDigitraffic is a
            separately counted layer from a second supplier (Fintraffic), and
            leaving it out of the sum meant this stat read "—" during an aisstream
            outage while the map was drawing several hundred Finnish ships. That
            outage is not hypothetical: aisstream has been silent for days at a
            time, which is the entire reason a second supplier exists, and this
            cell is one of the places a reader would look to find out. */}
        <TopStat
          id="statVessels"
          label="Vessels"
          tone="accent"
          readout={sumCountReadout(counts, ["aisCivilian", "aisNavy", "aisTanker", "aisDigitraffic"], "vessels")}
        />
        <TopStat
          id="statEvents"
          label="Events"
          tone="danger"
          readout={countReadout(counts, "events", "conflict events")}
        />

        {/* The full date rides along as the title rather than being formatted
            away: on a map whose subject is when things happened, "has this
            rolled over midnight" is a question a reader actually asks. */}
        <span className="top-clock" title={clock.full}>
          <span id="clock">{clock.time}</span>
          <span className="top-clock-zone">ZULU</span>
        </span>

        <button
          id="themeToggle"
          className="icon-btn"
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          title="Toggle light/dark mode"
          onClick={onToggleTheme}
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
      </span>
    </header>
  );
}
