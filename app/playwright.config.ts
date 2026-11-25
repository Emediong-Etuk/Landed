import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "../evidence/tests/e2e.json" }]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "off", video: process.env.E2E_VIDEO ? "on" : "off" },
  webServer: process.env.E2E_BASE_URL ? undefined : { command: "NODE_USE_ENV_PROXY=1 npx next start -p 3000", port: 3000, reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
