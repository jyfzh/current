import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The cf CLI uses the Cloudflare Vite plugin as its bundler and reads
// cloudflare.config.ts for the Worker bindings. `cf dev` does not accept a
// --port flag in a Vite project, so the dev server port is configured here.
// The integration test runner overrides it with CF_PORT.
export default defineConfig({
	plugins: [cloudflare()],
	server: {
		port: Number(process.env.CF_PORT ?? 8787),
		// Vite's dev-server CORS middleware answers OPTIONS requests before they
		// reach the Worker; the Worker handles CORS itself.
		cors: false,
	},
});
