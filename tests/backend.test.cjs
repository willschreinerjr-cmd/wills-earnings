const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OWNER, plain, ownerApp, seedShift } = require("./helpers.cjs");

const API = ["getEarningsData", "updateShift", "deleteShift", "addPaySchedule", "saveHourlyRates", "saveTransferredShift"];

test("private rates and confirmed transfers preserve role wages and reject duplicates", () => {
  const app = ownerApp();
  const transfer = { version: 1, shiftDate: "2026-11-06", venue: "Ivy House", eventType: "wedding",
    entries: [
      { role: "Bartender", hours: 3, cashTipsCents: 5000, creditTipsCents: 2500, guaranteeCents: 100 },
      { role: "Shift Manager", hours: 4, cashTipsCents: 6000, creditTipsCents: 3500, guaranteeCents: 200 }
    ] };
  assert.throws(() => app.context.saveTransferredShift(transfer), /Save your hourly rates/);
  assert.throws(() => app.context.saveHourlyRates({ bartender: "-1", manager: "14" }), /nonnegative/);
  app.context.saveHourlyRates({ bartender: "12.50", manager: "15.25" });
  assert.deepEqual(plain(app.context.getEarningsData().hourlyRates), { bartenderCents: 1250, managerCents: 1525 });
  let dashboard = plain(app.context.saveTransferredShift(transfer));
  const shifts = dashboard.periods.find(period => period.start === "2026-11-02").shifts;
  assert.deepEqual(shifts.map(shift => [shift.role, shift.wageCents, shift.guaranteeCents]),
    [["Bartender", 3750, 100], ["Shift Manager", 6100, 200]]);
  assert.throws(() => app.context.saveTransferredShift(transfer), /already saved/);
  app.context.saveHourlyRates({ bartender: "20", manager: "25" });
  dashboard = plain(app.context.getEarningsData());
  assert.deepEqual(dashboard.periods.find(period => period.start === "2026-11-02").shifts.map(shift => shift.wageCents), [3750, 6100]);
  const bad = { ...transfer, shiftDate: "2026-11-07", eventType: "non-wedding" };
  assert.throws(() => app.context.saveTransferredShift(bad), /non-wedding/);
  assert.equal(plain(app.context.getEarningsData()).periods.find(period => period.start === "2026-11-02").shifts.length, 2);
  const next = { ...transfer, shiftDate: "2026-11-07", eventType: "non-wedding",
    entries: [{ role: "Bartender", hours: 5, cashTipsCents: 0, creditTipsCents: 0, guaranteeCents: 0 }] };
  const saved = plain(app.context.saveTransferredShift(next)).periods.find(period => period.start === "2026-11-02").shifts;
  assert.equal(saved.find(shift => shift.shiftDate === "2026-11-07").wageCents, 10000);
});

test("only the owner's own Google account can open the site or call any server function", () => {
  for (const activeEmail of ["", "coworker@example.test", "WILL@example.test.evil"]) {
    const app = ownerApp({ activeEmail });
    assert.equal(app.context.doGet().html, "<p style=\"font-family:sans-serif\">Access denied.</p>");
    for (const name of API) {
      assert.throws(() => app.context[name]("x", {}), /Access denied/, `${activeEmail || "anonymous"} ${name}`);
    }
    assert.equal(app.spreadsheets.length, 0, "unauthorized calls never create or open data");
  }
  const app = ownerApp({ activeEmail: OWNER.toUpperCase() });
  assert.equal(app.context.doGet().file, "Index");
  assert.equal(plain(app.context.getEarningsData()).currentPeriodStart, "2026-11-16");
  assert.equal(app.spreadsheets.length, 1);
  assert.deepEqual(app.spreadsheets[0].sheets.map(sheet => sheet.name).sort(), ["Owner", "PaySchedule", "Shifts"]);
  assert.equal(app.context.savePaycheck, undefined);
  assert.equal(app.spreadsheets[0].getSheetByName("Owner").rows[1][0], OWNER);
});

test("a data sheet registered to another account is never served", () => {
  const app = ownerApp();
  app.context.getEarningsData();
  const other = ownerApp({ activeEmail: "someone@example.test", effectiveEmail: "someone@example.test",
    properties: app.properties, spreadsheets: app.spreadsheets });
  assert.throws(() => other.context.getEarningsData(), /Access denied/);
});

