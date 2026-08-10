// Task 35: the one "copy a link to this view" affordance, shared by the
// title bar and every info/detail card rather than reimplemented per site.
// It always means the same thing -- copy camera, layers, active filters, the
// one thing selected and the replay moment if scrubbed back -- never "copy a
// link to this specific record"; see urlState.js for exactly what that is and
// is not. `getShareUrl` is called at click time (not memoised here), so the
// link it builds always reflects whatever is on screen the moment the button
// is pressed, not whatever it was when the card first opened.
//
// Review fix (Important 2): `getShareUrl` returns `{url, note}`, not a bare
// string -- `note` is App.jsx's own omittedSelectionNote result, a
// plain-language list of what this particular click's state will not carry
// (a multi-country selection narrowed to one, an open subdivision/district/
// record card). Neither end of a link used to be told when it was partial;
// this is the sharer's half of that fix (see UrlStateNotice for the
// recipient's).
import { useCallback, useEffect, useRef, useState } from "react";

const COPIED_LABEL_MS = 1500;
// Longer than the plain "Copied" feedback -- a one-line warning needs more
// than a glance to actually read, and the button's title (the full note
// text) stays live for exactly as long as the shortened label does, so
// hovering during the window reaches the detail behind it.
const COPIED_WITH_NOTE_MS = 4000;

export default function CopyLinkButton({ getShareUrl, className = "", label = "Copy link" }) {
  const [feedback, setFeedback] = useState(null); // null | { note: string|null }
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onClick = useCallback(async () => {
    const result = getShareUrl();
    const url = typeof result === "string" ? result : result?.url;
    const note = typeof result === "string" ? null : result?.note ?? null;
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // No Clipboard API -- an insecure context, or a browser old enough
        // not to have one. The same hidden-textarea-plus-execCommand fallback
        // every "copy to clipboard" widget used before that API existed.
        const el = document.createElement("textarea");
        el.value = url;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setFeedback({ note });
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFeedback(null), note ? COPIED_WITH_NOTE_MS : COPIED_LABEL_MS);
    } catch (err) {
      // A blocked clipboard permission is not this app's to work around --
      // the reader still has the button's own title text as a fallback (the
      // URL itself is not shown anywhere else, on purpose: nothing here is
      // sensitive, but a raw hash string is not something a reading-mode
      // card should be printing onto the page).
      console.warn("Failed to copy link:", err);
    }
  }, [getShareUrl]);

  const baseTitle = "Copy a link to this view (camera, layers, filters, selection, replay moment)";

  return (
    <button
      type="button"
      className={`copy-link-button ${className}`}
      onClick={onClick}
      title={feedback?.note || baseTitle}
    >
      {feedback ? (feedback.note ? "Copied — partial" : "Copied") : label}
    </button>
  );
}
