#!/usr/bin/env bash
#
# Prepare the local D1 database used by `cf dev`.
#
# Applies every migrations/*.sql file to the local D1 simulation and
# optionally seeds it with tests/seed.sql. The local database is keyed by the
# D1 database ID configured in cloudflare.config.ts; override it with
# CURRENT_D1_ID if needed.
#
# Usage:
#   bash tests/local-db-setup.sh [--reset] [--seed]
#
#   --reset  delete the existing local D1/KV/cache state first
#   --seed   also apply tests/seed.sql
#

set -uo pipefail

# Bypass any proxy set in the environment — cf is local-only here
unset ALL_PROXY https_proxy http_proxy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# cf dev (using the Vite bundler) keeps local bindings in .cloudflare/state/v3.
# `cf d1 --local` appends v3 itself, so pass the parent directory here.
STATE_DIR="${PROJECT_DIR}/.cloudflare/state"
CF_BIN="${PROJECT_DIR}/node_modules/.bin/cf"

RESET=0
SEED=0
for arg in "$@"; do
    case "$arg" in
        --reset) RESET=1 ;;
        --seed) SEED=1 ;;
        *)
            echo "Unknown option: $arg"
            exit 2
            ;;
    esac
done

if [ ! -x "$CF_BIN" ]; then
    echo "ERROR: cf is not installed. Run: npm install"
    exit 1
fi

DB_ID="${CURRENT_D1_ID:-$(grep -A2 'bindings\.d1' "$PROJECT_DIR/cloudflare.config.ts" | grep -o '"[^"]*"' | head -1 | tr -d '"')}"
if [ -z "$DB_ID" ]; then
    DB_ID="your-database-id-here"
fi
echo "Database ID: $DB_ID"

if [ "$RESET" = "1" ]; then
    echo "Resetting local D1/KV/cache state"
    rm -rf "$STATE_DIR/v3/d1" "$STATE_DIR/v3/kv" "$STATE_DIR/v3/cache"
fi

# SQL files are sent as a D1 batch (JSON) rather than through --sql, because
# multi-line SQL is mis-parsed by the CLI argument parser.
BATCH_DIR="$(mktemp -d -t current-d1.XXXXXX)"
trap 'rm -rf "$BATCH_DIR"' EXIT

d1_exec_file() {
    local file="$1"
    local batch="$BATCH_DIR/batch.json"
    node -e '
        const fs = require("fs");
        const sql = fs.readFileSync(process.argv[1], "utf8");
        fs.writeFileSync(process.argv[2], JSON.stringify([{ sql }]));
    ' "$file" "$batch"
    "$CF_BIN" d1 raw "$DB_ID" --local --persist-to "$STATE_DIR" --batch "@$batch"
}

for migration in $(find "$PROJECT_DIR/migrations" -maxdepth 1 -type f -name '*.sql' | sort); do
    echo "Applying $(basename "$migration")"
    if ! d1_exec_file "$migration" >/dev/null; then
        echo "ERROR: failed to apply $migration"
        exit 1
    fi
done

if [ "$SEED" = "1" ]; then
    echo "Seeding tests/seed.sql"
    if ! d1_exec_file "$PROJECT_DIR/tests/seed.sql" >/dev/null; then
        echo "ERROR: failed to seed the local database"
        exit 1
    fi
fi

echo "Local D1 ready."
