"""Measure how wrong the map's pin placement actually is, in kilometres.

Every constant in the placement pipeline -- match radii, imprecision penalties,
uncertainty ring sizes, whether a refinement is allowed to move a pin at all --
is a claim about the world. This script is how those claims stop being
arguments. Run it before a change and after it; if the numbers do not move in
the right direction, the change was not an improvement regardless of how it
reads.

  python -m backend.scripts.eval_placement            # from the app's own archive
  python -m backend.scripts.eval_placement --live     # from a fresh GDELT window

Writes nothing. Reads the archive (or the live feeds) and prints distributions.

The ground truth is free and already in the pipeline: ACLED and UCDP rows are
human-coded to a named locality, while GDELT rows are machine-geocoded from an
article. Where both describe the same incident, the structured row's coordinate
is what the GDELT row's coordinate should have been.

Two measurements, because neither alone is honest:

  Clustered pairs -- rows the fusion pipeline actually merged. This is the error
    the merged record inherits, but it is *censored* by the clusterer: two rows
    are only paired directly if they are within _MATCH_KM, so a pin placed
    900 km wrong usually never forms a pair and is invisible here. The censoring
    is not a clean cutoff -- _cluster is union-find, so a chain of intermediate
    rows (or a shared GDELT FeatureID, which is matched with no distance test at
    all) can pull in a member far beyond the radius. Expect a long thin tail
    past _MATCH_KM rather than a wall at it, and do not read the absence of
    large errors here as their absence in the data.

  Nearest structured row -- for every GDELT row, the distance to the closest
    human-coded event in the same country and time window, with no radius
    ceiling. This one sees the country-centroid disasters. It over-matches by
    construction (the nearest real event may not be the one the article was
    about), so its absolute value is a loose upper bound -- but its *shape*,
    sliced by geo_precision, is the thing worth looking at, and its p90 moving
    is a real signal.
"""

import argparse
import asyncio
import collections
import statistics
from datetime import datetime, timedelta, timezone

from backend import config, regions, storage
from backend.sources import event_fusion, gazetteer, proximity

# How far the no-ceiling nearest-neighbour scan will look before giving up. Well
# beyond any defensible placement, so a country-centroid pin in a large country
# still finds its match and gets counted rather than silently dropping out of
# the sample.
NEAREST_SEARCH_KM = 1500.0

# Same-incident window for the nearest-neighbour measure. Matches
# event_fusion._MATCH_DAYS so the two measurements disagree only about distance,
# never about time.
NEAREST_WINDOW_DAYS = event_fusion._MATCH_DAYS

# Below this many pairs the percentiles are noise. escalation.py refuses to
# report on a thin sample for the same reason; a measurement harness that
# prints confident numbers off nine data points is worse than one that prints
# nothing.
MIN_PAIRS_TO_REPORT = 20

STRUCTURED_SOURCES = ("acled", "ucdp")


# --- loading ---------------------------------------------------------------


async def _load_from_db() -> tuple[list[dict], list[dict]]:
    """The app's own archive: 4 days of GDELT conflict rows, 7 of ACLED/UCDP.

    This is the preferred mode -- it is a far bigger sample than one live
    window, and it is exactly the data the running pipeline made decisions on.
    """
    await storage.init_pool(retries=1, delay=0.5)
    if storage.get_pool() is None:
        return [], []
    gdelt_rows = await storage.entity_latest("gdelt_conflict")
    structured = await storage.entity_latest("acled")
    return gdelt_rows, structured


