// The ledger for redrawn boundaries. Editing itself happens on the map (select
// a country, "Edit border" on its card); this is where you see what has been
// changed and take it back, which is the half a direct-manipulation gesture
// cannot show you.
import { PanelGroup } from "../../controlPanel/Collapsible";
import { borderStats } from "../../../settings/borderOverrides";

export const SEARCH_TERMS = [
  "Country borders",
  "Revert",
  "Discard",
  "Discard every border edit",
];

export default function BordersSection({ settings, actions, staleBorders, isOpen, onToggle }) {
  const borders = settings.borders || {};
  const keys = Object.keys(borders).sort();
  const stats = borderStats(borders);
  const stale = new Set(staleBorders || []);

  return (
    <PanelGroup id="adm-borders" title="Country borders" open={isOpen("adm-borders")} onToggle={onToggle}>
      <div className="admin-note">
        Boundaries come from Natural Earth at 1:50m, where the median country is drawn with about
        a hundred and eighty points &mdash; a generalisation for looking at the world, not a survey.
        It follows a coastline closely enough to zoom into; it is still not a cadastral line. An edit here
        redraws that line; it does not correct it. Every country whose border has been redrawn says so
        on its own card.
      </div>

      {keys.length === 0 ? (
        <div className="admin-note">
          Nothing redrawn. Click a country, then <b>Edit border</b> on its card.
        </div>
      ) : (
        <>
          {keys.map((key) => {
            const entry = borders[key];
            const rings = Object.keys(entry.rings || {}).length;
            const points = Object.values(entry.rings || {}).reduce((sum, r) => sum + r.length, 0);
            return (
              <div className={`admin-border-row${stale.has(key) ? " stale" : ""}`} key={key}>
                <span className="admin-border-name">{key}</span>
                <span className="admin-border-meta">
                  {stale.has(key)
                    ? "source geometry changed — not applied"
                    : `${rings} ${rings === 1 ? "ring" : "rings"}, ${points.toLocaleString()} points`}
                </span>
                <button type="button" onClick={() => actions.revertBorderCountry(key)}>
                  {stale.has(key) ? "Discard" : "Revert"}
                </button>
              </div>
            );
          })}
          {stale.size > 0 && (
            <div className="admin-note">
              A stale edit is one made against a different version of the source geometry &mdash; the
              points it names are no longer in the same places, so it is held rather than applied. It
              is kept in case the source comes back; discarding is the only thing that removes it.
            </div>
          )}
          <div className="admin-note">
            {stats.points.toLocaleString()} of {stats.limit.toLocaleString()} points used. The whole
            configuration is saved as one file, so this ceiling is what stops boundary geometry from
            crowding out every other setting in it.
          </div>
          <button type="button" className="admin-wide-btn" onClick={actions.clearBorderEdits}>
            Discard every border edit
          </button>
        </>
      )}
    </PanelGroup>
  );
}
