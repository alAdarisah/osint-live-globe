"""Full data backup of the OSINT Postgres DB via COPY -> gzipped CSV.

Phase 3 of docs/plans/2026-08-09-read-replica.md: this reads from the **read
replica** by default, so the 13 GB COPY scan runs off the write-heavy primary.
If the replica is not reachable it falls back to the primary and says so -- a
backup must never be skipped just because the standby is down.

No pg_dump/docker required: it uses the native COPY protocol through asyncpg,
which works identically against a read-only replica.

Source selection (first that is set / reachable wins):
  1. $BACKUP_SOURCE_URL   -- explicit override, no fallback
  2. $READ_REPLICA_URL    -- the standby, e.g. postgresql://osint:osint@localhost:5433/osint
  3. the default replica DSN (localhost:5433), then the primary (localhost:5432)
Set $BACKUP_DIR to change where it writes (default: a timestamped folder in the
sibling OSINT-backups/ directory, kept out of the git repo).

Produces, per run:
  01_tables.sql / 02_constraints_indexes.sql  -- reconstructed schema DDL
  data/<table>.csv.gz                          -- CSV with header, gzip level 6
  storage_source.py                            -- a copy of backend/storage.py
  MANIFEST.txt / RESTORE.md
Restore with psql \\copy into a matching schema (see RESTORE.md).
"""
import asyncio
import datetime
import gzip
import os
import pathlib
import shutil

import asyncpg

REPO = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_REPLICA = "postgresql://osint:osint@localhost:5433/osint"
DEFAULT_PRIMARY = os.getenv("DATABASE_URL", "postgresql://osint:osint@localhost:5432/osint")
STAMP = datetime.datetime.now().strftime("%Y-%m-%d_%H%M%S")
OUT = pathlib.Path(
    os.getenv("BACKUP_DIR", str(REPO.parent / "OSINT-backups" / STAMP))
)


def _redact(dsn: str) -> str:
    if "://" not in dsn or "@" not in dsn:
        return dsn
    scheme, rest = dsn.split("://", 1)
    auth, tail = rest.split("@", 1)
    return f"{scheme}://{auth.split(':', 1)[0]}@{tail}"


def human(n: int) -> str:
    x = float(n)
    for u in ("B", "KB", "MB", "GB", "TB"):
        if x < 1024:
            return f"{x:.1f} {u}"
        x /= 1024
    return f"{x:.1f} PB"


async def _connect():
    """Connect to the replica if we can, else the primary. Returns
    (connection, dsn, is_replica)."""
    override = os.getenv("BACKUP_SOURCE_URL")
    if override:
        conn = await asyncpg.connect(override)
        in_recovery = await conn.fetchval("SELECT pg_is_in_recovery()")
        return conn, override, bool(in_recovery)

    replica = os.getenv("READ_REPLICA_URL") or DEFAULT_REPLICA
    candidates = [(replica, "replica"), (DEFAULT_PRIMARY, "primary")]
    last_error = None
    for dsn, label in candidates:
        try:
            conn = await asyncpg.connect(dsn)
            in_recovery = await conn.fetchval("SELECT pg_is_in_recovery()")
            print(f"backing up from {label} ({_redact(dsn)}), in_recovery={in_recovery}", flush=True)
            return conn, dsn, bool(in_recovery)
        except Exception as exc:  # noqa: BLE001 - try the next source
            last_error = exc
            print(f"{label} unreachable ({_redact(dsn)}): {exc}", flush=True)
    raise SystemExit(f"no backup source reachable; last error: {last_error}")


