# Web motion system

A motion vocabulary for the map frontend, and the nine places that speak it.

This is the first of two specs. The second covers the `ops/cc` terminal
dashboard, which shares this spec's intent and none of its code.

## Why

The frontend already has 57 animation and transition rules, and they already
carry a doctrine. `style.css` says it out loud in two places: motion on this
map means "now", and tempo is what separates an incident happening under the
camera from a standing condition that is merely still true. A hot infrastructure
zone flares at 1.1s; an airspace bulletin pulses at 2.4s; a jamming ping
reverberates at 6s.

That doctrine is real and worth keeping. What it lacks is a name. Every
duration in the stylesheet is a literal, and there are eleven distinct ones —
80ms, 120ms, 150ms, 160ms, 180ms, 200ms, 220ms, 300ms, 350ms, 400ms, 600ms —
with no rule for choosing between them. `popup-in` is copy-pasted at five call
sites. New motion added under those conditions drifts, and the drift is
invisible until the whole screen feels arbitrary.

So: extract the vocabulary that is already implied, then use it to make the
rest of the interface as alive as the parts that already are.

## Scope

In: `frontend/`. Out: `ops/cc/`, the backend, and the Pixi marker layer's
render loop.

## Constraints

These came from the user and are not negotiable within this spec.

- **`prefers-reduced-motion` is honoured.** Every new looping animation joins
  the existing `:root.reduce-motion` block. One-shot transitions survive it,
  because they report that a control responded rather than decorating.
- **60fps with 10k+ markers.** Nothing in this spec animates the Pixi
  ship/aircraft layer, and nothing added to the map introduces per-frame
  layout reads.
- **No motion on death tolls.** Casualty and fatality figures snap to their
  new value. Everything else that counts may tween. A death toll rolling
  upward like an odometer is the one thing on this map that must never look
  like a game score.

Idle looping animations are permitted. The user considered restricting motion
to state changes only and chose not to: a dashboard that stops moving when
nothing is wrong looks broken rather than calm.

## Architecture

### The token layer

One new file, `frontend/src/motion.css`, imported by `style.css` before any
rule that uses it. It holds two token families and nothing else — no
selectors, no component rules.

**Durations and easings**, for one-shot motion:

```css
:root {
  --t-tap: 90ms;      /* a control acknowledges a press */
  --t-ui: 160ms;      /* hover, caret, toggle, popup */
  --t-panel: 240ms;   /* a panel slides, a card enters */
  --t-settle: 420ms;  /* a value lands, a bar fills */
  --t-boot: 700ms;    /* the loading screen leaves */

  --e-out: cubic-bezier(0.22, 0.61, 0.36, 1);
  --e-inout: cubic-bezier(0.45, 0.05, 0.55, 0.95);
  --e-spring: cubic-bezier(0.34, 1.32, 0.64, 1);
}
```

`--e-spring` overshoots, and is for entrances only. A control that overshoots
on press feels loose rather than responsive.

**Tempos**, for looping motion. These are the existing values, named:

```css
:root {
  --tempo-urgent: 1.1s;   /* happening under the camera now */
  --tempo-live: 2.4s;     /* a standing condition, still true */
  --tempo-ambient: 6s;    /* background presence */
}
```

Existing rules are retagged to these tokens. Where a rule already sits on a
token value — `infra-flare` at 1.1s, `czib-warn` at 2.4s, `jamming-ping` at 6s
— nothing changes but the text. Where it does not, the value converges onto
the nearest token and the motion shifts slightly: `country-flare` 1.4s → 1.1s,
`news-pulse` 1.6s → 2.4s, `notable-pulse` 1.8s → 2.4s, and the one-shot
durations move by at most 60ms. That convergence is the point of having a
scale; if a rule genuinely needs a value the scale does not offer, that is an
argument for changing the scale, not for exempting the rule.

Two rules are exempt, and the exemption is written in the stylesheet next to
them: `loading-radar-spin` and `loading-ellipsis-pulse`. Those are mechanism —
a spinner reporting that work is in progress — not status. The tempo scale
answers "how urgent is this condition", which is a question a spinner is not
in a position to be asked.

