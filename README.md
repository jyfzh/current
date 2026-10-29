[**English**](README.md) | [**中文**](README.zh-CN.md)

# Current — Fever-compatible RSS Reader Backend

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white) ![D1](https://img.shields.io/badge/D1-FFA116?style=for-the-badge&logo=cloudflare&logoColor=white)

**Current** is a self-hosted RSS feed reader backend that implements the [Fever API](https://feedafever.com/api) protocol. Built with **plain JavaScript** (ES modules, no runtime dependencies), it runs on **Cloudflare Workers** with D1 as the database and KV as the cache layer.

Use it as the server-side sync engine for any Fever-compatible RSS client — [Reeder](https://reederapp.com), [fluent-reader](https://hyliu.me/fluent-reader) and more.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
  - [Storage](#storage)
- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Usage — Connecting RSS Clients](#usage--connecting-rss-clients)
  - [General setup](#general-setup)
  - [Adding feeds](#adding-feeds)
  - [Marking feed as read](#marking-feed-as-read)
- [API Reference](#api-reference)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Features

- **Fever API v3** — full read/sync protocol implementation: groups, feeds, items, read/unread/saved state
- **Feed format support** — parses **RSS 2.0**, **Atom**, and **JSON Feed** subscriptions with a built-in zero-dependency parser
- **Concurrent feed fetching** — fetch multiple feeds in parallel with configurable concurrency
- **Cron-based auto-sync** — periodic feed refreshing via Workers Cron Triggers (default: every hour)
- **Startup fetch** — triggers an initial full sync on the first HTTP request after deployment
- **KV caching** — D1 query results are cached in KV for fast API responses; cache is selectively invalidated on mutations
- **Deduplication** — database-level unique indexes prevent duplicate items by `(feed_id, url)` and `(feed_id, title)`
- **CORS support** — cross-origin requests enabled for web-based RSS clients
- **Observability** — structured `[INFO]` / `[WARN]` / `[ERROR]` logging for Cloudflare dashboard inspection
- **Secure auth** — constant-time string comparison for API key validation

## Architecture

```
┌──────────────────────────┐
│  Fever-compatible Client │  (Reeder, Fiery Feeds, etc.)
│  GET/POST ?api&...       │
└─────────┬────────────────┘
          │ Fever API protocol
          ▼
┌──────────────────────────┐
│   Cloudflare Worker      │  Plain JavaScript (ES modules)
│   ┌──────────────────┐   │
│   │  fever.js        │   │  API request routing & response
│   │  auth.js         │   │  md5(email:password) authentication
│   │  fetcher.js      │   │  Concurrent RSS feed fetching & parsing
│   │  feedparser.js   │   │  RSS / Atom / JSON Feed parsing
│   │  db.js           │   │  D1 database access layer
│   │  cache.js        │   │  KV-backed cache-aside layer
│   │  var.js          │   │  Runtime configuration from env vars
│   │  models.js       │   │  Data models & Fever API response types
│   └──────────────────┘   │
└──────────────────────────┘
          │
     ┌────┴────┐
     ▼         ▼
┌─────────┐ ┌──────┐
│  D1 DB  │ │  KV  │
│  SQLite │ │Cache │
└─────────┘ └──────┘
```

### Storage

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Database** | Cloudflare D1 (SQLite) | Feeds, groups, items, read state |
| **Cache** | Cloudflare KV | Cached D1 queries for fast reads (feeds, groups, unread/saved IDs, item counts) |
| **Cache strategy** | Cache-aside | Read: KV → miss → D1 → backfill KV. Write: invalidate affected KV keys |

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22.18+ (required by the [`cf` CLI](https://developers.cloudflare.com/cf/))
- A [Cloudflare](https://cloudflare.com) account with:
  - Workers subscription (free plan works)
  - D1 database quota
  - KV namespace quota

## Deployment

### 1. Clone & install

```bash
git clone https://github.com/jyfzh/current
cd current
npm install
```

### 2. Configure cloudflare.config.ts

`cloudflare.config.ts` is the source of truth for the Worker: bindings, the hourly cron trigger, and runtime vars. The worker is plain JavaScript, so there is no user-authored build step — `npm run build` (`cf build`) bundles `src/index.js` with Vite through the Cloudflare Vite plugin.

`vite.config.ts` configures the bundler and the local dev server port (default `8787`).

### 3. Deploy to production

#### 3a. Create remote D1 database

```bash
npx cf d1 create --name current-db
```

The command outputs a database ID. Copy it into the `DB` binding in `cloudflare.config.ts`:

```ts
DB: bindings.d1({
  id: "<database-id>",
}),
```

#### 3b. Create remote KV namespace

```bash
npx cf kv namespaces create --title current-cache
```

Copy the output namespace ID into the `CACHE` binding in `cloudflare.config.ts`:

```ts
CACHE: bindings.kv({
  id: "<namespace-id>",
}),
```

#### 3c. Initialize the remote database

```bash
npx cf d1 migrations apply <database-id> --dir migrations
```

#### 3d. Set secrets

Create a `.secrets` file (it is gitignored) in `.env` format:

```bash
cat > .secrets <<'EOF'
CURRENT_FEVER_PASSWORD=<your-password>
CURRENT_FEVER_EMAIL=<your-email>
EOF
```

Both names are declared as required secrets in `cloudflare.config.ts`. Upload them with `--secrets-file`:

```bash
npx cf deploy --secrets-file .secrets
```

To rotate a secret later, update `.secrets` and deploy with the same flag, or set one individually with `npx cf workers secrets update CURRENT_FEVER_PASSWORD --text <value> --worker current`.

#### 3e. Deploy

```bash
npx cf auth login   # first time only
npm run deploy      # or: npx cf deploy
```

After deployment, your API endpoint will be:

```
https://current.<your-subdomain>.workers.dev/?api
```

### 4. Verify

```bash
curl "https://current.<your-subdomain>.workers.dev/?api&api_key=$(echo -n '<email>:<password>' | md5sum | cut -d' ' -f1)"
```

Expected response:

```json
{"api_version":3,"auth":1}
```

---

## Configuration

All configuration is through Worker environment variables, set in `cloudflare.config.ts` with `bindings.text(...)` (vars) or `bindings.secret()` (secrets):

### Secrets (required)

| Variable | Description |
|----------|-------------|
| `CURRENT_FEVER_PASSWORD` | Fever API password (used with email for auth) |
| `CURRENT_FEVER_EMAIL` | Fever API email (default: `admin`. Used with password for auth) |

### Runtime variables (all optional with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `CURRENT_MAX_CONCURRENCY` | `5` | Max concurrent feed fetches (`0` = unlimited) |
| `CURRENT_FEED_STALE_SECONDS` | `3600` | Min age (seconds) before a feed is eligible for re-fetch |
| `CURRENT_STARTUP_FETCH` | `true` | Trigger initial full feed fetch on first HTTP request after deploy |
| `CURRENT_CACHE_TTL_AGGREGATE` | `600` | KV cache TTL for aggregate queries (total items, group counts) |
| `CURRENT_CACHE_TTL_STRUCTURAL` | `600` | KV cache TTL for structural data (feeds, groups, unread/saved IDs) |
| `CURRENT_FEVER_ITEMS_PER_PAGE` | `50` | Number of items per API response page |

---

## Usage — Connecting RSS Clients

Current speaks the **Fever API protocol**, so any RSS reader that supports Fever sync can connect to it.

### General setup

1. Open your RSS client's account/sync settings
2. Select **Fever** as the sync type
3. Enter:
   - **URL**: `https://current.<your-subdomain>.workers.dev/?api`
   - **Email**: whatever you set for `CURRENT_FEVER_EMAIL` (default: `admin`)
   - **Password**: whatever you set for `CURRENT_FEVER_PASSWORD`

### Adding feeds

Open `/` or `/admin` to access the Chinese-language management dashboard. Sign in with `CURRENT_FEVER_EMAIL` (defaults to `admin`) and `CURRENT_FEVER_PASSWORD`.

The dashboard supports adding, editing, deleting, searching and filtering feeds; creating, renaming and deleting groups; inspecting unread counts and HTTP fetch status; and refreshing individual feeds. Deleting a group preserves its feeds as ungrouped. Deleting a feed also deletes its articles, saved state and read history, after confirmation.

Management endpoints live under `/admin/api/`, separate from the unchanged `/?api` Fever protocol. Credentials stay in page memory only; reloading requires signing in again. Use HTTPS in production. A successful HTTP status does not guarantee successful feed parsing; consult service logs for parsing details. No additional migrations or runtime dependencies are required.

For bulk maintenance, you can also add feeds directly to D1:

You can execute SQL against the D1 database using either of the following methods:

#### Cloudflare Dashboard (D1 UI)

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → **D1** → select your database
3. Use the **Explorer Data** tab to run SQL queries interactively, or view, add, and delete rows directly through the UI

#### cf CLI

```bash
# Execute SQL directly (use the database ID shown by `cf d1 create`)
npx cf d1 raw <database-id> --sql "INSERT INTO groups (title) VALUES ('Tech');"

# Apply SQL from a file as a batch
npx cf d1 raw <database-id> --batch @queries.json
```

`queries.json` is a JSON array of query objects:

```json
[
  {
    "sql": "INSERT INTO feeds (title, url, site_url, group_id) VALUES ('Example', 'https://example.com/feed.xml', 'https://example.com', 1);"
  }
]
```

Example SQL to add feeds:

```sql
-- Add a group
INSERT INTO groups (title) VALUES ('Tech');

-- Add a feed
INSERT INTO feeds (title, url, site_url, group_id)
VALUES ('Example Blog', 'https://example.com/rss', 'https://example.com', 1);
```

The next cron run (or first API request if `CURRENT_STARTUP_FETCH` is enabled) will fetch and populate items.

### Marking feed as read

From the RSS client, select the feed/group and use the "Mark as Read" action. The client sends the appropriate `mark=feed&as=read&id=N&before=TS` command, and Current handles it.

---

## API Reference

The Fever API protocol is fully documented in [`docs/fever-api.md`](docs/fever-api.md) and the OpenAPI spec at [`docs/fever-openapi.yaml`](docs/fever-openapi.yaml).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | JavaScript (ES modules) |
| Runtime | Cloudflare Workers |
| Tooling | [`cf`](https://developers.cloudflare.com/cf/) (Cloudflare CLI, beta) |
| Database | Cloudflare D1 (SQLite-compatible) |
| Cache | Cloudflare KV |
| Feed Parsing | Built-in parser (RSS 2.0, Atom, JSON Feed) |
| Auth | MD5 (Fever protocol) |
| Scheduling | Workers Cron Triggers |

---

## Roadmap

- **AI-powered feed clustering** — Automatically group feeds into topic clusters (e.g., Tech, Science, Politics) using [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) embeddings and [Vectorize](https://developers.cloudflare.com/vectorize/), so new subscriptions are categorized without manual setup.
- **Personalized recommendations** — Surface trending or relevant items based on your reading history, powered by on-device-style inference via Workers AI.
- **Smart summaries & highlights** — Generate concise summaries for unread items using an LLM running on Workers AI, stored back to D1 for quick recall.
- **Hot topics detection** — Analyze item titles and content across all feeds to identify emerging topics and spikes in coverage, delivered as a new API endpoint.

> These features will leverage Cloudflare's global AI inference network, keeping data processing close to the database and minimizing latency.

---

## License

[MIT](LICENSE) © 2026 jyfzh
