import { describe, expect, it } from "vitest";
import { addDays, dayOfWeek, daysBetween, localDate, localTime, zonedTimeToUtc } from "../../src/core/time";
import { hmacHex, safeEqual, sha256Hex } from "../../src/core/crypto";
import { makeTestCtx } from "../helpers";

describe("time", () => {
  it("reads local dates and times across zones and clock changes", () => {
    const d = new Date("2030-03-12T03:30:00Z");
    expect(localDate(d, "America/New_York")).toBe("2030-03-11");
    expect(localTime(d, "America/New_York")).toBe("23:30");
    expect(localDate(d, "Asia/Tokyo")).toBe("2030-03-12");
    expect(dayOfWeek(new Date("2030-03-12T15:00:00Z"), "UTC")).toBe(2);
    expect(zonedTimeToUtc("2030-03-12", "07:00", "America/New_York").toISOString()).toBe("2030-03-12T11:00:00.000Z");
    expect(zonedTimeToUtc("2030-01-12", "07:00", "America/New_York").toISOString()).toBe("2030-01-12T12:00:00.000Z");
    expect(addDays("2030-02-28", 1)).toBe("2030-03-01");
    expect(daysBetween("2030-03-12", "2030-03-15")).toBe(3);
  });
});

describe("crypto", () => {
  it("compares in constant shape and hashes known values", async () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await hmacHex("key", "The quick brown fox jumps over the lazy dog")).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("alerts", () => {
  it("dedupe by key and reopen after being resolved", async () => {
    const ctx = await makeTestCtx();
    await ctx.alert({ key: "k", message: "one" });
    await ctx.alert({ key: "k", message: "two" });
    expect(await ctx.db.all("SELECT id FROM alerts")).toHaveLength(1);
    expect((await ctx.db.one<{ message: string }>("SELECT message FROM alerts"))?.message).toBe("one");
    const { resolveAlert } = await import("../../src/core/alerts");
    await resolveAlert(ctx, "k");
    await ctx.alert({ key: "k", message: "three" });
    expect(await ctx.db.one<{ message: string; resolved_at: string | null }>("SELECT message, resolved_at FROM alerts")).toEqual({ message: "three", resolved_at: null });
  });
});