async def _load_live(days: int, hours: int) -> tuple[list[dict], list[dict]]:
    """Ground truth first, then the GDELT windows that actually overlap it.

    The obvious version of this -- fetch the newest GDELT window, fetch the
    current ACLED/UCDP rows, compare -- produces zero pairs, which is not a bug
    in either source. UCDP's candidate file lags real time by a month or more
    (see acled._parse_ucdp_csv), and acled._fetch's live half is gated to the
    real last three days precisely so a stale file cannot be drawn as current.
    So "now" on the GDELT side and "now" on the ground-truth side are two
    different months, and nothing pairs.

    Ground truth therefore chooses the dates. We take UCDP's reviewed record
    (ungated -- recency is irrelevant when measuring a geocoder), pick the days
    it covers most densely, and read GDELT's historical windows for those exact
    days. Sampling the densest days rather than the most recent ones is
    deliberate: a day with 400 reviewed events yields far more pairs per file
    fetched than one with three.
    """
    from backend.sources import acled, gdelt

    _live, history = await acled._fetch()
    if not history:
        return [], []

    by_day = collections.Counter(row["date"] for row in history if row.get("date"))
    sampled = [day for day, _ in by_day.most_common(days)]
    print(f"    ground truth: {len(history)} reviewed rows; sampling {len(sampled)} "
          f"day(s) {sorted(sampled)}")

    windows = []
    for day in sampled:
        # Midday UTC, reading back `hours`. GDELT's volume is not uniform across
        # the day, so a fixed hour keeps successive runs comparable.
        noon = datetime.strptime(day, "%Y-%m-%d").replace(hour=12, tzinfo=timezone.utc)
        windows.append(gdelt._fetch_window(at=noon, window_minutes=hours * 60))

    gdelt_rows: list[dict] = []
    for chunk in await asyncio.gather(*windows, return_exceptions=True):
        if isinstance(chunk, Exception):
            print(f"    (a GDELT window failed: {chunk})")
            continue
        gdelt_rows.extend(chunk)

    sampled_days = set(sampled)
    truth = [row for row in history if row.get("date") in sampled_days]
    return gdelt_rows, truth


# --- normalization ---------------------------------------------------------


