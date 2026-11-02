/** To-dos: everything open, in the same order Now picks from. Put-off ones sit at the end and say when they come back. */
import { useState } from "react";
import { itemAction, itemHref, useApi, type Me } from "../api";
import { Card, EmptyState } from "../ui";

interface Line {
  id: number;
  title: string;
  reason: string;
  urgent: boolean;
  asleep: string | null;
  outside: boolean;
}

export default function Todos({ me: _me }: { me: Me }) {
  const { data, error, reload } = useApi<{ items: Line[] }>("/api/tasks");
  const [busy, setBusy] = useState<number | null>(null);

  async function done(id: number) {
    setBusy(id);
    try {
      await itemAction(id, "done");
      await reload();
    } finally {
      setBusy(null);
    }
  }

  if (error) return <EmptyState title="To-dos did not load" hint={error} action={{ label: "Try again", onClick: () => void reload() }} />;
  if (!data) return <p className="muted small">Loading...</p>;
  if (!data.items.length) return <EmptyState title="Nothing on your list" action={{ label: "Add something", href: "#/add" }} />;
  return (
    <Card>
      <ul className="list todo-list">
        {data.items.map((t) => (
          <li key={t.id} className="todo-row">
            <div className="todo-text">
              <a className="primary" href={itemHref(t.id)}>
                {t.title}
                {t.outside && <span className="tag">from outside</span>}
              </a>
              <div className="secondary">{t.asleep ?? t.reason}</div>
            </div>
            <button type="button" className="todo-done" aria-label={`Done: ${t.title}`} disabled={busy === t.id} onClick={() => void done(t.id)}>
              Done
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
