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
				id: "2c6c6a77-87fb-43df-8bff-672b5e8ec847",
			}),
			CACHE: bindings.kv({
				id: "06bd7e4e2c4a4fc392a2c7efa63d11fe",
			}),
		},
	},
});
