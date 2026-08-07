"""What the world expects to grow, trade and eat -- and what food costs.

Two publishers, one module, kept apart all the way to the card because they are
different claims on different clocks.

- **AMIS** (the G20's Agricultural Market Information System), through FAO's
  keyless BigQuery proxy. Wheat, rice, maize and soybean balance sheets --
  production, opening and closing stocks, imports, exports, food and feed use --
  for the 24 regions that between them are most of world production and trade.
  Published monthly, on a *marketing year* ("2026/27"), which is the unit the
  grain trade actually thinks in and does not line up with a calendar year.
- **The FAO Food Price Index**, a single global monthly series back to 1990,
  with sub-indices for meat, dairy, cereals, oils and sugar. One number for
  "what did food cost this month", against a 2014-2016 = 100 base.

The Cereals sub-index is the number the AMIS balance sheets should be read
beside: a tightening balance and a rising cereal price are the same story told
from the supply side and the demand side.

--- three estimates of every number, never averaged ------------------------

The reason this source is here rather than USDA's own API is the `database`
column. It takes three values, and each is an independent body's estimate of the
same quantity:

    CBS -> FAO's own commodity balance sheets
    IGC -> the International Grains Council
    PSD -> USDA's Production, Supply and Distribution database

USDA's own API answers `403 Bad API Key` without a key and the IGC publishes no
API at all; both arrive here free, on an identical schema. Argentine wheat
exports for 2026/27 read 15.0 (FAO), 14.3 (IGC) and 14.5 (USDA).

**All three are stored side by side. They are never averaged and one is never
picked.** Three independent bodies estimating the same quantity is a
corroboration axis -- the same thing `conflict_events.corroborated_by` counts
for incidents -- and the distance between them is itself the signal. A commodity
the three agree on to within a percent is a settled fact; one they disagree on
by ten percent is a market nobody can see clearly, which is exactly when a map
of it is worth having.

`spread` below is the only number in this module that nobody published: it is
the gap between the highest and lowest of the three, computed here, and it says
so in its own payload (`inferred_by`) rather than sitting anonymously among the
figures the three bodies actually issued.

--- these are forecasts ----------------------------------------------------

A marketing-year balance sheet is not an observation. 2026/27 has not finished,
most of it has not happened, and every figure is what a forecasting body
currently expects. That is a fourth kind of claim on this map, alongside the
curated dataset (an ACLED incident a human analyst coded), the measurement (a
USGS magnitude, a metered megawatt) and the inference this app made itself
(dark_vessels' gaps).

So `season` -- AMIS's own "2026/27" -- is attached to every single figure, and
every estimate carries `evidence: "forecast"`. A card must be able to say
"2026/27 forecast" the way humanitarian.py's card says which months its IPC
figures cover. Nothing here may render as though it were measured.

**None of it goes on the map.** A national balance sheet has no location; the
honest pin for "Ukraine will export 15.5 Mt of wheat" does not exist. Same rule
humanitarian.py and energy_flows.py set out: served as a country-keyed
dictionary and read inside the country card, drawn nowhere.

--- change detection -------------------------------------------------------

The natural key is `(database_code, m49, product_code, year)`, which is exactly
how the merged document is nested (country -> commodity -> estimates[database]),
so two passes can be compared key by key. That matters because **the view
carries no revision or vintage column**: `date` is only 1 January of the
marketing year, identical on every row, and the query returns whichever estimate
is current. A revision is visible as a changed *value* and in no other way, so
nothing in this module may put a timestamp inside the document -- a pass that
changed nothing has to serialise to the same bytes. When the document was
fetched is `reference_snapshots.updated_at` and `state.last_success`, which is
where it belongs.

Licence: CC BY 4.0 both halves. Maintainer AMIS-Secretariat@fao.org.
"""

import asyncio
import csv
import io
import logging
import re
import time

import httpx

from backend import storage
from backend.cache import registry

log = logging.getLogger("osint-globe.food_trade")

# --- AMIS ------------------------------------------------------------------

AMIS_QUERY_URL = "https://api.data.apps.fao.org/api/v2/bigquery"
AMIS_CATALOG_URL = "https://data.apps.fao.org/catalog/api/3/action/package_show"
AMIS_PACKAGE_ID = "amis-database"
AMIS_SOURCE_URL = "https://data.apps.fao.org/catalog/dataset/amis-database"

