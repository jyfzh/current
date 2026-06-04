use crate::auth;
use crate::cache;
use crate::db;
use crate::models::*;
use crate::var;
use worker::*;

fn has_param(params: &[(String, String)], name: &str) -> bool {
    params.iter().any(|(k, _)| k == name)
}

fn get_param_value<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .rev()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

pub async fn handle_request(mut req: Request, env: &Env) -> Result<Response> {
    let is_post = req.method() == Method::Post;
    let url = req.url()?;

    // Extract params from URL query string (and POST body if applicable).
    let params = if is_post {
        let mut params: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let body_bytes = req.bytes().await.unwrap_or_default();
        if !body_bytes.is_empty() {
            params.extend(
                url::form_urlencoded::parse(&body_bytes)
                    .map(|(k, v)| (k.into_owned(), v.into_owned())),
            );
        }
        params
    } else {
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    };

    // Authenticate
    let api_key = get_param_value(&params, "api_key");

    if !auth::is_authenticated(api_key, env) {
        return json_response(&FeverResponse::unauth());
    }

    let d1 = env.d1("DB")?;
    let kv = env.kv("CACHE")?;

    // Check mode: must have 'api' param
    if !has_param(&params, "api") {
        return json_response(&FeverResponse::unauth());
    }

    // Dispatch by param presence (works for both GET and POST).
    // NOTE: Fever API spec says reads use GET and writes use POST,
    // but some clients send POST for all requests with read params in the query string,
    // so we dispatch by param presence rather than HTTP method.
    if has_param(&params, "mark") {
        return handle_mark(env, &d1, &kv, &params).await;
    }

    if has_param(&params, "items") {
        return handle_items(env, &d1, &kv, &params).await;
    }

    if has_param(&params, "links") {
        return handle_links(env).await;
    }

    if has_param(&params, "unread_item_ids") {
        return handle_unread_item_ids(env, &d1, &kv).await;
    }

    if has_param(&params, "saved_item_ids") {
        return handle_saved_item_ids(env, &d1, &kv).await;
    }

    if has_param(&params, "feeds") {
        return handle_feeds(env, &d1, &kv).await;
    }

    if has_param(&params, "groups") {
        return handle_groups(env, &d1, &kv).await;
    }

    // Just ?api — return status
    handle_status(env, &d1, &kv).await
}

// ── Sub-handlers ──

async fn handle_status(env: &Env, d1: &D1Database, kv: &KvStore) -> Result<Response> {
    let groups = cache::list_groups_cached(d1, kv, env).await?;
    let feeds = cache::list_feeds_cached(d1, kv, env).await?;
    let feed_groups = cache::list_feeds_by_group_cached(d1, kv, env).await?;
    let last_refreshed = last_refreshed_on(&feeds);

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.groups = Some(map_groups(groups));
    resp.feeds = Some(map_feeds(feeds));
    resp.feeds_groups = Some(map_feed_groups(feed_groups));
    json_response(&resp)
}

async fn handle_groups(env: &Env, d1: &D1Database, kv: &KvStore) -> Result<Response> {
    let groups = cache::list_groups_cached(d1, kv, env).await?;
    let last_refreshed = cache::get_max_feed_fetched_on_cached(d1, kv, env).await?;

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.groups = Some(map_groups(groups));
    // Per Fever API spec, ?api&groups must also return feeds_groups
    let feed_groups = cache::list_feeds_by_group_cached(d1, kv, env).await?;
    resp.feeds_groups = Some(map_feed_groups(feed_groups));
    json_response(&resp)
}

async fn handle_feeds(env: &Env, d1: &D1Database, kv: &KvStore) -> Result<Response> {
    let feeds = cache::list_feeds_cached(d1, kv, env).await?;
    let feed_groups = cache::list_feeds_by_group_cached(d1, kv, env).await?;
    let last_refreshed = last_refreshed_on(&feeds);

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.feeds = Some(map_feeds(feeds));
    resp.feeds_groups = Some(map_feed_groups(feed_groups));
    json_response(&resp)
}

