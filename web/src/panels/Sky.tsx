/**
 * The sky at the top of Now: one thin arc from wake-up to bedtime with the sun at the real time, the part behind it solid
 * and the part ahead dotted. At night the sun is a moon. Colours come from theme.css per data-sky phase.
 */
import { ARC, arcAt, clock12, type DayNow } from "../daylight";
import { useDay } from "../useDay";

export function SkyArc({ day }: { day: DayNow }) {
  const { bounds, min, phase } = day;
  const t = min < bounds.wake ? 0 : day.t;
  const p = arcAt(t);
  const { x0, y0, cx, cy, x1, y1, w, h } = ARC;
  return (
    <div className="sky-arc" role="img" aria-label={`Your day, ${clock12(bounds.wake)} to ${clock12(bounds.bed)}. It is ${clock12(min)}.`}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="sky-arc-ahead" d={`M${x0} ${y0} Q${cx} ${cy} ${x1} ${y1}`} vectorEffect="non-scaling-stroke" />
        {t > 0 && <path className="sky-arc-behind" d={`M${x0} ${y0} Q${p.qx.toFixed(1)} ${p.qy.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className={phase === "night" ? "sky-sun is-moon" : "sky-sun"} style={{ left: `${((p.x / w) * 100).toFixed(2)}%`, top: `${p.y.toFixed(1)}px` }} aria-hidden="true" />
      <div className="sky-arc-ends" aria-hidden="true">
        <span>{clock12(bounds.wake)}</span>
        <span>{clock12(bounds.bed)}</span>
      </div>
    </div>
  );
}

/** "Tue Mar 12 · 9:05 AM", for the header over the sky. */
export function SkyDate({ demo }: { demo: boolean }) {
  const day = useDay();
  const d = day.at.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");
  return (
    <span className="topbar-date">
      {demo && <span className="demo-flag">Demo · </span>}
      {d} · {clock12(day.min)}
    </span>
  );
}
