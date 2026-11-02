/**
 * The module contract and every shared type. Modules import from here.
 */
import type { Hono } from "hono";

// ------------------------------------------------------------------ environment

export interface Env {
  DB: D1Database;
  /** Workers AI, the free model. Optional: filing falls back to word rules without it. */
  AI?: Ai;
  ASSETS?: Fetcher;
  /** Service binding to this same Worker: the job dispatcher fans each due job out to its own invocation. */
  SELF?: Fetcher;
  TIMEZONE: string;
  /** The name the app uses for its owner. */
  USER_NAME?: string;
  /** "1" turns on demo mode, honored only on a loopback host (core/demo.ts). */
  DEMO?: string;
  /** Fixed clock for the demo, an ISO instant. */
  DEMO_NOW?: string;

  // Secrets (wrangler secret put). Every one is optional: features switch off when missing.
  APP_PASSPHRASE?: string;
  SESSION_SECRET?: string;
  /** Bearer token for scripts and the MCP server. Reaches only the routes in core/auth.ts. */
  API_TOKEN?: string;
  /** Bearer token the runner uses on /api/agent/tasks. */
  RUNNER_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  HEALTHCHECK_URL?: string;

  // Test only: migrations applied by test/apply-migrations.ts
  TEST_MIGRATIONS?: unknown[];
}

/** Hono generic: every route handler gets `c.env` (Env) and `c.get("ctx")` (Ctx). */
export type AppEnv = {
  Bindings: Env;
  Variables: { ctx: Ctx; auth: AuthKind };
};
export type AuthKind = "session" | "bearer" | "none";
export type App = Hono<AppEnv>;

export const MODULE_NAMES = ["capture", "planner"] as const;
export type ModuleName = (typeof MODULE_NAMES)[number];

// ------------------------------------------------------------------ db

export type SqlParam = string | number | null | boolean | ArrayBuffer | Uint8Array;

export interface Db {
  /** First row or null. */
  one<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | null>;
  /** All rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  /** Execute a statement; returns D1 meta (last_row_id, changes). */
  run(sql: string, ...params: SqlParam[]): Promise<D1Result>;
  /** Execute several statements in one D1 batch (atomic). */
  batch(stmts: Array<[sql: string, params?: SqlParam[]]>): Promise<D1Result[]>;
  /** INSERT a row from an object; returns the new id. Objects and arrays are JSON-stringified. */
  insert(table: string, row: Record<string, unknown>): Promise<number>;
  /** UPDATE ... SET <fields> WHERE id = ?. Objects and arrays are JSON-stringified. */
  update(table: string, id: number | string, fields: Record<string, unknown>, idColumn?: string): Promise<void>;
  /** Raw D1 for anything else. */
  raw: D1Database;
}

export interface Settings {
  get(key: string): Promise<string | null>;
  get(key: string, fallback: string): Promise<string>;
  getJSON<T>(key: string, fallback: T): Promise<T>;
  getNumber(key: string, fallback: number): Promise<number>;
  set(key: string, value: string): Promise<void>;
  setJSON(key: string, value: unknown): Promise<void>;
}

// ------------------------------------------------------------------ llm

export type LlmTier = "cheap" | "smart";

export interface LlmCompleteOptions {
  tier: LlmTier;
  prompt: string;
  system?: string;
  maxTokens?: number;
  /** Logged to llm_usage so cost is visible per feature, e.g. "capture.file". */
  purpose?: string;
}

export interface LlmJsonOptions<T> extends LlmCompleteOptions {
  /** Return the typed value, or throw (or return null) to reject and retry. Helpers live in core/validate.ts. */
  validate: (value: unknown) => T | null;
  /** An example of the shape, stringified into the prompt. */
  shape?: unknown;
  /** Default 2 (so 3 attempts). */
  retries?: number;
}

export interface LLM {
  complete(opts: LlmCompleteOptions): Promise<string>;
  json<T>(opts: LlmJsonOptions<T>): Promise<T>;
  /** Which backend each tier resolves to right now. */
  describe(): Record<LlmTier, string>;
}

// ------------------------------------------------------------------ captures

