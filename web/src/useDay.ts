/** The day's clock for React: re-renders each minute and when the app comes back to the front (daylight.ts). */
import { useEffect, useState } from "react";
import { dayNow, type DayNow } from "./daylight";

export function useDay(): DayNow {
  const [day, setDay] = useState<DayNow>(() => dayNow());
  useEffect(() => {
    const tick = () => setDay(dayNow());
    tick();
    const iv = setInterval(tick, 60_000);
    const vis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return day;
}
