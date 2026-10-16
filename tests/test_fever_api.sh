#!/usr/bin/env bash
#
# Fever API 集成测试脚本
#
# 用法:
#   export FEVER_BASE_URL="https://current.your-domain.workers.dev"
#   export CURRENT_FEVER_PASSWORD="your-password"
#   export CURRENT_FEVER_EMAIL="your-email"
#   bash tests/test_fever_api.sh
#
# 依赖: curl, jq
#

set -uo pipefail

# Bypass any proxy set in the environment — cf dev is local-only
unset ALL_PROXY https_proxy http_proxy

BASE_URL="${FEVER_BASE_URL:-http://localhost:8787}"
API_KEY_RAW="${CURRENT_FEVER_PASSWORD:-dev-test-key}"
API_KEY_USER="${CURRENT_FEVER_EMAIL:-admin}"
API_KEY_MD5=""
API_KEY=""
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

check_deps() {
    for cmd in curl jq; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "Error: $cmd is required but not installed."
            exit 1
        fi
    done
    # md5sum (Linux) or md5 (macOS)
    if ! command -v md5sum &>/dev/null && ! command -v md5 &>/dev/null; then
        echo "Error: md5sum or md5 is required but not installed."
        exit 1
    fi
}

# Portable MD5 hash function (Linux: md5sum, macOS: md5)
md5_hash() {
    if command -v md5sum &>/dev/null; then
        echo -n "$1" | md5sum | cut -d' ' -f1
    else
        echo -n "$1" | md5 -r
    fi
}

ok() {
    echo -e "  ${GREEN}✓${NC} $1" >&2
    ((++PASS))
}

fail() {
    echo -e "  ${RED}✗${NC} $1" >&2
    echo "    $2" >&2
    ((++FAIL))
}

header() {
    echo ""
    echo -e "${CYAN}━━━ $1 ━━━${NC}"
}

fetch_json() {
    local url="$1"
    local expected_key="$2"
    local expected_val="$3"
    local label="$4"

    local response
    response=$(curl -sS -w "\n%{http_code}" "$url" 2>&1) || {
        fail "$label" "curl failed: $response"
        return 1
    }

    local http_code
    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | head -n -1)

    if [[ "$http_code" != "200" ]]; then
        fail "$label" "HTTP $http_code (expected 200)"
        return 1
    fi

    local actual
    actual=$(echo "$body" | jq -r ".${expected_key}" 2>/dev/null) || {
        fail "$label" "Invalid JSON: $(echo "$body" | head -c 200)"
        return 1
    }

    if [[ "$actual" != "$expected_val" ]]; then
        fail "$label" ".${expected_key} = ${actual} (expected ${expected_val})"
        return 1
    fi

    ok "$label"
    echo "$body"
}

# ──────────────────────────────────────────────────
#  Tests
# ──────────────────────────────────────────────────

check_deps
API_KEY_MD5=$(md5_hash "${API_KEY_USER}:${API_KEY_RAW}")
API_KEY="$API_KEY_MD5"

echo ""
echo "Fever API Integration Test"
echo "  Base URL: $BASE_URL"
echo "  API Key:  ${API_KEY_RAW} (user: ${API_KEY_USER}, md5: ${API_KEY_MD5:0:8}...)"
echo ""

header "1. Auth — Invalid API Key"

fetch_json \
    "${BASE_URL}/?api&api_key=wrong" \
    "auth" "0" \
    "Invalid key returns auth=0"

header "2. Auth — Missing API Key"

fetch_json \
    "${BASE_URL}/?api" \
    "auth" "0" \
    "Missing key returns auth=0"

header "3. Auth — Plain Text Key (Rejected)"

fetch_json \
    "${BASE_URL}/?api&api_key=${API_KEY_RAW}" \
    "auth" "0" \
    "Raw key returns auth=0 (expected)"

header "4. Auth — MD5 API Key"

fetch_json \
    "${BASE_URL}/?api&api_key=${API_KEY}" \
    "auth" "1" \
    "MD5 key returns auth=1"

header "5. Status — Valid API Key"

fetch_json \
    "${BASE_URL}/?api&api_key=${API_KEY}" \
    "auth" "1" \
    "Valid key returns auth=1"

header "6. Groups"

body=$(fetch_json \
    "${BASE_URL}/?api&groups&api_key=${API_KEY}" \
    "auth" "1" \
    "Groups returns auth=1") || true

if [[ -n "$body" ]]; then
    groups_count=$(echo "$body" | jq '.groups | length')
    echo "    Groups count: $groups_count"
    has_refreshed=$(echo "$body" | jq 'has("last_refreshed_on_time")')
    if [[ "$has_refreshed" == "true" ]]; then
        ok "Groups response has last_refreshed_on_time"
    else
        fail "Groups" "Missing last_refreshed_on_time"
    fi
