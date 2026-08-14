// Bottom-of-screen replay scrubber. One slider spanning the last 3 days, a
// play/pause button (Task 44: now settings-driven cadence/step, prefetching
// with an observable degrade, see hooks/useReplay.js), a "Go live" button,
// and (Task 44) a row showing which of the replayed kinds actually have
// history. See useReplay.js for the timestamp/playback/fetch logic this
// just renders, and replay/availability.js for every string below the date
// label -- kept out of this file on purpose, since it is JSX and node --test
// cannot import it to check the wording directly.
import {
  REPLAY_KINDS, kindLabel, kindStatusBadge, describeKindAvailability,
  describePlaybackDegraded, playbackDegradedBadge,
} from "../replay/availability";

function fmtReplayTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One kind's dot in the availability row -- a CSS class per status so the
 *  stylesheet can give "no data" and "unavailable" visibly different
 *  treatment, never the same "just empty" look. */
function statusClass(status) {
  if (status === "ok") return "timeline-kind-ok";
  if (status === "no_history") return "timeline-kind-no-history";
  if (status === "unavailable") return "timeline-kind-unavailable";
  if (status === "refused") return "timeline-kind-refused";
  if (status === "error") return "timeline-kind-error";
  return "timeline-kind-checking";
}

export default function TimelineBar({
  isReplaying, isPlaying, replayAt, bounds, onScrub, onTogglePlay, onGoLive,
  configuredStepMinutes, playbackStepMinutes, playbackDegraded, kindAvailability,
}) {
  const degradeNote = playbackDegraded
    ? describePlaybackDegraded(configuredStepMinutes, playbackStepMinutes)
    : null;
  const degradeBadge = playbackDegraded ? playbackDegradedBadge(playbackStepMinutes) : null;

  return (
    <>
      {/* A second, thin strip above the main bar rather than crowding it --
          only shown while replaying, since kind_has_history has nothing to
          say about the live map. */}
      {isReplaying && (
        <div className="timeline-kinds-row" aria-label="Which kinds have history for this window">
          {REPLAY_KINDS.map(({ key }) => {
            const status = kindAvailability?.[key]; // undefined while kindAvailability is still {} (in flight)
            return (
              <span
                key={key}
                className={`timeline-kind ${statusClass(status)}`}
                title={describeKindAvailability(key, status)}
              >
                <span className="timeline-kind-dot" aria-hidden="true" />
                {kindLabel(key)}: {kindStatusBadge(status)}
              </span>
            );
          })}
          {degradeBadge && (
            <span className="timeline-kind timeline-degraded-note" title={degradeNote}>
              {degradeBadge}
            </span>
          )}
        </div>
      )}

      <div id="timelineBar" className={isReplaying ? "replaying" : ""}>
        <button
          type="button"
          className="timeline-play"
          onClick={onTogglePlay}
          title={isPlaying ? "Pause replay" : "Play replay (last 24 hours)"}
          aria-label={isPlaying ? "Pause replay" : "Play replay"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>

        <input
          type="range"
          className="timeline-slider"
          min={bounds.min}
          max={bounds.max}
          step={60000}
          value={replayAt}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Scrub timeline"
        />

        <span className="timeline-label">{isReplaying ? fmtReplayTime(replayAt) : "LIVE"}</span>

        <button type="button" className="timeline-live-btn" onClick={onGoLive} disabled={!isReplaying}>
          <span className="live-dot" /> Live
        </button>
      </div>
    </>
  );
}
