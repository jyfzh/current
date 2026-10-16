// Structured logging helpers for production observability.
//
// Each level adds a `[LEVEL]` prefix for easy grepping in Cloudflare
// dashboard logs.

/** Informational log — normal operational events (feed fetched, startup, cache hit). */
export function logInfo(message) {
  console.log(`[INFO] ${message}`);
}

/** Warning log — unexpected but handled conditions (cache errors, parse errors). */
export function logWarn(message) {
  console.warn(`[WARN] ${message}`);
}

/** Error log — failures that may need investigation (binding errors, fetch errors, etc.). */
export function logError(message) {
  console.error(`[ERROR] ${message}`);
}

/** Formats an unknown thrown value like Rust's `{:?}` for error logs. */
export function formatError(err) {
  if (err instanceof Error) {
    return err.stack ? err.stack : `${err.name}: ${err.message}`;
  }
  return String(err);
}
