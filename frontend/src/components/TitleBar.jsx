import { useClock } from "../hooks/useClock";

export default function TitleBar({ theme, onToggleTheme, adminMode, onToggleAdminMode }) {
  const clock = useClock();

  return (
    <header id="titleBar">
      <span className="title">OSINT LIVE GLOBE</span>
      <span className="titleBar-right">
        <span id="clock">{clock}</span>
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