async fn handle_items(
    env: &Env,
    d1: &D1Database,
    kv: &KvStore,
    params: &[(String, String)],
) -> Result<Response> {
    let started = chrono::Utc::now();
    let items_per_page = var::fever_items_per_page(env);
    let items = if let Some(ids_str) = get_param_value(params, "with_ids") {
        let ids: Vec<u64> = ids_str
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        db::get_items_by_ids(d1, &ids).await?
    } else if let Some(val) = get_param_value(params, "since_id") {
        let since_id = val.parse::<u64>().unwrap_or(0);
        db::get_items_since(d1, since_id, items_per_page).await?
    } else if let Some(val) = get_param_value(params, "max_id") {
        let max_id = val.parse::<u64>().unwrap_or(u64::MAX);
        db::get_items_max(d1, max_id, items_per_page).await?
    } else {
        db::get_items_max(d1, u64::MAX, items_per_page).await?
    };

    let total_items = cache::get_total_items_cached(d1, kv, env).await?;

    // Use cached unread IDs to determine read status (avoids a separate D1 query)
    let unread_ids = cache::get_unread_item_ids_cached(d1, kv, env).await?;
    let unread_set: std::collections::HashSet<u64> = unread_ids.into_iter().collect();

    let last_refreshed = cache::get_max_feed_fetched_on_cached(d1, kv, env).await?;

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.items = Some(map_items_with_unread(items, &unread_set));
    resp.total_items = Some(total_items);

    crate::log_info!(
        "perf route=fever.items total_items={} response_items={} duration_ms={}",
        total_items,
        resp.items.as_ref().map(|v| v.len()).unwrap_or(0),
        (chrono::Utc::now() - started).num_milliseconds().max(0)
    );

    json_response(&resp)
}

async fn handle_links(_env: &Env) -> Result<Response> {
    let mut resp = FeverResponse::ok();
    resp.links = Some(vec![]);
    json_response(&resp)
}

async fn handle_unread_item_ids(env: &Env, d1: &D1Database, kv: &KvStore) -> Result<Response> {
    let unread_ids = cache::get_unread_item_ids_cached(d1, kv, env).await?;
    let last_refreshed = cache::get_max_feed_fetched_on_cached(d1, kv, env).await?;

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.unread_item_ids = Some(join_ids(&unread_ids));
    json_response(&resp)
}

async fn handle_saved_item_ids(env: &Env, d1: &D1Database, kv: &KvStore) -> Result<Response> {
    let saved_ids = cache::get_saved_item_ids_cached(d1, kv, env).await?;
    let last_refreshed = cache::get_max_feed_fetched_on_cached(d1, kv, env).await?;

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.saved_item_ids = Some(join_ids(&saved_ids));
    json_response(&resp)
}

async fn handle_mark(
    env: &Env,
    d1: &D1Database,
    kv: &KvStore,
    params: &[(String, String)],
) -> Result<Response> {
    let mark = get_param_value(params, "mark");
    let as_val = get_param_value(params, "as");
    let id = get_param_value(params, "id").and_then(|v| v.parse::<i64>().ok());
    // Fever API spec uses "before" (unix timestamp), not "before_id"
    let before_ts = get_param_value(params, "before").and_then(|v| v.parse::<u64>().ok());

    match (mark, as_val, id, before_ts) {
        // mark=item&as=read&id=N
        (Some("item"), Some("read"), Some(item_id), _) => {
            db::mark_read(d1, item_id as u64).await?;
        }
        // mark=item&as=unread&id=N
        (Some("item"), Some("unread"), Some(item_id), _) => {
            db::mark_unread(d1, item_id as u64).await?;
        }
        // mark=item&as=saved&id=N
        (Some("item"), Some("saved"), Some(item_id), _) => {
            db::mark_saved(d1, item_id as u64).await?;
        }
        // mark=item&as=unsaved&id=N
        (Some("item"), Some("unsaved"), Some(item_id), _) => {
            db::mark_unsaved(d1, item_id as u64).await?;
        }
        // mark=feed&as=read&id=N&before=TS — mark all items in feed N before TS as read
        (Some("feed"), Some("read"), Some(feed_id), before_ts_val) => {
            let before = before_ts_val.unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);
            crate::log_info!("fever: mark feed {} as read before {}", feed_id, before);
            db::mark_read_before_feed(d1, feed_id as u64, before).await?;
        }
        // mark=group&as=read&id=N&before=TS — mark all items before TS in group N as read
        // id=0 = Kindling super group (all feeds with is_spark=0)
        // id=-1 = Sparks super group (all feeds with is_spark=1)
        // id>0 = user-created group
        (Some("group"), Some("read"), Some(group_id), before_ts_val) => {
            let before = before_ts_val.unwrap_or_else(|| chrono::Utc::now().timestamp() as u64);
            match group_id {
                -1 => {
                    crate::log_info!("fever: mark Sparks super group as read before {}", before);
                    // Sparks = feeds with is_spark=1; currently no feeds have is_spark=1
                    // so this is intentionally a no-op until is_spark support is added
                }
                0 => {
                    crate::log_info!("fever: mark Kindling super group as read before {}", before);
                    // Kindling = feeds with is_spark=0; currently all feeds have is_spark=0
                    db::mark_read_before_all(d1, before).await?;
                }
                _ => {
                    crate::log_info!("fever: mark group {} as read before {}", group_id, before);
                    db::mark_read_before_group(d1, group_id as u64, before).await?;
                }
            }
        }
        _ => {
            crate::log_warn!(
                "Unknown mark action: mark={:?} as={:?} id={:?} before={:?} — params: {:?}",
                mark,
                as_val,
                id,
                before_ts,
                params
            );
        }
    }

    // Invalidate caches affected by this mark operation
    match (mark, as_val) {
        (Some("item"), Some("read") | Some("unread")) => {
            cache::invalidate(kv, cache::CacheEvent::MarkRead).await
        }
        (Some("item"), Some("saved") | Some("unsaved")) => {
            cache::invalidate(kv, cache::CacheEvent::MarkSaved).await
        }
        (Some("feed") | Some("group"), Some("read")) => {
            cache::invalidate(kv, cache::CacheEvent::MarkRead).await
        }
        _ => {}
    }

    // Return current status after mark (cached versions; just-invalidated
    // keys are cache misses and fetch fresh data from D1)
    let last_refreshed = cache::get_max_feed_fetched_on_cached(d1, kv, env).await?;
    let saved_ids = cache::get_saved_item_ids_cached(d1, kv, env).await?;

    let mut resp = FeverResponse::ok();
    resp.last_refreshed_on_time = Some(last_refreshed);
    resp.saved_item_ids = Some(join_ids(&saved_ids));
    let unread_ids = cache::get_unread_item_ids_cached(d1, kv, env).await?;
    resp.unread_item_ids = Some(join_ids(&unread_ids));
    json_response(&resp)
}

