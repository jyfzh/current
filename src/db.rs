use crate::models::*;
use wasm_bindgen::JsValue;
use worker::*;

// ── Groups ──

pub async fn list_groups(d1: &D1Database) -> Result<Vec<GroupRow>> {
    let result = d1
        .prepare("SELECT id, title, created_on FROM groups ORDER BY id ASC")
        .all()
        .await?;
    result.results::<GroupRow>()
}

pub async fn list_groups_with_counts(d1: &D1Database) -> Result<Vec<GroupWithCountRow>> {
    let result = d1
        .prepare(
            "SELECT g.id, g.title, g.created_on, COUNT(f.id) AS subscription_count \
             FROM groups g LEFT JOIN feeds f ON g.id = f.group_id \
             GROUP BY g.id ORDER BY g.id ASC",
        )
        .all()
        .await?;
    result.results::<GroupWithCountRow>()
}

pub async fn get_group(d1: &D1Database, id: u64) -> Result<Option<GroupRow>> {
    let result = d1
        .prepare("SELECT id, title, created_on FROM groups WHERE id = ?")
        .bind(&[JsValue::from(id as f64)])?
        .all()
        .await?;
    let mut rows = result.results::<GroupRow>()?;
    Ok(rows.pop())
}

pub async fn create_group(d1: &D1Database, title: &str) -> Result<GroupRow> {
    let now = chrono::Utc::now().timestamp() as u64;
    d1.prepare("INSERT INTO groups (title, created_on) VALUES (?, ?)")
        .bind(&[JsValue::from(title), JsValue::from(now as f64)])?
        .run()
        .await?;
    let result = d1
        .prepare("SELECT id, title, created_on FROM groups WHERE id = last_insert_rowid()")
        .all()
        .await?;
    let mut rows = result.results::<GroupRow>()?;
    rows.pop()
        .ok_or_else(|| Error::RustError("failed to retrieve created group".into()))
}