The file is separate from `style.css` rather than a block at its top for two
reasons. `style.css` is 3511 lines, and a token block inside it would sit in
the same merge-hot region as layout. And "what moves, and how fast" becomes
one openable thing — the question "why does this feel slow" gets an address.

### Data-driven tempo

Three places take their tempo from live data rather than from a constant. Each
sets a CSS custom property inline from React; the stylesheet reads it. No
JavaScript animation loop is introduced anywhere in this spec.

The mechanism is uniform: a component computes a period, writes
`style={{ "--period": period }}`, and the rule says
`animation: name var(--period, var(--tempo-live)) ease-in-out infinite`. The
fallback matters — a source whose cadence is unknown must still breathe.

## Components

### 1. Entrances

`popup-in` exists five times (`style.css` lines 490, 1196, 1421, 1601, 3284)
with identical bodies. Replaced by one `.panel-enter` class on `--t-panel`
with `--e-spring`.

Cards whose content is a list stagger their children: a `--stagger-step` of
40ms, applied through `nth-child` up to eight items, flat delay beyond that.
Eight is where the perceived cascade stops reading as one gesture and starts
reading as a queue.

Applies to ConflictBriefingCard, CountryInfoCard, EventDetailCard,
NotableEventsPanel, NewsBroadcastPanel and ControlPanel. `news-item-in` is
already this animation under another name and folds into it.

### 2. Counting numbers

New hook, `frontend/src/hooks/useCountUp.js`. Takes a target integer, returns
the currently displayed integer, tweening over `--t-settle` with
`requestAnimationFrame`. Cancels cleanly on unmount and on a target that
changes mid-tween.

The tween arithmetic lives in a pure exported function so it can be tested
without a DOM:

```js
export function tweenValue(from, to, elapsed, duration) // -> integer
```

Applied to: source item counts, layer counts, ship and aircraft totals,
notable-event totals.

Not applied to: any figure that counts people. Casualty, fatality and injury
counts render directly and take a one-shot `alert` flash when they change, so
that the change is still noticed without being performed.

A number crossing a large delta — a source that jumps from 40 to 150,000 on
first load — must not spend `--t-settle` visibly spinning through six digits.
The hook skips the tween entirely when the target is the first non-zero value
it has seen, so initial load snaps and only subsequent updates animate.

### 3. Source status dots

`SourceStatusSection.jsx:36` renders a static `.dot` in one of three classes.
Health arrives from `useHealth`, which already carries
`seconds_since_success` per source.

The dot's period becomes that source's observed cadence, clamped into the
tempo range: a source that lands data every few seconds breathes near
`--tempo-urgent`, a slow one near `--tempo-ambient`, and a stale source stops
moving and goes flat. Stale means the same 1800 seconds the component already
uses to decide the `ok` class (`SourceStatusSection.jsx:32`) — one threshold,
not a second one invented for motion.

This is the point of the whole feature in one control: a still dot means
nothing is arriving. The motion is the status, not decoration on it.

Cadence derivation is a pure function, `dotPeriod(secondsSinceSuccess)`,
exported for test.

### 4. Event arrival

A conflict, notable or infrastructure marker that appears on the map runs one
`alert` flash as it lands — a single expansion and fade, on `--t-settle`, not
a loop.

"Appears" has to mean *new to the data*, not new to the screen.
`renderMarkerLayer` rebuilds markers as the viewport moves
(`createMapController.js:3007`), so a flash hung off marker construction would
fire on every pan and mean nothing. Instead the controller keeps the previous
poll's id set per layer and computes the ids that are new to it; only those
markers get the class. A layer whose previous set is empty is being seeded
rather than updated, and seeds nothing — otherwise first load flashes several
hundred pins at once.

Conflict, notable and infra layers only. The Pixi ship and aircraft layer is
explicitly excluded: those layers turn over thousands of markers per refresh,
and per-marker DOM animation there would violate the framerate constraint and
mean nothing anyway, since a ship appearing is not news.

