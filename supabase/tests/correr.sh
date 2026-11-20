#!/usr/bin/env bash
# Corre las pruebas de políticas en un Postgres local vacío.
# Uso: PGHOST=/tmp/pg PGPORT=5433 PGUSER=postgres ./supabase/tests/correr.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
psql -q -c "drop database if exists sge_test" -c "create database sge_test"
psql -q -v ON_ERROR_STOP=1 -d sge_test -f supabase/tests/00_mock_supabase.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d sge_test -f "$f"; done
psql -q -t -v ON_ERROR_STOP=1 -d sge_test -f supabase/tests/01_politicas.sql 2>&1 | grep -E "ok |FALLA|ERROR|PASARON"
