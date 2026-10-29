import { isAuthenticated } from "./auth.js";
import * as cache from "./cache.js";
import * as db from "./db.js";
import { fetchFeedById } from "./fetcher.js";
import { page, styles, script } from "./admin-page.js";
import { md5 } from "./md5.js";
import { formatError, logError } from "./log.js";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function response(body, status = 200, type = "application/json; charset=utf-8") {
  return new Response(type.startsWith("application/json") ? JSON.stringify(body) : body, {
    status,
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

async function readBody(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "请使用 JSON 请求");
  }
  // Enforce the limit on actual bytes, not the optional Content-Length header.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容不能为空");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new HttpError(413, "请求内容过大"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, "无效的 JSON 请求"); }
}

function text(body, key, required = true) {
  const value = body[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value.trim()) || value.length > 2048) {
    throw new HttpError(400, `请填写有效的 ${key}`);
  }
  return value.trim();
}

function httpUrl(value, optional = false) {
  if (!value && optional) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new HttpError(400, "订阅地址和网站地址必须是有效的 HTTP(S) URL"); }
}

async function invalidate(env, events) {
  if (env.CACHE) await Promise.all(events.map(event => cache.invalidate(env.CACHE, event)));
}

export async function handleAdminRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  try {
    if (request.method === "GET") {
      if (["/", "/admin"].includes(path)) return response(page, 200, "text/html; charset=utf-8");
      if (path === "/admin/style.css") return response(styles, 200, "text/css; charset=utf-8");
      if (path === "/admin/app.js") return response(script, 200, "text/javascript; charset=utf-8");
    }
    if (!path.startsWith("/admin/api/")) return response({ error: "页面不存在" }, 404);
    const origin = request.headers.get("origin");
    if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new HttpError(403, "不允许跨站管理请求");
    }
    if (path === "/admin/api/login" && request.method === "POST") {
      const body = await readBody(request);
      const email = text(body, "email");
      // Passwords deliberately retain leading/trailing whitespace.
      if (typeof body.password !== "string" || body.password.length > 2048) throw new HttpError(400, "请输入密码");
      const apiKey = md5(`${email}:${body.password}`);
      if (!isAuthenticated(apiKey, env)) throw new HttpError(401, "账号或密码错误");
      return response({ api_key: apiKey });
    }
    const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{32})$/)?.[1];
    if (!isAuthenticated(token, env)) throw new HttpError(401, "请先登录");
    if (!env.DB) throw new HttpError(503, "数据库未配置");
    const d1 = env.DB;

    if (path === "/admin/api/overview" && request.method === "GET") {
      const [feeds, groups] = await Promise.all([db.listFeedsWithCounts(d1), db.listGroupsWithCounts(d1)]);
      return response({ feeds, groups });
    }

    const feedMatch = path.match(/^\/admin\/api\/feeds(?:\/([1-9]\d*))?(\/refresh)?$/);
    if (feedMatch) {
      const id = feedMatch[1] ? Number(feedMatch[1]) : null;
      if (id !== null && !Number.isSafeInteger(id)) throw new HttpError(400, "无效的订阅源 ID");
      const existing = id === null ? null : await db.getFeed(d1, id);
      if (id !== null && !existing) throw new HttpError(404, "订阅源不存在");
      if (id && feedMatch[2] && request.method === "POST") {
        try { await fetchFeedById(d1, id); }
        finally {
          await invalidate(env, [cache.CacheEvent.feedsChanged(), cache.CacheEvent.itemsAdded([id]), cache.CacheEvent.markRead()]);
        }
        return response({ feed: await db.getFeed(d1, id) });
      }
      if (!feedMatch[2] && ((!id && request.method === "POST") || (id && request.method === "PUT"))) {
        const body = await readBody(request);
        const title = text(body, "title");
        const feedUrl = httpUrl(text(body, "url"));
        const siteUrl = httpUrl(text(body, "site_url", false), true);
        const groupId = body.group_id ?? 0;
        if (!Number.isSafeInteger(groupId) || groupId < 0 || (groupId > 0 && !await db.getGroup(d1, groupId))) {
          throw new HttpError(400, "请选择有效的分组");
        }
        if (id) await db.updateFeed(d1, id, title, feedUrl, siteUrl, groupId);
        const feed = id ? await db.getFeed(d1, id) : await db.createFeed(d1, title, feedUrl, siteUrl, groupId);
        await invalidate(env, [cache.CacheEvent.feedsChanged(), cache.CacheEvent.groupCountsChanged()]);
        return response({ feed }, id ? 200 : 201);
      }
      if (id && !feedMatch[2] && request.method === "DELETE") {
        await db.deleteFeed(d1, id);
        await invalidate(env, [cache.CacheEvent.feedsChanged(), cache.CacheEvent.groupCountsChanged(), cache.CacheEvent.itemsAdded([id]), cache.CacheEvent.markRead(), cache.CacheEvent.markSaved()]);
        return response({ ok: true });
      }
    }

    const groupMatch = path.match(/^\/admin\/api\/groups(?:\/([1-9]\d*))?$/);
    if (groupMatch) {
      const id = groupMatch[1] ? Number(groupMatch[1]) : null;
      if (id !== null && (!Number.isSafeInteger(id) || !await db.getGroup(d1, id))) throw new HttpError(404, "分组不存在");
      if ((!id && request.method === "POST") || (id && request.method === "PUT")) {
        const title = text(await readBody(request), "title");
        if (id) await db.updateGroup(d1, id, title);
        const group = id ? await db.getGroup(d1, id) : await db.createGroup(d1, title);
        await invalidate(env, [cache.CacheEvent.groupsChanged(), cache.CacheEvent.groupCountsChanged()]);
        return response({ group }, id ? 200 : 201);
      }
      if (id && request.method === "DELETE") {
        await db.deleteGroup(d1, id);
        await invalidate(env, [cache.CacheEvent.groupsChanged(), cache.CacheEvent.groupCountsChanged(), cache.CacheEvent.feedsChanged()]);
        return response({ ok: true });
      }
    }
    return response({ error: "接口不存在或不支持此操作" }, 404);
  } catch (error) {
    if (error instanceof HttpError) return response({ error: error.message }, error.status);
    if (String(error).includes("UNIQUE constraint failed: feeds.url")) return response({ error: "这个订阅地址已存在" }, 409);
    logError(`admin: ${formatError(error)}`);
    return response({ error: "操作失败，请稍后重试或查看服务日志" }, 500);
  }
}
