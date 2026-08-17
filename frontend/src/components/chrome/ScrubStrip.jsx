import { liveReadout } from "./hudLogic";

/**
 * Where in the past the map currently is, and the way back to now.
 *
 * Replay used to be Admin Mode's alone, and the argument for that was recorded
 * in App.jsx: scrubbing "replaces every live feed with a snapshot, and a reader
 * who found it by accident would be looking at a map that had quietly stopped
 * being live". The word doing the work there is *quietly* -- the objection was
 * never that readers should not have the control, it was that nothing on screen
 * said what the control had done.
 *
 * So the control ships with the thing that was missing, in three places at
 * once: this strip, which only exists while the map is not live and states the
 * moment it is showing; the top bar's LIVE badge, which goes dark and stops
 * pulsing; and the HUD's own NOT LIVE cell. A reader cannot now be scrubbed
 * back without three separate parts of the chrome saying so.
 *
 * Renders nothing at all while live -- a permanently visible scrubber parked at
 * the right-hand end is exactly the "quietly" this is answering, and it is also
 * 34px of map spent on a control almost nobody is using.
 */
export default function ScrubStrip({ isReplaying, isPlaying, replayAt, bounds, onScrub, onTogglePlay, onGoLive }) {
  if (!isReplaying) return null;
  const live = liveReadout({ isReplaying, replayAt });
  const at = Number.isFinite(replayAt) ? new Date(replayAt) : null;

  return (
    <div id="scrubStrip" role="group" aria-label="Replay position">
      <button
        type="button"
        className="scrub-play"
        onClick={onTogglePlay}
        title={isPlaying ? "Pause replay" : "Play replay"}
        aria-label={isPlaying ? "Pause replay" : "Play replay"}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>

      {/* The moment being shown, in full and in UTC. Not a relative age: "3
          hours ago" is a number that keeps changing while the map does not, and
          the thing a reader needs here is the timestamp they would quote. */}
      <span className="scrub-at" title={live.title}>
        {at ? at.toISOString().replace("T", " ").slice(0, 16) : "—"} UTC
      </span>

      <input
        type="range"
        className="scrub-range"
        min={bounds.min}
        max={bounds.max}
        step={60000}
        value={replayAt}
        onChange={(e) => onScrub(Number(e.target.value))}
        aria-label="Scrub the replay position"
      />

      <button type="button" className="scrub-live" onClick={onGoLive}>
        <span className="live-dot" /> Go live
      </button>
    </div>
  );
}
