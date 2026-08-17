import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { anchorMenuStyle } from "./menuPosition";

/**
 * A bar's dropdown, rendered on the body and positioned against its trigger.
 *
 * See menuPosition.js for why this is not simply a child of its bar: the two
 * bars are stacking contexts, and the category strip is a scroll container that
 * clipped its menu out of existence.
 *
 * Repositions on scroll and resize. The listener is on scroll in the *capture*
 * phase because the interesting scroll is the category strip's own horizontal
 * one, which does not bubble -- a reader who scrolls the pills sideways with a
 * menu open would otherwise leave the menu behind, pointing at a button that has
 * moved.
 */
export default function MenuPortal({
  anchorEl,
  className,
  minWidth = 0,
  align = "left",
  menuRef,
  children,
  ...rest
}) {
  const [style, setStyle] = useState(null);

  const measure = useCallback(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const styles = getComputedStyle(document.documentElement);
    // The bottom chrome is already published as a custom property by
    // useChromeLayout, so the menu clears the HUD (and the scrub strip while
    // replaying) without this component having to know either exists.
    const bottomInset = parseFloat(styles.getPropertyValue("--chrome-bottom")) || 0;
    const { left, top, maxHeight } = anchorMenuStyle(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { minWidth, align, bottomInset },
    );
    setStyle({ left: `${left}px`, top: `${top}px`, maxHeight: `${maxHeight}px` });
  }, [anchorEl, minWidth, align]);

  // Before paint, not after: measuring in a passive effect renders the menu at
  // the top-left corner for one frame first, which looks like a flash of a
  // different menu.
  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    if (!anchorEl) return undefined;
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorEl, measure]);

  if (!anchorEl || !style) return null;

  return createPortal(
    <div className={className} style={style} ref={menuRef} {...rest}>
      {children}
    </div>,
    document.body,
  );
}
