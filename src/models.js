// Fever API response types and row-to-response mapping helpers.
//
// Response objects are built with fields inserted in the same order the Rust
// `FeverResponse` struct serialized them, and absent optional fields are
// omitted entirely (mirroring `skip_serializing_if = "Option::is_none"`).

/** @returns {Record<string, unknown>} `{"api_version":3,"auth":0}` */
export function unauthResponse() {
  return { api_version: 3, auth: 0 };
}

/** @returns {Record<string, unknown>} `{"api_version":3,"auth":1}` */
export function okResponse() {
  return { api_version: 3, auth: 1 };
}

/**
 * Highest `last_fetched_on` across the given feeds (0 when there are none).
 * @param {Array<{last_fetched_on: number}>} feeds
 * @returns {number}
 */
export function lastRefreshedOn(feeds) {
  let max = 0;
  for (const feed of feeds) {
    if (feed.last_fetched_on > max) {
      max = feed.last_fetched_on;
    }
  }
  return max;
}

/** @param {Array<{id: number, title: string}>} groups */
export function mapGroups(groups) {
  return groups.map((group) => ({ id: group.id, title: group.title }));
}

/** @param {Array<Record<string, unknown>>} feeds */
export function mapFeeds(feeds) {
  return feeds.map((feed) => ({
    id: feed.id,
    favicon_id: 0,
    title: feed.title,
    url: feed.url,
    site_url: feed.site_url,
    is_spark: 0,
    last_updated_on_time: feed.last_fetched_on,
  }));
}

/** @param {Array<{group_id: number, feed_ids: string}>} feedGroups */
export function mapFeedGroups(feedGroups) {
  return feedGroups.map((feedGroup) => ({
    group_id: feedGroup.group_id,
    feed_ids: feedGroup.feed_ids,
  }));
}

/**
 * Map items with a pre-computed unread set (avoids a separate read_ids query).
 *
 * @param {Array<Record<string, unknown>>} items
 * @param {Set<number>} unreadSet
 */
export function mapItemsWithUnread(items, unreadSet) {
  return items.map((item) => ({
    id: item.id,
    feed_id: item.feed_id,
    title: item.title,
    author: item.author,
    html: item.html,
    url: item.url,
    is_saved: item.is_saved ? 1 : 0,
    is_read: unreadSet.has(item.id) ? 0 : 1,
    created_on_time: item.created_on,
  }));
}

/** @param {number[]} ids */
export function joinIds(ids) {
  return ids.map((id) => String(id)).join(",");
}
