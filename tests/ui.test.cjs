const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require("playwright");
const { createServer, OWNER: DEV_OWNER } = require("../dev/server.cjs");
const { NOW, seedShift } = require("./helpers.cjs");

let browser;
before(async () => {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].find(file => file && fs.existsSync(file));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { if (browser) await browser.close(); });

async function start(t, { seed = () => {}, activeEmail, width = 390 } = {}) {
  const { server, dev } = createServer({ persist: false, now: NOW, activeEmail });
  seed(dev.app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    if (t.passed === false) {
      fs.mkdirSync(path.join(__dirname, "..", "test-results"), { recursive: true });
      await page.screenshot({ path: path.join(__dirname, "..", "test-results", `${t.name.replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {});
    }
    await context.close();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { page, url, dev };
}

function seedPayPeriod(app) {
  seedShift(app, { shiftDate: "2026-11-13", hours: 8.5 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-14", hours: 7, cashTipsCents: 9000, creditTipsCents: 3000 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-20", hours: 9, eventType: "wedding", guaranteeCents: 4250 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-21", hours: 6.5, cashTipsCents: 7000, creditTipsCents: 0 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-10-28", hours: 5 }, DEV_OWNER);
}

const rows = page => page.locator("#shiftTable tbody tr.shift").evaluateAll(items =>
  items.map(row => [...row.cells].map(cell => cell.textContent.trim())));
const money = cents => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

test("the main page opens on the current pay period with shifts, details, and large totals", async t => {
  const { page, url, dev } = await start(t, { seed: seedPayPeriod });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  assert.equal(await page.locator("h1").textContent(), "WILL'S EARNINGS");
  assert.equal(await page.locator("#periodTitle").textContent(), "Pay Period: November 9 – November 22");
  assert.equal(await page.locator("#currentPill").isVisible(), true);
  assert.equal(await page.locator("#statusPill").textContent(), "Awaiting Paycheck");
  const period = JSON.parse(JSON.stringify(dev.app.context.getEarningsData())).periods[0];
  assert.deepEqual(await rows(page), period.shifts.map(shift => [
    new Date(`${shift.shiftDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    shift.hours.toFixed(1), money(shift.grossCents), money(shift.netCents)
  ]));
  assert.deepEqual((await rows(page)).map(row => row[0]), ["Nov 13", "Nov 14", "Nov 20", "Nov 21"]);
  assert.deepEqual(await page.locator("#shiftTable tfoot th").allTextContents(),
    ["TOTAL", "31.0", money(period.totals.grossCents), money(period.totals.netCents)]);
  assert.equal(await page.locator("#totalHours").textContent(), "31.0");
  assert.equal(await page.locator("#totalGross").textContent(), money(period.totals.grossCents));
  assert.equal(await page.locator("#totalNet").textContent(), money(period.totals.netCents));
  assert.equal(await page.locator("#totalDeposit").textContent(), money(period.totals.netCents - period.totals.cashTipsCents));
  const sizes = await page.evaluate(() => ["totalGross", "totalDeposit"].map(id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)));
  assert.ok(sizes.every(size => size >= 28), "totals are large");

  await page.locator("#shiftTable button", { hasText: "Nov 20" }).click();
  let detail = await page.locator(".detail").textContent();
  for (const expected of [/Event\s*Wedding/, /Hourly wages\s*\$135\.00/, /Cash tips\s*\$100\.00/, /Credit tips\s*\$50\.00/, /Wedding guarantee\s*\$42\.50/, /Expected through payroll/]) {
    assert.match(detail, expected);
  }
  await page.locator("#shiftTable button", { hasText: "Nov 13" }).click();
  detail = await page.locator(".detail").textContent();
  assert.match(detail, /Event\s*Non-wedding/);
  assert.doesNotMatch(detail, /Wedding guarantee/);
});

test("shifts can be corrected and deleted, and totals update immediately", async t => {
  const { page, url } = await start(t, { seed: seedPayPeriod });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  await page.locator("#shiftTable button", { hasText: "Nov 14" }).click();
  await page.locator(".detail button", { hasText: "Edit" }).click();
  await page.locator("#editForm input[name=hours]").fill("6");
  await page.locator("#editForm input[name=cashTips]").fill("95.25");
  await page.locator("#editForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("shiftStatus").textContent === "Shift updated.");
  const edited = (await rows(page))[1];
  assert.deepEqual(edited.slice(0, 3), ["Nov 14", "6.0", "$215.25"]);
  assert.equal(await page.locator("#totalHours").textContent(), "30.0");

  await page.locator("#shiftTable button", { hasText: "Nov 21" }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator(".detail button", { hasText: "Delete" }).click();
  assert.equal((await rows(page)).length, 4, "canceling keeps the shift");
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".detail button", { hasText: "Delete" }).click();
  await page.waitForFunction(() => document.getElementById("shiftStatus").textContent === "Shift deleted.");
  assert.deepEqual((await rows(page)).map(row => row[0]), ["Nov 13", "Nov 14", "Nov 20"]);
  assert.equal(await page.locator("#totalHours").textContent(), "23.5");
});

test("paycheck verification compares estimated and actual deposits and locks verified periods", async t => {
  const { page, url } = await start(t, { seed: seedPayPeriod });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  await page.locator("#olderPeriod").click();
  assert.equal(await page.locator("#periodTitle").textContent(), "Pay Period: October 26 – November 8");
  assert.equal(await page.locator("#currentPill").isVisible(), false);
  assert.deepEqual((await rows(page)).map(row => row[0]), ["Oct 28"]);
  const estimate = await page.locator("#totalDeposit").textContent();
  assert.match(await page.locator("#comparison").textContent(), new RegExp(`Estimated paycheck deposit\\s*\\${estimate}`));

  await page.locator('#paycheckForm label:has(input[value="needs_review"])').click();
  await page.locator("#paycheckForm input[name=actualDeposit]").fill("70.00");
  await page.locator("#paycheckForm input[name=actualGross]").fill("192.50");
  await page.locator("#paycheckForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("paycheckStatus").textContent === "Paycheck saved.");
  assert.equal(await page.locator("#statusPill").textContent(), "Needs Review");
  const comparison = await page.locator("#comparison").textContent();
  assert.match(comparison, /Actual paycheck deposit\s*\$70\.00/);
  assert.match(comparison, /Difference\s*\$\d+\.\d\d (higher|lower) than the estimated deposit/);
  assert.match(comparison, /before assuming an error/);

  await page.locator('#paycheckForm label:has(input[value="verified"])').click();
  await page.locator("#paycheckForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("statusPill").textContent === "Verified");
  await page.locator("#shiftTable button", { hasText: "Oct 28" }).click();
  assert.match(await page.locator(".detail").textContent(), /Verified\. Change its paycheck status/);
  assert.equal(await page.locator(".detail button", { hasText: "Edit" }).count(), 0);

  await page.locator("#newerPeriod").click();
  assert.equal(await page.locator("#periodTitle").textContent(), "Pay Period: November 9 – November 22");
  assert.equal(await page.locator("#newerPeriod").isDisabled(), true);
});

test("an empty pay period, a failed load, and narrow screens are handled cleanly", async t => {
  const { page, url } = await start(t, { width: 320 });
  let failNext = true;
  await page.route("**/api/getEarningsData", async route => {
    if (failNext) {
      failNext = false;
      return route.fulfill({ json: { ok: false, error: "Service unavailable" } });
    }
    return route.continue();
  });
  await page.goto(url);
  await page.locator("#loadError").waitFor({ state: "visible" });
  assert.match(await page.locator("#loadErrorText").textContent(), /Could not load your earnings\. Service unavailable/);
  await page.locator("#retryLoad").click();
  await page.locator("#periodTitle").waitFor();
  assert.match(await page.locator("#shiftTable").textContent(), /No shifts saved in this pay period yet/);
  assert.equal(await page.locator("#totalDeposit").textContent(), "$0.00");
  for (const width of [320, 390, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= width, `no overflow at ${width}`);
  }
});

test("the local preview refuses anyone but the owner", async t => {
  const { page, url } = await start(t, { activeEmail: "coworker@example.test" });
  const response = await page.goto(url);
  assert.equal(response.status(), 403);
  const api = await page.evaluate(async () => (await fetch("/api/getEarningsData", { method: "POST", body: "[]" })).json());
  assert.deepEqual(api, { ok: false, error: "Access denied." });
});
