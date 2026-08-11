// Task 35's own requirement: "an unknown version must fail cleanly and
// visibly, not silently produce a wrong view." decodeViewState never throws
// and always hands back a usable default view -- which is exactly the
// silent-failure mode the brief is warning against if nothing says so. This
// is that something: a small, dismissible banner.
//
// `content` is urlState.js's own describeUrlStateNotice(urlState) result --
// null when there is nothing to say, otherwise `{tone, message}`:
//
//   tone: "warn"   an unknown-version or malformed hash. decodeViewState's
//                  own error always wins over the info case below.
//   tone: "info"   review fix (Important 2), the recipient's half of "a link
//                  can be partial and nobody says so": a real, valid link
//                  restored something, and this format has known limits
//                  (multi-select, a drill-down, an open record) that no
//                  decode can see past -- only that they might have existed
//                  on the sharer's screen. See App.jsx's own
//                  omittedSelectionNote (CopyLinkButton) for the sharer's
//                  half, computed with the actual screen state decode does
//                  not have.
//
// Either way this is a one-time explanation for what the reader is looking
// at, not a standing status light -- gone for good once dismissed.
export default function UrlStateNotice({ content, onDismiss }) {
  if (!content) return null;

  return (
    <div id="urlStateNotice" className={`tone-${content.tone}`} role="status">
      <span>{content.message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
