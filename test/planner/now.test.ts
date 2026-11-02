import { describe, expect, it } from "vitest";
import { addTask, api, makeTestCtx } from "../helpers";
import { nowView, itemAction, itemDetail, todoList, titleForTool } from "../../src/modules/planner/now";
import { deadlinePressure, inferEnergy, inferShallow, pickTop, rankTasks, type RankedTask, type TaskRow } from "../../src/modules/planner/rank";
import { capUrgent, dueWithin2, saysUrgent, urgentReal } from "../../src/modules/planner/triage";
import { hasWaitLoop } from "../../src/modules/planner/waits";

const NOW = new Date("2030-03-12T13:05:00Z"); // Tuesday 09:05 in New York
const TODAY = "2030-03-12";
const at = () => makeTestCtx({ now: NOW });

const row = (id: number, f: Partial<TaskRow> = {}): TaskRow => ({ id, goal_id: null, title: `Task ${id}`, notes: null, due: null, status: "todo", effort_min: null, energy: null, is_shallow: 0, kind: "todo", remind_on: null, urgent: 0, urgent_why: null, triage_by: null, snoozed_until: null, snooze_count: 0, left_off: null, source: "web", ...f });
const rank = (tasks: TaskRow[], pins?: Map<number, string>) => rankTasks(tasks, [{ id: 1, title: "Big goal", weight: 1.5, status: "active" }], { today: TODAY, morning: true, pins });

describe("urgent has to be real", () => {
  it("the owner's call, or a flag their words or a near date back up", () => {
    expect(urgentReal({ title: "x", urgent: 1, triage_by: "you" }, TODAY)).toBe(true);
    expect(urgentReal({ title: "x", urgent: 0, triage_by: "you" }, TODAY)).toBe(false);
    expect(urgentReal({ title: "x asap", urgent: 1 }, TODAY)).toBe(true);
    expect(urgentReal({ title: "x", urgent: 1, due: "2030-03-13" }, TODAY)).toBe(true);
    expect(urgentReal({ title: "x", urgent: 1, due: "2030-03-20" }, TODAY)).toBe(false);
    expect(urgentReal({ title: "x", urgent: 1 }, TODAY)).toBe(false);
    expect(urgentReal({ title: "x asap", urgent: 1, outside: true }, TODAY)).toBe(false);
    expect(saysUrgent({ title: "send it right away" })).toBe(true);
    expect(dueWithin2("2030-03-10", TODAY)).toBe(true);
  });

  it("at most two stay urgent: the owner's first, then soonest", () => {
    const keep = capUrgent([
      { id: 1, due: "2030-03-13", mine: false },
      { id: 2, due: "2030-03-14", mine: true },
      { id: 3, due: "2030-03-12", mine: false },
      { id: 4, due: null, mine: false },
    ]);
    expect([...keep].sort()).toEqual([2, 3]);
  });
});

describe("ranking", () => {
  it("pin, then urgent, then due now, then score, each with its reason", () => {
    const out = rank(
      [row(1, { title: "Plain" }), row(2, { title: "Due", due: TODAY }), row(3, { title: "Now asap", urgent: 1 }), row(4, { title: "Picked" }), row(5, { title: "Goal", goal_id: 1 }), row(6, { title: "Late", due: "2030-03-01" })],
      new Map([[4, "fits the morning"]]),
    );
    expect(out.map((t) => t.title).slice(0, 4)).toEqual(["Picked", "Now asap", "Late", "Due"]);
    expect(out[0].reason).toBe("Claude's pick: fits the morning");
    expect(out[1].reason).toBe("Urgent: you said so");
    expect(out[2].reason).toContain("Overdue");
    expect(out[3].reason).toBe("Due today");
    expect(out.find((t) => t.title === "Goal")!.reason).toBe('Moves "Big goal" forward');
  });

  it("leaves out what is closed, ongoing or a reminder whose day has not come", () => {
    const out = rank([row(1, { status: "done" }), row(2, { kind: "ongoing" }), row(3, { kind: "reminder", remind_on: "2030-04-01" }), row(4, { kind: "reminder", remind_on: TODAY })]);
    expect(out.map((t) => t.id)).toEqual([4]);
    expect(out[0].due).toBe(TODAY);
  });

  it("a heavier goal ranks higher and a to-do others wait on ranks higher", () => {
    expect(rank([row(1), row(2, { goal_id: 1 })])[0].id).toBe(2);
    expect(rank([row(1), row(2, { blocks: 3 })])[0].id).toBe(2);
  });

  it("the short list holds at most one small errand unless it is due", () => {
    const list = rank([row(1, { title: "Buy milk" }), row(2, { title: "Buy eggs" }), row(3, { title: "Write the talk" }), row(4, { title: "Buy stamps", due: TODAY })]);
    const top = pickTop(list as RankedTask[], 4).map((t) => t.title);
    expect(top).toContain("Buy stamps");
    expect(top.filter((t) => /milk|eggs/.test(t))).toHaveLength(1);
  });

  it("reads effort from plain words", () => {
    expect(inferEnergy({ title: "Write the talk", is_shallow: 0, energy: null })).toBe("high");
    expect(inferEnergy({ title: "Call the vet", is_shallow: 0, energy: null })).toBe("low");
    expect(inferShallow({ title: "Call the vet", is_shallow: 0, energy: null })).toBe(true);
    expect(deadlinePressure("2030-03-11", TODAY)).toBe(1.2);
    expect(deadlinePressure(TODAY, TODAY)).toBe(1);
    expect(deadlinePressure(null, TODAY)).toBe(0);
  });
});

