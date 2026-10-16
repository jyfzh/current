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
| [Node.js](https://nodejs.org/) | 22.18+ | Runtime for unit tests and the cf CLI |
| [cf](https://developers.cloudflare.com/cf/) | Latest (installed by `npm install`) | Dev server, build, and deploy |
| [Vite](https://vite.dev/) | 8+ (installed by `npm install`) | Bundler and dev server used by cf through the Cloudflare Vite plugin |

There is no user-authored build step and no runtime dependency: the worker is
plain ES modules (`cloudflare.config.ts` → `src/index.js`), bundled by Vite when
you run `cf build` or `cf deploy`.

Install project dependencies:

```bash
npm install
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

Edit `cloudflare.config.ts` and make sure the `DB` (D1) and `CACHE` (KV) bindings exist.
The IDs are only needed for remote deployment; for local development, `cf dev`
auto-simulates them via Miniflare.

### 4. Bootstrap the local database

This creates the tables in the local D1 simulation
(`.cloudflare/state/v3`), keyed by the database ID in `cloudflare.config.ts`:

```bash
npm run db:local
```

### 5. Seed test data (optional)

```bash
npm run db:local -- --seed
```

### Run the worker locally

```bash
npm run dev
```

This starts a local server at `http://localhost:8787`. The worker automatically fetches feeds on the first request if `CURRENT_STARTUP_FETCH` is enabled (default: true). For development, you may want to disable it in `.dev.vars`:

```env
CURRENT_STARTUP_FETCH=false
```

The port is set in `vite.config.ts` (`server.port`, default `8787`) because
`cf dev` does not accept a `--port` flag in Vite projects. Export `CF_PORT` to
override it, for example `CF_PORT=8789 npm run dev`.

### Iterative development flow

1. Edit JavaScript in `src/`
2. Run `npm test` for unit tests
3. Run `npm run dev` to test against real HTTP requests
4. Deploy with `npm run deploy`

---

## Testing

### Unit tests

Unit tests run on Node's built-in test runner (no dependencies):

```bash
npm test
```

Current test coverage includes:
- **`md5.js` / `auth.js`** — known MD5 vectors, unicode input, `secureEq` constant-time comparison, authentication logic
- **`feedparser.js` / `xml.js`** — RSS 2.0, Atom, RSS 1.0 and JSON Feed mapping, entity/CDATA handling, author extraction fallback chain, content extraction priority
- **`models.js`** — FeverResponse serialization (exact field order and omission)
- **`fetcher.js`** — concurrency window calculation, summary semantics
- **`var.js` / `cache.js`** — configuration parsing, cache hit/miss and selective invalidation

### Integration tests

The integration runner starts `cf dev`, prepares and seeds local D1 with
`tests/local-db-setup.sh`, and runs the Fever API suite (plus the unit tests)
against the local worker:

```bash
bash tests/setup-integration.sh
```

To run just the API suite against an already-running instance:

```bash
FEVER_BASE_URL="http://localhost:8787" \
CURRENT_FEVER_PASSWORD=dev-test-key \
CURRENT_FEVER_EMAIL=admin \
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
npx cf d1 create --name current-db
```

Copy the returned database ID into `cloudflare.config.ts` → `DB` → `id`.

### 2. Create remote KV namespace

```bash
npx cf kv namespaces create --title current-cache
```

Copy the returned namespace ID into `cloudflare.config.ts` → `CACHE` → `id`.

### 3. Initialize the database schema

```bash
npx cf d1 migrations apply <DATABASE_ID> --dir migrations
```

### 4. Set secrets

`CURRENT_FEVER_PASSWORD` and `CURRENT_FEVER_EMAIL` are declared as required
secrets in `cloudflare.config.ts`. Create a gitignored `.secrets` file and pass
it to the deploy command:

```bash
cat > .secrets <<'EOF'
CURRENT_FEVER_PASSWORD=<your-password>
CURRENT_FEVER_EMAIL=<your-email>
EOF
```

### 5. Deploy

```bash
npx cf auth login
npm run deploy -- --secrets-file .secrets
```

---

## Code Conventions

### General

- **ES modules** — `"type": "module"`; use `import`/`export` with explicit `.js` extensions
- **No runtime dependencies** — keep the worker self-contained; only dev tooling may be added
- **No transpilation** — files must run as-is in the Workers runtime (`workerd`)
- **Strict equality** — prefer `===` / `!==`; avoid implicit coercion
- **Early returns** — keep functions flat and readable
- **Error handling** — throw for unexpected failures, catch only where the original implementation handled the error (parse errors, cache failures, batch writes)

### Module patterns

- **Database queries** (`db.js`) — each function takes the D1 binding (`d1`) as its first argument and returns plain rows. Queries and bindings match the SQL documented in `migrations/`.
- **Cache layer** (`cache.js`) — use `cacheOrCompute()` for read paths. Every mutation must call `invalidate()` with the appropriate `CacheEvent`.
- **Handler functions** (`fever.js`) — one sub-handler per API endpoint, named `handle<Endpoint>`. All take `env`, `d1`, `kv`.
- **Feed parsing** (`feedparser.js` / `xml.js`) — mirrors the subset of `feed-rs` behavior the worker relies on; keep the mapping tables and fallback order in sync when extending format support.
- **Configuration** (`var.js`) — one function per config key, with doc comments showing the env var name, default value, and behavior.

### Naming

- `camelCase` for functions and variables
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for module-level constants
- Env var prefix: `CURRENT_` for all Current-specific variables
- Cache keys: prefix `cache:` (e.g., `cache:feeds`, `cache:unread_ids`)

### Imports

Order imports in groups separated by blank lines:

```js
// 1. Internal modules
import * as db from "./db.js";
import { logWarn } from "./log.js";

// 2. (No external runtime dependencies)
```

---

## Logging & Observability

Use the structured logging helpers from `log.js`:

| Helper | Prefix | When to use |
|--------|--------|-------------|
| `logInfo()` | `[INFO]` | Normal operational events (feed fetched, startup, cache stats) |
| `logWarn()` | `[WARN]` | Handled errors (parse errors, cache write failures, invalid URL) |
| `logError()` | `[ERROR]` | Failures needing investigation (binding errors, fetch failures) |

All logs appear in the Cloudflare Dashboard under Workers & Pages > your worker > Logs.

### Performance logging

For latency-sensitive handlers, log timing information:

```js
const started = Date.now();
// ... handler logic ...
logInfo(
  `perf route=fever.items total_items=${totalItems} duration_ms=${Math.max(0, Date.now() - started)}`,
);
```

---

## Cache Strategy

Current uses a **cache-aside** pattern with KV:

- **Read path**: check KV → miss → query D1 → backfill KV with TTL
- **Write path**: mutate D1 → invalidate affected KV keys

When adding new cached data:

```js
export async function getMyDataCached(d1, kv, env) {
  return cacheOrCompute(kv, "cache:my_key", varModule.cacheTtlStructural(env), () =>
    db.getMyData(d1),
  );
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
   npm test
   bash tests/setup-integration.sh
   ```
5. **Open a PR** — against the `master` branch. Include:
   - Description of changes
   - Related issue number (if applicable)
   - Testing instructions
   - Any configuration changes needed

### PR Checklist

Before opening a PR, verify:

- [ ] `npm test` passes
- [ ] `bash tests/setup-integration.sh` passes
- [ ] New code has unit tests
- [ ] API changes are reflected in integration tests
- [ ] Cache invalidation is correct for new mutations
- [ ] Logging follows the structured format (`logInfo`/`logWarn`/`logError`)
- [ ] `npm run dev` runs the worker without startup errors

---

## Questions?

If you have questions about contributing, feel free to open a [Discussion](https://github.com/jyfzh/current/discussions) or reach out via the project's issue tracker.
