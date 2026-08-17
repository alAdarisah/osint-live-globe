import PlaceSearch from "../PlaceSearch";
import CopyLinkButton from "../CopyLinkButton";

/**
 * The sub bar: the row of things a reader *does*.
 *
 * Everything here came out of TitleBar.jsx unchanged in behaviour -- the place
 * search, Copy link, Export, and the way into Admin Mode. The split between
 * this bar and the one above it is that one: the top bar states facts about the
 * page (who it is, whether it is live, what is on it, what time it is), and
 * this one carries the actions. A reader looking for a control now has one row
 * to look along instead of a header and a drawer.
 *
 * The feed toggle, the time-window pills and the replay button land here too,
 * each in the step that builds it; the slots are `children` rather than props
 * so this file never grows a copy of their state.
 */
export default function SubBar({
  onLocatePlace,
  getShareUrl,
  onOpenExport,
  adminMode,
  onToggleAdminMode,
  readOnly,
  feedSlot,
  windowSlot,
  replaySlot,
  boardsSlot,
}) {
  return (
    <div id="subBar">
      {feedSlot}
      {windowSlot}
      {replaySlot}

      {/* Task 34, unchanged: type a few characters of a place name, fly to it.
          Its own flex item so it can grow and shrink independently of the
          fixed-width buttons beside it. */}
      <PlaceSearch onLocate={onLocatePlace} />

      <span className="sub-bar-right">
        {boardsSlot}

        {/* Task 35: the one copy-link affordance that is always on screen,
            whatever card (if any) is open. */}
        <CopyLinkButton getShareUrl={getShareUrl} label="Copy link" />

        {/* Task 43: everything currently on screen, as GeoJSON or CSV, with a
            provenance header naming every source, its licence and its
            collection time -- see ExportDialog.jsx / map/exportBuilder.js.
            Next to Copy link rather than tucked into the control drawer:
            exporting is a reader action about the world on screen right now,
            the same footing Copy link already has, not an adjustment to how the
            map behaves. */}
        <button
          id="exportToggle"
          className="ghost-btn"
          title="Export what is currently on screen as GeoJSON or CSV"
          onClick={onOpenExport}
        >
          Export
        </button>

        {/* The one way in and out of Admin Mode. Deliberately a plain labelled
            button rather than a hidden key chord: a mode that changes what the
            map is allowed to show should be visibly on, and its state should be
            readable at a glance.

            Absent entirely on the public listener rather than shown disabled. A
            greyed-out ADMIN button invites a reader to wonder what they are
            missing and to go looking; on a page where every save would be
            refused anyway, the honest presentation is that the mode is not part
            of this page. Operators reach it through the SSH tunnel, where it
            appears normally. */}
        {!readOnly && (
          <button
            id="adminToggle"
            className={`ghost-btn${adminMode ? " active" : ""}`}
            aria-pressed={!!adminMode}
            title={adminMode ? "Leave Admin Mode" : "Enter Admin Mode (edit icons, layers and data)"}
            onClick={onToggleAdminMode}
          >
            Admin
          </button>
        )}
      </span>
    </div>
  );
}
