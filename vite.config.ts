import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vitest/config";

/**
 * crypto.subtle only exists in a secure context, so a phone opening
 * http://192.168.x.x would have no hashing and no sealed signaling at all.
 * VITE_HTTPS=1 serves the dev app over TLS (self-signed) for that case.
 *
 * The signaling relay is proxied under the same origin at /signal, so a phone
 * trusts one certificate instead of two, and no second port is exposed.
 */
export default defineConfig({
  plugins: process.env["VITE_HTTPS"] ? [basicSsl()] : [],
  server: {
    host: true, // also listen on the LAN address, not just localhost
    allowedHosts: true, // tunnels (ngrok, cloudflared) present their own hostname
    proxy: {
      "/signal": {
        target: "ws://127.0.0.1:8787",
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  test: {
    environment: "happy-dom",
    // e2e/*.spec.ts belongs to Playwright, which has its own runner.
    include: ["src/**/*.test.ts"],
  },
});
