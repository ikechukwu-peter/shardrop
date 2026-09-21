import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    // The relay is proxied under the app's own origin, so the client needs no
    // second port in development. Deployments set VITE_SIGNAL_URL instead.
    proxy: {
      "/signal": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        rewriteWsOrigin: true,
      },
      // Short-lived TURN credentials, minted by the relay.
      "/turn": { target: "http://127.0.0.1:8787" },
    },
  },
  test: {
    environment: "happy-dom",
    // e2e/*.spec.ts belongs to Playwright, which has its own runner.
    include: ["src/**/*.test.ts"],
  },
});
