import { describe, expect, it } from "vitest";
import { api, env, fakeLLM, makeTestCtx, RUNNER } from "../helpers";
import { failTask, requestTask, sweepTasks, validateResult } from "../../src/core/agentTasks";
import { decide, expireConfirmations } from "../../src/core/confirmations";
import { dataBlock } from "../../src/core/untrusted";

const T0 = new Date("2030-03-12T10:35:00Z");

describe("queue, claim, result", () => {
  it("runs the whole path, and the second claim loses", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "morning_plan", { tasks: [] });
    const claim = await api(`/api/agent/tasks/${id}/claim?pass=noweb`, { method: "POST", headers: RUNNER }, "none");
    expect(claim.status).toBe(200);
    expect((await api(`/api/agent/tasks/${id}/claim?pass=noweb`, { method: "POST", headers: RUNNER }, "none")).status).toBe(409);
    const post = await api(`/api/agent/tasks/${id}/result`, { body: { result: { top3: [{ title: "Water the plants" }] } }, headers: RUNNER }, "none");
    expect(post.status).toBe(200);
    expect((await api(`/api/agent/tasks/${id}/result`, { body: { result: { top3: [{ title: "Again" }] } }, headers: RUNNER }, "none")).status).toBe(409);
  });

  it("refuses a result that does not match the kind's shape, and keeps the task", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "morning_plan", { tasks: [] });
    const post = await api(`/api/agent/tasks/${id}/result`, { body: { result: { note: "no top3" } }, headers: RUNNER }, "none");
    expect(post.status).toBe(422);
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", id))?.status).toBe("queued");
  });

  it("checks each kind's shape", () => {
    expect(() => validateResult("morning_plan", { top3: [] })).toThrow();
    expect(() => validateResult("research_brief", { summary: "x", sources: [] })).toThrow();
    expect(() => validateResult("capture_review", { actions: [{ do: "delete_everything", reason: "x" }] })).toThrow();
    expect(() => validateResult("capture_review", { actions: Array(41).fill({ do: "archive", reason: "x" }) })).toThrow();
    expect(validateResult("capture_review", { actions: [] })).toEqual({ actions: [] });
  });

  it("a failed try goes back to the queue while attempts and time remain", async () => {
    const ctx = await makeTestCtx({ now: T0 });
    const id = await requestTask(ctx, "morning_plan", { tasks: [] }, { dueAt: new Date(T0.getTime() + 3600_000) });
    await ctx.db.run("UPDATE agent_tasks SET attempts = 1 WHERE id = ?", id);
    const again = await failTask(ctx, id, "tool crashed");
    expect(again).toMatchObject({ ok: true, task: { status: "queued" } });
    await ctx.db.run("UPDATE agent_tasks SET attempts = 3 WHERE id = ?", id);
    const done = await failTask(ctx, id, "tool crashed");
    expect(done).toMatchObject({ ok: true, task: { status: "failed" } });
  });

  it("a review result after its deadline changes nothing", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "capture_review", { items: [] }, { dueAt: new Date(Date.now() - 1000) });
    const post = await api(`/api/agent/tasks/${id}/result`, { body: { result: { actions: [] } }, headers: RUNNER }, "none");
    expect(post.status).toBe(409);
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", id))?.status).toBe("failed");
  });
});

describe("held tasks", () => {
  const input = () => ({ email: dataBlock("hello", "email") });

  it("a bundle carrying a data block is held and asks for a tap", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "capture_review", input());
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", id))?.status).toBe("held");
    const conf = await ctx.db.one<{ kind: string; summary: string }>("SELECT kind, summary FROM confirmations");
    expect(conf?.kind).toBe("agent.release");
    expect(conf?.summary).toContain("hello");
  });

  it("'tapped' skips the hold, for the one request the owner just asked for", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "capture_review", input(), { tapped: true });
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", id))?.status).toBe("queued");
  });

  it("a tap cannot run twice", async () => {
    const ctx = await makeTestCtx();
    await requestTask(ctx, "capture_review", input());
    const conf = await ctx.db.one<{ id: number }>("SELECT id FROM confirmations");
    expect(await decide(ctx, conf!.id, true)).toMatchObject({ ok: true });
    expect(await decide(ctx, conf!.id, true)).toMatchObject({ ok: false, message: "Already approved." });
  });

  it("an expired confirmation cannot be approved, and the sweep closes the task and its to-do", async () => {
    const ctx = await makeTestCtx({ now: T0 });
    const now = T0.toISOString();
    const todo = await ctx.db.insert("tasks", { title: "Email: x", status: "held", created_at: now, updated_at: now });
    const id = await requestTask(ctx, "capture_review", input(), { releasePayload: { todoId: todo } });
    const week = await makeTestCtx({ now: new Date(T0.getTime() + 8 * 24 * 3600_000) });
    const conf = await ctx.db.one<{ id: number }>("SELECT id FROM confirmations");
    expect(await decide(week, conf!.id, true)).toMatchObject({ ok: false, message: "That one expired." });
    expect(await expireConfirmations(week)).toBe(0);
    await sweepTasks(week);
    expect((await ctx.db.one<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", id))?.status).toBe("failed");
    expect((await ctx.db.one<{ status: string; closed_as: string }>("SELECT status, closed_as FROM tasks WHERE id = ?", todo))).toEqual({ status: "archived", closed_as: "not_released" });
  });
});

describe("the fallback", () => {
  it("before the deadline: pending, and no model call", async () => {
    const llm = fakeLLM();
    const ctx = await makeTestCtx({ now: T0 });
    const id = await ctx.agent.request("morning_plan", { tasks: [] }, { dueAt: new Date(T0.getTime() + 3600_000) });
    expect(await ctx.agent.resolve(id)).toMatchObject({ status: "pending", result: null });
    expect(llm.calls).toEqual([]);
  });

  it("after it: a fallback that fails marks the task failed and alerts", async () => {
    const ctx = await makeTestCtx({ now: T0 });
    const id = await ctx.agent.request("morning_plan", { tasks: [] }, { dueAt: T0 });
    const r = await ctx.agent.resolve(id, { fallback: async () => { throw new Error("no model"); } });
    expect(r.status).toBe("failed");
    expect(await env.DB.prepare("SELECT id FROM alerts WHERE key = ?").bind(`agent.failed:${id}`).first()).not.toBeNull();
  });
});
