use crate::db;
use futures::stream::{self, StreamExt};
use wasm_bindgen::JsValue;
use worker::*;

/// Summary of one feed sync run.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FeedSyncSummary {
    pub attempted: u64,
    pub succeeded: u64,
    pub failed: u64,
    pub updated_feed_ids: Vec<u64>,
    pub new_items: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
struct FeedFetchOutcome {
    feed_id: u64,
    new_items: u64,
    ok: bool,
}

fn concurrency_window(max_concurrency: usize, total_jobs: usize) -> usize {
    if total_jobs == 0 {
        return 1;
    }
    if max_concurrency == 0 {
        total_jobs
    } else {
        max_concurrency.min(total_jobs).max(1)
    }
}

/// Fetch all feeds that need updating.
///
/// `max_concurrency` controls how many feeds are fetched simultaneously.
/// `0` means no limit (all jobs in a single window).
/// `stale_seconds` controls how old a feed must be before it's eligible for re-fetch.
pub async fn fetch_all_feeds(
    d1: &D1Database,
    max_concurrency: usize,
    stale_seconds: u64,
) -> Result<FeedSyncSummary> {
    let started = chrono::Utc::now();
    let feeds = db::get_feeds_to_fetch(d1, stale_seconds).await?;
    let attempted = feeds.len() as u64;

    // Collect fetch jobs
    let jobs: Vec<(u64, String, String)> =
        feeds.into_iter().map(|f| (f.id, f.title, f.url)).collect();

    let window = concurrency_window(max_concurrency, jobs.len());
    let outcomes: Vec<FeedFetchOutcome> = stream::iter(jobs.into_iter())
        .map(|(feed_id, title, feed_url)| async move {
            match fetch_single_feed(d1, feed_id, &feed_url).await {
                Ok(new_items) => {
                    crate::log_info!("  Fetched feed {}: {} ({} new)", feed_id, title, new_items);
                    FeedFetchOutcome {
                        feed_id,
                        new_items,
                        ok: true,
                    }
                }
                Err(e) => {
                    crate::log_error!("  Error fetching feed {} ({}): {:?}", feed_id, title, e);
                    FeedFetchOutcome {
                        feed_id,
                        new_items: 0,
                        ok: false,
                    }
                }
            }
        })
        .buffer_unordered(window)
        .collect()
        .await;

    let jobs_total = outcomes.len() as u64;
    let succeeded_jobs = outcomes.iter().filter(|o| o.ok).count() as u64;
    let failed_jobs = outcomes.iter().filter(|o| !o.ok).count() as u64;
    let skipped_without_url = attempted.saturating_sub(jobs_total);
    let succeeded = succeeded_jobs + skipped_without_url;

    let updated_feed_ids: Vec<u64> = outcomes
        .iter()
        .filter(|o| o.ok && o.new_items > 0)
        .map(|o| o.feed_id)
        .collect();
    let new_items = outcomes.iter().filter(|o| o.ok).map(|o| o.new_items).sum();
    let duration_ms = (chrono::Utc::now() - started).num_milliseconds().max(0) as u64;

    Ok(FeedSyncSummary {
        attempted,
        succeeded,
        failed: failed_jobs,
        updated_feed_ids,
        new_items,
        duration_ms,
    })
}

/// Fetch a single feed by its database ID and synchronize its items.
#[allow(dead_code)]
pub async fn fetch_feed_by_id(d1: &D1Database, feed_id: u64) -> Result<()> {
    let feed = match db::get_feed(d1, feed_id).await? {
        Some(f) => f,
        None => {
            return Err(Error::RustError(format!("feed {} not found", feed_id)));
        }
    };

    fetch_single_feed(d1, feed.id, &feed.url).await?;
    Ok(())
}

