# Read replica — separating heavy reads from the write path

Date: 2026-08-09. Branch base: `UI`. Status (2026-08-11): **Phases 1–3 live on the local WSL stack** — the standby streams with zero lag and `refine` reads from it. **Not yet on the server**, which has no `postgres-replica` container and no replication role or slot; see the handover at the end of §2. Written against the code as it stands today; every claim about what exists was checked in the tree.

The ask was "build me a read replica, to separate reads and writes, make things more efficient and safer." This document is the honest answer to what that buys here, what it must *not* touch, and exactly how to build it if we go ahead.

---

## 0. What the codebase already does with reads and writes

Read this first. The headline is that **the read/write separation the request is reaching for already exists — at the application layer, not the database.** A physical replica adds two specific things on top of it, and breaks two things if pointed at the wrong path.

### The serve path barely touches Postgres for reads

- `backend/mirror.py` is the backend's read side for everything `ingest`/`refine` collect. It does **not** re-read on a timer. Each pass reads one indexed row — `max(updated_at)` for the kind via `storage.kind_watermark` (`storage.py:728`) — and only reads the payload when that watermark moves (`mirror.py:157-197`).
- In front of that sits Redis as a read-through cache (`docker-compose.yml:90`, `backend/cachestore.py`), keyed by the same watermark, `allkeys-lru`, explicitly "safe to lose entirely" (`docker-compose.yml:86-89`).
- So a map request is answered from in-memory registry state that Redis backs; Postgres is consulted only on the comparatively rare watermark change. **A read replica will not make the map faster — Redis already owns the serve path.** Anyone who justifies the replica as "speed up the API" is wrong about this stack.

### Everything that writes, writes to the one Postgres

- Backend keyless pollers (`_SOURCE_MODULES` in `app.py`, now including the Digitraffic modules) write via `storage.record_snapshot` (`storage.py:397`).
- `ingest` writes the credentialed sources; `refine` reads stored rows and writes derived ones (`docker-compose.yml:112`, `:142`).
- Single connection pool, single `DATABASE_URL`, initialised in `storage.init_pool` (`storage.py:237`). **No read/replica split exists today** — grep for `READ_DATABASE_URL`/`REPLICA`/`read_pool` returns nothing.
- The write pressure that actually matters is `entity_history`: append-only, ~13 GB, 15.1M rows, 3-day retention (`config.py:342`), driven by AIS movement. This is what a long read query contends with.

### The two landmines — why the live path must stay on the primary

1. **`LISTEN`/`NOTIFY` does not propagate to physical replicas.** Every write here fires `pg_notify` *inside the writing transaction* (`storage.py:71` defines the channel; notifies at `storage.py:446`, `:549`, `:1282`). The mirror holds one connection open on that channel and wakes within milliseconds of a commit (`mirror.py:218-253`, `:232-233`). Point the mirror's listener at a replica and it goes **deaf** — no notifications arrive, and it silently degrades to the `INGEST_MIRROR_INTERVAL` fallback tick (`mirror.py:265`). Ship positions would lag by up to a full interval instead of being live. **The mirror listener and watermark read stay on the primary.**

2. **Read-your-writes on the watermark gate.** The mirror reads `max(updated_at)`, then reads the payload, then caches that payload *keyed by the watermark it just read* (`mirror.py:175-196`). If the watermark comes from the primary and the payload from a replica that is lagging, the cache stores a **stale payload under a fresh-looking watermark** — and because the watermark now matches, it is served as current and never re-read until the next change. That is silent stale data, the worst failure mode this codebase already goes out of its way to avoid (`mirror.py:9-29`). **The watermark + payload read must come from the same node; for the serve path that node is the primary.**

**Conclusion:** route to a replica only readers that (a) issue no writes, (b) do not depend on `NOTIFY`, and (c) tolerate seconds of lag. Everything driving the live map, and every writer, stays on the primary. A physical standby is read-only, so any accidental write routed to it fails loud rather than corrupting anything — a useful guardrail, not a substitute for getting the routing right.

