# Web Motion System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the OSINT map frontend one shared motion vocabulary, then spend it on nine surfaces so the interface reads as a live system rather than a static one.

**Architecture:** A new `frontend/src/motion.css` holds every duration, easing and tempo as a CSS custom property. `style.css` imports it and stops containing literal timing values. Three surfaces take their tempo from live data by writing a CSS custom property inline from React; no JavaScript animation loop is introduced except one `requestAnimationFrame` tween for counting numbers. All timing logic that can be a pure function is one, so it can be tested under `node --test` with no DOM.

**Tech Stack:** React 18, Vite 5, plain CSS (no preprocessor, no animation library), `node --test` + `node:assert/strict` for tests. Leaflet and Pixi are loaded as globals and are not touched by this work.

## Global Constraints

Every task's requirements implicitly include these. They come from the spec at
`docs/superpowers/specs/2026-08-11-web-motion-system-design.md` and from the user.

- **No new dependencies.** Three keyframe families and one 40-line hook do not justify one.
- **`prefers-reduced-motion` is honoured.** Every new *looping* animation must be listed in the `:root.reduce-motion` block in `style.css`. One-shot transitions are exempt — they report that a control responded.
- **Nothing animates the Pixi ship/aircraft layer**, in any form, in any task.
- **No motion on death tolls.** Casualty, fatality and injury figures never tween. They snap.
- **Token values are exact:** `--t-tap: 90ms`, `--t-ui: 160ms`, `--t-panel: 240ms`, `--t-settle: 420ms`, `--t-boot: 700ms`, `--tempo-urgent: 1.1s`, `--tempo-live: 2.4s`, `--tempo-ambient: 6s`.
- **Two exempt animations**, which keep literal durations and carry a comment saying why: `loading-radar-spin` (1.7s) and `loading-ellipsis-pulse` (1.2s). Both are mechanism, not status.
- **Comment style:** this codebase writes comments that explain *why*, often at length, and never restates what the code plainly does. Match it. A comment that says `/* fade in the panel */` above a fade-in is worse than no comment.
- **All commands run from `frontend/`.** `npm test` runs `node --test`, which discovers `tests/*.test.js`.

---

### Task 1: The token layer

Creates the vocabulary and the test that keeps it from eroding. No visible change to the app: every value either stays put or moves by less than 100ms.

**Files:**
- Create: `frontend/src/motion.css`
- Create: `frontend/tests/motionTokens.test.js`
- Modify: `frontend/src/style.css` (add `@import` at line 1; retag every `transition`/`animation` duration)

**Interfaces:**
- Consumes: nothing.
- Produces: the CSS custom properties `--t-tap`, `--t-ui`, `--t-panel`, `--t-settle`, `--t-boot`, `--e-out`, `--e-inout`, `--e-spring`, `--tempo-urgent`, `--tempo-live`, `--tempo-ambient`, `--stagger-step`. Every later task uses these names and no literal durations.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/motionTokens.test.js`:

```js
// The vocabulary erodes silently. A twelfth arbitrary duration does not break
// anything, it just makes the screen feel slightly more arbitrary than it did
// yesterday, and nobody notices until the whole thing feels wrong. This test is
// the thing that notices.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A duration literal: 0.15s, .2s, 90ms, 1.1s. Not a percentage, not a colour.
// Deliberately not /g: a global regex carries lastIndex between .test() calls
// and would report every other line as clean.
const DURATION = /(?<![\w-])\d*\.?\d+m?s(?![\w-])/;

// Mechanism, not status -- a spinner reporting that work is in progress cannot
// be asked "how urgent is this condition", which is the only question the tempo
// scale answers. Both carry the same explanation in the stylesheet.
const EXEMPT = ["loading-radar-spin", "loading-ellipsis-pulse"];

function timingLines(css) {
  return css
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\b(animation|transition)\b\s*:/.test(line))
    .filter(([, line]) => !EXEMPT.some((name) => line.includes(name)));
}

test("motion.css defines every token the stylesheet is allowed to use", () => {
  const motion = read("../src/motion.css");
  for (const token of [
    "--t-tap", "--t-ui", "--t-panel", "--t-settle", "--t-boot",
    "--e-out", "--e-inout", "--e-spring",
    "--tempo-urgent", "--tempo-live", "--tempo-ambient",
    "--stagger-step",
  ]) {
    assert.ok(motion.includes(`${token}:`), `motion.css is missing ${token}`);
  }
});

test("style.css states no duration of its own", () => {
  const offenders = timingLines(read("../src/style.css"))
    .filter(([, line]) => DURATION.test(line.replace(/var\([^)]*\)/g, "")))
    .map(([number, line]) => `style.css:${number}: ${line.trim()}`);
  assert.deepEqual(offenders, [], `raw durations outside motion.css:\n${offenders.join("\n")}`);
});

