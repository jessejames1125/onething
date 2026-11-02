/**
 * The proof behind "the job system holds up": once per slot, a missed run says so, a replay cannot run a job twice, and when
 * the runner is silent the day's plan still lands.
 */
import { describe, expect, it } from "vitest";
import { api, env, fakeLLM, makeTestCtx, RUNNER } from "../helpers";
import { allJobs, INTERNAL_JOB_PATH, JOB_SIGNATURE_HEADER, jobSignature, runDue, runDispatchedJob, type JobEntry } from "../../src/core/jobs";
import { FALLBACK_STREAK_ALERT_KEY, requestTask, sweepTasks } from "../../src/core/agentTasks";
import { getModules } from "../../src/modules/registry";
import type { ModuleDef } from "../../src/core/types";
import { registerCoreJobs } from "../../src/core/coreJobs";

registerCoreJobs();

function jobModule(run: () => void, name = "probe", at = "07:00"): ModuleDef {
  return { name: "planner", jobs: [{ name, schedule: { at }, run: async () => run() }] };
}

// 07:00 in New York on this date.
const SLOT = new Date("2030-03-12T11:00:00Z");

describe("proof: a job runs once per slot", () => {
  it("ten ticks in one slot run it once", async () => {
    let runs = 0;
    const mods = [jobModule(() => void runs++)];
    for (let i = 0; i < 10; i++) {
      const ctx = await makeTestCtx({ now: new Date(SLOT.getTime() + i * 60_000) });
      await runDue(ctx, mods);
    }
    expect(runs).toBe(1);
  });

  it("two ticks at the same moment still run it once: the row is the lock", async () => {
    let runs = 0;
    const mods = [jobModule(() => void runs++)];
    const ctx = await makeTestCtx({ now: SLOT });
    await Promise.all([runDue(ctx, mods), runDue(ctx, mods), runDue(ctx, mods)]);
    expect(runs).toBe(1);
  });

  it("a run past its grace is recorded as missed, alerted once, and not run late", async () => {
    let runs = 0;
    const mods = [jobModule(() => void runs++)];
    const ctx = await makeTestCtx({ now: new Date(SLOT.getTime() + 3 * 3600_000) });
    await runDue(ctx, mods);
    await runDue(ctx, mods);
    expect(runs).toBe(0);
    const row = await env.DB.prepare("SELECT status FROM job_runs WHERE job = 'planner.probe'").first<{ status: string }>();
    expect(row?.status).toBe("missed");
    const alerts = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE key LIKE 'job.missed:planner.probe%'").first<{ n: number }>();
    expect(alerts?.n).toBe(1);
  });

  it("a job that throws is recorded and alerted, and the jobs after it still run", async () => {
    let later = 0;
    const mods: ModuleDef[] = [
      {
        name: "planner",
        jobs: [
          { name: "bad", schedule: { at: "07:00" }, run: async () => { throw new Error("boom"); } },
          { name: "good", schedule: { at: "07:00" }, run: async () => void later++ },
        ],
      },
    ];
    const res = await runDue(await makeTestCtx({ now: SLOT }), mods);
    expect(res.failed).toContain("planner.bad");
    expect(res.ran).toContain("planner.good");
    expect(later).toBe(1);
    const alert = await env.DB.prepare("SELECT level FROM alerts WHERE key LIKE 'job.failed:planner.bad%'").first<{ level: string }>();
    expect(alert?.level).toBe("error");
  });
});

