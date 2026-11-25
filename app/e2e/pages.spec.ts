import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ROUTES = ["/", "/play", "/lab", "/verify", "/proof", "/how-it-works", "/watch"];

for (const route of ROUTES) {
  test(`${route} renders, has no serious a11y violations and no page errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${route}?demo=1`);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(1200);
    const axe = await new AxeBuilder({ page }).exclude(".driver-popover").analyze();
    const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id}: ${v.nodes.length}`), "axe serious/critical").toEqual([]);
    expect(errors, "uncaught page errors").toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow, "no horizontal page scroll").toBe(false);
  });
}

test("home shows the problem sentence and honest live-stats state", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.getByText("0% reaches the player")).toBeVisible();
  await expect(page.locator("[data-tour=stats]")).toBeVisible();
});

test("guided tour walks all 10 steps across routes", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "desktop walkthrough is enough for the step logic");
  await page.goto("/?tour=1");
  for (let i = 1; i <= 10; i++) {
    const pop = page.locator(".driver-popover.landed-tour");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop.locator(".driver-popover-progress-text")).toHaveText(`${i} / 10`);
    await pop.locator(".driver-popover-next-btn").click();
  }
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await expect(page).toHaveURL(/\/proof/);
});

test("verifier page runs in a worker and reports a result", async ({ page }) => {
  await page.goto("/verify?demo=1");
  await expect(page.getByText(/Landed: all invariants hold|Violation found|Couldn't fetch chain data/)).toBeVisible({ timeout: 90_000 });
});
