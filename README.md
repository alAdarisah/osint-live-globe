# OSINT Live Globe

A self-hosted situational-awareness map built entirely from open sources.

It pulls from roughly two dozen public publishers — conflict-event datasets,
news wire metadata, satellite thermal sensors, AIS and ADS-B transponder
feeds, seismic and volcanic bulletins, government press offices, sanctions
lists, internet-outage telemetry, submarine-cable registries, orbital element
sets — cross-references them, and draws the result on one map that runs on
your own machine. Nothing is uploaded anywhere, and no account is needed to
get a working map.

- **Backend:** Python 3.10+ / FastAPI, one async polling loop per source.
- **Frontend:** React + Vite + Leaflet, with a Pixi.js/WebGL layer for the
  high-volume ship and aircraft markers.
- **Storage:** optional Postgres. Without it the app runs live-only; with it,
  everything collected persists across restarts and reboots.

---

## Table of contents

1. [What "OSINT" means here](#what-osint-means-here)
2. [Quick start](#quick-start)
3. [Getting the API keys](#getting-the-api-keys)
4. [The sources](#the-sources)
5. [How the conflict layer is built](#how-the-conflict-layer-is-built)
6. [Where a pin actually is](#where-a-pin-actually-is)
7. [Annotations that aren't layers](#annotations-that-arent-layers)
8. [What's on screen](#whats-on-screen)
9. [Architecture](#architecture)
10. [HTTP API](#http-api)
11. [Configuration reference](#configuration-reference)
12. [Persistence](#persistence)
13. [Tests](#tests)
14. [Troubleshooting](#troubleshooting)
15. [Limits, and what this is not](#limits-and-what-this-is-not)
16. [Attribution](#attribution)

---

## What "OSINT" means here

Open-source intelligence is the practice of building an understanding of
events from publicly available material: published datasets, broadcast
transponder signals, government releases, satellite products, news reporting.
The hard part is not collection — most of this is a URL away. The hard part is
**knowing what each piece of evidence is worth**, and not letting a machine
guess get presented with the same confidence as a measurement.

That is the design constraint this project is built around, and it shows up as
four rules the code actually enforces.

### 1. Provenance beats recall

Every record on the map names its publisher and what *kind* of evidence it is.
A layer is never allowed to blend two kinds of evidence into an
undifferentiated feed. The clearest example is the Officials & Diplomacy layer,
which carries two inputs that are deliberately never merged:

- a government's **own press release** — certain about attribution, published
  with no editor between the claim and the reader;
- **CAMEO-coded newsroom reporting** — has reach and corroboration, and can be
  wrong about who did what.

The `origin` field survives all the way to the popup, and the pin is drawn
differently for each. Merging them would hide the single thing a reader most
needs in order to weigh a statement about a war.

The same discipline applies elsewhere: curated infrastructure (coordinates a
person checked) is a *different layer* from OpenStreetMap infrastructure
(crowd-sourced geometry), and every OSM popup names OpenStreetMap. Earthquakes
(USGS, minutes old) and volcanic activity (Smithsonian GVP, a weekly report)
share one layer but never a label.

### 2. Corroboration is a separate axis from severity

Severity — how bad — and corroboration — how sure — are different questions,
so they get different visual channels. Conflict pins are sized and coloured by
a 0–100 severity score, and an independently corroborated event gets its own
colour instead of a brighter shade of the same one. Every popup shows the
factors that actually moved the score, including the unflattering ones ("no
casualty figure reported", "reported by a single outlet", "no article text,
coded fields only").

Reliability is the third axis (`backend/sources/reliability.py`), and it is the
one that answers the question the popup's "How much to trust this" panel
actually asks. The dominant input is who published: outlets are tiered into
wire services and newsrooms of record (Reuters, AP, AFP, BBC, Al Jazeera, DW,
the papers of record), the rest of the allowlist, and everything else — which
is most of what GDELT indexes and is scored accordingly. A human-coded ACLED or
UCDP record outranks any newsroom. Breadth, a second dataset, a contradicted
coordinate and a commentary or stale URL adjust from there. On a live window 93
of 100 fused events are a CAMEO code from a domain no allowlist holds, and the
map now says so on each of them rather than lending them the credibility of the
seven that a wire service stands behind.

Scoring badly is not the same as being removed, and the two happen in that
order. A thin report stays on the map, labelled, because most conflict
reporting comes from newsrooms no allowlist will ever hold and deleting them
would narrow the map to whatever the wires covered. Only a record that already
scored in the bottom two bands is screened, and only a specific checkable
failure removes it: an opinion/archive URL, a publication date months behind
today, an event date beyond any plausible report lag, a retrospective headline,
or no traceable newsroom at all. Every removal is logged with its reason.

### 3. Uncertainty is drawn, not hidden

| Signal | Meaning |
|---|---|
| Dashed ring | Position is approximate — a country or region centroid, not a place |
| Desaturated conflict pin | Weakly sourced — no newsroom this app vouches for is behind it |
| `inferred` tag | Derived by this app from an absence or a pattern, not reported by anyone |
| Hollow grey pin | Historical record, not live — lags real time by a month or more |
| "+31 more" | The outlet list is capped; the true count is still shown |
| Explicit countdown suppression | A launch time looser than "to the hour" reads as "no earlier than" |

The Dark Vessels layer is the strongest case. It reads this backend's *own*
recorded AIS history and looks for two patterns that only exist in the gaps: a
transponder that went quiet for hours and reappeared implausibly far away, and
two hulls sitting alongside each other at near-zero speed away from any port.
Both are classic sanctions-evasion signatures — and an AIS receiver outage
looks exactly like a transponder switched off. So the module checks whether the
whole feed was quiet over the same window, marks every record `inferred: True`,
states its own counter-explanations in the popup, and is allowed to say "worth
a look" but never "detected".

### 4. Thin the presentation, never delete the data

Density is a rendering problem, not a reason to drop records. The map has
three separate mechanisms for it, and none of them discards anything:

- **Declutter** — one placement pass over every visible icon of every layer at
  once, producing a *screen-space* nudge so two things a few pixels apart stay
  individually clickable. The marker's real coordinate, popup anchor, and every
  distance calculation are untouched.
- **Collapse** — scoped to the news layer only, where a 24-hour window can put
  dozens of headlines on one spot. Overlapping items become one marker that
  says how many it stands for and lists all of them in its popup.
- **Serving caps** — the world view serves at most 2,500 conflict events and
  1,200 diplomacy items, chosen by severity and rank. A selected region is
  never capped, the archive and the escalation detector always see everything,
  and the UI says out loud when a cap is in effect: *"Showing the N most severe
  here — zoom in for the rest."*

### Evidence grades, in practice

| Grade | Example layers |
|---|---|
| Direct measurement | AIS/ADS-B transponders, USGS seismicity, FIRMS thermal detections, IODA outage telemetry, SGP4-propagated orbits |
| Curated dataset | ACLED, UCDP GED, OFAC SDN, OurAirports, TeleGeography cables, GeoNames |
| Primary source | Government and IGO press feeds |
| Machine-coded reporting | GDELT CAMEO events and article metadata |
| Inference by this app | Dark vessels, ship-to-ship transfers, aircraft role, military airfield flag, escalation ratios |
| Reference / context | Country boundaries, cities, curated infrastructure, capitals |

---

## Quick start

### Docker Compose

```bash
docker compose up -d --build
```

Seven containers:

| Service | Role |
|---|---|
| `postgres` | System of record, on a named volume |
| `ingest` | Owns every credentialed and metered upstream |
| `refine` | Derives fused events, dark vessels and escalation from stored rows |
| `redis` | Read-through cache in front of Postgres |
| `backend` | Pure API — fetches nothing, derives nothing |
| `cache-worker` | Watches the cache and the producers, alerts only |
| `frontend` | The React app behind nginx, proxying `/api` |

- Map: `http://localhost:8080` · API: `http://localhost:8000` · Postgres: `5432`
- Every source writes what it collects to Postgres and reads its own data back
  at startup, so the map is populated from the first second instead of filling
  in over the following minutes — or hours, for the daily sources.
- It keeps collecting with no browser open, and comes back by itself after a
  reboot (`restart: unless-stopped`).

This is the only supported way to run the app. The old single-container image
(root `Dockerfile` + `render.yaml`) and the plain `run.bat` process were removed
when the pipeline split out: neither has anywhere to put the ingest and refine
processes, and `run.bat` had no Postgres at all — which is now the channel every
collected and derived layer arrives through.

For frontend work, run `python -m backend.app` in one terminal and `npm run dev`
inside `frontend/` in another, then use the URL Vite prints — its dev server
proxies `/api` to the backend. The backend alone serves only the sources it
still polls itself; add `python -m backend.ingest` and `python -m backend.refine`
(against a reachable `DATABASE_URL`) for the rest.

Stop with `docker compose down`. Use `docker compose down -v` **only** if you
mean to throw the collected history away — that is the one command that deletes
the volume.

**`run-stack.bat`** is the same thing for a Windows host whose Docker lives
inside WSL rather than Docker Desktop. It starts the daemon in the distro,
brings the stack up, holds a WSL session open so `localhost` keeps forwarding,
and opens the map. Pass compose flags straight through: `run-stack.bat --build`.

A one-off SQLite → Postgres import exists for upgrading from an older layout:

```bash
docker compose --profile migrate run --rm migrate
```

### What works with no keys at all

Most of the map. Keyless out of the box:

News (GDELT) · Conflict events (UCDP + GDELT half of the fused layer) ·
District-level ACLED via HDX · Aircraft (airplanes.live, unfiltered — includes
military) · Satellites · Earthquakes & volcanoes · GPS jamming · Internet
outages · Cross-border electricity flows · Submarine cables · Airfields ·
OSM infrastructure · Orbital launches · Sanctions cross-referencing · Countries ·
Cities · Displacement & food security (UNHCR half) · Precipitation radar ·
Wind arrows · NASA GIBS satellite imagery.

Keys only add: NASA FIRMS fires, live AIS ship positions, faster/authenticated
OpenSky ADS-B, event-level ACLED, and the OpenWeatherMap cloud/wind tile
layers.

---

## Getting the API keys

Open `.env` in the project root (Notepad is fine) and fill in what you have.
Every source degrades to "unavailable" rather than crashing when its key is
missing, and the **Source status** panel says exactly which are missing.

### 1. NASA FIRMS — fires / thermal anomalies (instant)

Go to <https://firms.modaps.eosdis.nasa.gov/api/map_key/>, enter your email,
and a key arrives immediately. Paste it as `FIRMS_MAP_KEY`.

Without it you still get NOAA HMS fire detections; the higher-resolution VIIRS
half needs the key.

### 2. aisstream.io — live ship positions (a few minutes)

Sign up free at <https://aisstream.io>, then copy your key from your account
page into `AISSTREAM_API_KEY`.

By default this tracks eight high-interest maritime areas rather than the whole
ocean: Black Sea, Red Sea, Gulf of Aden / Bab-el-Mandeb, Strait of Hormuz /
Persian Gulf, Taiwan Strait, South China Sea, Eastern Mediterranean, and the
Suez Canal. Change it with `AIS_BBOXES` (format documented in
`backend/config.py`).

**If the ship layer is empty, suspect aisstream before your key.** Its
characteristic failure is silent: the websocket connects, the subscription is
accepted, pings are answered, and no data arrives — for hours or days. A key
that is genuinely wrong looks nothing like that; it is closed on within a
second. The source-status panel distinguishes the two, and the backend backs
off to 15-minute reconnects during an outage rather than hammering a service
that is already down (aisstream rate-limits by account and IP). Service state
is reported at <https://github.com/aisstream/issues>.

### 3. OpenSky Network — aircraft (optional)

The app already shows aircraft without any key, from **airplanes.live** — a
free, keyless, unfiltered community feed that carries military and government
aircraft which opt out of OpenSky entirely. OpenSky is added on top: anonymous
access is capped at 100 requests/day (so a 15-minute refresh), while a free
registered client gets 60-second updates.

Register at <https://opensky-network.org>, create an API client in your account
settings, and paste the pair as `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`.

### 4. ACLED — conflict & violence events (approval may be needed)

Register at <https://acleddata.com> and put the same email/password in
`ACLED_EMAIL` / `ACLED_PASSWORD` — the app performs the OAuth login you would
do in a browser.

Note the access tiers. A free/Research-tier myACLED account is typically
**embargoed to events roughly 12 months old**, which makes the point-level feed
useless for anything current. The backend detects this automatically (ACLED
returns the cutoff in `data_query_restrictions.date_recency`), caches the
finding, rechecks daily, and correctly discards embargoed rows rather than
drawing year-old events as live ones.

This is why ACLED is not a hard dependency: **HDX HAPI republishes the same
ACLED data as monthly counts per admin-2 district with no key and no embargo**,
and that is what backs the district numbers and the country cards. Full raw
event access requires ACLED to approve a higher tier.

Your ACLED password is stored only in the local `.env` file and is sent only to
ACLED's own login endpoint over HTTPS.

### 5. OpenWeatherMap — cloud cover / wind tiles (optional)

Precipitation radar (RainViewer) and the wind-arrow field (Open-Meteo) need no
key and always work. For the extra Cloud Cover and Wind tile layers, register
free at <https://home.openweathermap.org/users/sign_up>, take a key from
<https://home.openweathermap.org/api_keys>, and paste it as `OWM_API_KEY`.

Tiles are proxied through the backend so the key never reaches the browser.

### Optional: HDX HAPI contact address

HAPI asks callers to identify themselves with a contact address rather than
issuing credentials. Set `HAPI_CONTACT_EMAIL` (or a pre-encoded
`HAPI_APP_IDENTIFIER`) to enable the IPC food-security phases, in-country IDP
counts, and admin-2 ACLED district counts. The UNHCR half of the humanitarian
layer works without it.

---

## The sources

Every source runs its own independent polling loop. One module failing to
import or poll leaves the rest untouched — a bad source logs and sits inert.

### Conflict and violence

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **GDELT 2.0** | Every 15 minutes, a global export of CAMEO-coded events with actors, geography, tone, and a Mentions table naming which outlets carried each story. Each poll re-reads a 2-hour window into a rolling accumulator. | 15 min | none |
| **ACLED** | Curated, human-coded political violence and protest events with actor names and reviewed fatality counts. | 30 min, 3-day lookback | account |
| **UCDP GED Candidate** | UCDP's keyless monthly cut of its peer-reviewed conflict-death dataset — the most rigorous data available here without a paid key, and explicitly not live. | 6 h | none |
| **HDX HAPI (ACLED admin-2)** | Monthly ACLED event/fatality counts per district. No key, no embargo, and the ground-truth check on where violence actually is — independent of what happened to be in the news. | 6 h | contact email |
| **HDX aggregate ACLED** | Country-by-month event and fatality series, 24 months kept, for trend lines and country cards. | 6 h | none |
| **Event fusion** | Not a fetch. Collapses the three live inputs above into one record per real-world incident — see [below](#how-the-conflict-layer-is-built). Re-derived on GDELT's own cadence, since that is the input that moves. | 15 min | — |
| **Escalation detection** | Which regions are running above *their own* recent baseline. Computed on request over a week of archived events, cached 120 s. | on request | — |

### Diplomacy

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **Government / IGO press feeds** | Eight hand-verified RSS/Atom feeds published by ministries, leaders' offices and international bodies. Each URL was fetched and confirmed to parse before being added; a feed that starts 404ing is logged and skipped, never silently retried forever. | 10 min | none |
| **GDELT CAMEO roots 01–17** | Statements, meetings, visits, demands, threats, sanctions, coded from newsroom reporting. Country-only geocodes are shown at that country's capital and say so. | 15 min | none |

### Air and sea traffic

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **aisstream.io** | Live AIS position reports over a websocket, snapshotted every few seconds. Ship type, IMO and call sign are cached per MMSI from the separate static message. | live | key |
| **airplanes.live** | Keyless, unfiltered ADS-B. Seven regional point queries plus a global military sweep, plus dedicated worldwide sweeps for squawk 7500/7600/7700 and for LADD / Privacy-ICAO-Address aircraft. Hard-limited to 1 request/second, so every call is serialized. | 15 min / 60 s | none |
| **OpenSky Network** | Global ADS-B state vectors, merged into the same poll. Cadence for both feeds is set by whether OpenSky is authenticated: 15 min anonymous (100 calls/day), 60 s with a client. | 15 min / 60 s | optional |
| **Dark vessels** | Derived from this backend's own AIS history: transponder gaps (≥4 h inside a watched chokepoint, with the implied speed across the gap) and possible ship-to-ship transfers (two hulls within 500 m, near-zero speed, over an hour, away from any known port). Feed-outage-aware. | 15 min | — |

### Ground, infrastructure and environment

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **NASA FIRMS (VIIRS)** | Satellite thermal anomalies, filtered to nominal/high confidence. | 15 min | key |
| **NOAA HMS** | Analyst-QC'd fire detections fusing GOES-16/18 (5–15 min geostationary cadence), VIIRS and MODIS. | 15 min | none |
| **gpsjam.org** | Daily GPS interference, aggregated into H3 resolution-4 hex cells from aircraft GPS-quality reports. Cells below a 25% affected ratio or 2 total reports are dropped as noise, and only the 100 worst-affected are served. | 6 h | none |
| **IODA (Georgia Tech)** | Country-level internet outages from three independent signals: BGP withdrawals, active probing, and darknet traffic. Rendered as a country tint and a card line, never as a pin — the measurement has no location finer than the country. | 15 min | none |
| **Fraunhofer ISE Energy-Charts** | Cross-border electricity exchange for 38 European countries plus the EU bloc, both metered *physical flows* (`cbpf`, 15-min, hours behind wall clock) and day-ahead *commercial schedules* (`cbet`, hourly, published ahead). The two are stored separately and never merged — a schedule is a contract, a flow is a reading. Nothing is drawn: a flow is an edge between two countries and has no location. | 1 h | none |
| **TeleGeography** | 718 submarine cable routes and 1,922 landing points. Geometry is schematic (drawn for a map, not a chart) and the popup says so. | 24 h | none |
| **OurAirports** | 80k+ airfields. Served as a filtered slice (large/medium/small airports; heliports, seaplane bases and closed fields excluded) and gated by zoom. | 24 h | none |
| **OpenStreetMap / Overpass** | Military sites and airfields, power plants, border crossings — thousands of features, swept one conflict theatre at a time with long pauses, partial results published as they arrive. | 24 h | none |
| **Curated infrastructure** | 207 hand-checked sites (refineries, LNG terminals, ports, desalination, nuclear, semiconductor fabs, pipeline nodes, military bases across seven subtypes) plus 10 pipeline routes. Static — no poller. | static | none |

### Hazards and space

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **USGS** | Earthquakes M2.5+ over the past 24 h. Colour follows USGS's own **PAGER** impact alert where one was issued, magnitude otherwise, and the popup says which. | 5 min | none |
| **Smithsonian GVP** | The weekly volcanic activity report, issued each Thursday. A volcano pin describes a week, not this moment. Reports published without a coordinate are dropped rather than placed by guesswork. | 6 h | none |
| **CelesTrak** | Orbital elements for the `stations` and `military` groups; positions propagated with SGP4 (Skyfield, using bundled leap-second tables — no extra network dependency). | elements 6 h, positions per poll | none |
| **Launch Library 2** | Upcoming and just-flown orbital launches, drawn at the pad. Anonymous callers get ~15 requests/hour, so HTTP 429 is treated as ordinary backoff rather than an error. | 30 min | none |

### Humanitarian and reference

| Source | What it gives | Cadence | Key |
|---|---|---|---|
| **UNHCR** | Refugees, asylum seekers, IDPs and stateless people **by country of origin** — the framing that matches a map of conflict. | 12 h | none |
| **HDX HAPI** | IPC food-security phases, in-country IDP counts at admin-2, and which organisations operate where. | 12 h | contact email |
| **Natural Earth + World Bank + OWID** | Country boundaries, population, population density, HDI. | 24 h | none |
| **GeoNames `cities15000`** | Every city over 100,000, plus every national capital regardless of size (GeoNames feature code `PPLC`). | 6 h | none |
| **GeoNames `cities500` + admin tables** | The offline gazetteer: ~200k populated places down to 500 people, plus admin-1/admin-2 code tables. Backs geocoding and placement verification. | 24 h | none |
| **OFAC SDN list** | ~19,000 rows, of which ~1,500 are vessels and ~340 aircraft. Draws nothing itself — see [annotations](#annotations-that-arent-layers). | 24 h | none |
| **Open-Meteo** | Wind velocity grid, pinned to NOAA's GFS 0.25° model, fetched on demand for the current viewport. | on demand | none |
| **RainViewer / OpenWeatherMap / NASA GIBS** | Precipitation radar frames (keyless), cloud and wind tiles (key), and MODIS / VIIRS true-colour and VIIRS day-night-band imagery. | tiles | OWM only |

**None of the humanitarian figures go on the map.** Every one is a country or
admin-1 aggregate over a reference period of months; drawing that as a pin
would claim a precision it does not have. They are rendered inside the country
card with the reference period attached to every number.

---

## How the conflict layer is built

One real incident can reach this backend three times — as an ACLED row, as a
UCDP row, and as a GDELT structured event. Drawing all three is exactly the
"icons stacked on top of each other for the same thing" problem. `event_fusion`
collapses them into one canonical record before anything is drawn.

### 1. Gate GDELT down to actual violence

GDELT's conflict feed splits across two quad classes: **verbal** conflict
(accusations, denials, demands) and **material** conflict. Only CAMEO roots
**18, 19 and 20** pass. Root 17 (COERCE) is excluded — arrests, expulsions and
censorship are repression, not violence, and belong on the diplomacy layer.

Violence-typed is necessary but not sufficient. GDELT codes a great deal of
ordinary domestic crime as FIGHT/ASSAULT, and its corpus is dominated by US
local media. So at least one actor must be of an armed type — `MIL`, `REB`,
`INS`, `SEP`, `PAR`, `UAF`, `SPY`. Police (`COP`) is deliberately excluded,
because including it re-admits the entire domestic crime blotter.

This gating lives in the fusion step, not in the GDELT poller, because the same
parsed feed also backs `/api/news`, which *wants* the broad political picture.
The two layers are allowed to disagree about what is relevant.

### 2. Cluster across sources

Rows are clustered through a spatial hash: within **50 km** and **2 days** of
each other, with matching event families. Kilometres rather than degrees —
the old 0.5° threshold was ~55 km at the equator but ~28 km at 60°N, which made
the clusterer quietly stricter in Ukraine than in the Sahel for no reason
anyone chose.

### 3. Merge, with a source priority

ACLED and UCDP carry real structured fields (actor names, reviewed fatality
counts); GDELT is CAMEO-coded with no fatality field. When a cluster spans
sources, the richest supplies the record's core fields: ACLED → UCDP → GDELT.
The record keeps `corroborated_by` so "two independent datasets agree" is
visible rather than silently folded in.

### 4. Score severity 0–100

Inputs: a base score per event type, fatalities on a square root (the
difference between 1 and 10 dead is a change of scale; 200 to 400 is not),
independent outlet count on a log curve, whether a real headline exists at all,
CAMEO's Goldstein intensity (weighted low — it is nearly constant on violent
rows), and a confidence multiplier from corroboration and geographic precision.

Every popup lists the reasons that actually moved the score, including the ones
that lowered it. A bare "24/100" tells a reader nothing about whether that
means "minor incident" or "we barely know anything about this" — and here it
usually means the second.

### 5. Attach physical corroboration

Two signals the app already fetches for their own layers are reused as
independent evidence that something physical happened where a report says it
did. Only events placed to **locality** precision are eligible — "something
burning within 10 km of a country centroid" is not evidence about anything.

- **GPS jamming within 60 km** (gpsjam H3 res-4 cells are ~20 km across).
  Interference at that scale is essentially never accidental. Its *absence*
  means nothing and never reduces a score: coverage exists only where ADS-B
  receivers do, which leaves much of Africa and central Asia blind.
- **A thermal anomaly within 10 km the same day**, and only for event families
  where a fire or blast signature is physically plausible — a hostage-taking
  near a burning field is a coincidence, not evidence. This is a small bonus
  that never sets `corroborated`, and the UI describes it as an observation
  rather than as confirmation, because most hotspots on earth are wildfire and
  agricultural burning.

### 6. Score reliability, then screen the bottom of it

Severity above says how consequential; this says how believable, and the two
are not the same claim — see principle 2. Inputs: the publishing outlet's tier
(wire service / newsroom of record → allowlisted newsroom → everything else),
whether a human analyst coded it, independent breadth on a log curve, a second
dataset, and deductions for a contradicted coordinate, no article text, a
commentary URL or a stale one.

*Then*, and only for records already in the bottom two bands, the screen runs.
It removes a record for a fact about the page, never for the score itself: an
opinion/magazine/archive section, a URL dated three or more months back, an
event date past `MAX_REPORT_LAG_DAYS`, a retrospective headline, or no
traceable newsroom at all. Human-coded ACLED/UCDP records are exempt outright.
Screened ids are deleted from the archive alongside superseded ones, so a
removed record does not survive on the replay timeline, and every removal is
logged with its reason and headline.

### 7. Headlines stay with the incident

A story folded into a conflict pin is not drawn twice. The fused record carries
the headlines and the news ids that produced it, and the map suppresses the
duplicate marker from that — so the headline appears *inside* the pin under
"Coverage", and the news feed and country card stay complete. (An earlier
version removed the duplicate by dropping the article, which made the headline
appear nowhere at all.)

### 8. Detect escalation

`escalation.py` asks the question a map of "what exists" cannot: what is
*changing*. A region with 40 events/day is not newsworthy if it always has 40;
a region that normally sees 2 and just saw 9 is. So every region is compared
against its own trailing baseline — a 24-hour current window against 7 days of
history, with additive smoothing so 0→2 does not read as an infinite spike, a
floor of 3 current events, and a 1.5× ratio threshold.

Two guards keep it honest:

- It returns **nothing** — not an error — when there is no database or fewer
  than 36 hours of observed history. A cold database should produce silence,
  not a fabricated spike.
- Every window is scoped to a **pipeline version** (`CONFLICT_PIPELINE_VERSION`).
  A change that makes the pipeline see more events is a change in *us*, not in
  the world, and would otherwise land as a simultaneous worldwide "escalation".
  Bumping the version keeps the detector silent until it has comparable history.

### 9. Fixed news summaries

Earlier versions auto-generated a one-line summary from GDELT's raw CAMEO codes
("engaged in fighting with"), which was frequently just wrong — GDELT's
structured data contains no headlines. The backend now fetches each article's
own `<title>`/`og:title` and shows that. `/api/news` serves *only* items with a
real scraped title; the CAMEO sentence survives as a labelled fallback inside
fused conflict pins, never as a headline.

---

## Where a pin actually is

For the large majority of conflict rows the coordinate came from GDELT, which
geocodes by picking a place named somewhere in the article. That is a guess
about a document, not an observation of an event. The measured baseline
(`backend/scripts/eval_placement.py`) found 37.9% of rows placed no better than
a region, a median 87 km from the nearest human-coded event, and a tail past
1,300 km.

Two modules address this.

**`gazetteer.py`** is the offline reference: GeoNames `cities500` plus the
admin-1/admin-2 code tables, ~200k rows, served entirely from memory. It
returns *candidates* rather than an answer — "Tripoli" is genuinely two cities
in two countries, and collapsing that to one point is the failure mode it
exists to prevent — and it reports `radius_km_for(...)`, because a national
centroid is not a location, it is a 400 km circle drawn as a dot. The built
index is persisted to Postgres and rehydrated at startup (three GeoNames
downloads and 200k parsed rows is not something to redo on every restart), but
lookups never go through the database: placement accuracy must not depend on
storage being up.

**`geoverify.py`** reads the article's own text back against the coordinate and
returns one of five verdicts:

| Verdict | Effect |
|---|---|
| `confirmed` | The text names a locality at or near the pin. Believe it. |
| `refined` | The pin was on a country/region centroid and the text names one unambiguous locality inside it. Move the pin, and record where it came from. |
| `contested` | The text names a locality far from the pin. **Do not move it** — we know the geocode is doubtful, not what is right — but stop presenting it as certain. |
| `dateline_suspect` | The only place named is the one the article was filed from. The classic wrong-pin case; demoted hardest, never allowed to move anything. |
| `unverified` | No readable text, or none naming a resolvable place. Leave the coordinate alone. |

Two rules run through all of it: a verdict may only ever move a pin **up** the
precision ladder (a country centroid can become a locality; a locality is never
overwritten by something coarser), and a disagreement demotes confidence rather
than inventing a new position.

Records that end up with no better than country-level precision are handled by
an explicit policy (`COUNTRY_CENTROID_POLICY`, default `demote`): they are
severity-penalised, drawn with a dashed ring, and can be hidden entirely with
the **Show approximate locations** checkbox.

---

## Annotations that aren't layers

Some of the highest-value work here draws nothing of its own — it answers a
question about markers that are already on the map.

**Sanctions.** OFAC's SDN list is reduced to things that move. Vessel
identifiers live in two places: the structured `Call_Sign` column, and free
prose in `Remarks` ("Vessel Registration Identification IMO 7406784") — 1,517
of 1,524 vessel rows carry an IMO there and 791 an MMSI. Aircraft are listed by
tail number in `SDN_Name`.

Every match records **which identifier fired**, and the popup prints it,
because they are three very different strengths of claim about the same hull:
an IMO is permanent and hull-specific; an MMSI belongs to the radio licence and
is reissued on reflagging; an AIS call sign is free text a crew typed in.
**Nothing is ever matched on name** — a vessel name is the easiest field in AIS
to change and the most duplicated, so a name match would produce confident,
wrong designations. A designated vessel keeps its own glyph and gains a double
ring: a designated tanker is still a tanker.

**Airfields.** OurAirports also backs a proximity index queried per aircraft,
so a contact orbiting over an airbase says so in its own popup — you do not
have to switch the airfield layer on. The military flag is an *inference from
the airfield's name* ("Air Base", "RAF", "AFB"), labelled as one everywhere it
surfaces: OurAirports has no military field, so a name match will both miss
civil-named military fields and over-reach.

**Capitals.** GDELT geocodes many diplomatic events to a country centroid — a
point in the geometric middle of a landmass, which is an artifact of the
geocoder rather than a location. Diplomacy happens in capitals, so those events
are anchored to the seat of government and the popup says that is what happened.

**Outlets.** A shared domain allowlist and labelling/ranking table, used by
GDELT (bare domains from the Mentions table) and by ACLED/UCDP (their own
semicolon-separated source strings). Outlet lists are capped for payload size,
but the true total always survives as `outlet_count`, so a popup naming eight
outlets and saying "+31 more" tells the reader everything a full list would.

**CAMEO.** The coding scheme rendered readable — turning
`1831 / ISRAELI / JOURNALIST` into a sentence. Every output is a *rendering* of
structured fields, never a new claim; the hedging lives in the provenance line
printed underneath, which states that the whole thing is machine-coded from one
article.

---

## What's on screen

### Layer groups (control panel)

- **Conflict & Events** — Conflict & Violence (fused), news reports as a
  sub-ticker of it, the UCDP verified record, Officials & Diplomacy.
- **Air & Sea Traffic** — Navy/MSC, tankers, civilian ships, dark vessels,
  military aircraft, emergency & hidden aircraft, civilian aircraft, plus
  optional trails.
- **Infrastructure & Environment** — curated infrastructure (with a name
  filter), OSM infrastructure, airfields, submarine cables, fires, jamming.
- **Natural Hazards** — earthquakes and volcanoes.
- **Space** — satellites (stations + military, with trails), orbital launches.
- **Places** — countries, cities.
- **Weather** — precipitation radar, cloud cover, wind arrows.
- **Satellite imagery** — MODIS Terra true colour, VIIRS true colour, VIIRS
  day-night band (which runs ~3 days behind and says so).
- **Source status** — per-source item count, seconds since last success, and
  the actual error text when a source is failing.

Layers default **off** except the ones that earn being on: fused conflict
events, news, diplomacy, military aircraft and ships, tankers, curated
infrastructure, satellites, jamming, countries, cities — and
**Emergency & Hidden Aircraft**, which is on deliberately, because an aircraft
squawking 7500 or one whose operator asked not to be listed is rare, is the
point, and should not need switching on to be seen.

Dark vessels and OSM infrastructure default off **on principle** rather than
for clutter: one is an inference drawn from an absence, the other is
crowd-sourced geometry sitting next to a human-checked list. Both should appear
because a reader asked for them, not because the map asserted them.

Every layer row shows `visible (global total)`, so a thinned view never reads
as a broken feed.

### Panels and interaction

| Element | What it does |
|---|---|
| **Region bar** | 11 conflict theatres (Russia/Ukraine, Israel/Gaza/Lebanon, Persian Gulf/Hormuz, Red Sea/Yemen, Korean Peninsula, Taiwan Strait, South China Sea, Sahel, Sudan, Kashmir, Venezuela/Caribbean) plus World. One backend registry drives both the camera and the `?region=` payload filter, so the two can never drift. Zones are ranked hottest-first from live data. |
| **Conflict briefing card** | Opens on picking a zone: event/fatality tally, dominant activity type, top events, latest headlines — filtered exactly as the map is. |
| **Notable events panel** | "What matters right now", ranked by server-computed severity (floor 40), so significance does not depend on spotting the biggest pin among hundreds. |
| **News broadcast panel** | Viewport-filtered headline ticker, reusing the already-fetched GDELT payload. Starts collapsed. |
| **Country card** | Click any country: population, density, HDI, recent matched events, district-level ACLED counts, displacement and food security, internet-outage status. Folded into collapsible sections, anchored to the clicked country until dragged, then detached. |
| **Country selection bar** | Chips for every highlighted country — the only place a selection is cleared, so scoping state is never invisible. |
| **Timeline scrubber** | Replays the last 3 days: one slider, play/pause, "Go live". Conflict events replay out of Postgres so the scrubber shows the *fused* records, falling back to time-filtering the live feed on a cold database. Satellite imagery date and event-age calculations both follow the scrubber, so the whole map agrees on what "now" means. |
| **Admin Mode** | Everything that used to require editing source: icon colours and sizes, per-layer size/opacity/zoom gates, per-record data edits, panel opacity/accent/text size/motion, export/import/reset. Rendered only while Admin Mode is on — there is no editable control anywhere else, so a reader cannot change anything by any sequence of clicks. Saved server-side to `data/admin_config.json` and fetched by every client at startup, so a configuration made on one machine applies everywhere this backend serves. |
| **Theme** | Light and dark, with the basemap swapped to match. |

### Viewport-scoped rendering

Every layer draws only what is within (plus a small margin around) the current
view. The backend still fetches full global data in the background, so panning
is instant — it is the drawing step that is scoped. Sidebar counts show visible
and global totals side by side; `/api/health` has the raw numbers. Countries are
the exception and always draw in full, since they are cheap and act as map
furniture.

---

## Architecture

```
frontend/src/
  App.jsx              orchestrator; owns nothing but wiring
  hooks/               useOsintData (all polling + region scope), useReplay,
                       useHealth, useTheme, useAppSettings, ...
  map/                 useLeafletMap + createMapController, layers, popups,
                       declutter, collapse, trails, severity, decorators,
                       svgIcons, webglLayer (Pixi sprite batching), iconTheme
  components/          presentational only; nothing below App talks to the
                       network or to Leaflet directly
  settings/            defaults + Admin Mode override application

backend/
  app.py               FastAPI routes, ETag/caching, tile + wind proxies
  cache.py             in-memory SourceRegistry; version counter per source
  config.py            every tunable, all env-overridable
  storage.py           asyncpg pool, five tables, retention sweep
  regions.py           the region registry (camera targets == payload filters)
  infrastructure.py    curated static sites + pipeline routes
  escalation.py        baseline comparison
  replay.py/history.py point-in-time reconstruction
  admin_config.py      atomic read/write of data/admin_config.json
  ratelimit.py         TokenBucket + LruTtlCache
  sources/             one module per publisher, plus shared helpers
                       (cameo, outlets, capitals, proximity, hapi, geoverify,
                       gazetteer)
  tests/               pytest
  scripts/             placement evaluation, bulk infra import, probes
```

**Source lifecycle.** Each module is imported and started independently inside
FastAPI's lifespan. A module with a broken or missing dependency used to take
the whole backend down through a single shared import line; now it logs and
sits inert while everything else runs.

**Caching.** A source's data can only change when its poller reassigns
`state.data`, which bumps a version counter — so "did the version change"
answers "did the data change" without ever hashing a 100k-point payload. That
version becomes the ETag. `Cache-Control: no-cache` is used deliberately (not a
bare `max-age`): the browser can still skip the body via a 304, but must
actually ask, so a client can never sit on a 30-minute-old snapshot with no way
to notice. Slow-moving reference sources (countries, cities, airfields, OSM
infra, cables) get a real `max-age`. Every ETag carries a per-process token, so
a restarted backend can never serve a 304 against a cached copy from the
previous process.

**Rate limiting.** Outbound quota-limited upstreams are guarded by token
buckets, and only cache *misses* draw a token: the wind grid (snapped to a 4°
cache key, 30 burst / 1 per second, plus a short negative cache so an outage
costs one upstream call instead of one per pan) and the OWM tile proxy (200
burst / 20 per second, with out-of-range z/x/y rejected by arithmetic rather
than by spending quota upstream).

**Process split.** Four tiers, one shape.

```
sources -> ingest -> Postgres -> refine -> Postgres -> backend <-> redis -> frontend
                                                          ^
                                                    cache-worker (watches only)
```

**ingest** (`python -m backend.ingest`) owns every upstream that costs
credentials, credits or a volunteer service's patience — ACLED/UCDP, FIRMS,
ADS-B, AIS, and the Overpass sweep — and writes only to Postgres. That boundary
exists because those five were being re-paid for on every restart, redeploy and
local dev run, by whichever process happened to be running. Exactly one process
holds the keys now, and running a second copy of it is the one deployment
mistake that costs real quota.

**refine** (`python -m backend.refine`) reads stored rows and writes derived
ones: event fusion (ACLED + UCDP + GDELT into one record per incident, carrying
geo-verification, CAMEO coding and reliability scoring with it), dark-vessel gaps
and ship-to-ship pairs, and the escalation ranking. It holds no credentials and
makes no outbound call at all — a property enforced by a test, not by convention
— which is what makes it safe to restart or kill freely.

**backend** fetches nothing and derives nothing. It follows what the other two
wrote (`backend/mirror.py`) and republishes it into the same registry states the
API always served from, so `/api/ships`, `/api/aircraft`, `/api/fires` and the
conflict layer are unchanged from the outside. Everything keyless still polls
here.

**redis** caches the built payloads, and **cache-worker** watches. The worker
never writes a cache key or repopulates one: a monitor that also repairs cannot
tell "healthy" from "broken and patched every 60 seconds". What it finds goes to
the log, an `alerts` table, an optional `ALERT_WEBHOOK_URL`, and the `alerts`
block on `/api/health`.

Two mechanisms make the read side cheap and honest. Writers announce on a
Postgres `NOTIFY` channel inside their own transaction, so the backend follows a
change within milliseconds of it becoming readable, with a 20-second tick only
as a fallback for a dropped listener. And each pass first reads one indexed row
— `max(updated_at)` for the kind — and touches the payload only when that moved:
`state.version` is the HTTP ETag, so republishing unchanged data would force
every client to re-download a 100k-point FIRMS payload several times a minute.
`/api/health` reports the *ingest's* last success for those sources, not the
backend's last database read, so a dead ingest container turns them red with the
reason on it instead of showing frozen data under a green light.

---

## HTTP API

All responses are JSON unless noted. Point endpoints accept `?region=<key>`
(see `/api/regions`); an unknown or absent key means world/unfiltered.

| Endpoint | Returns |
|---|---|
| `GET /api/health` | Per-source status: key configured, item count, version, last success, seconds since, last error. Plus `alerts`: whatever the cache worker is currently reporting |
| `GET /api/regions` | The region registry (labels, groups, bounds) |
| `GET /api/events` | **The canonical conflict feed** — fused ACLED + UCDP + GDELT, one record per incident. World view capped at 2,500 by severity |
| `GET /api/officials` | Officials & Diplomacy, world view capped at 1,200 by rank |
| `GET /api/news` | GDELT articles with real scraped titles, 24-hour window |
| `GET /api/conflict` | Raw pre-fusion ACLED + UCDP rows |
| `GET /api/conflict-history` | UCDP's reviewed record, ungated by recency; every row carries `as_of`/`lag_days` |
| `GET /api/conflict-stats` | Country-by-month ACLED aggregates (24 months) |
| `GET /api/conflict-districts` | ACLED at admin-2, monthly. `?country=ISO3`, `?months=N` (default 1, `0` for all — the full archive is ~23 MB) |
| `GET /api/escalation` | Regions above their own baseline; empty list when there is not enough history |
| `GET /api/fires` | FIRMS + HMS thermal anomalies |
| `GET /api/ships` | Live AIS positions |
| `GET /api/aircraft` | Live ADS-B positions |
| `GET /api/dark-vessels` | Inferred AIS gaps and ship-to-ship transfers |
| `GET /api/satellites` | SGP4-propagated positions (never cached) |
| `GET /api/launches` | Orbital launches at their pads |
| `GET /api/hazards` | Earthquakes and volcanic activity, each record carrying its own `kind` and publisher |
| `GET /api/jamming` | GPS interference hex cells |
| `GET /api/outages` | Country-keyed internet outage scores |
| `GET /api/energy-flows` | Country-keyed cross-border electricity exchange, measured and scheduled halves kept apart |
| `GET /api/cables` | Cable routes and landing points in one payload (no region filter — a cable is one object thousands of km long) |
| `GET /api/infrastructure` | Curated sites + pipeline routes |
| `GET /api/osm-infrastructure` | OpenStreetMap infrastructure |
| `GET /api/airports` | Served airfield slice |
| `GET /api/countries` | Boundaries GeoJSON with population/density/HDI |
| `GET /api/cities` | Cities 100k+ and capitals |
| `GET /api/humanitarian` | Country-keyed displacement and food security |
| `GET /api/replay?at=<unix>` | Point-in-time snapshot: events, fires, news, plus nearest ship/aircraft positions |
| `GET /api/wind?south=&west=&north=&east=` | 9×9 wind velocity grid for a bbox |
| `GET /api/weather/tile/{layer}/{z}/{x}/{y}.png` | Proxied OWM tile (`clouds_new`, `wind_new`, `precipitation_new`, `temp_new`, `pressure_new`) |
| `GET`/`PUT /api/admin-config` | The Admin Mode configuration, never cached |

---

## Configuration reference

Everything lives in `.env` at the project root. All values are optional.

### Credentials

| Variable | Purpose |
|---|---|
| `FIRMS_MAP_KEY` | NASA FIRMS VIIRS |
| `AISSTREAM_API_KEY` | Live AIS |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Authenticated OpenSky (60 s instead of 15 min) |
| `ACLED_EMAIL` / `ACLED_PASSWORD` | myACLED login for the point-level feed |
| `OWM_API_KEY` | OpenWeatherMap cloud/wind tiles |
| `HAPI_CONTACT_EMAIL` / `HAPI_APP_IDENTIFIER` | HDX HAPI courtesy identifier |

### Poll intervals (seconds)

`FIRMS_POLL_INTERVAL` (900) · `GDELT_POLL_INTERVAL` (900) ·
`ADSB_POLL_INTERVAL_ANON` (900) · `ADSB_POLL_INTERVAL_AUTH` (60) ·
`ACLED_POLL_INTERVAL` (1800) · `UCDP_POLL_INTERVAL` (21600) ·
`ENERGY_FLOWS_POLL_INTERVAL` (3600)

### Retention and storage

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://osint:osint@localhost:5432/osint` | Postgres. Wrong or absent is survivable: storage retries in the background and the app runs live-only until it connects |
| `HISTORY_RETENTION_SECONDS` | 3 days | Ship/aircraft movement log — matches the replay range |
| `CONFLICT_WATCH_RETENTION_DAYS` | 180 | The fused-event archive, the durable "personal daily archive" |
| `SOURCE_HEALTH_RETENTION_DAYS` | 14 | Per-poll outcome log |
| `AIS_STALE_AFTER` / `ADSB_STALE_AFTER` | 1800 | When an entity is evicted from `entity_latest` |
| `ENTITY_STALE_AFTER_DEFAULT` | 86400 | Fallback for kinds without a specific window |

Per-kind eviction windows are set in `config.ENTITY_STALE_AFTER`, and they
differ by an order of magnitude on purpose — a 30-minute window that suits a
live AIS stream would continuously evict a city index refetched once a day.

### Coverage and behaviour

| Variable | Default | Meaning |
|---|---|---|
| `AIS_BBOXES` | 8 chokepoints | `lat_min,lon_min,lat_max,lon_max` boxes separated by `;` |
| `AIRPLANES_LIVE_POINTS` | 7 regions | `lat,lon,radius_nm` (max 250 nm) separated by `;` — airplanes.live has no bbox endpoint |
| `CONFLICT_PIPELINE_VERSION` | 2 | Bump whenever a change alters how many events the pipeline produces, or what severity means |
| `COUNTRY_CENTROID_POLICY` | `demote` | What to do with events located only to a country |
| `NEWS_URL_DATE_GATE` | off | Stricter recency gate on news URLs |
| `OFFICIALS_SNAP_REGION` | off | Snap region-level diplomacy geocodes |
| `PORT` | 8000 | Set by PaaS hosts; its presence switches the bind to `0.0.0.0` and skips auto-opening a browser |

---

## Persistence

Everything the app collects goes to Postgres, across six tables
(`backend/storage.py`):

| Table | Contents |
|---|---|
| `entity_latest` | One row per `(kind, entity_id)`, always current |
| `entity_history` | Append-only, one row per position *change* (deduped at ~1 m, so a stationary ship reporting the same position every 5 s does not bloat the log) |
| `conflict_events` | The fused ACLED/UCDP/GDELT archive with its richer queryable columns |
| `reference_snapshots` | Whole-document sources that aren't lat/lon rows — country GeoJSON, HDX series, cable routes, the OFAC list, the gazetteer index |
| `source_health` | One row per poll outcome, per source |
| `alerts` | Open and resolved problems the cache worker found — a producer gone quiet, a cached copy behind Postgres (`backend/cacheworker`) |

Adding a source is one `record_snapshot()` call in its poll loop — no schema
change. Writes are deliberately failure-tolerant: the live in-memory layer is
the source of truth for what is on screen, so a Postgres hiccup logs and
continues rather than taking a poller down. Reads (`/api/replay`) surface their
errors normally.

Two things are deliberately **not** read back at startup:

- **Aircraft positions** — restoring them would draw planes where they *were*,
  not where they are. The sky is empty for one poll instead.
- **Satellite positions** — recomputed from the stored orbital elements, which
  is the honest equivalent: the elements are what was collected, the positions
  are arithmetic over them. They are not *written* either: a position this app
  can recompute exactly is not evidence worth a row.

Rows expire on their kind's own window (`ENTITY_STALE_AFTER` in
`backend/config.py`). That cutoff is applied twice — once by each write, and
again every 10 minutes by `storage.retention_sweep_loop`, which is what clears
a source that has stopped producing altogether. A poller cannot be relied on to
evict its own last positions, because a dead one never runs again.

The only *live* application state outside the database is
`data/admin_config.json`, bind-mounted so it survives container replacement.
`data/` also holds archives and re-fetchable snapshots that no code reads —
see [`data/README.md`](data/README.md), which accounts for every file there.

`backend/tests/test_persistence_coverage.py` enforces the contract: a source
that collects something without storing it, or stores something without reading
it back, fails the test suite rather than quietly showing an empty layer after
every restart.

---

## Tests

```bash
python -m pytest backend/tests
```

Coverage is concentrated where silent breakage is most likely: headerless
column indices read by position (GeoNames, OFAC), parsing of upstream formats
(GDELT export rows, RSS/Atom, XLSX, Overpass), the fusion clustering and
severity logic, geoverify verdicts, the dark-vessel inference guards, the
storage schema, and the persistence round-trip above.

`backend/scripts/eval_placement.py` measures geocode quality against
human-coded events — it is where the 37.9%/87 km/1,300 km figures quoted above
come from, and it is the way to check whether a placement change actually
helped.

---

## Troubleshooting

**A layer is empty.** Open **Source status** in the control panel (or
`GET /api/health`). It reports per source whether a key is configured, how many
items it holds, how long since its last success, and the verbatim error text.

**Conflict events look thin on a fresh start.** Expected without Postgres — the
GDELT accumulator builds over three days. Use the compose stack.

**ACLED shows an error after adding credentials.** Check your access level on
your myACLED account page. Research tier typically has a ~12-month embargo, and
the backend correctly discards embargoed rows rather than drawing them as
current. The district-level HDX feed keeps working regardless.

**Wind arrows stop.** Open-Meteo's free tier has a hard *daily* cap. The
backend returns 503 with `Retry-After` when it is deliberately declining to
spend more quota, and negative-caches upstream failures for two minutes.

**The map goes cold on the WSL/Docker setup.** Check that `docker.service` is
enabled in the distro and that `vmIdleTimeout=-1` is set in
`%USERPROFILE%\.wslconfig` — without it the WSL VM shuts down about a minute
after the last shell closes and takes the collectors with it.

**Nothing loads at `localhost:8080`.** nginx waits on the backend's health
check before proxying; give it the start period, then
`docker compose logs backend`.

---

## Limits, and what this is not

- **This is not an intelligence product.** Nothing here is verified or
  authoritative. It is an aggregation of public feeds with their uncertainty
  labelled. Cross-check before drawing any conclusion.
- **Thermal anomalies cannot distinguish a wildfire from a strike.** FIRMS
  detects heat, and most heat is agricultural burning or wildfire.
- **Absence of data is not absence of events.** AIS coverage is thin far from
  shore, ADS-B coverage is thin over oceans and much of Africa and Asia, and
  GDELT sees what was published in the languages and outlets it indexes.
  Sparse regions look quiet whether or not they are.
- **Machine-coded events can be wrong about who did what.** That is the whole
  reason the `origin` field, the outlet count, and the corroboration colour
  exist.
- **Historical layers lag.** UCDP's candidate file trails by a month or more;
  ACLED district counts run to the end of the previous month; the GVP volcano
  report describes a week.
- **Coordinates are for situational awareness.** Curated infrastructure
  positions are approximate, sourced from public reference material (EIA,
  company and government sites, Wikipedia). OSM positions are a feature's
  computed centre, so a large base reads as the middle of its area rather than
  any particular building. Cable routes are schematic.
- **Credentials stay local.** All keys live only in your `.env`, which is
  gitignored. Tile and API requests that need a key are proxied through the
  backend so the key never reaches the browser.

---

## Attribution

This project is a thin layer over other people's work. In rough order of how
much of the map they carry:

GDELT Project · ACLED · UCDP (Uppsala University) · UN OCHA HDX / HAPI · UNHCR ·
NASA FIRMS · NOAA HMS · NASA GIBS / Worldview · USGS · Smithsonian Global
Volcanism Program · OpenSky Network · airplanes.live · aisstream.io ·
gpsjam.org · IODA (Georgia Tech) · CelesTrak · The Space Devs (Launch Library
2) · TeleGeography · OurAirports · OpenStreetMap contributors · Overpass API ·
GeoNames · Natural Earth · World Bank · Our World in Data · US Treasury OFAC ·
Open-Meteo · RainViewer · OpenWeatherMap · CARTO · Leaflet.

LiveATC is deliberately **not** used: its terms of service prohibit third-party
use of its audio streams. ADS-B stands in for it.

Each source's own terms apply to the data it publishes.
