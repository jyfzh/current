#!/usr/bin/env bash
#
# Integration test runner — runs the unit tests, prepares the local D1
# database, starts `cf dev` for the JavaScript worker, runs the Fever API
# test suite, then cleans up.
#
# Usage:
#   bash tests/setup-integration.sh
#
# Environment variables (optional):
#   CF_PORT                — dev server port (default: 8787)
#   CURRENT_D1_ID          — D1 database ID used for local state
#                            (default: the ID in cloudflare.config.ts)
#   CURRENT_FEVER_PASSWORD — Fever password used by the auth tests (default: dev-test-key)
#   CURRENT_FEVER_EMAIL    — Fever email used by the auth tests (default: admin)
#

set -uo pipefail

# Bypass any proxy set in the environment — cf dev is local-only
unset ALL_PROXY https_proxy http_proxy

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PORT="${CF_PORT:-8787}"
BASE_URL="http://localhost:$PORT"
PASSWORD="${CURRENT_FEVER_PASSWORD:-dev-test-key}"
EMAIL="${CURRENT_FEVER_EMAIL:-admin}"
DEV_LOG="${PROJECT_DIR}/.cf-dev.log"
DEV_VARS="${PROJECT_DIR}/.dev.vars"

CF_BIN="${PROJECT_DIR}/node_modules/.bin/cf"
CF_PID=""
DEV_VARS_BACKUP=""

# cf dev does not forward signals to the Vite/workerd processes it spawns, so
# collect its descendants and terminate the whole tree.
collect_descendants() {
    local pid="$1" child
    echo "$pid"
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        collect_descendants "$child"
    done
}

cleanup() {
    local exit_code=$?
    echo ""
    echo "=== Cleanup ==="
    if [ -n "$CF_PID" ] && kill -0 "$CF_PID" 2>/dev/null; then
        echo "Stopping cf dev (PID $CF_PID)..."
        local pids
        pids="$(collect_descendants "$CF_PID")"
        kill $pids 2>/dev/null || true
        sleep 1
        kill -9 $pids 2>/dev/null || true
        wait "$CF_PID" 2>/dev/null || true
        echo "Stopped."
    fi
    if [ -n "$DEV_VARS_BACKUP" ]; then
        mv "$DEV_VARS_BACKUP" "$DEV_VARS"
        echo "Restored .dev.vars"
    else
        rm -f "$DEV_VARS"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo "━━━ Integration Test Runner ━━━"
echo ""

if [ ! -x "$CF_BIN" ]; then
    echo "ERROR: cf is not installed. Run: npm install"
    exit 1
fi

# ── Step 1: Unit tests ──
echo "=== Step 1: Run unit tests ==="
cd "$PROJECT_DIR"
if ! npm test; then
    echo "ERROR: unit tests failed"
    exit 1
fi
echo ""

# ── Step 2: Prepare local D1 + cache state ──
echo "=== Step 2: Prepare local D1 state ==="
cd "$PROJECT_DIR"
if ! bash "$SCRIPT_DIR/local-db-setup.sh" --reset --seed; then
    echo "ERROR: failed to prepare the local database"
    exit 1
fi
echo ""

# ── Step 3: Start cf dev ──
echo "=== Step 3: Start cf dev ==="
if [ -f "$DEV_VARS" ]; then
    DEV_VARS_BACKUP="$(mktemp -t current-dev-vars.XXXXXX)"
    cp "$DEV_VARS" "$DEV_VARS_BACKUP"
fi
cat >"$DEV_VARS" <<EOF
CURRENT_FEVER_PASSWORD=$PASSWORD
CURRENT_FEVER_EMAIL=$EMAIL
CURRENT_STARTUP_FETCH=false
EOF

# CF_PORT is read by vite.config.ts (cf dev has no --port flag in Vite projects)
CF_PORT="$PORT" "$CF_BIN" dev >"$DEV_LOG" 2>&1 &
CF_PID=$!
echo "cf dev started (PID $CF_PID), log: $DEV_LOG"
echo ""

# ── Step 4: Wait for server ──
echo "=== Step 4: Wait for server ==="
for i in $(seq 1 60); do
    if curl -s -o /dev/null "$BASE_URL/?api" 2>/dev/null; then
        echo "Server ready after ${i}s"
        break
    fi
    if ! kill -0 "$CF_PID" 2>/dev/null; then
        echo "ERROR: cf dev exited before the server was ready"
        echo "--- cf dev log ---"
        tail -50 "$DEV_LOG"
        exit 1
    fi
    if [ "$i" -eq 60 ]; then
        echo "ERROR: Server did not start within 60s"
        echo "--- cf dev log ---"
        tail -50 "$DEV_LOG"
        exit 1
    fi
    sleep 1
done
echo ""

# ── Step 5: Run integration tests ──
echo "=== Step 5: Run Fever API tests ==="
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
