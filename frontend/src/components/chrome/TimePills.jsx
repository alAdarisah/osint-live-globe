import { WINDOW_OPTIONS } from "../intelPanelLogic";

/**
 * How far back the map is looking, as a joined row of pills.
 *
 * The same choice the feed panel's Window select offers, and deliberately the
 * same *value*: both read `windowHours` from App.jsx and both write it back.
 * Two controls over one number cannot disagree; two controls each holding their
 * own copy is the arrangement Task 12's review removed once already.
 *
 * A filter, not a replay. Nothing here takes the map off live -- it narrows
 * which records are drawn and listed. The scrub strip is the control that stops
 * the map being now, and it says so in three places when it does.
 */
export default function TimePills({ windowHours, onChange }) {
  return (
    <div className="time-pills" role="group" aria-label="How far back to look">
      {WINDOW_OPTIONS.map((opt) => {
        const active = opt.hours === windowHours;
        return (
          <button
            key={opt.pill}
            type="button"
            className={`tp${active ? " active" : ""}`}
            aria-pressed={active}
            title={`Show the last ${opt.label}`}
            onClick={() => onChange?.(opt.hours)}
          >
            {opt.pill}
          </button>
        );
      })}
    </div>
  );
}
