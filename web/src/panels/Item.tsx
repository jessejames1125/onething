/** One to-do: why it is where it is, the words it came from, and every action. */
import { useEffect, useState } from "react";
import { api, useApi, type ActionButton, type ActionResult, type Me } from "../api";
import { Button, Card, EmptyState } from "../ui";
import { ActionButtons } from "./actions";

interface Detail {
  id: number;
  title: string;
  notes: string | null;
  why: string;
  due: string | null;
  status: "open" | "done" | "not_for_me" | "held";
  urgent: boolean;
  goalId: number | null;
  outside: string | null;
  leftOff: string | null;
  waitsOn: Array<{ id: number; title: string }>;
  actions: ActionButton[];
}

const dayLabel = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const idFromHash =() => Number(location.hash.replace(/^#\/?/, "").split("/")[1]);

export default function Item({ me }: { me: Me }) {
  const [id, setId] = useState(idFromHash);
  useEffect(() => {
    const on = () => setId(idFromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const { data, error, reload } = useApi<Detail>(`/api/planner/tasks/${id}`);
  const goals = useApi<{ items: Array<{ id: number; title: string }> }>("/api/planner/goals");
  const [msg, setMsg] = useState<string | null>(null);

  if (error) return <EmptyState title="That to-do did not load" hint={error} action={{ label: "Back to To-dos", href: "#/todos" }} />;
  if (!data) return <p className="muted small">Loading...</p>;

  const onResult = (r: ActionResult) => {
    setMsg(r.message);
    void reload();
  };

  return (
    <div>
      <a className="item-back" href="#/todos">
        Back
      </a>
      <Card>
        <h1 className={data.title.length > 70 ? "item-title is-long" : "item-title"}>{data.title}</h1>
        <p className="item-line">{data.why}</p>
        {data.outside && <p className="item-line">This text came from outside the app ({data.outside}).</p>}
        {data.due && <p className="item-line">Due {dayLabel(data.due)}</p>}
        {data.leftOff && <p className="item-about">Left off: {data.leftOff}</p>}
        {data.notes && data.notes.trim().toLowerCase() !== data.title.trim().toLowerCase() && <p className="item-about item-notes">{data.notes}</p>}
        {data.status !== "open" && <p className="item-status muted">{data.status === "done" ? "Done." : data.status === "held" ? "Waiting for your OK on Now." : "Set aside."}</p>}
        {msg && (
          <p className="now-msg" role="status">
            {msg}
          </p>
        )}
        {data.actions.length > 0 && <ActionButtons key={`${data.id}-${data.status}`} id={data.id} actions={data.actions} today={me.today} onResult={onResult} />}
      </Card>

      {data.waitsOn.length > 0 && (
        <section className="item-waits">
          <h2 className="section-h">Waits on</h2>
          <ul>
            {data.waitsOn.map((w) => (
              <li key={w.id}>
                <a href={`#/item/${w.id}`}>{w.title}</a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.status === "open" && (
        <section>
          <h2 className="section-h">Yours to set</h2>
          <div className="line-row">
            <span>Urgent</span>
            <Button
              small
              onClick={() =>
                void api.post(`/api/planner/tasks/${id}/urgent`, { urgent: !data.urgent }).then(() => {
                  setMsg(data.urgent ? "No longer urgent." : "Marked urgent.");
                  void reload();
                })
              }
            >
              {data.urgent ? "Not urgent" : "Mark urgent"}
            </Button>
          </div>
          <div className="line-row">
            <label htmlFor="goal">Goal</label>
            <select id="goal" value={data.goalId ?? ""} onChange={(e) => void api.post(`/api/planner/tasks/${id}/goal`, { goalId: e.target.value ? Number(e.target.value) : null }).then(() => void reload())}>
              <option value="">None</option>
              {(goals.data?.items ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          </div>
        </section>
      )}
    </div>
  );
}
