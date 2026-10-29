// D1 database access layer.
//
// Every function takes the D1 binding explicitly, mirroring the Rust `db.rs`
// module. Queries and bindings are kept identical to the Rust implementation.

const FEED_COLUMNS =
  "id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on";
const ITEM_COLUMNS = "id, feed_id, title, author, html, url, is_saved, created_on";

/**
 * Runs a SELECT and returns the result rows.
 * @param {D1Database} d1
 * @param {string} sql
 * @param {unknown[]} bindings
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function all(d1, sql, bindings = []) {
  const statement = d1.prepare(sql);
  const bound = bindings.length > 0 ? statement.bind(...bindings) : statement;
  const result = await bound.all();
  return result.results ?? [];
}

async function run(d1, sql, bindings = []) {
  const statement = d1.prepare(sql);
  const bound = bindings.length > 0 ? statement.bind(...bindings) : statement;
  await bound.run();
}

// ── Groups ──

export async function listGroups(d1) {
  return all(d1, "SELECT id, title, created_on FROM groups ORDER BY id ASC");
}

export async function listGroupsWithCounts(d1) {
  return all(
    d1,
    "SELECT g.id, g.title, g.created_on, COUNT(f.id) AS subscription_count \
     FROM groups g LEFT JOIN feeds f ON g.id = f.group_id \
     GROUP BY g.id ORDER BY g.id ASC",
  );
}

export async function getGroup(d1, id) {
  const rows = await all(d1, "SELECT id, title, created_on FROM groups WHERE id = ?", [id]);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export async function createGroup(d1, title) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await all(
    d1,
    "INSERT INTO groups (title, created_on) VALUES (?, ?) RETURNING id, title, created_on",
    [title, now],
  );
  if (rows.length === 0) {
    throw new Error("failed to retrieve created group");
  }
  return rows[rows.length - 1];
}

export async function updateGroup(d1, id, title) {
  await run(d1, "UPDATE groups SET title = ? WHERE id = ?", [title, id]);
}

export async function deleteGroup(d1, id) {
  // Move feeds in this group to group_id = 0 (ungrouped)
  await d1.batch([
    d1.prepare("UPDATE feeds SET group_id = 0 WHERE group_id = ?").bind(id),
    d1.prepare("DELETE FROM groups WHERE id = ?").bind(id),
  ]);
}

export async function countFeedsInGroup(d1, groupId) {
  const rows = await all(d1, "SELECT COUNT(*) AS count FROM feeds WHERE group_id = ?", [groupId]);
  return rows.length > 0 ? rows[0].count : 0;
}

// ── Feeds ──

export async function listFeeds(d1) {
  return all(d1, `SELECT ${FEED_COLUMNS} FROM feeds ORDER BY id ASC`);
}

export async function listFeedsWithCounts(d1) {
  return all(d1, `SELECT f.*, COALESCE(c.item_count, 0) AS item_count,
    COALESCE(c.unread_count, 0) AS unread_count FROM feeds f LEFT JOIN (
      SELECT i.feed_id, COUNT(*) AS item_count,
        SUM(CASE WHEN r.item_id IS NULL THEN 1 ELSE 0 END) AS unread_count
      FROM items i LEFT JOIN read_item_ids r ON r.item_id = i.id GROUP BY i.feed_id
    ) c ON c.feed_id = f.id ORDER BY f.id DESC`);
}

export async function updateFeed(d1, id, title, url, siteUrl, groupId) {
  await run(d1, `UPDATE feeds SET title = ?, site_url = ?, group_id = ?,
    last_fetched_on = CASE WHEN url != ? THEN 0 ELSE last_fetched_on END,
    last_http_status = CASE WHEN url != ? THEN 0 ELSE last_http_status END,
    url = ? WHERE id = ?`, [title, siteUrl, groupId, url, url, url, id]);
}

export async function getFeed(d1, id) {
  const rows = await all(d1, `SELECT ${FEED_COLUMNS} FROM feeds WHERE id = ?`, [id]);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

export async function createFeed(d1, title, url, siteUrl, groupId) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await all(
    d1,
    "INSERT INTO feeds (title, url, site_url, group_id, last_fetched_on, last_http_status, created_on) \
     VALUES (?, ?, ?, ?, 0, 0, ?) RETURNING " + FEED_COLUMNS,
    [title, url, siteUrl, groupId, now],
  );
  if (rows.length === 0) {
    throw new Error("failed to retrieve created feed");
  }
  return rows[rows.length - 1];
}

export async function deleteFeed(d1, id) {
  await d1.batch([
    d1.prepare("DELETE FROM read_item_ids WHERE item_id IN (SELECT id FROM items WHERE feed_id = ?)").bind(id),
    d1.prepare("DELETE FROM items WHERE feed_id = ?").bind(id),
    d1.prepare("DELETE FROM feeds WHERE id = ?").bind(id),
  ]);
}

export async function listFeedsByGroup(d1) {
  return all(
    d1,
    "SELECT group_id, GROUP_CONCAT(CAST(id AS TEXT), ',') AS feed_ids \
     FROM feeds GROUP BY group_id ORDER BY group_id ASC",
  );
}

/**
 * Get feeds that need fetching — only those not fetched within the last
 * `staleSeconds`. Ordered by last_fetched_on ascending (oldest first).
 */
