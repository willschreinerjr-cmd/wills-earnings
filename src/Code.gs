// Will's Earnings: a private Apps Script web app.
// Deploy with "Execute as: Me" and "Who has access: Only myself"; requireOwner() re-checks every call.

const DATA_SPREADSHEET_PROPERTY = "WILLS_EARNINGS_SPREADSHEET_ID";
const DATA_SPREADSHEET_NAME = "Will's Earnings - Private Data";
const BUSINESS_DAY_ROLLOVER_HOUR = 3;
const PAYCHECK_STATUSES = ["awaiting", "verified", "needs_review"];
const MAX_AMOUNT_CENTS = 10000000;

// BEGIN SHARED EARNINGS STORAGE (keep identical in twobirds-tipout/google-apps-script.gs and wills-earnings/src/Code.gs)
const EARNINGS_SHIFT_SHEET = "Shifts";
const EARNINGS_SCHEDULE_SHEET = "PaySchedule";
const EARNINGS_PAYCHECK_SHEET = "Paychecks";
const EARNINGS_OWNER_SHEET = "Owner";
const EARNINGS_SHIFT_COLUMNS = [
  "id", "idempotencyKey", "shiftDate", "venue", "eventType", "role", "hours",
  "hourlyWageCents", "wageCents", "cashTipsCents", "creditTipsCents", "guaranteeCents",
  "grossCents", "taxCents", "netCents", "cashReceivedCents", "depositCents",
  "withholdingRate", "payPeriodStart", "payPeriodEnd", "source", "createdAt", "updatedAt"
];
const EARNINGS_SCHEDULE_COLUMNS = ["startDate", "periodDays", "createdAt"];
const EARNINGS_PAYCHECK_COLUMNS = [
  "periodStart", "periodEnd", "status", "actualGrossCents", "actualTaxesCents",
  "actualDepositCents", "adjustmentsCents", "notes", "updatedAt"
];
const EARNINGS_OWNER_COLUMNS = ["ownerId", "createdAt"];
const EARNINGS_DEFAULT_SCHEDULE = { startDate: "2026-10-12", periodDays: 14 };
const EARNINGS_INTEGER_FIELDS = [
  "hourlyWageCents", "wageCents", "cashTipsCents", "creditTipsCents", "guaranteeCents", "grossCents",
  "taxCents", "netCents", "cashReceivedCents", "depositCents"
];

function earningsDayNumber(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ""));
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(time).toISOString().slice(0, 10) === match[0] ? Math.round(time / 86400000) : null;
}

function earningsDayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function earningsWriteRow(sheet, row, values) {
  // Plain-text cells keep dates, cents, and IDs exactly as written.
  sheet.getRange(row, 1, 1, values.length)
    .setNumberFormat("@")
    .setValues([values.map(value => value === null || value === undefined ? "" : String(value))]);
}

function earningsSheet(spreadsheet, name, columns) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    earningsWriteRow(sheet, 1, columns);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function earningsReadRows(sheet, columns) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, columns.length).getValues().map((values, index) => {
    const record = { row: index + 2 };
    columns.forEach((column, columnIndex) => { record[column] = String(values[columnIndex]); });
    return record;
  });
}

