// Concurrent feed fetching, parsing and synchronization.
//
// Port of the Rust `fetcher.rs` module: HTTP GET with a browser User-Agent,
// feed-rs-compatible parsing, batched INSERT OR IGNORE writes and a summary
// of the sync run.

import * as db from "./db.js";
import { parseFeed } from "./feedparser.js";
import { formatError, logError, logInfo, logWarn } from "./log.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const BATCH_SIZE = 100;

/**
 * Number of jobs to run in a single concurrency window.
 * `0` means unlimited (all jobs in a single window).
 */
export function concurrencyWindow(maxConcurrency, totalJobs) {
  if (totalJobs === 0) {
    return 1;
  }
  if (maxConcurrency === 0) {
    return totalJobs;
  }
  return Math.max(Math.min(maxConcurrency, totalJobs), 1);
}

/**
 * Runs `worker` over `items` with at most `window` tasks in flight.
 * Results are collected in completion order (like `buffer_unordered`).
 */
async function runWithConcurrency(items, window, worker) {
  const results = [];
  let nextIndex = 0;

  async function runner() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results.push(await worker(items[index]));
    }
  }

  const runners = [];
  const runnerCount = Math.min(window, items.length);
  for (let i = 0; i < runnerCount; i++) {
    runners.push(runner());
  }
  await Promise.all(runners);
  return results;
}

/**
 * Fetch all feeds that need updating.
 *
 * `maxConcurrency` controls how many feeds are fetched simultaneously.
 * `0` means no limit (all jobs in a single window).
 * `staleSeconds` controls how old a feed must be before it's eligible for re-fetch.
 *
 * @returns {Promise<{attempted: number, succeeded: number, failed: number, updated_feed_ids: number[], new_items: number, duration_ms: number}>}
 */
export async function fetchAllFeeds(d1, maxConcurrency, staleSeconds) {
  const started = Date.now();
  const feeds = await db.getFeedsToFetch(d1, staleSeconds);
  const attempted = feeds.length;

  const jobs = feeds.map((feed) => ({ id: feed.id, title: feed.title, url: feed.url }));
  const window = concurrencyWindow(maxConcurrency, jobs.length);

  const outcomes = await runWithConcurrency(jobs, window, async (job) => {
    try {
      const newItems = await fetchSingleFeed(d1, job.id, job.url);
      logInfo(`  Fetched feed ${job.id}: ${job.title} (${newItems} new)`);
      return { feedId: job.id, newItems, ok: true };
    } catch (error) {
      logError(`  Error fetching feed ${job.id} (${job.title}): ${formatError(error)}`);
      return { feedId: job.id, newItems: 0, ok: false };
    }
  });

  const jobsTotal = outcomes.length;
  const succeededJobs = outcomes.filter((outcome) => outcome.ok).length;
  const failedJobs = outcomes.filter((outcome) => !outcome.ok).length;
  const skippedWithoutUrl = attempted - jobsTotal;
  const succeeded = succeededJobs + skippedWithoutUrl;

  const updatedFeedIds = outcomes
    .filter((outcome) => outcome.ok && outcome.newItems > 0)
    .map((outcome) => outcome.feedId);
  const newItems = outcomes
    .filter((outcome) => outcome.ok)
    .reduce((sum, outcome) => sum + outcome.newItems, 0);
  const durationMs = Math.max(0, Date.now() - started);

  return {
    attempted,
    succeeded,
    failed: failedJobs,
    updated_feed_ids: updatedFeedIds,
    new_items: newItems,
    duration_ms: durationMs,
  };
}

/** Fetch a single feed by its database ID and synchronize its items. */
export async function fetchFeedById(d1, feedId) {
  const feed = await db.getFeed(d1, feedId);
  if (!feed) {
    throw new Error(`feed ${feedId} not found`);
  }
  await fetchSingleFeed(d1, feed.id, feed.url);
}

/**
 * Fetch and parse a single feed, storing new entries.
 * Returns the number of new items inserted.
 */
