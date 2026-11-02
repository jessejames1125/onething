import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * The demo, driven in a real phone-sized browser against the real local Worker that `npm run demo` starts.
 *   npx playwright install chromium && npm run e2e
 * RECORD=1 slows it to reading speed and writes docs/images/. Nothing here needs an account or a key.
 */
const root = path.resolve(import.meta.dirname, "..", "..");
const PORT = process.env.ONETHING_DEMO_PORT ?? "8841";

export default defineConfig({
  testDir: ".",
  outputDir: path.join(root, "test-results"),
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["iPhone 14"],
    defaultBrowserType: "chromium",
    browserName: "chromium",
    colorScheme: "light",
    video: process.env.RECORD ? { mode: "on", size: { width: 390, height: 844 } } : "off",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tools/demo.mjs",
    cwd: root,
    env: { ONETHING_DEMO_PORT: PORT },
    url: `http://127.0.0.1:${PORT}/api/health-check`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
