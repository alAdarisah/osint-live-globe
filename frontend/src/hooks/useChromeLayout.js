import { useCallback, useEffect, useRef, useState } from "react";
import { chromeInsets, chromeInsetProperties } from "./chromeLayout";

// The feed rail's open state, and the three custom properties every fixed
// surface anchors against.
//
// Written onto <html> rather than passed down as props, for the reason
// useAppSettings.js gives for --accent and --panel-alpha: the readers are
// twenty CSS rules, not twenty components, and threading a number through
// React to end up in a stylesheet is a round trip that buys nothing.
//
// Its own storage key, deliberately not the panel-positions record: that one is
// what "Reset panel layout" wipes, and a reader who resets where their cards
// sit has not asked for the feed to close.
const FEED_OPEN_KEY = "osint-feed-open";

function loadFeedOpen(fallback) {
  try {
    const raw = localStorage.getItem(FEED_OPEN_KEY);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback; // disabled storage is not a reason to fail to render
  }
}

/**
 * @param {object} options
 * @param {() => void} options.invalidateSize  mapApi.invalidateSize
 * @param {boolean} options.isMobileViewport
 * @param {boolean} options.drawerOpen    Admin Mode's layer drawer
 * @param {boolean} options.scrubVisible  the replay strip
 */
export function useChromeLayout({ invalidateSize, isMobileViewport, drawerOpen = false, scrubVisible = false }) {
  // Open on a desktop, because the rail is the panel that answers "what should
  // I look at" and hiding it by default defeats the point -- the same call
  // IntelPanel.jsx has always made. Closed on a phone, where it is a full-width
  // overlay over the map rather than a column beside it.
  const [feedOpenPref, setFeedOpenPref] = useState(() => loadFeedOpen(!isMobileViewport));

  // The exclusive rail. The drawer (320px) and the feed (332px) both want the
  // left edge, and stacking them side by side leaves 628px of map on a 1280px
  // screen -- unusable on the laptop most of this is read on. So the drawer
  // wins while it is open and the feed comes back when it closes, which is why
  // this is derived rather than stored: the reader's preference is never
  // overwritten by an operator opening a drawer over it.
  const feedOpen = feedOpenPref && !drawerOpen;

  const toggleFeed = useCallback(() => {
    setFeedOpenPref((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(FEED_OPEN_KEY, next ? "1" : "0");
      } catch {
        /* the toggle still works for this session; it just will not be remembered */
      }
      return next;
    });
  }, []);

  const insets = chromeInsets({ feedOpen, drawerOpen, scrubVisible, mobile: isMobileViewport });

  useEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(chromeInsetProperties(insets))) {
      root.style.setProperty(name, value);
    }
  }, [insets.top, insets.left, insets.bottom]);

  // Leaflet caches the map's pixel size and only re-reads it when told to, so a
  // map whose left edge just moved renders every click a third of a screen off
  // until it is. Fired after the slide rather than with it: invalidating
  // mid-transition measures a width the map is no longer going to have.
  //
  // Keyed on the left inset alone -- top and bottom are constants once the bars
  // exist, and a repaint per unrelated re-render is exactly what this used to
  // cost when it was a setTimeout in a click handler.
  const previousLeft = useRef(insets.left);
  useEffect(() => {
    if (previousLeft.current === insets.left) return undefined;
    previousLeft.current = insets.left;
    const styles = getComputedStyle(document.documentElement);
    const slide = parseFloat(styles.getPropertyValue("--t-panel")) || 240;
    const timer = setTimeout(() => invalidateSize?.(), slide + 10);
    return () => clearTimeout(timer);
  }, [insets.left, invalidateSize]);

  return { feedOpen, toggleFeed, insets };
}
