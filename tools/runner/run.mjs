#!/usr/bin/env node
// The real runner: one pass over the queue with the official `claude` tool on your own machine. Run it by hand, or schedule
// it yourself. If ANTHROPIC_API_KEY is set, it runs on your key. If not, `claude` uses however you signed in to it: read
// "Which Claude" in the README first.
//
// Locked down: each pass starts in an empty folder outside the repo, has no Read tool, and its only command is the helper,
// which talks to ONETHING_URL under /api/agent/ and nowhere else. Two passes: the no-web pass (your own data) has no web
// tools at all; the web pass gets web tools and only the research kind. The server enforces the split too.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (process.env.ONETHING_URL ?? "").replace(/\/+$/, "");
const token = process.env.ONETHING_RUNNER_TOKEN ?? "";

export function claudeArgs(pass, helper, usesKey) {
  const web = pass === "web";
  return [
    "-p",
    "--output-format",
    "text",
    "--restricted",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
    "--tools",
    web ? "Bash,WebSearch,WebFetch" : "Bash",
    "--allowedTools",
    web ? `Bash(node ${helper}:*),WebSearch,WebFetch` : `Bash(node ${helper}:*)`,
    "--max-turns",
    "60",
    ...(usesKey ? ["--bare"] : []),
  ];
}

function runClaude(args, env, cwd, input) {
  const opts = { cwd, env, input, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] };
  const first = spawnSync("claude", args, opts);
  if (!first.error || process.platform !== "win32") return first;
  // An npm-installed shim on Windows runs only through the shell.
  const quoted = args.map((a) => `"${a}"`);
  return spawnSync("claude.cmd", quoted, { ...opts, shell: true });
}

async function main() {
  if (!url || !token) {
    console.error("Set ONETHING_URL and ONETHING_RUNNER_TOKEN.");
    process.exit(2);
  }
  const standing = readFileSync(path.join(here, "RUNNER.md"), "utf8");
  let code = 0;
  for (const pass of ["noweb", "web"]) {
    const res = await fetch(`${url}/api/agent/tasks?pass=${pass}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.error(`[${pass}] the app answered ${res.status}`);
      code = 1;
      continue;
    }
    const { items } = await res.json();
    if (!items.length) {
      console.log(`[${pass}] nothing queued`);
      continue;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), "onething-runner-"));
    if (/\s/.test(root)) {
      console.error(`The temp folder path has a space in it (${root}), and the helper's allow rule needs a path without spaces. Set TMPDIR to one without.`);
      process.exit(2);
    }
    const bin = path.join(root, "bin");
    const work = path.join(root, "work");
    mkdirSync(bin);
    mkdirSync(work);
    copyFileSync(path.join(here, "api.mjs"), path.join(bin, "api.mjs"));
    const helper = path.join(bin, "api.mjs").replace(/\\/g, "/");
    const env = { ...process.env, ONETHING_URL: url, ONETHING_RUNNER_TOKEN: token, ONETHING_PASS: pass };
    const prompt = `${pass === "web" ? "Web pass: web tools are for research_brief tasks." : "No-web pass: you have no web tools."}\nThe helper command in this run is: node ${helper}\nUse it exactly, with no quotes around the path, nothing before it, and no pipes or redirects. It adds the token and the host itself.\n\n${standing}`;
    console.log(`[${pass}] ${items.length} queued`);
    const out = runClaude(claudeArgs(pass, helper, !!process.env.ANTHROPIC_API_KEY), env, work, prompt);
    rmSync(root, { recursive: true, force: true });
    if (out.error) {
      console.error(`Could not start claude: ${out.error.message}`);
      code = 1;
    } else if (out.status !== 0) {
      code = out.status ?? 1;
    }
  }
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