---

## 1. What the replica actually buys — the two real wins

Both map the original words: *safer* and *more efficient*.

- **Safer — a hot, always-current second copy + failover.** The cold backup taken today (`OSINT-backups/2026-08-09_125758/`, 1.2 GB gz) is a point-in-time snapshot that is stale the moment it finishes. A streaming standby is continuously current and can be promoted to primary if `pgdata` is lost or corrupted. For a system that has accumulated 15M history rows nobody wants to re-collect, that is the strongest single reason to do this.
- **More efficient — heavy background reads move off the write-heavy primary.** The readers that genuinely contend with the AIS append stream today are: the 13 GB backup COPY, `postgres-exporter`'s stat scraping (`docker-compose.yml:204`), `refine`'s bulk fusion reads, and any future analytics. Moving those to the standby leaves the primary doing writes + the cheap watermark reads. That is the real throughput win — not the map.

If neither of those matters to you yet, the honest call is *don't build it* — the app-layer separation already covers the common case. Build it when you want durability/failover, or when `refine`/backups/monitoring start visibly competing with writes (watch `pg_stat_activity` wait events and replication of the Grafana Postgres panel).

---

## 2. Build plan

Three phases, each independently revertible. Phase 1 stands alone (you get the safety win with zero app changes). Phases 2–3 add the efficiency win.

### Phase 1 — a streaming standby in the compose stack

Goal: a second Postgres that continuously replicates the primary, seeded once via `pg_basebackup`, using a physical replication slot so the primary never purges WAL the standby still needs.

**Primary changes (`postgres` service, `docker-compose.yml:18`):**

```yaml
  postgres:
    image: postgres:16-alpine
    command:
      - postgres
      - -c
      - wal_level=replica            # default in PG16, set explicitly so it is not a surprise
      - -c
      - max_wal_senders=10
      - -c
      - max_replication_slots=10
      - -c
      - hot_standby=on
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-osint}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-osint}
      POSTGRES_DB: ${POSTGRES_DB:-osint}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./ops/postgres/initdb:/docker-entrypoint-initdb.d:ro   # NEW: creates the replication role
    # ...healthcheck/ports/restart unchanged...
```

`ops/postgres/initdb/10-replication.sql` (runs once, only on a fresh `pgdata`):

```sql
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator';
SELECT pg_create_physical_replication_slot('standby_1');
```

Replication connections also need a `pg_hba.conf` line. The official image trusts nothing for `replication` by default, so append one via a small mounted `pg_hba` or an init step. Simplest inside a private compose network:

```
host replication replicator 0.0.0.0/0 scram-sha-256
```

> **Note on an existing `pgdata`.** The init scripts and the slot creation only run on an empty data directory. Our primary already has 13 GB in `pgdata`, so `10-replication.sql` will **not** auto-run — create the role and the slot once by hand against the live DB (`CREATE ROLE …; SELECT pg_create_physical_replication_slot('standby_1');`) and add the `pg_hba` line with a reload. Document this as a one-time manual step; don't pretend the init script covers a populated volume.

**New `postgres-replica` service:**

```yaml
  postgres-replica:
    image: postgres:16-alpine
    user: postgres
    environment:
      PGPASSWORD: replicator
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - pgdata-replica:/var/lib/postgresql/data
    entrypoint:
      - /bin/sh
      - -c
      - |
        if [ ! -s "$$PGDATA/PG_VERSION" ]; then
          rm -rf "$$PGDATA"/*
          pg_basebackup -h postgres -U replicator -D "$$PGDATA" \
            -Fp -Xs -P -R -S standby_1
        fi
        exec postgres -c hot_standby=on
    ports:
      - "127.0.0.1:5433:5432"   # host access for backups/psql, mirrors the primary's 5432
    restart: unless-stopped
```