fi

header "7. Feeds"

body=$(fetch_json \
    "${BASE_URL}/?api&feeds&api_key=${API_KEY}" \
    "auth" "1" \
    "Feeds returns auth=1") || true

if [[ -n "$body" ]]; then
    feeds_count=$(echo "$body" | jq '.feeds | length')
    echo "    Feeds count: $feeds_count"
    has_feeds_groups=$(echo "$body" | jq 'has("feeds_groups")')
    if [[ "$has_feeds_groups" == "true" ]]; then
        ok "Feeds response has feeds_groups"
    else
        fail "Feeds" "Missing feeds_groups"
    fi

    # Validate feed structure
    if [[ "$feeds_count" -gt 0 ]]; then
        has_url=$(echo "$body" | jq '.feeds[0] | has("url")')
        has_site_url=$(echo "$body" | jq '.feeds[0] | has("site_url")')
        has_is_spark=$(echo "$body" | jq '.feeds[0] | has("is_spark")')
        has_updated=$(echo "$body" | jq '.feeds[0] | has("last_updated_on_time")')
        if [[ "$has_url" == "true" && "$has_site_url" == "true" && "$has_is_spark" == "true" && "$has_updated" == "true" ]]; then
            ok "Feed[0] has all required fields"
        else
            fail "Feed[0]" "Missing required fields"
        fi
    fi
fi

header "8. Items"

body=$(fetch_json \
    "${BASE_URL}/?api&items&api_key=${API_KEY}" \
    "auth" "1" \
    "Items returns auth=1") || true

if [[ -n "$body" ]]; then
    items_count=$(echo "$body" | jq '.items | length')
    total_items=$(echo "$body" | jq '.total_items // 0')
    echo "    Items returned: $items_count (total: $total_items)"

    # Per Fever API spec, ?api&items returns only items + total_items
    # saved_item_ids and unread_item_ids are standalone endpoints
    has_saved=$(echo "$body" | jq 'has("saved_item_ids")')
    has_read=$(echo "$body" | jq 'has("unread_item_ids")')
    has_total=$(echo "$body" | jq 'has("total_items")')

    if [[ "$has_saved" == "false" ]]; then ok "Items response has no saved_item_ids (correct)"; else fail "Items" "Should NOT have saved_item_ids"; fi
    if [[ "$has_read" == "false" ]]; then ok "Items response has no unread_item_ids (correct)"; else fail "Items" "Should NOT have unread_item_ids"; fi
    if [[ "$has_total" == "true" ]]; then ok "Has total_items"; else fail "Items" "Missing total_items"; fi

    # Validate item structure
    if [[ "$items_count" -gt 0 ]]; then
        item_ok=0
        for field in id feed_id title author html url is_saved created_on_time; do
            has_field=$(echo "$body" | jq ".items[0] | has(\"$field\")")
            if [[ "$has_field" == "true" ]]; then item_ok=$((item_ok + 1)); fi
        done
        if [[ "$item_ok" -eq 8 ]]; then
            ok "Item[0] has all 8 required fields"
        else
            fail "Item[0]" "Missing fields ($item_ok/8)"
        fi
    fi
fi

header "9. Items — since_id"

fetch_json \
    "${BASE_URL}/?api&items&since_id=0&api_key=${API_KEY}" \
    "auth" "1" \
    "Items with since_id=0 returns auth=1"

header "10. Items — max_id"

fetch_json \
    "${BASE_URL}/?api&items&max_id=999999&api_key=${API_KEY}" \
    "auth" "1" \
    "Items with max_id returns auth=1"

header "11. Links"

body=$(fetch_json \
    "${BASE_URL}/?api&links&api_key=${API_KEY}" \
    "auth" "1" \
    "Links returns auth=1") || true

if [[ -n "$body" ]]; then
    links_is_array=$(echo "$body" | jq '.links | type')
    if [[ "$links_is_array" == "\"array\"" ]]; then
        links_len=$(echo "$body" | jq '.links | length')
        ok "Links is an array (length=$links_len)"
    else
        fail "Links" "links is not an array"
    fi
fi

header "12. Sync — unread_item_ids"

body=$(fetch_json \
    "${BASE_URL}/?api&unread_item_ids&api_key=${API_KEY}" \
    "auth" "1" \
    "unread_item_ids returns auth=1") || true

