/**
 * Screenshots every page at three widths and collects console noise.
 *
 *   node scripts/ui-audit.mjs [outDir]
 *
 * Written for reviewing the interface, not for CI: it logs in as the chairman
 * (who can reach every page), walks the routes, and writes one PNG per page per
 * breakpoint so the rendered result can actually be looked at rather than
 * inferred from the markup.
 */

import fs from "node:fs";
import { chromium } from "playwright";

const OUT = process.argv[2] || "/tmp/ui-audit";
const BASE = process.env.AUDIT_URL || "http://localhost:3000";
const LOGIN = process.env.AUDIT_LOGIN || "rais";
const PASSWORD = process.env.AUDIT_PASSWORD || "rais2026";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "desktop", width: 1440, height: 900 },
];

const ROUTES = [
  ["dashboard", "/dashboard"],
  ["tasks-assign", "/tasks/assign"],
  ["tasks-inbox", "/tasks/inbox"],
  ["tasks-execute", "/tasks/execute"],
  ["tasks-overdue", "/tasks/overdue"],
  ["team", "/team"],
  ["statistics", "/statistics"],
  ["reports", "/reports"],
  ["ai", "/ai"],
  ["meetings", "/meetings"],
  ["partners", "/partners"],
  ["chat", "/chat"],
  ["profile", "/profile"],
];

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems = [];

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`[${viewport.name}] console.${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    problems.push(`[${viewport.name}] pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    problems.push(`[${viewport.name}] failed: ${request.url()}`);
  });

  // Sign in once per context; the session cookie carries the rest of the walk.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/${viewport.name}-login.png`, fullPage: true });
  await page.fill('input[name="login"], input#login, input[type="text"]', LOGIN);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 }).catch(() => {});

  for (const [name, route] of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" }).catch(() => {});
    // Let entry animations settle so the shot is the resting state.
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${OUT}/${viewport.name}-${name}.png`,
      fullPage: true,
    });

    // A page wider than its viewport is the defect that hides every other one.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 2) {
      problems.push(`[${viewport.name}] ${route}: horizontal overflow ${overflow}px`);
    }
  }

  await context.close();
}

await browser.close();

fs.writeFileSync(`${OUT}/problems.txt`, problems.join("\n") || "нет замечаний");
console.log(problems.length ? problems.join("\n") : "console/overflow: чисто");
console.log(`\nСкриншоты: ${OUT}`);
