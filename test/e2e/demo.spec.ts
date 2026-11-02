import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const RECORD = !!process.env.RECORD;
const images = path.resolve(import.meta.dirname, "..", "..", "docs", "images");

const beat = (page: Page, ms: number) => (RECORD ? page.waitForTimeout(ms) : Promise.resolve());
const shot = (page: Page, name: string) => (RECORD ? page.screenshot({ path: path.join(images, `${name}.png`) }) : Promise.resolve());

/** A fading dot where each tap lands, so a viewer can follow the recording. Only in RECORD mode, and it never touches the app's code. */
async function showTaps(page: Page) {
  await page.addInitScript(() => {
    addEventListener(
      "pointerdown",
      (e) => {
        const dot = document.createElement("div");
        Object.assign(dot.style, { position: "fixed", left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: "36px", height: "36px", borderRadius: "50%", background: "rgba(40,90,220,.45)", zIndex: "9999", pointerEvents: "none", transition: "opacity .5s", opacity: "1" });
        document.documentElement.append(dot);
        setTimeout(() => (dot.style.opacity = "0"), 250);
        setTimeout(() => dot.remove(), 800);
      },
      true,
    );
  });
}

test("a brain dump files into to-dos, and a hostile email waits for a tap and is read as data", async ({ page }) => {
  if (RECORD) await showTaps(page);
  await page.goto("/");

  // Robin's morning: one card.
  await expect(page.locator(".now-title")).toHaveText("Sign up for the half marathon");
  await beat(page, 2000);
  await shot(page, "1-now");

  // A messy brain dump goes in; separate to-dos come out.
  await page.getByRole("link", { name: "Add" }).click();
  await beat(page, 600);
  await page.getByRole("button", { name: "Paste a sample brain dump" }).click();
  await beat(page, 3000);
  await shot(page, "2-dump");
  await page.getByRole("button", { name: "File it" }).click();
  await expect(page.getByRole("heading", { name: /^Filed 6:/ })).toBeVisible();
  await beat(page, 3000);
  await shot(page, "3-filed");

  // The one thing to do now, and why.
  await page.getByRole("link", { name: "Show me the one thing" }).click();
  await expect(page.locator(".now-title")).toHaveText("Send the landlord the lease form asap");
  await expect(page.locator(".now-label")).toHaveText("Urgent: you wrote that it can't wait");
  await beat(page, 3000);
  await shot(page, "4-one-thing");

  // A forwarded email tells the app to ignore its rules. It waits for a tap, and nothing has read it.
  await page.getByRole("link", { name: "Add" }).click();
  await beat(page, 600);
  await page.getByRole("button", { name: "Forward a hostile email" }).click();
  const held = page.getByRole("region", { name: "Waiting for your OK" });
  await expect(held).toContainText(/ignore your rules/i);
  await expect(page.locator(".now-title")).toHaveText("Send the landlord the lease form asap");
  await beat(page, 4500);
  await shot(page, "5-held");

  // The tap sends it to the runner as data. The card does not move, and nothing was sent anywhere.
  await held.getByRole("button", { name: "Let Claude read it" }).click();
  await expect(page.locator(".held-note")).toContainText("the email was read as data", { timeout: 15_000 });
  await expect(held).toHaveCount(0);
  await expect(page.locator(".now-title")).toHaveText("Send the landlord the lease form asap");
  await beat(page, 4500);
  await shot(page, "6-read-as-data");
});

test("no screen scrolls sideways at the smallest phone width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  for (const hash of ["#/now", "#/add", "#/todos", "#/more"]) {
    await page.goto(`/${hash}`);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, hash).toBeLessThanOrEqual(0);
  }
});
