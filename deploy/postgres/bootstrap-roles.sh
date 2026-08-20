#!/bin/sh
# Set passwords on the application login roles.
#
# Deliberately not a migration: a migration containing a password would put it in git, in every
# environment's history, and in the checksum the runner refuses to let you change. Production
# sources these from KMS; this script exists so local development matches production's *shape*
# rather than running everything as a superuser and discovering in staging that RLS was never
# actually doing anything (see migrations/0005_login_roles.sql).
set -eu

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=kna}"
: "${PGDATABASE:=kna}"
: "${KNA_INTERACTIVE_PASSWORD:?set KNA_INTERACTIVE_PASSWORD}"
: "${KNA_BATCH_PASSWORD:?set KNA_BATCH_PASSWORD}"

psql -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE kna_interactive WITH PASSWORD '${KNA_INTERACTIVE_PASSWORD}';
ALTER ROLE kna_batch       WITH PASSWORD '${KNA_BATCH_PASSWORD}';
SQL

echo "application role passwords set"
