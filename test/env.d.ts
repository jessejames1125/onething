import type { Env as AppEnvBindings } from "../src/core/types";

declare global {
  namespace Cloudflare {
    // What `import { env } from "cloudflare:test"` is typed as.
    interface Env extends AppEnvBindings {}
  }
}

export {};
