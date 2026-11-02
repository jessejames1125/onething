/** Shared by Now and the to-do page: a row of action buttons, the date picker and the "where did you leave off?" box. */
import { useState, type ReactNode } from "react";
import { itemAction, type ActionButton, type ActionId, type ActionResult } from "../api";
import { Button } from "../ui";

/** "2030-03-12" -> "2030-03-13" (calendar math in UTC so a clock change never skips a day). */
export function addDay(date: string, n = 1): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ActionButtons({ id, actions, today, onResult, extra }: { id: number; actions: ActionButton[]; today: string; onResult: (r: ActionResult) => void; extra?: ReactNode }) {
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [picking, setPicking] = useState<ActionButton | null>(null);
  const [noting, setNoting] = useState<ActionButton | null>(null);
  const [day, setDay] = useState(() => addDay(today));

  async function run(b: ActionButton, date?: string, note?: string) {
    setBusy(b.id);
    try {
      onResult(await itemAction(id, b.id, { date, note }));
      setPicking(null);
      setNoting(null);
    } catch (e) {
      onResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="now-actions">
        {actions.map((b, i) => (
          <Button key={b.id} primary={i === 0} disabled={busy !== null} onClick={() => (b.pickDay ? setPicking(picking?.id === b.id ? null : b) : b.note ? setNoting(noting?.id === b.id ? null : b) : void run(b))}>
            {busy === b.id ? "..." : b.label}
          </Button>
        ))}
        {extra}
      </div>
      {picking && <DayPicker label={picking.label} day={day} min={addDay(today)} onDay={setDay} busy={busy !== null} onOk={() => void run(picking, day)} onCancel={() => setPicking(null)} />}
      {noting && <NotePrompt busy={busy !== null} onOk={(n) => void run(noting, undefined, n)} onCancel={() => setNoting(null)} />}
    </>
  );
}

export function NotePrompt({ busy, onOk, onCancel }: { busy: boolean; onOk: (note: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="now-pick"
      onSubmit={(e) => {
        e.preventDefault();
        onOk(text);
      }}
    >
      <input type="text" value={text} maxLength={140} autoFocus placeholder="Where did you leave off?" aria-label="Where did you leave off?" onChange={(e) => setText(e.target.value)} />
      <Button small primary type="submit" disabled={busy}>
        Save
      </Button>
      <Button small onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

export function DayPicker({ label, day, min, onDay, busy, onOk, onCancel }: { label: string; day: string; min?: string; onDay: (d: string) => void; busy: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <div className="now-pick">
      <input type="date" value={day} min={min} onChange={(e) => onDay(e.target.value)} aria-label={`${label}: which day`} />
      <Button small primary disabled={busy || !day} onClick={onOk}>
        OK
      </Button>
      <Button small onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
