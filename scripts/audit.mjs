#!/usr/bin/env node
/**
 * Visual audit capture harness for osd-edit.
 *
 * Boots the Next.js dev server with NEXT_PUBLIC_AUDIT_MODE=1 (which
 * makes `src/lib/use-session.ts` return a synthetic signed-in session
 * so the editor renders past the GitHub OAuth gate), drives Playwright
 * at the system Chrome, captures component-isolated screenshots per
 * the manifest below, and writes a round directory under `.audit/`.
 *
 * The autonomous gan-design loop drives this script: each round
 * captures fresh shots; the evaluator scores them against a Google
 * Earth aesthetic rubric; the generator iterates the source; repeat.
 *
 * Run:    node scripts/audit.mjs
 * Output: .audit/round-NNN/{manifest.json, *.png, server.log?}
 */

import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const AUDIT_DIR = join(ROOT, ".audit");
const PORT = 3017;
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };
const CHROME = process.env.AUDIT_CHROME ?? "/usr/bin/google-chrome";

/**
 * Region selectors lean on `data-testid` attributes already present
 * in editor.tsx (welcome-intro, conflict-badge, patch-preview-panel,
 * etc.) and on `aria-label="Mode"` on the mode toolbar. New shots
 * should prefer existing test-ids over class-name selectors so the
 * audit survives CSS refactors.
 */
const ROUTES = [
  {
    name: "home-viewport",
    path: "/",
    waitFor: 'nav[aria-label="Mode"]',
    // Wait for Google Maps to actually paint, not just for the
    // React shell to mount. The SDK injects `.gm-style` once the
    // map instance is rendered; tiles need an extra moment to settle.
    extraWait: { selector: ".gm-style", optional: true, timeout: 12_000 },
    settleMs: 2_500,
    region: "viewport",
  },
  {
    name: "mode-toolbar",
    path: "/",
    waitFor: 'nav[aria-label="Mode"]',
    region: { selector: 'nav[aria-label="Mode"]' },
  },
  {
    name: "session-chip",
    path: "/",
    waitFor: 'nav[aria-label="Mode"]',
    region: { selector: 'div.fixed.right-3.top-3' },
  },
  {
    name: "welcome-intro",
    path: "/",
    waitFor: 'nav[aria-label="Mode"]',
    interact: async (page) => {
      await page.evaluate(() => {
        try { localStorage.removeItem("osd-edit:welcome-seen"); } catch {}
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="welcome-intro"]', { timeout: 10_000 });
    },
    region: { selector: '[data-testid="welcome-intro"]' },
  },
  {
    // Simulates a real user picking a resort from the dropdown. Once
    // a resort loads, the map flies to it and the right panel
    // populates with the entity browser (slopes / lifts / nodes / edges).
    // Reference flow: Google Earth's "click a feature → side panel
    // slides in with data + elevation".
    name: "resort-loaded",
    path: "/",
    waitFor: 'nav[aria-label="Mode"]',
    extraWait: { selector: ".gm-style", optional: true, timeout: 12_000 },
    interact: async (page) => {
      // Dismiss welcome so it doesn't crowd the populated panel.
      await page.evaluate(() => {
        try { localStorage.setItem("osd-edit:welcome-seen", "1"); } catch {}
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector('nav[aria-label="Mode"]', { timeout: 20_000 });
      // Wait for the resort registry to load (select options > 1).
      await page.waitForFunction(
        () => document.querySelectorAll("select option").length > 1,
        { timeout: 20_000 },
      );
      // Pick the first non-placeholder resort.
      const slug = await page.evaluate(() => {
        const select = document.querySelector("select");
        if (!select) return null;
        const first = Array.from(select.options).find((o) => o.value);
        return first ? first.value : null;
      });
      if (!slug) throw new Error("no resort slugs found in dropdown");
      await page.selectOption("select", slug);
      // Wait for the entity browser to render (it only mounts when a
      // resort is loaded).
      await page.waitForSelector('input[type="search"], input[placeholder]', {
        timeout: 15_000,
      });
    },
    settleMs: 3_000,
    region: "viewport",
  },
];

async function nextRoundDir() {
  if (!existsSync(AUDIT_DIR)) await mkdir(AUDIT_DIR);
  const entries = await readdir(AUDIT_DIR);
  const rounds = entries
    .map((n) => n.match(/^round-(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = (rounds.length ? Math.max(...rounds) : 0) + 1;
  const dir = join(AUDIT_DIR, `round-${String(next).padStart(3, "0")}`);
  await mkdir(dir, { recursive: true });
  return { dir, round: next };
}

async function waitForReady(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`dev server never responded at ${BASE}`);
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

async function main() {
  const { dir, round } = await nextRoundDir();
  console.log(`[audit] round ${round} → ${dir}`);

  // Make sure the port is free — a prior aborted run may have left
  // a zombie next-dev process holding it. Best-effort; fuser exits
  // non-zero when nothing was listening, which is fine.
  spawnSync("fuser", ["-k", `${PORT}/tcp`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 500));

  const server = spawn("npm", ["run", "dev", "--", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_PUBLIC_AUDIT_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // new process group so cleanup can kill children
  });
  let serverLog = "";
  server.stdout.on("data", (b) => (serverLog += b.toString()));
  server.stderr.on("data", (b) => (serverLog += b.toString()));

  const cleanup = async () => {
    // Kill the whole process group — `next dev` spawns workers that
    // SIGTERM on the parent won't reach.
    try { process.kill(-server.pid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 400));
    try { process.kill(-server.pid, "SIGKILL"); } catch {}
    spawnSync("fuser", ["-k", `${PORT}/tcp`], { stdio: "ignore" });
  };

  try {
    await waitForReady();
    console.log("[audit] dev server ready");

    const browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();

    const captured = [];
    for (const r of ROUTES) {
      console.log(`[audit] ${r.name}`);
      // Google Maps streams tiles indefinitely, so "networkidle" never
      // settles. Use domcontentloaded + a target selector instead.
      await page.goto(`${BASE}${r.path}`, { waitUntil: "domcontentloaded" });
      if (r.waitFor) await page.waitForSelector(r.waitFor, { timeout: 20_000 });
      if (r.extraWait) {
        try {
          await page.waitForSelector(r.extraWait.selector, {
            timeout: r.extraWait.timeout ?? 10_000,
          });
        } catch (err) {
          if (!r.extraWait.optional) throw err;
          console.warn(`[audit] ${r.name}: extraWait "${r.extraWait.selector}" not found, proceeding`);
        }
      }
      if (r.interact) await r.interact(page);
      // Let post-mount transitions settle.
      await page.waitForTimeout(r.settleMs ?? 800);

      const file = join(dir, `${r.name}.png`);
      if (r.region === "viewport") {
        await page.screenshot({ path: file, fullPage: false });
      } else {
        await page.locator(r.region.selector).first().screenshot({ path: file });
      }
      captured.push({
        name: r.name,
        file: file.replace(`${ROOT}/`, ""),
        path: r.path,
      });
    }

    await browser.close();

    const manifest = {
      round,
      capturedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      base: BASE,
      gitHead: gitHead(),
      shots: captured,
    };
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    console.log(`[audit] wrote ${join(dir, "manifest.json")}`);
  } catch (err) {
    await writeFile(join(dir, "server.log"), serverLog);
    console.error("[audit] failed; server.log saved to round dir");
    throw err;
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error("[audit] error:", err.message);
  process.exit(1);
});
