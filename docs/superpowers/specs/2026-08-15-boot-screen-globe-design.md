# Boot screen: globe and honest log — design

Replace the boot screen's spinning radar with a graticule globe that actually
rotates, and make each line of the source log say what it loaded, how long it
took, and — when it did not load — why.

## Where things stand

`frontend/src/components/LoadingScreen.jsx` covers the map from first paint
until every source in `bootSources` has resolved once, or until a 9-second
safety timeout fires. It draws three things: a radar (two static rings and a
conic-gradient sweep spun by `transform: rotate`), a title and subtitle, and a
log of twelve source lines each carrying a status glyph and a label. A progress
bar underneath tracks the fraction resolved.

Two problems with the log as it stands.

The first is that a line says almost nothing. `✓ City index` tells a reader the
fetch returned, and nothing else — not whether it returned four cities or forty
thousand, not whether it took 30ms from cache or four seconds from a cold
backend, and on failure not what failed. The screen's own comments are careful
about honesty — the safety timeout deliberately relabels still-pending sources
`timeout` rather than counting them as loaded, "so the log stays honest about
what actually happened" — but honesty about *which* sources resolved is only
half of it. A boot log that cannot distinguish a fast success from a slow one,
or a 503 from an unreachable host, is not yet reporting what happened.

The second is a real gap. `useOsintData.js` has a fourth status: a source
sitting below its zoom gate is marked `deferred`, which is terminal for the boot
screen but not for the source. `STATUS_GLYPH` in `LoadingScreen.jsx` has entries
for `pending`, `ok`, `warn` and `timeout` only. A deferred source therefore
renders an empty glyph in a row with no matching CSS rule — it appears as an
unexplained blank at the exact moment the screen is supposed to be explaining
itself. `cities` is gated and the map opens at zoom 3, so this is not
hypothetical.

Separately, the radar is a shape that does not mean anything here. The product
is called OSINT LIVE GLOBE and sits in front of a world map; a radar sweep is
borrowed iconography from a different instrument.

## What is not changing

The timing constants stay exactly as they are: `MIN_VISIBLE_MS` at 1400,
`MAX_VISIBLE_MS` at 9000, and the 700ms removal delay after the opacity
transition. The dismissal rule — wait for every boot source, then honor the
minimum — is unchanged, as is the deliberate theme-independence of the splash.

`.loading-inner` stays at `max-width: 380px`. The extra per-source detail is
made to fit that column rather than the column being widened to fit it.

## Carrying the detail out of the fetch

The status of a source is decided in one place: `registerPoller`'s `tick()` in
`frontend/src/hooks/useOsintData.js`, which calls `markSourceLoaded(key, ok)`
from its success and error branches and `markSourceDeferred(key)` from the
zoom-gate branch. Those three call sites are the only seam that needs to widen,
which is what makes this change small.

`markSourceLoaded` grows a third parameter:

```js
markSourceLoaded(key, ok, { ms, count, detail })
```

**Elapsed time.** `tick()` records `Date.now()` immediately inside its `try`,
before the URL is assembled, and differences it at the point the outcome is
known. This measures the round trip the reader actually waited through,
including a 304 served from the ETag cache — which is the honest number, since a
cache hit really is that fast.

**Record count.** A new exported pure helper:

```js
export function countOf(data) { ... }
```

It returns `data.length` for an array, `data.features.length` when the payload
is GeoJSON, and `null` for anything else. `null` means "this payload has no
countable rows", which the UI renders as no count rather than as zero — the same
distinction `.meta.district-nodata` already draws elsewhere in this codebase
between an absent record and an empty one. It is exported so it can be tested
directly rather than through React.

**Failure detail.** `fetchJson` in `frontend/src/api.js` currently throws
`new Error(\`${url}: ${resp.status}\`)`. Recovering the status by parsing that
string would be fragile, and rendering the message verbatim would put a full API
URL on the splash screen. Instead `api.js` attaches the status to the error
before throwing:

```js
if (!resp.ok) {
  const err = new Error(`${url}: ${resp.status}`);
  err.status = resp.status;
  throw err;
}
```

The message is untouched, so every existing caller and every log line that reads
it behaves exactly as before. The error branch of `tick()` then reports
`HTTP ${err.status}` when a status is present, and `unreachable` when it is not
— a thrown `TypeError` from `fetch` itself carries no status, and calling that
an HTTP error would be a lie.

`markSourceDeferred` reports `detail: "below zoom gate"`, which is the plain
statement of the condition already described at length in that branch's comment.

## Short labels, full provenance on hover

Twelve rows with a count and a timing each will not fit a 380px column beside
labels like `Conflict & violence events (ACLED + UCDP + GDELT, fused)`. Those
long labels are not decoration — naming the upstream source is how a reader
knows what kind of evidence a layer is — so they are kept rather than rewritten.

Each entry in `BOOT_SOURCES` gains a `short` field for display, and the existing
`label` becomes the row's `title` attribute:

| key | short |
|-----|-------|
| `countries` | Country boundaries |
| `cities` | City index |
| `events` | Conflict events |
| `firms` | Thermal anomalies |
| `gdelt` | News stream |
| `ais` | Maritime traffic |
| `adsb` | Aircraft tracking |
| `jamming` | GPS jamming |
| `satellites` | Satellites |
| `satNavigation` | Satellites: navigation |
| `satWeather` | Satellites: weather |
| `satImaging` | Satellites: imaging |