function earningsSchedules(spreadsheet) {
  const sheet = earningsSheet(spreadsheet, EARNINGS_SCHEDULE_SHEET, EARNINGS_SCHEDULE_COLUMNS);
  let schedules = earningsReadRows(sheet, EARNINGS_SCHEDULE_COLUMNS)
    .map(record => ({ startDate: record.startDate, periodDays: Number(record.periodDays) }))
    .filter(schedule => earningsDayNumber(schedule.startDate) !== null &&
      Number.isInteger(schedule.periodDays) && schedule.periodDays > 0);
  if (!schedules.length) {
    earningsWriteRow(sheet, sheet.getLastRow() + 1, [
      EARNINGS_DEFAULT_SCHEDULE.startDate, EARNINGS_DEFAULT_SCHEDULE.periodDays, new Date().toISOString()
    ]);
    schedules = [{ ...EARNINGS_DEFAULT_SCHEDULE }];
  }
  return schedules.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

function earningsPayPeriod(schedules, isoDate) {
  const day = earningsDayNumber(isoDate);
  if (day === null) throw new Error("Enter a valid date.");
  let index = 0;
  schedules.forEach((schedule, scheduleIndex) => {
    if (earningsDayNumber(schedule.startDate) <= day) index = scheduleIndex;
  });
  const schedule = schedules[index];
  const scheduleStart = earningsDayNumber(schedule.startDate);
  const start = scheduleStart + Math.floor((day - scheduleStart) / schedule.periodDays) * schedule.periodDays;
  let end = start + schedule.periodDays - 1;
  const next = schedules[index + 1];
  if (next) end = Math.min(end, earningsDayNumber(next.startDate) - 1);
  return { start: earningsDayToIso(start), end: earningsDayToIso(end) };
}

function earningsPaychecks(spreadsheet) {
  const sheet = earningsSheet(spreadsheet, EARNINGS_PAYCHECK_SHEET, EARNINGS_PAYCHECK_COLUMNS);
  return earningsReadRows(sheet, EARNINGS_PAYCHECK_COLUMNS).filter(record => record.periodStart);
}

function earningsIsVerifiedPeriod(spreadsheet, periodStart) {
  return earningsPaychecks(spreadsheet).some(record =>
    record.periodStart === periodStart && record.status === "verified");
}

function earningsShiftFromRecord(record) {
  const shift = {};
  EARNINGS_SHIFT_COLUMNS.forEach(column => { shift[column] = record[column]; });
  EARNINGS_INTEGER_FIELDS.forEach(field => { shift[field] = Number(record[field]) || 0; });
  shift.hours = Number(record.hours) || 0;
  shift.withholdingRate = Number(record.withholdingRate) || 0;
  shift.row = record.row;
  return shift;
}

function earningsShiftRow(shift) {
  return EARNINGS_SHIFT_COLUMNS.map(column => shift[column]);
}
// END SHARED EARNINGS STORAGE

function doGet() {
  try {
    requireOwner();
  } catch (err) {
    return HtmlService.createHtmlOutput("<p style=\"font-family:sans-serif\">Access denied.</p>").setTitle("Access denied");
  }
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Will's Earnings")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function normalizedEmail(user) {
  try {
    return String(user && user.getEmail() || "").trim().toLowerCase();
  } catch (err) {
    return "";
  }
}

function requireOwner() {
  // With "Execute as: Me", the effective user is the owner; the active user is whoever opened the app.
  const active = normalizedEmail(Session.getActiveUser());
  const owner = normalizedEmail(Session.getEffectiveUser());
  if (!active || !owner || active !== owner) throw new Error("Access denied.");
  return owner;
}

function getDataSpreadsheet(ownerId) {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(DATA_SPREADSHEET_PROPERTY);
  const spreadsheet = existingId ? SpreadsheetApp.openById(existingId) : SpreadsheetApp.create(DATA_SPREADSHEET_NAME);
  const ownerSheet = earningsSheet(spreadsheet, EARNINGS_OWNER_SHEET, EARNINGS_OWNER_COLUMNS);
  const owners = earningsReadRows(ownerSheet, EARNINGS_OWNER_COLUMNS).filter(record => record.ownerId);
  if (!owners.length) {
    earningsWriteRow(ownerSheet, 2, [ownerId, new Date().toISOString()]);
  } else if (owners[0].ownerId !== ownerId) {
    throw new Error("Access denied.");
  }
  if (!existingId) {
    earningsSheet(spreadsheet, EARNINGS_SHIFT_SHEET, EARNINGS_SHIFT_COLUMNS);
    earningsSchedules(spreadsheet);
    earningsPaychecks(spreadsheet);
    const unused = spreadsheet.getSheetByName("Sheet1");
    if (unused && spreadsheet.getSheets().length > 1) spreadsheet.deleteSheet(unused);
    props.setProperty(DATA_SPREADSHEET_PROPERTY, spreadsheet.getId());
  }
  return spreadsheet;
}

function withOwnerData(callback) {
  const ownerId = requireOwner();
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return callback(getDataSpreadsheet(ownerId));
  } finally {
    lock.releaseLock();
  }
}

