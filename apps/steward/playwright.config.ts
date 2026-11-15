import { defineConfig } from "@playwright/test";

// Playwright 1.64+ uses module.registerHooks() on Node 22.15+, which conflicts
// with dynamic import() of .ts modules and custom node:module register() loaders
// (https://github.com/microsoft/playwright/issues/43939). The async loader path
// avoids the bug. Set early so it applies before Playwright registers hooks.
process.env.PLAYWRIGHT_FORCE_ASYNC_LOADER ??= "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  outputDir: "./test-results",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: ["--single-process", "--no-zygote", "--no-sandbox"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