Nothing is lost: hovering any row still gives the full attribution string.

## The globe

A new component, `frontend/src/components/BootGlobe.jsx`, with its projection
math in a sibling module `frontend/src/components/bootGlobeGeometry.js`. The
split follows the pattern already used by `sanctionsBoardLogic.js` and
`countryCompareLogic.js`: the geometry is plain functions over numbers, testable
in the existing Vitest suite without React or a DOM.

No third-party 3D library is involved. The repository has just moved Leaflet to
same-origin hosting and tightened its content policy; pulling in a WebGL globe
library would run against that, and is not needed for a wireframe.

`bootGlobeGeometry.js` exports:

```js
export function graticulePaths(spinRadians, size)
```

returning `{ meridians: [pathString, ...], parallels: [pathString, ...] }`.
Points on the sphere are projected orthographically at a fixed 20° tilt, so the
equator reads as an ellipse and the poles sit off-centre — the cue that makes a
set of curves read as a sphere rather than a badge. Six meridians at 30°
spacing and five parallels at 30° spacing are sampled at a fixed angular step;
each sample carries a depth term, and samples on the far side of the sphere are
dropped. A line that crosses the limb therefore breaks into separate path
segments rather than being drawn through the body of the globe, which is what
distinguishes a wireframe globe from a flat grid.

`BootGlobe.jsx` holds one `requestAnimationFrame` loop advancing the spin at
roughly 0.35 radians per second, and renders the returned paths as inline SVG
inside a rim circle with a faint radial fill, in the existing cyan. The loop is
cancelled on unmount and does not start while the `hidden` prop is true, so the
screen does not keep animating through its own fade-out.

Under reduced motion the loop never starts and the component renders a single
static frame at spin 0. This is handled inside the component rather than by a
CSS `animation: none` override, because the motion here lives in JavaScript
state and cannot be switched off from a stylesheet. The condition is the pair
`useCountUp.js` already checks — the `reduce-motion` class on the root element,
which `useAppSettings.js` toggles from the in-app setting, or the
`prefers-reduced-motion: reduce` media query:

```js
document.documentElement.classList.contains("reduce-motion") ||
window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
```

This is a small behavioural improvement as well as a port. The radar sweep it
replaces is animated purely in CSS and appears in neither reduced-motion block,
so it spins today regardless of the setting; the globe will not.

## The log line

`LoadingScreen.jsx` swaps the three radar divs for `<BootGlobe hidden={hidden} />`
and adds the missing glyph:

```js
const STATUS_GLYPH = { pending: "⋯", ok: "✓", warn: "―", timeout: "⚠", deferred: "·" };
```

Each row becomes two lines within one list item — the short label with its glyph
on top, and a dimmer meta line beneath it:

- **ok** — count and elapsed time, e.g. `12,480 rows · 340ms`. If `countOf`
  returned `null`, the elapsed time alone.
- **warn** and **timeout** — the `detail` string: `HTTP 503`, `unreachable`, or
  for a timed-out row, `still waiting`.
- **deferred** — `below zoom gate`.
- **pending** — no meta line; there is nothing true to say yet.

The `forceDone` relabelling of pending rows to `timeout` is unchanged, and now
also supplies that row's `still waiting` detail, so the relabelled row explains
itself rather than only changing colour.

## Styling

In `frontend/src/style.css`, the `.loading-radar*` rules and the
`loading-radar-spin` keyframes are removed and replaced by `.boot-globe` rules
sized to match the 110px footprint the radar occupied, so the vertical rhythm of
the splash is unchanged.

`.loading-log-meta` is the new dim second line, around 9.5px, tinted below the
label. `.loading-log-line.deferred` gets a muted slate tone, deliberately
distinct from the orange of `warn` and `timeout`: a source that was correctly
not fetched is not a degraded one, and colouring it like a failure would
misreport the boot.

The stagger ladder currently enumerates `nth-child` up to 8, so with twelve boot
sources the last four rows all land on the same fallback delay. The `.loading-log`
selectors are extended to 12 so every row staggers.

No `.boot-globe` entry is added to either reduced-motion block. The globe has no
CSS animation to switch off — its only motion is the rAF loop, which the
component already declines to start.

## Tests

`frontend/tests/bootGlobeGeometry.test.js` covers the projection: a point at
0°N 0°E under zero spin projects to the centre of the viewport; a point on the
far side of the sphere is excluded from the emitted path rather than folded onto
the visible face; parallels are symmetric about the tilted equator; and advancing
the spin by 2π returns the same paths as spin 0.

`frontend/tests/bootSourceMeta.test.js` covers `countOf` for an array, a GeoJSON
`FeatureCollection`, an empty array (0, not `null`), and a scalar or object with
no countable rows (`null`).

Both are pure-function suites in the style of the existing `safeUrl.test.js`.

## What could go wrong

A source whose payload is a large array is counted with `.length`, which is
free; nothing walks the rows. The rAF loop is one component's worth of path
recomputation for at most nine seconds, and it stops before the fade-out rather
than running behind an invisible screen.

The `err.status` addition in `api.js` is additive. No existing caller reads a
`status` property off these errors today, and the message string is byte-for-byte
what it was, so the change cannot alter any current behaviour.
