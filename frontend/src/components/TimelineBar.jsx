// Bottom-of-screen replay scrubber. Deliberately minimal: one slider
// spanning the last 3 days, a play/pause button, and a "Go live" button --
// no speed picker, no per-layer controls. See useReplay.js for the actual
// timestamp/playback/fetch logic this just renders.
function fmtReplayTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TimelineBar({ isReplaying, isPlaying, replayAt, bounds, onScrub, onTogglePlay, onGoLive }) {
  return (
    <div id="timelineBar" className={isReplaying ? "replaying" : ""}>
      <button
        type="button"
        className="timeline-play"
        onClick={onTogglePlay}
        title={isPlaying ? "Pause replay" : "Play replay"}
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
  );
}
