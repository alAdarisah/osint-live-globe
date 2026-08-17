import { watchKey } from "../../utils/watchlist";
import LocateIcon from "../icons/LocateIcon";

/**
 * What the reader has pinned, at the top of the rail.
 *
 * Deliberately above the tabs rather than as a sixth one: the tabs are five
 * readings of the world, and this is the reader's own note to themselves about
 * which parts of it they are following. Putting it in the tab bar would make it
 * something you navigate to, when the whole point is that it stays in view
 * while you read everything else.
 *
 * Nothing pinned draws the header and one line of explanation rather than
 * nothing at all -- unlike the panels that hide themselves when empty, this is
 * an affordance a reader has to know exists before they can use it, and the
 * map's own popups are where the pinning actually happens.
 */
export default function Watchlist({ items, onRemove, onOpen }) {
  const list = items || [];

  return (
    <div className="watchlist">
      <div className="watchlist-head">
        <span className="watchlist-title">Watchlist</span>
        <span className="watchlist-count">{list.length}</span>
      </div>

      {list.length === 0 ? (
        <p className="watchlist-empty">
          Nothing pinned. Use <span className="watchlist-pin-hint">✓ Watch</span> in any map popup to keep a
          record here.
        </p>
      ) : (
        <ul className="watchlist-items">
          {list.map((item) => {
            const key = watchKey(item.kind, item.id);
            const locatable = Number.isFinite(item.lat) && Number.isFinite(item.lon);
            return (
              <li key={key} className="watchlist-item">
                {/* Opens the same detail card a map pin opens -- `kind` and
                    `id` are the map controller's own record vocabulary, which
                    is why the stored entry keeps them. */}
                <button
                  type="button"
                  className="watchlist-name"
                  title={`Open ${item.label}`}
                  onClick={() => onOpen?.(item)}
                >
                  {item.label}
                </button>
                {/* Only when there is somewhere to fly to. A country or an
                    aggregate is a legitimate thing to pin and has no single
                    point; a locate button that silently did nothing would be
                    worse than no button. */}
                {locatable && (
                  <button
                    type="button"
                    className="watchlist-locate"
                    title="Show on map"
                    aria-label={`Show ${item.label} on map`}
                    onClick={() => onOpen?.(item, { locate: true })}
                  >
                    <LocateIcon />
                  </button>
                )}
                <button
                  type="button"
                  className="watchlist-remove"
                  title="Remove from watchlist"
                  aria-label={`Remove ${item.label} from the watchlist`}
                  onClick={() => onRemove?.(key)}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
