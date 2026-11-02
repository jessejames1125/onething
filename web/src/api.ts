/**
 * API client. Auth is the HttpOnly session cookie set by POST /api/login; a 401 anywhere flips the app to the login screen.
 */
import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // x-requested-with is the Worker's CSRF check: a cross-site form cannot send a custom header.
  const headers: Record<string, string> = { "x-requested-with": "onething" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (res.status === 401 && path !== "/api/login") {
    unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(401, "unauthorized");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
};

export function useApi<T>(path: string): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

// ------------------------------------------------------------------ shapes

export interface Me {
  userName: string;
  tz: string;
  today: string;
  now: string;
  day: { wake: number; bed: number };
  lastHeartbeat: { job: string; started_at: string; status: string } | null;
  llm: { cheap: string; smart: string };
  runner: boolean;
  demo: { dump: string; emailFrom: string; emailSubject: string; emailBody: string } | null;
}

export type ActionId = "done" | "undo" | "later" | "pick_day" | "stop" | "already" | "not_for_me";

export interface ActionButton {
  id: ActionId;
  label: string;
  pickDay?: boolean;
  note?: boolean;
}

export interface NowView {
  date: string;
  card: { id: number; title: string; sub: string | null; reason: string; outside: boolean; primary: ActionButton[]; more: ActionButton[] } | null;
  next: Array<{ id: number; title: string; reason: string; outside: boolean }>;
  free: string | null;
  held: Array<{ confirmationId: number; todoId: number | null; question: string }>;
  outsideNote: { lines: string[]; note: string | null } | null;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export const itemHref = (id: number) => `#/item/${id}`;

export const itemAction = (id: number, action: ActionId, opts: { date?: string; note?: string } = {}) => api.post<ActionResult>(`/api/planner/tasks/${id}/action`, { action, ...opts });
