/**
 * Everything comes in here. The text is stored first, so nothing is lost when filing fails, then it is split (a brain
 * dump), classified (task, question or note) and handed to the module that owns the kind.
 *
 * Two doors do not go through a model:
 * - Email (holdEmail): outside text is stored and held for a tap. No model reads it before the tap.
 * - MCP (source "mcp"): another AI's output is filed as a plain to-do by code.
 */
import type { CaptureKind, CaptureResult, CaptureRow, CaptureSource, Ctx, FiledCapture } from "./types";
import { getModules } from "../modules/registry";
import { keepsOwnWords, splitDump, type DumpItem } from "./brainDump";
import { questionAllowed, ruleKind, todoTitle } from "./captureRules";
import { obj, optNum } from "./validate";
import { queueEmailReview, queueReview } from "./captureReview";

export const MAX_CAPTURE_CHARS = 8000;
const KINDS = ["task", "question", "note"] as const;

export interface IngestInput {
  text: string;
  source: Exclude<CaptureSource, "email">;
  sourceRef?: string | null;
}

export interface FiledItem {
  captureId: number;
  kind: CaptureKind;
  refId: number | null;
  receipt: string;
  duplicateOf?: { id: number; title: string };
}

export interface IngestResult {
  captureId: number;
  receipt: string;
  items: FiledItem[];
}

interface Filing {
  kind: CaptureKind;
  confidence: number;
  fields: Record<string, unknown>;
}

const FILE_SYSTEM = `Sort one message from the owner of a to-do app.
"task": something they have to do. "question": something they want looked up or answered. "note": anything else worth keeping.
"title": the to-do in their words, short. Never add words they did not write.`;

/** With no model answer: word rules. A short line is a to-do; a long one is kept as a note. */
export function fileByWords(text: string): Filing {
  if (questionAllowed(text)) return { kind: "question", confidence: 0.5, fields: {} };
  if (ruleKind(text) === "task" || text.length <= 120) return { kind: "task", confidence: 0.5, fields: {} };
  return { kind: "note", confidence: 0.5, fields: {} };
}

async function classify(ctx: Ctx, text: string, source: CaptureSource): Promise<Filing> {
  if (source === "mcp") return { kind: "task", confidence: 1, fields: {} };
  if (ruleKind(text) === "task") return { kind: "task", confidence: 1, fields: {} };
  try {
    const out = await ctx.llm.json<Filing>({
      tier: "cheap",
      purpose: "capture.file",
      system: FILE_SYSTEM,
      prompt: `Today is ${ctx.localDate()}.\nMessage:\n"""${text.slice(0, 2000)}"""`,
      shape: { kind: "task", confidence: 0.9, fields: { title: "renew my library card" } },
      maxTokens: 200,
      validate: (v) => {
        const o = obj(v);
        const kind = String(o.kind);
        if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
        return { kind, confidence: optNum(o.confidence) ?? 0.5, fields: o.fields && typeof o.fields === "object" ? (o.fields as Record<string, unknown>) : {} };
      },
    });
    // "question" needs an actual question: a small model calls too many things one.
    if (out.kind === "question" && !questionAllowed(text)) return { ...out, kind: text.length <= 120 ? "task" : "note" };
    // A title that rewords the owner is dropped; code makes one from their words.
    if (typeof out.fields.title === "string" && !keepsOwnWords(out.fields.title, text)) delete out.fields.title;
    return out;
  } catch (e) {
    ctx.log(`[capture] the model did not file it: ${String(e).slice(0, 160)}`);
    return fileByWords(text);
  }
}

async function fileOne(ctx: Ctx, capture: CaptureRow, hint?: DumpItem): Promise<FiledItem> {
  const text = capture.raw_text ?? "";
  const filing = await classify(ctx, text, capture.source);
  const now = ctx.now().toISOString();
  const owner = getModules().find((m) => m.captureKinds?.includes(filing.kind));
  try {
    if (!owner?.onCapture) throw new Error(`no module files ${filing.kind}`);
    const filed: FiledCapture = {
      capture,
      kind: filing.kind,
      confidence: filing.confidence,
      text,
      fields: { ...filing.fields, ...(hint ? { today: hint.today, minutes: hint.minutes } : {}) },
    };
    const res: CaptureResult = await owner.onCapture(ctx, filed);
    await ctx.db.update("captures", capture.id, {
      status: "filed",
      filed_kind: filing.kind,
      filed_ref_table: res.refTable,
      filed_ref_id: res.refId,
      confidence: filing.confidence,
      receipt: res.receipt,
      filed_at: now,
    });
    return { captureId: capture.id, kind: filing.kind, refId: res.refId, receipt: res.receipt, ...(res.duplicateOf ? { duplicateOf: res.duplicateOf } : {}) };
  } catch (e) {
    await ctx.db.update("captures", capture.id, { status: "failed", error: String(e).slice(0, 500) });
    await ctx.alert({ key: `capture.failed:${capture.id}`, level: "error", module: "core", message: `Could not file a capture: ${String(e).slice(0, 160)}` });
    return { captureId: capture.id, kind: filing.kind, refId: null, receipt: "Saved, but it could not be filed. It's in your Inbox." };
  }
}

async function store(ctx: Ctx, text: string, source: CaptureSource, sourceRef: string | null, parentId: number | null): Promise<CaptureRow> {
  const id = await ctx.db.insert("captures", { raw_text: text, source, source_ref: sourceRef, parent_id: parentId, status: "new", created_at: ctx.now().toISOString() });
  return (await ctx.db.one<CaptureRow>("SELECT * FROM captures WHERE id = ?", id))!;
}

