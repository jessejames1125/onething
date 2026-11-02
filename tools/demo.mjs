#!/usr/bin/env node
// `npm run demo`: builds the app, resets a throwaway local database, loads the invented person, starts the real Worker on
// your machine and the canned runner. No account, no key, no network calls from the app.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, ".demo", "state");
const canBind = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
async function freePort(from) {
  for (let port = from; port < from + 50; port++) if (await canBind(port)) return String(port);
  throw new Error(`No free port from ${from}.`);
}
const PORT = process.env.ONETHING_DEMO_PORT ?? (await freePort(8799));
const URL_ = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: "error", CI: "1" };
const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const started = Date.now();

function step(label, args) {
  process.stdout.write(`${label}... `);
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
  if (r.status !== 0) {
    console.log("failed");
    console.error(`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000));
    process.exit(1);
  }
  console.log("ok");
}

if (!existsSync(wrangler)) {
  console.error("Run `npm install` first.");
  process.exit(1);
}

step("Building the app", [vite, "build", "--config", "web/vite.config.ts", "--logLevel", "error"]);
rmSync(state, { recursive: true, force: true });
const d1 = ["d1", "--config", "tools/demo.jsonc"];
step("Making the demo database", [wrangler, ...d1, "migrations", "apply", "DB", "--local", "--persist-to", state]);
step("Loading the invented person", [wrangler, ...d1, "execute", "DB", "--local", "--persist-to", state, "--file", "tools/seed.sql"]);

const server = spawn(process.execPath, [wrangler, "dev", "--config", "tools/demo.jsonc", "--local", "--persist-to", state, "--ip", "127.0.0.1", "--port", PORT, "--show-interactive-dev-session=false"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
const fake = spawn(process.execPath, [path.join(root, "tools", "runner", "fake.mjs")], { cwd: root, env: { ...env, ONETHING_URL: URL_, ONETHING_RUNNER_TOKEN: "demo-runner-token" }, stdio: "ignore" });

let errors = "";
server.stderr.on("data", (d) => (errors = (errors + d).slice(-2000)));

function stop(code = 0) {
  fake.kill();
  server.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
server.on("exit", (code) => {
  if (code) console.error(errors);
  fake.kill();
  process.exit(code ?? 0);
});

for (let i = 0; i < 120; i++) {
  const up = await fetch(`${URL_}/api/health-check`).then((r) => r.ok).catch(() => false);
  if (up) {
    console.log(`\nReady in ${Math.round((Date.now() - started) / 1000)} s: ${URL_}\nOpen it at phone width. Everything is invented, the clock is fixed and the model is canned. Ctrl+C stops it.\n`);
    break;
  }
  if (i === 119) {
    console.error("The app did not start.", errors);
    stop(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
