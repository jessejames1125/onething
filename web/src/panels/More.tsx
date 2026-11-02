/** More: goals, what Claude changed (with Undo), whether the jobs and the runner are alive, the theme, sign out. */
import { useEffect, useState, type FormEvent } from "react";
import { api, useApi, type ActionResult, type Me } from "../api";
import { getTheme, onThemeChange, setTheme, THEME_CHOICES, THEME_LABEL, type ThemeChoice } from "../themeChoice";
import { Button, Card } from "../ui";

interface Goal {
  id: number;
  title: string;
  weight: number;
}

function Goals() {
  const { data, reload } = useApi<{ items: Goal[] }>("/api/planner/goals");
  const [title, setTitle] = useState("");
  async function add(e: FormEvent) {
    e.preventDefault();
    await api.post("/api/planner/goals", { title });
    setTitle("");
    await reload();
  }
  return (
    <Card title="Goals">
      <p className="muted small">To-dos that move a heavier goal rank higher.</p>
      {(data?.items ?? []).map((g) => (
        <div key={g.id} className="line-row">
          <span>{g.title}</span>
          <select aria-label={`How much ${g.title} matters`} value={g.weight >= 1.5 ? "1.5" : "1"} onChange={(e) => void api.post(`/api/planner/goals/${g.id}`, { weight: Number(e.target.value) }).then(() => void reload())}>
            <option value="1">Normal</option>
            <option value="1.5">Matters most</option>
          </select>
        </div>
      ))}
      <form className="goal-add" onSubmit={(e) => void add(e)}>
        <input type="text" value={title} maxLength={120} placeholder="A new goal" aria-label="A new goal" onChange={(e) => setTitle(e.target.value)} />
        <Button type="submit" disabled={!title.trim()}>
          Add
        </Button>
      </form>
    </Card>
  );
}

interface Review {
  id: number;
  status: string;
  lines: string[];
  dropped: string[];
  note: string | null;
  untrusted: boolean;
}

function Changes() {
  const { data, reload } = useApi<{ items: Review[] }>("/api/capture/reviews");
  const [msg, setMsg] = useState<string | null>(null);
  const items = (data?.items ?? []).filter((r) => r.lines.length || r.note || r.dropped.length);
  return (
    <Card title="What Claude changed">
      {msg && <p className="now-msg">{msg}</p>}
      {items.length === 0 && <p className="muted small">Nothing yet.</p>}
      {items.map((r) => (
        <div key={r.id} className="change">
          {r.note && <p>{r.note}</p>}
          {r.lines.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
          {r.dropped.length > 0 && <p className="muted small">The app refused: {r.dropped.join("; ")}</p>}
          {r.status === "applied" && (
            <Button
              small
              onClick={() =>
                void api.post<ActionResult>(`/api/capture/reviews/${r.id}/undo`).then((res) => {
                  setMsg(res.message);
                  void reload();
                })
              }
            >
              Undo
            </Button>
          )}
          {r.status === "undone" && <p className="muted small">Undone.</p>}
        </div>
      ))}
    </Card>
  );
}

interface Jobs {
  items: Array<{ id: string; last: { started_at: string; status: string; error: string | null } | null }>;
}

function System({ me }: { me: Me }) {
  const jobs = useApi<Jobs>("/api/jobs");
  const alerts = useApi<{ items: Array<{ id: number; level: string; message: string }> }>("/api/alerts");
  const agent = useApi<{ runnerConfigured: boolean; counts: Record<string, number>; lastRunnerResult: { done_at: string | null } | null; fallbackStreak: number }>("/api/system/agent");
  return (
    <Card title="System">
      <div className="line-row">
        <span>Model</span>
        <span className="muted small">{me.llm.cheap}</span>
      </div>
      <div className="line-row">
        <span>Runner</span>
        <span className="muted small">{agent.data?.runnerConfigured ? `last result ${agent.data.lastRunnerResult?.done_at ?? "none yet"}` : "not set up"}</span>
      </div>
      {(jobs.data?.items ?? []).map((j) => (
        <div key={j.id} className="line-row">
          <span>{j.id}</span>
          <span className="muted small">{j.last ? `${j.last.status}, ${j.last.started_at.slice(0, 16).replace("T", " ")}` : "not yet"}</span>
        </div>
      ))}
      {(alerts.data?.items ?? []).map((a) => (
        <p key={a.id} className="error small">
          {a.message}
        </p>
      ))}
    </Card>
  );
}

function Theme() {
  const [t, setT] = useState<ThemeChoice>(getTheme);
  useEffect(() => onThemeChange(setT), []);
  return (
    <div className="line-row">
      <label htmlFor="theme">Look</label>
      <select id="theme" value={t} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
        {THEME_CHOICES.map((c) => (
          <option key={c} value={c}>
            {THEME_LABEL[c]}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function More({ me }: { me: Me }) {
  return (
    <div>
      <Goals />
      <Changes />
      <System me={me} />
      <Card>
        <Theme />
        {!me.demo && (
          <div className="line-row">
            <span>Signed in as {me.userName}</span>
            <Button small onClick={() => void api.post("/api/logout").then(() => location.reload())}>
              Sign out
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
