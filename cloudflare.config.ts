import { bindings, defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "current",
		compatibilityDate: "2026-05-11",
		entrypoint: "src/index.js",
		triggers: [
			triggers.scheduled({
				schedule: "0 */1 * * *",
			}),
		],
		env: {
			CURRENT_MAX_CONCURRENCY: bindings.text("5"),
			CURRENT_FEED_STALE_SECONDS: bindings.text("3600"),
			CURRENT_STARTUP_FETCH: bindings.text("true"),
			CURRENT_CACHE_TTL_AGGREGATE: bindings.text("600"),
			CURRENT_CACHE_TTL_STRUCTURAL: bindings.text("600"),
			CURRENT_FEVER_ITEMS_PER_PAGE: bindings.text("50"),
			CURRENT_FEVER_PASSWORD: bindings.secret(),
			CURRENT_FEVER_EMAIL: bindings.secret(),
			DB: bindings.d1({
				id: "your-database-id-here",
			}),
			CACHE: bindings.kv({
				id: "your-kv-id-here",
			}),
		},
	},
});