test("shifts are grouped into biweekly pay periods with totals in whole cents", () => {
  const app = ownerApp();
  seedShift(app, { shiftDate: "2026-11-20" });
  seedShift(app, { shiftDate: "2026-11-19", hours: 7, cashTipsCents: 8000, creditTipsCents: 4321 });
  seedShift(app, { shiftDate: "2026-11-15", hours: 5 });
  seedShift(app, { shiftDate: "2026-10-19", hours: 4 });
  const data = plain(app.context.getEarningsData());
  assert.equal(data.today, "2026-11-17");
  assert.deepEqual(data.periods.map(period => [period.start, period.end, period.isCurrent]), [
    ["2026-11-16", "2026-11-29", true],
    ["2026-11-02", "2026-11-15", false],
    ["2026-10-19", "2026-11-01", false]
  ]);
  const current = data.periods[0];
  assert.deepEqual(current.shifts.map(shift => shift.shiftDate), ["2026-11-19", "2026-11-20"], "chronological order");
  const [first, second] = current.shifts;
  assert.deepEqual([second.wageCents, second.grossCents, second.taxCents, second.netCents, second.cashReceivedCents, second.depositCents],
    [12750, 27750, 5758, 21992, 10000, 11992]);
  assert.equal(first.grossCents, 10500 + 8000 + 4321);
  assert.deepEqual(current.totals, {
    hours: 15.5,
    wageCents: 10500 + 12750, cashTipsCents: 18000, creditTipsCents: 9321, guaranteeCents: 0,
    grossCents: first.grossCents + second.grossCents, taxCents: first.taxCents + second.taxCents,
    netCents: first.netCents + second.netCents, depositCents: first.depositCents + second.depositCents
  });
  assert.equal(current.totals.depositCents, current.totals.netCents - current.totals.cashTipsCents);
  assert.equal("paycheck" in current, false);
  assert.equal("idempotencyKey" in current.shifts[0], false);
});

test("editing recalculates with the shift's original wage and withholding, and only weddings keep a guarantee", () => {
  const app = ownerApp();
  const shift = seedShift(app, { eventType: "wedding", guaranteeCents: 2500, withholdingRate: 0.1 });
  let data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-11-21", venue: "Starling", eventType: "wedding", role: "Bartender",
    hours: "6", cashTips: "80", creditTips: "40.55", guarantee: "30.00"
  }));
  let edited = data.periods[0].shifts[0];
  assert.deepEqual(
    [edited.shiftDate, edited.venue, edited.role, edited.wageCents, edited.guaranteeCents, edited.grossCents, edited.taxCents, edited.netCents, edited.depositCents, edited.source],
    ["2026-11-21", "Starling", "Bartender", 9000, 3000, 9000 + 8000 + 4055 + 3000, 2406, 21649, 13649, "edited"]
  );
  data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-11-21", venue: "Starling", eventType: "non-wedding", role: "Bartender",
    hours: "6", cashTips: "80", creditTips: "40.55", guarantee: "30.00"
  }));
  edited = data.periods[0].shifts[0];
  assert.deepEqual([edited.eventType, edited.guaranteeCents, edited.grossCents], ["non-wedding", 0, 21055]);
  data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-11-06", venue: "Starling", eventType: "non-wedding", hours: "6", cashTips: "80", creditTips: "0"
  }));
  assert.deepEqual(data.periods.find(period => period.start === "2026-11-02").shifts.map(item => item.id), [shift.id],
    "changing the date moves the shift to the correct period");
  for (const bad of [{ hours: "0" }, { cashTips: "-1" }, { creditTips: "1.234" }, { shiftDate: "2026-13-01" }, { venue: "" }]) {
    assert.throws(() => app.context.updateShift(shift.id, {
      shiftDate: "2026-11-21", venue: "Starling", hours: "6", cashTips: "1", creditTips: "1", ...bad
    }));
  }
  assert.throws(() => app.context.updateShift("missing", {}), /no longer exists/);
});

test("deleting a shift updates its pay period totals immediately", () => {
  const app = ownerApp();
  const keep = seedShift(app, { shiftDate: "2026-11-18" });
  const remove = seedShift(app, { shiftDate: "2026-11-19" });
  const data = plain(app.context.deleteShift(remove.id));
  assert.deepEqual(data.periods[0].shifts.map(shift => shift.id), [keep.id]);
  assert.equal(data.periods[0].totals.grossCents, keep.grossCents);
});

