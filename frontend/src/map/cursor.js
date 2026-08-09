// The map's own pointer.
//
// Why a DOM element and not `cursor: url(<svg>)`. A CSS cursor image cannot be
// animated -- there is no transition on the property and no way to express
// "closing" -- so a themed cursor that reacts to what is under it has to be
// something the page draws. The cost is that the native cursor has to be hidden
// wherever this one is drawn, and everything the native cursor was saying has to
// be said again.
//
// Which is why it is scoped to `.leaflet-container` and nothing else (see the
// `cursor: none` rules in style.css). The control panel, the admin panel and
// every form control keep their own cursors, their own text carets and their own
// accessibility settings; this one only has to be right over the map.
//
// The state read is the part worth keeping. Rather than running a second
// hit-test -- which would mean knowing about sprites, markers, controls, the
// border editor, and every layer added later -- it asks the DOM what is under
// the pointer, via elementFromPoint plus getComputedStyle, and reads one
// inherited custom property off it.
//
// That property, not `cursor`, because the two cannot be the same thing. Hiding
// the native cursor means `cursor: none !important` on every descendant (an
// explicit value on a child beats the inherited one, and both this app and
// Leaflet's own stylesheet set one -- without it the native hand painted on top
// of the reticle over every pin). That override flattens every cursor value, so
// there is nothing left to read there. `--map-cursor` carries the meaning and
// nothing paints it; see the block next to `.leaflet-container` in style.css.
//
// It still costs no registration and resists drift, because the two rules that
// matter key on .leaflet-marker-icon and .leaflet-interactive -- classes Leaflet
// puts on every marker and every vector path it builds, including those of a
// layer added tomorrow.

/** Resting ring radius, in the SVG's own units. */
export const RESTING_RADIUS = 11;
/** Ring radius over anything clickable -- deliberately the smallest state. */
export const TARGET_RADIUS = 7;
/** Ring radius while the map is being dragged: closed, but not a target. */
export const DRAG_RADIUS = 9;

/** The three treatments the admin panel can pick between. */
export const CURSOR_STYLES = ["reticle", "dot", "halo"];

const VIEWBOX = 56;
const HALF = VIEWBOX / 2;

/**
 * What the reticle should look like, given the `--map-cursor` under the pointer.
 *
 * Pure, and a total function of one string: an unrecognised value rests rather
 * than inventing a state, so a value written anywhere else in the app can never
 * silently change how the map reads. The vocabulary is deliberately the CSS
 * cursor keywords -- the property is a stand-in for `cursor`, and reusing its
 * names is what makes the stylesheet readable to someone who has not read this.
 *
 * @param {string|null|undefined} cssCursor
 * @returns {{radius:number, ticks:boolean, danger:boolean}}
 */
export function reticleStateFor(cssCursor) {
  if (cssCursor === "pointer") return { radius: TARGET_RADIUS, ticks: false, danger: false };
  // `grabbing` only, never `grab`. Leaflet puts .leaflet-grab on the container
  // permanently -- it means "this is draggable", which is true of the whole map
  // at all times, so treating it as a state would leave the reticle closed at
  // rest and give it nowhere to go when a drag actually started.
  if (cssCursor === "grabbing") return { radius: DRAG_RADIUS, ticks: true, danger: false };
  if (cssCursor === "not-allowed") return { radius: RESTING_RADIUS, ticks: true, danger: true };
  return { radius: RESTING_RADIUS, ticks: true, danger: false };
}

// Admin Mode's settings, held at module level and pushed in by useAppSettings --
// the same arrangement setIconTheme uses, and for the same reason: this is not
// React's to own, and threading it through the map controller would make the
// controller a courier for something it never reads.
const DEFAULTS = { enabled: true, style: "reticle", scale: 1, color: null };
let options = { ...DEFAULTS };
let applyOptions = null; // set while a cursor is attached

/**
 * @param {{enabled?:boolean, style?:string, scale?:number, color?:string|null}} next
 */