test("the exempt animations say why they are exempt", () => {
  const css = read("../src/style.css");
  for (const name of EXEMPT) {
    const at = css.indexOf(`animation: ${name}`);
    assert.notEqual(at, -1, `${name} no longer exists; drop it from EXEMPT`);
    // The 400 characters before it must explain the exemption, so that deleting
    // the explanation fails the test rather than quietly orphaning the rule.
    assert.match(css.slice(Math.max(0, at - 400), at), /mechanism/i,
      `${name} is exempt from the tempo scale and must say why`);
  }
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: FAIL. First test errors with `ENOENT` on `src/motion.css`; the second reports a long list of `style.css:NNN` offenders.

- [ ] **Step 3: Create the token file**

Create `frontend/src/motion.css`:

```css
/* Every duration, easing and tempo this interface uses.
 *
 * The stylesheet had eleven distinct duration literals and no rule for
 * choosing between them, which is how a screen ends up feeling arbitrary
 * without any single rule being wrong. These are that rule.
 *
 * Kept out of style.css deliberately. That file is 3500 lines and a token
 * block at the top of it would sit in the same merge-hot region as layout;
 * here, "why does this feel slow" has an address. */

:root {
  /* One-shot motion. The scale is roughly logarithmic because perception is:
   * the step from 90ms to 160ms is as noticeable as the one from 240ms to
   * 420ms. */
  --t-tap: 90ms;      /* a control acknowledges a press */
  --t-ui: 160ms;      /* hover, caret, toggle, popup */
  --t-panel: 240ms;   /* a panel slides, a card enters */
  --t-settle: 420ms;  /* a value lands, a bar fills */
  --t-boot: 700ms;    /* the loading screen leaves */

  --e-out: cubic-bezier(0.22, 0.61, 0.36, 1);
  --e-inout: cubic-bezier(0.45, 0.05, 0.55, 0.95);
  /* Overshoots. Entrances only -- a control that overshoots when pressed feels
   * loose rather than responsive. */
  --e-spring: cubic-bezier(0.34, 1.32, 0.64, 1);

  /* Delay between consecutive children of a staggered list. Eight children is
   * where the cascade stops reading as one gesture and starts reading as a
   * queue, so nothing staggers past that. */
  --stagger-step: 40ms;

  /* Looping motion, and the reason this file exists at all.
   *
   * Motion on this map means "now" -- see the hot-zone and CZIB rules in
   * style.css, which have said so since long before this file did. Tempo is
   * what separates an incident happening under the camera from a standing
   * condition that is merely still true. Both are live; only one is urgent. */
  --tempo-urgent: 1.1s;   /* happening under the camera now */
  --tempo-live: 2.4s;     /* a standing condition, still true */
  --tempo-ambient: 6s;    /* background presence */
}
```

- [ ] **Step 4: Import it from the stylesheet**

At the very top of `frontend/src/style.css`, above the existing `* { box-sizing: border-box; }`:

```css
/* Must be first: @import is only legal before any other rule, and every
   duration below is one of these tokens. */
@import "./motion.css";
```

- [ ] **Step 5: Retag every duration in style.css**

Work through each line the failing test named. Apply this mapping — it is exhaustive for the current file:

| Current | Becomes |
| --- | --- |
| `0.08s` | `var(--t-tap)` |
| `0.12s` | `var(--t-tap)` |
| `0.15s` | `var(--t-ui)` |
| `0.16s` | `var(--t-ui)` |
| `0.18s` | `var(--t-ui)` |
| `0.2s` | `var(--t-ui)` |
| `0.22s` | `var(--t-panel)` |
| `0.3s` | `var(--t-panel)` |
| `0.35s` | `var(--t-settle)` |
| `0.4s` | `var(--t-settle)` |
| `0.6s` | `var(--t-boot)` |
| `120ms` (the two SVG transitions near line 178) | `var(--t-ui)` |
| `1.1s` (`infra-flare`, `infra-badge-pulse`) | `var(--tempo-urgent)` |
| `1.4s` (`country-flare`) | `var(--tempo-urgent)` |
| `1.6s` (`news-pulse`) | `var(--tempo-live)` |
| `1.8s` (`notable-pulse`) | `var(--tempo-live)` |
| `2.4s` (`czib-warn`) | `var(--tempo-live)` |
| `6s` (`jamming-ping`) | `var(--tempo-ambient)` |

Replace bare `ease` with `var(--e-out)` and `ease-in-out` with `var(--e-inout)` on the same lines. Leave `linear` alone; it is only on the exempt radar spin.

Leave `transition: none` (line 214) and `animation: none` rules exactly as they are — they state no duration and the test does not flag them.

- [ ] **Step 6: Add the exemption comments**

Above `.loading-radar-sweep`'s `animation:` line and above the
`.loading-log-line.pending .loading-log-status` rule, state the exemption. Both
must contain the word "mechanism", which is what the third test checks:

```css
/* Exempt from the tempo scale on purpose: this is mechanism, not status. The
   tempo tokens answer "how urgent is this condition", and a spinner saying
   work is in progress is not in a position to be asked that. */
```

- [ ] **Step 7: Run the tests**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 8: Run the whole suite for regressions**

```bash
cd frontend && npm test
```

Expected: PASS. No existing test reads CSS, so nothing else should move.

- [ ] **Step 9: Look at it**

```bash
cd frontend && npm run dev
```

Open the app. Confirm the hot-zone flare, the LIVE dot, the jamming pings and the loading radar all still animate, and that hovering a control still responds. This step catches a mistyped `var()`, which CSS fails silently rather than loudly.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/motion.css frontend/src/style.css frontend/tests/motionTokens.test.js
git commit -m "Name the durations the stylesheet was already using"
```

---

### Task 2: One entrance, used everywhere

`popup-in` is copy-pasted at five call sites with identical bodies. This replaces all five with one class, and gives list-bearing cards a stagger.

**Files:**
- Modify: `frontend/src/style.css` (lines ~490, ~1196, ~1421, ~1548, ~1601, ~3284)

**Interfaces:**
- Consumes: `--t-panel`, `--e-spring`, `--stagger-step` from Task 1.
- Produces: the classes `.panel-enter` and `.stagger-children`, used by no JavaScript — they are applied to existing selectors in the stylesheet itself.

- [ ] **Step 1: Find every copy**

```bash
cd frontend && grep -n "popup-in\|news-item-in" src/style.css
```

Expected: six or seven lines — five `animation: popup-in` uses, the `@keyframes popup-in` block near line 1198, and `news-item-in` near 1548.

- [ ] **Step 2: Write the single entrance**

In `style.css`, next to where `@keyframes popup-in` currently lives, replace that block with:

```css
/* Every card and panel on this map enters the same way. It used to be five
   identical copies of one keyframe under one name, which is the state a
   stylesheet is in right before it acquires a sixth that is subtly different. */
.panel-enter,
.leaflet-popup,
#conflictBriefing,
#countryInfoCard,
#eventDetailCard,
#notableEvents,
#newsBroadcast {
  animation: panel-enter var(--t-panel) var(--e-spring);
}

@keyframes panel-enter {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* A list arriving as one block reads as a repaint; arriving in sequence reads
   as the panel filling. Stops at eight because past that the cascade stops
   being one gesture and becomes a queue -- the ninth item onward simply shares
   the eighth's delay. */
.stagger-children > * {
  animation: panel-enter var(--t-panel) var(--e-out) both;
  animation-delay: calc(var(--stagger-step) * 8);
}
.stagger-children > :nth-child(1) { animation-delay: 0ms; }
.stagger-children > :nth-child(2) { animation-delay: var(--stagger-step); }
.stagger-children > :nth-child(3) { animation-delay: calc(var(--stagger-step) * 2); }
.stagger-children > :nth-child(4) { animation-delay: calc(var(--stagger-step) * 3); }
.stagger-children > :nth-child(5) { animation-delay: calc(var(--stagger-step) * 4); }
.stagger-children > :nth-child(6) { animation-delay: calc(var(--stagger-step) * 5); }
.stagger-children > :nth-child(7) { animation-delay: calc(var(--stagger-step) * 6); }
.stagger-children > :nth-child(8) { animation-delay: calc(var(--stagger-step) * 7); }
```

- [ ] **Step 3: Delete the five copies**

Remove each `animation: popup-in ...` declaration and the `@keyframes popup-in` block. The selectors that carried them are now listed on `.panel-enter` above. Check the exact selector each of the five sat on and make sure it appears in that list — if one of them is a selector not named above, add it rather than dropping it.

- [ ] **Step 4: Point the news list at the shared stagger**

`.news-list` and `.notable-list` gain `.stagger-children`'s rules. Rather than
editing JSX, add the selectors to the stagger block — **including the delay
ladder**, not only the base rule. The animation without the per-child delays is
every item entering in unison, which is the thing this step exists to prevent:

```css
.stagger-children > *,
.news-list > *,
.notable-list > * {
  animation: panel-enter var(--t-panel) var(--e-out) both;
  animation-delay: calc(var(--stagger-step) * 8);
}
```

and add `.news-list > :nth-child(N)` and `.notable-list > :nth-child(N)`
alongside each of the eight `.stagger-children > :nth-child(N)` selectors.

Then delete `news-item-in` and its keyframes, which is this animation with a
different name and a 5px offset.

- [ ] **Step 5: Run the token test**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: PASS. New rules use tokens only; if one does not, this fails and names the line.

- [ ] **Step 6: Look at it**

Run `npm run dev`. Click a country to open the info card, open the briefing card, and watch the news ticker refresh. Each should enter with a slight overshoot; news items should cascade rather than appear as a block.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/style.css
git commit -m "Give every panel the same entrance instead of five copies of it"
```

---

### Task 3: Numbers that count, and numbers that must not

The tween arithmetic is pure and tested; the hook wraps it; a component wraps the hook. Casualty figures are excluded here and stay excluded.

**Files:**
- Create: `frontend/src/hooks/useCountUp.js`
- Create: `frontend/src/components/CountUp.jsx`
- Create: `frontend/tests/countUp.test.js`
- Modify: `frontend/src/components/controlPanel/LayersSection.jsx` (the `<span className="count">` sites, first at line 170)
- Modify: `frontend/src/components/NotableEventsPanel.jsx:174`

**Interfaces:**
- Consumes: `--t-settle` (as the literal `420` in JS — see Step 3's note).
- Produces:
  - `tweenValue(from: number, to: number, elapsed: number, duration: number) => number` (integer)
  - `useCountUp(target: number) => number`
  - `<CountUp value={number} />` rendering an integer text node.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/countUp.test.js`:

```js
// The arithmetic behind the counting numbers, kept pure so it can be tested
// without a DOM or a clock. The hook around it is four lines of
// requestAnimationFrame and is not what breaks.

import test from "node:test";
import assert from "node:assert/strict";

import { tweenValue } from "../src/hooks/useCountUp.js";

test("starts at the old value and ends at the new one", () => {
  assert.equal(tweenValue(10, 90, 0, 420), 10);
  assert.equal(tweenValue(10, 90, 420, 420), 90);
  // Past the end, not stuck near it: a dropped frame must not leave a counter
  // reading 89 forever.
  assert.equal(tweenValue(10, 90, 10000, 420), 90);
});

test("moves monotonically and stays an integer", () => {
  let previous = tweenValue(0, 500, 0, 420);
  for (let elapsed = 0; elapsed <= 420; elapsed += 7) {
    const value = tweenValue(0, 500, elapsed, 420);
    assert.ok(Number.isInteger(value), `${value} is not an integer`);
    assert.ok(value >= previous, `${value} went backwards from ${previous}`);
    previous = value;
  }
});

test("counts down as readily as up", () => {
  assert.equal(tweenValue(90, 10, 0, 420), 90);
  assert.equal(tweenValue(90, 10, 420, 420), 10);
  assert.ok(tweenValue(90, 10, 210, 420) < 90);
});

test("refuses to tween toward nonsense", () => {
  // A source that returns null for its count must not leave a ticker counting
  // toward NaN, which renders as the string "NaN" and looks like a crash.
  assert.equal(tweenValue(10, NaN, 210, 420), 10);
  assert.equal(tweenValue(10, Infinity, 210, 420), 10);
  assert.equal(tweenValue(NaN, 90, 210, 420), 90);
});

test("a zero duration lands immediately", () => {
  // Reduced motion sets the duration to zero rather than taking a second code
  // path, so this case has to be division-by-zero-safe.
  assert.equal(tweenValue(10, 90, 0, 0), 90);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && node --test tests/countUp.test.js
```

Expected: FAIL, `Cannot find module .../src/hooks/useCountUp.js`.

- [ ] **Step 3: Write the hook**

Create `frontend/src/hooks/useCountUp.js`:

```js
// A number that changes is worth noticing. A number that changes by rolling to
// its new value is worth noticing without anyone having been watching it.
//
// Deliberately not applied to anything that counts people -- see CountUp.jsx.

import { useEffect, useRef, useState } from "react";

// Matches --t-settle. Stated here rather than read from the stylesheet because
// reading a custom property means a getComputedStyle call per tween, which is a
// layout read in a requestAnimationFrame loop -- the exact thing this feature
// is not allowed to do. The token test does not cover this; the comment is the
// only thing keeping the two in step, so change both or neither.
export const COUNT_DURATION_MS = 420;

/**
 * Where a counter sits partway through its tween.
 *
 * Eased rather than linear: a linear counter reads as a progress bar, and this
 * is a value landing, not work completing.
 */
export function tweenValue(from, to, elapsed, duration) {
  if (!Number.isFinite(to)) return Number.isFinite(from) ? from : 0;
  if (!Number.isFinite(from)) return to;
  if (!(duration > 0) || elapsed >= duration) return to;
  if (elapsed <= 0) return from;
  const t = elapsed / duration;
  const eased = 1 - (1 - t) ** 3;
  const value = from + (to - from) * eased;
  // Round toward the destination so the last visible frame before the end is
  // never one short of it.
  return to >= from ? Math.floor(value) : Math.ceil(value);
}

function motionIsReduced() {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.classList.contains("reduce-motion") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * @param {number} target
 * @returns {number} the value to display right now
 */
export function useCountUp(target) {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const seeded = useRef(false);

  useEffect(() => {
    // Two cases snap rather than tween, and they are the same case wearing two
    // hats: a counter that has nothing to count up from.
    //
    // The mount run is the obvious one. The second is not: every counts object
    // in this app starts as EMPTY_COUNTS, every key literally zero (see
    // map/useLeafletMap.js), and the control panel mounts before the first poll
    // lands. So the mount run seeds zero and the *first real value* arrives as
    // an ordinary update -- which is how a source going from 0 to 150,000 spends
    // 420ms visibly spinning through six digits and reads as a loading state
    // rather than as an update.
    //
    // Hence: counting up from nothing is a load. The cost is that a layer
    // genuinely going 0 -> 3 snaps too, which is a fair price for never
    // spinning the odometer on page load.
    if (!seeded.current || from.current === 0) {
      seeded.current = true;
      from.current = target;
      setShown(target);
      return undefined;
    }
    // A CSS rule cannot stop a JavaScript tween, so the hook has to opt itself
    // out of reduced motion.
    if (motionIsReduced()) {
      from.current = target;
      setShown(target);
      return undefined;
    }

    const start = performance.now();
    const startedAt = from.current;
    let frame = requestAnimationFrame(function step(now) {
      const value = tweenValue(startedAt, target, now - start, COUNT_DURATION_MS);
      // Written here rather than in the cleanup, which is the subtle part.
      // React keeps the destroy function from the run that created it and does
      // not refresh it on renders where the deps did not change -- and setShown
      // re-renders this component ~25 times without `target` moving. A cleanup
      // that read `shown` would therefore read the value from before the tween
      // started, so a counts update arriving mid-tween would visibly jump the
      // number backwards before rolling up again. Counts change several times
      // inside 420ms during a pan, so that is the common path, not the corner.
      from.current = value;
      setShown(value);
      if (value !== target) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}
```

- [ ] **Step 4: Run the test**

```bash
cd frontend && node --test tests/countUp.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the component**

Create `frontend/src/components/CountUp.jsx`:

```jsx
// A counter that rolls to its new value.
//
// Never put this around a casualty figure. Fatality and injury counts on this
// map render directly and snap, and they do so on purpose: a death toll
// climbing like an odometer is the one thing here that must not be performed.
// If a future ticker counts people, it does not get this component.

import { useCountUp } from "../hooks/useCountUp";

export default function CountUp({ value }) {
  const shown = useCountUp(Number.isFinite(value) ? value : 0);
  return <>{shown}</>;
}
```

- [ ] **Step 6: Apply it to the neutral counters**

In `frontend/src/components/controlPanel/LayersSection.jsx`, import it:

```jsx
import CountUp from "../CountUp";
```

Then wrap the numeric halves of each layer ticker. The first is at line 170:

```jsx
<span className="count"><CountUp value={counts.events} /> (<CountUp value={counts.eventsTotal} />)</span>
```

Apply the same shape to every other `<span className="count">` in the file (`counts.gdelt`, `counts.conflictHistory`, `counts.officials`, and the rest — `grep -n 'className="count"' src/components/controlPanel/LayersSection.jsx` lists them).

Leave the group counts (`groupCount`, line 136) alone: they render as `"3/7"`, a ratio rather than a magnitude, and a ratio counting up is noise.

In `frontend/src/components/NotableEventsPanel.jsx:174`, the count span becomes:

```jsx
<span className="notable-count">
  {zones.length ? <>{zones.length}&#8593; <CountUp value={items.length} /></> : <CountUp value={items.length} />}
</span>
```

with `import CountUp from "./CountUp";` at the top.

- [ ] **Step 7: Confirm the exclusion holds**

```bash
cd frontend && grep -rn "fatalities\|casualt\|killed\|injur" src/components/ | grep -i countup
```

Expected: no output. If this prints anything, a casualty figure has been wrapped and must be unwrapped.

- [ ] **Step 8: Run the whole suite**

```bash
cd frontend && npm test
```

Expected: PASS.

- [ ] **Step 9: Look at it**

Run `npm run dev`, open the control panel, and watch a layer's ticker across a poll. The number should roll rather than jump. Confirm the notable panel's `· N killed` meta line does not move at all.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/hooks/useCountUp.js frontend/src/components/CountUp.jsx frontend/tests/countUp.test.js frontend/src/components/controlPanel/LayersSection.jsx frontend/src/components/NotableEventsPanel.jsx
git commit -m "Roll the counters to their new values, except the ones counting people"
```

---

### Task 4: Source dots that breathe at their own cadence

The first of three data-driven surfaces, and the one that makes the case: a still dot means nothing is arriving.

**Files:**
- Create: `frontend/src/utils/tempo.js`
- Create: `frontend/tests/tempo.test.js`
- Modify: `frontend/src/components/controlPanel/SourceStatusSection.jsx:29-40`
- Modify: `frontend/src/style.css` (add the `.dot.breathing` rule)

**Interfaces:**
- Consumes: `--tempo-urgent`, `--tempo-live`, `--tempo-ambient`.
- Produces: `dotPeriod(secondsSinceSuccess: number|null) => string|null` — a CSS duration like `"2.4s"`, or `null` meaning "do not animate".

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/tempo.test.js`:

```js
// Tempo derived from live data, which means tempo derived from data that can be
// wrong. A source reporting a negative age must not produce a 4ms strobe, so
// the clamp is the first property tested rather than an afterthought.

import test from "node:test";
import assert from "node:assert/strict";

import { dotPeriod, STALE_AFTER_SECONDS } from "../src/utils/tempo.js";

test("a fast source breathes fast and a slow one slow", () => {
  const fast = Number.parseFloat(dotPeriod(2));
  const slow = Number.parseFloat(dotPeriod(600));
  assert.ok(fast < slow, `expected ${fast}s to be quicker than ${slow}s`);
});

test("never faster than urgent, never slower than ambient", () => {
  for (const age of [0, 1, 5, 60, 600, 1799]) {
    const period = Number.parseFloat(dotPeriod(age));
    assert.ok(period >= 1.1, `${age}s gave ${period}s, faster than --tempo-urgent`);
    assert.ok(period <= 6, `${age}s gave ${period}s, slower than --tempo-ambient`);
  }
});

test("a stale source stops moving", () => {
  // The dot going still IS the status. This is the whole point of the feature,
  // so it is not allowed to degrade into "animates a bit slower".
  assert.equal(dotPeriod(STALE_AFTER_SECONDS), null);
  assert.equal(dotPeriod(STALE_AFTER_SECONDS + 1), null);
  assert.equal(dotPeriod(99999), null);
});

test("stale matches the threshold the panel already used", () => {
  // SourceStatusSection has drawn `ok` at under 1800s since long before this.
  // Two thresholds for one idea is how a dot ends up green and still.
  assert.equal(STALE_AFTER_SECONDS, 1800);
});

test("nonsense is treated as stale, not as urgent", () => {
  for (const bad of [null, undefined, -1, NaN, Infinity, "soon"]) {
    assert.equal(dotPeriod(bad), null, `${String(bad)} should read as stale`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && node --test tests/tempo.test.js
```

Expected: FAIL, `Cannot find module .../src/utils/tempo.js`.

- [ ] **Step 3: Write the mapping**

Create `frontend/src/utils/tempo.js`:

```js
// Turning live data into a tempo.
//
// The three tempo tokens in motion.css are a sentence the map has been saying
// since long before they had names: motion means "now", and how fast something
// moves says how urgent it is. These functions are how data gets to say it.

// The same threshold SourceStatusSection has always drawn `ok` against. One
// idea, one number -- a second threshold invented for motion is how a dot ends
// up green and still.
export const STALE_AFTER_SECONDS = 1800;

const URGENT = 1.1;
const AMBIENT = 6;

/**
 * How often a source's status dot should pulse, given how long ago it last
 * landed data.
 *
 * @param {number|null} secondsSinceSuccess
 * @returns {string|null} a CSS duration, or null for "do not animate"
 */
export function dotPeriod(secondsSinceSuccess) {
  // Before the coercion, not after: Number(null) is 0, so a source that has
  // never reported would otherwise read as one that reported this instant --
  // the single most wrong answer this function can give.
  if (secondsSinceSuccess === null || secondsSinceSuccess === undefined) return null;
  const age = Number(secondsSinceSuccess);
  if (!Number.isFinite(age) || age < 0 || age >= STALE_AFTER_SECONDS) return null;

  // Logarithmic, because source cadences span three orders of magnitude -- AIS
  // lands every few seconds and ACLED daily -- and a linear map would put every
  // source except the fastest at the same indistinguishable crawl.
  const t = Math.log10(1 + age) / Math.log10(1 + STALE_AFTER_SECONDS);
  const period = URGENT + (AMBIENT - URGENT) * t;
  return `${Math.min(AMBIENT, Math.max(URGENT, period)).toFixed(2)}s`;
}
```

- [ ] **Step 4: Run the test**

```bash
cd frontend && node --test tests/tempo.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the CSS**

In `style.css`, near the existing `.dot` rules:

```css
/* A source dot's pulse period is that source's own cadence (see
   utils/tempo.js), so the row reports how alive it is without anyone reading
   the "updated 4s ago" beside it. The still case is not a missing feature: a
   dot that has stopped moving is a source that has stopped arriving, and that
   is the fastest-reading status on the panel. */
.dot.breathing {
  animation: dot-breathe var(--period, var(--tempo-live)) var(--e-inout) infinite;
}

@keyframes dot-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.82); }
}
```

- [ ] **Step 6: Wire the component**

In `frontend/src/components/controlPanel/SourceStatusSection.jsx`, add the import:

```jsx
import { dotPeriod } from "../../utils/tempo";
```

and replace the dot at line 36. The surrounding `<li>` is unchanged:

```jsx
{(() => {
  const period = dotPeriod(info.seconds_since_success);
  return (
    <span
      className={`dot ${cls}${period ? " breathing" : ""}`}
      style={period ? { "--period": period } : undefined}
    />
  );
})()}
```

- [ ] **Step 7: Run the whole suite**

```bash
cd frontend && npm test
```

Expected: PASS.

- [ ] **Step 8: Look at it**

Run `npm run dev`, enter Admin Mode, open the Source status fold. Fast sources should pulse visibly quicker than slow ones, and any source that has not reported in half an hour should be completely still.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/utils/tempo.js frontend/tests/tempo.test.js frontend/src/components/controlPanel/SourceStatusSection.jsx frontend/src/style.css
git commit -m "Let each source's dot pulse at the cadence that source actually keeps"
```

---

### Task 5: The notable header tracks the event rate

**Files:**
- Modify: `frontend/src/utils/tempo.js` (add `ratePeriod`)
- Modify: `frontend/tests/tempo.test.js` (add its tests)
- Modify: `frontend/src/components/NotableEventsPanel.jsx:169`
- Modify: `frontend/src/style.css` (the existing `.notable-pulse` rule)

**Interfaces:**
- Consumes: `dotPeriod`'s neighbours in `utils/tempo.js`, `--tempo-*`.
- Produces: `ratePeriod(eventsInWindow: number) => string` — always a CSS duration, never null. The header always breathes; only its speed carries information.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/tempo.test.js`:

```js
import { ratePeriod } from "../src/utils/tempo.js";

test("a busy board beats faster than a quiet one", () => {
  const quiet = Number.parseFloat(ratePeriod(0));
  const busy = Number.parseFloat(ratePeriod(200));
  assert.ok(busy < quiet, `expected ${busy}s to be quicker than ${quiet}s`);
});

test("the header always breathes", () => {
  // Unlike a source dot, this one never goes still: a stopped header would read
  // as a broken panel rather than as a quiet world.
  for (const count of [0, 1, 50, 5000, -3, NaN, null]) {
    const period = ratePeriod(count);
    assert.match(period, /^\d+(\.\d+)?s$/, `${String(count)} gave ${period}`);
    const seconds = Number.parseFloat(period);
    assert.ok(seconds >= 1.1 && seconds <= 6, `${String(count)} gave ${period}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && node --test tests/tempo.test.js
```

Expected: FAIL, `ratePeriod is not a function`.

- [ ] **Step 3: Implement it**

Append to `frontend/src/utils/tempo.js`:

```js
// Where the world stops being quiet. Not a claim about severity -- the panel's
// own MIN_SEVERITY floor has already made that judgement, so anything counted
// here already cleared the bar for being worth interrupting someone over.
const BUSY_EVENTS = 60;

/**
 * How often the notable-activity header should pulse, given how much is on the
 * board.
 *
 * Never null: a header that stopped moving would read as a broken panel rather
 * than as a quiet world, which is the opposite of what a quiet world deserves.
 *
 * @param {number} eventsInWindow
 * @returns {string} a CSS duration
 */
export function ratePeriod(eventsInWindow) {
  const count = Number(eventsInWindow);
  if (!Number.isFinite(count) || count <= 0) return `${AMBIENT}s`;
  const t = Math.min(1, count / BUSY_EVENTS);
  const period = AMBIENT - (AMBIENT - URGENT) * t;
  return `${Math.min(AMBIENT, Math.max(URGENT, period)).toFixed(2)}s`;
}
```

- [ ] **Step 4: Run the test**

```bash
cd frontend && node --test tests/tempo.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the component**

In `NotableEventsPanel.jsx`, add to the existing import from `../map/severity` region:

```jsx
import { ratePeriod } from "../utils/tempo";
```

The pulse span at line 169 becomes — note it reads `eventsRaw`, the unfiltered
feed, not `items`, which is capped at six or eight and so could never say
anything about rate:

```jsx
<span className="notable-pulse" style={{ "--period": ratePeriod((eventsRaw || []).length) }} />
```

- [ ] **Step 6: Point the CSS at the property**

Change the existing `.notable-pulse` animation to read the custom property,
keeping `--tempo-live` as the fallback so a render without the style attribute
still breathes:

```css
.notable-pulse {
  /* ... existing size/colour declarations unchanged ... */
  animation: notable-pulse var(--period, var(--tempo-live)) var(--e-inout) infinite;
}
```

- [ ] **Step 7: Run the suite and the token test**

```bash
cd frontend && npm test
```

Expected: PASS.

- [ ] **Step 8: Look at it**

Run `npm run dev`. The notable header's dot should breathe slowly on a quiet world board and visibly faster when a busy region is selected.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/utils/tempo.js frontend/tests/tempo.test.js frontend/src/components/NotableEventsPanel.jsx frontend/src/style.css
git commit -m "Beat the notable header at the rate events are actually arriving"
```

---

### Task 6: A marker that is new to the data flashes once

**Files:**
- Create: `frontend/src/map/arrivals.js`
- Create: `frontend/tests/arrivals.test.js`
- Modify: `frontend/src/map/createMapController.js` (near `renderMarkerLayer`, line 2949, and `buildMarker`)
- Modify: `frontend/src/style.css`

**Interfaces:**
- Consumes: `--t-settle`.
- Produces: `newArrivals(previousIds: Set|null, items: Array, idField: string) => { ids: Set, arrived: Set }` — `ids` is the new complete set to keep, `arrived` is what to flash. A `previousIds` of `null` means "seeding", and returns an empty `arrived`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/arrivals.test.js`:

```js
// Which markers are actually new.
//
// "New" cannot mean "newly constructed": renderMarkerLayer rebuilds markers as
// the viewport moves, so a flash hung off construction would fire on every pan
// and would mean nothing. It has to mean new to the data.

import test from "node:test";
import assert from "node:assert/strict";

import { newArrivals } from "../src/map/arrivals.js";

const items = (...ids) => ids.map((id) => ({ id }));

test("seeding flashes nothing", () => {
  // First load is several hundred events at once. Flashing them would be a
  // firework display over a conflict map.
  const { ids, arrived } = newArrivals(null, items("a", "b", "c"), "id");
  assert.deepEqual([...arrived], []);
  assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});

test("only the ids absent last time arrive", () => {
  const first = newArrivals(null, items("a", "b"), "id");
  const second = newArrivals(first.ids, items("a", "b", "c", "d"), "id");
  assert.deepEqual([...second.arrived].sort(), ["c", "d"]);
});

test("a pan that drops items out of view is not an arrival when they return", () => {
  const first = newArrivals(null, items("a", "b"), "id");
  const panned = newArrivals(first.ids, items("a", "b"), "id");
  assert.deepEqual([...panned.arrived], []);
});

test("the id set tracks removals so a returning event flashes again", () => {
  // A record dropping out of the feed and coming back later genuinely is news
  // arriving twice, which is the honest reading.
  const first = newArrivals(null, items("a", "b"), "id");
  const gone = newArrivals(first.ids, items("a"), "id");
  assert.deepEqual([...gone.ids], ["a"]);
  const back = newArrivals(gone.ids, items("a", "b"), "id");
  assert.deepEqual([...back.arrived], ["b"]);
});

test("items with no id are ignored rather than crashing the render", () => {
  const { ids, arrived } = newArrivals(new Set(["a"]), [{ id: "a" }, {}, { id: null }], "id");
  assert.deepEqual([...ids], ["a"]);
  assert.deepEqual([...arrived], []);
});

test("an empty payload clears the set without flashing", () => {
  const first = newArrivals(null, items("a"), "id");
  const empty = newArrivals(first.ids, [], "id");
  assert.deepEqual([...empty.ids], []);
  assert.deepEqual([...empty.arrived], []);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && node --test tests/arrivals.test.js
```

Expected: FAIL, `Cannot find module .../src/map/arrivals.js`.

- [ ] **Step 3: Implement it**

Create `frontend/src/map/arrivals.js`:

```js
// Which records are new to a layer since the last time it was asked.
//
// Kept out of createMapController because it is the one part of the arrival
// flash with a right and a wrong answer, and that file is not somewhere a pure
// function can be tested.

/**
 * @param {Set|null} previousIds  null on the first call for a layer
 * @param {Array<object>} items   the layer's full payload, not the visible slice
 * @param {string} idField        ID_FIELD's entry for this layer
 * @returns {{ids: Set, arrived: Set}}
 */
export function newArrivals(previousIds, items, idField) {
  const ids = new Set();
  for (const item of items || []) {
    const id = item?.[idField];
    if (id === undefined || id === null) continue;
    ids.add(id);
  }
  // A null previous set means this layer is being seeded, not updated. Every id
  // is new by definition and none of them is news.
  if (previousIds === null || previousIds === undefined) return { ids, arrived: new Set() };

  const arrived = new Set();
  for (const id of ids) if (!previousIds.has(id)) arrived.add(id);
  return { ids, arrived };
}
```

- [ ] **Step 4: Run the test**

```bash
cd frontend && node --test tests/arrivals.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the controller**

In `createMapController.js`, add the import alongside the other `./` map imports:

```js
import { newArrivals } from "./arrivals";
```

Next to the existing `markersByKey` declaration, add the two pieces of state:

```js
// Which record ids each layer held last render, and which of them are new
// enough to still be flashing. Only the layers where a new record is news --
// a ship appearing is not.
const seenIdsByKey = {};
const arrivedByKey = {};
const FLASHES_ON_ARRIVAL = new Set(["events", "gdelt", "osmInfra", "czib"]);
```

Inside `renderMarkerLayer`, immediately after `const items = raw[key] || [];`
(line 2985):

```js
if (FLASHES_ON_ARRIVAL.has(key)) {
  const { ids, arrived } = newArrivals(seenIdsByKey[key] ?? null, items, idField);
  seenIdsByKey[key] = ids;
  // Held until the next render of this layer rather than on a timer: the class
  // only has to survive long enough for the marker to be built with it, and the
  // animation is one-shot, so a stray timer would be a second source of truth
  // about when the flash ends.
  if (arrived.size) arrivedByKey[key] = arrived;
  else delete arrivedByKey[key];
}
```

The class goes on `d.icon.options.className`, in **both** `buildMarker` and
`updateMarker`:

```js
// One flash as it lands. buildMarker also runs when a known record scrolls
// back into view, which is why the test is against the arrival set and not
// against "is this marker new".
//
// className, never options.html: the html string is this file's repaint
// change-test (see updateMarker), so a class baked into it makes every
// arriving marker compare unequal on the next pass and get its DOM rebuilt --
// which tears down the very animation it was added to start. className is
// outside that test, which is what makes it free.
const arriving = arrivedByKey[key]?.has(item[ID_FIELD[key]]) ? " marker-arrived" : "";
```

`updateMarker` must apply it too, or the layer's synchronous second pass strips
it: `settlePlacement` marks the layer dirty whenever a declutter offset moves,
which calls `renderMarkerLayer` again inside the same task, before the browser
has painted once.

That second pass is also why `arrivedByKey` cannot have a one-render lifetime.
Store `{id → timestamp}` and treat an entry as live for `--t-settle`, expiring
on read. The plan previously argued a timer would be "a second source of truth"
about when the flash ends; that was wrong, because the layer reliably
re-renders within milliseconds and the render count is the unreliable clock.

Finally, in `skipHiddenLayer`, clear both maps for the layer:

```js
// A layer that goes dark stops being updated, so its id set goes stale. Coming
// back is a re-seed, not an update -- without this, a conflict layer switched
// off for an hour flashes every record that arrived meanwhile.
delete seenIdsByKey[key];
delete arrivedByKey[key];
```

- [ ] **Step 6: Write the CSS**

```css
/* A record that is new to the feed, flashing once as it lands. One-shot, not a
   loop: this says "this just arrived", and a pin that kept flashing would be
   saying "this is urgent", which is severity's job and not arrival's.

   Conflict, news, infrastructure and airspace only. The ship and aircraft
   layers turn over thousands of markers a refresh and a vessel appearing is
   not news.

   Targets the inner <svg>, and that is load-bearing. Leaflet positions the
   outer marker div with an inline translate3d, so animating transform there
   parks the pin at the pane origin for the whole flash. One element in --
   .entity-icon-wrap -- is no better: it carries the declutter offset and
   rotation inline, so a transform animation on it snaps the glyph up to ~87px
   back to its true point while its leader line keeps pointing where the glyph
   used to be. A line that exists to say "the glyph is not where the record is"
   would spend 420ms asserting the opposite. The wrapper also carries inline
   opacity for age and confidence dimming, so animating opacity there flashes a
   low-confidence event at full strength -- briefly claiming more certainty
   than the record has. The <svg> child carries neither. */
.marker-arrived .entity-icon-wrap > svg {
  animation: marker-arrived var(--t-settle) var(--e-out);
}

@keyframes marker-arrived {
  from { transform: scale(2.1); opacity: 0; }
  60% { opacity: 1; }
  to { transform: scale(1); opacity: 1; }
}
```

- [ ] **Step 7: Run the whole suite**

```bash
cd frontend && npm test
```

Expected: PASS.

- [ ] **Step 8: Look at it, including the case that must not fire**

Run `npm run dev`. Two things to confirm, and the second is the one that matters:

1. Leave the map on a busy region across a poll. New conflict pins should flash once as they land.
2. Pan and zoom repeatedly without waiting for a poll. **Nothing should flash.** If pins flash while panning, the arrival set is being computed from the visible slice instead of from `items`, and Step 5 is wrong.

Also confirm the ship and aircraft layers never flash.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/map/arrivals.js frontend/tests/arrivals.test.js frontend/src/map/createMapController.js frontend/src/style.css
git commit -m "Flash a pin once when the record behind it is new to the feed"
```

---

### Task 7: Folds open, and controls admit they were pressed

The cheapest task here and the most felt. No new logic, so no new unit test — the token test covers the only thing that can silently rot.

**Files:**
- Modify: `frontend/src/style.css`

**Interfaces:**
- Consumes: `--t-tap`, `--t-ui`, `--e-out`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Animate the folds open**

`Collapsible.jsx` is built on native `<details>`, and the file explains at
length why — that reasoning stands and is not to be touched. A closed
`<details>` does not render its body, so there is no height to transition from
and no `grid-template-rows` trick to reach for. Animate the opening only:

```css
/* Opening a fold is the reader asking to see something; closing it is them
   done looking. So the open is animated and the close is instant, which also
   happens to be the only thing native <details> can do without a height to
   transition from. */
details[open] > .panel-group-body,
details[open] > .layer-details-body {
  animation: fold-open var(--t-ui) var(--e-out);
}

@keyframes fold-open {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: Make controls acknowledge a press**

```css
/* The difference between "clicked" and "clicked?". Scale rather than colour:
   several of these already change colour to mean something else (a pinned
   layer, an active region, Admin Mode being on), and a press must not be
   confusable with a state. */
.layer-check,
.region-btn,
.region-zone-menu-item,
.timeline-play,
.timeline-live-btn,
.news-locate-btn,
.news-caret-btn,
#themeToggle,
#adminToggle {
  transition: transform var(--t-tap) var(--e-out);
}
.layer-check:active,
.region-btn:active,
.region-zone-menu-item:active,
.timeline-play:active,
.timeline-live-btn:not(:disabled):active,
.news-locate-btn:active,
.news-caret-btn:active,
#themeToggle:active,
#adminToggle:active {
  transform: scale(0.93);
}
```

Where one of these selectors already has a `transition`, extend that
declaration rather than adding a second one — a later `transition` property
replaces an earlier one outright, and silently dropping an existing hover
transition is exactly the kind of regression this would cause.

```bash
cd frontend && grep -n "region-btn\|timeline-play\|themeToggle\|adminToggle\|news-locate-btn" src/style.css | grep transition
```

- [ ] **Step 3: Run the token test**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: PASS.

- [ ] **Step 4: Look at it**

Run `npm run dev`. Open and close the control panel's groups — opening should
slide, closing should be instant. Press the region buttons, the theme toggle
and the timeline play button; each should visibly give under the press.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/style.css
git commit -m "Slide the folds open and let the controls give under a press"
```

---

### Task 8: The boot log arrives in sequence

**Files:**
- Modify: `frontend/src/style.css` (the `.loading-log-line` rules near line 2523)

**Interfaces:**
- Consumes: `--t-panel`, `--stagger-step`, `--e-out`.
- Produces: nothing.

- [ ] **Step 1: Stagger the log lines**

The loading screen is already the best-animated surface here; the radar sweep
and the pending pulse stay exactly as they are. Only the log changes.

Do **not** restate the eight `nth-child` delay rules — Task 2 already wrote
them once, under `.stagger-children`. Reuse that definition by adding
`.loading-log` to the selector lists Task 2 created, exactly as `.news-list`
and `.notable-list` are already there:

```css
.news-list > *,
.notable-list > *,
.loading-log > * {
  animation: panel-enter var(--t-panel) var(--e-out) both;
}
```

and add `.loading-log > :nth-child(N)` alongside each of Task 2's eight
`.stagger-children > :nth-child(N)` selectors, so the delay ladder has one
definition in the stylesheet rather than two.

`.loading-log` is the `<ul>` and `.loading-log-line` its `<li>` children, so
the child combinator lands on the right element without touching
`LoadingScreen.jsx`.

The existing `transition: opacity ..., color ...` on `.loading-log-line` stays:
it carries the pending → ok → warn transitions, which are a different thing
from the line's arrival.

- [ ] **Step 2: Confirm the exempt animations survived**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: PASS, including the test asserting both exempt animations still exist
and still explain themselves. If the third test fails, Step 1 overwrote the
radar or the ellipsis pulse.

- [ ] **Step 3: Look at it**

Hard-reload the app (the loading screen only shows on a cold load; `Ctrl+Shift+R`).
The boot log lines should cascade rather than appear at once, and the radar
should spin at exactly the speed it always has.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/style.css
git commit -m "Bring the boot log up a line at a time"
```

---

### Task 9: Reduced motion covers everything new

The constraint that is easiest to satisfy per-rule and easiest to forget in aggregate. This task closes it and adds the test that keeps it closed.

**Files:**
- Modify: `frontend/src/style.css:2586` (the `:root.reduce-motion` block)
- Modify: `frontend/tests/motionTokens.test.js` (add the coverage test)

**Interfaces:**
- Consumes: every looping selector introduced by Tasks 4, 5 and 6.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `frontend/tests/motionTokens.test.js`:

```js
test("every looping animation can be switched off", () => {
  const css = read("../src/style.css");
  const reduceBlock = css.slice(css.indexOf(":root.reduce-motion"));
  const stop = reduceBlock.indexOf("animation: none");
  assert.notEqual(stop, -1, "the reduce-motion block has gone missing");
  const selectors = reduceBlock.slice(0, stop);

  // Every rule that loops. A looping animation nobody can switch off is the one
  // accessibility failure this feature can actually cause, and it is invisible
  // to whoever adds the loop.
  const looping = [...css.matchAll(/animation:[^;]*infinite/g)]
    .map((match) => {
      // Walk back to the selector that owns this declaration.
      const before = css.slice(0, match.index);
      const brace = before.lastIndexOf("{");
      return before.slice(before.lastIndexOf("}", brace) + 1, brace).trim();
    })
    .filter((selector) => selector && !selector.startsWith("@"));

  const uncovered = looping.filter((selector) => {
    const leaf = selector.split(/[\s>,]+/).filter(Boolean).pop();
    return !selectors.includes(leaf);
  });
  assert.deepEqual(uncovered, [], `looping rules missing from :root.reduce-motion:\n${uncovered.join("\n")}`);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: FAIL, naming `.dot.breathing`, `.notable-pulse` and any other loop
added since. (`.notable-pulse` was already loop-driven and already in the block
under a different selector form — if it is reported, add the exact leaf.)

- [ ] **Step 3: Extend the block**

At `style.css:2586`, add the new selectors to the existing list. Keep the
existing comment and extend it:

```css
/* "Reduce motion": kills the decorative loops (pulsing dots, jamming pings,
   hot-zone flares) without touching the transitions that tell you a control
   responded.

   The data-driven tempos join it too. A source dot's cadence is real
   information, but a reader who has asked for stillness has asked for
   stillness -- the "updated 4s ago" beside the dot says the same thing in
   words, which is why the information is not lost by switching this off. */
:root.reduce-motion .live-dot,
:root.reduce-motion .notable-pulse,
:root.reduce-motion .jamming-ping-ring,
:root.reduce-motion .infra-hot .entity-icon-wrap,
:root.reduce-motion .czib-live .entity-icon-wrap,
:root.reduce-motion .country-shape.country-hot,
:root.reduce-motion .dot.breathing,
:root.reduce-motion .infra-hot-badge,
:root.reduce-motion .marker-arrived .entity-icon-wrap > svg,
:root.reduce-motion .panel-enter,
:root.reduce-motion .stagger-children > *,
:root.reduce-motion .loading-log-line,
:root.reduce-motion .news-list > *,
:root.reduce-motion .notable-list > * {
  animation: none !important;
}
```

- [ ] **Step 4: Mirror it under the media query**

The `.reduce-motion` class comes from the app's own setting
(`hooks/useAppSettings.js`). A reader whose operating system asks for reduced
motion has never touched that setting, so the same list needs the media query
too:

```css
/* The setting above is the app's; this is the operating system's. A reader who
   set it there should not have to find it here as well. */
@media (prefers-reduced-motion: reduce) {
  .live-dot,
  .notable-pulse,
  .jamming-ping-ring,
  .infra-hot .entity-icon-wrap,
  .czib-live .entity-icon-wrap,
  .country-shape.country-hot,
  .dot.breathing,
  .infra-hot-badge,
  .marker-arrived .entity-icon-wrap > svg,
  .panel-enter,
  .stagger-children > *,
  .loading-log-line,
  .news-list > *,
  .notable-list > * {
    animation: none !important;
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && node --test tests/motionTokens.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the JavaScript tween opts out too**

`useCountUp` checks both signals itself, because a CSS rule cannot stop a
`requestAnimationFrame` loop. Confirm it:

```bash
cd frontend && grep -n "reduce-motion\|prefers-reduced-motion" src/hooks/useCountUp.js
```

Expected: both appear, inside `motionIsReduced`. If either is missing, add it —
Task 3 Step 3 has the implementation.

- [ ] **Step 7: Look at it, both ways**

Run `npm run dev`. Turn on the app's own "reduce motion" setting: every pulse,
flare and counter should go still, while hover and press responses keep
working. Then turn the setting off and set the OS-level preference instead
(in Chrome DevTools: Rendering → Emulate CSS `prefers-reduced-motion`), and
confirm the same.

- [ ] **Step 8: Run the full suite**

```bash
cd frontend && npm test
```

Expected: PASS — `motionTokens`, `countUp`, `tempo`, `arrivals` and every
pre-existing test.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/style.css frontend/tests/motionTokens.test.js
git commit -m "Let a reader who asked for stillness actually get it"
```

---

## Verification

After Task 9, the whole feature is in. Confirm against the spec's constraints:

```bash
cd frontend && npm test && npm run build
```

Then run the app and check the three things no test can:

1. **Nothing counts people.** Open the notable panel and a conflict popup. Fatality figures must be still.
2. **Panning flashes nothing.** Pan and zoom hard on a busy region between polls.
3. **The map is still smooth with the traffic layers on.** Turn on ships and aircraft at a zoom that draws thousands, and pan. Framerate must not move — nothing in this plan touches that layer, so a change here means something leaked.

## What is not in this plan

The `ops/cc` terminal dashboard. It gets its own spec and its own plan, per the
decomposition agreed during brainstorming. Nothing here should be generalised
in anticipation of it: the two surfaces share an intent and no code.