describe("Now", () => {
  it("shows one card and up to four next", async () => {
    const ctx = await at();
    for (let i = 0; i < 8; i++) await addTask(ctx, { title: `Write part ${i}` });
    const v = await nowView(ctx);
    expect(v.card?.title).toBe("Write part 0");
    expect(v.next).toHaveLength(4);
    expect(v.card?.primary.map((b) => b.id)).toEqual(["done", "later"]);
  });

  it("with nothing to do it says so", async () => {
    const v = await nowView(await at());
    expect(v.card).toBeNull();
    expect(v.free).toBe("Nothing else today");
  });

  it("'Not now' puts it off until tomorrow's start, and the second time the card stops offering it", async () => {
    const ctx = await at();
    const id = await addTask(ctx, { title: "Write the talk" });
    expect((await itemAction(ctx, id, "later")).message).toBe("Okay, tomorrow.");
    expect((await nowView(ctx)).card).toBeNull();
    const tomorrow = await makeTestCtx({ now: new Date("2030-03-13T13:05:00Z") });
    const v = await nowView(tomorrow);
    expect(v.card?.id).toBe(id);
    expect(v.card?.primary.map((b) => b.id)).toEqual(["done", "pick_day"]);
  });

  it("'Pick a day' sets the date and sleeps until then; a bad date means tomorrow", async () => {
    const ctx = await at();
    const id = await addTask(ctx, { title: "Write the talk" });
    await itemAction(ctx, id, "pick_day", { date: "2030-03-20" });
    const r = await ctx.db.one<{ due: string; snoozed_until: string }>("SELECT due, snoozed_until FROM tasks WHERE id = ?", id);
    expect(r?.due).toBe("2030-03-20");
    expect(r?.snoozed_until.slice(0, 10)).toBe("2030-03-20");
    await itemAction(ctx, id, "pick_day", { date: "1999-01-01" });
    expect((await ctx.db.one<{ due: string }>("SELECT due FROM tasks WHERE id = ?", id))?.due).toBe("2030-03-13");
  });

  it("'Stop here' keeps where you left off and shows it next time", async () => {
    const ctx = await at();
    const id = await addTask(ctx, { title: "Write the talk" });
    await itemAction(ctx, id, "stop", { note: "got to slide 4" });
    const v = await nowView(await makeTestCtx({ now: new Date("2030-03-13T13:05:00Z") }));
    expect(v.card).toMatchObject({ title: "Pick up: got to slide 4", sub: "Write the talk" });
    await itemAction(ctx, id, "done");
    expect((await ctx.db.one<{ left_off: string | null }>("SELECT left_off FROM tasks WHERE id = ?", id))?.left_off).toBeNull();
  });

  it("Done can be undone", async () => {
    const ctx = await at();
    const id = await addTask(ctx, { title: "Write the talk" });
    await itemAction(ctx, id, "done");
    expect((await nowView(ctx)).card).toBeNull();
    expect((await itemDetail(ctx, id))?.actions.map((a) => a.id)).toEqual(["undo"]);
    await itemAction(ctx, id, "undo");
    expect((await nowView(ctx)).card?.id).toBe(id);
  });

  it("a to-do waiting on another stays out of sight until that one is done", async () => {
    const ctx = await at();
    const first = await addTask(ctx, { title: "Write part one" });
    const second = await addTask(ctx, { title: "Write part two" });
    await ctx.db.run("INSERT INTO task_waits (task_id, waits_on) VALUES (?, ?)", second, first);
    const v = await nowView(ctx);
    expect(v.card?.id).toBe(first);
    expect(v.next).toEqual([]);
    expect((await todoList(ctx)).find((t) => t.id === second)?.asleep).toBe("Waiting on another to-do");
    await itemAction(ctx, first, "done");
    expect((await nowView(ctx)).card?.id).toBe(second);
  });

  it("refuses a wait that would make a loop", async () => {
    const ctx = await at();
    const a = await addTask(ctx, { title: "A" });
    const b = await addTask(ctx, { title: "B" });
    const c = await addTask(ctx, { title: "C" });
    await ctx.db.run("INSERT INTO task_waits (task_id, waits_on) VALUES (?, ?), (?, ?)", b, a, c, b);
    expect(await hasWaitLoop(ctx, a, c)).toBe(true);
    expect(await hasWaitLoop(ctx, a, a)).toBe(true);
    expect(await hasWaitLoop(ctx, c, a)).toBe(false);
    expect((await api(`/api/planner/tasks/${a}/waits`, { body: { waitsOn: c } })).status).toBe(409);
  });

  it("the owner can mark a to-do urgent, and that sticks", async () => {
    const ctx = await at();
    await addTask(ctx, { title: "Write A" });
    const b = await addTask(ctx, { title: "Write B" });
    await api(`/api/planner/tasks/${b}/urgent`, { body: { urgent: true } });
    expect((await nowView(ctx)).card?.id).toBe(b);
  });

  it("goals can be added, weighted and attached", async () => {
    const ctx = await at();
    const goal = (await (await api("/api/planner/goals", { body: { title: "Run a race", weight: 1.5 } })).json()) as { id: number };
    const a = await addTask(ctx, { title: "Write A" });
    expect((await api(`/api/planner/tasks/${a}/goal`, { body: { goalId: 9999 } })).status).toBe(400);
    expect((await api(`/api/planner/tasks/${a}/goal`, { body: { goalId: goal.id } })).status).toBe(200);
    expect((await nowView(ctx)).card?.reason).toBe('Moves "Run a race" forward');
    expect((await api("/api/planner/goals", { body: { title: "  " } })).status).toBe(400);
  });
});

describe("what a tool reads", () => {
  it("wraps outside titles, not the owner's", () => {
    expect(titleForTool("Mine", "web")).toBe("Mine");
    expect(titleForTool("Mine", null)).toBe("Mine");
    expect(titleForTool("Theirs", "email")).toContain("UNTRUSTED_DATA");
  });
});
