"""One-shot ACLED scrape: pull the last day of events and write a CSV.

Run: python -m backend.scripts.scrape_acled_daily [--days N]

Reuses the OAuth token + query logic from backend/sources/acled.py rather
than reimplementing it -- same auth flow, same field set.
"""
import argparse
import asyncio
import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from backend import config
from backend.sources.acled import _get_token, _parse_acled_rows, _query_acled

OUT_DIR = config.DATA_DIR / "acled_daily"

FIELDS = [
    "id", "date", "event_type", "sub_event_type", "actor1", "actor2",
    "fatalities", "country", "lat", "lon", "notes",
]


async def scrape(days: int) -> Path:
    if not (config.ACLED_EMAIL and config.ACLED_PASSWORD):
        raise SystemExit("ACLED_EMAIL / ACLED_PASSWORD not set in .env")

    today = datetime.now(timezone.utc).date()
    until = today
    since = until - timedelta(days=days)

    async with httpx.AsyncClient(timeout=30) as client:
        token = await _get_token(client)
        payload = await _query_acled(client, token, since, until)

        # Research-tier accounts are embargoed from recent months; ACLED
        # reports the actual allowed cutoff in the response itself, so shift
        # the window there instead of silently returning 0 rows.
        restriction = (payload.get("data_query_restrictions") or {}).get("date_recency") or {}
        cutoff_str = restriction.get("date")
        if cutoff_str:
            cutoff = datetime.fromisoformat(cutoff_str).date()
            print(f"account embargoed -- shifting window to end at {cutoff}")
            until = cutoff
            since = until - timedelta(days=days)
            payload = await _query_acled(client, token, since, until)

    items = _parse_acled_rows(payload)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{until.isoformat()}.csv"
    with out_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(items)

    print(f"{len(items)} events -> {out_path}")
    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=1, help="lookback window in days (default 1)")
    args = parser.parse_args()
    asyncio.run(scrape(args.days))