if [[ -n "$body" ]]; then
    has_unread=$(echo "$body" | jq 'has("unread_item_ids")')
    has_refreshed=$(echo "$body" | jq 'has("last_refreshed_on_time")')
    no_feeds=$(echo "$body" | jq 'has("feeds") | not')
    no_items=$(echo "$body" | jq 'has("items") | not')

    if [[ "$has_unread" == "true" ]]; then ok "unread_item_ids response has unread_item_ids"; else fail "unread_item_ids" "Missing unread_item_ids"; fi
    if [[ "$has_refreshed" == "true" ]]; then ok "unread_item_ids response has last_refreshed_on_time"; else fail "unread_item_ids" "Missing last_refreshed_on_time"; fi
    if [[ "$no_feeds" == "true" ]]; then ok "unread_item_ids response has no feeds"; else fail "unread_item_ids" "Unexpected feeds field"; fi
    if [[ "$no_items" == "true" ]]; then ok "unread_item_ids response has no items"; else fail "unread_item_ids" "Unexpected items field"; fi
fi

header "13. Sync — saved_item_ids"

body=$(fetch_json \
    "${BASE_URL}/?api&saved_item_ids&api_key=${API_KEY}" \
    "auth" "1" \
    "saved_item_ids returns auth=1") || true

if [[ -n "$body" ]]; then
    has_saved=$(echo "$body" | jq 'has("saved_item_ids")')
    has_refreshed=$(echo "$body" | jq 'has("last_refreshed_on_time")')
    no_feeds=$(echo "$body" | jq 'has("feeds") | not')

    if [[ "$has_saved" == "true" ]]; then ok "saved_item_ids response has saved_item_ids"; else fail "saved_item_ids" "Missing saved_item_ids"; fi
    if [[ "$has_refreshed" == "true" ]]; then ok "saved_item_ids response has last_refreshed_on_time"; else fail "saved_item_ids" "Missing last_refreshed_on_time"; fi
    if [[ "$no_feeds" == "true" ]]; then ok "saved_item_ids response has no feeds"; else fail "saved_item_ids" "Unexpected feeds field"; fi
fi

header "14. POST — Mark as read"

# Find an item ID if available, otherwise use 1
item_id=$(curl -sS "${BASE_URL}/?api&items&api_key=${API_KEY}" | jq '.items[0].id // 1')

# Put api and api_key in the URL query string, mark params in the POST body.
# This ensures the request works even if the body is not parsed in some environments.
response=$(curl -sS -w "\n%{http_code}" -X POST -d "mark=item&as=read&id=${item_id}" "${BASE_URL}/?api&api_key=${API_KEY}" 2>&1) || {
    fail "POST mark as read" "curl failed: $response"
    body=""
}
http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | head -n -1)

if [[ "$http_code" == "200" ]]; then
    ok "POST mark as read returns 200"
else
    fail "POST mark as read" "HTTP $http_code (expected 200)"
fi

if [[ -n "$body" ]]; then
    has_read_ids=$(echo "$body" | jq 'has("unread_item_ids")')
    has_saved_ids=$(echo "$body" | jq 'has("saved_item_ids")')
    if [[ "$has_read_ids" == "true" && "$has_saved_ids" == "true" ]]; then
        ok "Mark response has unread_item_ids and saved_item_ids"
    else
        fail "Mark response" "Missing expected fields"
    fi
fi

header "15. CORS Headers"

origin="https://example.com"
resp_headers=$(curl -sS -D - -o /dev/null "${BASE_URL}/?api&api_key=${API_KEY}" 2>&1)

if echo "$resp_headers" | grep -qi "Access-Control-Allow-Origin: \*"; then
    ok "CORS: Access-Control-Allow-Origin: *"
else
    fail "CORS" "Missing Access-Control-Allow-Origin header"
fi

# Test OPTIONS preflight
options_resp=$(curl -sS -X OPTIONS -D - -o /dev/null "${BASE_URL}/" 2>&1)
if echo "$options_resp" | grep -qi "Access-Control-Allow-Origin"; then
    ok "CORS: OPTIONS preflight returns CORS headers"
else
    fail "CORS" "OPTIONS preflight missing CORS headers"
fi

header "16. Response Time"

start_time=$(date +%s%N)
curl -sS -o /dev/null "${BASE_URL}/?api&api_key=${API_KEY}"
end_time=$(date +%s%N)
elapsed_ms=$(( (end_time - start_time) / 1000000 ))
echo "    Response time: ${elapsed_ms}ms"
if [[ "$elapsed_ms" -lt 5000 ]]; then
    ok "Response time under 5s (${elapsed_ms}ms)"
else
    fail "Response time" "${elapsed_ms}ms (exceeds 5s)"
fi

# ──────────────────────────────────────────────────
#  Summary
# ──────────────────────────────────────────────────

echo ""
echo "━━━ Summary ━━━"
echo -e "  ${GREEN}Passed:${NC} $PASS"
echo -e "  ${RED}Failed:${NC} $FAIL"

if [[ "$FAIL" -eq 0 ]]; then
    echo -e "  ${GREEN}All tests passed!${NC}"
else
    echo -e "  ${RED}Some tests failed.${NC}"
fi
echo ""

exit "$FAIL"