pub async fn update_group(d1: &D1Database, id: u64, title: &str) -> Result<()> {
    d1.prepare("UPDATE groups SET title = ? WHERE id = ?")
        .bind(&[JsValue::from(title), JsValue::from(id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn delete_group(d1: &D1Database, id: u64) -> Result<()> {
    // Move feeds in this group to group_id = 0 (ungrouped)
    d1.prepare("UPDATE feeds SET group_id = 0 WHERE group_id = ?")
        .bind(&[JsValue::from(id as f64)])?
        .run()
        .await?;
    d1.prepare("DELETE FROM groups WHERE id = ?")
        .bind(&[JsValue::from(id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn count_feeds_in_group(d1: &D1Database, group_id: u64) -> Result<u64> {
    let result = d1
        .prepare("SELECT COUNT(*) AS count FROM feeds WHERE group_id = ?")
        .bind(&[JsValue::from(group_id as f64)])?
        .all()
        .await?;
    let rows = result.results::<CountRow>()?;
    Ok(rows.first().map(|r| r.count).unwrap_or(0))
}

// ── Feeds ──

pub async fn list_feeds(d1: &D1Database) -> Result<Vec<FeedRow>> {
    let result = d1
        .prepare(
            "SELECT id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on \
             FROM feeds ORDER BY id ASC",
        )
        .all()
        .await?;
    result.results::<FeedRow>()
}

pub async fn get_feed(d1: &D1Database, id: u64) -> Result<Option<FeedRow>> {
    let result = d1
        .prepare(
            "SELECT id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on \
             FROM feeds WHERE id = ?",
        )
        .bind(&[JsValue::from(id as f64)])?
        .all()
        .await?;
    let mut rows = result.results::<FeedRow>()?;
    Ok(rows.pop())
}

pub async fn create_feed(
    d1: &D1Database,
    title: &str,
    url: &str,
    site_url: &str,
    group_id: u64,
) -> Result<FeedRow> {
    let now = chrono::Utc::now().timestamp() as u64;
    d1.prepare(
        "INSERT INTO feeds (title, url, site_url, group_id, last_fetched_on, last_http_status, created_on) \
         VALUES (?, ?, ?, ?, 0, 0, ?)",
    )
    .bind(&[
        JsValue::from(title),
        JsValue::from(url),
        JsValue::from(site_url),
        JsValue::from(group_id as f64),
        JsValue::from(now as f64),
    ])?
    .run()
    .await?;
    let result = d1
        .prepare(
            "SELECT id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on \
             FROM feeds WHERE id = last_insert_rowid()",
        )
        .all()
        .await?;
    let mut rows = result.results::<FeedRow>()?;
    rows.pop()
        .ok_or_else(|| Error::RustError("failed to retrieve created feed".into()))
}

pub async fn delete_feed(d1: &D1Database, id: u64) -> Result<()> {
    // Delete associated read_item_ids first
    d1.prepare(
        "DELETE FROM read_item_ids WHERE item_id IN (SELECT id FROM items WHERE feed_id = ?)",
    )
    .bind(&[JsValue::from(id as f64)])?
    .run()
    .await?;
    // Delete items belonging to this feed
    d1.prepare("DELETE FROM items WHERE feed_id = ?")
        .bind(&[JsValue::from(id as f64)])?
        .run()
        .await?;
    // Delete the feed itself
    d1.prepare("DELETE FROM feeds WHERE id = ?")
        .bind(&[JsValue::from(id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn list_feeds_by_group(d1: &D1Database) -> Result<Vec<FeedsGroupRow>> {
    let result = d1
        .prepare(
            "SELECT group_id, GROUP_CONCAT(CAST(id AS TEXT), ',') AS feed_ids \
             FROM feeds GROUP BY group_id ORDER BY group_id ASC",
        )
        .all()
        .await?;
    result.results::<FeedsGroupRow>()
}

/// Get feeds that need fetching — only those not fetched within the last `stale_seconds`.
/// Ordered by last_fetched_on ascending (oldest first).
pub async fn get_feeds_to_fetch(d1: &D1Database, stale_seconds: u64) -> Result<Vec<FeedRow>> {
    let now = chrono::Utc::now().timestamp() as u64;
    let since = now.saturating_sub(stale_seconds);
    let result = d1
        .prepare(
            "SELECT id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on \
             FROM feeds WHERE last_fetched_on <= ? ORDER BY last_fetched_on ASC",
        )
        .bind(&[JsValue::from(since as f64)])?
        .all()
        .await?;
    result.results::<FeedRow>()
}

pub async fn update_feed_fetched(
    d1: &D1Database,
    feed_id: u64,
    last_http_status: u64,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp() as u64;
    d1.prepare("UPDATE feeds SET last_fetched_on = ?, last_http_status = ? WHERE id = ?")
        .bind(&[
            JsValue::from(now as f64),
            JsValue::from(last_http_status as f64),
            JsValue::from(feed_id as f64),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn get_max_feed_fetched_on(d1: &D1Database) -> Result<u64> {
    #[derive(serde::Deserialize)]
    struct ValueRow {
        value: u64,
    }

    let result = d1
        .prepare("SELECT COALESCE(MAX(last_fetched_on), 0) AS value FROM feeds")
        .all()
        .await?;
    let rows = result.results::<ValueRow>()?;
    Ok(rows.first().map(|r| r.value).unwrap_or(0))
}

// ── Items ──

pub async fn get_items_since(d1: &D1Database, since_id: u64, limit: u64) -> Result<Vec<ItemRow>> {
    let result = d1
        .prepare(
            "SELECT id, feed_id, title, author, html, url, is_saved, created_on \
             FROM items WHERE id > ? ORDER BY id ASC LIMIT ?",
        )
        .bind(&[JsValue::from(since_id as f64), JsValue::from(limit as f64)])?
        .all()
        .await?;
    result.results::<ItemRow>()
}

pub async fn get_items_max(d1: &D1Database, max_id: u64, limit: u64) -> Result<Vec<ItemRow>> {
    let result = d1
        .prepare(
            "SELECT id, feed_id, title, author, html, url, is_saved, created_on \
             FROM items WHERE id <= ? ORDER BY id DESC LIMIT ?",
        )
        .bind(&[JsValue::from(max_id as f64), JsValue::from(limit as f64)])?
        .all()
        .await?;
    result.results::<ItemRow>()
}

pub async fn get_items_by_ids(d1: &D1Database, ids: &[u64]) -> Result<Vec<ItemRow>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT id, feed_id, title, author, html, url, is_saved, created_on \
         FROM items WHERE id IN ({}) ORDER BY id ASC",
        placeholders.join(",")
    );
    let mut stmt = d1.prepare(&sql);
    let bindings: Vec<JsValue> = ids.iter().map(|id| JsValue::from(*id as f64)).collect();
    stmt = stmt.bind(&bindings)?;
    let result = stmt.all().await?;
    result.results::<ItemRow>()
}

pub async fn get_total_items(d1: &D1Database) -> Result<u64> {
    let result = d1
        .prepare("SELECT COUNT(*) AS count FROM items")
        .all()
        .await?;
    let rows = result.results::<CountRow>()?;
    Ok(rows.first().map(|r| r.count).unwrap_or(0))
}

pub async fn get_saved_item_ids(d1: &D1Database) -> Result<Vec<u64>> {
    let result = d1
        .prepare("SELECT id FROM items WHERE is_saved = 1 ORDER BY id ASC")
        .all()
        .await?;
    let rows = result.results::<IdOnlyRow>()?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

pub async fn get_read_item_ids(d1: &D1Database) -> Result<Vec<u64>> {
    let result = d1
        .prepare("SELECT item_id FROM read_item_ids ORDER BY item_id ASC")
        .all()
        .await?;
    let rows = result.results::<ItemIdRow>()?;
    Ok(rows.into_iter().map(|r| r.item_id).collect())
}

pub async fn get_read_item_ids_by_ids(d1: &D1Database, ids: &[u64]) -> Result<Vec<u64>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "SELECT item_id FROM read_item_ids WHERE item_id IN ({})",
        placeholders.join(",")
    );
    let bindings: Vec<JsValue> = ids.iter().map(|id| JsValue::from(*id as f64)).collect();
    let result = d1.prepare(&sql).bind(&bindings)?.all().await?;
    let rows = result.results::<ItemIdRow>()?;
    Ok(rows.into_iter().map(|r| r.item_id).collect())
}

/// Get unread item IDs (all items minus those marked as read).
///
/// Uses NOT EXISTS instead of LEFT JOIN ... IS NULL for better SQLite
/// query plan. With read_item_ids.item_id being INTEGER PRIMARY KEY,
/// the inner subquery can short-circuit (stop at first match) rather than
/// scanning all read IDs per item.
pub async fn get_unread_item_ids(d1: &D1Database) -> Result<Vec<u64>> {
    let result = d1
        .prepare(
            "SELECT i.id FROM items i \
             WHERE NOT EXISTS (
                 SELECT 1 FROM read_item_ids r WHERE r.item_id = i.id
             ) \
             ORDER BY i.id ASC",
        )
        .all()
        .await?;
    let rows = result.results::<IdOnlyRow>()?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

// ── Mark operations ──

pub async fn mark_read(d1: &D1Database, item_id: u64) -> Result<()> {
    d1.prepare("INSERT OR IGNORE INTO read_item_ids (item_id) VALUES (?)")
        .bind(&[JsValue::from(item_id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn mark_unread(d1: &D1Database, item_id: u64) -> Result<()> {
    d1.prepare("DELETE FROM read_item_ids WHERE item_id = ?")
        .bind(&[JsValue::from(item_id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn mark_saved(d1: &D1Database, item_id: u64) -> Result<()> {
    d1.prepare("UPDATE items SET is_saved = 1 WHERE id = ?")
        .bind(&[JsValue::from(item_id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn mark_unsaved(d1: &D1Database, item_id: u64) -> Result<()> {
    d1.prepare("UPDATE items SET is_saved = 0 WHERE id = ?")
        .bind(&[JsValue::from(item_id as f64)])?
        .run()
        .await?;
    Ok(())
}

pub async fn mark_read_before_feed(d1: &D1Database, feed_id: u64, before_ts: u64) -> Result<()> {
    d1.prepare(
        "INSERT OR IGNORE INTO read_item_ids (item_id) \
         SELECT id FROM items WHERE feed_id = ? AND created_on <= ?",
    )
    .bind(&[
        JsValue::from(feed_id as f64),
        JsValue::from(before_ts as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn mark_read_before_group(d1: &D1Database, group_id: u64, before_ts: u64) -> Result<()> {
    d1.prepare(
        "INSERT OR IGNORE INTO read_item_ids (item_id) \
         SELECT items.id FROM items \
         JOIN feeds ON items.feed_id = feeds.id \
         WHERE feeds.group_id = ? AND items.created_on <= ?",
    )
    .bind(&[
        JsValue::from(group_id as f64),
        JsValue::from(before_ts as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Mark all items with created_on <= before_ts as read (for Kindling super group).
pub async fn mark_read_before_all(d1: &D1Database, before_ts: u64) -> Result<()> {
    d1.prepare(
        "INSERT OR IGNORE INTO read_item_ids (item_id) \
         SELECT id FROM items WHERE created_on <= ?",
    )
    .bind(&[JsValue::from(before_ts as f64)])?
    .run()
    .await?;
    Ok(())
}

/// Insert a new item if it doesn't already exist (dedup by feed_id + url).
pub async fn insert_item_if_new(d1: &D1Database, item: &ItemRow) -> Result<()> {
    d1.prepare(
        "INSERT OR IGNORE INTO items (feed_id, title, author, html, url, is_saved, created_on) \
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&[
        JsValue::from(item.feed_id as f64),
        JsValue::from(&item.title),
        JsValue::from(&item.author),
        JsValue::from(&item.html),
        JsValue::from(&item.url),
        JsValue::from(item.created_on as f64),
    ])?
    .run()
    .await?;
    Ok(())
}

// ── Helper row types (defined in models.rs) ──
// CountRow, IdOnlyRow, ItemIdRow, GroupWithCountRow, FeedsGroupRow
