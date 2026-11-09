const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OWNER, plain, ownerApp, seedShift } = require("./helpers.cjs");

const API = ["getEarningsData", "updateShift", "deleteShift", "savePaycheck", "addPaySchedule"];

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
  assert.equal(plain(app.context.getEarningsData()).currentPeriodStart, "2026-11-06");
  assert.equal(app.spreadsheets.length, 1);
  assert.deepEqual(app.spreadsheets[0].sheets.map(sheet => sheet.name).sort(), ["Owner", "PaySchedule", "Paychecks", "Shifts"]);
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
  seedShift(app, { shiftDate: "2026-11-10" });
  seedShift(app, { shiftDate: "2026-11-09", hours: 7, cashTipsCents: 8000, creditTipsCents: 4321 });
  seedShift(app, { shiftDate: "2026-11-05", hours: 5 });
  seedShift(app, { shiftDate: "2026-10-09", hours: 4 });
  const data = plain(app.context.getEarningsData());
  assert.equal(data.today, "2026-11-07");
  assert.deepEqual(data.periods.map(period => [period.start, period.end, period.isCurrent]), [
    ["2026-11-06", "2026-11-19", true],
    ["2026-10-23", "2026-11-05", false],
    ["2026-10-09", "2026-10-22", false]
  ]);
  const current = data.periods[0];
  assert.deepEqual(current.shifts.map(shift => shift.shiftDate), ["2026-11-09", "2026-11-10"], "chronological order");
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
  assert.equal(current.paycheck.status, "awaiting");
  assert.equal("idempotencyKey" in current.shifts[0], false);
});

test("editing recalculates with the shift's original wage and withholding, and only weddings keep a guarantee", () => {
  const app = ownerApp();
  const shift = seedShift(app, { eventType: "wedding", guaranteeCents: 2500, withholdingRate: 0.1 });
  let data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-11-11", venue: "Starling", eventType: "wedding", role: "Bartender",
    hours: "6", cashTips: "80", creditTips: "40.55", guarantee: "30.00"
  }));
  let edited = data.periods[0].shifts[0];
  assert.deepEqual(
    [edited.shiftDate, edited.venue, edited.role, edited.wageCents, edited.guaranteeCents, edited.grossCents, edited.taxCents, edited.netCents, edited.depositCents, edited.source],
    ["2026-11-11", "Starling", "Bartender", 9000, 3000, 9000 + 8000 + 4055 + 3000, 2406, 21649, 13649, "edited"]
  );
  data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-11-11", venue: "Starling", eventType: "non-wedding", role: "Bartender",
    hours: "6", cashTips: "80", creditTips: "40.55", guarantee: "30.00"
  }));
  edited = data.periods[0].shifts[0];
  assert.deepEqual([edited.eventType, edited.guaranteeCents, edited.grossCents], ["non-wedding", 0, 21055]);
  data = plain(app.context.updateShift(shift.id, {
    shiftDate: "2026-10-27", venue: "Starling", eventType: "non-wedding", hours: "6", cashTips: "80", creditTips: "0"
  }));
  assert.deepEqual(data.periods.find(period => period.start === "2026-10-23").shifts.map(item => item.id), [shift.id],
    "changing the date moves the shift to the correct period");
  for (const bad of [{ hours: "0" }, { cashTips: "-1" }, { creditTips: "1.234" }, { shiftDate: "2026-13-01" }, { venue: "" }]) {
    assert.throws(() => app.context.updateShift(shift.id, {
      shiftDate: "2026-11-11", venue: "Starling", hours: "6", cashTips: "1", creditTips: "1", ...bad
    }));
  }
  assert.throws(() => app.context.updateShift("missing", {}), /no longer exists/);
});

test("deleting a shift updates its pay period totals immediately", () => {
  const app = ownerApp();
  const keep = seedShift(app, { shiftDate: "2026-11-08" });
  const remove = seedShift(app, { shiftDate: "2026-11-09" });
  const data = plain(app.context.deleteShift(remove.id));
  assert.deepEqual(data.periods[0].shifts.map(shift => shift.id), [keep.id]);
  assert.equal(data.periods[0].totals.grossCents, keep.grossCents);
});

