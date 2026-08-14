# Reader panel visibility, and country-gated pin layers

Two additions to Admin Mode's configuration, both of which thin what the public
page presents without changing what is fetched or stored.

## A. Which reader panels the public page shows

Three panels are the reader's rather than the operator's, and they render
outside the Admin Mode gate: the news ticker (`NewsBroadcastPanel`), the
notable-activity board (`NotableEventsPanel`) and the conflict briefing card
(`ConflictBriefingCard`). An operator has no way to decide that a deployment
should not carry one of them.

### Shape

`settings.publicPanels`, a table of three booleans:

```js
publicPanels: { newsTicker: true, notableEvents: true, briefingCard: true }
```

Written in full rather than sparsely, because unlike `layerWish` there is no
resolver to hand a panel back to -- a panel is shown or it is not, and there is
no third state for an absent key to mean.

Merged with the rule `ui.showLeaderLines` already uses: anything but an explicit
`false` leaves the panel on. A configuration written before this setting existed
must not switch a panel off by not mentioning it.

`actions.setPublicPanels(patch)` in `useAppSettings.js`, the same patch shape as
`setUi` and `setCityZones`.

The admin panel gains a **Reader panels** group with one checkbox per panel.
`App.jsx` renders each panel only when its flag is on.

### Off means off for admin too

Admin Mode is the reader's map plus instruments, not a different app. An
operator who has hidden the ticker from readers should see the page readers see;
the checkbox that hid it is the way back. This matches the treatment every other
presentation setting already gets -- an icon scale or a layer opacity set in
Admin Mode is what the operator then looks at.

## B. Pins that only draw for a selected country

Some layers are only worth drawing once a reader has said which country they are
asking about. Cities already behave this way, but by a mechanism specific to
cities (`citiesEnabled`, matched on `country_code`), and nothing generalises it.

### Shape

`countryOnly: false` joins `DEFAULT_LAYER_STYLE`, so it lives in
`settings.layers[key]` beside that layer's scale, opacity and zoom gates.
Merged as a strict boolean -- anything else is dropped rather than coerced, the
rule `layerWish` uses, and for the same reason: a truthy string in a hand-edited
file would silently blank a layer.

### Which layers are offered it

`COUNTRY_ONLY_LAYERS` in `settings/defaults.js`. Every layer that draws
individual pins, minus:

- `cities` -- already country-scoped by its own renderer. A second gate saying
  the same thing in a different vocabulary is how the two end up disagreeing.
- `firms`, `jamming` -- density canvases, not pins. There is no per-item mark to
  clip, and the payloads are a quarter of a million rows.
- `cables`, `railways` -- polylines. A line is only legible whole; clipping one
  to a border draws a fragment that claims the cable ends there.

A layer outside that set gets no checkbox rather than a checkbox that half
works.

### How it draws

Two stages, because "nothing is selected" and "something is selected" are
different questions.

**Stage 1 -- the layer is not on the map at all.** In `applyScene`, a gated
layer with an empty selection resolves to not-visible, alongside the zoom floor
and ceiling that already arbitrate there. Skipped under `sceneBypass`, whose
whole job is to be the state with nothing applied.

**Stage 2 -- pins outside the selection are not drawn.** `countryClipFor(key)`
returns a `(lat, lon) => boolean` built from the selected countries' own
geometry, using `countryContainsPoint` from `map/countryHitTest.js` -- the same
test `map/countryScope.js` applies for the reader panels, so the map and the
panels cannot disagree about what is inside Sudan. Applied in
`renderMarkerLayer`'s filter loop, which covers eighteen layers in one place,
and in the five bespoke pin renderers: `renderInfra`, `renderSatellites`,
`renderAisLayer`, `renderAisDigitraffic`, `renderAdsbLayer`. The last three
sort one payload into three toggleable buckets each, so the clip is asked per
bucket key rather than per payload.

A selection whose geometry has not landed yet draws nothing rather than
everything. The alternative -- pass everything through until the shapes arrive
-- would flash the whole world across the screen for one poll, which is the
opposite of what the setting was switched on to do.

### Re-rendering on a selection change

`setFocus` already re-runs the scene and the renderers, which covers picking the
first country and dropping the last one. It returns early when the focus is
unchanged, so adding a second country to a selection, or removing one of three,
would leave the clip stale. `applyScene` records the selection it last resolved
for; `reportCountrySelection` compares and re-runs when they differ and any
layer is gated. Guarded on both, so a deployment using neither pays nothing.

### The zoom gate still applies

The country gate is an AND on top of the existing gates, never a promotion.
Selecting a country makes a gated layer eligible; it does not drag the layer
below its own zoom floor. A layer can therefore be gated on both and show
nothing until the reader has picked a country *and* zoomed in, which is the
honest reading of two controls that each state a condition.

### Counts

The per-layer counts in the control drawer are computed from the drawn slice, so
they follow the clip without further work -- "12 of 4,300" stays a true
statement about what is on screen.

## What neither of these does

Nothing here stops a fetch, drops a record or edits a payload. Both settings
thin the presentation and leave the data behind it whole: clear the selection,
or tick the panel back on, and the full picture is there.
