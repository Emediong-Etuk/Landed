/**
 * pnpm record:broll — clean 1080p clips of each flow into evidence/broll/.
 * Uses ?demo=1 (no auto-tour). Requires the app running (E2E_BASE_URL or :3000)
 * and, for the gameplay clips, the devnet deployment.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OUT = resolve(new URL(".", import.meta.url).pathname, "../../evidence/broll");
mkdirSync(OUT, { recursive: true });

async function clip(name: string, f: (p: Page) => Promise<void>) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  await page.addStyleTag({ content: "*{cursor:auto}" }).catch(() => {});
  try { await f(page); } catch (e) { console.warn(`${name}: ${(e as Error).message}`); }
  const v = page.video();
  await ctx.close();
  await browser.close();
  if (v) renameSync(await v.path(), resolve(OUT, `${name}.webm`));
  console.log(`recorded ${name}`);
}

await clip("01-guest-onboarding", async (p) => {
  await p.goto(`${BASE}/?demo=1`); await p.waitForTimeout(1500);
  await p.getByRole("link", { name: "Play as guest" }).click();
  await p.locator("[data-tour=drops] button").first().waitFor({ state: "visible", timeout: 90_000 });
  await p.waitForTimeout(1500);
});
await clip("02-drop-reveal", async (p) => {
  await p.goto(`${BASE}/play?demo=1`);
  await p.locator("[data-tour=drops] button").first().waitFor({ timeout: 90_000 });
  await p.keyboard.press("2"); await p.waitForTimeout(800); await p.keyboard.press("3");
  await p.getByText("landed on").waitFor({ timeout: 120_000 }); await p.waitForTimeout(5000);
});
await clip("03-cashout-lands", async (p) => {
  await p.goto(`${BASE}/play?demo=1`);
  await p.getByLabel("Technical details").check().catch(() => {});
  await p.getByRole("button", { name: /Cash out all/ }).click({ timeout: 90_000 });
  await p.getByText(/^Landed/).first().waitFor({ timeout: 90_000 }); await p.waitForTimeout(2500);
});
await clip("04-fault-lab", async (p) => {
  await p.goto(`${BASE}/lab?demo=1`); await p.waitForTimeout(3000);
  const open = p.getByRole("button", { name: /Open a baseline account/ });
  if (await open.isVisible()) { await open.click(); await p.waitForTimeout(8000); }
  await p.getByRole("button", { name: /failing payout/ }).click();
  await p.getByText("Landed (rescued)").waitFor({ timeout: 120_000 }); await p.waitForTimeout(6000);
});
await clip("05-verify", async (p) => {
  await p.goto(`${BASE}/verify?demo=1`);
  await p.getByText(/all invariants hold|Violation found|Couldn't fetch/).waitFor({ timeout: 90_000 }); await p.waitForTimeout(2500);
});
await clip("06-proof", async (p) => {
  await p.goto(`${BASE}/proof?demo=1`); await p.waitForTimeout(2500);
  await p.mouse.wheel(0, 1500); await p.waitForTimeout(2000); await p.mouse.wheel(0, 1500); await p.waitForTimeout(2000);
});
