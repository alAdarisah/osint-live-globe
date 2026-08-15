# Postgres read replica — operator notes

A physical streaming standby (`postgres-replica` in `docker-compose.yml`) from
[docs/plans/2026-08-09-read-replica.md](../../docs/plans/2026-08-09-read-replica.md).
It is a hot, always-current second copy and the home for heavy lag-tolerant reads.

What routes to it today, all inside the `refine` process and all falling back to
the primary when no standby is open:

- the dark-vessel detector's three reads (`backend/sources/dark_vessels.py`),
  including the position-gap self-join over `entity_history`
- the airfield activity aggregate (`backend/sources/airfield_activity.py`)
- escalation's per-region scans (`backend/escalation.py`)
- the backup COPY (`ops/backup/pg_backup.py`, which prefers `localhost:5433`)

What never routes to it: every write, `kind_watermark`, the mirror's serve read,
the `NOTIFY` listener, and anything in the request path. See the plan's "two
landmines" for why — the short version is that `NOTIFY` does not reach a replica
and a lagging replica split from the watermark serves stale data as fresh.

## Two ways in, depending on the volume

### A. Fresh stack (empty `pgdata`)

Everything is automatic. On first `docker compose up`:

1. The primary runs `initdb/10-replication.sh` once — creates the `replicator`
   role, the physical slot `standby_1`, and the replication `pg_hba` line.
2. `postgres-replica` waits for the primary to be healthy, then `pg_basebackup`
   seeds `pgdata-replica` and starts streaming.

Nothing else to do. Skip to **Verify** below.

### B. Existing populated volume (our case — the 13 GB `pgdata`)

The init script does **not** run on a populated data directory, so create the
role, slot, and pg_hba line by hand **once**, against the running primary,
before starting the replica.

```bash
# 1. Bring up just the primary with the new flags (safe on the existing volume;
#    wal_level=replica / max_wal_senders are already the PG16 defaults).
docker compose up -d postgres

# 2. Create the replication role and the physical slot.
docker compose exec postgres psql -U osint -d osint -c \
  "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';"
docker compose exec postgres psql -U osint -d osint -c \
  "SELECT pg_create_physical_replication_slot('standby_1');"

# 3. Allow replication in pg_hba, then reload (no restart needed).
docker compose exec postgres sh -c \
  "grep -q 'host replication replicator' \"\$PGDATA/pg_hba.conf\" || \
   echo 'host replication replicator 0.0.0.0/0 scram-sha-256' >> \"\$PGDATA/pg_hba.conf\""
docker compose exec postgres psql -U osint -d osint -c "SELECT pg_reload_conf();"

# 4. Now start the replica; it will pg_basebackup from the primary and stream.
docker compose up -d postgres-replica
```

Use the same password here as `REPLICATION_PASSWORD` in the environment
(default `replicator`); the replica authenticates with it via `PGPASSWORD`.

## Verify (not just "the container is up")

```bash
# On the primary: the standby should show up, streaming, with small lag.
docker compose exec postgres psql -U osint -d osint -c \
  "SELECT client_addr, state, sync_state, \
          pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes \
   FROM pg_stat_replication;"

# On the replica: must be in recovery, and lag as a duration.
docker compose exec postgres-replica psql -U osint -d osint -c "SELECT pg_is_in_recovery();"          # -> t
docker compose exec postgres-replica psql -U osint -d osint -c "SELECT now() - pg_last_xact_replay_timestamp();"

# End-to-end: write on primary, read on replica within lag.
docker compose exec postgres psql -U osint -d osint -c \
  "CREATE TABLE IF NOT EXISTS repl_check(t timestamptz); INSERT INTO repl_check VALUES (now());"
docker compose exec postgres-replica psql -U osint -d osint -c "SELECT max(t) FROM repl_check;"

# Guardrail: a write on the replica must fail read-only.
docker compose exec postgres-replica psql -U osint -d osint -c "INSERT INTO repl_check VALUES (now());"
#   -> ERROR: cannot execute INSERT in a read-only transaction
```

## The one sharp edge: the replication slot and WAL

The physical slot `standby_1` guarantees the primary keeps WAL the standby still
needs — which also means **a long-dead standby makes the primary hoard WAL until
the disk fills.** If you retire the replica, drop the slot:

```bash
docker compose exec postgres psql -U osint -d osint -c "SELECT pg_drop_replication_slot('standby_1');"
```

Watch slot lag so a stalled standby is visible before it hurts:

```bash
docker compose exec postgres psql -U osint -d osint -c \
  "SELECT slot_name, active, \
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal \
   FROM pg_replication_slots;"
```

## Scope and cautions

- **Failover is manual.** This is a warm copy to promote (`SELECT pg_promote();`
  on the replica, then repoint `DATABASE_URL`), not automatic HA. No
  Patroni/repmgr — the right scope for a single-host compose stack.
- **Default password is weak** (`replicator`). Fine while 5432/5433 are bound to
  `127.0.0.1`. Set `REPLICATION_PASSWORD` in `.env` before exposing this host to
  anything else, and rotate the role password on the primary to match.
- **Disk:** a full second copy of the data (~13 GB now, growing with the same
  3-day `entity_history` retention).
