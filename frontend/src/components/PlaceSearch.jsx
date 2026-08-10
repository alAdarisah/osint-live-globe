// Task 34: the title bar's "type any town on Earth and go there" search box.
// Debounced fetch to /api/places (backend/app.py, backed by
// backend/sources/gazetteer.py's in-memory index), a keyboard-navigable
// dropdown of results, and a fly-to on pick.
//
// The pure formatting/wrap-around logic lives in placeSearchFormat.js, not
// here -- this file is JSX and not importable under the headless `node
// --test` suite (see placeInfoCard.test.js's own note on the same split).
import { useCallback, useEffect, useState } from "react";

import { fetchJson, placesSearchUrl } from "../api";
import { createGenerationGuard } from "../utils/fetchGeneration";
import { nextHighlightedIndex, placeResultTitle, placeResultSubtitle } from "./placeSearchFormat";

// How long to wait after the last keystroke before asking the backend.
// /api/places' own worst case -- a very common two- or three-character
// prefix, scanned against the in-memory gazetteer index -- runs to roughly
// 100-220ms against a synthetic index sized like the live table (see
// Gazetteer.search()'s docstring in backend/sources/gazetteer.py). This is
// what keeps that cost paid once per pause in typing rather than once per
// keystroke -- and because the timer itself (not just the fetch) is what
// gets cancelled on the next keystroke, an abandoned in-between query is
// never even sent, not just discarded on arrival.
const DEBOUNCE_MS = 200;

// Below this the backend itself returns nothing (see app.py's
// MIN_PLACE_QUERY_LENGTH) -- checked here too so the dropdown does not flash
// open on a single keystroke only to immediately show "no results".
const MIN_QUERY_LENGTH = 2;

// One search box, one guard, one key -- createGenerationGuard (Task 17's
// house pattern for a fetch that can be superseded) needs a key only because
// its original callers each track several concurrently-open cards. A module-
// level instance is safe here specifically because there is exactly one
// PlaceSearch mounted for the app's lifetime (see App.jsx).
const searchGuard = createGenerationGuard();
const SEARCH_KEY = "places";

export default function PlaceSearch({ onLocate }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [totalMatches, setTotalMatches] = useState(0);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  // idle | loading | ready | notready | error. "notready" is distinct from
  // "ready" with zero results -- see the useEffect below and the Task 34
  // review: the backend's own index is warmed from Postgres asynchronously
  // and is not necessarily populated yet when this box first becomes
  // interactive, and telling a reader a real capital "does not match"
  // during that window is the found-nothing-versus-did-not-look mistake
  // this project holds the line against everywhere else.
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setTotalMatches(0);
      setStatus("idle");
      return undefined;
    }
    setStatus("loading");
    const timer = setTimeout(() => {
      const token = searchGuard.start(SEARCH_KEY);
      fetchJson(placesSearchUrl(trimmed))
        .then((data) => {
          if (!searchGuard.isCurrent(SEARCH_KEY, token)) return; // a later keystroke has already superseded this
          setResults(data.results || []);
          setTotalMatches(data.total_matches || 0);
          // data.ready is false only while the backend's gazetteer index has
          // not loaded any data at all yet (see app.py's places_endpoint) --
          // once it has, even a genuinely empty result set comes back as
          // "ready".
          setStatus(data.ready === false ? "notready" : "ready");
          setHighlighted(-1);
        })
        .catch(() => {
          if (!searchGuard.isCurrent(SEARCH_KEY, token)) return;
          setResults([]);
          setTotalMatches(0);
          setStatus("error");
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const pick = useCallback(
    (result) => {
      if (!result) return;
      // Administrative divisions (regions, districts) are worth seeing from
      // further out than a single town -- gazetteer.py's own radius table
      // (radius_km_for) draws the same distinction, on the same
      // feature_class signal, for the placement-uncertainty ring.
      const zoom = result.feature_class === "A" ? 6 : 10;
      onLocate?.(result.lat, result.lon, zoom);
      setOpen(false);
      setQuery("");
      setResults([]);
      setHighlighted(-1);
    },
    [onLocate]
  );

  const onKeyDown = useCallback(
    (event) => {
      if (!open || results.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((h) => nextHighlightedIndex(h, results.length, 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((h) => nextHighlightedIndex(h, results.length, -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        pick(results[highlighted] ?? results[0]);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    },
    [open, results, highlighted, pick]
  );

  const trimmedQuery = query.trim();
  const showDropdown = open && trimmedQuery.length >= MIN_QUERY_LENGTH;
  const activeOptionId = highlighted >= 0 ? `place-search-option-${highlighted}` : undefined;

  return (
    <div className="place-search">
      <input
        type="text"
        className="place-search-input"
        placeholder="Search for a place…"
        value={query}
        role="combobox"
        aria-label="Search for a place"
        aria-expanded={showDropdown}
        aria-controls="place-search-listbox"
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Delayed rather than immediate so a click on a result (onMouseDown,
        // below) has already fired and picked it before the list unmounts.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {showDropdown && (
        <ul className="place-search-results" id="place-search-listbox" role="listbox">
          {status === "loading" && <li className="place-search-status">Searching…</li>}
          {status === "error" && <li className="place-search-status">Search failed. Try again.</li>}
          {status === "notready" && (
            <li className="place-search-status">
              Still loading the place index — try again in a moment.
            </li>
          )}
          {status === "ready" && results.length === 0 && (
            <li className="place-search-status">No places match &ldquo;{trimmedQuery}&rdquo;.</li>
          )}
          {results.map((result, index) => (
            <li
              key={result.geonameid}
              id={`place-search-option-${index}`}
              role="option"
              aria-selected={index === highlighted}
              className={`place-search-result${index === highlighted ? " highlighted" : ""}`}
              // onMouseDown, not onClick: it fires before the input's onBlur
              // (above) would otherwise unmount this list out from under the
              // click.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(result);
              }}
              onMouseEnter={() => setHighlighted(index)}
            >
              <span className="place-search-title">{placeResultTitle(result)}</span>
              <span className="place-search-subtitle">{placeResultSubtitle(result)}</span>
            </li>
          ))}
          {status === "ready" && totalMatches > results.length && (
            <li className="place-search-status">
              Showing {results.length} of {totalMatches} matches -- keep typing to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
