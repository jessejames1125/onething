#!/usr/bin/env node
// The runner's only way to reach the app, with ONETHING_URL and ONETHING_RUNNER_TOKEN from the environment.
//   node api.mjs list | claim <id> | result <id> '<json>' | fail <id> "<why>" | instructions

const base = (process.env.ONETHING_URL ?? "").replace(/\/+$/, "");
const token = process.env.ONETHING_RUNNER_TOKEN ?? "";
const pass = process.env.ONETHING_PASS ?? "noweb";

if (!base || !token) {
  console.error("Set ONETHING_URL and ONETHING_RUNNER_TOKEN.");
  process.exit(2);
}

async function call(method, path, body) {
  const res = await fetch(`${base}/api/agent${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status}: ${text.slice(0, 500)}`);
    process.exit(1);
  }
  return text;
}

const [cmd, id, arg] = process.argv.slice(2);
// run.mjs sets ONETHING_TASK: this session can touch that one task and no other, and cannot list the queue.
const locked = process.env.ONETHING_TASK ?? "";
const needId = () => {
  if (!/^\d+$/.test(id ?? "")) {
    console.error("A task id is required.");
    process.exit(2);
  }
  if (locked && id !== locked) {
    console.error(`This run can touch task ${locked} only.`);
    process.exit(2);
  }
};

if (cmd === "instructions") {
  console.log(await call("GET", "/instructions"));
} else if (cmd === "list") {
  if (locked) {
    console.error(`This run has one task: ${locked}.`);
    process.exit(2);
  }
  console.log(await call("GET", `/tasks?pass=${pass}`));
} else if (cmd === "claim") {
  needId();
  console.log(await call("POST", `/tasks/${id}/claim?pass=${pass}`));
} else if (cmd === "result") {
  needId();
  console.log(await call("POST", `/tasks/${id}/result`, { result: JSON.parse(String(arg ?? "")) }));
} else if (cmd === "fail") {
  needId();
  console.log(await call("POST", `/tasks/${id}/fail`, { error: String(arg ?? "unknown").slice(0, 1000) }));
} else {
  console.error("Usage: node api.mjs list | claim <id> | result <id> '<json>' | fail <id> <why> | instructions");
  process.exit(2);
}