# The parameterised query the proxy runs. Resolved from FAO's own catalogue at
# startup rather than hardcoded: the resource UUID is stable but the SQL behind
# it was last edited 2025-11-10, and a stale query is the failure mode that
# answers 200 with the wrong columns instead of erroring. This is the last
# known-good value, used only when resolution fails, and the fallback is logged.
AMIS_SQL_URL_FALLBACK = (
    "https://data.apps.fao.org/catalog/dataset/10d3d4ae-120d-4f55-90f5-34d36fc9f922"
    "/resource/1f2b85b1-837e-4a11-ba5b-fc85b4680769/download/amis-parameterized-query.sql"
)

# All four are required. Omitting any one answers 400 naming the one that is
# missing, so there is no partial request to make.
DATABASES = ("CBS", "IGC", "PSD")

# Product codes, deliberately *not* paired with names here. The catalogue's
# documented ordering and the live view disagree (code 4 answers Rice and code 5
# answers Maize, the other way round from the published note), so the commodity
# a row is about is read from its own `product_name` column and never inferred
# from the code that was asked for.
PRODUCT_CODES = ("1", "4", "5", "6")

# 12 requests, ~38 KB, 1.9-4.1 s each. No rate limit was hit across ~20
# sequential calls, which is not a reason to make 12 at once against a free
# service run by a secretariat.
REQUEST_SPACING = 2.0

# Half the sweep. Above this the corroboration axis is gone -- and losing it
# matters more here than a missing country does in energy_flows.py, because a
# single surviving estimate looks exactly like a settled figure.
MAX_TOLERATED_FAILURES = (len(DATABASES) * len(PRODUCT_CODES)) // 2

# The numeric columns of the balance sheet, in the publisher's own names and
# order. `imports_nmy` / `exports_nmy` keep their suffix rather than being
# shortened to imports/exports: it marks trade counted on the national marketing
# year, which is a different quantity from calendar-year trade, and renaming it
# would quietly assert they are the same.
BALANCE_FIELDS = (
    "total_supply",
    "opening_stocks",
    "production",
    "imports_nmy",
    "total_utilization",
    "domestic_utilization",
    "food_use",
    "feed_use",
    "other_uses",
    "exports_nmy",
    "closing_stocks",
)

# The evidence grade every AMIS figure carries. See the module docstring: a
# marketing-year balance sheet is a projection, and the map has no other source
# that is one.
EVIDENCE_FORECAST = "forecast"

# Anything this app computed rather than received. Stamped on the spread block
# so a card can never present it as one of the three bodies' own numbers.
INFERRED_BY = "osint-live-globe"

AMIS_LICENCE = "CC BY 4.0"
AMIS_ATTRIBUTION = "AMIS (FAO / IGC / USDA-PSD), CC BY 4.0"

# --- the FAO Food Price Index ----------------------------------------------

# The bare URL on purpose. FAO's own page links this with a `?sfvrsn=` cache
# token that changes with every monthly release; the bare form is stable and
# serves the current file.
FPI_URL = (
    "https://www.fao.org/media/docs/worldfoodsituationlibraries"
    "/default-document-library/food_price_indices_data.csv"
)
FPI_SOURCE_URL = "https://www.fao.org/worldfoodsituation/foodpricesindex/en/"
FPI_LICENCE = "CC BY 4.0"
FPI_ATTRIBUTION = "FAO Food Price Index, CC BY 4.0"

# An index is a measurement of what happened, not a projection of what will --
# the opposite grade to the AMIS half, and the reason the two are separate
# documents rather than one.
EVIDENCE_OBSERVED = "observed"

# --- cadence ---------------------------------------------------------------

# AMIS publishes ~10 issues a year and the price index once a month. Twice a day
# is already far tighter than either, and is only this frequent so that a
# restart or a failed pass is not a whole day behind.
REFRESH_INTERVAL = 12 * 3600
FAILURE_RETRY_INTERVAL = 300  # scaled by consecutive failures, capped at REFRESH_INTERVAL

# How far back to look for a published marketing year. A new one appears partway
# through the calendar year before it: asking for 2027 today answers 200 with a
# header and no rows, so "this year" alone would blank the card every January.
# Same shape as humanitarian.py's UNHCR year window, and for the same reason.
AMIS_YEARS_BACK = 1

