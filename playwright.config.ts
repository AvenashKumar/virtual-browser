import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The sandbox's system Chromium (/opt/meta-chromium/chrome) refuses to start
// without a Hatch WebGL domain policy. Real Playwright Chromium in CI ignores
// these unknown switches. The policy file ships with the tests so its SHA-256
// can be computed at config time.
const webglPolicyFile = join(dirname(fileURLToPath(import.meta.url)), "e2e", "hatch-webgl-domains.txt");
const webglPolicySha = createHash("sha256").update(readFileSync(webglPolicyFile)).digest("hex");
const hatchArgs = [
  `--hatch-webgl-allowed-domains-file=${webglPolicyFile}`,
  `--hatch-webgl-allowed-domains-sha256=${webglPolicySha}`,
];

const baseURL = process.env.E2E_BASE_URL || "https://browse.avenash-kumar.com";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", ...hatchArgs] }
      : { args: ["--no-sandbox", ...hatchArgs] },
  },
});
