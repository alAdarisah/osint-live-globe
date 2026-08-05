"""Read-only calibration probe for the GDELT conflict pipeline.

Fetches one rolling export window straight from GDELT and prints the
distributions the fusion pipeline's constants need to be tuned against --
geographic precision, CAMEO code mix, outlet-count percentiles, and how many
rows actually survive the violence gate. Writes nothing, touches no database,
and does not import the running app's state.

Two jobs:

  1. Validate the column indices in gdelt.py empirically rather than trusting
     a spec. Every index this prints a plausible distribution for is an index
     that is really where we think it is.
  2. Replace guesses with measurements. Severity coefficients and accumulator
     caps were previously reasoned about from the shape of the code; the
     percentiles below are what they should be set from.

    python -m backend.scripts.probe_gdelt [--window-minutes 120]
"""

import argparse
import asyncio
import collections
import csv
import io
import statistics
import zipfile
from datetime import datetime, timedelta, timezone

import httpx

from backend.sources import gdelt

# Column indices under test. Deliberately re-declared here rather than
# imported: the point of this script is to check gdelt.py's constants, and
# importing them would make the check circular.
COL = {
    "GlobalEventID": 0,
    "SQLDATE": 1,
    "Actor1Name": 6,
    "Actor1CountryCode": 7,
    "Actor1KnownGroupCode": 8,
    "Actor1Type1Code": 12,
    "Actor2Name": 16,
    "Actor2CountryCode": 17,
    "Actor2KnownGroupCode": 18,
    "Actor2Type1Code": 22,
    "IsRootEvent": 25,
    "EventCode": 26,
    "EventBaseCode": 27,
    "EventRootCode": 28,
    "QuadClass": 29,
    "GoldsteinScale": 30,
    "NumMentions": 31,
    "NumSources": 32,
    "NumArticles": 33,
    "AvgTone": 34,
    "ActionGeo_Type": 51,
    "ActionGeo_FullName": 52,
    "ActionGeo_CountryCode": 53,
    "ActionGeo_Lat": 56,
    "ActionGeo_Long": 57,
    "ActionGeo_FeatureID": 58,
    "DATEADDED": 59,
    "SOURCEURL": 60,
}

GEO_TYPE_NAME = {
    0: "0 no match", 1: "1 COUNTRY", 2: "2 USSTATE",
    3: "3 USCITY", 4: "4 WORLDCITY", 5: "5 WORLDSTATE",
}

VIOLENCE_ROOT_CODES = {18, 19, 20}
ARMED_ACTOR_TYPES = {"MIL", "REB", "INS", "SEP", "PAR", "UAF", "SPY"}


def _is_violent(row: list[str]) -> bool:
    """Mirror of event_fusion._is_violent_gdelt_row, against raw columns."""
    try:
        root = int(row[COL["EventRootCode"]])
    except (ValueError, IndexError):
        return False
    if root not in VIOLENCE_ROOT_CODES:
        return False
    if row[COL["Actor1Type1Code"]] in ARMED_ACTOR_TYPES or row[COL["Actor2Type1Code"]] in ARMED_ACTOR_TYPES:
        return True
    return bool(row[COL["Actor1KnownGroupCode"]] or row[COL["Actor2KnownGroupCode"]])