/** One message from the owner or their tools. */
export async function ingestCapture(ctx: Ctx, input: IngestInput): Promise<IngestResult> {
  const text = input.text.trim().slice(0, MAX_CAPTURE_CHARS);
  if (!text) throw new Error("Nothing to save.");
  const capture = await store(ctx, text, input.source, input.sourceRef ?? null, null);
  // Only the owner's own text is split by a model.
  const parts = input.source === "mcp" ? null : await splitDump(ctx, text);
  if (!parts) {
    const item = await fileOne(ctx, capture);
    if (input.source !== "mcp") await queueReview(ctx, [capture.id]);
    return { captureId: capture.id, receipt: item.receipt, items: [item] };
  }
  const items: FiledItem[] = [];
  for (const part of parts) {
    const child = await store(ctx, part.text, input.source, input.sourceRef ?? null, capture.id);
    items.push(await fileOne(ctx, child, part));
  }
  const receipt = `Filed ${items.length}: ${parts.map((p) => p.short).join(", ")}.`;
  await ctx.db.update("captures", capture.id, { status: "filed", filed_kind: "dump", receipt, filed_at: ctx.now().toISOString() });
  await queueReview(ctx, items.map((i) => i.captureId));
  return { captureId: capture.id, receipt, items };
}

/** Anything not cleanly filed. */
export async function inbox(ctx: Ctx, limit = 50): Promise<CaptureRow[]> {
  return ctx.db.all<CaptureRow>("SELECT * FROM captures WHERE status IN ('new','low_confidence','failed') ORDER BY created_at DESC LIMIT ?", limit);
}

// ------------------------------------------------------------------ email

export interface ParsedEmail {
  from: string;
  subject: string;
  body: string;
}

const EMAIL_BODY_CHARS = 20_000;

function decodeBody(body: string, encoding: string): string {
  const e = encoding.toLowerCase();
  if (e.includes("base64")) {
    try {
      const bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return body;
    }
  }
  if (e.includes("quoted-printable")) {
    const raw = body.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0) & 255));
  }
  return body;
}

function splitHead(raw: string): { head: string; body: string } {
  const sep = raw.search(/\r?\n\r?\n/);
  return sep >= 0 ? { head: raw.slice(0, sep), body: raw.slice(sep).replace(/^\r?\n\r?\n/, "") } : { head: raw, body: "" };
}

function header(head: string, name: string): string {
  const m = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(head);
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

/** Subject, sender and the first plain-text part. Nested multiparts stay as raw text. */
export function parseEmail(raw: string): ParsedEmail {
  const { head, body } = splitHead(raw);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(header(head, "Content-Type"))?.[1];
  let text = "";
  if (boundary) {
    const parts = body.split(`--${boundary}`).map(splitHead);
    const plain = parts.find((p) => /text\/plain/i.test(header(p.head, "Content-Type"))) ?? parts.find((p) => /text\/html/i.test(header(p.head, "Content-Type")));
    text = plain ? decodeBody(plain.body, header(plain.head, "Content-Transfer-Encoding")) : body;
  } else {
    text = decodeBody(body, header(head, "Content-Transfer-Encoding"));
  }
  return {
    from: header(head, "From").slice(0, 200),
    subject: header(head, "Subject").slice(0, 200),
    // Cut first: the tag regex is slow on a long run of "<", and a sender picks the input.
    body: text.slice(0, EMAIL_BODY_CHARS * 4).replace(/<[^>]+>/g, " ").replace(/[ \t]+\n/g, "\n").trim().slice(0, EMAIL_BODY_CHARS),
  };
}

/** Email is held at the door: the owner can see it and tap, and that is all that can happen to it. */
export async function holdEmail(ctx: Ctx, mail: ParsedEmail, sourceRef: string | null = null): Promise<{ captureId: number; todoId: number; agentTaskId: number } | null> {
  const cap = await ctx.settings.getNumber("email.daily_cap", 25);
  const since = new Date(ctx.now().getTime() - 24 * 3600_000).toISOString();
  const sent = await ctx.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM captures WHERE source = 'email' AND created_at >= ?", since);
  if (Number(sent?.n ?? 0) >= cap) {
    await ctx.alert({ key: `email.cap:${ctx.localDate()}`, level: "warn", module: "core", message: `More than ${cap} emails in a day: the rest were not kept.` });
    return null;
  }
  const raw = `Subject: ${mail.subject}\nFrom: ${mail.from}\n\n${mail.body}`;
  const capture = await store(ctx, raw, "email", sourceRef, null);
  const now = ctx.now().toISOString();
  // The to-do's title is made by code from the headers, and it stays off the list until the tap.
  const title = todoTitle(`Email: ${mail.subject || `from ${mail.from}`}`);
  const todoId = await ctx.db.insert("tasks", { title, status: "held", source_capture_id: capture.id, created_at: now, updated_at: now });
  const receipt = "Held for your OK. Nothing has read it.";
  await ctx.db.update("captures", capture.id, { status: "filed", filed_kind: "task", filed_ref_table: "tasks", filed_ref_id: todoId, receipt, filed_at: now });
  const agentTaskId = await queueEmailReview(ctx, capture.id, raw, todoId, title);
  return { captureId: capture.id, todoId, agentTaskId };
}
