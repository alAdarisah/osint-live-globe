import { useCallback, useEffect, useRef, useState } from "react";

import CategoryMenu from "./CategoryMenu";
import { LayerScopeProvider } from "../controlPanel/HealthContext";
import { SCOPE_SESSION, SCOPE_DEPLOYMENT } from "../controlPanel/layerCheckTitle";
import { groupTitle } from "../../settings/layerGroups";
import { GROUP_PILL, PILL_ORDER } from "../../settings/layerPresentation";
import { pillCount, nextOpenCategory, resetTargets, groupHasWishes } from "./categoryPillsLogic";

/**
 * The layer controls, in the top bar, for everybody.
 *
 * This is the one genuinely new capability in the redesign rather than a
 * relocation: layer control has until now been Admin Mode's alone, because the
 * only surface carrying it was the operator's drawer. A reader could see what
 * the map had decided to draw and had no way to ask for anything else.
 *
 * Handing it over needed one thing settled first -- where a tick goes. In the
 * drawer it is saved to the shared data/admin_config.json and every reader of
 * the deployment gets it. That is right for an operator and wrong for everyone
 * else twice over: on the public listener the write is refused outright (a 403
 * that would put the whole session into an error state on every click), and
 * even where it succeeded, a reader adjusting their own view for a minute was
 * never asking to edit what the next visitor sees. So a tick from here is
 * session-only. App.jsx's onToggleLayer holds that rule; this component
 * declares the scope so every row's tooltip states it.
 */
export default function CategoryPills({
  layerVisibility,
  layerWish,
  counts,
  onToggleLayer,
  adminMode,
}) {
  const [openCategory, setOpenCategory] = useState(null);
  const stripRef = useRef(null);

  // Outside click and Escape both close. Escape because a menu opened by
  // keyboard has to be closeable by keyboard, and outside-click because a menu
  // that only closes via the button that opened it is a menu readers leave open.
  useEffect(() => {
    if (!openCategory) return undefined;
    const onDocClick = (event) => {
      if (!stripRef.current?.contains(event.target)) setOpenCategory(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpenCategory(null);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [openCategory]);

  const onReset = useCallback(() => {
    // Hand every overridden layer back to the scene resolver, one call each --
    // the same path the ↺ button uses, so this cannot drift from it. See
    // resetTargets' own note on why this is not "tick everything".
    for (const key of resetTargets(layerWish)) onToggleLayer(key, null);
    setOpenCategory(null);
  }, [layerWish, onToggleLayer]);

  const anyWishes = resetTargets(layerWish).length > 0;

  return (
    <LayerScopeProvider value={adminMode ? SCOPE_DEPLOYMENT : SCOPE_SESSION}>
      <span className="cat-pills" ref={stripRef}>
        {PILL_ORDER.map((groupId) => {
          const pill = GROUP_PILL[groupId];
          if (!pill) return null;
          const { on, total } = pillCount(groupId, layerVisibility);
          const open = openCategory === groupId;
          return (
            <span key={groupId} className={`cat${open ? " open" : ""}`}>
              <button
                type="button"
                className={`cat-btn${groupHasWishes(groupId, layerWish) ? " touched" : ""}`}
                aria-expanded={open}
                aria-label={`${groupTitle(groupId)} layers, ${on} of ${total} on`}
                title={groupTitle(groupId)}
                onClick={() => setOpenCategory((prev) => nextOpenCategory(prev, groupId))}
              >
                <span className="dot" style={{ background: pill.dot }} />
                <span className="txt">{pill.label}</span>
                <span className="n">{on}</span>
              </button>
              {open && (
                <CategoryMenu
                  groupId={groupId}
                  layerVisibility={layerVisibility}
                  layerWish={layerWish}
                  counts={counts}
                  onToggleLayer={onToggleLayer}
                />
              )}
            </span>
          );
        })}

        {/* Only offered once there is something to undo. A permanently
            available Reset on a map where nothing has been overridden is a
            button that does nothing, which teaches a reader that it does
            nothing. */}
        {anyWishes && (
          <button
            type="button"
            className="cat-btn reset"
            title={
              adminMode
                ? "Hand every layer back to the scene, and clear the saved overrides for this deployment"
                : "Hand every layer back to the scene: zoom, what the camera is over, and what you have clicked"
            }
            onClick={onReset}
          >
            <span className="dot" style={{ background: "var(--danger)" }} />
            <span className="txt">Reset</span>
          </button>
        )}
      </span>
    </LayerScopeProvider>
  );
}
