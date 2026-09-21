import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests drive two real browser tabs through manual signaling and a
 * transfer. They are the only way to exercise RTCPeerConnection: happy-dom has
 * no WebRTC, so the unit tests use a fake wire instead.
 */
export default defineConfig({
  testDir: "e2e",
  // ICE gathering plus a full transfer needs more than the 30s default.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    // Its own port, so an unrelated dev server on 5173 cannot be mistaken
    // for this app.
    baseURL: "http://localhost:5174",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev -- --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
