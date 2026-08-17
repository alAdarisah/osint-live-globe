import { ACTIVITY_CHIPS } from "./feedItemLogic";

/**
 * The coarse category filter over the Activity and Events tabs.
 *
 * Sits above the Scope/Window/severity controls rather than among them because
 * it is a different kind of decision: those four narrow *what counts as a
 * record worth listing*, and this one asks *what shape of thing am I looking
 * for*. A reader flicks between chips; they set the controls once.
 */
export default function FilterChipRow({ value, onChange }) {
  return (
    <div className="chip-row" role="group" aria-label="Filter by kind of activity">
      {ACTIVITY_CHIPS.map((chip) => {
        const active = (value || "all") === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            className={`fchip${active ? " active" : ""}`}
            aria-pressed={active}
            onClick={() => onChange?.(chip.key)}
          >
            {chip.glyph && (
              <svg className="fchip-glyph" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: chip.glyph }} />
            )}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
