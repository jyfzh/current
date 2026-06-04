//! Runtime configuration variables read from `env.var()` with sensible defaults.
//!
//! All values are configured via `wrangler.jsonc` `vars` and can be overridden
//! per-environment with `wrangler secret put` (for secrets) or dashboard vars.
//!
//! Each function falls back to the same default used in `wrangler.jsonc` `vars`,
//! so the worker works even when vars are not explicitly set.

use worker::*;

/// Maximum number of concurrent feed fetch requests.
/// `0` means unlimited (the default).
pub fn max_concurrency(env: &Env) -> usize {
    env.var("CURRENT_MAX_CONCURRENCY")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(0)
}

/// Minimum age (seconds) before a feed is eligible for re-fetch.
/// Default: 3600 (1 hour). Feeds fetched more recently than this are skipped.
pub fn feed_stale_seconds(env: &Env) -> u64 {
    env.var("CURRENT_FEED_STALE_SECONDS")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(3600)
}

/// Whether to trigger an initial full feed fetch on the first HTTP request
/// after worker deployment. `true` = enabled (default).
pub fn startup_fetch_enabled(env: &Env) -> bool {
    env.var("CURRENT_STARTUP_FETCH")
        .ok()
        .map(|v| v.to_string() == "true")
        .unwrap_or(true)
}

/// TTL (seconds) for aggregate query caches (total_items, groups_counts).
/// Default: 600 (10 minutes).
pub fn cache_ttl_aggregate(env: &Env) -> u64 {
    env.var("CURRENT_CACHE_TTL_AGGREGATE")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(600)
}

/// TTL (seconds) for structural data caches (feeds, groups, feeds_groups,
/// unread_ids, saved_ids). Default: 600 (10 minutes).
/// A long TTL is safe because all relevant mutations explicitly invalidate
/// their cache keys (e.g., feed create/update/deletes invalidate KEY_FEEDS).
pub fn cache_ttl_structural(env: &Env) -> u64 {
    env.var("CURRENT_CACHE_TTL_STRUCTURAL")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(600)
}

/// Number of items returned per page by the Fever API. Default: 50.
pub fn fever_items_per_page(env: &Env) -> u64 {
    env.var("CURRENT_FEVER_ITEMS_PER_PAGE")
        .ok()
        .and_then(|v| v.to_string().parse().ok())
        .unwrap_or(50)
}