export function setCursorOptions(next) {
  options = { ...options, ...next };
  if (!CURSOR_STYLES.includes(options.style)) options.style = DEFAULTS.style;
  applyOptions?.();
}

const SVG_NS = "http://www.w3.org/2000/svg";

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * The three treatments, each returning the same shape so the loop below does not
 * branch: a root element, the ring it animates, and optionally ticks.
 *
 * `lag` is what separates the dot treatment from the other two -- the ring eases
 * toward the pointer instead of tracking it exactly.
 */
function buildShape(style) {
  const svg = el("svg", {
    class: `map-reticle map-reticle-${style}`,
    width: VIEWBOX, height: VIEWBOX, viewBox: `0 0 ${VIEWBOX} ${VIEWBOX}`,
    // Decorative: a restatement of the pointer position, which assistive
    // technology already has by other means.
    "aria-hidden": "true",
  });
  const ring = el("circle", { cx: HALF, cy: HALF, r: RESTING_RADIUS, class: "map-reticle-ring" });

  if (style === "halo") {
    // Nothing but the ring, and the native cursor is left alone (no `cursor:
    // none` rule matches this style -- see style.css). The ring is shown only
    // over something clickable, which is the whole treatment.
    svg.append(ring);
    return { svg, ring, ticks: null, lag: 1, haloOnly: true };
  }

  if (style === "dot") {
    svg.append(ring, el("circle", { cx: HALF, cy: HALF, r: 2.5, class: "map-reticle-dot" }));
    return { svg, ring, ticks: null, lag: 0.18, haloOnly: false };
  }

  const ticks = el("g", { class: "map-reticle-ticks" });
  for (const [x1, y1, x2, y2] of [
    [HALF, 9, HALF, 17], [HALF, 39, HALF, 47],
    [9, HALF, 17, HALF], [39, HALF, 47, HALF],
  ]) {
    ticks.appendChild(el("line", { x1, y1, x2, y2 }));
  }
  svg.append(ring, ticks, el("circle", { cx: HALF, cy: HALF, r: 1.75, class: "map-reticle-dot" }));
  return { svg, ring, ticks, lag: 1, haloOnly: false };
}

/**
 * Draw the cursor over one map container.
 *
 * @param {HTMLElement} container  the Leaflet container
 * @returns {() => void} teardown
 */