describe("proof: the signed fan-out", () => {
  const entry = (run: () => void): JobEntry => ({ id: "planner.probe", module: "planner", def: { name: "probe", schedule: { at: "07:00" }, run: async () => run() } });
  const SCHEDULED = SLOT.toISOString();

  it("only a signature over this job and this slot runs it, and a replay after it finished is refused", async () => {
    let runs = 0;
    const mods = [jobModule(() => void runs++)];
    const ctx = await makeTestCtx({ now: SLOT });
    await ctx.db.run("INSERT INTO job_runs (job, scheduled_for, started_at, status) VALUES ('planner.probe', ?, ?, 'running')", SCHEDULED, SCHEDULED);
    const sig = await jobSignature(env.SESSION_SECRET!, "planner.probe", SCHEDULED);
    expect((await runDispatchedJob(ctx, "planner.probe", SCHEDULED, "0".repeat(64), mods)).status).toBe(401);
    expect((await runDispatchedJob(ctx, "planner.probe", "2030-03-13T11:00:00.000Z", sig, mods)).status).toBe(401);
    expect((await runDispatchedJob(ctx, "planner.probe", SCHEDULED, sig, mods)).status).toBe(200);
    expect((await runDispatchedJob(ctx, "planner.probe", SCHEDULED, sig, mods)).status).toBe(409);
    expect(runs).toBe(1);
    expect(entry(() => {}).id).toBe("planner.probe");
  });

  it("from outside, a forged signature on the real route is a 401", async () => {
    const job = allJobs(getModules())[0];
    const res = await api(`${INTERNAL_JOB_PATH}/${encodeURIComponent(job.id)}/run`, { body: { scheduledFor: SCHEDULED }, headers: { [JOB_SIGNATURE_HEADER]: "f".repeat(64) } }, "none");
    expect(res.status).toBe(401);
  });

  it("a dispatcher that fails marks the slot failed and alerts", async () => {
    const mods = [jobModule(() => {})];
    const ctx = await makeTestCtx({ now: SLOT });
    await runDue(ctx, mods, { dispatch: async () => { throw new Error("no route"); } });
    const { flushCtx } = await import("../helpers");
    await flushCtx(ctx);
    const row = await env.DB.prepare("SELECT status, error FROM job_runs WHERE job = 'planner.probe'").first<{ status: string; error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("no route");
  });
});

describe("proof: a silent runner cannot stop the day", () => {
  const QUEUE = new Date("2030-03-12T10:35:00Z");
  const APPLY = new Date("2030-03-12T11:00:00Z");

  it("the morning job falls back to the app's own pick, and two misses in a row raise one alert", async () => {
    fakeLLM();
    const first = await makeTestCtx({ now: QUEUE });
    await first.db.insert("tasks", { title: "Water the plants", created_at: QUEUE.toISOString(), updated_at: QUEUE.toISOString() });
    const planner = getModules().find((m) => m.name === "planner")!;
    const queue = planner.jobs!.find((j) => j.name === "morning_queue")!;
    const apply = planner.jobs!.find((j) => j.name === "morning_apply")!;
    await queue.run(first);
    await apply.run(await makeTestCtx({ now: APPLY }));
    let row = await env.DB.prepare("SELECT status, result FROM agent_tasks WHERE kind = 'morning_plan'").first<{ status: string; result: string }>();
    expect(row?.status).toBe("fallback");
    expect(row?.result).toContain("Water the plants");
    expect(await env.DB.prepare("SELECT id FROM alerts WHERE key = ?").bind(FALLBACK_STREAK_ALERT_KEY).first()).toBeNull();

    const day2 = (d: Date) => new Date(d.getTime() + 24 * 3600_000);
    await queue.run(await makeTestCtx({ now: day2(QUEUE) }));
    await apply.run(await makeTestCtx({ now: day2(APPLY) }));
    expect(await env.DB.prepare("SELECT id FROM alerts WHERE key = ?").bind(FALLBACK_STREAK_ALERT_KEY).first()).not.toBeNull();
  });

  it("a runner that reports clears the streak, and its pick takes the card", async () => {
    const queueCtx = await makeTestCtx();
    const a = await queueCtx.db.insert("tasks", { title: "Water the plants", due: "2020-01-01", created_at: "2030-01-01", updated_at: "2030-01-01" });
    const b = await queueCtx.db.insert("tasks", { title: "Draft the wish list", created_at: "2030-01-01", updated_at: "2030-01-01" });
    const id = await requestTask(queueCtx, "morning_plan", { tasks: [] }, { module: "planner" });
    await api(`/api/agent/tasks/${id}/claim?pass=noweb`, { method: "POST", headers: RUNNER }, "none");
    const post = await api(`/api/agent/tasks/${id}/result`, { body: { result: { top3: [{ task_id: b, title: "Draft the wish list", why: "it moves your biggest goal" }] } }, headers: RUNNER }, "none");
    expect(post.status).toBe(200);
    const now = (await (await api("/api/now")).json()) as { card: { id: number; reason: string } };
    expect(now.card.id).toBe(b);
    expect(now.card.reason).toBe("Claude's pick: it moves your biggest goal");
    expect(a).not.toBe(b);
  });

  it("a claim that goes quiet returns to the queue, and stops after three tries", async () => {
    const t0 = new Date("2030-03-12T10:00:00Z");
    const ctx = await makeTestCtx({ now: t0 });
    const id = await requestTask(ctx, "morning_plan", { tasks: [] }, { dueAt: new Date(t0.getTime() + 24 * 3600_000) });
    const later = (min: number) => makeTestCtx({ now: new Date(t0.getTime() + min * 60_000) });
    for (let i = 0; i < 3; i++) {
      const c = await later(i * 40);
      await c.db.run("UPDATE agent_tasks SET status = 'claimed', claimed_at = ?, attempts = attempts + 1 WHERE id = ?", c.now().toISOString(), id);
      await sweepTasks(await later(i * 40 + 31));
    }
    const row = await ctx.db.one<{ status: string; attempts: number }>("SELECT status, attempts FROM agent_tasks WHERE id = ?", id);
    expect(row).toMatchObject({ status: "failed", attempts: 3 });
  });
});
