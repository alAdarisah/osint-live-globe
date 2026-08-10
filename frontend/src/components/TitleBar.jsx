import { useClock } from "../hooks/useClock";
import PlaceSearch from "./PlaceSearch";
import CopyLinkButton from "./CopyLinkButton";

export default function TitleBar({
  theme, onToggleTheme, adminMode, onToggleAdminMode, onLocatePlace, getShareUrl,
}) {
  const clock = useClock();

  return (
    <header id="titleBar">
      <span className="title">OSINT LIVE GLOBE</span>
      {/* Task 34: type a few characters of a place name, fly to it. Its own
          flex item (not folded into titleBar-right) so it can grow/shrink
          independently of the fixed-width admin/theme controls next to it. */}
      <PlaceSearch onLocate={onLocatePlace} />
      <span className="titleBar-right">
        <span id="clock">{clock}</span>
        {/* Task 35: shares the title bar's space with PlaceSearch above, per
            the brief -- the one copy-link affordance that is always on
            screen, whatever card (if any) is open. */}
        <CopyLinkButton getShareUrl={getShareUrl} label="Copy link" />
        {/* The one way in and out of Admin Mode. Deliberately a plain labelled
            button rather than a hidden key chord: a mode that changes what the
            map is allowed to show should be visibly on, and its state should be
            readable at a glance from the header. */}
        <button
          id="adminToggle"
          className={adminMode ? "active" : ""}
          aria-pressed={!!adminMode}
          title={adminMode ? "Leave Admin Mode" : "Enter Admin Mode (edit icons, layers and data)"}
          onClick={onToggleAdminMode}
        >
          ADMIN
        </button>
        <button
          id="themeToggle"
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          title="Toggle light/dark mode"
          onClick={onToggleTheme}
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
      </span>
    </header>
  );
}
