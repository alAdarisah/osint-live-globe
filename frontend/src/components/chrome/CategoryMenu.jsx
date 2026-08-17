import LayerCheck from "../controlPanel/LayerCheck";
import LayerIcon from "../controlPanel/LayerIcon";
import CountUp from "../CountUp";
import { groupTitle } from "../../settings/layerGroups";
import { layerRowsFor } from "../../settings/layerPresentation";
import { pillCount } from "./categoryPillsLogic";

/**
 * One category pill's dropdown: the layers filed under that subject.
 *
 * Every row renders the real `LayerCheck` from the control drawer rather than a
 * plain checkbox. That is the whole design of this component, and it is not
 * incidental: a layer is not on or off, it is on or off *for a reason* -- the
 * scene resolver decided, or someone pinned it on, or someone pinned it off --
 * and a plain checkbox has two states where the app has three. Reusing the
 * component means the indeterminate "not your call" state, the pinned marker,
 * the amber "pinned on but held back by its own zoom gate" case and the ↺
 * hand-back button all behave here exactly as they do in the drawer, because
 * they *are* the drawer's, not a second implementation of them.
 *
 * The same reasoning runs through the styling: the rows reuse .layer-row and
 * .layer-check from style.css, and chrome.css only sets the spacing. If the
 * pill drew its own checkbox, "pinned" would look like one thing here and
 * another there.
 *
 * What the drawer keeps and this does not: the four filter checkboxes, the
 * three text filters, the sub-tickers with no toggle, the cap-thinning banner,
 * the twelve zoom notes, the placement tally and the "About this layer" folds.
 * None of those are layer switches, and a 270px dropdown is the wrong home for
 * a text input with a live match count.
 */
export default function CategoryMenu({ groupId, layerVisibility, layerWish, counts, onToggleLayer }) {
  const rows = layerRowsFor(groupId);
  const { on, total } = pillCount(groupId, layerVisibility);

  // No wrapper of its own: the .cat-menu element is MenuPortal's, because it is
  // the thing that has to be on the body and positioned against the pill (see
  // menuPosition.js). This renders the contents of that box and nothing else.
  return (
    <>
      <div className="cat-menu-head">
        <span>{groupTitle(groupId)}</span>
        <span className="cat-menu-count">{on} of {total} on</span>
      </div>

      {rows.map((row) => (
        <label key={row.key} className={`layer-row${row.sub ? " sub-row" : ""}`} data-layer={row.key}>
          <LayerCheck
            layerKey={row.key}
            on={layerVisibility[row.key]}
            wish={layerWish?.[row.key]}
            onToggle={onToggleLayer}
            ariaLabel={row.label}
          />
          <LayerIcon svg={row.svg} color={row.color} token={row.token} />
          <span className="cat-row-label">{row.label}</span>
          {/* Kept from the drawer verbatim: an inference drawn from an absence
              is labelled as one wherever it is offered. */}
          {row.inferred && <span className="inferred-tag">inferred</span>}
          {/* `visible (global total)`, the same pairing every drawer row shows,
              so a thinned view never reads as a broken feed. A layer the map
              draws as geometry rather than as counted points has nothing to
              report and says nothing, rather than showing a zero. */}
          {row.count && (
            <span className="count">
              <CountUp value={counts[row.count]} /> (<CountUp value={counts[`${row.count}Total`]} />)
            </span>
          )}
        </label>
      ))}
    </>
  );
}
