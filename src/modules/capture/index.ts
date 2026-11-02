/**
 * The capture module owns notes and questions, and the results of the runner's capture reviews. A question is a to-do
 * plus a research task for the runner's web pass; the answer lands in the to-do's notes.
 */
import type { AgentTask, Ctx, FiledCapture, CaptureResult, ModuleDef } from "../../core/types";
import { listReviews, onReviewResult, undoReview } from "../../core/captureReview";
import { addTask } from "../planner/tasks";
import { todoTitle } from "../../core/captureRules";
import { arr, optStr } from "../../core/validate";

const RESEARCH_WINDOW_MS = 24 * 3600_000;

async function onCapture(ctx: Ctx, filed: FiledCapture): Promise<CaptureResult> {
  if (filed.kind === "note") return { refTable: null, refId: null, receipt: "Kept as a note." };
  const added = await addTask(ctx, { text: filed.text, title: todoTitle(filed.text), captureId: filed.capture.id, source: filed.capture.source, fields: filed.fields });
  if (added.duplicateOf) return { refTable: "tasks", refId: added.duplicateOf.id, receipt: `That's already on your list: ${added.duplicateOf.title}`, duplicateOf: added.duplicateOf };
  if (ctx.env.RUNNER_TOKEN) {
    await ctx.agent.request("research_brief", { question: filed.text, task_id: added.id }, { module: "capture", dueAt: new Date(ctx.now().getTime() + RESEARCH_WINDOW_MS) });
  }
  return { refTable: "tasks", refId: added.id, receipt: ctx.env.RUNNER_TOKEN ? `On your list, and Claude will look it up: ${added.title}` : `On your list: ${added.title}` };
}

/** Sources must be plain https links, so nothing a web page says can become a script or a local path on the screen. */
export function httpsOnly(sources: unknown[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const raw = typeof s === "string" ? s : typeof s === "object" && s ? String((s as Record<string, unknown>).url ?? "") : "";
    try {
      const u = new URL(raw);
      if (u.protocol === "https:") out.push(u.toString());
    } catch {
      /* not a link: left out */
    }
  }
  return out;
}

async function onResearch(ctx: Ctx, task: AgentTask): Promise<void> {
  const id = Number(task.input.task_id);
  const row = await ctx.db.one<{ notes: string | null }>("SELECT notes FROM tasks WHERE id = ?", id);
  if (!row) return;
  const result = task.result ?? {};
  const sources = httpsOnly(arr(result.sources, "sources"));
  const answer = [optStr(result.summary)?.slice(0, 2000), ...sources].filter(Boolean).join("\n");
  const notes = [row.notes, `Claude looked this up:\n${answer}`].filter(Boolean).join("\n\n");
  await ctx.db.update("tasks", id, { notes, updated_at: ctx.now().toISOString() });
}

const capture: ModuleDef = {
  name: "capture",
  captureKinds: ["note", "question"],
  onCapture,
  agentHandlers: {
    research_brief: onResearch,
    capture_review: (ctx, task) => onReviewResult(ctx, task.id, task.result ?? {}),
  },
  routes(app) {
    app.get("/reviews", async (c) => c.json({ items: await listReviews(c.get("ctx")) }));
    app.post("/reviews/:id/undo", async (c) => c.json(await undoReview(c.get("ctx"), Number(c.req.param("id")))));
  },
};

export default capture;