export type CaptureSource = "web" | "mcp" | "email" | "system";

export interface CaptureRow {
  id: number;
  raw_text: string | null;
  source: CaptureSource;
  source_ref: string | null;
  parent_id: number | null;
  filed_kind: string | null;
  filed_ref_table: string | null;
  filed_ref_id: number | null;
  confidence: number | null;
  status: "new" | "filed" | "low_confidence" | "failed" | "archived";
  error: string | null;
  receipt: string | null;
  created_at: string;
  filed_at: string | null;
}

/** "task" | "question" | "note". Modules declare the ones they own in `captureKinds`. */
export type CaptureKind = string;

/** What the capture bus hands to the owning module's onCapture. */
export interface FiledCapture {
  capture: CaptureRow;
  kind: CaptureKind;
  confidence: number;
  text: string;
  /** Fields the model extracted: { title?, due?, minutes? }. Treat as hints. */
  fields: Record<string, unknown>;
}

export interface CaptureResult {
  /** Table and id of the row the module created, written back to captures.filed_ref_*. Null for a plain note. */
  refTable: string | null;
  refId: number | null;
  /** One line shown back to the owner. */
  receipt: string;
  /** Set when the capture was a to-do already on the list: nothing new was made and refId is the open one. */
  duplicateOf?: { id: number; title: string };
}

// ------------------------------------------------------------------ jobs

export interface JobSchedule {
  /** Local wall time "HH:MM" in TIMEZONE. */
  at?: string;
  /** Read the time from a settings key instead; `at` is the fallback. */
  atSetting?: string;
  /** Interval: "5m" | "15m" | "1h" | "6h". Multiples of 5 minutes. */
  every?: string;
  /** Days of week (0 = Sunday ... 6 = Saturday) for `at` jobs. Default every day. */
  days?: number[];
}

export interface JobDef {
  /** Short name, unique within the module. Recorded as "<module>.<name>". */
  name: string;
  schedule: JobSchedule;
  run(ctx: Ctx): Promise<void>;
  /** Minutes after the slot in which a late run is still allowed; after that it is recorded as missed. Default 20. */
  graceMin?: number;
  /** Where it runs in one tick: 0 first (default), then 1. A later phase waits for the earlier one. */
  phase?: 0 | 1;
}

// ------------------------------------------------------------------ confirmations

export interface ConfirmationRequest {
  /** Handler key. Must exist in some module's confirmationHandlers or be registered by core. */
  kind: string;
  /** One line the owner reads before tapping. */
  summary: string;
  payload: Record<string, unknown>;
  /** Default 7 days. */
  expiresInMin?: number;
}

export interface ConfirmationRow {
  id: number;
  kind: string;
  summary: string;
  payload: string;
  status: "pending" | "approved" | "rejected" | "expired" | "failed";
  result: string | null;
  error: string | null;
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
}

export type ConfirmationHandler = (ctx: Ctx, payload: Record<string, unknown>, confirmation: ConfirmationRow) => Promise<unknown>;

// ------------------------------------------------------------------ alerts

export type AlertLevel = "info" | "warn" | "error";

export interface AlertInput {
  /** Dedupe key. An unresolved alert with the same key is not raised again. */
  key: string;
  message: string;
  level?: AlertLevel;
  module?: string;
}

// ------------------------------------------------------------------ agent tasks (the runner)

/** "held": the bundle carries text someone else wrote (core/untrusted.ts) and waits for a tap before the runner sees it. */
export type AgentTaskStatus = "queued" | "claimed" | "done" | "failed" | "fallback" | "held";

/** Row in `agent_tasks` with JSON columns parsed. */
export interface AgentTask<TInput = Record<string, unknown>, TResult = Record<string, unknown>> {
  id: number;
  kind: string;
  module: string | null;
  input: TInput;
  output_schema: unknown;
  status: AgentTaskStatus;
  result: TResult | null;
  error: string | null;
  due_at: string | null;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
  handled_at: string | null;
}