`pg_basebackup -R` writes `standby.signal` + `primary_conninfo` into the standby's data dir, so it comes up as a read-only hot standby streaming from the slot. `PGDATA` for `postgres:16-alpine` is `/var/lib/postgresql/data`.

**Verify replication is live** (not "the container is up"):

```sql
-- on primary
SELECT client_addr, state, sync_state,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes
FROM pg_stat_replication;
-- on replica
SELECT pg_is_in_recovery();                         -- must be true
SELECT now() - pg_last_xact_replay_timestamp();     -- lag as a duration
```

Simpler alternative if the hand-rolled entrypoint is more fuss than it's worth: `bitnami/postgresql:16` exposes `POSTGRESQL_REPLICATION_MODE=master|slave` env and does all of the above for you. The cost is swapping the image on the primary too. Given the stack has no PostGIS and no custom primary image, that swap is low-risk — worth considering if we actually build this.

### Phase 2 — a read pool that falls back to the primary

Goal: application code can ask for a read connection that *prefers* the replica but never breaks when the replica is absent or down.

**`config.py`:**

```python
# Optional physical read replica. Unset -> reads go to the primary, i.e. today's
# behaviour exactly. Set to the standby's DSN to offload lag-tolerant heavy reads.
READ_REPLICA_URL = os.getenv("READ_REPLICA_URL", "").strip() or None
```

**`storage.py`** (alongside `init_pool`/`get_pool` at `:237`):

```python
_read_pool = None

async def init_read_pool(...):
    # Only if READ_REPLICA_URL is set AND reachable. On any failure, log and
    # leave _read_pool None so get_read_pool() falls back to the primary.
    ...

def get_read_pool():
    """Pool for lag-tolerant, read-only queries. Falls back to the primary
    pool when no replica is configured or the replica pool failed to open."""
    return _read_pool or get_pool()
```

Guardrails that make this safe:
- `get_read_pool()` is **only** for read-only queries whose caller tolerates lag. It is never used by `record_*`, by `kind_watermark`, or by the mirror serve read.
- The replica is physically read-only, so if a write is ever routed there by mistake it raises `cannot execute … in a read-only transaction` — loud, not silent.
- Fallback means the replica is purely additive: `docker compose stop postgres-replica` degrades to exactly today's behaviour, the same property Redis already has.

### Phase 3 — route only the safe consumers

- **Backups.** Point the backup script's DSN at the replica (`localhost:5433`). This is the biggest immediate win: the 13 GB COPY stops competing with the AIS write stream, and a slightly-lagging snapshot is completely acceptable for a backup.
- **`postgres-exporter`** (`docker-compose.yml:204`). Point `DATA_SOURCE_NAME` at the replica. Caveat: some `pg_stat_*` views describe the *local* node, so a handful of Grafana panels then report the replica's numbers, not the primary's — decide per panel whether that is what you want, or run a second exporter so you can see both. (Replication lag itself becomes a panel worth adding.)
- **`refine`** (optional; this was the "route refine too" scope). Move only its heavy, lag-tolerant bulk reads to `get_read_pool()`. Its writes stay on the primary. Requires confirming the fusion logic never does read-then-write-assuming-freshness across the two nodes; if any step needs read-your-writes, that step stays on the primary. This is the one phase that needs a careful read of `backend/refine` before flipping.

**Never routed to the replica:** all `record_*` writes; `kind_watermark` and the mirror serve read (`mirror.py:157-197`); the `NOTIFY` listener (`mirror.py:218`); anything in the request path.

### Handover — bringing this up on the server (not done yet)

The server (`root@37.27.38.223`, `/opt/osint`) is still a single-Postgres stack: no `postgres-replica` container, no `replicator` role, no `standby_1` slot. Its database is 2.1 GB against 63 GB free, so disk is not a constraint. Its `postgres` already runs `wal_level=replica`, `max_wal_senders=10`, `max_replication_slots=10` — the PG16 defaults — so **no primary restart is needed** to start replicating.

