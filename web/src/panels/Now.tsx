/**
 * Now: the one thing to do. The sky holds the day's arc and the card; the sheet under it holds anything from outside the
 * app waiting for a tap, then what comes next. No scores, no streaks, no percentages.
 */
import { useEffect, useRef, useState } from "react";
import { api, itemAction, itemHref, useApi, type ActionButton, type ActionResult, type Me, type NowView } from "../api";
import { Button, EmptyState } from "../ui";
import { useDay } from "../useDay";
import { SkyArc } from "./Sky";
import { ActionButtons, DayPicker, NotePrompt, addDay } from "./actions";

/** Right after a tap the runner takes a moment: look again a few times, then stop. */
const FOLLOW_UPS_MS = [800, 1600, 3000, 5000];

export default function Now({ me: _me }: { me: Me }) {
  const { data, error, loading, reload } = useApi<NowView>("/api/now");
  const [msg, setMsg] = useState<{ text: string; undoId?: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const [pick, setPick] = useState<ActionButton | null>(null);
  const [noting, setNoting] = useState<ActionButton | null>(null);
  const [day, setDay] = useState("");
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sky = useDay();

  useEffect(() => {
    const on = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [reload]);

  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), msg.undoId ? 6000 : 3500);
    return () => clearTimeout(t);
  }, [msg]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    addEventListener("pointerdown", down);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointerdown", down);
      removeEventListener("keydown", key);
    };
  }, [menu]);

  function done(r: ActionResult, undoId?: number) {
    setPick(null);
    setNoting(null);
    setMenu(false);
    setMsg(r.message ? { text: r.message, undoId: r.ok ? undoId : undefined } : null);
    void reload();
  }

  async function run(fn: () => Promise<ActionResult>, undoId?: number) {
    setBusy(true);
    try {
      done(await fn(), undoId);
    } catch (e) {
      setMsg({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function answer(id: number, yes: boolean) {
    await run(() => api.post<ActionResult>(`/api/confirmations/${id}/${yes ? "approve" : "reject"}`));
    if (yes) for (const ms of FOLLOW_UPS_MS) setTimeout(() => void reload(), ms);
  }

  if (!data)
    return (
      <div className="now">
        <section className="now-sky" aria-label="Now">
          <SkyArc day={sky} />
        </section>
        <div className="now-sheet">{error ? <EmptyState title="Now did not load" hint={error} action={{ label: "Try again", onClick: () => void reload() }} /> : <p className="muted small">{loading ? "Loading..." : ""}</p>}</div>
      </div>
    );

  const card = data.card;
  return (
    <div className="now">
      <section className="now-sky" aria-label="Now">
        <SkyArc day={sky} />
        {card ? (
          <div className="now-card">
            <div className="now-label">{card.reason}</div>
            <h1 className={card.title.length > 70 ? "now-title now-title-long" : "now-title"}>
              <a className="now-title-link" href={itemHref(card.id)}>
                {card.title}
              </a>
            </h1>
            {card.sub && <p className="now-sub">{card.sub}</p>}
            <ActionButtons
              key={card.id}
              id={card.id}
              actions={card.primary}
              today={data.date}
              onResult={(r) => done(r, r.message === "Done." ? card.id : undefined)}
              extra={
                <div className="now-dots" ref={menuRef}>
                  <button type="button" className="btn" aria-label="More options" aria-expanded={menu} aria-haspopup="menu" disabled={busy} onClick={() => setMenu((m) => !m)}>
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
                      <circle cx="3.5" cy="9" r="1.6" />
                      <circle cx="9" cy="9" r="1.6" />
                      <circle cx="14.5" cy="9" r="1.6" />
                    </svg>
                  </button>
                  {menu && (
                    <div className="now-menu" role="menu">
                      {card.more.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(false);
                            if (b.pickDay) {
                              setDay(addDay(data.date));
                              setPick(b);
                            } else if (b.note) setNoting(b);
                            else void run(() => itemAction(card.id, b.id));
                          }}
                        >
                          {b.label}
                        </button>
                      ))}
                      <a role="menuitem" href={itemHref(card.id)}>
                        Details
                      </a>
                    </div>
                  )}
                </div>
              }
            />
            {pick && <DayPicker label={pick.label} day={day} min={addDay(data.date)} onDay={setDay} busy={busy} onOk={() => void run(() => itemAction(card.id, pick.id, { date: day }))} onCancel={() => setPick(null)} />}
            {noting && <NotePrompt busy={busy} onOk={(n) => void run(() => itemAction(card.id, noting.id, { note: n }))} onCancel={() => setNoting(null)} />}
          </div>
        ) : (
          <p className="now-free">{data.free ?? "Nothing right now."}</p>
        )}
      </section>

      <div className="now-sheet">
        {msg && (
          <p className="now-msg" role="status">
            {msg.text}
            {msg.undoId && (
              <button type="button" onClick={() => void run(() => itemAction(msg.undoId!, "undo"))}>
                Undo
              </button>
            )}
          </p>
        )}

        {data.held.map((h) => (
          <section key={h.confirmationId} className="held" aria-label="Waiting for your OK">
            <p className="held-h">Waiting for your OK</p>
            <p className="held-q">{h.question}</p>
            <div className="held-actions">
              <Button primary disabled={busy} onClick={() => void answer(h.confirmationId, true)}>
                Let Claude read it
              </Button>
              <Button disabled={busy} onClick={() => void answer(h.confirmationId, false)}>
                Drop it
              </Button>
            </div>
          </section>
        ))}

        {data.outsideNote && (
          <p className="held-note" role="status">
            {data.outsideNote.note ?? "Claude read the email."} {data.outsideNote.lines.join(". ")}
          </p>
        )}

        {data.next.length > 0 && (
          <>
            <h2 className="now-h">Next</h2>
            <ul className="now-lines">
              {data.next.map((l) => (
                <li key={l.id}>
                  <a href={itemHref(l.id)}>
                    <span className="now-line-title">
                      {l.title}
                      {l.outside && <span className="tag">from outside</span>}
                    </span>
                    <span className="now-line-why">{l.reason}</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
