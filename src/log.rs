//! Structured logging helpers for production observability.
//!
//! Usage: replace `console_log!(...)` with `log_info!(...)`, `log_warn!(...)`,
//! or `log_error!(...)` depending on severity. Each level adds a `[LEVEL]` prefix
//! for easy grepping in Cloudflare dashboard logs.

/// Informational log — normal operational events (feed fetched, startup, cache hit).
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)+) => {
        console_log!("[INFO] {}", format_args!($($arg)+))
    };
}

/// Warning log — unexpected but handled conditions (cache errors, parse errors).
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)+) => {
        console_log!("[WARN] {}", format_args!($($arg)+))
    };
}

/// Error log — failures that may need investigation (binding errors, fetch errors, etc.).
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)+) => {
        console_log!("[ERROR] {}", format_args!($($arg)+))
    };
}
