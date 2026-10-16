-- Integration test seed data for local D1 emulation
-- Applied by tests/local-db-setup.sh and tests/setup-integration.sh
-- (cf d1 raw --local --batch).

-- Groups
INSERT OR IGNORE INTO groups (id, title, created_on) VALUES (1, 'Tech', 1700000000);
INSERT OR IGNORE INTO groups (id, title, created_on) VALUES (2, 'News', 1700000000);

-- Feeds (group 1: Tech, group 2: News)
INSERT OR IGNORE INTO feeds (id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on)
VALUES (1, 'Rust Blog', 'https://blog.rust-lang.org/feed.xml',
        'https://blog.rust-lang.org',
        1, 1700000000, 200, 1700000000);
INSERT OR IGNORE INTO feeds (id, title, url, site_url, group_id, last_fetched_on, last_http_status, created_on)
VALUES (2, 'HN Frontpage', 'https://hnrss.org/frontpage',
        'https://news.ycombinator.com',
        2, 1700000100, 200, 1700000000);

-- Items (feed 1 items: first saved, second unread; feed 2 item: unread)
INSERT OR IGNORE INTO items (id, feed_id, title, author, html, url, is_saved, created_on)
VALUES (1, 1, 'Announcing Rust 1.85', 'Rust Team', '<p>New release</p>',
        'https://blog.rust-lang.org/1.85', 1, 1700000000);
INSERT OR IGNORE INTO items (id, feed_id, title, author, html, url, is_saved, created_on)
VALUES (2, 1, 'Async Rust Guide', 'Alice', '<p>Async patterns</p>',
        'https://blog.rust-lang.org/async', 0, 1700000001);
INSERT OR IGNORE INTO items (id, feed_id, title, author, html, url, is_saved, created_on)
VALUES (3, 2, 'New Tech Breakthrough', 'Bob', '<p>Exciting news</p>',
        'https://news.ycombinator.com/1', 0, 1700000100);

-- Mark item 2 as read
INSERT OR IGNORE INTO read_item_ids (item_id) VALUES (2);
