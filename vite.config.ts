import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    // e2e/*.spec.ts belongs to Playwright, which has its own runner.
    include: ["src/**/*.test.ts"],
  },
});
