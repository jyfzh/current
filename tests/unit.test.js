import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { isAuthenticated, secureEq } from "../src/auth.js";
import * as cache from "../src/cache.js";
import { concurrencyWindow, extractContent, extractEntryAuthor, fetchAllFeeds } from "../src/fetcher.js";
import { parseFeed, parseTimestamp } from "../src/feedparser.js";
import { md5 } from "../src/md5.js";
import * as models from "../src/models.js";
import * as varModule from "../src/var.js";
import { childAsText, childrenAsString, parseXml } from "../src/xml.js";

const encoder = new TextEncoder();

// ── md5 ──

test("md5 known vectors", () => {
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
});

test("md5 matches Node crypto for unicode input", () => {
  for (const value of ["admin:secret", "中文密码:🔐", "a".repeat(1000)]) {
    const expected = createHash("md5").update(value, "utf8").digest("hex");
    assert.equal(md5(value), expected);
  }
});

// ── auth ──

test("secureEq matches equal strings", () => {
  assert.equal(secureEq("secret", "secret"), true);
});

test("secureEq rejects mismatches", () => {
  assert.equal(secureEq("secret", "secreT"), false);
  assert.equal(secureEq("short", "longer"), false);
});

test("isAuthenticated validates md5(email:password)", () => {
  const env = { CURRENT_FEVER_EMAIL: "user@example.com", CURRENT_FEVER_PASSWORD: "pw" };
  assert.equal(isAuthenticated(md5("user@example.com:pw"), env), true);
  assert.equal(isAuthenticated("wrong", env), false);
  assert.equal(isAuthenticated(undefined, env), false);
});

test("isAuthenticated defaults the email to admin", () => {
  const env = { CURRENT_FEVER_PASSWORD: "pw" };
  assert.equal(isAuthenticated(md5("admin:pw"), env), true);
});

test("isAuthenticated denies when the password is missing", () => {
  assert.equal(isAuthenticated(md5("admin:whatever"), {}), false);
});

// ── models ──

test("unauth response serializes exactly", () => {
  assert.equal(JSON.stringify(models.unauthResponse()), '{"api_version":3,"auth":0}');
});

test("ok response serializes exactly", () => {
  assert.equal(JSON.stringify(models.okResponse()), '{"api_version":3,"auth":1}');
});

test("full response serialization order and omitted fields", () => {
  const response = models.okResponse();
  response.last_refreshed_on_time = 1700000000;
  response.groups = models.mapGroups([{ id: 1, title: "Tech" }]);
  response.feeds = models.mapFeeds([
    {
      id: 1,
      title: "Example Blog",
      url: "https://example.com/feed.xml",
      site_url: "https://example.com",
      last_fetched_on: 1700000000,
    },
  ]);
  response.feeds_groups = models.mapFeedGroups([{ group_id: 1, feed_ids: "1" }]);
  response.items = models.mapItemsWithUnread(
    [
      {
        id: 1,
        feed_id: 1,
        title: "First Post",
        author: "Alice",
        html: "<p>Hello</p>",
        url: "https://example.com/post1",
        is_saved: 1,
        created_on: 1700000000,
      },
    ],
    new Set([1]),
  );
  response.saved_item_ids = "1,2";
  response.unread_item_ids = "3,4,5";
  response.links = [];
  response.total_items = 42;

  assert.equal(
    JSON.stringify(response),
    '{"api_version":3,"auth":1,"last_refreshed_on_time":1700000000,' +
      '"groups":[{"id":1,"title":"Tech"}],' +
      '"feeds":[{"id":1,"favicon_id":0,"title":"Example Blog","url":"https://example.com/feed.xml","site_url":"https://example.com","is_spark":0,"last_updated_on_time":1700000000}],' +
      '"feeds_groups":[{"group_id":1,"feed_ids":"1"}],' +
      '"items":[{"id":1,"feed_id":1,"title":"First Post","author":"Alice","html":"<p>Hello</p>","url":"https://example.com/post1","is_saved":1,"is_read":0,"created_on_time":1700000000}],' +
      '"saved_item_ids":"1,2","unread_item_ids":"3,4,5","links":[],"total_items":42}',
  );
});

test("lastRefreshedOn returns the maximum or 0", () => {
  assert.equal(models.lastRefreshedOn([]), 0);
  assert.equal(models.lastRefreshedOn([{ last_fetched_on: 5 }, { last_fetched_on: 9 }]), 9);
});

test("joinIds joins with commas", () => {
  assert.equal(models.joinIds([1, 2, 3]), "1,2,3");
  assert.equal(models.joinIds([]), "");
});

// ── var ──

