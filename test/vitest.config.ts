import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import path from "node:path";

// The tests run inside the real Workers runtime against a real local D1. Every secret here is a throwaway test value.
export default defineConfig(async () => {
  const root = path.join(import.meta.dirname, "..");
  const migrations = await readD1Migrations(path.join(root, "src", "db"));
  return {
    root,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(root, "test", "wrangler.jsonc") },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TIMEZONE: "America/New_York",
            USER_NAME: "Robin",
            API_TOKEN: "test-api-token",
            APP_PASSPHRASE: "open sesame",
            SESSION_SECRET: "test-session-secret-0123456789",
            RUNNER_TOKEN: "test-runner-token",
          },
        },
      }),
    ],
    test: {
      include: ["test/{core,capture,planner,proof}/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
