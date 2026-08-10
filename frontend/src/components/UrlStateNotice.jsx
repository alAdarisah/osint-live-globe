// Task 35's own requirement: "an unknown version must fail cleanly and
// visibly, not silently produce a wrong view." decodeViewState never throws
// and always hands back a usable default view -- which is exactly the
// silent-failure mode the brief is warning against if nothing says so. This
// is that something: a small, dismissible banner, shown once at load for
// whichever of the two ways a hash can fail to be honoured (see
// urlState.js's decodeViewState for what "unknown-version" and "malformed"
// mean), and gone for good once dismissed or once the reader has looked at
// the map for a while -- it is a one-time explanation for what they are
// looking at, not a standing status light.
export default function UrlStateNotice({ error, onDismiss }) {
  if (!error) return null;

  const message = error === "unknown-version"
    ? "This link was written by a version of this app that no longer matches this one, so it could not be read -- showing the default view instead."
    : "This link looks incomplete or altered (cut off in a paste, an email footer...) and could not be read -- showing the default view instead.";

  return (
    <div id="urlStateNotice" role="status">
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
