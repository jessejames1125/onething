/** Add: one box for everything on your mind. It gets filed into separate to-dos; Now then shows the one to do first. */
import { useState, type FormEvent } from "react";
import { api, itemHref, useApi, type Me } from "../api";
import { Button } from "../ui";

interface Filed {
  receipt: string;
  items: Array<{ captureId: number; kind: string; refId: number | null; receipt: string }>;
}

export default function Add({ me }: { me: Me }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Filed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stuck = useApi<{ items: Array<{ id: number; raw_text: string | null; error: string | null }> }>("/api/captures/inbox");

  async function save(e?: FormEvent, body = text) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<Filed>("/api/capture", { text: body }));
      setText("");
      void stuck.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function forwardEmail() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/demo/email");
      location.hash = "#/now";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form className="add-box" onSubmit={(e) => void save(e)}>
        <label className="sr-only" htmlFor="dump">
          Everything on your mind
        </label>
        <textarea id="dump" value={text} placeholder="Everything on your mind, in any order." onChange={(e) => setText(e.target.value)} />
        <div className="add-actions">
          <Button primary type="submit" disabled={busy || !text.trim()}>
            {busy ? "Filing..." : "File it"}
          </Button>
        </div>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <section className="add-result" aria-live="polite">
          <h2>{result.receipt}</h2>
          {result.items.length > 1 && (
            <ul className="now-lines">
              {result.items.map((i) => (
                <li key={i.captureId}>
                  <a href={i.refId ? itemHref(i.refId) : "#/todos"}>
                    <span className="now-line-why">{i.receipt}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <div className="add-actions">
            <Button primary href="#/now">
              Show me the one thing
            </Button>
          </div>
        </section>
      )}

      {me.demo && (
        <section className="add-try" aria-label="Try the demo">
          <p>This is the demo. Try these two.</p>
          <div className="add-actions">
            <Button disabled={busy} onClick={() => setText(me.demo!.dump)}>
              Paste a sample brain dump
            </Button>
            <Button disabled={busy} onClick={() => void forwardEmail()}>
              Forward a hostile email
            </Button>
          </div>
        </section>
      )}

      {(stuck.data?.items.length ?? 0) > 0 && (
        <section className="add-result">
          <h2>Saved, but not filed</h2>
          <ul className="now-lines">
            {stuck.data!.items.map((c) => (
              <li key={c.id} className="now-line-why" style={{ padding: "10px 0" }}>
                {c.raw_text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
