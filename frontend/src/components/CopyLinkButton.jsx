// Task 35: the one "copy a link to this view" affordance, shared by the
// title bar and every info/detail card rather than reimplemented per site.
// It always means the same thing -- copy camera, layers, active filters, the
// one thing selected and the replay moment if scrubbed back -- never "copy a
// link to this specific record"; see urlState.js for exactly what that is and
// is not. `getShareUrl` is called at click time (not memoised here), so the
// link it builds always reflects whatever is on screen the moment the button
// is pressed, not whatever it was when the card first opened.
import { useCallback, useEffect, useRef, useState } from "react";

export default function CopyLinkButton({ getShareUrl, className = "", label = "Copy link" }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const onClick = useCallback(async () => {
    const url = getShareUrl();
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
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // A blocked clipboard permission is not this app's to work around --
      // the reader still has the button's own title text as a fallback (the
      // URL itself is not shown anywhere else, on purpose: nothing here is
      // sensitive, but a raw hash string is not something a reading-mode
      // card should be printing onto the page).
      console.warn("Failed to copy link:", err);
    }
  }, [getShareUrl]);

  return (
    <button
      type="button"
      className={`copy-link-button ${className}`}
      onClick={onClick}
      title="Copy a link to this view (camera, layers, filters, selection, replay moment)"
    >
      {copied ? "Copied" : label}
    </button>
  );
}
