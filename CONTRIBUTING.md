# Contributing to Current

Thank you for considering contributing to **Current**! This document covers how to set up your development environment, code conventions, testing, and the pull request process.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Testing](#testing)
- [Deployment](#deployment)
- [Code Conventions](#code-conventions)
- [Logging & Observability](#logging--observability)
- [Cache Strategy](#cache-strategy)
- [Pull Request Process](#pull-request-process)
- [Questions?](#questions)

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Rust](https://rustup.rs/) | Latest stable (edition 2024) | Compile to WebAssembly |
| [Node.js](https://nodejs.org/) | 18+ | Wrangler CLI runtime |
| [wrangler](https://developers.cloudflare.com/workers/wrangler/) | Latest | Local dev server & deploy |
| [worker-build](https://github.com/cloudflare/workers-sdk/tree/main/packages/worker-build) | Latest | Compiles Rust to Worker WASM bundle |

Install wrangler globally:

```bash
npm install -g wrangler
```

---

## Local Development

### 1. Clone the repository

```bash
git clone https://github.com/jyfzh/current
cd current
```

### 2. Set up local secrets

Create a `.dev.vars` file in the project root (never commit it):

```env
CURRENT_FEVER_PASSWORD=dev-password
CURRENT_FEVER_EMAIL=admin
```

### 3. Configure bindings

Edit `wrangler.jsonc` and make sure the `d1_databases` and `kv_namespaces` entries exist.
The `database_id` and `id` values are only needed for remote deployment;
for local development, `wrangler dev` auto-simulates them via Miniflare.

### 4. Bootstrap the database schema (local)

This creates the tables in the local Miniflare-simulated D1:

```bash
wrangler d1 execute DB --local --file=migrations/0001_init.sql
```

### 5. Seed test data (optional)

```bash
wrangler d1 execute DB --local --file=tests/seed.sql
```

### Run the worker locally

```bash
wrangler dev
```

This starts a local server at `http://localhost:8787`. The worker automatically fetches feeds on the first request if `CURRENT_STARTUP_FETCH` is enabled (default: true). For development, you may want to disable it:

```env
CURRENT_STARTUP_FETCH=false
```

## Build for production

```bash
wrangler build
```

Output goes to `build/`:

```
build/
├── index.js          # JavaScript shim
├── index_bg.wasm     # Compiled WebAssembly binary
├── worker/           # Worker module output
└── package.json
```

### Iterative development flow

1. Edit Rust code in `src/`
2. Run `cargo check` for fast type-checking
3. Run `cargo test` for unit tests
4. Run `wrangler dev` to test against real HTTP requests
5. Deploy with `wrangler deploy`

---

## Testing

### Unit tests

Rust unit tests are co-located with source files using `#[cfg(test)] mod tests`:

```bash
cargo test
```

Current test coverage includes:
- **`auth.rs`** — secure_eq constant-time comparison, authentication logic
- **`fetcher.rs`** — concurrency window calculation, author extraction cascading fallback, content extraction priority
- **`models.rs`** — FeverResponse serialization (unauth, ok, full response), all DTO round-trips, backwards compatibility for old cache entries

### Integration tests

Integration tests require a running instance (local or deployed) and a configured D1 database:

```bash
# Set up test data
bash tests/setup-integration.sh

# Run the test suite
bash tests/test_fever_api.sh
```

### Adding tests

When contributing:
- **Bug fixes** — add a test that reproduces the bug before applying the fix
- **New features** — include unit tests for new logic and integration tests for new API endpoints
- **Edge cases** — test empty states, boundary values, and failure modes

---

## Deployment

### 1. Create remote D1 database

```bash
wrangler d1 create current-db
```

Copy the returned database ID into `wrangler.jsonc` → `d1_databases[0].database_id`.

### 2. Create remote KV namespace

```bash
wrangler kv:namespace create current-cache
```

Copy the returned ID into `wrangler.jsonc` → `kv_namespaces[0].id`.

### 3. Initialize the database schema

```bash
wrangler d1 execute current-db --remote --file=migrations/0001_init.sql
```

### 4. Set secrets

```bash
wrangler secret put CURRENT_FEVER_PASSWORD
wrangler secret put CURRENT_FEVER_EMAIL
```

### 5. Deploy

```bash
wrangler deploy
```

---

## Code Conventions

### General

- **Rust edition 2024** — use modern Rust idioms (`impl Trait`, `let-else`, etc.)
- **Formatting** — `rustfmt` is enforced. Run `cargo fmt` before committing.
- **Clippy** — run `cargo clippy` and address all warnings
- **No unwrap in production code** — use `?` (error propagation), `.ok()`, or explicit error handling. `unwrap()` is acceptable only in tests.
- **Error messages** — be descriptive: include relevant identifiers (feed_id, URL, etc.) in `log_warn!` / `log_error!` messages

### Module patterns

- **Database queries** (`db.rs`) — each function takes `&D1Database`, returns `Result<T>`. Use `JsValue` bindings for parameters.
- **Cache layer** (`cache.rs`) — use `cache_or_compute()` for read paths. Every mutation must call `invalidate()` with the appropriate `CacheEvent`.
- **Handler functions** (`fever.rs`) — one sub-handler per API endpoint, named `handle_<endpoint>`. All take `&Env`, `&D1Database`, `&KvStore`.
- **Configuration** (`var.rs`) — one function per config key, with doc comments showing the env var name, default value, and behavior.

### Naming

- `snake_case` for functions, variables, and module names
- `PascalCase` for types and enum variants
- `SCREAMING_SNAKE_CASE` for constants and static variables
- Env var prefix: `CURRENT_` for all Current-specific variables
- Cache keys: prefix `cache:` (e.g., `cache:feeds`, `cache:unread_ids`)

### Imports

Order imports in groups separated by blank lines:

```rust
// 1. External crate imports
use worker::*;
use serde::{Deserialize, Serialize};

// 2. Internal crate imports
use crate::db;
use crate::models::*;

// 3. Standard library
use std::sync::Once;
```

---

## Logging & Observability

Use the structured logging macros from `log.rs`:

| Macro | Prefix | When to use |
|-------|--------|-------------|
| `log_info!` | `[INFO]` | Normal operational events (feed fetched, startup, cache stats) |
| `log_warn!` | `[WARN]` | Handled errors (parse errors, cache write failures, invalid URL) |
| `log_error!` | `[ERROR]` | Failures needing investigation (binding errors, fetch failures) |

All logs appear in the Cloudflare Dashboard under Workers & Pages > your worker > Logs.

### Performance logging

For latency-sensitive handlers, log timing information:

```rust
let started = chrono::Utc::now();
// ... handler logic ...
crate::log_info!(
    "perf route=fever.items total_items={} duration_ms={}",
    total_items,
    (chrono::Utc::now() - started).num_milliseconds().max(0)
);
```

---

## Cache Strategy

Current uses a **cache-aside** pattern with KV:

- **Read path**: check KV → miss → query D1 → backfill KV with TTL
- **Write path**: mutate D1 → invalidate affected KV keys

When adding new cached data:

```rust
// Read with cache
pub async fn get_my_data_cached(d1: &D1Database, kv: &KvStore, env: &Env) -> Result<MyData> {
    cache_or_compute(kv, "cache:my_key", var::cache_ttl_structural(env), async {
        db::get_my_data(d1).await
    })
    .await
}
```

Always define a `CacheEvent` variant for invalidation and call it in the appropriate handler.

---

## Pull Request Process

1. **Create an issue** — for significant changes, open an issue first to discuss the approach. For bug fixes, include the reproduction steps.
2. **Branch** — create a feature branch from `master`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Commit** — write clear commit messages describing *what* and *why*:
   ```bash
   git commit -m "feat(fever): add favicons endpoint support"
   ```
4. **Test** — ensure all unit tests pass and integration tests are green:
   ```bash
   cargo test
   cargo clippy -- -D warnings
   ```
5. **Format** — ensure code is formatted:
   ```bash
   cargo fmt --check
   ```
6. **Open a PR** — against the `master` branch. Include:
   - Description of changes
   - Related issue number (if applicable)
   - Testing instructions
   - Any configuration changes needed

### PR Checklist

Before opening a PR, verify:

- [ ] `cargo test` passes
- [ ] `cargo clippy` is clean
- [ ] `cargo fmt --check` passes
- [ ] New code has unit tests
- [ ] API changes are reflected in integration tests
- [ ] Cache invalidation is correct for new mutations
- [ ] Logging follows the structured format (`log_info!`/`log_warn!`/`log_error!`)
- [ ] `wrangler dev` runs the worker without startup errors

---

## Questions?

If you have questions about contributing, feel free to open a [Discussion](https://github.com/jyfzh/current/discussions) or reach out via the project's issue tracker.
