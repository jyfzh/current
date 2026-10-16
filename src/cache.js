// KV-backed cache layer for expensive D1 queries.
//
// Strategy: cache-aside with KV as the only external cache tier.
// Each cached function delegates to `cacheOrCompute`: check KV first,
// fall back to D1, backfill KV on compute.

import * as db from "./db.js";
import { logWarn } from "./log.js";
import * as varModule from "./var.js";

// ── KV cache key constants ──

export const KEY_FEEDS = "cache:feeds";
export const KEY_GROUPS = "cache:groups";
export const KEY_FEEDS_GROUPS = "cache:feeds_groups";
export const KEY_GROUPS_COUNTS = "cache:groups_counts";
export const KEY_TOTAL_ITEMS = "cache:total_items";
export const KEY_MAX_FEED_FETCHED_ON = "cache:max_feed_fetched_on";
export const KEY_UNREAD_IDS = "cache:unread_ids";
export const KEY_SAVED_IDS = "cache:saved_ids";

// ── KV put helper ──

/**
 * Write a JSON-serializable value to KV with TTL, logging errors (non-fatal).
 */
async function putKv(kv, key, value, ttl) {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch (error) {
    logWarn(`cache: put error ${key}: ${error}`);
  }
}

// ── Generic cache-or-compute ──

/**
 * Check KV for `key`. On hit, return the parsed value.
 * On miss, call `compute` to produce the value, store it in KV with `ttl`,
 * and return it.
 */
async function cacheOrCompute(kv, key, ttl, compute) {
  const cached = await kv.get(key, "json");
  if (cached !== null && cached !== undefined) {
    return cached;
  }
  const value = await compute();
  await putKv(kv, key, value, ttl);
  return value;
}

// ── Cached queries ──

export async function listGroupsWithCountsCached(d1, kv, env) {
  return cacheOrCompute(
    kv,
    KEY_GROUPS_COUNTS,
    varModule.cacheTtlAggregate(env),
    () => db.listGroupsWithCounts(d1),
  );
}

export async function getTotalItemsCached(d1, kv, env) {
  return cacheOrCompute(kv, KEY_TOTAL_ITEMS, varModule.cacheTtlAggregate(env), () =>
    db.getTotalItems(d1),
  );
}

export async function getMaxFeedFetchedOnCached(d1, kv, env) {
  return cacheOrCompute(
    kv,
    KEY_MAX_FEED_FETCHED_ON,
    varModule.cacheTtlStructural(env),
    () => db.getMaxFeedFetchedOn(d1),
  );
}

export async function listFeedsCached(d1, kv, env) {
  return cacheOrCompute(kv, KEY_FEEDS, varModule.cacheTtlStructural(env), () => db.listFeeds(d1));
}

export async function listGroupsCached(d1, kv, env) {
  return cacheOrCompute(kv, KEY_GROUPS, varModule.cacheTtlStructural(env), () => db.listGroups(d1));
}

export async function listFeedsByGroupCached(d1, kv, env) {
  return cacheOrCompute(
    kv,
    KEY_FEEDS_GROUPS,
    varModule.cacheTtlStructural(env),
    () => db.listFeedsByGroup(d1),
  );
}

export async function getUnreadItemIdsCached(d1, kv, env) {
  return cacheOrCompute(kv, KEY_UNREAD_IDS, varModule.cacheTtlStructural(env), () =>
    db.getUnreadItemIds(d1),
  );
}

export async function getSavedItemIdsCached(d1, kv, env) {
  return cacheOrCompute(kv, KEY_SAVED_IDS, varModule.cacheTtlStructural(env), () =>
    db.getSavedItemIds(d1),
  );
}

// ── Unified invalidation ──

/**
 * Describes what kind of change occurred, used to selectively invalidate
 * cache keys.
 */
export const CacheEvent = {
  feedsChanged: () => ({ type: "feeds_changed" }),
  itemsAdded: (feedIds) => ({ type: "items_added", feedIds }),
  markRead: () => ({ type: "mark_read" }),
  markSaved: () => ({ type: "mark_saved" }),
  groupsChanged: () => ({ type: "groups_changed" }),
  groupCountsChanged: () => ({ type: "group_counts_changed" }),
};

async function deleteKey(kv, key) {
  try {
    await kv.delete(key);
  } catch {
    // Cache invalidation failures are non-fatal: entries expire via TTL.
  }
}

/** Invalidate KV cache keys affected by the given event. */
export async function invalidate(kv, event) {
  switch (event.type) {
    case "feeds_changed":
      await deleteKey(kv, KEY_FEEDS);
      await deleteKey(kv, KEY_FEEDS_GROUPS);
      await deleteKey(kv, KEY_MAX_FEED_FETCHED_ON);
      break;
    case "items_added":
      await deleteKey(kv, KEY_TOTAL_ITEMS);
      // search:* invalidation removed — no such keys exist
      break;
    case "mark_read":
      await deleteKey(kv, KEY_UNREAD_IDS);
      break;
    case "mark_saved":
      await deleteKey(kv, KEY_SAVED_IDS);
      // search:* invalidation removed — no such keys exist
      break;
    case "groups_changed":
      await deleteKey(kv, KEY_GROUPS);
      break;
    case "group_counts_changed":
      await deleteKey(kv, KEY_GROUPS_COUNTS);
      break;
    default:
      break;
  }
}