# --- country coding --------------------------------------------------------
#
# AMIS keys regions by UN M49 numeric code. This project keys countries by ISO3
# (backend/sources/countries.py reads Natural Earth's ADM0_A3; humanitarian.py
# and the country card join on it), so the 24 regions are mapped by hand. Twenty
# four rows that change roughly never is not worth a dependency, and a hand table
# is the only form in which the two judgement calls below can be written down.

M49_EUROPEAN_UNION = 150
M49_CHINA_MAINLAND = 156

# The European Union has no ISO3 and no country card. It is also not a sum of
# the member rows -- those are not in this feed at all -- so dropping it would
# throw away roughly a fifth of world wheat with nothing to reconstruct it from.
# It is kept under a non-ISO3 key and flagged `aggregate`, exactly as
# energy_flows.py keeps its `eu` row: anything walking this dictionary looking
# for country cards to fill skips it, and a bloc-level panel can still find it.
EU_KEY = "EU"
AGGREGATE_CODES = frozenset({EU_KEY})

M49_TO_ISO3 = {
    32: "ARG",
    36: "AUS",
    76: "BRA",
    124: "CAN",
    # 150 European Union -- see EU_KEY above.
    # AMIS reports "China, mainland": Hong Kong, Macao and Taiwan excluded. It is
    # mapped to CHN rather than held out, because the shape this app draws for
    # CHN (Natural Earth ADM0_A3, with TWN and HKG as their own features) covers
    # the same territory, so the join is honest rather than convenient. FAO's
    # *wider* "China" aggregate -- the one that would be ambiguous -- is M49 1248
    # and does not appear in this feed, so there is no second row to confuse it
    # with. The record keeps FAO's own `region_name` verbatim and carries a note,
    # so the card prints "China, mainland" and can footnote what that excludes
    # instead of silently relabelling the figure "China".
    156: "CHN",
    356: "IND",
    360: "IDN",
    392: "JPN",
    398: "KAZ",
    410: "KOR",
    484: "MEX",
    566: "NGA",
    608: "PHL",
    643: "RUS",
    682: "SAU",
    704: "VNM",
    710: "ZAF",
    764: "THA",
    792: "TUR",
    804: "UKR",
    818: "EGY",
    826: "GBR",
    840: "USA",
}

CHINA_MAINLAND_NOTE = (
    "FAO reports mainland China separately: Hong Kong, Macao and Taiwan Province "
    "of China are not included in these figures."
)

# A region AMIS adds that this table does not know yet. Keyed rather than
# dropped -- no country feature carries an iso_a3 of this shape, so it reaches no
# card, but the figures survive in storage and the log says what to add.
UNMAPPED_KEY_PREFIX = "m49:"

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def _slug(text: str | None) -> str:
    return _NON_ALNUM_RE.sub("_", (text or "").strip().lower()).strip("_")