### 5. Control panel folds

`Collapsible.jsx` is built on native `<details>`/`<summary>`, deliberately —
the file says why, and that reasoning stands. A closed `<details>` does not
render its body at all, so there is no height to transition from and the usual
`grid-template-rows: 0fr/1fr` trick has nothing to animate.

So: animate the opening only. `details[open] > .panel-group-body` runs a
one-shot `fold-open` keyframe on `--t-ui` — a small downward slide with a fade
— and closing stays instant. This works in every browser without feature
detection, and the asymmetry is the honest one: opening a fold is the reader
asking to see something, and closing it is them done looking.

The same rule applies to `.layer-details-body`. The caret rotation already
exists and retags to the token.

### 6. Controls acknowledge

LayerCheck, RegionBar buttons, timeline play/pause, `#themeToggle` and
`#adminToggle` get a `--t-tap` press response — a small scale-down on
`:active`. This is the cheapest item in the spec and the one most felt.

### 7. Loading screen

Already the best-animated surface here; the radar sweep and the pending-line
pulse stay as they are. Two changes: the boot log lines stagger in rather than
appearing as a block, and the existing durations retag to `--t-boot` and
`--t-settle`.

### 8. Notable events header

Tempo tracks event rate over the visible window. A quiet period breathes at
`--tempo-ambient`; a spike moves to `--tempo-urgent`. Third and last
data-driven place.

The rate-to-tempo mapping is a pure function alongside `dotPeriod`.

### 9. Reduce-motion

The block at `style.css:2586` gains every new looping selector. The
`useCountUp` hook checks `matchMedia("(prefers-reduced-motion: reduce)")` and
the `:root.reduce-motion` class, returning the target value immediately when
either is set — a CSS rule cannot stop a JavaScript tween, so the hook has to
opt out itself.

## Data flow

```
useHealth ──> SourceStatusSection ──> style={{"--period": dotPeriod(age)}}
                                              │
                                       motion.css reads it

useOsintData ──> counts ──> useCountUp ──> rendered integer

map controller ──> marker added ──> .alert-enter class ──> one-shot keyframe
```

Nothing new polls. Nothing new subscribes. Every data-driven tempo reads state
that a component already receives.

## Error handling

Motion has one failure mode worth designing for: a tempo computed from bad
data. A source reporting a negative or absurd `seconds_since_success` must not
produce a 4ms strobe.

`dotPeriod` clamps its output to `[--tempo-urgent, --tempo-ambient]` and
returns the stale (still) case for null, negative and non-finite input. The
same clamp applies to the event-rate mapping. Both are pure functions with
that clamp as their first tested property.

`useCountUp` on a non-finite target returns the target unchanged rather than
tweening toward `NaN`.

## Testing

The suite is `node --test` with no DOM, so the tests target the pure logic and
the token discipline, which is where the regressions actually live.

**`frontend/tests/motionTokens.test.js`** — parses `style.css` and asserts no
raw duration literal appears in an `animation` or `transition` declaration
outside `motion.css`. This is the test that keeps the vocabulary from eroding:
without it, the twelfth arbitrary duration arrives within a month.

**`frontend/tests/tempo.test.js`** — `dotPeriod` and the event-rate mapping.
Clamping at both ends, the stale case, and null/negative/`Infinity` input.

**`frontend/tests/countUp.test.js`** — `tweenValue`. Returns `from` at elapsed
0, `to` at elapsed >= duration, an integer throughout, and monotonic movement
between the two.

Not covered by automated test: whether it looks good. That is checked by
running the app and looking at it, which is the honest description of the
verification step and should not be dressed up as a test.

## What this deliberately does not do

No scanlines, CRT glow, typewriter text, full-map radar sweep or boot
sequence. The user was offered that and declined it: it fights the conflict
data the map exists to show.

No animation library. Three keyframe families and one 40-line hook do not
justify a dependency, and a dependency here would be loaded on a page that
already ships Pixi and Leaflet.

No motion on the Pixi layer, in any form, in this spec.
