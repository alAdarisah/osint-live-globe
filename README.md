# OSINT Live Globe

A local, interactive map that shows live open-source intelligence: conflict
events, fires/thermal anomalies, ship traffic, news, aircraft, and live weather.
Runs entirely on your own PC.

## Running it

1. Make sure [Python](https://www.python.org/downloads/) is installed (3.10+).
2. Double-click **`run.bat`** in this folder.
   - First run: it creates a virtual environment, installs everything it needs,
     and creates a `.env` file for your API keys.
   - It then starts the app and opens your browser to `http://localhost:8000`.
3. To stop it, close the black command-window that opened (or press `Ctrl+C`
   inside it).

The app works immediately with **no keys at all** — the News (GDELT) and
Aircraft (anonymous ADS-B) layers work out of the box. The other three layers
need a free key each; add them any time and just restart `run.bat`.

## Getting the API keys

Open `.env` in this folder (Notepad is fine) and fill these in. You only need
to do each of these once.

### 1. NASA FIRMS (fires / thermal anomalies) — instant
Go to https://firms.modaps.eosdis.nasa.gov/api/map_key/, enter your email, and
it emails you a key immediately. Paste it as `FIRMS_MAP_KEY`.

### 2. aisstream.io (live ship positions) — a few minutes
Sign up free at https://aisstream.io, then find your API key on your account
page. Paste it as `AISSTREAM_API_KEY`.

By default this only tracks a handful of high-interest maritime chokepoints
(Black Sea, Red Sea, Strait of Hormuz, Taiwan Strait, South China Sea, Eastern
Mediterranean) rather than the whole ocean, to keep things fast and relevant.
You can change this by editing `AIS_BBOXES` in `.env` (see `backend/config.py`
for the format).

### 3. OpenSky Network (live aircraft) — optional
The app already shows aircraft without any key, but anonymous access is
limited to 100 requests/day, so it updates only every 15 minutes. For live
(60-second) updates: register free at https://opensky-network.org, go to your
account's API client settings, create a client, and paste the id/secret as
`OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`.

### 4. ACLED (conflict & violence events) — a few minutes, approval may be needed
Register at https://acleddata.com (top-right "Login/Register"). Use the same
email/password as your `ACLED_EMAIL` / `ACLED_PASSWORD` in `.env` — the app
signs in as you would in a browser. Note: ACLED's free tier gives you their
dashboard, but full raw-event API access sometimes requires them to approve a
Research/Partner tier request — if the Conflict layer shows an error in the
"Source status" panel after you add your credentials, check your myACLED
account page for your current access level.

Your ACLED password is stored only in the local `.env` file on this PC and is
sent only to ACLED's own login page over HTTPS — nothing else sees it.

### 5. OpenWeatherMap (cloud cover / wind layers) — optional
The precipitation radar layer needs no key and always works. For the extra
Cloud Cover and Wind layers, register free at
https://home.openweathermap.org/users/sign_up, then grab a key from
https://home.openweathermap.org/api_keys and paste it as `OWM_API_KEY`.

## What each layer shows

| Layer | Source | Notes |
|---|---|---|
| Conflict & Violence | ACLED | Political violence/protest events, colored by fatalities |
| Fires / Thermal Anomalies | NASA FIRMS | Satellite heat detections shown as a density heatmap — cannot distinguish a wildfire from a strike; use judgment |
| Maritime / AIS | aisstream.io | Live ship positions in a curated set of high-risk waters |
| News | GDELT | Recent conflict-flavored news, with an auto-generated one-line summary and a link to the original article |
| Aircraft | OpenSky Network (ADS-B) | Live aircraft broadcasting ADS-B position, icon/color by type (commercial/military/helicopter/other) — substituted for LiveATC, whose terms of service prohibit third-party use of its audio streams |
| Weather | RainViewer (radar, no key) + OpenWeatherMap (clouds/wind, optional key) | Live precipitation radar always on; cloud cover and wind need a free OWM key |
| Countries | Natural Earth (boundaries) + World Bank (population/density) | Click any country for its latest population, population density, and recent matched ACLED/GDELT events |
| Cities (100k+) | GeoNames | Every city with population ≥100,000 — click for its population and events within 50km |
| Wind Direction (arrows) | Open-Meteo (free, no key) | Small animated arrows over a grid across whatever's on screen, pointing the way the wind blows; bigger arrows when zoomed out |
| Ship/aircraft trails | Built client-side from each poll | A fading line behind every ship and plane showing its recent track — the closest thing to a "flight path" available, since OpenSky only gives live position, not filed routes |

Countries and cities need no key at all — Natural Earth, the World Bank API,
and GeoNames' bulk city dump are all free and open. "Recent events" in a
country/city popup are matched by country name (countries) or straight-line
distance (cities) against the ACLED/GDELT data already on the map, so a
mismatch in country naming or a very sparse area can mean nothing is matched
even if something nearby exists.

## Fixed news summaries

Earlier versions tried to auto-generate a one-line summary from GDELT's raw
CAMEO event codes (e.g. "engaged in fighting with"), which was often just
wrong — GDELT's structured data doesn't include real headlines. The backend
now fetches each article's own `<title>`/`og:title` directly and shows that
instead; the CAMEO sentence only appears as a fallback on the rare article
that can't be fetched (paywall, bot-blocking, timeout), and is clearly
labeled as such in the popup.

## Viewport-based rendering

Every layer now only draws what's within (plus a small margin around) your
current view — pan to the Middle East and you'll only see Middle East fires,
ships, aircraft, news, and cities, not the whole world's worth. The backend
still fetches full global data in the background as before (so panning is
instant, no waiting on a new request), it's the drawing step that's now
scoped to what's on screen. The sidebar counts reflect what's currently
visible, not the global total — check `/api/health` if you want raw global
counts. Countries are the one exception and always show all 177 regardless of
view, since they're cheap to draw and act as map reference/furniture.

## Notes and limits

- This is a personal monitoring tool, not an intelligence product — nothing
  shown here is verified or authoritative. Cross-check before drawing
  conclusions.
- If a layer stays empty, check the **Source status** panel in the app (or
  `http://localhost:8000/api/health`) — it tells you whether a key is missing
  or a request is failing, and why.
- All API keys/credentials live only in your local `.env` file, which is never
  uploaded anywhere and is excluded from version control (`.gitignore`).