test("var defaults", () => {
  const env = {};
  assert.equal(varModule.maxConcurrency(env), 0);
  assert.equal(varModule.feedStaleSeconds(env), 3600);
  assert.equal(varModule.startupFetchEnabled(env), true);
  assert.equal(varModule.cacheTtlAggregate(env), 600);
  assert.equal(varModule.cacheTtlStructural(env), 600);
  assert.equal(varModule.feverItemsPerPage(env), 50);
});

test("var parsing matches Rust unsigned integer semantics", () => {
  assert.equal(varModule.maxConcurrency({ CURRENT_MAX_CONCURRENCY: "5" }), 5);
  assert.equal(varModule.maxConcurrency({ CURRENT_MAX_CONCURRENCY: "+5" }), 5);
  assert.equal(varModule.maxConcurrency({ CURRENT_MAX_CONCURRENCY: "-1" }), 0);
  assert.equal(varModule.maxConcurrency({ CURRENT_MAX_CONCURRENCY: "5.5" }), 0);
  assert.equal(varModule.maxConcurrency({ CURRENT_MAX_CONCURRENCY: "abc" }), 0);
  assert.equal(varModule.startupFetchEnabled({ CURRENT_STARTUP_FETCH: "false" }), false);
  assert.equal(varModule.startupFetchEnabled({ CURRENT_STARTUP_FETCH: "TRUE" }), false);
});

// ── fetcher helpers ──

test("concurrencyWindow handles unlimited, capped and empty job lists", () => {
  assert.equal(concurrencyWindow(0, 7), 7);
  assert.equal(concurrencyWindow(10, 3), 3);
  assert.equal(concurrencyWindow(5, 0), 1);
});

test("extractEntryAuthor prefers entry author", () => {
  assert.equal(
    extractEntryAuthor({ authors: [{ name: "Alice" }], contributors: [] }, { authors: [{ name: "Feed Author" }] }),
    "Alice",
  );
});

test("extractEntryAuthor falls back to feed author", () => {
  assert.equal(
    extractEntryAuthor({ authors: [], contributors: [] }, { authors: [{ name: "Feed Author" }] }),
    "Feed Author",
  );
  assert.equal(
    extractEntryAuthor(
      { authors: [{ name: "   " }], contributors: [] },
      { authors: [{ name: "Feed Author" }] },
    ),
    "Feed Author",
  );
});

test("extractEntryAuthor falls back to contributors", () => {
  assert.equal(
    extractEntryAuthor(
      { authors: [], contributors: [{ name: "" }, { name: "Contributor B" }, { name: "Contributor C" }] },
      { authors: [] },
    ),
    "Contributor B",
  );
});

test("extractEntryAuthor returns empty when all sources are empty", () => {
  assert.equal(
    extractEntryAuthor({ authors: [{ name: "" }], contributors: [{ name: "" }] }, { authors: [{ name: "" }] }),
    "",
  );
});

test("extractContent prefers content body", () => {
  assert.equal(
    extractContent({ content: { body: "<p>Content body</p>" }, summary: { content: "Summary" }, media: [] }),
    "<p>Content body</p>",
  );
});

test("extractContent keeps an empty content body", () => {
  assert.equal(
    extractContent({ content: { body: "" }, summary: { content: "Summary" }, media: [] }),
    "",
  );
});

test("extractContent falls back to summary then media description", () => {
  assert.equal(extractContent({ content: null, summary: { content: "Summary" }, media: [] }), "Summary");
  assert.equal(
    extractContent({ content: null, summary: null, media: [{ description: "Media description" }] }),
    "Media description",
  );
  assert.equal(extractContent({ content: null, summary: null, media: [] }), "");
});

// ── timestamps ──

test("parseTimestamp handles lenient feed formats", () => {
  assert.equal(parseTimestamp("2014-12-29T14:53:35+02:00").toISOString(), "2014-12-29T12:53:35.000Z");
  assert.equal(parseTimestamp("2014-12-29T14:53:35+0200").toISOString(), "2014-12-29T12:53:35.000Z");
  assert.equal(parseTimestamp("Tue, 15 Nov 2022 20:15:04 +0000").toISOString(), "2022-11-15T20:15:04.000Z");
  assert.equal(parseTimestamp("Tue, 15 Nov 2022 20:15:04 Z").toISOString(), "2022-11-15T20:15:04.000Z");
  assert.equal(parseTimestamp("Wed, 22 Jan 2020 10:58:02 -0000").toISOString(), "2020-01-22T10:58:02.000Z");
  assert.equal(parseTimestamp("2016-10-01T00:00:00+10:00").toISOString(), "2016-09-30T14:00:00.000Z");
  assert.equal(parseTimestamp("garbage"), null);
  assert.equal(parseTimestamp(null), null);
});

