# `data/` — what is in here and where it came from

Almost nothing in this directory is read by the running app. That is the point
of writing it down: without a note like this, a 1.5 GB file beside a live config
file is indistinguishable from a live config file, and the safe move becomes
"touch nothing", forever.

Everything the app *collects* lives in Postgres (volume `osint_pgdata`, six
tables — see the Persistence section of the root README). This directory holds
one piece of live state, plus archives and manual snapshots kept for reference.

The whole directory is gitignored except this file.

| Path | What it is | Where it came from | Captured | Read by the app? | Reproducible? |
|---|---|---|---|---|---|
| `admin_config.json` | **Live state.** Admin Mode's saved configuration | written by `backend/admin_config.py` | continuously | **yes** — every client reads it at startup | **no** — this is the one file here that cannot be regenerated |
| `archive/positions-2026-08-06.db.gz` | The legacy SQLite store, gzipped | the pre-Postgres storage layer | collection window 2026-08-02 → 2026-08-04 | no | no, but see below |
| `snapshots/acled/acled_2025-08-03_2025-08-04.csv` | 1,941 ACLED events | `python -m backend.scripts.scrape_acled_daily` | run 2026-08-04 | no | yes, re-run the script |
| `snapshots/acled/acled_2025-06-30_2025-07-04.csv` | 2,000 ACLED events — exactly the API page cap, so assume it is truncated | same script, embargo-shifted window | run 2026-08-04 | no | yes, re-run the script |
| `snapshots/hdx/hdx_political-violence-events-and-fatalities_2026-08-04.xlsx` | HDX's aggregate ACLED workbook, 43 MB | manual download of the URL in `backend/sources/hdx_conflict_stats.py` | 2026-08-04 | no — the source fetches this URL into memory each poll and never looks at disk | yes, it is a public URL |
| `logs/backend-uvicorn_2026-08-04.log` | A backend run log | a `python -m backend.app` session before the stack moved to Compose | 2026-08-04, 11:22–11:33 | no | no |

## About the SQLite archive

It holds 4,421,607 `entity_history` rows (ADS-B and AIS only, 2026-08-02 →
2026-08-04), 19,669 `entity_latest` rows, and 873 `conflict_watch_events` dated
2026-06-27 → 2026-08-04.

**The conflict rows are already in Postgres.** They were imported on 2026-08-06
with `python -m backend.migrate_sqlite_to_postgres --conflict-only`, and they
carry `pipeline_version IS NULL`, which is how you find them:

```sql
SELECT count(*), min(date), max(date) FROM conflict_events WHERE pipeline_version IS NULL;
```

That NULL is also load-bearing — `backend/escalation.py` filters on an exact
pipeline version, so this archive is queryable without ever being counted as
present-day escalation.

The movement history was **not** imported and should not be: it is older than
`HISTORY_RETENTION_SECONDS` (3 days), so the retention sweep would delete it
within ten minutes of arrival. It is kept here instead, compressed, because it
is the only surviving record of those two days.

To read it without unpacking the whole thing:

```bash
gunzip -c data/archive/positions-2026-08-06.db.gz > /tmp/positions.db && sqlite3 /tmp/positions.db
```

## Adding to this directory

If you put a file here, add a row above. A file whose origin has to be guessed
is not evidence — it is clutter with a plausible filename. Snapshot names carry
the window of the data, not the date of the run: `scrape_acled_daily.py` used to
name files after the run date, and under ACLED's Research-tier embargo that
produced `2026-08-04.csv` containing events from June 2025.