test("paycheck verification stores optional actual amounts, status, and a neutral comparison", () => {
  const app = ownerApp();
  const shift = seedShift(app, { shiftDate: "2026-10-25" });
  let data = plain(app.context.savePaycheck({
    periodStart: "2026-10-23", status: "needs_review", actualGross: "277.50", actualTaxes: "$57.58",
    actualDeposit: "120.00", adjustments: "-5.25", notes: "Uniform deduction"
  }));
  const period = data.periods.find(item => item.start === "2026-10-23");
  assert.deepEqual(period.paycheck, {
    status: "needs_review", actualGrossCents: 27750, actualTaxesCents: 5758, actualDepositCents: 12000,
    adjustmentsCents: -525, notes: "Uniform deduction",
    depositDifferenceCents: 12000 - shift.depositCents, grossDifferenceCents: 0
  });
  data = plain(app.context.savePaycheck({ periodStart: "2026-10-23", status: "verified", actualDeposit: "" }));
  const verified = data.periods.find(item => item.start === "2026-10-23").paycheck;
  assert.deepEqual([verified.status, verified.actualDepositCents, verified.depositDifferenceCents], ["verified", null, null]);
  assert.throws(() => app.context.updateShift(shift.id, { shiftDate: "2026-10-25", venue: "X", hours: "1", cashTips: "0", creditTips: "0" }), /Verified/);
  assert.throws(() => app.context.deleteShift(shift.id), /Verified/);
  const other = seedShift(app, { shiftDate: "2026-11-09" });
  assert.throws(() => app.context.updateShift(other.id, { shiftDate: "2026-10-27", venue: "X", hours: "1", cashTips: "0", creditTips: "0" }), /Verified/,
    "shifts cannot be moved into a verified period");
  assert.throws(() => app.context.savePaycheck({ periodStart: "2026-10-24" }), /valid pay period/);
  assert.throws(() => app.context.savePaycheck({ periodStart: "2026-10-23", actualDeposit: "12.345" }), /two decimal places/);
});

test("changing the pay schedule only regroups later shifts and never rewrites verified history", () => {
  const app = ownerApp();
  const early = seedShift(app, { shiftDate: "2026-10-27" });
  const before = seedShift(app, { shiftDate: "2026-11-09" });
  const after = seedShift(app, { shiftDate: "2026-11-15" });
  app.context.savePaycheck({ periodStart: "2026-10-23", status: "verified" });
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-10-29", periodDays: 14 }), /must start after/);
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-11-13", periodDays: 3 }), /7 to 31/);
  const data = plain(app.context.addPaySchedule({ startDate: "2026-11-13", periodDays: 7 }));
  assert.equal(data.moved, 2);
  const byId = Object.fromEntries(data.periods.flatMap(period => period.shifts.map(shift => [shift.id, [shift.payPeriodStart, shift.payPeriodEnd]])));
  assert.deepEqual(byId[before.id], ["2026-11-06", "2026-11-12"], "an earlier shift keeps its period start, which now ends before the new schedule");
  assert.deepEqual(byId[after.id], ["2026-11-13", "2026-11-19"]);
  assert.deepEqual(data.periods.map(period => [period.start, period.end]).slice(0, 2),
    [["2026-11-13", "2026-11-19"], ["2026-11-06", "2026-11-12"]], "periods never overlap");
  assert.equal(byId[early.id][1], "2026-11-05", "verified history is untouched");
  assert.equal(data.schedules.length, 2);
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-11-13", periodDays: 14 }), /must start after/);
});

test("a schedule cannot start inside a verified pay period", () => {
  const app = ownerApp();
  seedShift(app, { shiftDate: "2026-11-10" });
  app.context.savePaycheck({ periodStart: "2026-11-06", status: "verified" });
  assert.throws(() => app.context.addPaySchedule({ startDate: "2026-11-10", periodDays: 14 }), /Verified pay periods run through 2026-11-19/);
});

test("money is parsed exactly from text without floating-point drift", () => {
  const { context } = ownerApp();
  assert.equal(context.parseCents("0.29", "x"), 29);
  assert.equal(context.parseCents("1,234.5", "x"), 123450);
  assert.equal(context.parseCents("$1.10", "x"), 110);
  assert.equal(context.parseCents("-2.05", "x", { allowNegative: true }), -205);
  assert.throws(() => context.parseCents("-2.05", "x"));
  assert.throws(() => context.parseCents("abc", "x"));
});