Order matters: the compose file has to be on the server before the standby can be started, and the role and slot have to exist before the standby's `pg_basebackup` can authenticate. Do not create the slot until the standby will actually be started — an inactive slot makes the primary retain WAL forever.

1. Ship the code and the new compose file: `"Deploy Code to Server.bat"`. This rebuilds backend, frontend, refine and cache-worker, so the public map restarts for a few seconds. It does **not** rebuild `ingest`, so no metered source is re-polled. Note it also does not sync `ops/` or `monitoring/` — copy `monitoring/prometheus/prometheus.yml` and `monitoring/postgres-exporter/queries.yaml` by hand for the replication-lag metrics, and `ops/postgres/initdb/` if the server's `pgdata` might ever be recreated from empty.
2. Set a real replication password rather than shipping the default `replicator`:
   `openssl rand -hex 24`, then add `REPLICATION_PASSWORD=<that>` to `/opt/osint/.env`.
3. Create the role, the slot and the `pg_hba` line against the live primary — the populated-volume path in [ops/postgres/README.md](../../ops/postgres/README.md), using the password from step 2.
4. `docker compose up -d postgres-replica postgres-exporter-replica`, then `docker compose restart prometheus` if the monitoring files were copied.
5. Verify with the queries in that README — `pg_stat_replication` must show `streaming`, and `docker compose logs refine | grep replica` must say "Read replica pool ready". `refine` retries for ten minutes after boot, so if it started before the standby finished seeding, restart it.

---

## 3. Operational notes

- **Lag monitoring is mandatory.** Add a Grafana panel for `pg_last_xact_replay_timestamp` age and `pg_stat_replication.replay_lag`. A replica that silently falls hours behind turns "acceptable lag" into "wrong data" for whatever reads it.
- **WAL retention.** The physical slot (`standby_1`) guarantees the primary keeps WAL for the standby — which also means a **long-dead standby will grow the primary's WAL until the disk fills.** If the standby is decommissioned, drop the slot: `SELECT pg_drop_replication_slot('standby_1');`. This is the sharp edge of using a slot; the alternative (`wal_keep_size`) risks the opposite failure (standby falls off the end of retained WAL and needs re-seeding).
- **Failover is manual here.** Promotion is `pg_ctl promote` (or `SELECT pg_promote()`), then repoint `DATABASE_URL`. This plan gives you a warm copy to promote; it is not automatic HA (no Patroni/repmgr). That is the right scope for a single-host compose stack — say so rather than implying auto-failover.
- **Disk.** A second full copy of `pgdata` — budget ~13 GB now and growing with the same retention. New named volume `pgdata-replica`.

## 4. Testing

- `pg_stat_replication` shows `state=streaming` and small `replay_lag` on the primary; `pg_is_in_recovery()` true on the replica.
- Write a row to the primary, read it from the replica within lag — confirms the stream.
- Stop the replica; confirm the app is unchanged (backups fall back, map unaffected) — proves the fallback.
- Confirm a write attempted on the replica raises read-only — proves the guardrail.
- Confirm the mirror still wakes on `NOTIFY` (it must still be on the primary): watch a ship position update sub-interval after a write.

## 5. Rollback and cost

- **Rollback:** remove the `postgres-replica` service + `pgdata-replica` volume, unset `READ_REPLICA_URL`, drop the slot. App returns to a single-Postgres stack with zero code change (thanks to the primary fallback in Phase 2).
- **Cost:** one extra container, ~13 GB extra disk, a mandatory lag panel, and one genuinely tricky area (`refine` read-your-writes) if Phase 3 is taken. Phases 1–2 are low-risk and give the safety win plus offloaded backups; Phase 3 is where the care goes.

## 6. Recommendation

Build Phases 1–2 when durability/failover is wanted or backups start contending; take Phase 3 only after reading `backend/refine` for read-your-writes assumptions. Do **not** frame or build this as a way to speed up the map — that is Redis's job and it already does it. The value here is a hot standby and getting heavy background reads off the write path, nothing more and nothing less.