async def _fetch_raw_window(window_minutes: int) -> tuple[list[list[str]], str]:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        latest_url = await gdelt._latest_export_url(client)
        latest_dt = gdelt._parse_latest_ts(latest_url)
        # Built here rather than via gdelt._window_urls, which is hard-capped
        # at the module's own WINDOW_MINUTES -- this probe wants to be able to
        # sample a wider window than the live poller uses.
        step = gdelt.FILE_STEP_MINUTES
        urls = [
            f"{gdelt.GDELT_BASE_URL}"
            f"{(latest_dt - timedelta(minutes=step * k)).strftime('%Y%m%d%H%M%S')}.export.CSV.zip"
            for k in range(window_minutes // step)
        ]
        payloads = await asyncio.gather(*(client.get(u) for u in urls), return_exceptions=True)

    rows: list[list[str]] = []
    for resp in payloads:
        if isinstance(resp, Exception) or resp.status_code != 200:
            continue
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            text = zf.read(zf.namelist()[0]).decode("utf-8", errors="replace")
        rows.extend(csv.reader(io.StringIO(text), delimiter="\t"))
    return rows, latest_dt.strftime("%Y-%m-%d %H:%M UTC")


def _percentiles(values: list[float], label: str) -> str:
    if not values:
        return f"  {label:<14} (none)"
    ordered = sorted(values)

    def at(p):
        return ordered[min(int(len(ordered) * p), len(ordered) - 1)]

    return (
        f"  {label:<14} p10={at(0.10):>6.0f}  p50={at(0.50):>6.0f}  p75={at(0.75):>6.0f}  "
        f"p90={at(0.90):>6.0f}  p99={at(0.99):>6.0f}  max={ordered[-1]:>6.0f}  "
        f"mean={statistics.fmean(ordered):>6.1f}"
    )


def _histogram(counter: collections.Counter, total: int, limit: int = 25) -> list[str]:
    out = []
    for key, count in counter.most_common(limit):
        share = 100.0 * count / total if total else 0.0
        bar = "#" * int(share / 2)
        out.append(f"  {str(key):<34} {count:>6}  {share:>5.1f}%  {bar}")
    return out


def _report(rows: list[list[str]], window_label: str, window_hours: float) -> None:
    width = collections.Counter(len(r) for r in rows)
    usable = [r for r in rows if len(r) > COL["SOURCEURL"]]

    print(f"\nGDELT calibration probe -- window ending {window_label}")
    print("=" * 78)
    print(f"raw rows                    {len(rows)}")
    print(f"column-count distribution   {dict(width.most_common(4))}")
    print(f"usable rows (>60 cols)      {len(usable)}")

    quad = collections.Counter()
    conflict = []
    for row in usable:
        try:
            quad_class = int(row[COL["QuadClass"]])
        except (ValueError, IndexError):
            continue
        quad[quad_class] += 1
        if quad_class in (3, 4):
            conflict.append(row)
    print(f"quad_class distribution     {dict(sorted(quad.items()))}")
    print(f"conflict rows (quad 3|4)    {len(conflict)}")

    by_url = {}
    for row in conflict:
        key = row[COL["SOURCEURL"]] or f"evt:{row[COL['GlobalEventID']]}"
        by_url.setdefault(key, row)
    deduped = list(by_url.values())
    print(f"after source_url dedup      {len(deduped)}   "
          f"({len(conflict) - len(deduped)} collapsed, i.e. rows lost to one-row-per-article)")

    # The same dedup keyed on (article, place) instead of article alone. One
    # article reporting three separate incidents currently contributes one row;
    # this measures how much recall that costs.
    by_url_place = {}
    for row in conflict:
        key = (row[COL["SOURCEURL"]] or f"evt:{row[COL['GlobalEventID']]}",
               row[COL["ActionGeo_FeatureID"]])
        by_url_place.setdefault(key, row)
    print(f"if deduped by (url, place)  {len(by_url_place)}   "
          f"(+{len(by_url_place) - len(deduped)} rows recovered)")

    violent = [r for r in deduped if _is_violent(r)]
    violent_by_place = [r for r in by_url_place.values() if _is_violent(r)]
    root_ok = [r for r in deduped
               if r[COL["EventRootCode"]].isdigit() and int(r[COL["EventRootCode"]]) in VIOLENCE_ROOT_CODES]
    print(f"violence-typed (root 18/19/20) {len(root_ok)}")
    print(f"passing full violence gate     {len(violent)}   "
          f"({100.0 * len(violent) / max(len(deduped), 1):.1f}% of conflict rows)")
    print(f"  same, with (url, place) dedup  {len(violent_by_place)}"
          f"  (+{len(violent_by_place) - len(violent)})")

    # THE number Stage 7 exists for. gdelt.py serves the top NEWS_MAX_ITEMS rows by
    # NumMentions, and event_fusion reads that served list -- so a violent row
    # outside the cut is deleted by a popularity ranking before the violence
    # gate ever runs. This measures how many are lost that way.
    ranked = sorted(deduped, key=lambda r: int(r[COL["NumMentions"]] or 0), reverse=True)
    survivors = {id(r) for r in ranked[:gdelt.NEWS_MAX_ITEMS]}
    kept = [r for r in violent if id(r) in survivors]
    lost = len(violent) - len(kept)
    print(f"\n  >>> violent rows surviving the top-{gdelt.NEWS_MAX_ITEMS}-by-mentions cut: "
          f"{len(kept)}/{len(violent)}")
    print(f"  >>> violent rows DELETED by the news ranking:                 {lost}"
          f"  ({100.0 * lost / max(len(violent), 1):.0f}%)")
    if lost:
        worst = sorted(
            (r for r in violent if id(r) not in survivors),
            key=lambda r: int(r[COL["NumMentions"]] or 0),
        )[:5]
        print("      examples currently being discarded:")
        for r in worst:
            print(f"        {r[COL['NumMentions']]:>3} mentions  {r[COL['EventCode']]:<5} "
                  f"{r[COL['ActionGeo_FullName']][:52]}")

    hours = max(len(rows) and (len(rows) / 7852.0) * 2.0, 1)
    print(f"\nimplied violent rows/day       ~{len(violent) / hours * 24:.0f}"
          f"  (extrapolated from a {hours:.1f}h window)")

    # --- geographic precision ------------------------------------------------
    print("\nActionGeo_Type -- all conflict rows")
    geo_all = collections.Counter(
        GEO_TYPE_NAME.get(int(r[COL["ActionGeo_Type"]]), r[COL["ActionGeo_Type"]])
        if r[COL["ActionGeo_Type"]].isdigit() else "(blank)"
        for r in deduped
    )
    print("\n".join(_histogram(geo_all, len(deduped))))

    print("\nActionGeo_Type -- rows passing the violence gate  <-- the number that matters")
    geo_violent = collections.Counter(
        GEO_TYPE_NAME.get(int(r[COL["ActionGeo_Type"]]), r[COL["ActionGeo_Type"]])
        if r[COL["ActionGeo_Type"]].isdigit() else "(blank)"
        for r in violent
    )
    print("\n".join(_histogram(geo_violent, len(violent))))

    with_feature = sum(1 for r in violent if r[COL["ActionGeo_FeatureID"]].strip())
    print(f"\n  violent rows carrying a FeatureID   {with_feature}/{len(violent)}"
          f"  ({100.0 * with_feature / max(len(violent), 1):.0f}%)  <-- Stage 5 pre-key coverage")

    # --- CAMEO mix -----------------------------------------------------------
    print("\nEventRootCode -- conflict rows")
    print("\n".join(_histogram(collections.Counter(r[COL["EventRootCode"]] for r in deduped), len(deduped), 12)))

    print("\nEventCode -- violent rows only (drives the Stage 2 label table)")
    print("\n".join(_histogram(collections.Counter(r[COL["EventCode"]] for r in violent), len(violent), 20)))

    # --- outlet counts -------------------------------------------------------
    def nums(rows_in, col):
        out = []
        for r in rows_in:
            try:
                out.append(float(r[COL[col]]))
            except (ValueError, IndexError):
                pass
        return out

    print("\nOutlet/reach percentiles -- violent rows (drives the Stage 4 severity curve)")
    for col in ("NumMentions", "NumSources", "NumArticles"):
        print(_percentiles(nums(violent, col), col))
    print(_percentiles([abs(v) for v in nums(violent, "GoldsteinScale")], "|Goldstein|"))

    single = sum(1 for r in violent
                 if r[COL["NumSources"]].isdigit() and int(r[COL["NumSources"]]) <= 1)
    print(f"\n  single-outlet violent rows  {single}/{len(violent)}"
          f"  ({100.0 * single / max(len(violent), 1):.0f}%)  <-- what the confidence discount must catch")

    root_events = sum(1 for r in violent if r[COL["IsRootEvent"]] == "1")
    print(f"  IsRootEvent == 1            {root_events}/{len(violent)}")

    # --- date semantics ------------------------------------------------------
    lags = []
    for r in violent:
        try:
            sql = datetime.strptime(r[COL["SQLDATE"]], "%Y%m%d").replace(tzinfo=timezone.utc)
            added = datetime.strptime(r[COL["DATEADDED"]][:8], "%Y%m%d").replace(tzinfo=timezone.utc)
        except (ValueError, IndexError):
            continue
        lags.append((added - sql).days)
    if lags:
        buckets = collections.Counter(
            "same day" if d == 0 else "1-3 days" if d <= 3 else "4-30 days" if d <= 30 else ">30 days (retrospective)"
            for d in lags
        )
        print("\nDATEADDED minus SQLDATE -- report lag on violent rows")
        print("\n".join(_histogram(buckets, len(lags))))
        print(f"  mean {statistics.fmean(lags):.1f}d   median {statistics.median(lags):.0f}d   max {max(lags)}d")
        over = sum(1 for d in lags if d > 30)
        print(f"  would be dropped by _MAX_REPORT_LAG_DAYS=30:  {over}"
              f"  ({100.0 * over / len(lags):.1f}%)")

    # --- sanity check on the indices ----------------------------------------
    print("\nColumn sanity -- a sample violent row, decoded")
    if violent:
        sample = violent[0]
        for name in ("GlobalEventID", "SQLDATE", "Actor1Name", "Actor1Type1Code", "Actor2Name",
                     "Actor2Type1Code", "EventCode", "EventRootCode", "QuadClass", "NumMentions",
                     "NumSources", "NumArticles", "ActionGeo_Type", "ActionGeo_FullName",
                     "ActionGeo_FeatureID", "DATEADDED", "SOURCEURL"):
            print(f"  {name:<22} {sample[COL[name]][:70]!r}")
    print()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window-minutes", type=int, default=gdelt.WINDOW_MINUTES)
    args = parser.parse_args()
    rows, label = await _fetch_raw_window(args.window_minutes)
    _report(rows, label, args.window_minutes / 60.0)


if __name__ == "__main__":
    asyncio.run(main())
