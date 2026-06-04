-- init_current.sql
-- Full schema for current: tables + indexes (including dedup unique indexes).
-- Run this on a fresh D1 database to bootstrap.
--
--   wrangler d1 execute current --file=migrations/init_current.sql
--
-- If migrating an existing database, also run dedup_items.sql after this
-- to clean up any duplicate rows created before the unique indexes existed.

-- ── Groups ──

CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_on INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Feeds ──

CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    site_url TEXT NOT NULL DEFAULT '',
    group_id INTEGER NOT NULL DEFAULT 0,
    last_fetched_on INTEGER NOT NULL DEFAULT 0,
    last_http_status INTEGER NOT NULL DEFAULT 0,
    created_on INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Items ──

CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    is_saved INTEGER NOT NULL DEFAULT 0,
    created_on INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Read tracking ──

CREATE TABLE IF NOT EXISTS read_item_ids (
    item_id INTEGER PRIMARY KEY,
    read_on INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── General-purpose indexes ──

CREATE INDEX IF NOT EXISTS idx_items_feed_id ON items(feed_id);
CREATE INDEX IF NOT EXISTS idx_items_created_on ON items(created_on);
CREATE INDEX IF NOT EXISTS idx_feeds_group_id ON feeds(group_id);

-- ── Dedup unique indexes ──
-- These make INSERT OR IGNORE in the application code actually prevent
-- duplicate items at the database level.
-- Partial (WHERE url != '') so multiple items with empty url are allowed.

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_feed_id_url
    ON items(feed_id, url) WHERE url != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_feed_id_title
    ON items(feed_id, title) WHERE title != '';