// ── XML helpers ──

test("parseXml decodes entities, CDATA and comments", () => {
  const root = parseXml("<x>a&amp;b<![CDATA[<c>]]><!-- note -->d</x>");
  assert.equal(root.name, "x");
  assert.equal(childrenAsString(root), "a&b<c>d");
  assert.equal(childAsText(root), "a&b<c>d");
});

test("parseXml strips prefixes and resolves namespaces", () => {
  const root = parseXml(
    "<rss version=\"2.0\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\">" +
      "<channel><item><content:encoded>x</content:encoded></item></channel></rss>",
  );
  const channel = root.children.find((child) => typeof child !== "string");
  const item = channel.children.find((child) => typeof child !== "string");
  const encoded = item.children.find((child) => typeof child !== "string");
  assert.equal(encoded.name, "encoded");
  assert.equal(encoded.uri, "http://purl.org/rss/1.0/modules/content/");
});

test("childAsText only returns a leading text node", () => {
  assert.equal(childAsText(parseXml("<x>text<b/>more</x>")), "text");
  assert.equal(childAsText(parseXml("<x><b/>more</x>")), null);
});

// ── feed parsing ──

test("parses RSS 2.0 fields", () => {
  const feed = parseFeed(
    encoder.encode(
      `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<channel><title>T</title>` +
        `<item><title>Post</title><link>https://example.com/1</link>` +
        `<description><![CDATA[<p>desc</p>]]></description><dc:creator>Alice</dc:creator>` +
        `<pubDate>Tue, 15 Nov 2022 20:15:04 +0000</pubDate></item>` +
        `<item><title>Second</title><link>https://example.com/2</link>` +
        `<content:encoded><![CDATA[<p>full</p>]]></content:encoded><author>a@b.c</author></item>` +
        `</channel></rss>`,
    ),
  );

  assert.equal(feed.entries.length, 2);
  const [first, second] = feed.entries;
  assert.equal(first.title, "Post");
  assert.equal(first.links[0].href, "https://example.com/1");
  assert.equal(first.summary.content, "<p>desc</p>");
  assert.equal(first.published.toISOString(), "2022-11-15T20:15:04.000Z");
  assert.equal(extractEntryAuthor(first, feed), "Alice");
  assert.equal(extractContent(first), "<p>desc</p>");
  assert.equal(extractContent(second), "<p>full</p>");
  // feed-rs maps the RSS <author> role string to the person's name
  assert.equal(extractEntryAuthor(second, feed), "author");
});

test("parses Atom feeds", () => {
  const feed = parseFeed(
    encoder.encode(
      `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>` +
        `<author><name>Feed Author</name></author>` +
        `<entry><title>E1</title><link href="https://ex.com/1"/>` +
        `<updated>2014-12-29T14:53:35+02:00</updated>` +
        `<content type="html">&lt;p&gt;hi&lt;/p&gt;</content></entry>` +
        `<entry><title>E2</title><link href="https://ex.com/2"/>` +
        `<content src="https://ex.com/media" type="video/mp4"/>` +
        `<summary>only summary</summary></entry>` +
        `</feed>`,
    ),
  );

  assert.equal(feed.entries.length, 2);
  assert.equal(feed.authors[0].name, "Feed Author");
  assert.equal(feed.entries[0].title, "E1");
  assert.equal(feed.entries[0].updated.toISOString(), "2014-12-29T12:53:35.000Z");
  assert.equal(extractContent(feed.entries[0]), "<p>hi</p>");
  assert.equal(feed.entries[1].links[0].href, "https://ex.com/2");
  assert.equal(extractContent(feed.entries[1]), "only summary");
});

test("parses JSON feeds", () => {
  const feed = parseFeed(
    encoder.encode(
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "JSON",
        authors: [{ name: "Feed A" }],
        items: [
          {
            id: "1",
            url: "https://j.com/1",
            title: "J1",
            content_html: "<p>j1</p>",
            date_published: "2020-01-02T03:04:05Z",
          },
          { id: "2", external_url: "https://j.com/2", content_text: "  plain text  ", summary: "s" },
        ],
      }),
    ),
  );

  assert.equal(feed.entries.length, 2);
  assert.equal(feed.entries[0].title, "J1");
  assert.equal(extractContent(feed.entries[0]), "<p>j1</p>");
  assert.equal(feed.entries[0].published.toISOString(), "2020-01-02T03:04:05.000Z");
  // items without an author inherit the feed's authors
  assert.equal(extractEntryAuthor(feed.entries[1], feed), "Feed A");
  assert.equal(feed.entries[1].links[0].href, "https://j.com/2");
  assert.equal(extractContent(feed.entries[1]), "plain text");
});

