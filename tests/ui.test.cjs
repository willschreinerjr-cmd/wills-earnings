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
  seedShift(app, { shiftDate: "2026-11-20", hours: 8.5 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-21", hours: 7, cashTipsCents: 9000, creditTipsCents: 3000 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-27", hours: 9, eventType: "wedding", guaranteeCents: 4250 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-28", hours: 6.5, cashTipsCents: 7000, creditTipsCents: 0 }, DEV_OWNER);
  seedShift(app, { shiftDate: "2026-11-04", hours: 5 }, DEV_OWNER);
}

const rows = page => page.locator("#shiftTable tbody tr.shift").evaluateAll(items =>
  items.map(row => [...row.cells].map(cell => cell.textContent.trim())));
const money = cents => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

test("a calculator shift opens ready for review after hourly rates are set", async t => {
  const { page, url } = await start(t);
  const transfer = { version: 1, shiftDate: "2026-11-06", venue: "Ivy House", eventType: "non-wedding",
    entries: [{ role: "Bartender", hours: 5, cashTipsCents: 5000, creditTipsCents: 2500, guaranteeCents: 0 }] };
  await page.goto(`${url}#shift=${encodeURIComponent(JSON.stringify(transfer))}`);
  await page.locator("#periodTitle").waitFor();
  await page.waitForFunction(() => document.getElementById("transferStatus").textContent.includes("Save your hourly rates"));
  assert.equal(await page.locator("#manualTransfer").isVisible(), false);
  assert.equal(await page.evaluate(() => location.hash), "", "shift data is removed from the URL");
  await page.locator("#ratesForm input[name=bartender]").fill("12.50");
  await page.locator("#ratesForm input[name=manager]").fill("15.25");
  await page.locator("#ratesForm button").click();
  await page.locator("#confirmTransfer").waitFor({ state: "visible" });
  assert.match(await page.locator("#transferReview").innerText(), /Bartender: 5 hours at \$12\.50\/hour/);
  await page.locator("#confirmTransfer").click();
  await page.waitForFunction(() => document.getElementById("transferStatus").textContent === "Shift saved.");
  assert.equal(await page.locator("#totalGross").textContent(), "$137.50");
});

test("owner saves rates, reviews a transfer and keeps earlier rates after a raise", async t => {
  const { page, url } = await start(t);
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  await page.locator("#ratesForm input[name=bartender]").fill("12.50");
  await page.locator("#ratesForm input[name=manager]").fill("15.25");
  await page.locator("#ratesForm button").click();
  await page.waitForFunction(() => document.getElementById("ratesStatus").textContent === "Hourly rates saved.");
  await page.locator("summary", { hasText: "Review a shift" }).click();
  const transfer = { version: 1, shiftDate: "2026-11-06", venue: "Ivy House", eventType: "non-wedding",
    entries: [{ role: "Bartender", hours: 5, cashTipsCents: 5000, creditTipsCents: 2500, guaranteeCents: 0 }] };
  await page.locator("#shiftTransfer").fill(JSON.stringify(transfer));
  await page.locator("#reviewTransfer").click();
  assert.match(await page.locator("#transferReview").innerText(), /Bartender: 5 hours at \$12\.50\/hour/);
  await page.locator("#confirmTransfer").click();
  await page.waitForFunction(() => document.getElementById("transferStatus").textContent === "Shift saved.");
  assert.equal(await page.locator("#totalGross").textContent(), "$137.50");
  await page.locator("#shiftTransfer").fill(JSON.stringify(transfer));
  await page.locator("#reviewTransfer").click();
  await page.locator("#confirmTransfer").click();
  await page.waitForFunction(() => document.getElementById("transferStatus").textContent.includes("already saved"));
  await page.locator("#ratesForm input[name=bartender]").fill("20");
  await page.locator("#ratesForm button").click();
  await page.waitForFunction(() => document.getElementById("ratesStatus").textContent === "Hourly rates saved.");
  await page.reload();
  await page.locator("#periodTitle").waitFor();
  assert.equal(await page.locator("#ratesForm input[name=bartender]").inputValue(), "20.00");
  await page.locator("#periodSelect").selectOption("2026-11-02");
  assert.equal(await page.locator("#totalGross").textContent(), "$137.50");
});

test("the main page opens on the current pay period with shifts, details, and large totals", async t => {
  const { page, url, dev } = await start(t, { seed: seedPayPeriod });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  assert.equal(await page.locator("h1").textContent(), "MY EARNINGS");
  assert.equal(await page.locator("#periodTitle").textContent(), "Pay Period: November 16 – November 29");
  assert.equal(await page.locator("#currentPill").isVisible(), true);
  assert.equal(await page.locator("#statusPill").count(), 0);
  assert.equal(await page.locator("#paycheckForm").count(), 0);
  assert.doesNotMatch(await page.locator("main").innerText(), /Paycheck Verification|Awaiting Paycheck|Needs Review/);
  const period = JSON.parse(JSON.stringify(dev.app.context.getEarningsData())).periods[0];
  assert.deepEqual(await rows(page), period.shifts.map(shift => [
    new Date(`${shift.shiftDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    shift.hours.toFixed(1), money(shift.grossCents), money(shift.netCents)
  ]));
  assert.deepEqual((await rows(page)).map(row => row[0]), ["Nov 20", "Nov 21", "Nov 27", "Nov 28"]);
  assert.deepEqual(await page.locator("#shiftTable tfoot th").allTextContents(),
    ["TOTAL", "31.0", money(period.totals.grossCents), money(period.totals.netCents)]);
  assert.equal(await page.locator("#totalHours").textContent(), "31.0");
  assert.equal(await page.locator("#totalGross").textContent(), money(period.totals.grossCents));
  assert.equal(await page.locator("#totalNet").textContent(), money(period.totals.netCents));
  assert.equal(await page.locator("#totalDeposit").textContent(), money(period.totals.netCents - period.totals.cashTipsCents));
  const sizes = await page.evaluate(() => ["totalGross", "totalDeposit"].map(id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)));
  assert.ok(sizes.every(size => size >= 28), "totals are large");

  await page.locator("#shiftTable button", { hasText: "Nov 27" }).click();
  let detail = await page.locator(".detail").textContent();
  for (const expected of [/Event\s*Wedding/, /Hourly wages\s*\$135\.00/, /Cash tips\s*\$100\.00/, /Credit tips\s*\$50\.00/, /Wedding guarantee\s*\$42\.50/, /Expected through payroll/]) {
    assert.match(detail, expected);
  }
  await page.locator("#shiftTable button", { hasText: "Nov 20" }).click();
  detail = await page.locator(".detail").textContent();
  assert.match(detail, /Event\s*Non-wedding/);
  assert.doesNotMatch(detail, /Wedding guarantee/);
});

test("shifts can be corrected and deleted, and totals update immediately", async t => {
  const { page, url } = await start(t, { seed: seedPayPeriod });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  await page.locator("#shiftTable button", { hasText: "Nov 21" }).click();
  await page.locator(".detail button", { hasText: "Edit" }).click();
  await page.locator("#editForm input[name=hours]").fill("6");
  await page.locator("#editForm input[name=cashTips]").fill("95.25");
  await page.locator("#editForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("shiftStatus").textContent === "Shift updated.");
  const edited = (await rows(page))[1];
  assert.deepEqual(edited.slice(0, 3), ["Nov 21", "6.0", "$215.25"]);
  assert.equal(await page.locator("#totalHours").textContent(), "30.0");

  await page.locator("#shiftTable button", { hasText: "Nov 28" }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator(".detail button", { hasText: "Delete" }).click();
  assert.equal((await rows(page)).length, 4, "canceling keeps the shift");
  page.once("dialog", dialog => dialog.accept());
  await page.locator(".detail button", { hasText: "Delete" }).click();
  await page.waitForFunction(() => document.getElementById("shiftStatus").textContent === "Shift deleted.");
  assert.deepEqual((await rows(page)).map(row => row[0]), ["Nov 20", "Nov 21", "Nov 27"]);
  assert.equal(await page.locator("#totalHours").textContent(), "23.5");
});

test("legacy verified periods have no verification controls and remain editable", async t => {
  const { page, url } = await start(t, {
    seed: app => {
      seedPayPeriod(app);
      const sheet = app.context.getDataSpreadsheet(DEV_OWNER).insertSheet("Paychecks");
      sheet.rows.push(["periodStart", "periodEnd", "status"], ["2026-11-16", "2026-11-29", "verified"]);
    }
  });
  await page.goto(url);
  await page.locator("#periodTitle").waitFor();
  assert.equal(await page.locator("#paycheckForm").count(), 0);
  assert.equal(await page.locator("#statusPill").count(), 0);
  await page.locator("#shiftTable button", { hasText: "Nov 20" }).click();
  await page.locator(".detail button", { hasText: "Edit" }).click();
  await page.locator("#editForm input[name=hours]").fill("9");
  await page.locator("#editForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("shiftStatus").textContent === "Shift updated.");
  assert.equal((await rows(page))[0][1], "9.0");
  const updatedTotals = await page.evaluate(async () => {
    const response = await fetch("/api/getEarningsData", { method: "POST", body: "[]" });
    return (await response.json()).result.periods[0].totals;
  });
  assert.equal(await page.locator("#totalDeposit").textContent(), money(updatedTotals.depositCents));
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
