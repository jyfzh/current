[**English**](README.md) | [**中文**](README.zh-CN.md)

# Current — Fever-compatible RSS Reader Backend

![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white) ![D1](https://img.shields.io/badge/D1-FFA116?style=for-the-badge&logo=cloudflare&logoColor=white) ![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?style=for-the-badge&logo=webassembly&logoColor=white)

**Current** is a self-hosted RSS feed reader backend that implements the [Fever API](https://feedafever.com/api) protocol. Built with **Rust** and compiled to **WebAssembly**, it runs on **Cloudflare Workers** with D1 as the database and KV as the cache layer.

Use it as the server-side sync engine for any Fever-compatible RSS client — [Reeder](https://reederapp.com), [fluent-reader](https://hyliu.me/fluent-reader) and more.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jyfzh/current)

> [!IMPORTANT]
> **Do not click the button above before completing these steps, otherwise deployment will fail:**
>
> 1. **Fork** this repository to your GitHub account
> 2. **Create a D1 database** — via Cloudflare Dashboard or run `npx wrangler d1 create current-db`
> 3. **Create a KV namespace** — run `npx wrangler kv:namespace create current-cache`
> 4. Paste the generated **database_id** and **KV id** into the corresponding fields in `wrangler.jsonc`
> 5. Then click the button above and select your fork to deploy
>
> After deployment, you still need to **initialize the database schema** and **set secrets** — see the [Deployment](#deployment) section below for details.

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
- **Feed format support** — parses **RSS 2.0**, **Atom**, and **JSON Feed** subscriptions via [`feed-rs`](https://crates.io/crates/feed-rs)
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
│   Cloudflare Worker      │  Rust → WebAssembly (worker-build)
│   ┌──────────────────┐   │
│   │  fever.rs        │   │  API request routing & response
│   │  auth.rs         │   │  md5(email:password) authentication
│   │  fetcher.rs      │   │  Concurrent RSS feed fetching & parsing
│   │  db.rs           │   │  D1 database access layer
│   │  cache.rs        │   │  KV-backed cache-aside layer
│   │  var.rs          │   │  Runtime configuration from env vars
│   │  models.rs       │   │  Data models & Fever API response types
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

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (latest stable)
- [wrangler](https://developers.cloudflare.com/workers/wrangler/) CLI (`npm install -g wrangler`)
- A [Cloudflare](https://cloudflare.com) account with:
  - Workers subscription (free plan works)
  - D1 database quota
  - KV namespace quota

## Deployment

### 1. Clone & install

```bash
git clone https://github.com/jyfzh/current
cd current
```

### 2. Configure wrangler

> **Note:** The project uses `worker-build` (via `cargo`) to compile Rust to WebAssembly. The `wrangler.jsonc` build command handles this automatically.

### 3. Deploy to production

#### 3a. Create remote D1 database

```bash
wrangler d1 create current-db
```

The command outputs a database ID. Copy it into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_id": "your-database-id-here"
  }
]
```

#### 3b. Create remote KV namespace

```bash
wrangler kv:namespace create current-cache
```

Copy the output ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "CACHE",
    "id": "your-kv-id-here"
  }
]
```

#### 3c. Initialize the remote database

```bash
wrangler d1 execute current-db --remote --file=migrations/0001_init.sql
```

#### 3d. Set secrets

```bash
wrangler secret put CURRENT_FEVER_PASSWORD
wrangler secret put CURRENT_FEVER_EMAIL
```

#### 3e. Deploy

```bash
wrangler deploy
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

All configuration is through Worker environment variables (set via `wrangler.jsonc` `vars` or `wrangler secret put`):

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

Currently feeds must be added directly to the D1 database (the Fever API write endpoints for feed/group management are not yet implemented).

You can execute SQL against the D1 database using either of the following methods:

#### Cloudflare Dashboard (D1 UI)

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → **D1** → select your database
3. Use the **Explorer Data** tab to run SQL queries interactively, or view, add, and delete rows directly through the UI

#### Wrangler CLI

```bash
# Execute SQL directly
wrangler d1 execute current-db --remote --command="INSERT INTO groups (title) VALUES ('Tech');"

# Execute from a SQL file
wrangler d1 execute current-db --remote --file=add_feeds.sql
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
| Language | Rust (edition 2024) |
| Runtime | Cloudflare Workers (WebAssembly via `worker-build`) |
| Database | Cloudflare D1 (SQLite-compatible) |
| Cache | Cloudflare KV |
| Feed Parsing | [`feed-rs`](https://crates.io/crates/feed-rs) (RSS 2.0, Atom, JSON Feed) |
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