def _prepare(gdelt_rows: list[dict], structured_rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """Run the real pipeline's own gates and normalizers, not a copy of them.

    Anything this script re-implements is something it can be wrong about
    independently of the pipeline, which would make a measurement that
    disagrees with production useless.
    """
    violent = [r for r in gdelt_rows if event_fusion._is_violent_gdelt_row(r)]
    normalized_gdelt = []
    for raw in violent:
        item = event_fusion._normalize_gdelt(raw)
        if item.get("dt") is not None and _has_coords(item):
            normalized_gdelt.append(item)

    normalized_structured = []
    for raw in structured_rows:
        source = (raw.get("source") or "acled").lower()
        if source not in STRUCTURED_SOURCES:
            source = "acled"
        item = event_fusion._normalize_structured(source, raw)
        if item.get("dt") is not None and _has_coords(item):
            normalized_structured.append(item)

    return normalized_gdelt, normalized_structured


def _has_coords(item: dict) -> bool:
    return isinstance(item.get("lat"), (int, float)) and isinstance(item.get("lon"), (int, float))


# --- measurement -----------------------------------------------------------


def clustered_pair_errors(gdelt_items: list[dict], structured_items: list[dict]) -> list[dict]:
    """Placement error for rows the fusion pipeline actually merged together.

    Ceiling-limited to event_fusion._MATCH_KM by construction -- see the module
    docstring. Reported anyway because it is the error the *served* record
    carries.
    """
    clusters = event_fusion._cluster(gdelt_items + structured_items)
    out = []
    for cluster in clusters:
        truth = [i for i in cluster if i.get("source") in STRUCTURED_SOURCES]
        guesses = [i for i in cluster if i.get("source") == "gdelt"]
        if not truth or not guesses:
            continue
        # The most precise structured member is the reference. ACLED and UCDP
        # are both locality-coded, so this is a tiebreak, not a judgement.
        reference = max(truth, key=lambda i: i.get("fatalities") or 0)
        for guess in guesses:
            out.append({
                "km": proximity.haversine_km(
                    guess["lat"], guess["lon"], reference["lat"], reference["lon"]
                ),
                "geo_precision": guess.get("geo_precision") or "unknown",
                "lat": guess["lat"],
                "lon": guess["lon"],
                "country": guess.get("country"),
                "location": guess.get("location"),
            })
    return out


def _truth_index(structured_items: list[dict]) -> dict[tuple[str, str], proximity.ProximityIndex]:
    """Human-coded events bucketed by (country, day), each day its own index.

    A row is registered under every day in its +/- NEAREST_WINDOW_DAYS window so
    the lookup is a single dict hit rather than a scan across days.
    """
    by_day_country: dict[tuple[str, str], list[dict]] = {}
    for item in structured_items:
        country = (item.get("country") or "").strip().lower()
        day = item["dt"].date()
        for offset in range(-NEAREST_WINDOW_DAYS, NEAREST_WINDOW_DAYS + 1):
            key = (country, str(day + timedelta(days=offset)))
            by_day_country.setdefault(key, []).append(item)
    return {key: proximity.ProximityIndex(items) for key, items in by_day_country.items()}


def _nearest_truth(indexes: dict, guess: dict) -> dict | None:
    """The closest human-coded event to `guess`, same country and time window."""
    country = (guess.get("country") or "").strip().lower()
    index = indexes.get((country, str(guess["dt"].date())))
    if index is None:
        return None
    return index.nearest(guess["lat"], guess["lon"], NEAREST_SEARCH_KM)


def nearest_truth_errors(gdelt_items: list[dict], structured_items: list[dict]) -> list[dict]:
    """Distance from each GDELT row to the nearest human-coded event, no ceiling.

    Restricted to the same country and a +/- NEAREST_WINDOW_DAYS window, because
    without that restriction the "nearest event" in a busy theatre is always
    something, and the number stops meaning anything at all.
    """
    indexes = _truth_index(structured_items)
    out = []
    for guess in gdelt_items:
        hit = _nearest_truth(indexes, guess)
        if hit is None:
            continue
        out.append({
            "km": proximity.haversine_km(guess["lat"], guess["lon"], hit["lat"], hit["lon"]),
            "geo_precision": guess.get("geo_precision") or "unknown",
            "lat": guess["lat"],
            "lon": guess["lon"],
            "country": guess.get("country"),
            "location": guess.get("location"),
        })
    return out


# --- reporting -------------------------------------------------------------


def _percentiles(values: list[float]) -> dict:
    ordered = sorted(values)
    n = len(ordered)

    def at(fraction: float) -> float:
        if not ordered:
            return float("nan")
        return ordered[min(n - 1, int(fraction * n))]

    return {
        "n": n,
        "median": statistics.median(ordered) if ordered else float("nan"),
        "p75": at(0.75),
        "p90": at(0.90),
        "p99": at(0.99),
        "max": ordered[-1] if ordered else float("nan"),
    }


def _print_error_table(title: str, errors: list[dict], caveat: str) -> None:
    print(f"\n=== {title} ===")
    print(f"    {caveat}")
    if len(errors) < MIN_PAIRS_TO_REPORT:
        print(f"    Only {len(errors)} pairs -- below the {MIN_PAIRS_TO_REPORT} needed to say")
        print("    anything. Let the archive fill up, or widen the window.")
        return

    overall = _percentiles([e["km"] for e in errors])
    print(f"    n={overall['n']}  median={overall['median']:.1f} km  "
          f"p75={overall['p75']:.1f}  p90={overall['p90']:.1f}  "
          f"p99={overall['p99']:.1f}  max={overall['max']:.1f}")

    by_precision: dict[str, list[float]] = collections.defaultdict(list)
    for e in errors:
        by_precision[e["geo_precision"]].append(e["km"])
    print("\n    by geo_precision (this is the slice the whole layer is about):")
    print(f"      {'precision':<10} {'n':>6} {'median':>9} {'p90':>9} {'max':>9}")
    for precision in ("locality", "region", "country", "unknown"):
        values = by_precision.get(precision)
        if not values:
            continue
        stats = _percentiles(values)
        print(f"      {precision:<10} {stats['n']:>6} {stats['median']:>8.1f}k "
              f"{stats['p90']:>8.1f}k {stats['max']:>8.1f}k")

    print("\n    by theatre:")
    print(f"      {'region':<26} {'n':>6} {'median':>9} {'p90':>9}")
    for key, entry in regions.REGIONS.items():
        bounds = entry.get("bounds")
        if not bounds:
            continue
        south, west, north, east = bounds
        values = [
            e["km"] for e in errors
            if south <= e["lat"] <= north and west <= e["lon"] <= east
        ]
        if len(values) < 5:
            continue
        stats = _percentiles(values)
        print(f"      {entry['label']:<26} {stats['n']:>6} "
              f"{stats['median']:>8.1f}k {stats['p90']:>8.1f}k")


def _print_worst(errors: list[dict], limit: int = 12) -> None:
    """The individual disasters. Percentiles say how bad it is; these say why.

    Every line here is a pin a reader would have believed. Read them before
    tuning any constant -- the fix is usually visible in the location string.
    """
    if not errors:
        return
    print(f"\n    worst {limit} placements:")
    for e in sorted(errors, key=lambda x: -x["km"])[:limit]:
        location = (e.get("location") or "?")[:44]
        print(f"      {e['km']:>8.1f} km  [{e['geo_precision']:<8}] {location}")


def _print_precision_mix(gdelt_items: list[dict]) -> None:
    """What share of rows are placed on something that is not a place.

    The plan this work came from quoted 17.8% country-precision from an earlier
    measurement. It is re-measured here rather than carried forward as folklore.
    """
    counts = collections.Counter(i.get("geo_precision") or "unknown" for i in gdelt_items)
    total = sum(counts.values()) or 1
    print("\n=== GDELT geo_precision mix (post violence gate) ===")
    for precision in ("locality", "region", "country", "unknown"):
        n = counts.get(precision, 0)
        print(f"    {precision:<10} {n:>7}  {100.0 * n / total:>5.1f}%")
    imprecise = sum(counts.get(p, 0) for p in ("region", "country", "unknown"))
    print(f"    {'-> imprecise':<10} {imprecise:>7}  {100.0 * imprecise / total:>5.1f}%"
          "   (drawn as a point, known only to a region or worse)")


def _print_corroboration_mix(gdelt_items: list[dict]) -> None:
    """Reach vs. independence.

    outlet_count is how many domains carried the story; it is not how many
    newsrooms saw the event. Until backend/sources/wirechains.py lands there is
    no independent count to compare against, so this prints the reach
    distribution alone and says so.
    """
    outlets = sorted(i.get("outlet_count") or 0 for i in gdelt_items)
    if not outlets:
        return
    stats = _percentiles([float(v) for v in outlets])
    print("\n=== outlet_count (reach, NOT independence) ===")
    print(f"    n={stats['n']}  median={stats['median']:.0f}  p75={stats['p75']:.0f}  "
          f"p90={stats['p90']:.0f}  p99={stats['p99']:.0f}  max={stats['max']:.0f}")
    if any("independent_sources" in i for i in gdelt_items):
        independent = [float(i.get("independent_sources") or 0) for i in gdelt_items]
        ind_stats = _percentiles(independent)
        print(f"    independent_sources: median={ind_stats['median']:.0f}  "
              f"p90={ind_stats['p90']:.0f}  max={ind_stats['max']:.0f}")
    else:
        print("    independent_sources not present yet -- wire-chain collapse not wired in.")


def _print_gate_counters() -> None:
    """What the pipeline threw away, and under which rule.

    These counters are maintained by the live pollers (gdelt._dropped_*,
    event_fusion._dropped_*). In --live mode they reflect this run; read from
    the archive they are zero, which is correct and not a bug.
    """
    from backend.sources import gdelt

    print("\n=== gate drop counters (this process) ===")
    print(f"    gdelt retrospective (report lag > {gdelt.MAX_REPORT_LAG_DAYS}d): {gdelt._dropped_retrospective}")
    print(f"    gdelt non-news section path:                {gdelt._dropped_non_news}")
    print(f"    gdelt stale URL date (gate on={gdelt.URL_DATE_GATE}):  {gdelt._dropped_stale_url}")
    print(f"    fusion retrospective:                       {event_fusion._dropped_retrospective}")
    print(f"    fusion non-news:                            {event_fusion._dropped_non_news}")


def _print_geoverify_status(gdelt_items: list[dict], structured_items: list[dict]) -> None:
    """What the reconciliation layer decided, and whether it helped.

    The refinement regression metric is the one that matters. A refinement rate
    is easy to raise and says nothing on its own -- moving every country pin to
    an arbitrary town would score 100%. What counts is whether the pins that
    moved ended up closer to the truth than where they started, and how many
    ended up further away.
    """
    print("\n=== placement reconciliation ===")
    verdicts = collections.Counter(i.get("geo_verdict") or "(none)" for i in gdelt_items)
    total = sum(verdicts.values()) or 1
    if verdicts.get("(none)") == total:
        print("    No verdicts on any row -- geoverify did not run.")
        return
    for verdict, n in verdicts.most_common():
        print(f"    {verdict:<18} {n:>6}  {100.0 * n / total:>5.1f}%")

    refined = [i for i in gdelt_items if i.get("original_lat") is not None]
    if not refined:
        print("\n    No pins were moved. With no scraped article text that is the")
        print("    expected result -- re-run without --no-scrape to exercise the layer.")
        return

    index = _truth_index(structured_items)
    before, after = [], []
    for item in refined:
        hit = _nearest_truth(index, item)
        if hit is None:
            continue
        before.append(proximity.haversine_km(
            item["original_lat"], item["original_lon"], hit["lat"], hit["lon"]))
        after.append(proximity.haversine_km(item["lat"], item["lon"], hit["lat"], hit["lon"]))

    print(f"\n    {len(refined)} pins moved ({100.0 * len(refined) / total:.1f}% of rows); "
          f"{len(before)} of them have a truth row to check against.")
    if not before:
        return
    worse = sum(1 for b, a in zip(before, after) if a > b + 1.0)
    b_stats, a_stats = _percentiles(before), _percentiles(after)
    print(f"      before: median={b_stats['median']:>7.1f} km  p90={b_stats['p90']:>7.1f}")
    print(f"      after:  median={a_stats['median']:>7.1f} km  p90={a_stats['p90']:>7.1f}")
    print(f"      moved FURTHER from truth: {worse} of {len(before)} "
          f"({100.0 * worse / len(before):.0f}%)")
    print("      ^ this is the regression metric. A refinement rate means nothing")
    print("        without it -- moving every pin somewhere would score 100% refined.")


# --- entry point -----------------------------------------------------------


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--live", action="store_true",
        help="fetch a fresh GDELT window + ACLED/UCDP instead of reading the archive",
    )
    parser.add_argument(
        "--worst", type=int, default=12,
        help="how many individual worst placements to list (0 to skip)",
    )
    parser.add_argument(
        "--days", type=int, default=3,
        help="--live only: how many ground-truth days to sample (default 3)",
    )
    parser.add_argument(
        "--hours", type=int, default=4,
        help="--live only: hours of GDELT to read per sampled day (default 4)",
    )
    parser.add_argument(
        "--no-scrape", action="store_true",
        help="skip fetching article text; placement reconciliation then has nothing "
             "to read and every row comes back unverified (this is the BEFORE run)",
    )
    args = parser.parse_args()

    # The gazetteer is not running here -- there is no poller in a script -- so
    # it has to be loaded explicitly or every lookup returns nothing and the
    # whole reconciliation layer silently reports "no opinion".
    print("Loading the gazetteer...")
    try:
        gazetteer.install(await gazetteer._fetch())
        print(f"    {len(gazetteer.current())} resolvable places")
    except Exception as exc:  # noqa: BLE001 - measure what we can without it
        print(f"    gazetteer load failed ({exc}); placement checks will abstain")

    if args.live:
        print("Sampling ground-truth days and reading the matching GDELT windows...")
        gdelt_rows, structured_rows = await _load_live(args.days, args.hours)
    else:
        print("Reading the app's archive (use --live for a fresh window)...")
        gdelt_rows, structured_rows = await _load_from_db()
        if not gdelt_rows and not structured_rows:
            print("Archive is empty or Postgres is unreachable -- falling back to --live.")
            gdelt_rows, structured_rows = await _load_live(args.days, args.hours)

    if not args.no_scrape and gdelt_rows:
        # Article text is what the placement check reads. The live pipeline
        # scrapes it in a background backfill; a script has to ask for it, and
        # without it every row is unverified by construction rather than by
        # measurement.
        from backend.sources import gdelt as gdelt_source

        violent = [r for r in gdelt_rows if event_fusion._is_violent_gdelt_row(r)]
        print(f"Scraping article text for {len(violent)} violent rows "
              "(pass --no-scrape to skip)...")
        try:
            await gdelt_source._attach_titles(violent)
            scraped = sum(1 for r in violent if r.get("article_excerpt"))
            datelines = sum(1 for r in violent if r.get("dateline_place"))
            print(f"    {scraped} with body text, {datelines} with a dateline")
        except Exception as exc:  # noqa: BLE001
            print(f"    scrape failed ({exc}); continuing without article text")

    gdelt_items, structured_items = _prepare(gdelt_rows, structured_rows)
    print(f"\nGDELT rows: {len(gdelt_rows)} fetched, {len(gdelt_items)} violent + placeable")
    print(f"Structured rows (ACLED/UCDP): {len(structured_rows)} fetched, "
          f"{len(structured_items)} placeable")
    print(f"Pipeline version {config.CONFLICT_PIPELINE_VERSION}, "
          f"country-centroid policy '{event_fusion.COUNTRY_CENTROID_POLICY}', "
          f"match radius {event_fusion._MATCH_KM:.0f} km / {event_fusion._MATCH_DAYS} days")

    if not gdelt_items or not structured_items:
        print("\nNothing to compare -- one side of the golden set is empty.")
        print("In archive mode that means the app has not been running against Postgres")
        print("long enough to have persisted both sides; try --live. In --live mode it")
        print("means UCDP published no candidate file in the last 15 months, which would")
        print("be a change in UCDP rather than anything wrong here.")
        return

    _print_precision_mix(gdelt_items)

    clustered = clustered_pair_errors(gdelt_items, structured_items)
    _print_error_table(
        "Placement error, clustered pairs",
        clustered,
        f"CENSORED near {event_fusion._MATCH_KM:.0f} km: rows further apart are rarely "
        "paired at all,\n    so most large failures never reach this table. The tail past "
        "that radius is\n    real (FeatureID matches and union-find chaining ignore "
        "distance) but is not\n    a representative sample of it.",
    )
    if args.worst:
        _print_worst(clustered, args.worst)

    nearest = nearest_truth_errors(gdelt_items, structured_items)
    _print_error_table(
        "Placement error, nearest human-coded event (no ceiling)",
        nearest,
        "Over-matches by construction, so absolute values are a loose upper bound.\n"
        "    The shape per geo_precision, and how p90 moves between runs, is the signal.",
    )
    if args.worst:
        _print_worst(nearest, args.worst)

    _print_corroboration_mix(gdelt_items)
    _print_gate_counters()
    _print_geoverify_status(gdelt_items, structured_items)

    await storage.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
