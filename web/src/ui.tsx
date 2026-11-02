/** Shared pieces, so every screen reads as one system. */
import type { ReactNode } from "react";

export function Card({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card">
      {title != null && (
        <h2>
          <span>{title}</span>
        </h2>
      )}
      {children}
    </section>
  );
}

export function Button({ children, onClick, primary, danger, small, block, disabled, type = "button", href }: { children: ReactNode; onClick?: () => void; primary?: boolean; danger?: boolean; small?: boolean; block?: boolean; disabled?: boolean; type?: "button" | "submit"; href?: string }) {
  const cls = `btn ${primary ? "primary" : ""} ${danger ? "danger" : ""} ${small ? "small" : ""} ${block ? "block" : ""}`;
  if (href) return <a className={cls} href={href}>{children}</a>;
  return (
    <button className={cls} onClick={onClick} disabled={disabled} type={type}>
      {children}
    </button>
  );
}

export function EmptyState({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: { label: string; href?: string; onClick?: () => void } }) {
  return (
    <div className="ui-empty">
      <div className="title">{title}</div>
      {hint && <div className="small">{hint}</div>}
      {action && (
        <div style={{ marginTop: 12 }}>
          <Button primary small href={action.href} onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
