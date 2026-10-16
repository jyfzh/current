#!/usr/bin/env bash
#
# Integration test runner — runs the unit tests, starts wrangler dev for the
# JavaScript worker, seeds local D1 test data, runs the Fever API test suite,
# then cleans up.
#
# Usage:
#   bash tests/setup-integration.sh
#
# Environment variables (optional):
#   WRANGLER_PORT          — dev server port (default: 8787)
#   CURRENT_FEVER_PASSWORD — Fever password used by the auth tests (default: dev-test-key)
#   CURRENT_FEVER_EMAIL    — Fever email used by the auth tests (default: admin)
#

set -uo pipefail

# Bypass any proxy set in the environment — wrangler dev is local-only
unset ALL_PROXY https_proxy http_proxy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${WRANGLER_PORT:-8787}"
BASE_URL="http://localhost:$PORT"
PASSWORD="${CURRENT_FEVER_PASSWORD:-dev-test-key}"
EMAIL="${CURRENT_FEVER_EMAIL:-admin}"
DEV_LOG="${PROJECT_DIR}/.wrangler-dev.log"

WRANGLER_PID=""

cleanup() {
    local exit_code=$?
    echo ""
    echo "=== Cleanup ==="
    if [ -n "$WRANGLER_PID" ] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
        echo "Stopping wrangler dev (PID $WRANGLER_PID)..."
        kill "$WRANGLER_PID" 2>/dev/null || true
        wait "$WRANGLER_PID" 2>/dev/null || true
        echo "Stopped."
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "━━━ Integration Test Runner ━━━"
echo ""

# ── Step 1: Unit tests ──
echo "=== Step 1: Run unit tests ==="
cd "$PROJECT_DIR"
if ! npm test; then
    echo "ERROR: unit tests failed"
    exit 1
fi
echo ""

# ── Step 2: Start wrangler dev ──
echo "=== Step 2: Start wrangler dev ==="
cd "$PROJECT_DIR"
wrangler dev --local --port "$PORT" \
    --var CURRENT_FEVER_PASSWORD:"$PASSWORD" \
    --var CURRENT_FEVER_EMAIL:"$EMAIL" \
    --var CURRENT_STARTUP_FETCH:false \
    >"$DEV_LOG" 2>&1 &
WRANGLER_PID=$!
echo "wrangler dev started (PID $WRANGLER_PID), log: $DEV_LOG"
echo ""

# ── Step 3: Wait for server ──
echo "=== Step 3: Wait for server ==="
for i in $(seq 1 60); do
    if curl -s -o /dev/null "$BASE_URL/?api" 2>/dev/null; then
        echo "Server ready after ${i}s"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "ERROR: Server did not start within 60s"
        echo "--- wrangler dev log ---"
        tail -50 "$DEV_LOG"
        exit 1
    fi
    sleep 1
done
echo ""

# ── Step 4: Apply database migrations ──
echo "=== Step 4: Apply database migrations ==="
cd "$PROJECT_DIR"
for migration in $(find migrations -maxdepth 1 -type f -name '*.sql' | sort); do
    echo "Applying $migration"
    wrangler d1 execute DB --local --file="$migration" 2>&1
done
echo "Migrations complete."
echo ""

# ── Step 5: Seed test data ──
echo "=== Step 5: Seed test data ==="
cd "$PROJECT_DIR"
wrangler d1 execute DB --local --file=tests/seed.sql 2>&1
echo "Seed complete."
echo ""

# ── Step 6: Run integration tests ──
echo "=== Step 6: Run Fever API tests ==="
FEVER_BASE_URL="$BASE_URL" \
CURRENT_FEVER_PASSWORD="$PASSWORD" \
CURRENT_FEVER_EMAIL="$EMAIL" \
    bash "$SCRIPT_DIR/test_fever_api.sh"
FEVER_EXIT=$?
echo ""

if [ "$FEVER_EXIT" -ne 0 ]; then
    echo "ERROR: Fever API tests failed (exit $FEVER_EXIT)"
fi

exit "$FEVER_EXIT"