function todayBusinessDate(now) {
  const time = now || new Date();
  const timeZone = Session.getScriptTimeZone();
  const hour = Number(Utilities.formatDate(time, timeZone, "H"));
  const businessTime = hour < BUSINESS_DAY_ROLLOVER_HOUR ? new Date(time.getTime() - 4 * 3600000) : time;
  return Utilities.formatDate(businessTime, timeZone, "yyyy-MM-dd");
}

function parseCents(value, label, options) {
  const allowNegative = Boolean(options && options.allowNegative);
  const text = String(value === null || value === undefined ? "" : value).replace(/[$,\s]/g, "");
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match || (match[1] && !allowNegative)) {
    throw new Error(`${label} must be ${allowNegative ? "an" : "a nonnegative"} amount with up to two decimal places.`);
  }
  const cents = Number(match[2]) * 100 + Number((match[3] || "0").padEnd(2, "0"));
  if (cents > MAX_AMOUNT_CENTS) throw new Error(`${label} is too large.`);
  return match[1] ? -cents : cents;
}

function parseOptionalCents(value, label, options) {
  return String(value === null || value === undefined ? "" : value).trim() === "" ? null : parseCents(value, label, options);
}

function computeShiftAmounts(input) {
  const wageCents = Math.round(input.hours * input.hourlyWageCents);
  const guaranteeCents = input.eventType === "wedding" ? input.guaranteeCents : 0;
  const grossCents = wageCents + input.cashTipsCents + input.creditTipsCents + guaranteeCents;
  const taxCents = Math.round(grossCents * input.withholdingRate);
  const netCents = grossCents - taxCents;
  return {
    wageCents, guaranteeCents, grossCents, taxCents, netCents,
    cashReceivedCents: input.cashTipsCents,
    depositCents: netCents - input.cashTipsCents
  };
}

function summarizeShifts(shifts) {
  const totals = { hours: 0 };
  ["wageCents", "cashTipsCents", "creditTipsCents", "guaranteeCents", "grossCents", "taxCents",
    "netCents", "depositCents"].forEach(field => {
    totals[field] = shifts.reduce((sum, shift) => sum + shift[field], 0);
  });
  totals.hours = Math.round(shifts.reduce((sum, shift) => sum + shift.hours, 0) * 100) / 100;
  return totals;
}

function toPaycheck(record) {
  const number = value => value === "" || value === undefined ? null : Number(value);
  return {
    status: record && PAYCHECK_STATUSES.includes(record.status) ? record.status : "awaiting",
    actualGrossCents: record ? number(record.actualGrossCents) : null,
    actualTaxesCents: record ? number(record.actualTaxesCents) : null,
    actualDepositCents: record ? number(record.actualDepositCents) : null,
    adjustmentsCents: record ? number(record.adjustmentsCents) : null,
    notes: record ? record.notes : ""
  };
}

function buildDashboard(spreadsheet, today) {
  const schedules = earningsSchedules(spreadsheet);
  const shifts = earningsReadRows(earningsSheet(spreadsheet, EARNINGS_SHIFT_SHEET, EARNINGS_SHIFT_COLUMNS),
    EARNINGS_SHIFT_COLUMNS).filter(record => record.id).map(earningsShiftFromRecord);
  const paychecks = earningsPaychecks(spreadsheet);
  const periods = new Map();
  const addPeriod = start => {
    if (!periods.has(start)) periods.set(start, { start, end: earningsPayPeriod(schedules, start).end, shifts: [] });
    return periods.get(start);
  };
  const current = earningsPayPeriod(schedules, today);
  addPeriod(current.start);
  shifts.forEach(shift => addPeriod(shift.payPeriodStart).shifts.push(shift));
  paychecks.forEach(record => addPeriod(record.periodStart));

  const list = [...periods.values()].sort((a, b) => b.start.localeCompare(a.start)).map(period => {
    period.shifts.sort((a, b) => a.shiftDate.localeCompare(b.shiftDate) || a.createdAt.localeCompare(b.createdAt));
    period.shifts.forEach(shift => { delete shift.row; delete shift.idempotencyKey; });
    const totals = summarizeShifts(period.shifts);
    const paycheck = toPaycheck(paychecks.find(record => record.periodStart === period.start));
    paycheck.depositDifferenceCents = paycheck.actualDepositCents === null
      ? null : paycheck.actualDepositCents - totals.depositCents;
    paycheck.grossDifferenceCents = paycheck.actualGrossCents === null
      ? null : paycheck.actualGrossCents - totals.grossCents;
    return { ...period, totals, paycheck, isCurrent: period.start === current.start };
  });
  return { today, currentPeriodStart: current.start, periods: list, schedules };
}