async def build_schema_sql(conn) -> tuple[str, str]:
    cols = await conn.fetch(
        """
        select c.relname as tbl, a.attname as col,
               format_type(a.atttypid, a.atttypmod) as typ,
               a.attnotnull as notnull,
               pg_get_expr(d.adbin, d.adrelid) as dflt
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where n.nspname = 'public' and c.relkind = 'r'
              and a.attnum > 0 and not a.attisdropped
        order by c.relname, a.attnum
        """
    )
    tables: dict[str, list[str]] = {}
    for r in cols:
        line = f'    "{r["col"]}" {r["typ"]}'
        if r["dflt"]:
            line += f' default {r["dflt"]}'
        if r["notnull"]:
            line += " not null"
        tables.setdefault(r["tbl"], []).append(line)

    tables_sql = ["-- Tables (columns only; constraints/indexes in 02_*.sql)\n"]
    for t, lines in tables.items():
        tables_sql.append(f'create table if not exists "{t}" (\n' + ",\n".join(lines) + "\n);\n")

    cons = await conn.fetch(
        """
        select conrelid::regclass::text as tbl, conname,
               pg_get_constraintdef(oid) as def,
               case when conindid <> 0 then conindid::regclass::text else null end as idxname
        from pg_constraint
        where connamespace = 'public'::regnamespace
        order by conrelid::regclass::text, conname
        """
    )
    constraint_index_names = {c["idxname"] for c in cons if c["idxname"]}
    ci_sql = ["-- Constraints\n"]
    for c in cons:
        ci_sql.append(f'alter table "{c["tbl"]}" add constraint "{c["conname"]}" {c["def"]};\n')

    idx = await conn.fetch(
        "select indexname, indexdef from pg_indexes where schemaname='public' order by tablename, indexname"
    )
    ci_sql.append("\n-- Indexes\n")
    for i in idx:
        if i["indexname"] in constraint_index_names:
            continue
        ci_sql.append(i["indexdef"] + ";\n")

    return "\n".join(tables_sql), "\n".join(ci_sql)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "data").mkdir(exist_ok=True)
    conn, dsn, is_replica = await _connect()
    print(f"writing to {OUT}", flush=True)

    tables = [r["tablename"] for r in await conn.fetch(
        "select tablename from pg_tables where schemaname='public' order by tablename"
    )]

    tables_sql, ci_sql = await build_schema_sql(conn)
    (OUT / "01_tables.sql").write_text(tables_sql, encoding="utf-8")
    (OUT / "02_constraints_indexes.sql").write_text(ci_sql, encoding="utf-8")

    src = REPO / "backend" / "storage.py"
    if src.exists():
        shutil.copy2(src, OUT / "storage_source.py")

    manifest = [
        f"OSINT Postgres backup  {STAMP}",
        f"source: {'replica' if is_replica else 'primary'} ({_redact(dsn)})",
        "",
    ]
    total_bytes = 0
    for t in tables:
        rows = await conn.fetchval(f'select count(*) from "{t}"')
        dest = OUT / "data" / f"{t}.csv.gz"
        print(f"[{t}] {rows} rows -> {dest.name} ...", flush=True)
        gz = gzip.open(dest, "wb", compresslevel=6)
        try:
            async def sink(data, _gz=gz):
                _gz.write(data)
            await conn.copy_from_table(t, output=sink, format="csv", header=True)
        finally:
            gz.close()
        b = dest.stat().st_size
        total_bytes += b
        manifest.append(f"{t}\t{rows} rows\t{human(b)} gz")
        print(f"[{t}] done  {human(b)} gz", flush=True)

    manifest.append("")
    manifest.append(f"TOTAL gz: {human(total_bytes)}")
    (OUT / "MANIFEST.txt").write_text("\n".join(manifest), encoding="utf-8")

    (OUT / "RESTORE.md").write_text(
        f"""# Restore

Backup {STAMP}, taken from the {'replica' if is_replica else 'primary'}. CSV COPY
format, gzip. Restores into a matching empty Postgres DB.

1. Load schema (tables first): `psql "$DATABASE_URL" -f 01_tables.sql`
2. Load each table: `gunzip -c data/<t>.csv.gz | psql "$DATABASE_URL" -c "\\copy <t> from stdin with (format csv, header true)"`
3. Apply constraints + indexes last: `psql "$DATABASE_URL" -f 02_constraints_indexes.sql`

`storage_source.py` is the authoritative schema if you prefer to let the app
create the tables and only load the CSV data.
""",
        encoding="utf-8",
    )
    await conn.close()
    print(f"BACKUP COMPLETE  total {human(total_bytes)} gz  at {OUT}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
