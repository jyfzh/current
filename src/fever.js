// Fever API request routing and response generation.

import * as auth from "./auth.js";
import * as cache from "./cache.js";
import * as db from "./db.js";
import * as models from "./models.js";
import { logInfo, logWarn } from "./log.js";
import * as varModule from "./var.js";

// ── Param helpers ──

function hasParam(params, name) {
  return params.some(([key]) => key === name);
}

/** Returns the value of the last occurrence of `name`, or undefined. */
function getParamValue(params, name) {
  for (let i = params.length - 1; i >= 0; i--) {
    if (params[i][0] === name) {
      return params[i][1];
    }
  }
  return undefined;
}

/** Rust `str::parse::<u64>()` for query params (optional leading `+`). */
function parseU64(value) {
  if (value === undefined || !/^\+?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rust `str::parse::<i64>()` for query params (optional leading `+`/`-`). */
function parseI64(value) {
  if (value === undefined || !/^[+-]?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

// ── Request entry point ──

export async function handleRequest(req, env) {
  const isPost = req.method === "POST";
  const url = new URL(req.url);

  // Extract params from URL query string (and POST body if applicable).
  let params = [...url.searchParams.entries()];
  if (isPost) {
    try {
      const body = await req.text();
      if (body.length > 0) {
        params = params.concat([...new URLSearchParams(body).entries()]);
      }
    } catch {
      // Unreadable body: proceed with query params only.
    }
  }

  // Authenticate
  const apiKey = getParamValue(params, "api_key");

  if (!auth.isAuthenticated(apiKey, env)) {
    return jsonResponse(models.unauthResponse());
  }

  const d1 = requireBinding(env.DB, "DB");
  const kv = requireBinding(env.CACHE, "CACHE");

  // Check mode: must have 'api' param
  if (!hasParam(params, "api")) {
    return jsonResponse(models.unauthResponse());
  }

  // Dispatch by param presence (works for both GET and POST).
  // NOTE: Fever API spec says reads use GET and writes use POST,
  // but some clients send POST for all requests with read params in the query string,
  // so we dispatch by param presence rather than HTTP method.
  if (hasParam(params, "mark")) {
    return handleMark(env, d1, kv, params);
  }
  if (hasParam(params, "items")) {
    return handleItems(env, d1, kv, params);
  }
  if (hasParam(params, "links")) {
    return handleLinks();
  }
  if (hasParam(params, "unread_item_ids")) {
    return handleUnreadItemIds(env, d1, kv);
  }
  if (hasParam(params, "saved_item_ids")) {
    return handleSavedItemIds(env, d1, kv);
  }
  if (hasParam(params, "feeds")) {
    return handleFeeds(env, d1, kv);
  }
  if (hasParam(params, "groups")) {
    return handleGroups(env, d1, kv);
  }

  // Just ?api — return status
  return handleStatus(env, d1, kv);
}

function requireBinding(binding, name) {
  if (!binding) {
    throw new Error(`binding ${name} not found`);
  }
  return binding;
}

// ── Sub-handlers ──

async function handleStatus(env, d1, kv) {
  const groups = await cache.listGroupsCached(d1, kv, env);
  const feeds = await cache.listFeedsCached(d1, kv, env);
  const feedGroups = await cache.listFeedsByGroupCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = models.lastRefreshedOn(feeds);
  response.groups = models.mapGroups(groups);
  response.feeds = models.mapFeeds(feeds);
  response.feeds_groups = models.mapFeedGroups(feedGroups);
  return jsonResponse(response);
}

async function handleGroups(env, d1, kv) {
  const groups = await cache.listGroupsCached(d1, kv, env);
  const lastRefreshed = await cache.getMaxFeedFetchedOnCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = lastRefreshed;
  response.groups = models.mapGroups(groups);
  // Per Fever API spec, ?api&groups must also return feeds_groups
  const feedGroups = await cache.listFeedsByGroupCached(d1, kv, env);
  response.feeds_groups = models.mapFeedGroups(feedGroups);
  return jsonResponse(response);
}

async function handleFeeds(env, d1, kv) {
  const feeds = await cache.listFeedsCached(d1, kv, env);
  const feedGroups = await cache.listFeedsByGroupCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = models.lastRefreshedOn(feeds);
  response.feeds = models.mapFeeds(feeds);
  response.feeds_groups = models.mapFeedGroups(feedGroups);
  return jsonResponse(response);
}

async function handleItems(env, d1, kv, params) {
  const started = Date.now();
  const itemsPerPage = varModule.feverItemsPerPage(env);

  let items;
  const withIds = getParamValue(params, "with_ids");
  const sinceIdParam = getParamValue(params, "since_id");
  const maxIdParam = getParamValue(params, "max_id");
  if (withIds !== undefined) {
    const ids = withIds
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^\+?\d+$/.test(part))
      .map((part) => Number(part));
    items = await db.getItemsByIds(d1, ids);
  } else if (sinceIdParam !== undefined) {
    const sinceId = parseU64(sinceIdParam) ?? 0;
    items = await db.getItemsSince(d1, sinceId, itemsPerPage);
  } else if (maxIdParam !== undefined) {
    const maxId = parseU64(maxIdParam) ?? Number.MAX_SAFE_INTEGER;
    items = await db.getItemsMax(d1, maxId, itemsPerPage);
  } else {
    items = await db.getItemsMax(d1, Number.MAX_SAFE_INTEGER, itemsPerPage);
  }

  const totalItems = await cache.getTotalItemsCached(d1, kv, env);

  // Use cached unread IDs to determine read status (avoids a separate D1 query)
  const unreadIds = await cache.getUnreadItemIdsCached(d1, kv, env);
  const unreadSet = new Set(unreadIds);

  const lastRefreshed = await cache.getMaxFeedFetchedOnCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = lastRefreshed;
  response.items = models.mapItemsWithUnread(items, unreadSet);
  response.total_items = totalItems;

  logInfo(
    `perf route=fever.items total_items=${totalItems} response_items=${response.items.length} duration_ms=${Math.max(0, Date.now() - started)}`,
  );

  return jsonResponse(response);
}

async function handleLinks() {
  const response = models.okResponse();
  response.links = [];
  return jsonResponse(response);
}

async function handleUnreadItemIds(env, d1, kv) {
  const unreadIds = await cache.getUnreadItemIdsCached(d1, kv, env);
  const lastRefreshed = await cache.getMaxFeedFetchedOnCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = lastRefreshed;
  response.unread_item_ids = models.joinIds(unreadIds);
  return jsonResponse(response);
}

async function handleSavedItemIds(env, d1, kv) {
  const savedIds = await cache.getSavedItemIdsCached(d1, kv, env);
  const lastRefreshed = await cache.getMaxFeedFetchedOnCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = lastRefreshed;
  response.saved_item_ids = models.joinIds(savedIds);
  return jsonResponse(response);
}

async function handleMark(env, d1, kv, params) {
  const mark = getParamValue(params, "mark");
  const asValue = getParamValue(params, "as");
  const id = parseI64(getParamValue(params, "id"));
  // Fever API spec uses "before" (unix timestamp), not "before_id"
  const beforeTs = parseU64(getParamValue(params, "before"));

  if (mark === "item" && asValue === "read" && id !== null) {
    // mark=item&as=read&id=N
    await db.markRead(d1, id);
  } else if (mark === "item" && asValue === "unread" && id !== null) {
    // mark=item&as=unread&id=N
    await db.markUnread(d1, id);
  } else if (mark === "item" && asValue === "saved" && id !== null) {
    // mark=item&as=saved&id=N
    await db.markSaved(d1, id);
  } else if (mark === "item" && asValue === "unsaved" && id !== null) {
    // mark=item&as=unsaved&id=N
    await db.markUnsaved(d1, id);
  } else if (mark === "feed" && asValue === "read" && id !== null) {
    // mark=feed&as=read&id=N&before=TS — mark all items in feed N before TS as read
    const before = beforeTs ?? Math.floor(Date.now() / 1000);
    logInfo(`fever: mark feed ${id} as read before ${before}`);
    await db.markReadBeforeFeed(d1, id, before);
  } else if (mark === "group" && asValue === "read" && id !== null) {
    // mark=group&as=read&id=N&before=TS — mark all items before TS in group N as read
    // id=0 = Kindling super group (all feeds with is_spark=0)
    // id=-1 = Sparks super group (all feeds with is_spark=1)
    // id>0 = user-created group
    const before = beforeTs ?? Math.floor(Date.now() / 1000);
    if (id === -1) {
      logInfo(`fever: mark Sparks super group as read before ${before}`);
      // Sparks = feeds with is_spark=1; currently no feeds have is_spark=1
      // so this is intentionally a no-op until is_spark support is added
    } else if (id === 0) {
      logInfo(`fever: mark Kindling super group as read before ${before}`);
      // Kindling = feeds with is_spark=0; currently all feeds have is_spark=0
      await db.markReadBeforeAll(d1, before);
    } else {
      logInfo(`fever: mark group ${id} as read before ${before}`);
      await db.markReadBeforeGroup(d1, id, before);
    }
  } else {
    logWarn(
      `Unknown mark action: mark=${JSON.stringify(mark)} as=${JSON.stringify(asValue)} id=${JSON.stringify(id)} before=${JSON.stringify(beforeTs)} — params: ${JSON.stringify(params)}`,
    );
  }

  // Invalidate caches affected by this mark operation
  if (mark === "item" && (asValue === "read" || asValue === "unread")) {
    await cache.invalidate(kv, cache.CacheEvent.markRead());
  } else if (mark === "item" && (asValue === "saved" || asValue === "unsaved")) {
    await cache.invalidate(kv, cache.CacheEvent.markSaved());
  } else if ((mark === "feed" || mark === "group") && asValue === "read") {
    await cache.invalidate(kv, cache.CacheEvent.markRead());
  }

  // Return current status after mark (cached versions; just-invalidated
  // keys are cache misses and fetch fresh data from D1)
  const lastRefreshed = await cache.getMaxFeedFetchedOnCached(d1, kv, env);
  const savedIds = await cache.getSavedItemIdsCached(d1, kv, env);

  const response = models.okResponse();
  response.last_refreshed_on_time = lastRefreshed;
  response.saved_item_ids = models.joinIds(savedIds);
  const unreadIds = await cache.getUnreadItemIdsCached(d1, kv, env);
  response.unread_item_ids = models.joinIds(unreadIds);
  return jsonResponse(response);
}