def _number(value) -> float | None:
    """A blank AMIS field is "not published", which is not zero.

    Every IGC row leaves `other_uses` empty and every USDA row leaves both
    `food_use` and `feed_use` empty. Reading those as 0.0 would say the USDA
    forecasts no human consumption of wheat in Argentina, and would make the
    spread against FAO's 4.9 Mt look like a disagreement rather than a silence.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _int(value) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def country_key(m49: int | None) -> tuple[str | None, bool, str | None]:
    """M49 -> (key this project can join on, is-an-aggregate, footnote).

    Never returns None for a code that arrived with data; an unrecognised region
    gets a namespaced key so the figures survive somewhere findable rather than
    disappearing between a parse and a merge.
    """
    if m49 is None:
        return None, False, None
    if m49 == M49_EUROPEAN_UNION:
        return EU_KEY, True, None
    if m49 == M49_CHINA_MAINLAND:
        return M49_TO_ISO3[m49], False, CHINA_MAINLAND_NOTE
    iso3 = M49_TO_ISO3.get(m49)
    if iso3:
        return iso3, False, None
    return f"{UNMAPPED_KEY_PREFIX}{m49}", False, None


def parse_amis(text: str) -> list[dict]:
    """One CSV response -> one estimate per region.

    Read by column name rather than by position: the view is a parameterised SQL
    query FAO edits in place, and it has gained columns before. A row without a
    region, a product or a season is dropped -- a balance sheet whose marketing
    year is unknown cannot be labelled, and an unlabelled forecast is the one
    thing this module must not produce.
    """
    out: list[dict] = []
    unmapped: set[int] = set()
    for row in csv.DictReader(io.StringIO(text, newline="")):
        m49 = _int(row.get("m49"))
        product_code = _int(row.get("product_code"))
        product = (row.get("product_name") or "").strip()
        season = (row.get("season") or "").strip()
        database_code = (row.get("database_code") or "").strip()
        if not (m49 and product and season and database_code):
            continue
        key, aggregate, note = country_key(m49)
        if key and key.startswith(UNMAPPED_KEY_PREFIX):
            unmapped.add(m49)
        estimate = {
            "database_code": database_code,
            # The `database` column is each body's own name for itself
            # ("FAO-AMIS", "IGC", "USDA-PSD") and is what a card should print.
            "publisher": (row.get("database") or database_code).strip(),
            "m49": m49,
            "region_name": (row.get("region_name") or "").strip() or None,
            "country_code": key,
            "aggregate": aggregate,
            "note": note,
            "product_code": product_code,
            "product": product,
            "commodity": _slug(product),
            "year": _int(row.get("year")),
            "season": season,
            "units": (row.get("units") or "").strip() or None,
            # 1 January of the marketing year on every row, identical across
            # revisions. Carried because it is what the publisher said, but it is
            # not a vintage and nothing may treat it as one.
            "date": (row.get("date") or "").strip() or None,
            "evidence": EVIDENCE_FORECAST,
        }
        estimate.update({field: _number(row.get(field)) for field in BALANCE_FIELDS})
        out.append(estimate)
    if unmapped:
        log.warning(
            "AMIS returned regions with no ISO3 mapping: %s -- their figures are "
            "stored under %s<code> and reach no country card until M49_TO_ISO3 "
            "learns them",
            ", ".join(str(m) for m in sorted(unmapped)), UNMAPPED_KEY_PREFIX,
        )
    return out


def spread(estimates: dict[str, dict]) -> dict | None:
    """How far apart the three bodies are, per field. Computed here, not published.

    Only fields at least two of them actually put a number against: a "spread"
    over one estimate is not a spread, and a spread that silently treats a blank
    as zero would manufacture a disagreement out of a silence.
    """
    fields: dict[str, dict] = {}
    for field in BALANCE_FIELDS:
        published = {
            code: est[field]
            for code, est in estimates.items()
            if est.get(field) is not None
        }
        if len(published) < 2:
            continue
        low = min(published, key=lambda code: published[code])
        high = max(published, key=lambda code: published[code])
        fields[field] = {
            "low": published[low],
            "low_source": estimates[low]["publisher"],
            "high": published[high],
            "high_source": estimates[high]["publisher"],
            # Binary float subtraction: 15.0 - 14.3 is 0.7000000000000011, and a
            # card showing that would look like a precision nobody claimed.
            "spread": round(published[high] - published[low], 6),
            "estimates": len(published),
        }
    if not fields:
        return None
    return {
        "inferred_by": INFERRED_BY,
        "basis": (
            "the difference between the highest and lowest of the estimates above. "
            "No publisher issues this figure."
        ),
        "fields": fields,
    }


def merge(estimates: list[dict]) -> dict[str, dict]:
    """Estimates from every (database, product) request -> {country key: record}.

    Nested by the natural key: country -> commodity -> estimates[database_code].
    That is what keeps the three bodies distinguishable at the point a card reads
    them, and what makes two passes comparable value by value.
    """
    merged: dict[str, dict] = {}
    for est in estimates:
        key = est.get("country_code")
        if not key:
            continue
        record = merged.setdefault(key, {
            "country_code": key,
            # FAO's own wording for the region, not a name of ours.
            "country": est.get("region_name"),
            "m49": est.get("m49"),
            "aggregate": bool(est.get("aggregate")),
            "note": est.get("note"),
            # Repeated on every record rather than held once at the top of the
            # document: this is a country-keyed dictionary and a card that has
            # one record has to be able to attribute it without a second lookup.
            "evidence": EVIDENCE_FORECAST,
            "license": AMIS_LICENCE,
            "attribution": AMIS_ATTRIBUTION,
            "source_url": AMIS_SOURCE_URL,
            "commodities": {},
        })
        commodity = record["commodities"].setdefault(est["commodity"], {
            "commodity": est["commodity"],
            "product": est.get("product"),
            "product_code": est.get("product_code"),
            "estimates": {},
        })
        commodity["estimates"][est["database_code"]] = {
            field: est.get(field)
            for field in (
                "database_code", "publisher", "season", "year", "units", "date",
                "evidence", *BALANCE_FIELDS,
            )
        }

    for record in merged.values():
        for commodity in record["commodities"].values():
            per_estimate = commodity["estimates"].values()
            seasons = sorted({e["season"] for e in per_estimate if e.get("season")})
            units = sorted({e["units"] for e in per_estimate if e.get("units")})
            # Set at the commodity level only when all three agree. They always
            # have; if they ever stop, a header cannot pick one of two answers,
            # and every estimate carries its own season anyway -- that one is
            # authoritative and this one is a convenience.
            commodity["season"] = seasons[0] if len(seasons) == 1 else None
            commodity["seasons"] = seasons
            commodity["units"] = units[0] if len(units) == 1 else None
            commodity["databases"] = sorted(commodity["estimates"])
            commodity["spread"] = spread(commodity["estimates"])
    return merged


# --- the price index -------------------------------------------------------

# The row that starts the table. FAO ships two title lines above it ("FAO Food
# Price Index", then the base period) and a row of bare commas below it, and pads
# every line out to ~65 empty columns. The header is found by looking for this
# cell rather than by skipping a fixed number of lines: FAO has moved that
# preamble before, and a fixed skip does not fail, it silently reads the base
# period line as the column names.
FPI_HEADER_FIRST_CELL = "date"
_FPI_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
_FPI_BASE_RE = re.compile(r"=\s*100\b")


def parse_price_index(text: str) -> dict:
    """The FAO Food Price Index CSV -> the whole monthly series and its base.

    Raises rather than returning an empty document when the header cannot be
    found: a price index that silently became zero months long would show as a
    healthy poll over a blank card.
    """
    rows = list(csv.reader(io.StringIO(text, newline="")))
    header_at = None
    for index, row in enumerate(rows):
        if row and row[0].strip().lower() == FPI_HEADER_FIRST_CELL:
            header_at = index
            break
    if header_at is None:
        raise ValueError(
            f"no {FPI_HEADER_FIRST_CELL!r} header row in the FAO Food Price Index CSV "
            f"({len(rows)} rows) -- the layout changed"
        )

    preamble = [cell.strip() for row in rows[:header_at] for cell in row if cell.strip()]
    base_period = next((cell for cell in preamble if _FPI_BASE_RE.search(cell)), None)

    # Everything after the first empty header cell is padding, not a column.
    labels: list[str] = []
    for cell in rows[header_at]:
        name = cell.strip()
        if not name:
            break
        labels.append(name)
    value_labels = labels[1:]  # the first is the Date column itself
    keys = [_slug(label) for label in value_labels]

    series = []
    for row in rows[header_at + 1:]:
        if not row:
            continue
        month = row[0].strip()
        if not _FPI_MONTH_RE.match(month):
            continue  # the blank spacer row, and anything FAO appends as a note
        values = {
            key: _number(row[position + 1]) if position + 1 < len(row) else None
            for position, key in enumerate(keys)
        }
        if all(value is None for value in values.values()):
            continue
        series.append({"month": month, **values})
    if not series:
        raise ValueError("the FAO Food Price Index CSV has a header but no monthly rows")

    return {
        "publisher": "FAO",
        "index": preamble[0] if preamble else "FAO Food Price Index",
        # The reference period the whole series is expressed against. It is the
        # index's equivalent of AMIS's `season`: without it every number below is
        # a bare figure with no scale, and FAO rebases this periodically.
        "base_period": base_period,
        "evidence": EVIDENCE_OBSERVED,
        "license": FPI_LICENCE,
        "attribution": FPI_ATTRIBUTION,
        "source_url": FPI_SOURCE_URL,
        # slug -> FAO's own column label, so a card prints "Food Price Index"
        # rather than the key this module made out of it.
        "labels": dict(zip(keys, value_labels)),
        "first_month": series[0]["month"],
        "last_month": series[-1]["month"],
        "months": len(series),
        # The newest month, lifted out so a card does not have to know that the
        # series is in ascending order to find it.
        "latest": series[-1],
        "series": series,
    }


# --- fetching --------------------------------------------------------------


def pick_sql_url(resources: list[dict]) -> str:
    """The query file's own download URL, out of the catalogue's resource list.

    Two of the four resources end in ".sql" and only one of them *is* one. The
    first listed is a `smart-csv` whose URL is a ready-made call to the query
    proxy with the real file passed as its `sql_url` parameter:

        https://api.data.apps.fao.org/api/v2/bigquery?sql_url=https://...query.sql

    Matching on the string's suffix picks that one, and feeding it back in as
    `sql_url` nests the proxy inside itself and answers 502 on every request. So
    the test is on the URL's *path*, with the query string cut off first -- the
    wrapper's path is /api/v2/bigquery and the file's ends in .sql.
    """
    for resource in resources:
        url = (resource.get("url") or "").strip()
        path = url.split("?", 1)[0]
        if path.lower().endswith(".sql"):
            return url
    raise RuntimeError(f"{AMIS_PACKAGE_ID} lists no .sql resource")


async def resolve_sql_url(client: httpx.AsyncClient) -> str:
    """The parameterised query's current URL, from FAO's own CKAN catalogue."""
    resp = await client.get(AMIS_CATALOG_URL, params={"id": AMIS_PACKAGE_ID})
    resp.raise_for_status()
    return pick_sql_url(((resp.json() or {}).get("result") or {}).get("resources") or [])


async def _get_csv(client: httpx.AsyncClient, sql_url: str, database: str, product: str, year: int) -> str:
    resp = await client.get(
        AMIS_QUERY_URL,
        params={
            "sql_url": sql_url,
            "database": database,
            "product": product,
            "region": "all",
            "year": str(year),
        },
    )
    resp.raise_for_status()
    # Decoded explicitly. The response's Content-Type is the bare string "csv"
    # with no charset, so the encoding is a guess unless it is made here, and the
    # region list contains "Türkiye".
    return resp.content.decode("utf-8", "replace")


async def newest_published_year(client: httpx.AsyncClient, sql_url: str) -> int:
    """The newest marketing year AMIS actually has rows for.

    One cheap probe rather than discovering it 12 requests in. Falls back to the
    current calendar year when neither candidate answers, so the sweep still runs
    and its per-request failures are reported where they can be read.
    """
    this_year = time.gmtime().tm_year
    for candidate in range(this_year, this_year - AMIS_YEARS_BACK - 1, -1):
        try:
            rows = parse_amis(await _get_csv(client, sql_url, DATABASES[0], PRODUCT_CODES[0], candidate))
        except Exception as exc:  # noqa: BLE001 - the sweep reports the real failure
            log.warning("AMIS year probe for %d failed: %s", candidate, exc)
            continue
        if rows:
            return candidate
        log.info("AMIS has no rows for %d yet; trying the previous marketing year", candidate)
    return this_year


async def sweep_amis(client: httpx.AsyncClient, sql_url: str, year: int) -> tuple[list[dict], list[str]]:
    """Every (database, product) for one marketing year. Returns (estimates, failures).

    Sequential and paced. One request failing must not cost the other eleven --
    the same rule hazards.py follows when the weekly volcano report fails and the
    earthquakes already in hand are kept.
    """
    estimates: list[dict] = []
    failures: list[str] = []
    first = True
    for database in DATABASES:
        for product in PRODUCT_CODES:
            if not first:
                await asyncio.sleep(REQUEST_SPACING)
            first = False
            try:
                rows = parse_amis(await _get_csv(client, sql_url, database, product, year))
            except Exception as exc:  # noqa: BLE001 - one cell of the grid, not the sweep
                failures.append(f"{database}/product {product}: {exc}")
                log.debug("AMIS %s product %s failed: %s", database, product, exc)
                continue
            if not rows:
                failures.append(f"{database}/product {product}: no rows for {year}")
                continue
            estimates.extend(rows)
    return estimates, failures


async def fetch_price_index(client: httpx.AsyncClient) -> dict:
    resp = await client.get(FPI_URL)
    resp.raise_for_status()
    # utf-8-sig: FAO's export has carried a BOM in past releases and the header
    # test below matches on the first cell, which a BOM would prefix.
    return parse_price_index(resp.content.decode("utf-8-sig", "replace"))


# --- the poller ------------------------------------------------------------


async def start():
    # Two states, not one. They are two documents on two clocks with two
    # different evidence grades, and folding them together would make
    # /api/health unable to say which half went quiet -- the same reason gdelt.py
    # registers its three layers separately.
    trade_state = registry.register("food_trade", key_configured=True)  # no key required
    price_state = registry.register("food_price_index", key_configured=True)
    # Country-keyed dicts and whole documents, not point rows: nothing here is
    # drawn, so both warm from reference_snapshots and neither is ever mirrored
    # into entity_latest.
    trade_state.data = {}
    price_state.data = {}
    await storage.warm_reference(trade_state, "food_trade", "Food trade")
    await storage.warm_reference(price_state, "food_price_index", "Food price index")

    sql_url = AMIS_SQL_URL_FALLBACK
    sql_url_resolved = False
    consecutive_failures = 0
    while True:
        merged: dict[str, dict] = {}
        price: dict | None = None
        amis_error: str | None = None
        price_error: str | None = None
        amis_failures: list[str] = []
        year: int | None = None

        async with httpx.AsyncClient(
            timeout=90, follow_redirects=True, headers={"User-Agent": "osint-live-globe/1.0"}
        ) as client:
            # Retried on every pass until it works rather than only at boot: a
            # run that fell back is running a query FAO may since have edited,
            # and that is worth getting out of as soon as the catalogue answers.
            if not sql_url_resolved:
                try:
                    sql_url = await resolve_sql_url(client)
                    sql_url_resolved = True
                    log.info("AMIS query resolved from the catalogue: %s", sql_url)
                except Exception as exc:  # noqa: BLE001 - the fallback is known-good
                    log.warning(
                        "AMIS catalogue lookup failed (%s) -- falling back to the "
                        "last known-good query URL", exc,
                    )

            try:
                year = await newest_published_year(client, sql_url)
                estimates, amis_failures = await sweep_amis(client, sql_url, year)
                merged = merge(estimates)
                if not merged or len(amis_failures) > MAX_TOLERATED_FAILURES:
                    raise RuntimeError(
                        f"AMIS sweep produced {len(merged)} regions with "
                        f"{len(amis_failures)} of {len(DATABASES) * len(PRODUCT_CODES)} "
                        f"requests failing"
                    )
            except Exception as exc:  # noqa: BLE001 - the price index still publishes
                merged = {}
                amis_error = str(exc)
                log.warning("AMIS fetch failed: %s", exc)

            try:
                price = await fetch_price_index(client)
            except Exception as exc:  # noqa: BLE001 - the balance sheets still publish
                price_error = str(exc)
                log.warning("FAO Food Price Index fetch failed: %s", exc)

        now = time.time()
        if merged:
            trade_state.data = merged
            trade_state.last_success = now
            # A partial sweep is a success that still owes an explanation: the
            # commodities behind those failures will be short an estimate, and
            # /api/health is the only place that can say which.
            databases = sorted({
                code
                for record in merged.values()
                for commodity in record["commodities"].values()
                for code in commodity["databases"]
            })
            notes = []
            if amis_failures:
                notes.append(
                    f"{len(amis_failures)} of {len(DATABASES) * len(PRODUCT_CODES)} "
                    f"requests failed: {'; '.join(amis_failures[:3])}"
                )
            if len(databases) < len(DATABASES):
                notes.append(
                    f"only {'/'.join(databases)} answered -- no corroboration across "
                    f"the three estimating bodies this pass"
                )
            trade_state.last_error = " | ".join(notes) or None
            log.info(
                "Food trade: %d regions x %d commodities for %s from %s (%d request failures)",
                len(merged),
                max((len(r["commodities"]) for r in merged.values()), default=0),
                year, "/".join(databases), len(amis_failures),
            )
            await storage.record_reference("food_trade", merged)
            await storage.record_source_health("food_trade", len(merged), True)
        else:
            trade_state.last_error = amis_error
            await storage.record_source_health("food_trade", None, False, amis_error)

        if price:
            price_state.data = price
            price_state.last_success = now
            price_state.last_error = None
            log.info(
                "Food price index: %d months to %s, headline %s, cereals %s",
                price["months"], price["last_month"],
                price["latest"].get("food_price_index"), price["latest"].get("cereals"),
            )
            await storage.record_reference("food_price_index", price)
            await storage.record_source_health("food_price_index", price["months"], True)
        else:
            price_state.last_error = price_error
            await storage.record_source_health("food_price_index", None, False, price_error)

        # One publisher answering is a working pass. Backing off because the
        # other one did not would slow the half that is healthy for the sake of
        # the half that is not.
        ok = bool(merged or price)
        consecutive_failures = 0 if ok else consecutive_failures + 1
        await asyncio.sleep(
            REFRESH_INTERVAL if ok
            else min(FAILURE_RETRY_INTERVAL * consecutive_failures, REFRESH_INTERVAL)
        )
