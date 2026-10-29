import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { handleAdminRequest } from "../src/admin.js";
import worker from "../src/index.js";
import { script } from "../src/admin-page.js";
import { initAppearance, normalizeAppearance } from "../src/admin-appearance.js";
import * as cache from "../src/cache.js";
import { md5 } from "../src/md5.js";

test("appearance preferences reject unknown values and retain defaults", () => {
  assert.deepEqual(normalizeAppearance(null), { theme: "system", accent: "green", font: "standard", density: "comfortable" });
  assert.deepEqual(normalizeAppearance({ theme: "dark", accent: "blue", font: "extra-large", density: "compact", token: "secret" }), { theme: "dark", accent: "blue", font: "extra-large", density: "compact" });
  assert.deepEqual(normalizeAppearance({ theme: "invalid", accent: "invalid", font: "invalid" }), normalizeAppearance(null));
});

test("appearance applies saved preferences, follows system, and tolerates blocked storage", () => {
  const source = `(${initAppearance.toString()})(${normalizeAppearance.toString()})`;
  for (const blocked of [false, true]) {
    const controls = new Map();
    const document = {
      documentElement: { dataset: {} },
      getElementById(id) {
        if (!controls.has(id)) controls.set(id, { handlers: {}, value: "", addEventListener(event, fn) { this.handlers[event] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
        return controls.get(id);
      },
    };
    const system = { matches: true, addEventListener(event, fn) { this.change = fn; } };
    let saved = JSON.stringify({ theme: "system", accent: "purple", font: "large", density: "compact" });
    const window = {
      matchMedia() { return system; },
      localStorage: {
        getItem() { if (blocked) throw new Error("blocked"); return saved; },
        setItem(key, value) { if (blocked) throw new Error("blocked"); saved = value; },
      },
      addEventListener(event, fn) { this[event] = fn; },
    };
    new Script(source).runInNewContext({ document, window });
    assert.equal(document.documentElement.dataset.theme, "dark");
    system.matches = false; system.change();
    assert.equal(document.documentElement.dataset.theme, "light");
    controls.get("appearance-theme").handlers.change({ target: { value: "dark" } });
    assert.equal(document.documentElement.dataset.theme, "dark");
    controls.get("appearance-font").handlers.change({ target: { value: "extra-large" } });
    assert.equal(document.documentElement.dataset.font, "extra-large");
    if (!blocked) assert.equal(JSON.parse(saved).font, "extra-large");
    else assert.match(controls.get("appearance-status").textContent, /不允许保存/);
    controls.get("appearance-open").handlers.click();
    assert.equal(controls.get("appearance").open, true);
    controls.get("appearance-done").handlers.click();
    assert.equal(controls.get("appearance").open, false);
    controls.get("appearance-reset").handlers.click();
    assert.equal(document.documentElement.dataset.font, "standard");
    window.storage({ key: "current.admin.appearance.v1", newValue: '{"theme":"dark","accent":"orange"}' });
    assert.equal(document.documentElement.dataset.accent, "orange");
    assert.equal(document.documentElement.dataset.theme, "dark");
  }
});

// Execute real SQL in an isolated in-memory database, exposing the D1 subset.
function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  function prepare(sql, params = []) {
    return {
      bind(...values) { return prepare(sql, values); },
      async all() { return { results: sqlite.prepare(sql).all(...params) }; },
      async run() {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { rows_written: Number(result.changes) } };
      },
    };
  }
  const deletedKeys = [];
  const env = {
    CURRENT_FEVER_EMAIL: "admin", CURRENT_FEVER_PASSWORD: "test password",
    CURRENT_STARTUP_FETCH: "false",
    DB: {
      prepare,
      async batch(statements) {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    },
    CACHE: { async delete(key) { deletedKeys.push(key); } },
  };
  const token = md5("admin:test password");
  async function request(path, method = "GET", body, headers = {}) {
    return handleAdminRequest(new Request(`https://current.test/admin/api/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
  }
  return { env, sqlite, request, deletedKeys };
}

test("admin assets are served by worker without startup fetch; Fever is unchanged", async () => {
  for (const path of ["/", "/admin", "/admin/", "/admin/style.css", "/admin/app.js"]) {
    const result = await worker.fetch(new Request(`https://current.test${path}`), {}, { waitUntil() { assert.fail("admin must not start feed fetching"); } });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.ok(result.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
    assert.equal(result.headers.get("access-control-allow-origin"), null);
  }
  const fever = await worker.fetch(new Request("https://current.test/?api"), { CURRENT_STARTUP_FETCH: "false" }, {});
  assert.deepEqual(await fever.json(), { api_version: 3, auth: 0 });
  assert.equal(fever.headers.get("access-control-allow-origin"), "*");
  assert.doesNotThrow(() => new Script(script));
});

test("admin login and management requests require valid credentials and same origin", async t => {
  const { request } = fixture(t);
  assert.equal((await request("overview", "GET", undefined, { Authorization: "" })).status, 401);
  assert.equal((await request("overview", "GET", undefined, { Origin: "https://evil.test" })).status, 403);
  assert.equal((await request("overview", "GET", undefined, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await request("login", "POST", { email: "admin", password: "wrong" })).status, 401);
  const result = await request("login", "POST", { email: "admin", password: "test password" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { api_key: md5("admin:test password") });
});

test("feed and group CRUD preserve counts, unread state, and invalidate Fever caches", async t => {
  const { request, sqlite, deletedKeys } = fixture(t);
  let result = await request("groups", "POST", { title: "技术" });
  assert.equal(result.status, 201);
  const { group } = await result.json();
  const input = { title: "测试订阅", url: "https://example.test/feed", site_url: "https://example.test", group_id: group.id };
  result = await request("feeds", "POST", input);
  assert.equal(result.status, 201);
  const { feed } = await result.json();
  assert.equal(feed.group_id, group.id);
  assert.equal((await request("feeds", "POST", input)).status, 409);
  sqlite.prepare("INSERT INTO items (feed_id, title, url, is_saved) VALUES (?, 'post', 'https://example.test/post', 1)").run(feed.id);
  let overview = await (await request("overview")).json();
  assert.equal(overview.feeds[0].item_count, 1);
  assert.equal(overview.feeds[0].unread_count, 1);
  assert.equal(overview.groups[0].subscription_count, 1);
  sqlite.exec("INSERT INTO read_item_ids (item_id) SELECT id FROM items");
  overview = await (await request("overview")).json();
  assert.equal(overview.feeds[0].unread_count, 0);
  sqlite.prepare("UPDATE feeds SET last_fetched_on = 123, last_http_status = 200 WHERE id = ?").run(feed.id);
  result = await request(`feeds/${feed.id}`, "PUT", { ...input, title: "已改名", url: "https://example.test/new.xml" });
  assert.equal(result.status, 200);
  const updated = (await result.json()).feed;
  assert.equal(updated.title, "已改名");
  assert.equal(updated.last_fetched_on, 0);
  assert.equal(updated.last_http_status, 0);
  assert.equal((await request(`groups/${group.id}`, "PUT", { title: "已改分组" })).status, 200);
  assert.equal((await request(`groups/${group.id}`, "DELETE")).status, 200);
  overview = await (await request("overview")).json();
  assert.equal(overview.groups.length, 0);
  assert.equal(overview.feeds[0].group_id, 0);
  assert.equal((await request(`feeds/${feed.id}`, "DELETE")).status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM items").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM read_item_ids").get().n, 0);
  assert.deepEqual(await (await request("overview")).json(), { feeds: [], groups: [] });
  for (const key of [cache.KEY_FEEDS, cache.KEY_FEEDS_GROUPS, cache.KEY_GROUPS, cache.KEY_GROUPS_COUNTS, cache.KEY_TOTAL_ITEMS, cache.KEY_UNREAD_IDS, cache.KEY_SAVED_IDS, cache.KEY_MAX_FEED_FETCHED_ON]) assert.ok(deletedKeys.includes(key), key);
});

test("admin rejects invalid URLs, invalid groups, malformed JSON and oversized bodies", async t => {
  const { request, env } = fixture(t);
  const input = { title: "test", url: "https://example.test/feed" };
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.test/rss", "https://user:password@example.test/rss", "invalid"]) {
    assert.equal((await request("feeds", "POST", { ...input, url })).status, 400);
  }
  for (const group_id of [-1, "0", 999, 1.5]) assert.equal((await request("feeds", "POST", { ...input, group_id })).status, 400);
  assert.equal((await request("feeds", "POST", { ...input, title: " " })).status, 400);
  assert.equal((await request("feeds/999", "DELETE")).status, 404);
  assert.equal((await request("groups/999", "PUT", { title: "test" })).status, 404);
  assert.equal((await request("groups", "POST", { title: "x".repeat(20000) })).status, 413);
  assert.equal((await request("groups", "POST", { title: "test" }, { "Content-Type": "text/plain" })).status, 415);
  for (const body of ["{broken", "[]", "null"]) {
    const result = await handleAdminRequest(new Request("https://current.test/admin/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body }), env);
    assert.equal(result.status, 400);
  }
});

test("single feed refresh stores entries and invalidates counts", async t => {
  const { request, deletedKeys } = fixture(t);
  const { feed } = await (await request("feeds", "POST", { title: "Refresh", url: "https://example.test/rss" })).json();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('<rss version="2.0"><channel><title>Feed</title><item><title>New</title><link>https://example.test/post</link><description>content</description></item></channel></rss>', { status: 200 });
  const result = await request(`feeds/${feed.id}/refresh`, "POST");
  assert.equal(result.status, 200);
  assert.equal((await result.json()).feed.last_http_status, 200);
  const overview = await (await request("overview")).json();
  assert.equal(overview.feeds[0].item_count, 1);
  assert.equal(overview.feeds[0].unread_count, 1);
  assert.ok(deletedKeys.includes(cache.KEY_UNREAD_IDS));
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  assert.equal((await (await request(`feeds/${feed.id}/refresh`, "POST")).json()).feed.last_http_status, 503);
});