export async function getFeedsToFetch(d1, staleSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const since = Math.max(0, now - staleSeconds);
  return all(
    d1,
    `SELECT ${FEED_COLUMNS} FROM feeds WHERE last_fetched_on <= ? ORDER BY last_fetched_on ASC`,
    [since],
  );
}

export async function updateFeedFetched(d1, feedId, lastHttpStatus) {
  const now = Math.floor(Date.now() / 1000);
  await run(d1, "UPDATE feeds SET last_fetched_on = ?, last_http_status = ? WHERE id = ?", [
    now,
    lastHttpStatus,
    feedId,
  ]);
}

export async function getMaxFeedFetchedOn(d1) {
  const rows = await all(
    d1,
    "SELECT COALESCE(MAX(last_fetched_on), 0) AS value FROM feeds",
  );
  return rows.length > 0 ? rows[0].value : 0;
}

// ── Items ──

export async function getItemsSince(d1, sinceId, limit) {
  return all(
    d1,
    `SELECT ${ITEM_COLUMNS} FROM items WHERE id > ? ORDER BY id ASC LIMIT ?`,
    [sinceId, limit],
  );
}

export async function getItemsMax(d1, maxId, limit) {
  return all(
    d1,
    `SELECT ${ITEM_COLUMNS} FROM items WHERE id <= ? ORDER BY id DESC LIMIT ?`,
    [maxId, limit],
  );
}

export async function getItemsByIds(d1, ids) {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `SELECT ${ITEM_COLUMNS} FROM items WHERE id IN (${placeholders}) ORDER BY id ASC`;
  return all(d1, sql, ids);
}

export async function getTotalItems(d1) {
  const rows = await all(d1, "SELECT COUNT(*) AS count FROM items");
  return rows.length > 0 ? rows[0].count : 0;
}

export async function getSavedItemIds(d1) {
  const rows = await all(d1, "SELECT id FROM items WHERE is_saved = 1 ORDER BY id ASC");
  return rows.map((row) => row.id);
}

export async function getReadItemIds(d1) {
  const rows = await all(d1, "SELECT item_id FROM read_item_ids ORDER BY item_id ASC");
  return rows.map((row) => row.item_id);
}

export async function getReadItemIdsByIds(d1, ids) {
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `SELECT item_id FROM read_item_ids WHERE item_id IN (${placeholders})`;
  const rows = await all(d1, sql, ids);
  return rows.map((row) => row.item_id);
}

/**
 * Get unread item IDs (all items minus those marked as read).
 *
 * Uses NOT EXISTS instead of LEFT JOIN ... IS NULL for better SQLite
 * query plan. With read_item_ids.item_id being INTEGER PRIMARY KEY,
 * the inner subquery can short-circuit (stop at first match) rather than
 * scanning all read IDs per item.
 */
export async function getUnreadItemIds(d1) {
  const rows = await all(
    d1,
    "SELECT i.id FROM items i \
     WHERE NOT EXISTS ( \
         SELECT 1 FROM read_item_ids r WHERE r.item_id = i.id \
     ) \
     ORDER BY i.id ASC",
  );
  return rows.map((row) => row.id);
}

// ── Mark operations ──

export async function markRead(d1, itemId) {
  await run(d1, "INSERT OR IGNORE INTO read_item_ids (item_id) VALUES (?)", [itemId]);
}

export async function markUnread(d1, itemId) {
  await run(d1, "DELETE FROM read_item_ids WHERE item_id = ?", [itemId]);
}

export async function markSaved(d1, itemId) {
  await run(d1, "UPDATE items SET is_saved = 1 WHERE id = ?", [itemId]);
}

export async function markUnsaved(d1, itemId) {
  await run(d1, "UPDATE items SET is_saved = 0 WHERE id = ?", [itemId]);
}

export async function markReadBeforeFeed(d1, feedId, beforeTs) {
  await run(
    d1,
    "INSERT OR IGNORE INTO read_item_ids (item_id) \
     SELECT id FROM items WHERE feed_id = ? AND created_on <= ?",
    [feedId, beforeTs],
  );
}

export async function markReadBeforeGroup(d1, groupId, beforeTs) {
  await run(
    d1,
    "INSERT OR IGNORE INTO read_item_ids (item_id) \
     SELECT items.id FROM items \
     JOIN feeds ON items.feed_id = feeds.id \
     WHERE feeds.group_id = ? AND items.created_on <= ?",
    [groupId, beforeTs],
  );
}

/** Mark all items with created_on <= beforeTs as read (for Kindling super group). */
export async function markReadBeforeAll(d1, beforeTs) {
  await run(
    d1,
    "INSERT OR IGNORE INTO read_item_ids (item_id) \
     SELECT id FROM items WHERE created_on <= ?",
    [beforeTs],
  );
}

/** Insert a new item if it doesn't already exist (dedup by feed_id + url). */
export async function insertItemIfNew(d1, item) {
  await run(
    d1,
    "INSERT OR IGNORE INTO items (feed_id, title, author, html, url, is_saved, created_on) \
     VALUES (?, ?, ?, ?, ?, 0, ?)",
    [item.feed_id, item.title, item.author, item.html, item.url, item.created_on],
  );
}
