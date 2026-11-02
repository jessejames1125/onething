/**
 * The proof behind the other walls: who can reach what, and the web pass.
 */
import { describe, expect, it } from "vitest";
import { api, BASE, env, fakeLLM, makeTestCtx, RUNNER } from "../helpers";
import { requestTask, isWebKind } from "../../src/core/agentTasks";
import { isDemoRequest } from "../../src/core/demo";
import { TOKEN_ROUTES } from "../../src/core/auth";

describe("proof: web and no-web passes never mix", () => {
  it("the web pass lists and claims only research; the no-web pass everything else", async () => {
    const ctx = await makeTestCtx();
    const web = await requestTask(ctx, "research_brief", { question: "tides" });
    const own = await requestTask(ctx, "morning_plan", { tasks: [] });
    const list = async (pass: string) => ((await (await api(`/api/agent/tasks?pass=${pass}`, { headers: RUNNER }, "none")).json()) as { items: Array<{ id: number }> }).items.map((t) => t.id);
    expect(await list("web")).toEqual([web]);
    expect(await list("noweb")).toEqual([own]);
    expect((await api(`/api/agent/tasks/${own}/claim?pass=web`, { method: "POST", headers: RUNNER }, "none")).status).toBe(409);
    expect((await api(`/api/agent/tasks/${web}/claim?pass=noweb`, { method: "POST", headers: RUNNER }, "none")).status).toBe(409);
    expect(isWebKind("capture_review")).toBe(false);
  });

  it("a call that names no pass gets nothing", async () => {
    const ctx = await makeTestCtx();
    const id = await requestTask(ctx, "morning_plan", { tasks: [] });
    expect((await api("/api/agent/tasks", { headers: RUNNER }, "none")).status).toBe(400);
    expect((await api(`/api/agent/tasks/${id}/claim`, { method: "POST", headers: RUNNER }, "none")).status).toBe(400);
  });

  it("held tasks are not listed under any status the runner may ask for", async () => {
    expect((await api("/api/agent/tasks?pass=noweb&status=held", { headers: RUNNER }, "none")).status).toBe(400);
    expect((await api("/api/agent/tasks?pass=noweb&status=all", { headers: RUNNER }, "none")).status).toBe(400);
  });
});

describe("proof: each token reaches only its own routes", () => {
  it("the API token reads Now and the list and adds a to-do, and nothing else", async () => {
    fakeLLM();
    expect([...TOKEN_ROUTES].sort()).toEqual(["GET /api/now", "GET /api/tasks", "POST /api/capture"]);
    expect((await api("/api/now", {}, "bearer")).status).toBe(200);
    expect((await api("/api/tasks", {}, "bearer")).status).toBe(200);
    for (const [method, path] of [
      ["GET", "/api/me"],
      ["GET", "/api/confirmations"],
      ["POST", "/api/confirmations/1/approve"],
      ["POST", "/api/planner/tasks/1/action"],
      ["GET", "/api/planner/tasks/1"],
      ["POST", "/api/jobs/core.agent.sweep/run"],
      ["POST", "/api/capture/reviews/1/undo"],
    ]) {
      expect((await api(path, { method }, "bearer")).status, `${method} ${path}`).toBe(403);
    }
  });

  it("the API token cannot approve what it cannot see, and cannot read the runner's queue", async () => {
    expect((await api("/api/agent/tasks?pass=noweb", {}, "bearer")).status).toBe(401);
  });

  it("the runner token opens only the runner's routes", async () => {
    expect((await api("/api/now", { headers: RUNNER }, "none")).status).toBe(401);
    expect((await api("/api/capture", { body: { text: "x" }, headers: RUNNER }, "none")).status).toBe(401);
    expect((await api("/api/confirmations/1/approve", { method: "POST", headers: RUNNER }, "none")).status).toBe(401);
  });

  it("no token at all opens nothing but the login and the health check", async () => {
    expect((await api("/api/now", {}, "none")).status).toBe(401);
    expect((await api("/api/agent/tasks?pass=noweb", {}, "none")).status).toBe(401);
    expect((await api("/api/health-check", {}, "none")).status).toBe(200);
  });

  it("text the MCP server adds is marked as a tool's, and a tool cannot make itself urgent", async () => {
    const ctx = await makeTestCtx();
    await api("/api/capture", { body: { text: "send it ASAP immediately", via: "mcp" } }, "bearer");
    const row = await ctx.db.one<{ urgent: number; source: string }>("SELECT t.urgent, c.source FROM tasks t JOIN captures c ON c.id = t.source_capture_id");
    expect(row).toEqual({ urgent: 0, source: "mcp" });
    const tasks = (await (await api("/api/tasks", {}, "bearer")).json()) as { items: Array<{ title: string }> };
    expect(tasks.items[0].title).toContain("UNTRUSTED_DATA");
  });
});

describe("proof: demo mode opens nothing on a deployed Worker", () => {
  it("counts only on a loopback host", () => {
    for (const url of ["http://127.0.0.1:8799/api/now", "http://localhost:8799/api/now", "http://[::1]:8799/api/now"]) expect(isDemoRequest({ DEMO: "1" }, url)).toBe(true);
    for (const url of [`${BASE}/api/now`, "https://onething.example.workers.dev/api/now", "http://127.0.0.1.attacker.example/api/now", "http://localhost.attacker.example/"]) expect(isDemoRequest({ DEMO: "1" }, url)).toBe(false);
    expect(isDemoRequest({}, "http://127.0.0.1:8799/api/now")).toBe(false);
  });

  it("a stray DEMO=1 on a real host gets a 401, not a session, and no demo door", async () => {
    expect((await api("/api/now", {}, "none", { DEMO: "1" })).status).toBe(401);
    expect((await api("/api/demo/email", { method: "POST" }, "session", { DEMO: "1" })).status).toBe(404);
  });

  it("the loopback demo really does skip sign-in, so the test above means something", async () => {
    expect((await api("/api/now", { url: "http://127.0.0.1:8799/api/now" }, "none", { DEMO: "1", DEMO_NOW: "2030-03-12T13:05:00Z" })).status).toBe(200);
    expect(env.DEMO).toBeUndefined();
  });
});
