// Runtime configuration variables read from the Worker environment with
// sensible defaults.
//
// All values are configured in `cloudflare.config.ts` under `worker.env` and
// can be overridden per-environment with secrets or dashboard vars.
//
// Each function falls back to the same default used in `cloudflare.config.ts`,
// so the worker works even when vars are not explicitly set.

/**
 * Parses an unsigned integer the same way Rust's `str::parse::<u64>()` does:
 * an optional leading `+` followed by digits, with no whitespace or other
 * characters. Returns `fallback` when the value is missing or invalid.
 */
function parseUint(value, fallback) {
  if (typeof value !== "string" && typeof value !== "number") {
    return fallback;
  }
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) {
    return fallback;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Maximum number of concurrent feed fetch requests.
 * `0` means unlimited (the default).
 */
export function maxConcurrency(env) {
  return parseUint(env.CURRENT_MAX_CONCURRENCY, 0);
}

/**
 * Minimum age (seconds) before a feed is eligible for re-fetch.
 * Default: 3600 (1 hour). Feeds fetched more recently than this are skipped.
 */
export function feedStaleSeconds(env) {
  return parseUint(env.CURRENT_FEED_STALE_SECONDS, 3600);
}

/**
 * Whether to trigger an initial full feed fetch on the first HTTP request
 * after worker deployment. `true` = enabled (default).
 */
export function startupFetchEnabled(env) {
  const value = env.CURRENT_STARTUP_FETCH;
  if (value === undefined || value === null) {
    return true;
  }
  return String(value) === "true";
}

/**
 * TTL (seconds) for aggregate query caches (total_items, groups_counts).
 * Default: 600 (10 minutes).
 */
export function cacheTtlAggregate(env) {
  return parseUint(env.CURRENT_CACHE_TTL_AGGREGATE, 600);
}

/**
 * TTL (seconds) for structural data caches (feeds, groups, feeds_groups,
 * unread_ids, saved_ids). Default: 600 (10 minutes).
 * A long TTL is safe because all relevant mutations explicitly invalidate
 * their cache keys (e.g., feed create/update/deletes invalidate KEY_FEEDS).
 */
export function cacheTtlStructural(env) {
  return parseUint(env.CURRENT_CACHE_TTL_STRUCTURAL, 600);
}

/** Number of items returned per page by the Fever API. Default: 50. */
export function feverItemsPerPage(env) {
  return parseUint(env.CURRENT_FEVER_ITEMS_PER_PAGE, 50);
}
