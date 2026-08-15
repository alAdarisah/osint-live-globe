# Reader panel visibility, and country-gated pin layers

Two additions to Admin Mode's configuration, both of which thin what the public
page presents without changing what is fetched or stored.

Written against the frontend as it stood before `origin/UI` was merged, and
rewritten afterwards to describe what actually shipped. Two things moved in that
merge and are called out where they land: the news ticker and the
notable-activity board no longer exist as separate panels (Task 12 merged them
into `IntelPanel`'s four tabs), and the admin panel is now a registry of
`components/admin/sections/` files rather than one component.

## A. What the reader's own panels carry

Some panels render outside the Admin Mode gate, because each answers a question
about the world rather than about the map: `IntelPanel` (Escalation, Events,
News, Officials) and the `ConflictBriefingCard` a theatre pick opens. An
operator had no way to decide that a deployment should not carry one of them.

### Shape

`settings.publicPanels`, five booleans:

```js
publicPanels: {
  escalation: true, events: true, news: true, officials: true,
  briefingCard: true,
}
```

Written in full rather than sparsely, because unlike `layerWish` there is no
resolver to hand a panel back to — a panel is shown or it is not, and there is
no third state for an absent key to mean.

Merged with the rule `ui.showLeaderLines` already uses: anything but an explicit
`false` leaves the panel on. A configuration written before this setting existed
must not switch a panel off by not mentioning it.

`actions.setPublicPanels(patch)` in `useAppSettings.js`, the same patch shape as
`setUi` and `setCityZones`.

### Per tab, not per panel

The first four keys are `IntelPanel`'s tabs rather than the panel itself. The
four tabs are four readings of four different feeds behind one header, and
"carry the news wire but not the officials one" is a real editorial decision
about a deployment that a single on/off could not express.

Three files have to agree on a tab's key, and they agree on the key itself
rather than translating between three vocabularies. `INTEL_TAB_KEYS` in
`settings/defaults.js` is the list; `App.jsx` filters it by `publicPanels` and
hands the result to `IntelPanel` as its `tabs` prop; `IntelPanel` filters its own
`TABS` by that list. The dependency runs one way — the panel owns what a tab
looks like and what it lists, the settings file owns which of them a deployment
carries, and the panel never reads a settings object.

Two consequences fall out of the tabs being configurable:

- The selected tab can stop being carried while it is selected. `IntelPanel`
  falls back to the first tab left, so the tab bar and the body cannot disagree;
  without it the bar would highlight nothing and the body would go on rendering
  a tab nobody can reach.
- With all four off, `App.jsx` does not render the panel at all. An empty tab bar
  over an empty list is worse than no panel.

`shownTabs` is filtered from `TABS` rather than mapped from the prop, so the
order on screen is always the panel's. A caller cannot rearrange the tab bar by
listing keys in a different sequence; that is not a decision the settings shape
was meant to carry.

### Off means off for admin too

Admin Mode is the reader's map plus instruments, not a different app. An
operator who has hidden a tab from readers should see the page readers see; the
checkbox that hid it is the way back. This matches the treatment every other
presentation setting already gets — an icon scale or a layer opacity set in
Admin Mode is what the operator then looks at.

### Where the controls live

`components/admin/sections/ReaderPanelsSection.jsx`, its own section file, with
its `SEARCH_TERMS` registered in `AdminPanel.jsx`'s `SECTIONS` list so the
panel's search box finds it.

## B. Pins that only draw for a selected country

Some layers are only worth drawing once a reader has said which country they are
asking about. Cities already behave this way, but by a mechanism specific to
cities (`citiesEnabled`, matched on `country_code`), and nothing generalises it.

### Shape

`countryOnly: false` joins `DEFAULT_LAYER_STYLE`, so it lives in
`settings.layers[key]` beside that layer's scale, opacity and zoom gates.
Merged as a strict boolean, and only for a layer that has the gate on offer —
anything else is dropped rather than coerced, the rule `layerWish` uses, and for
the same reason: a truthy string in a hand-edited file would silently blank a
layer until somebody found the checkbox.

The control is a checkbox in `sections/LayerDialsSection.jsx`, under the two zoom
sliders it qualifies.

### Which layers are offered it

`COUNTRY_ONLY_LAYERS` in `settings/defaults.js`. Every layer that draws
individual pins, minus:

- `cities` — already country-scoped by its own renderer. A second gate saying the
  same thing in a different vocabulary is how the two end up disagreeing.
- `firms`, `jamming`, `laneDensity` — density canvases, not pins. There is no
  per-item mark to clip, and the payloads run to hundreds of thousands of rows.
- `water` — a lake or a sea is a shape, not a mark on one.
- `cables`, `shippingLanes` — lines that live in the ocean. Line layers are gated
  by keeping whole lines that touch the selection (below), and a submarine cable
  or a shipping corridor almost never has a vertex inside a country, so the test
  would hide them permanently rather than scope them.

The satellite layers are deliberately in, the bulk WebGL groups included. A
satellite is a pin with a real propagated position, and "only the passes over
the country I am reading about" is exactly the question the gate exists for.

A layer outside the set gets no checkbox rather than a checkbox that half works.

### The overland line layers

`railways` and `powerLines` were excluded in the first version of this design, on
the argument that a line clipped at a border draws a fragment claiming the line
ends there. They are in now, because the renderers answer that objection rather
than accepting it: a line is kept or dropped **whole**, never cut.
`lineInCountryScope` keeps a line if any of its vertices lies inside the
selection.

Any vertex is enough. These are OpenStreetMap ways swept per theatre, dense
enough that a line crossing a country without a single vertex inside it is not
worth the cost of real segment/polygon intersection — and being too generous
draws one extra whole line, which is the right direction to be wrong in.

These are also the two layers where it matters most: an OSM sweep across eleven
theatres is tens of thousands of ways, drawn as real geometry at every zoom, and
gating them is the difference the setting was asked for.

Their counts changed with them. `counts.railways` and `counts.powerLines` were
the number of lines in the served document, which was correct while every served
line was drawn — these layers have no viewport filter. The gate is the first
thing that can make drawn and served differ, so they now report lines drawn
against lines served; otherwise the drawer would read 27,729 beside six visible
lines.

### How it draws

Two stages, because "nothing is selected" and "something is selected" are
different questions.

**Stage 1 — the layer is not on the map at all.** In `applyScene`, a gated layer
with an empty selection resolves to not-visible, alongside the zoom floor and
ceiling that already arbitrate there. Skipped under `sceneBypass`, whose whole
job is to be the state with nothing applied.

**Stage 2 — pins outside the selection are not drawn.** `countryClipFor(key)`
returns a `(lat, lon) => boolean` built from the selected countries' own
geometry, using `countryContainsPoint` from `map/countryHitTest.js` — the same
test `map/countryScope.js` applies for the reader panels, so the map and the
panels cannot disagree about what is inside Sudan. Matching on a feed's own
country string would: ACLED writes names, GDELT writes FIPS codes, and the two
differ about exactly the contested places this map is for.

Applied in eight places:

| Renderer | Covers |
|---|---|
| `renderMarkerLayer` | every layer with a decorator — about twenty, in one call site |
| `renderPowerLines`, `renderRailways` | whole lines, via `lineInCountryScope` |
| `renderInfra` | critical infrastructure |
| `renderSatellites` | the curated satellite layer |
| `renderSatElementLayer` | the DOM-marker satellite groups |
| `renderSatElementWebgl` | the bulk WebGL satellite groups |
| `renderAisLayer` | asked per bucket — `aisNavy`, `aisTanker`, `aisCivilian` |
| `renderAisDigitraffic` | the Baltic feed |
| `renderAdsbLayer` | per bucket — `adsbFlagged`, `adsbMilitary`, `adsbCivilian` |

The last three sort one payload into three toggleable layers each, so the clip is
asked per bucket key rather than per payload.

In the AIS and ADS-B renderers the clip sits inside the loop over the
*filter-bar-filtered* feed (`filteredAis`, `filteredAdsb`, `filterVessels`),
never the raw one. That order is load-bearing: a ship the filter bar rejected
must not reach a bucket for the country gate to then keep.

`renderSatElementWebgl` is the one exception to its own "no per-item filter"
rule, and deliberately. `entityWebglLayer` culls off-screen sprites itself, which
is why that renderer applies no viewport filter — but a country gate is not
"what can be seen from here", it is what this deployment has said the layer is
allowed to draw at all.

A selection whose geometry has not landed yet draws nothing rather than
everything. The alternative — pass everything through until the shapes arrive —
would flash the whole world across the screen for one poll, which is the opposite
of what the setting was switched on to do.

### Re-rendering on a selection change

`setFocus` already re-runs the scene and the renderers, which covers picking the
first country and dropping the last one. It returns early when the focus is
unchanged, so adding a second country to a selection, or removing one of three,
would leave the clip stale. `applyScene` records the selection it last resolved
for in `sceneSelectionSignature`; `reportCountrySelection` compares and re-runs
when they differ and any layer is gated. Guarded on both, so a deployment using
neither pays nothing.

### The zoom gate still applies

The country gate is an AND on top of the existing gates, never a promotion.
Selecting a country makes a gated layer eligible; it does not drag the layer
below its own zoom floor. A layer can therefore be gated on both and show nothing
until the reader has picked a country *and* zoomed in, which is the honest
reading of two controls that each state a condition.

### Counts

The per-layer counts in the control drawer are computed from the drawn slice, so
they follow the clip without further work — "1 of 54" stays a true statement
about what is on screen.

### Not threaded into the fetch layer

Unlike the per-layer zoom floors, `layerCountryOnly` is not given to
`useOsintData`. This gate decides what is drawn out of a payload, not whether the
payload is worth asking for: clearing the selection has to put the full picture
back immediately, and it cannot do that if the data was never fetched.

## Settings version

Both keys are additive, so `SETTINGS_VERSION` goes to 5 as a record of the shape
changing rather than because a converter had to be written — the same practice
versions 2, 3 and 4 document. Both are default-permissive besides: an absent
`publicPanels` leaves all five showing, an absent `countryOnly` leaves the layer
ungated, so a configuration saved before this task describes exactly the
behaviour it had.

## Where it lives

```
frontend/src/settings/defaults.js                      publicPanels, INTEL_TAB_KEYS,
                                                       countryOnly, COUNTRY_ONLY_LAYERS,
                                                       validation, SETTINGS_VERSION
frontend/src/hooks/useAppSettings.js                   setPublicPanels
frontend/src/App.jsx                                   intelTabs, layerCountryOnly, gating
frontend/src/components/IntelPanel.jsx                 tabs prop, shownTabs, tab fallback
frontend/src/components/admin/sections/
    ReaderPanelsSection.jsx                            the Reader panels fold (new)
    LayerDialsSection.jsx                              the per-layer checkbox
frontend/src/components/admin/AdminPanel.jsx           section registration
frontend/src/map/createMapController.js                the gate, the clip, the eight
                                                       call sites, setLayerCountryOnly
frontend/src/map/useLeafletMap.js                      setLayerCountryOnly passthrough
frontend/tests/publicPanels.test.js                    storage and validation tests
```

## What neither of these does

Nothing here stops a fetch, drops a record or edits a payload. Both settings thin
the presentation and leave the data behind it whole: clear the selection, or tick
the panel back on, and the full picture is there.
