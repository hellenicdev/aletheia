/**
 * WCAG 2.1 AA check of the production build.
 * Ko-fi injects a third-party iframe (floating chat) that we do not control.
 * axe is told not to enter iframes, and the widget root is excluded.
 * Our own UI is still checked.
 *
 * The preview server and Chrome are always killed. A hung axe run cannot
 * hold the CI job open.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const port = Number(process.env.AXE_PORT || 4181);
const base = process.env.PAGES_BASE || "/aletheia/";
const origin = `http://127.0.0.1:${port}`;
const root = `${origin}${base.startsWith("/") ? base : `/${base}`}`;
const HARD_MS = 75_000;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const found = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      /* try the next name */
    }
  }
  throw new Error("Chrome not found. Set CHROME_PATH.");
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const preview = spawn(
  "npx",
  ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    env: { ...process.env, PAGES_BASE: base },
    stdio: "ignore",
    detached: true,
  },
);

function stopPreview() {
  const pid = preview.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      preview.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const hardStop = setTimeout(() => {
  console.error(`axe did not finish within ${HARD_MS}ms`);
  stopPreview();
  process.exit(1);
}, HARD_MS);

let exitCode = 0;
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(root);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* preview still booting */
    }
    await delay(250);
  }
  if (!ready) throw new Error(`Preview did not start at ${root}`);

  const browser = await withTimeout(
    puppeteer.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    }),
    20_000,
    "Chrome",
  );
  try {
    const pages = [root, `${root}?lang=el`];
    const failures = [];
    for (const url of pages) {
      const page = await withTimeout(browser.newPage(), 10_000, "new page");
      try {
        await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForSelector("h1", { timeout: 10_000 });
        await page.addScriptTag({ path: axePath });
        // Give the deferred Ko-fi script a chance to inject its iframe, so the exclusion is exercised.
        await page
          .waitForSelector("[id^='kofi-widget-overlay'] iframe, .floatingchat-container-wrap iframe", {
            timeout: 8_000,
          })
          .catch(() => {});
        const result = await withTimeout(
          page.evaluate(async () => {
            const axe = window.axe;
            // Context exclude (not a run option) drops the Ko-fi widget and its third-party iframes.
            return axe.run(
              {
                exclude: [
                  ["iframe"],
                  ["[id^='kofi-widget-overlay']"],
                  [".floatingchat-container-wrap"],
                  [".floatingchat-container-wrap-mobi"],
                ],
              },
              {
                runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
                iframes: false,
                resultTypes: ["violations"],
              },
            );
          }),
          20_000,
          "axe.run",
        );
        if (result.violations.length) {
          failures.push({ url, violations: result.violations });
        } else {
          console.log(`axe clean: ${url}`);
        }
      } finally {
        await withTimeout(page.close(), 5_000, "page.close").catch(() => {});
      }
    }
    if (failures.length) {
      for (const failure of failures) {
        console.error(`\naxe violations at ${failure.url}`);
        for (const violation of failure.violations) {
          console.error(`- ${violation.id}: ${violation.help}`);
          for (const node of violation.nodes.slice(0, 5)) {
            console.error(`  ${node.target.join(" ")} — ${node.failureSummary}`);
          }
        }
      }
      exitCode = 1;
    }
  } finally {
    await withTimeout(browser.close(), 5_000, "browser.close").catch(() => {});
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  clearTimeout(hardStop);
  stopPreview();
}

process.exit(exitCode);