// ── Helpers ──

fn last_refreshed_on(feeds: &[FeedRow]) -> u64 {
    feeds.iter().map(|f| f.last_fetched_on).max().unwrap_or(0)
}

fn map_groups(groups: Vec<GroupRow>) -> Vec<FeverGroup> {
    groups
        .into_iter()
        .map(|g| FeverGroup {
            id: g.id,
            title: g.title,
        })
        .collect()
}

fn map_feeds(feeds: Vec<FeedRow>) -> Vec<FeverFeed> {
    feeds
        .into_iter()
        .map(|f| FeverFeed {
            id: f.id,
            favicon_id: 0,
            title: f.title,
            url: f.url,
            site_url: f.site_url,
            is_spark: 0,
            last_updated_on_time: f.last_fetched_on,
        })
        .collect()
}

fn map_feed_groups(feed_groups: Vec<FeedsGroupRow>) -> Vec<FeverFeedsGroup> {
    feed_groups
        .into_iter()
        .map(|fg| FeverFeedsGroup {
            group_id: fg.group_id,
            feed_ids: fg.feed_ids,
        })
        .collect()
}

/// Map items with pre-computed unread set (avoids separate read_ids query).
fn map_items_with_unread(
    items: Vec<ItemRow>,
    unread_set: &std::collections::HashSet<u64>,
) -> Vec<FeverItem> {
    items
        .into_iter()
        .map(|i| FeverItem {
            id: i.id,
            feed_id: i.feed_id,
            title: i.title,
            author: i.author,
            html: i.html,
            url: i.url,
            is_saved: i.is_saved as u8,
            is_read: if unread_set.contains(&i.id) { 0 } else { 1 },
            created_on_time: i.created_on,
        })
        .collect()
}

fn join_ids(ids: &[u64]) -> String {
    ids.iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn json_response(value: &impl serde::Serialize) -> Result<Response> {
    let body = serde_json::to_string(value)?;
    let mut resp = Response::ok(body)?;
    resp.headers_mut().set("Content-Type", "application/json")?;
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::get_param_value;

    #[test]
    fn test_get_param_value_prefers_last() {
        let params = vec![
            ("mark".to_string(), "query".to_string()),
            ("mark".to_string(), "body".to_string()),
        ];
        assert_eq!(get_param_value(&params, "mark"), Some("body"));
    }

    #[test]
    fn test_get_param_value_missing() {
        let params = vec![("api".to_string(), "1".to_string())];
        assert_eq!(get_param_value(&params, "missing"), None);
    }
}
