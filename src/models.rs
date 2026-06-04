use serde::{Deserialize, Serialize};

// ── D1 Row types (for deserializing query results) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupRow {
    pub id: u64,
    pub title: String,
    pub created_on: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedRow {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub site_url: String,
    pub group_id: u64,
    pub last_fetched_on: u64,
    #[serde(default)]
    pub last_http_status: u64,
    pub created_on: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemRow {
    pub id: u64,
    pub feed_id: u64,
    pub title: String,
    pub author: String,
    pub html: String,
    pub url: String,
    pub is_saved: u64,
    pub created_on: u64,
}

// ── Query helper row types ──

#[derive(Deserialize)]
pub struct CountRow {
    pub count: u64,
}

#[derive(Deserialize)]
pub struct IdOnlyRow {
    pub id: u64,
}

#[derive(Deserialize)]
pub struct ItemIdRow {
    pub item_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupWithCountRow {
    pub id: u64,
    pub title: String,
    pub created_on: u64,
    pub subscription_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedsGroupRow {
    pub group_id: u64,
    pub feed_ids: String,
}

// ── Fever API response types ──

#[derive(Debug, Serialize, Deserialize)]
pub struct HotEvent {
    pub id: String,
    pub title: String,
    pub temperature: u32,
    pub summary: String,
    pub item_ids: Vec<u64>,
    pub source_count: u32,
}

#[derive(Debug, Serialize)]
pub struct FeverResponse {
    pub api_version: u32,
    pub auth: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_refreshed_on_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<FeverGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feeds: Option<Vec<FeverFeed>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feeds_groups: Option<Vec<FeverFeedsGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<FeverItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_item_ids: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread_item_ids: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub links: Option<Vec<HotEvent>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_items: Option<u64>,
}

impl FeverResponse {
    pub fn unauth() -> Self {
        Self {
            api_version: 3,
            auth: 0,
            last_refreshed_on_time: None,
            groups: None,
            feeds: None,
            feeds_groups: None,
            items: None,
            saved_item_ids: None,
            unread_item_ids: None,
            links: None,
            total_items: None,
        }
    }

    pub fn ok() -> Self {
        Self {
            api_version: 3,
            auth: 1,
            last_refreshed_on_time: None,
            groups: None,
            feeds: None,
            feeds_groups: None,
            items: None,
            saved_item_ids: None,
            unread_item_ids: None,
            links: None,
            total_items: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct FeverGroup {
    pub id: u64,
    pub title: String,
}

#[derive(Debug, Serialize)]
pub struct FeverFeed {
    pub id: u64,
    pub favicon_id: u64,
    pub title: String,
    pub url: String,
    pub site_url: String,
    pub is_spark: u8,
    pub last_updated_on_time: u64,
}

#[derive(Debug, Serialize)]
pub struct FeverFeedsGroup {
    pub group_id: u64,
    pub feed_ids: String,
}

#[derive(Debug, Serialize)]
pub struct FeverItem {
    pub id: u64,
    pub feed_id: u64,
    pub title: String,
    pub author: String,
    pub html: String,
    pub url: String,
    pub is_saved: u8,
    pub is_read: u8,
    pub created_on_time: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unauth_response() {
        let resp = FeverResponse::unauth();
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r##"{"api_version":3,"auth":0}"##);
    }

    #[test]
    fn test_ok_response() {
        let resp = FeverResponse::ok();
        let json = serde_json::to_string(&resp).unwrap();
        assert_eq!(json, r##"{"api_version":3,"auth":1}"##);
    }

    #[test]
    fn test_full_response_serialization() {
        let mut resp = FeverResponse::ok();
        resp.last_refreshed_on_time = Some(1700000000);
        resp.groups = Some(vec![
            FeverGroup {
                id: 1,
                title: "Tech".into(),
            },
            FeverGroup {
                id: 2,
                title: "News".into(),
            },
        ]);
        resp.feeds = Some(vec![FeverFeed {
            id: 1,
            favicon_id: 0,
            title: "Example Blog".into(),
            url: "https://example.com/feed.xml".into(),
            site_url: "https://example.com".into(),
            is_spark: 0,
            last_updated_on_time: 1700000000,
        }]);
        resp.feeds_groups = Some(vec![FeverFeedsGroup {
            group_id: 1,
            feed_ids: "1".into(),
        }]);
        resp.items = Some(vec![FeverItem {
            id: 1,
            feed_id: 1,
            title: "First Post".into(),
            author: "Alice".into(),
            html: "<p>Hello</p>".into(),
            url: "https://example.com/post1".into(),
            is_saved: 0,
            is_read: 0,
            created_on_time: 1700000000,
        }]);
        resp.saved_item_ids = Some("1,2".into());
        resp.unread_item_ids = Some("3,4,5".into());
        resp.links = Some(vec![]);
        resp.total_items = Some(42);

        let json = serde_json::to_string(&resp).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed["api_version"], 3);
        assert_eq!(parsed["auth"], 1);
        assert_eq!(parsed["last_refreshed_on_time"], 1700000000);
        assert_eq!(parsed["groups"][0]["title"], "Tech");
        assert_eq!(parsed["feeds"][0]["site_url"], "https://example.com");
        assert_eq!(parsed["items"][0]["author"], "Alice");
        assert_eq!(parsed["saved_item_ids"], "1,2");
        assert_eq!(parsed["unread_item_ids"], "3,4,5");
        assert!(parsed["links"].is_array());
        assert_eq!(parsed["total_items"], 42);
        assert!(parsed.get("groups").is_some());
        assert!(parsed.get("feeds_groups").is_some());
    }

    #[test]
    fn test_group_row_roundtrip() {
        let row = GroupRow {
            id: 1,
            title: "Tech".into(),
            created_on: 1700000000,
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: GroupRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, row.id);
        assert_eq!(parsed.title, row.title);
        assert_eq!(parsed.created_on, row.created_on);
    }

    #[test]
    fn test_item_row_roundtrip() {
        let row = ItemRow {
            id: 42,
            feed_id: 1,
            title: "Test".into(),
            author: "Bob".into(),
            html: "<p>Content</p>".into(),
            url: "https://example.com".into(),
            is_saved: 1,
            created_on: 1700000000,
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: ItemRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, 42);
        assert_eq!(parsed.is_saved, 1);
        assert_eq!(parsed.feed_id, 1);
    }

    #[test]
    fn test_feed_row_roundtrip() {
        let row = FeedRow {
            id: 1,
            title: "My Feed".into(),
            url: "https://example.com/rss".into(),
            site_url: "https://example.com".into(),
            group_id: 1,
            last_fetched_on: 1700000000,
            last_http_status: 200,
            created_on: 1690000000,
        };
        let json = serde_json::to_string(&row).unwrap();
        let parsed: FeedRow = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.title, "My Feed");
        assert_eq!(parsed.group_id, 1);
        assert_eq!(parsed.last_fetched_on, 1700000000);
        assert_eq!(parsed.last_http_status, 200);
        assert_eq!(parsed.url, "https://example.com/rss");
    }

    #[test]
    fn test_feed_row_deserializes_old_cache_without_http_status() {
        let old_json = r##"{"id":1,"title":"My Feed","url":"https://example.com/rss","site_url":"https://example.com","group_id":1,"last_fetched_on":1700000000,"created_on":1690000000}"##;
        let parsed: FeedRow = serde_json::from_str(old_json).unwrap();
        assert_eq!(parsed.last_http_status, 0);
        assert_eq!(parsed.title, "My Feed");
    }
}
