import { expect, test } from "@playwright/test";

/** Full gameplay against devnet. Requires the deployed program + a funded gas faucet (LANDED_E2E_DEVNET=1). */
test.describe("devnet gameplay", () => {
  test.skip(!process.env.LANDED_E2E_DEVNET, "set LANDED_E2E_DEVNET=1 once the program is deployed");
  test("guest → drop → round settles → cash out → paid", async ({ page }, info) => {
    test.skip(info.project.name === "mobile");
    test.setTimeout(240_000);
    await page.goto("/play?guest=1&demo=1");
    await expect(page.locator("[data-tour=drops] button").first()).toBeEnabled({ timeout: 90_000 });
    await page.keyboard.press("2"); // drop 5
    await expect(page.getByText(/closes in|Drawing|landed on/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("landed on")).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: /Cash out all/ }).click();
    await expect(page.getByText(/^Landed( \(rescued\))?$/)).toBeVisible({ timeout: 90_000 });
  });
  test("fault lab: Landed rescues a failing payout", async ({ page }, info) => {
    test.skip(info.project.name === "mobile");
    test.setTimeout(240_000);
    await page.goto("/lab?demo=1");
    await expect(page.getByRole("button", { name: /failing payout/ })).toBeEnabled({ timeout: 120_000 });
    const open = page.getByRole("button", { name: /Open a baseline account/ });
    if (await open.isVisible()) await open.click();
    await page.getByRole("button", { name: /failing payout/ }).click();
    await expect(page.getByText("Landed (rescued)")).toBeVisible({ timeout: 120_000 });
  });
});
