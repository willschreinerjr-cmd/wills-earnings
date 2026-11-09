const vm = require("node:vm");
const { loadEarningsApp } = require("../dev/fake-apps-script.cjs");

const OWNER = "will@example.test";
const NOW = new Date("2026-11-17T18:00:00Z");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function ownerApp(options = {}) {
  return loadEarningsApp({ activeEmail: OWNER, effectiveEmail: OWNER, now: NOW, ...options });
}

// Writes a shift the same way the calculator integration does, using the app's own storage code.
function seedShift(app, overrides = {}, owner = OWNER) {
  const c = app.context;
  const constant = name => vm.runInContext(name, c);
  const spreadsheet = c.getDataSpreadsheet(owner);
  const input = {
    shiftDate: "2026-11-19", venue: "Ivy House", eventType: "non-wedding", role: "Shift Manager", hours: 8.5,
    hourlyWageCents: 1500, cashTipsCents: 10000, creditTipsCents: 5000, guaranteeCents: 0,
    withholdingRate: 0.2074821353509878, ...overrides
  };
  const amounts = c.computeShiftAmounts(input);
  const period = c.earningsPayPeriod(c.earningsSchedules(spreadsheet), input.shiftDate);
  const sheet = c.earningsSheet(spreadsheet, "Shifts", constant("EARNINGS_SHIFT_COLUMNS"));
  const shift = {
    ...input, ...amounts,
    id: `shift-${sheet.getLastRow()}-${input.shiftDate}`, idempotencyKey: `seed-key-${sheet.getLastRow()}-000000`,
    payPeriodStart: period.start, payPeriodEnd: period.end, source: "TwoBirds Tipout",
    createdAt: `${input.shiftDate}T23:00:00.000Z`, updatedAt: `${input.shiftDate}T23:00:00.000Z`
  };
  c.earningsWriteRow(sheet, sheet.getLastRow() + 1, c.earningsShiftRow(shift));
  return shift;
}

module.exports = { OWNER, NOW, plain, ownerApp, seedShift };
