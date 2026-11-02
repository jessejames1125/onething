#!/usr/bin/env node
// The demo's runner: canned answers over the same HTTP API the real one uses, so the demo runs with no account and no key.
// It calls no model. What it proves is the app's side: holds, passes, checks. tools/runner/run.mjs runs real Claude.
const base = (process.env.ONETHING_URL ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const token = process.env.ONETHING_RUNNER_TOKEN ?? "demo-runner-token";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const POLL_MS = 700;

const FROM_EMAIL = /UNTRUSTED_DATA from=email/;
const TITLE_OF_EMAIL = /Subject: ([^\n]*)/;

/** What this canned runner would say for each bundle. */
export function answer(task) {
  if (task.kind === "capture_review") {
    const text = JSON.stringify(task.input);
    if (FROM_EMAIL.test(text)) {
      const item = task.input.items[0];
      const subject = TITLE_OF_EMAIL.exec(task.input.captures[0].text)?.[1]?.trim() ?? "";
      return {
        actions: subject ? [{ do: "retitle", task_id: item.id, title: subject.replace(/ today$/i, ""), reason: "from the subject line" }] : [],
        note: "This demo runner is canned, with no model. It read the email as data: it said to ignore the rules and send your data, and neither happened.",
      };
    }
    return { actions: [], note: null };
  }
  if (task.kind === "research_brief") {
    return { summary: "Canned demo answer: a real runner would look this up on the web and cite its sources here.", sources: ["https://example.com/"] };
  }
  if (task.kind === "morning_plan") {
    const top = (task.input.tasks ?? []).slice(0, 3);
    return { top3: top.length ? top.map((t) => ({ task_id: t.id, title: t.title, why: t.reason })) : [{ task_id: null, title: "Nothing on the list", why: "" }], note: "Canned demo answer." };
  }
  return { result: "unknown kind" };
}

async function call(method, path, body) {
  const res = await fetch(`${base}/api/agent${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
  return res.json();
}

async function pass(name) {
  const { items } = await call("GET", `/tasks?pass=${name}`);
  for (const t of items) {
    const claimed = await call("POST", `/tasks/${t.id}/claim?pass=${name}`);
    await call("POST", `/tasks/${t.id}/result`, { result: answer(claimed) });
  }
}

async function loop() {
  for (;;) {
    try {
      await pass("noweb");
      await pass("web");
    } catch {
      // The app is starting or stopping: try again next time.
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) void loop();