function getEarningsData() {
  return withOwnerData(spreadsheet => buildDashboard(spreadsheet, todayBusinessDate()));
}

function findShift(spreadsheet, id) {
  const sheet = earningsSheet(spreadsheet, EARNINGS_SHIFT_SHEET, EARNINGS_SHIFT_COLUMNS);
  const record = earningsReadRows(sheet, EARNINGS_SHIFT_COLUMNS).find(item => item.id && item.id === String(id || ""));
  if (!record) throw new Error("That shift no longer exists. Refresh and try again.");
  return { sheet, shift: earningsShiftFromRecord(record) };
}

function requireUnlockedPeriod(spreadsheet, periodStart) {
  if (earningsIsVerifiedPeriod(spreadsheet, periodStart)) {
    throw new Error("That pay period is marked Verified. Change its paycheck status before changing its shifts.");
  }
}

function updateShift(id, input) {
  return withOwnerData(spreadsheet => {
    const { sheet, shift } = findShift(spreadsheet, id);
    requireUnlockedPeriod(spreadsheet, shift.payPeriodStart);
    const data = input || {};
    const shiftDate = String(data.shiftDate || "").trim();
    if (earningsDayNumber(shiftDate) === null) throw new Error("Enter a valid date.");
    const venue = String(data.venue || "").trim().slice(0, 60);
    if (!venue) throw new Error("Enter a venue.");
    const eventType = data.eventType === "wedding" ? "wedding" : "non-wedding";
    const hours = Number(data.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error("Hours must be greater than 0 and no more than 24.");
    const period = earningsPayPeriod(earningsSchedules(spreadsheet), shiftDate);
    requireUnlockedPeriod(spreadsheet, period.start);
    const cashTipsCents = parseCents(data.cashTips, "Cash tips");
    const creditTipsCents = parseCents(data.creditTips, "Credit tips");
    const amounts = computeShiftAmounts({
      hours, eventType, cashTipsCents, creditTipsCents,
      guaranteeCents: eventType === "wedding" ? parseCents(data.guarantee, "Wedding guarantee") : 0,
      hourlyWageCents: shift.hourlyWageCents, withholdingRate: shift.withholdingRate
    });
    const updated = {
      ...shift, ...amounts, shiftDate, venue, eventType, hours,
      role: String(data.role || shift.role).trim().slice(0, 60),
      cashTipsCents, creditTipsCents,
      payPeriodStart: period.start, payPeriodEnd: period.end,
      source: "edited", updatedAt: new Date().toISOString()
    };
    earningsWriteRow(sheet, shift.row, earningsShiftRow(updated));
    return buildDashboard(spreadsheet, todayBusinessDate());
  });
}

function deleteShift(id) {
  return withOwnerData(spreadsheet => {
    const { sheet, shift } = findShift(spreadsheet, id);
    requireUnlockedPeriod(spreadsheet, shift.payPeriodStart);
    sheet.deleteRow(shift.row);
    return buildDashboard(spreadsheet, todayBusinessDate());
  });
}

function savePaycheck(input) {
  return withOwnerData(spreadsheet => {
    const data = input || {};
    const periodStart = String(data.periodStart || "");
    const schedules = earningsSchedules(spreadsheet);
    if (earningsDayNumber(periodStart) === null || earningsPayPeriod(schedules, periodStart).start !== periodStart) {
      throw new Error("Choose a valid pay period.");
    }
    const status = PAYCHECK_STATUSES.includes(data.status) ? data.status : "awaiting";
    const values = [
      periodStart,
      earningsPayPeriod(schedules, periodStart).end,
      status,
      parseOptionalCents(data.actualGross, "Actual gross pay"),
      parseOptionalCents(data.actualTaxes, "Actual taxes withheld"),
      parseOptionalCents(data.actualDeposit, "Actual paycheck deposit"),
      parseOptionalCents(data.adjustments, "Other deductions or adjustments", { allowNegative: true }),
      String(data.notes || "").trim().slice(0, 500),
      new Date().toISOString()
    ];
    const sheet = earningsSheet(spreadsheet, EARNINGS_PAYCHECK_SHEET, EARNINGS_PAYCHECK_COLUMNS);
    const existing = earningsReadRows(sheet, EARNINGS_PAYCHECK_COLUMNS).find(record => record.periodStart === periodStart);
    earningsWriteRow(sheet, existing ? existing.row : sheet.getLastRow() + 1, values);
    return buildDashboard(spreadsheet, todayBusinessDate());
  });
}

function addPaySchedule(input) {
  return withOwnerData(spreadsheet => {
    const data = input || {};
    const startDate = String(data.startDate || "").trim();
    const periodDays = Number(data.periodDays);
    if (earningsDayNumber(startDate) === null) throw new Error("Enter the first day of a pay period.");
    if (!Number.isInteger(periodDays) || periodDays < 7 || periodDays > 31) throw new Error("Pay periods must be 7 to 31 days long.");
    const schedules = earningsSchedules(spreadsheet);
    if (startDate <= schedules[schedules.length - 1].startDate) {
      throw new Error("A new schedule must start after the current schedule's start date.");
    }
    const lockedThrough = earningsPaychecks(spreadsheet)
      .filter(record => record.status === "verified")
      .reduce((latest, record) => record.periodEnd > latest ? record.periodEnd : latest, "");
    if (lockedThrough && startDate <= lockedThrough) {
      throw new Error(`Verified pay periods run through ${lockedThrough}. Start the new schedule after that date.`);
    }
    const scheduleSheet = earningsSheet(spreadsheet, EARNINGS_SCHEDULE_SHEET, EARNINGS_SCHEDULE_COLUMNS);
    earningsWriteRow(scheduleSheet, scheduleSheet.getLastRow() + 1, [startDate, periodDays, new Date().toISOString()]);
    const updatedSchedules = earningsSchedules(spreadsheet);
    // Shifts whose recorded period reaches the new start date are regrouped; earlier periods are untouched.
    const sheet = earningsSheet(spreadsheet, EARNINGS_SHIFT_SHEET, EARNINGS_SHIFT_COLUMNS);
    let moved = 0;
    earningsReadRows(sheet, EARNINGS_SHIFT_COLUMNS).filter(record => record.id).forEach(record => {
      if (record.shiftDate < startDate && record.payPeriodEnd < startDate) return;
      const shift = earningsShiftFromRecord(record);
      const period = earningsPayPeriod(updatedSchedules, shift.shiftDate);
      if (period.start === shift.payPeriodStart && period.end === shift.payPeriodEnd) return;
      earningsWriteRow(sheet, shift.row, earningsShiftRow({
        ...shift, payPeriodStart: period.start, payPeriodEnd: period.end, updatedAt: new Date().toISOString()
      }));
      moved++;
    });
    const paycheckSheet = earningsSheet(spreadsheet, EARNINGS_PAYCHECK_SHEET, EARNINGS_PAYCHECK_COLUMNS);
    earningsReadRows(paycheckSheet, EARNINGS_PAYCHECK_COLUMNS).forEach(record => {
      if (!record.periodStart || record.periodEnd < startDate) return;
      const period = earningsPayPeriod(updatedSchedules, record.periodStart);
      if (period.start !== record.periodStart || period.end === record.periodEnd) return;
      earningsWriteRow(paycheckSheet, record.row, EARNINGS_PAYCHECK_COLUMNS.map(column =>
        column === "periodEnd" ? period.end : record[column]));
    });
    return { ...buildDashboard(spreadsheet, todayBusinessDate()), moved };
  });
}