test("legacy verified paycheck records do not lock shift edits or create dashboard periods", () => {
  const app = ownerApp();
  const shift = seedShift(app, { shiftDate: "2026-11-04" });
  const spreadsheet = app.context.getDataSpreadsheet(OWNER);
  const legacyPaychecks = spreadsheet.insertSheet("Paychecks");
  legacyPaychecks.rows.push(
    ["periodStart", "periodEnd", "status"],
    ["2026-11-02", "2026-11-15", "verified"],
    ["2026-10-19", "2026-11-01", "verified"]
  );
  const data = plain(app.context.getEarningsData());
  assert.deepEqual(data.periods.map(period => period.start), ["2026-11-16", "2026-11-02"]);
  assert.equal(data.periods.some(period => period.start === "2026-10-19"), false, "legacy paychecks do not create empty periods");
  assert.equal("paycheck" in data.periods.find(period => period.start === "2026-11-02"), false);
  const edited = app.context.updateShift(shift.id, {
    shiftDate: "2026-11-04", venue: "Starling", hours: "1", cashTips: "0", creditTips: "0"
  });
  assert.equal(plain(edited).periods.find(period => period.start === "2026-11-02").shifts[0].venue, "Starling");
  assert.equal(plain(app.context.deleteShift(shift.id)).periods[0].shifts.length, 0);
  assert.equal(legacyPaychecks.rows[1][2], "verified", "old verification data is left untouched");
});

test("changing the pay schedule regroups later shifts without rewriting earlier shift periods", () => {
  const app = ownerApp();
  const early = seedShift(app, { shiftDate: "2026-11-06" });
  const before = seedShift(app, { shiftDate: "2026-11-19" });
  const after = seedShift(app, { shiftDate: "2026-11-25" });
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-11-23", periodDays: 3 }), /7 to 31/);
  const data = plain(app.context.addPaySchedule({ startDate: "2026-11-23", periodDays: 7 }));
  assert.equal(data.moved, 2);
  const byId = Object.fromEntries(data.periods.flatMap(period => period.shifts.map(shift => [shift.id, [shift.payPeriodStart, shift.payPeriodEnd]])));
  assert.deepEqual(byId[before.id], ["2026-11-16", "2026-11-22"], "an earlier shift keeps its period start, which now ends before the new schedule");
  assert.deepEqual(byId[after.id], ["2026-11-23", "2026-11-29"]);
  assert.deepEqual(data.periods.map(period => [period.start, period.end]).slice(0, 2),
    [["2026-11-23", "2026-11-29"], ["2026-11-16", "2026-11-22"]], "periods never overlap");
  assert.equal(byId[early.id][1], "2026-11-15", "earlier shift periods remain untouched");
  assert.equal(data.schedules.length, 2);
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-11-23", periodDays: 14 }), /must start after/);
});

test("a schedule can change inside a legacy verified pay period", () => {
  const app = ownerApp();
  const shift = seedShift(app, { shiftDate: "2026-11-20" });
  const spreadsheet = app.context.getDataSpreadsheet(OWNER);
  const legacyPaychecks = spreadsheet.insertSheet("Paychecks");
  legacyPaychecks.rows.push(
    ["periodStart", "periodEnd", "status"],
    ["2026-11-16", "2026-11-29", "verified"]
  );
  const data = plain(app.context.addPaySchedule({ startDate: "2026-11-20", periodDays: 14 }));
  assert.equal(data.schedules.length, 2);
  assert.equal(data.periods.flatMap(period => period.shifts).find(item => item.id === shift.id).payPeriodStart, "2026-11-20");
  assert.equal(legacyPaychecks.rows[1][2], "verified", "old verification data is left untouched");
});

test("money is parsed exactly from text without floating-point drift", () => {
  const { context } = ownerApp();
  assert.equal(context.parseCents("0.29", "x"), 29);
  assert.equal(context.parseCents("1,234.5", "x"), 123450);
  assert.equal(context.parseCents("$1.10", "x"), 110);
  assert.throws(() => context.parseCents("-2.05", "x"));
  assert.throws(() => context.parseCents("abc", "x"));
});