async function fetchSingleFeed(d1, feedId, url) {
  // 1. HTTP GET the feed using the Worker Fetch API
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    logWarn(`  Invalid URL for feed ${feedId}: ${formatError(error)}`);
    await db.updateFeedFetched(d1, feedId, 0);
    return 0;
  }

  const response = await fetch(parsedUrl.toString(), {
    headers: { "User-Agent": USER_AGENT },
  });

  const status = response.status;
  if (status < 200 || status >= 300) {
    logWarn(`  HTTP ${status} for feed ${url}`);
    // Still update last_fetched_on to avoid hammering failing feeds
    await db.updateFeedFetched(d1, feedId, status);
    return 0;
  }

  const body = new Uint8Array(await response.arrayBuffer());

  // 2. Parse the feed (RSS, Atom or JSON Feed)
  let feed;
  try {
    feed = parseFeed(body);
  } catch (error) {
    logWarn(`  Parse error for feed ${feedId}: ${formatError(error)}`);
    await db.updateFeedFetched(d1, feedId, status);
    return 0;
  }

  // 3. Insert new entries in batches (D1 batch API)
  let newCount = 0;

  const statements = [];
  for (const entry of feed.entries) {
    const title = entry.title ?? "";
    const author = extractEntryAuthor(entry, feed);
    const entryUrl = entry.links.length > 0 ? entry.links[0].href : "";
    const html = extractContent(entry);

    // Use entry.published or updated as timestamp, fallback to now
    const publishedDate = entry.published ?? entry.updated;
    const published = publishedDate
      ? Math.floor(publishedDate.getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    statements.push(
      d1
        .prepare(
          "INSERT OR IGNORE INTO items (feed_id, title, author, html, url, is_saved, created_on) \
           VALUES (?, ?, ?, ?, ?, 0, ?)",
        )
        .bind(feedId, title, author, html, entryUrl, published),
    );
  }

  // Execute in batches of `BATCH_SIZE`
  for (let offset = 0; offset < statements.length; offset += BATCH_SIZE) {
    const chunk = statements.slice(offset, offset + BATCH_SIZE);
    try {
      const results = await d1.batch(chunk);
      for (const result of results) {
        // rows_written > 0 means a new row was inserted (not ignored by dedup)
        const written = result && result.meta ? result.meta.rows_written ?? 0 : 0;
        if (written > 0) {
          newCount += 1;
        }
      }
    } catch (error) {
      logWarn(`  Batch insert error for feed ${feedId}: ${formatError(error)}`);
    }
  }

  // 4. Update last_fetched_on and http status
  await db.updateFeedFetched(d1, feedId, status);
  return newCount;
}

/**
 * Extract HTML content from a feed entry.
 * Prefers content, then summary, then media description.
 */
export function extractContent(entry) {
  if (entry.content && entry.content.body !== null && entry.content.body !== undefined) {
    return entry.content.body;
  }
  if (entry.summary) {
    return entry.summary.content;
  }
  if (entry.media.length > 0 && entry.media[0].description !== null) {
    return entry.media[0].description;
  }
  return "";
}

/**
 * Extract the best author name for a feed entry, using cascading fallbacks:
 * 1. Entry-level author name (non-empty, trimmed)
 * 2. Feed-level author name (non-empty, trimmed)
 * 3. First non-empty entry-level contributor name (trimmed)
 * 4. Empty string
 */
export function extractEntryAuthor(entry, feed) {
  if (entry.authors.length > 0) {
    const name = (entry.authors[0].name ?? "").trim();
    if (name !== "") {
      return name;
    }
  }
  if (feed.authors.length > 0) {
    const name = (feed.authors[0].name ?? "").trim();
    if (name !== "") {
      return name;
    }
  }
  for (const contributor of entry.contributors) {
    const name = (contributor.name ?? "").trim();
    if (name !== "") {
      return name;
    }
  }
  return "";
}
