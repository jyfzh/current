pub mod auth;
pub mod cache;
pub mod db;
pub mod fetcher;
pub mod fever;
pub mod log;
mod models;
pub mod var;

use std::sync::Once;
use worker::*;

/// Track whether the initial startup feed fetch has been triggered.
static STARTUP_FETCH_DONE: Once = Once::new();

#[event(fetch)]
async fn fetch(req: Request, env: Env, ctx: Context) -> Result<Response> {
    // Handle CORS preflight
    if req.method() == Method::Options {
        let mut resp = Response::empty()?;
        resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
        resp.headers_mut().set(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, DELETE, OPTIONS",
        )?;
        resp.headers_mut().set(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization",
        )?;
        resp.headers_mut().set("Access-Control-Max-Age", "86400")?;
        return Ok(resp);
    }

    // Trigger initial feed fetch on the very first HTTP request after deployment.
    // Uses wait_until so the response is returned immediately while fetching happens in background.
    // Controlled by CURRENT_STARTUP_FETCH var (default: true).
    if var::startup_fetch_enabled(&env) && !STARTUP_FETCH_DONE.is_completed() {
        STARTUP_FETCH_DONE.call_once(|| {});
        crate::log_info!("Startup: triggering initial feed fetch");
        let max_concurrency = var::max_concurrency(&env);
        let stale_seconds = var::feed_stale_seconds(&env);
        let env = env.clone();
        ctx.wait_until(async move {
            let d1 = match env.d1("DB") {
                Ok(d) => d,
                Err(e) => {
                    crate::log_error!("Startup: failed to get D1 binding: {:?}", e);
                    return;
                }
            };
            match fetcher::fetch_all_feeds(&d1, max_concurrency, stale_seconds).await {
                Ok(summary) => {
                    crate::log_info!(
                        "Startup: attempted={} succeeded={} failed={} updated={} new_items={} duration_ms={}",
                        summary.attempted,
                        summary.succeeded,
                        summary.failed,
                        summary.updated_feed_ids.len(),
                        summary.new_items,
                        summary.duration_ms
                    );
                    // Always invalidate feeds (last_fetched_on updated for all fetched feeds).
                    // Additionally invalidate search + total_items when new items were added.
                    if let Ok(kv) = env.kv("CACHE") {
                        cache::invalidate(&kv, cache::CacheEvent::FeedsChanged).await;
                        if !summary.updated_feed_ids.is_empty() {
                            cache::invalidate(
                                &kv,
                                cache::CacheEvent::ItemsAdded(summary.updated_feed_ids.clone()),
                            )
                            .await;
                        }
                    }
                }
                Err(e) => crate::log_error!("Startup: feed fetching error: {:?}", e),
            }
        });
    }

    let mut resp = fever::handle_request(req, &env).await?;
    add_response_cors_headers(&mut resp)?;
    Ok(resp)
}

/// Add CORS headers to an HTTP response.
/// Called on every Fever API response to allow cross-origin requests.
fn add_response_cors_headers(resp: &mut Response) -> Result<()> {
    resp.headers_mut().set("Access-Control-Allow-Origin", "*")?;
    resp.headers_mut()
        .set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    resp.headers_mut().set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
    )?;
    Ok(())
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    crate::log_info!("Cron: starting feed fetch");
    let d1 = match env.d1("DB") {
        Ok(d) => d,
        Err(e) => {
            crate::log_error!("Cron: failed to get D1 binding: {:?}", e);
            return;
        }
    };

    let max_concurrency = var::max_concurrency(&env);
    let stale_seconds = var::feed_stale_seconds(&env);
    let start = chrono::Utc::now();

    // Phase 1: Feed fetching
    match fetcher::fetch_all_feeds(&d1, max_concurrency, stale_seconds).await {
        Ok(summary) => {
            let elapsed = (chrono::Utc::now() - start).num_seconds() as u64;
            crate::log_info!(
                "Cron: attempted={} succeeded={} failed={} updated={} new_items={} duration_ms={} elapsed_s={}",
                summary.attempted,
                summary.succeeded,
                summary.failed,
                summary.updated_feed_ids.len(),
                summary.new_items,
                summary.duration_ms,
                elapsed
            );
            // Always invalidate feeds (last_fetched_on updated for all fetched feeds).
            // Additionally invalidate search + total_items when new items were added.
            if let Ok(kv) = env.kv("CACHE") {
                cache::invalidate(&kv, cache::CacheEvent::FeedsChanged).await;
                if !summary.updated_feed_ids.is_empty() {
                    cache::invalidate(
                        &kv,
                        cache::CacheEvent::ItemsAdded(summary.updated_feed_ids.clone()),
                    )
                    .await;
                }
            }
        }
        Err(e) => crate::log_error!("Cron: feed fetching error: {:?}", e),
    }
}
