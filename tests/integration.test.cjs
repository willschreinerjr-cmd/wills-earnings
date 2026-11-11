const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { loadScript, EARNINGS_CODE } = require("../dev/fake-apps-script.cjs");
const { OWNER, NOW, plain, ownerApp } = require("./helpers.cjs");

const calculatorDir = process.env.TWOBIRDS_TIPOUT_DIR || path.join(__dirname, "..", "..", "twobirds-tipout");
const calculatorBackend = path.join(calculatorDir, "google-apps-script.gs");
const skip = fs.existsSync(calculatorBackend) ? false : "TwoBirds Tipout checkout not found next to this repo";

function sharedBlock(file) {
  const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return source.slice(source.indexOf("// BEGIN SHARED EARNINGS STORAGE"), source.indexOf("// END SHARED EARNINGS STORAGE"));
}

function connect() {
  const earnings = ownerApp();
  earnings.context.getEarningsData();
  const calculatorProperties = new Map([
    ["LEGACY_PIN_AUTH_ENABLED", "true"],
    ["WILLS_EARNINGS_SPREADSHEET_ID", earnings.properties.get("WILLS_EARNINGS_SPREADSHEET_ID")],
    ["WILLS_EARNINGS_URL", "https://script.google.com/macros/s/earnings/exec"]
  ]);
  const calculator = loadScript(calculatorBackend, { properties: calculatorProperties, spreadsheets: earnings.spreadsheets, now: NOW });
  const post = payload => JSON.parse(calculator.context.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
  return { earnings, post };
}

function event(overrides = {}) {
  return {
    shiftDate: "2026-11-20", venue: "Society", cashPot: 300, creditPot: 150.5, isWedding: false, guestCount: null,
    staff: [
      { role: "Bartender", name: "Will Schreiner", hours: 8.5 },
      { role: "Shift Manager", name: "Staff 2", hours: 6.5 }
    ],
    ...overrides
  };
}

test("both apps use identical storage code", { skip }, () => {
  assert.equal(sharedBlock(calculatorBackend), sharedBlock(EARNINGS_CODE));
});

test("a shift saved from TwoBirds Tipout appears in Will's Earnings with matching totals", { skip }, () => {
  const { earnings, post } = connect();
  const will = post({ action: "authManagerPin", pin: "1218" });
  assert.equal(will.earningsSiteUrl, "https://script.google.com/macros/s/earnings/exec");
  const saved = post({ action: "saveEarningsShift", managerName: will.managerName, authToken: will.authToken,
    idempotencyKey: "integration-key-000001", event: event({ isWedding: true, guestCount: 150 }) });
  assert.equal(saved.ok, true, saved.error);
  const retry = post({ action: "saveEarningsShift", managerName: will.managerName, authToken: will.authToken,
    idempotencyKey: "integration-key-000001", event: event({ isWedding: true, guestCount: 150 }) });
  assert.equal(retry.duplicate, true);
  post({ action: "saveEarningsShift", managerName: will.managerName, authToken: will.authToken,
    idempotencyKey: "integration-key-000002", event: event({ shiftDate: "2026-11-21", guestCount: 150 }) });

  const data = plain(earnings.context.getEarningsData());
  const period = data.periods.find(item => item.isCurrent);
  assert.equal(period.start, "2026-11-16");
  assert.equal(period.shifts.length, 2);
  const [wedding, regular] = period.shifts;
  assert.deepEqual([wedding.eventType, wedding.role, wedding.hours, wedding.wageCents, wedding.cashTipsCents, wedding.creditTipsCents, wedding.guaranteeCents],
    ["wedding", "Bartender", 8.5, 12750, 17000, 8528, 8472]);
  assert.equal(wedding.grossCents, 12750 + 17000 + 8528 + 8472);
  assert.equal(wedding.netCents, wedding.grossCents - wedding.taxCents);
  assert.equal(wedding.depositCents, wedding.netCents - wedding.cashTipsCents);
  assert.deepEqual([regular.eventType, regular.guaranteeCents], ["non-wedding", 0], "guest counts never apply to non-weddings");
  assert.equal(saved.shift.grossCents, wedding.grossCents);

  const edited = plain(earnings.context.updateShift(regular.id, {
    shiftDate: regular.shiftDate, venue: regular.venue, eventType: "non-wedding", role: regular.role,
    hours: "8.5", cashTips: "170.00", creditTips: "0", guarantee: "0"
  }));
  assert.equal(edited.periods[0].shifts[1].creditTipsCents, 0);
  const legacyPaychecks = earnings.spreadsheets[0].insertSheet("Paychecks");
  legacyPaychecks.rows.push(["periodStart", "periodEnd", "status"], ["2026-11-16", "2026-11-29", "verified"]);
  const savedAfterLegacyVerification = post({ action: "saveEarningsShift", managerName: will.managerName, authToken: will.authToken,
    idempotencyKey: "integration-key-000003", event: event({ shiftDate: "2026-11-22" }) });
  assert.equal(savedAfterLegacyVerification.ok, true, savedAfterLegacyVerification.error);

  const jake = post({ action: "authManagerPin", pin: "2334" });
  const denied = post({ action: "saveEarningsShift", managerName: jake.managerName, authToken: jake.authToken,
    idempotencyKey: "integration-key-000004", event: event() });
  assert.match(denied.error, /Unsupported action/);
  assert.equal(plain(earnings.context.getEarningsData()).periods[0].shifts.length, 3);
});

test("TwoBirds Tipout keeps authenticating managers when Will's Earnings is unavailable", { skip }, () => {
  const calculator = loadScript(calculatorBackend, { properties: new Map([
    ["LEGACY_PIN_AUTH_ENABLED", "true"], ["WILLS_EARNINGS_SPREADSHEET_ID", "deleted-sheet"]
  ]) });
  const post = payload => JSON.parse(calculator.context.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
  const will = post({ action: "authManagerPin", pin: "1218" });
  assert.equal(will.ok, true);
  const failed = post({ action: "saveEarningsShift", managerName: will.managerName, authToken: will.authToken,
    idempotencyKey: "integration-key-000005", event: event() });
  assert.equal(failed.ok, false);
  assert.equal(post({ action: "authManagerPin", pin: "1212" }).ok, true);
});

test("the owner ID is the Google account, never an employee name", () => {
  const app = ownerApp();
  app.context.getEarningsData();
  assert.equal(app.spreadsheets[0].getSheetByName("Owner").rows[1][0], OWNER);
  assert.doesNotMatch(JSON.stringify(app.spreadsheets[0].getSheetByName("Owner").rows), /Will Schreiner/);
});
