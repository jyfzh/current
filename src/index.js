// Worker entry point: HTTP fetch handling, CORS, startup fetch and cron sync.

import * as cache from "./cache.js";
import { handleAdminRequest } from "./admin.js";
import * as fetcher from "./fetcher.js";
import * as fever from "./fever.js";
import { formatError, logError, logInfo } from "./log.js";
import * as varModule from "./var.js";

/**
 * Track whether the initial startup feed fetch has been triggered.
 * Module scope gives the same per-isolate semantics as the Rust `Once`.
 */
let startupFetchDone = false;

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Keep the management surface separate from Fever, including its CORS policy.
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") ||
        (url.pathname === "/" && !url.searchParams.has("api"))) {
      return handleAdminRequest(request, env);
    }
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Trigger initial feed fetch on the very first HTTP request after deployment.
    // Uses waitUntil so the response is returned immediately while fetching happens in background.
    // Controlled by CURRENT_STARTUP_FETCH var (default: true).
    if (varModule.startupFetchEnabled(env) && !startupFetchDone) {
      startupFetchDone = true;
      logInfo("Startup: triggering initial feed fetch");
      const maxConcurrency = varModule.maxConcurrency(env);
      const staleSeconds = varModule.feedStaleSeconds(env);
      ctx.waitUntil(
        (async () => {
          const d1 = env.DB;
          if (!d1) {
            logError("Startup: failed to get D1 binding: binding DB not found");
            return;
          }
          try {
            const summary = await fetcher.fetchAllFeeds(d1, maxConcurrency, staleSeconds);
            logInfo(
              `Startup: attempted=${summary.attempted} succeeded=${summary.succeeded} failed=${summary.failed} updated=${summary.updated_feed_ids.length} new_items=${summary.new_items} duration_ms=${summary.duration_ms}`,
            );
            // Always invalidate feeds (last_fetched_on updated for all fetched feeds).
            // Additionally invalidate search + total_items when new items were added.
            const kv = env.CACHE;
            if (kv) {
              await cache.invalidate(kv, cache.CacheEvent.feedsChanged());
              if (summary.updated_feed_ids.length > 0) {
                await cache.invalidate(kv, cache.CacheEvent.itemsAdded(summary.updated_feed_ids));
              }
            }
          } catch (error) {
            logError(`Startup: feed fetching error: ${formatError(error)}`);
          }
        })(),
      );
    }

    const response = await fever.handleRequest(request, env);
    addResponseCorsHeaders(response);
    return response;
  },

  /**
   * Cron Trigger handler.
   *
   * @param {ScheduledController} _event
   * @param {Record<string, unknown>} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_event, env, _ctx) {
    logInfo("Cron: starting feed fetch");
    const d1 = env.DB;
    if (!d1) {
      logError("Cron: failed to get D1 binding: binding DB not found");
      return;
    }

    const maxConcurrency = varModule.maxConcurrency(env);
    const staleSeconds = varModule.feedStaleSeconds(env);
    const start = Date.now();

    // Phase 1: Feed fetching
    try {
      const summary = await fetcher.fetchAllFeeds(d1, maxConcurrency, staleSeconds);
      const elapsedSeconds = Math.floor((Date.now() - start) / 1000);
      logInfo(
        `Cron: attempted=${summary.attempted} succeeded=${summary.succeeded} failed=${summary.failed} updated=${summary.updated_feed_ids.length} new_items=${summary.new_items} duration_ms=${summary.duration_ms} elapsed_s=${elapsedSeconds}`,
      );
      // Always invalidate feeds (last_fetched_on updated for all fetched feeds).
      // Additionally invalidate search + total_items when new items were added.
      const kv = env.CACHE;
      if (kv) {
        await cache.invalidate(kv, cache.CacheEvent.feedsChanged());
        if (summary.updated_feed_ids.length > 0) {
          await cache.invalidate(kv, cache.CacheEvent.itemsAdded(summary.updated_feed_ids));
        }
      }
    } catch (error) {
      logError(`Cron: feed fetching error: ${formatError(error)}`);
    }
  },
};

/**
 * Add CORS headers to an HTTP response.
 * Called on every Fever API response to allow cross-origin requests.
 */
function addResponseCorsHeaders(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
