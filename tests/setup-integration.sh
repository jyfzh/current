#!/usr/bin/env bash
#
# Integration test runner — builds the Rust worker, starts wrangler dev,
# seeds D1 test data, runs both Fever API and Management API test suites,
# then cleans up.
#
# Usage:
#   bash tests/setup-integration.sh
#
# Environment variables (optional):
#   WRANGLER_PORT    — dev server port (default: 8787)
#

set -euo pipefail

# Bypass any proxy set in the environment — wrangler dev is local-only
unset ALL_PROXY https_proxy http_proxy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${WRANGLER_PORT:-8787}"
BASE_URL="http://localhost:$PORT"

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

# ── Step 1: Build ──
echo "=== Step 1: Build Rust Worker ==="
cd "$PROJECT_DIR/worker"
worker-build --release 2>&1
echo "Build complete."
echo ""

# ── Step 2: Start wrangler dev ──
echo "=== Step 2: Start wrangler dev ==="
cd "$PROJECT_DIR"
wrangler dev --local --port "$PORT" &
WRANGLER_PID=$!
echo "wrangler dev started (PID $WRANGLER_PID) from $PROJECT_DIR"
echo ""

# ── Step 3: Wait for server ──
echo "=== Step 3: Wait for server ==="
for i in $(seq 1 30); do
    if curl -s -o /dev/null "$BASE_URL/?api" 2>/dev/null; then
        echo "Server ready after ${i}s"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERROR: Server did not start within 30s"
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
CURRENT_FEVER_PASSWORD="${CURRENT_FEVER_PASSWORD:-dev-test-key}" \
CURRENT_FEVER_EMAIL="${CURRENT_FEVER_EMAIL:-admin}" \
    bash "$SCRIPT_DIR/test_fever_api.sh"
FEVER_EXIT=$?
echo ""

