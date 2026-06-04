//! KV-backed cache layer for expensive D1 queries.
//!
//! Strategy: cache-aside with KV as the only external cache tier.
//! Each cached function delegates to `cache_or_compute`: check KV first,
//! fall back to D1, backfill KV on compute.

use crate::db;
use crate::models::*;
use crate::var;
use worker::*;

// ── KV cache key constants ──

const KEY_FEEDS: &str = "cache:feeds";
const KEY_GROUPS: &str = "cache:groups";
const KEY_FEEDS_GROUPS: &str = "cache:feeds_groups";
const KEY_GROUPS_COUNTS: &str = "cache:groups_counts";
const KEY_TOTAL_ITEMS: &str = "cache:total_items";
const KEY_MAX_FEED_FETCHED_ON: &str = "cache:max_feed_fetched_on";
const KEY_UNREAD_IDS: &str = "cache:unread_ids";
const KEY_SAVED_IDS: &str = "cache:saved_ids";

// ── KV put helper ──

/// Write a serializable value to KV with TTL, logging errors (non-fatal).
async fn put_kv<T: serde::Serialize + ?Sized>(kv: &KvStore, key: &str, val: &T, ttl: u64) {
    match kv.put(key, val) {
        Ok(builder) => {
            if let Err(e) = builder.expiration_ttl(ttl).execute().await {
                crate::log_warn!("cache: put error {}: {:?}", key, e);
            }
        }
        Err(e) => crate::log_warn!("cache: put error {}: {:?}", key, e),
    }
}

// ── Generic cache-or-compute ──

/// Check KV for `key`. On hit, deserialize and return.
/// On miss, call `f` to compute the value, store in KV with `ttl`, and return.
async fn cache_or_compute<T, F>(kv: &KvStore, key: &str, ttl: u64, f: F) -> Result<T>
where
    T: for<'de> serde::Deserialize<'de> + serde::Serialize,
    F: std::future::Future<Output = Result<T>>,
{
    if let Some(cached) = kv.get(key).json::<T>().await? {
        return Ok(cached);
    }
    let val = f.await?;
    put_kv(kv, key, &val, ttl).await;
    Ok(val)
}

// ── Cached queries ──

pub async fn list_groups_with_counts_cached(
    d1: &D1Database,
    kv: &KvStore,
    env: &Env,
) -> Result<Vec<GroupWithCountRow>> {
    cache_or_compute(
        kv,
        KEY_GROUPS_COUNTS,
        var::cache_ttl_aggregate(env),
        async { db::list_groups_with_counts(d1).await },
    )
    .await
}

pub async fn get_total_items_cached(d1: &D1Database, kv: &KvStore, env: &Env) -> Result<u64> {
    cache_or_compute(kv, KEY_TOTAL_ITEMS, var::cache_ttl_aggregate(env), async {
        db::get_total_items(d1).await
    })
    .await
}

pub async fn get_max_feed_fetched_on_cached(
    d1: &D1Database,
    kv: &KvStore,
    env: &Env,
) -> Result<u64> {
    cache_or_compute(
        kv,
        KEY_MAX_FEED_FETCHED_ON,
        var::cache_ttl_structural(env),
        async { db::get_max_feed_fetched_on(d1).await },
    )
    .await
}

pub async fn list_feeds_cached(d1: &D1Database, kv: &KvStore, env: &Env) -> Result<Vec<FeedRow>> {
    cache_or_compute(kv, KEY_FEEDS, var::cache_ttl_structural(env), async {
        db::list_feeds(d1).await
    })
    .await
}

pub async fn list_groups_cached(d1: &D1Database, kv: &KvStore, env: &Env) -> Result<Vec<GroupRow>> {
    cache_or_compute(kv, KEY_GROUPS, var::cache_ttl_structural(env), async {
        db::list_groups(d1).await
    })
    .await
}

pub async fn list_feeds_by_group_cached(
    d1: &D1Database,
    kv: &KvStore,
    env: &Env,
) -> Result<Vec<FeedsGroupRow>> {
    cache_or_compute(
        kv,
        KEY_FEEDS_GROUPS,
        var::cache_ttl_structural(env),
        async { db::list_feeds_by_group(d1).await },
    )
    .await
}

pub async fn get_unread_item_ids_cached(
    d1: &D1Database,
    kv: &KvStore,
    env: &Env,
) -> Result<Vec<u64>> {
    cache_or_compute(kv, KEY_UNREAD_IDS, var::cache_ttl_structural(env), async {
        db::get_unread_item_ids(d1).await
    })
    .await
}

pub async fn get_saved_item_ids_cached(
    d1: &D1Database,
    kv: &KvStore,
    env: &Env,
) -> Result<Vec<u64>> {
    cache_or_compute(kv, KEY_SAVED_IDS, var::cache_ttl_structural(env), async {
        db::get_saved_item_ids(d1).await
    })
    .await
}

// ── Unified invalidation ──

/// Describes what kind of change occurred, used to selectively invalidate cache keys.
pub enum CacheEvent {
    FeedsChanged,
    ItemsAdded(Vec<u64>),
    MarkRead,
    MarkSaved,
    GroupsChanged,
    GroupCountsChanged,
}

/// Invalidate KV cache keys affected by the given event.
pub async fn invalidate(kv: &KvStore, event: CacheEvent) {
    match event {
        CacheEvent::FeedsChanged => {
            let _ = kv.delete(KEY_FEEDS).await;
            let _ = kv.delete(KEY_FEEDS_GROUPS).await;
            let _ = kv.delete(KEY_MAX_FEED_FETCHED_ON).await;
        }
        CacheEvent::ItemsAdded(_feed_ids) => {
            let _ = kv.delete(KEY_TOTAL_ITEMS).await;
            // search:* invalidation removed — no such keys exist
        }
        CacheEvent::MarkRead => {
            let _ = kv.delete(KEY_UNREAD_IDS).await;
        }
        CacheEvent::MarkSaved => {
            let _ = kv.delete(KEY_SAVED_IDS).await;
            // search:* invalidation removed — no such keys exist
        }
        CacheEvent::GroupsChanged => {
            let _ = kv.delete(KEY_GROUPS).await;
        }
        CacheEvent::GroupCountsChanged => {
            let _ = kv.delete(KEY_GROUPS_COUNTS).await;
        }
    }
}
