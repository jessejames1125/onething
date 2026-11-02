import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import { api, onUnauthorized, type Me } from "./api";
import { setAppClock, writeBounds } from "./daylight";
import { refreshDay } from "./themeChoice";
import { Button } from "./ui";
import { SkyDate } from "./panels/Sky";
import Now from "./panels/Now";
import Add from "./panels/Add";
import Todos from "./panels/Todos";
import Item from "./panels/Item";
import More from "./panels/More";

const TABS: Array<{ id: string; label: string }> = [
  { id: "now", label: "Now" },
  { id: "add", label: "Add" },
  { id: "todos", label: "To-dos" },
  { id: "more", label: "More" },
];

const SCREENS: Record<string, { title: string; Component: ComponentType<{ me: Me }> }> = {
  now: { title: "Now", Component: Now },
  add: { title: "Add", Component: Add },
  todos: { title: "To-dos", Component: Todos },
  item: { title: "To-do", Component: Item },
  more: { title: "More", Component: More },
};

function useRoute(): string {
  const read = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "now";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function Login({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/login", { passphrase: pass });
      onDone();
    } catch (err) {
      setError((err as Error).message === "wrong passphrase" ? "Wrong passphrase." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form onSubmit={submit}>
        <h1 style={{ textAlign: "center", marginBottom: 18 }}>onething</h1>
        <input type="password" placeholder="Passphrase" aria-label="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus autoComplete="current-password" />
        {error && (
          <p className="error" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <Button primary block type="submit" disabled={busy || !pass}>
            {busy ? "..." : "Unlock"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = checking
  const route = useRoute();
  const topRef = useRef<HTMLElement>(null);

  const load = async () => {
    const s = await fetch("/session", { credentials: "same-origin" }).then((r) => r.json() as Promise<{ signedIn: boolean }>).catch(() => ({ signedIn: false }));
    if (!s.signedIn) return setMe(null);
    return api
      .get<Me>("/api/me")
      .then((m) => {
        setAppClock(m.now, m.tz);
        writeBounds(m.day);
        refreshDay();
        setMe(m);
      })
      .catch(() => setMe(null));
  };
  useEffect(() => {
    void load();
    return onUnauthorized(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="login muted">Loading...</div>;
  if (me === null) return <Login onDone={() => void load()} />;

  const screen = SCREENS[route] ?? SCREENS.now;
  const id = SCREENS[route] ? route : "now";
  const tab = id === "item" ? "todos" : id;
  const onSky = id === "now";
  const hb = me.lastHeartbeat;
  const late = !me.demo && (!hb || (Date.parse(me.now) - Date.parse(hb.started_at)) / 60000 > 15);

  return (
    <div className="shell">
      <header className={onSky ? "topbar topbar-sky" : "topbar"} ref={topRef}>
        <div>
          <div className="title">{onSky ? "onething" : screen.title}</div>
          {late && (
            <a className="meta meta-warn" href="#/more">
              Scheduled jobs not running
            </a>
          )}
        </div>
        <div className="topbar-actions">{onSky && <SkyDate demo={!!me.demo} />}</div>
      </header>
      <main className="content" data-panel={id}>
        <screen.Component me={me} />
      </main>
      <nav className="nav tabs" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.id} href={`#/${t.id}`} className={t.id === tab ? "active" : ""} aria-current={t.id === tab ? "page" : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