/// Fetch and parse a single feed, storing new entries.
/// Returns the number of new items inserted.
async fn fetch_single_feed(d1: &D1Database, feed_id: u64, url: &str) -> Result<u64> {
    // 1. HTTP GET the feed using the Worker Fetch API
    let parsed_url = match Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            crate::log_warn!("  Invalid URL for feed {}: {:?}", feed_id, e);
            db::update_feed_fetched(d1, feed_id, 0).await?;
            return Ok(0);
        }
    };
    let headers = Headers::new();
    headers.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    )?;
    let req = Request::new_with_init(
        &parsed_url.to_string(),
        RequestInit::new().with_headers(headers),
    )?;
    let mut resp = Fetch::Request(req).send().await?;

    let status = resp.status_code();
    if status < 200 || status >= 300 {
        crate::log_warn!("  HTTP {} for feed {}", status, url);
        // Still update last_fetched_on to avoid hammering failing feeds
        db::update_feed_fetched(d1, feed_id, status as u64).await?;
        return Ok(0);
    }

    let body = resp.bytes().await?;

    // 2. Parse the feed using feed-rs
    let feed = match feed_rs::parser::parse(body.as_slice()) {
        Ok(f) => f,
        Err(e) => {
            crate::log_warn!("  Parse error for feed {}: {:?}", feed_id, e);
            db::update_feed_fetched(d1, feed_id, status as u64).await?;
            return Ok(0);
        }
    };

    // 3. Insert new entries in batches (D1 batch API)
    let mut new_count = 0u64;
    let batch_size = 100;

    // Collect all entries into statements first
    let mut all_stmts: Vec<D1PreparedStatement> = Vec::new();
    for entry in &feed.entries {
        let title = entry
            .title
            .as_ref()
            .map(|t| t.content.as_str())
            .unwrap_or("")
            .to_string();
        let author = extract_entry_author(entry, &feed);
        let url = entry
            .links
            .first()
            .map(|l| l.href.as_str())
            .unwrap_or("")
            .to_string();
        let html = extract_content(entry);

        // Use entry.published or updated as timestamp, fallback to now
        let published = entry
            .published
            .or(entry.updated)
            .map(|dt| dt.timestamp() as u64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);

        let stmt = d1
            .prepare(
                "INSERT OR IGNORE INTO items (feed_id, title, author, html, url, is_saved, created_on) \
                 VALUES (?, ?, ?, ?, ?, 0, ?)",
            )
            .bind(&[
                JsValue::from(feed_id as f64),
                JsValue::from(title),
                JsValue::from(author),
                JsValue::from(html),
                JsValue::from(url),
                JsValue::from(published as f64),
            ])?;
        all_stmts.push(stmt);
    }

    // Execute in batches of `batch_size`
    for chunk in all_stmts.chunks(batch_size) {
        match d1.batch(chunk.to_vec()).await {
            Ok(results) => {
                for result in results.iter() {
                    // rows_written > 0 means a new row was inserted (not ignored by dedup)
                    if result
                        .meta()
                        .ok()
                        .flatten()
                        .and_then(|m| m.rows_written)
                        .unwrap_or(0)
                        > 0
                    {
                        new_count += 1;
                    }
                }
            }
            Err(e) => crate::log_warn!("  Batch insert error for feed {}: {:?}", feed_id, e),
        }
    }

    // 4. Update last_fetched_on and http status
    db::update_feed_fetched(d1, feed_id, status as u64).await?;
    Ok(new_count)
}

/// Extract HTML content from a feed entry.
fn extract_content(entry: &feed_rs::model::Entry) -> String {
    // Prefer content, then summary, then description
    if let Some(ref content) = entry.content {
        if let Some(ref body) = content.body {
            return body.clone();
        }
    }
    if let Some(ref summary) = entry.summary {
        return summary.content.clone();
    }
    if let Some(ref media) = entry.media.first() {
        if let Some(ref desc) = media.description {
            return desc.content.clone();
        }
    }
    String::new()
}