export function attachCursor(container) {
  // No pointer, no cursor to replace -- and on a touch screen elementFromPoint
  // would run on every tap for something nobody can see. `(pointer: fine)` is
  // the same test the platform uses to decide whether hover states mean
  // anything, which is the same question being asked here.
  if (!container || !window.matchMedia?.("(pointer: fine)").matches) return () => {};

  let shape = null;
  let x = 0;
  let y = 0;
  let ringX = 0;
  let ringY = 0;
  let pulse = 0;
  let frame = null;
  let visible = false;

  // Motion is a setting on this map (see settings.ui.reduceMotion), and it is
  // read per frame rather than captured once: the admin panel can turn it on
  // while the map is open, and a cursor that kept easing until reload would be
  // the one piece of the UI that ignored the switch.
  const motionOff = () => document.documentElement.classList.contains("reduce-motion");

  function teardownShape() {
    shape?.svg.remove();
    shape = null;
  }

  // Rebuilt rather than mutated when the style changes: three treatments with
  // different children are three different elements, and a rebuild happens once
  // per admin edit rather than once per frame.
  function rebuild() {
    teardownShape();
    // The root carries the style so the stylesheet can decide whether to hide
    // the native cursor -- the halo treatment deliberately keeps it.
    const root = document.documentElement;
    root.dataset.mapCursor = options.enabled ? options.style : "native";
    if (!options.enabled) return;
    shape = buildShape(options.style);
    // Size is set here, not per frame: it changes when the setting changes and
    // at no other time. The viewBox is fixed, so the whole drawing scales with
    // the element and the ring radii keep their meaning in SVG units.
    const scale = options.scale ?? 1;
    shape.svg.style.width = `${VIEWBOX * scale}px`;
    shape.svg.style.height = `${VIEWBOX * scale}px`;
    if (options.color) shape.svg.style.color = options.color;
    container.appendChild(shape.svg);
    if (visible) shape.svg.classList.add("visible");
    schedule();
  }
  applyOptions = rebuild;

  function draw() {
    frame = null;
    if (!shape) return;
    const under = document.elementFromPoint(x, y);
    // Null when the pointer is outside the viewport, which is a resting state
    // rather than an error -- getComputedStyle(null) would throw.
    const mapCursor = under ? getComputedStyle(under).getPropertyValue("--map-cursor").trim() : null;
    const state = reticleStateFor(mapCursor);

    const ease = motionOff() ? 1 : shape.lag;
    ringX += (x - ringX) * ease;
    ringY += (y - ringY) * ease;
    // The centring offset has to scale with the element, which is why it is
    // computed from the same number rebuild() sized it with rather than from the
    // constant -- at 200% a fixed -HALF would leave the cursor a half-width off
    // the pointer.
    const half = HALF * (options.scale ?? 1);
    shape.svg.style.transform = `translate(${Math.round(ringX - half)}px, ${Math.round(ringY - half)}px)`;

    // The halo treatment says one thing only: is this clickable. Everything else
    // is the native cursor's job, and it is still on screen saying it.
    if (shape.haloOnly) {
      shape.svg.classList.toggle("visible", visible && mapCursor === "pointer");
    }

    // The pulse rides on top of whatever radius the state asked for, so a click
    // on a target expands from the tightened ring rather than from the resting
    // one -- the ring the reader was actually looking at when they clicked.
    shape.ring.setAttribute("r", String(Math.round((state.radius + pulse * 10) * 100) / 100));
    shape.ring.style.opacity = String(Math.round((1 - pulse * 0.7) * 100) / 100);
    if (shape.ticks) shape.ticks.style.opacity = state.ticks ? "1" : "0.2";
    shape.svg.classList.toggle("danger", state.danger);

    if (pulse > 0) pulse = motionOff() ? 0 : Math.max(0, pulse - 0.08);
    // Keeps running while the ring is still catching up (the dot treatment) or
    // a pulse is still decaying, and stops the moment neither is true.
    const chasing = Math.abs(x - ringX) > 0.4 || Math.abs(y - ringY) > 0.4;
    if (pulse > 0 || chasing) frame = requestAnimationFrame(draw);
  }

  function schedule() {
    if (frame == null) frame = requestAnimationFrame(draw);
  }

  const onMove = (event) => {
    x = event.clientX;
    y = event.clientY;
    if (!visible) {
      visible = true;
      // The halo decides its own visibility per frame; the other two are shown
      // as soon as the pointer is over the map.
      if (shape && !shape.haloOnly) shape.svg.classList.add("visible");
    }
    schedule();
  };
  const onLeave = () => {
    visible = false;
    shape?.svg.classList.remove("visible");
  };
  const onDown = () => {
    if (!motionOff()) pulse = 1;
    schedule();
  };

  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", onLeave);
  container.addEventListener("mousedown", onDown);
  rebuild();
  // Same dev-only handle webglLayer keeps, and for the same reason: this module
  // holds state at module scope, and a console `import()` of it under Vite
  // resolves to a *different* instance (HMR gives the app's copy a `?t=` query),
  // so there is otherwise no way to drive the live one from outside.
  if (import.meta.env.DEV) window.__mapCursorDebug = { setCursorOptions, options: () => options };

  return () => {
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mouseleave", onLeave);
    container.removeEventListener("mousedown", onDown);
    if (frame != null) cancelAnimationFrame(frame);
    applyOptions = null;
    delete document.documentElement.dataset.mapCursor;
    teardownShape();
  };
}
