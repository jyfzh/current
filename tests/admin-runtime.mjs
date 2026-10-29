// Optional real workerd smoke: npm run build && node tests/admin-runtime.mjs
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: ".cloudflare/output/v0/workers/default/bundle/index.js",
  compatibilityDate: "2026-05-11",
  d1Databases: ["DB"],
  kvNamespaces: ["CACHE"],
  bindings: {
    CURRENT_FEVER_EMAIL: "admin",
    CURRENT_FEVER_PASSWORD: "runtime-test-only",
    CURRENT_STARTUP_FETCH: "false",
  },
}));

try {
  const db = await runtime.getD1Database("DB");
  const sql = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8")
    .split("\n").filter(line => !line.trim().startsWith("--")).join("\n");
  await db.batch(sql.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
  const origin = "https://current.test";
  assert.equal((await runtime.dispatchFetch(`${origin}/admin`)).status, 200);
  const login = await runtime.dispatchFetch(`${origin}/admin/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin", password: "runtime-test-only" }),
  });
  assert.equal(login.status, 200);
  const { api_key } = await login.json();
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${api_key}` };
  const create = await runtime.dispatchFetch(`${origin}/admin/api/feeds`, {
    method: "POST", headers,
    body: JSON.stringify({ title: "Runtime", url: "https://example.test/rss" }),
  });
  assert.equal(create.status, 201);
  const { feed } = await create.json();
  const overview = await runtime.dispatchFetch(`${origin}/admin/api/overview`, { headers });
  assert.equal((await overview.json()).feeds.length, 1);
  assert.equal((await runtime.dispatchFetch(`${origin}/admin/api/feeds/${feed.id}`, { method: "DELETE", headers })).status, 200);
  const fever = await runtime.dispatchFetch(`${origin}/?api&api_key=${api_key}`);
  assert.equal((await fever.json()).auth, 1);
  console.log("PASS: Workers runtime assets, login, D1 CRUD, KV invalidation and Fever authentication");
} finally {
  await runtime.dispose();
}