/// Extract the best author name for a feed entry, using cascading fallbacks:
/// 1. Entry-level author name (non-empty, trimmed)
/// 2. Feed-level author name (non-empty, trimmed)
/// 3. First non-empty entry-level contributor name (trimmed)
/// 4. Empty string
fn extract_entry_author(entry: &feed_rs::model::Entry, feed: &feed_rs::model::Feed) -> String {
    // Check entry authors first
    if let Some(author) = entry.authors.first() {
        let name = author.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    // Fall back to feed-level authors
    if let Some(author) = feed.authors.first() {
        let name = author.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    // Fall back to first non-empty contributor name
    for contributor in &entry.contributors {
        let name = contributor.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use feed_rs::model::*;

    // ── concurrency_window tests ──

    #[test]
    fn test_concurrency_window_unlimited_uses_total_jobs() {
        assert_eq!(concurrency_window(0, 7), 7);
    }

    #[test]
    fn test_concurrency_window_caps_to_total_jobs() {
        assert_eq!(concurrency_window(10, 3), 3);
    }

    #[test]
    fn test_concurrency_window_minimum_one() {
        assert_eq!(concurrency_window(5, 0), 1);
    }

    // ── Helpers to construct feed_rs types for tests ──

    fn make_person(name: &str) -> Person {
        // Build directly since all Person fields are pub.
        Person {
            name: name.to_string(),
            uri: None,
            email: None,
        }
    }

    fn make_entry(authors: Vec<Person>, contributors: Vec<Person>) -> Entry {
        serde_json::from_value(serde_json::json!({
            "id": "1",
            "authors": authors,
            "contributors": contributors,
            "links": [],
            "categories": [],
            "media": []
        }))
        .expect("make_entry: failed to construct Entry")
    }

    fn make_feed(authors: Vec<Person>, entries: Vec<Entry>) -> Feed {
        serde_json::from_value(serde_json::json!({
            "id": "feed1",
            "feed_type": "RSS2",
            "authors": authors,
            "entries": entries,
            "links": [],
            "categories": [],
            "contributors": []
        }))
        .expect("make_feed: failed to construct Feed")
    }

    // ── extract_entry_author tests ──

    #[test]
    fn test_author_uses_entry_author_when_present() {
        let entry = make_entry(vec![make_person("Alice")], vec![]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Alice");
    }

    #[test]
    fn test_author_falls_back_to_feed_author_when_entry_author_empty() {
        let entry = make_entry(vec![make_person("")], vec![]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Feed Author");
    }

    #[test]
    fn test_author_falls_back_to_feed_author_when_entry_has_no_authors() {
        let entry = make_entry(vec![], vec![]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Feed Author");
    }

    #[test]
    fn test_author_falls_back_to_contributor_when_entry_and_feed_authors_empty() {
        let entry = make_entry(vec![], vec![make_person("Contributor")]);
        let feed = make_feed(vec![], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Contributor");
    }

    #[test]
    fn test_author_uses_entry_author_over_contributor() {
        // Entry author should take priority over contributor
        let entry = make_entry(vec![make_person("Alice")], vec![make_person("Contributor")]);
        let feed = make_feed(vec![], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Alice");
    }

    #[test]
    fn test_author_uses_feed_author_over_contributor() {
        // Feed author should take priority over contributor
        let entry = make_entry(vec![], vec![make_person("Contributor")]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Feed Author");
    }

    #[test]
    fn test_author_uses_first_entry_author_when_multiple() {
        let entry = make_entry(
            vec![make_person("First Author"), make_person("Second Author")],
            vec![],
        );
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "First Author");
    }

    #[test]
    fn test_author_returns_empty_when_all_sources_empty() {
        let entry = make_entry(vec![], vec![]);
        let feed = make_feed(vec![], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "");
    }

    #[test]
    fn test_author_filters_whitespace_only_entry_name_and_falls_back() {
        let entry = make_entry(vec![make_person("   ")], vec![]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Feed Author");
    }

    #[test]
    fn test_author_first_non_empty_contributor_used() {
        let entry = make_entry(
            vec![],
            vec![
                make_person(""),
                make_person("Contributor B"),
                make_person("Contributor C"),
            ],
        );
        let feed = make_feed(vec![], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Contributor B");
    }

    #[test]
    fn test_author_feed_author_preferred_over_contributor() {
        // Feed author non-empty should be preferred over contributor
        let entry = make_entry(vec![], vec![make_person("Contributor")]);
        let feed = make_feed(vec![make_person("Feed Author")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "Feed Author");
    }

    #[test]
    fn test_author_full_chain_all_empty() {
        let entry = make_entry(vec![make_person("")], vec![make_person("")]);
        let feed = make_feed(vec![make_person("")], vec![entry]);
        let author = extract_entry_author(&feed.entries[0], &feed);
        assert_eq!(author, "");
    }

    // ── extract_content tests ──

    fn make_entry_with_content(
        content_body: Option<&str>,
        summary: Option<&str>,
        media_desc: Option<&str>,
    ) -> Entry {
        let mut entry_val = serde_json::json!({
            "id": "1",
            "authors": [],
            "contributors": [],
            "links": [],
            "categories": [],
            "media": []
        });

        if let Some(body) = content_body {
            entry_val["content"] = serde_json::json!({
                "body": body,
                "content_type": "text/html"
            });
        }

        if let Some(sum) = summary {
            entry_val["summary"] = serde_json::json!({
                "content": sum,
                "content_type": "text/plain"
            });
        }

        if let Some(desc) = media_desc {
            entry_val["media"] = serde_json::json!([{
                "description": {
                    "content": desc,
                    "content_type": "text/plain"
                },
                "content": [],
                "thumbnails": [],
                "texts": [],
                "credits": []
            }]);
        }

        serde_json::from_value(entry_val).unwrap()
    }

    #[test]
    fn test_extract_content_prefers_content_body() {
        let entry =
            make_entry_with_content(Some("<p>Content body</p>"), Some("Summary text"), None);
        assert_eq!(extract_content(&entry), "<p>Content body</p>");
    }

    #[test]
    fn test_extract_content_falls_back_to_summary() {
        let entry = make_entry_with_content(None, Some("Summary text"), None);
        assert_eq!(extract_content(&entry), "Summary text");
    }

    #[test]
    fn test_extract_content_falls_back_to_media_description() {
        let entry = make_entry_with_content(None, None, Some("Media description"));
        assert_eq!(extract_content(&entry), "Media description");
    }

    #[test]
    fn test_extract_content_prefers_content_over_summary_and_media() {
        let entry = make_entry_with_content(
            Some("<p>Content</p>"),
            Some("Summary"),
            Some("Media description"),
        );
        assert_eq!(extract_content(&entry), "<p>Content</p>");
    }

    #[test]
    fn test_extract_content_prefers_summary_over_media() {
        let entry = make_entry_with_content(None, Some("Summary"), Some("Media description"));
        assert_eq!(extract_content(&entry), "Summary");
    }

    #[test]
    fn test_extract_content_returns_empty_when_all_none() {
        let entry = make_entry_with_content(None, None, None);
        assert_eq!(extract_content(&entry), "");
    }

    #[test]
    fn test_extract_content_content_body_has_no_body_field() {
        // When content exists but body is None
        let entry: Entry = serde_json::from_value(serde_json::json!({
            "id": "1",
            "content": {
                "content_type": "text/html"
            },
            "authors": [],
            "contributors": [],
            "links": [],
            "categories": [],
            "media": []
        }))
        .unwrap();
        assert_eq!(extract_content(&entry), "");
    }

    #[test]
    fn test_extract_content_summary_empty_string() {
        let entry = make_entry_with_content(None, Some(""), None);
        assert_eq!(extract_content(&entry), "");
    }
}
