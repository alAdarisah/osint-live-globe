#!/bin/sh
# Runs once, only on a FRESH data directory, during the postgres image's
# docker-entrypoint init phase (a temporary local server is up, and we are the
# POSTGRES_USER superuser). Creates the streaming-replication role + a physical
# slot for the standby, and opens pg_hba for replication connections from the
# private compose network.
#
# On the EXISTING populated volume this does NOT run -- the init phase is
# skipped when PG_VERSION already exists. See ops/postgres/README.md for the
# equivalent one-time manual commands to run against the live database.
set -e

REPL_PW="${REPLICATION_PASSWORD:-replicator}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPL_PW}';
SELECT pg_create_physical_replication_slot('standby_1');
SQL

# The official image adds no replication line to pg_hba by default. Append one
# for the compose network. scram-sha-256 matches PG16's default
# password_encryption, so the role's stored password verifies against it. The
# server re-reads pg_hba on the entrypoint's final restart, so no reload here.
if ! grep -q "host replication replicator" "$PGDATA/pg_hba.conf"; then
  echo "host replication replicator 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
fi
