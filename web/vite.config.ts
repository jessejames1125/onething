import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Built output lands in web/dist, which wrangler.jsonc serves as static assets.
export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