export interface AgentRequestOptions<TResult> {
  /** Deadline. After it, resolve() stops waiting for the runner and uses the fallback. Default: 24 h. */
  dueAt?: Date | string;
  /** Shape hint shown to the runner (an example object is best). Also used by the generic fallback. */
  outputSchema?: unknown;
  /** Who asked (for agentHandlers routing). */
  module?: ModuleName;
  /**
   * Fallback answer. A function cannot be stored, so this only applies when resolve() runs in the same invocation; a
   * resolve() in a later tick must pass its own fallback or rely on the generic one (the free model).
   */
  fallback?: (ctx: Ctx, task: AgentTask) => Promise<TResult>;
  /** The owner tapped for this exact request, so a bundle carrying data blocks goes to the runner at once. */
  tapped?: boolean;
  /** Extra fields stored on the release confirmation (the to-do a tap lets through). */
  releasePayload?: Record<string, unknown>;
}

export interface AgentResolution<TResult = Record<string, unknown>> {
  taskId: number;
  kind: string;
  /** "done" = the runner; "fallback" = the fallback; "pending" = before due_at; "failed" = neither produced a result. */
  status: "done" | "fallback" | "pending" | "failed";
  result: TResult | null;
  viaFallback: boolean;
  /** Line to show when viaFallback. */
  footer: string | null;
}

export interface AgentService {
  /** Queue a task for the runner. Returns the task id. */
  request<TResult = Record<string, unknown>>(kind: string, input: Record<string, unknown>, opts?: AgentRequestOptions<TResult>): Promise<number>;
  /**
   * The runner's result if it posted one; otherwise, at or after due_at (or with force), the fallback's answer, stored
   * with status "fallback". Before due_at with nothing yet: status "pending", result null.
   */
  resolve<TResult = Record<string, unknown>>(taskId: number, opts?: { fallback?: (ctx: Ctx, task: AgentTask) => Promise<TResult>; force?: boolean }): Promise<AgentResolution<TResult>>;
  /** One task by id (parsed), or null. */
  get(taskId: number): Promise<AgentTask | null>;
}

/** Called when the runner posts a result for a task kind. */
export type AgentHandler = (ctx: Ctx, task: AgentTask) => Promise<void>;

// ------------------------------------------------------------------ ctx

export interface Ctx {
  env: Env;
  db: Db;
  settings: Settings;
  llm: LLM;
  /** IANA timezone, from settings.timezone, falling back to env.TIMEZONE. */
  tz: string;
  /** The owner's name from USER_NAME, for text the app writes. */
  userName: string;
  /** Current instant. Jobs get the real time; tests and the demo may fix it. */
  now(): Date;
  /** Local date "YYYY-MM-DD" in tz (today by default). */
  localDate(d?: Date): string;
  /** Local time "HH:MM" in tz. */
  localTime(d?: Date): string;
  /** Request a one-tap confirmation. Nothing that lets outside text reach a model runs without it. */
  confirm(req: ConfirmationRequest): Promise<{ id: number; status: ConfirmationRow["status"] }>;
  /** Deduped alert, listed on the System screen. */
  alert(input: AlertInput): Promise<void>;
  agent: AgentService;
  /** Fire-and-forget work that should outlive the response (wraps ExecutionContext.waitUntil). */
  waitUntil(p: Promise<unknown>): void;
  log(...args: unknown[]): void;
}

// ------------------------------------------------------------------ the module contract

export interface ModuleDef {
  name: ModuleName;
  /** HTTP routes on a sub-app mounted at /api/<name>, with auth already enforced. */
  routes?(app: App): void;
  /** Capture kinds this module files. */
  captureKinds?: CaptureKind[];
  /** Called by the capture bus once a capture is filed to one of this module's kinds. */
  onCapture?(ctx: Ctx, filed: FiledCapture): Promise<CaptureResult>;
  /** Scheduled jobs. The 5-minute cron dispatcher runs each one when its slot is due, exactly once per slot. */
  jobs?: JobDef[];
  /** Handlers for confirmations this module requests, keyed by ConfirmationRequest.kind. */
  confirmationHandlers?: Record<string, ConfirmationHandler>;
  /** Called when the runner posts a result for one of these task kinds. Keyed by kind. */
  agentHandlers?: Record<string, AgentHandler>;
}