test("parses RSS 1.0 (RDF) and drops linkless items", () => {
  const feed = parseFeed(
    encoder.encode(
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" ` +
        `xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
        `<channel><title>C</title><dc:creator>Channel Author</dc:creator></channel>` +
        `<item><title>R1</title><link>https://r.com/1</link><dc:creator>Bob</dc:creator>` +
        `<content:encoded><![CDATA[<b>r1</b>]]></content:encoded></item>` +
        `<item><title>NoLink</title><description>ignored</description></item>` +
        `</rdf:RDF>`,
    ),
  );

  assert.equal(feed.authors[0].name, "Channel Author");
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].links[0].href, "https://r.com/1");
  assert.equal(extractEntryAuthor(feed.entries[0], feed), "Bob");
  assert.equal(extractContent(feed.entries[0]), "<b>r1</b>");
});

test("uses media descriptions as the last content fallback", () => {
  const feed = parseFeed(
    encoder.encode(
      `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>` +
        `<item><title>M</title><link>https://m.com/1</link>` +
        `<media:content url="https://m.com/a.mp4"/><media:description>media desc</media:description>` +
        `</item></channel></rss>`,
    ),
  );
  assert.equal(extractContent(feed.entries[0]), "media desc");
});

test("rejects unknown root elements and unsupported JSON versions", () => {
  assert.throws(() => parseFeed(encoder.encode("<html><body/></html>")));
  assert.throws(() => parseFeed(encoder.encode('{"version":"https://jsonfeed.org/version/2","title":"x","items":[]}')));
  assert.throws(() => parseFeed(encoder.encode("not a feed")));
});

// ── cache ──

function fakeKv(store = new Map()) {
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) {
        return null;
      }
      const value = store.get(key);
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

function fakeFeedsD1(feeds) {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: feeds };
        },
      };
    },
  };
}

test("listFeedsCached caches and invalidates feed rows", async () => {
  const kv = fakeKv();
  const d1 = fakeFeedsD1([{ id: 1, title: "Feed", last_fetched_on: 10 }]);
  const env = {};

  const first = await cache.listFeedsCached(d1, kv, env);
  assert.deepEqual(first, [{ id: 1, title: "Feed", last_fetched_on: 10 }]);
  assert.ok(kv.store.has(cache.KEY_FEEDS));

  const second = await cache.listFeedsCached(fakeFeedsD1([]), kv, env);
  assert.deepEqual(second, first);

  await cache.invalidate(kv, cache.CacheEvent.feedsChanged());
  assert.equal(kv.store.has(cache.KEY_FEEDS), false);
  assert.equal(kv.store.has(cache.KEY_MAX_FEED_FETCHED_ON), false);
});

test("cache invalidation deletes only the affected keys", async () => {
  const kv = fakeKv();
  for (const key of [
    cache.KEY_FEEDS,
    cache.KEY_GROUPS,
    cache.KEY_FEEDS_GROUPS,
    cache.KEY_GROUPS_COUNTS,
    cache.KEY_TOTAL_ITEMS,
    cache.KEY_MAX_FEED_FETCHED_ON,
    cache.KEY_UNREAD_IDS,
    cache.KEY_SAVED_IDS,
  ]) {
    kv.store.set(key, "cached");
  }

  await cache.invalidate(kv, cache.CacheEvent.markRead());
  assert.equal(kv.store.has(cache.KEY_UNREAD_IDS), false);
  assert.equal(kv.store.has(cache.KEY_SAVED_IDS), true);

  await cache.invalidate(kv, cache.CacheEvent.markSaved());
  assert.equal(kv.store.has(cache.KEY_SAVED_IDS), false);

  await cache.invalidate(kv, cache.CacheEvent.itemsAdded([1, 2]));
  assert.equal(kv.store.has(cache.KEY_TOTAL_ITEMS), false);
  assert.equal(kv.store.has(cache.KEY_FEEDS), true);

  await cache.invalidate(kv, cache.CacheEvent.groupsChanged());
  assert.equal(kv.store.has(cache.KEY_GROUPS), false);

  await cache.invalidate(kv, cache.CacheEvent.groupCountsChanged());
  assert.equal(kv.store.has(cache.KEY_GROUPS_COUNTS), false);
});

test("fetchAllFeeds skips feeds when none are stale", async () => {
  const d1 = {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [] };
        },
      };
    },
  };
  const summary = await fetchAllFeeds(d1, 5, 3600);
  assert.deepEqual(summary, {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    updated_feed_ids: [],
    new_items: 0,
    duration_ms: summary.duration_ms,
  });
});
