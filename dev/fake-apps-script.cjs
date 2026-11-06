// In-memory stand-ins for the Apps Script services used by Will's Earnings and the TwoBirds backend.
// Used by tests and the local preview server; nothing here is a production data store.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows;
  }
  getName() { return this.name; }
  setName(name) { this.name = name; return this; }
  getLastRow() { return this.rows.length; }
  setFrozenRows() { return this; }
  deleteRow(row) { this.rows.splice(row - 1, 1); }
  getRange(row, column, numRows, numColumns) {
    const sheet = this;
    return {
      setNumberFormat() { return this; },
      setValues(values) {
        values.forEach((rowValues, rowOffset) => {
          while (sheet.rows.length < row + rowOffset) sheet.rows.push([]);
          rowValues.forEach((value, columnOffset) => {
            sheet.rows[row + rowOffset - 1][column + columnOffset - 1] = value;
          });
        });
        return this;
      },
      getValues() {
        return Array.from({ length: numRows }, (_, rowOffset) =>
          Array.from({ length: numColumns }, (__, columnOffset) => {
            const value = (sheet.rows[row + rowOffset - 1] || [])[column + columnOffset - 1];
            return value === undefined ? "" : value;
          })
        );
      }
    };
  }
}

class FakeSpreadsheet {
  constructor(name, id, sheets) {
    this.name = name;
    this.id = id;
    this.sheets = sheets || [new FakeSheet("Sheet1")];
  }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(sheet => sheet.name === name) || null; }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }
  deleteSheet(sheet) { this.sheets = this.sheets.filter(item => item !== sheet); }
  toJSON() { return { name: this.name, id: this.id, sheets: this.sheets.map(sheet => ({ name: sheet.name, rows: sheet.rows })) }; }
  static fromJSON(data) {
    return new FakeSpreadsheet(data.name, data.id, data.sheets.map(sheet => new FakeSheet(sheet.name, sheet.rows)));
  }
}

function formatDate(date, timeZone, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map(part => [part.type, part.value]));
  if (pattern === "H") return String(Number(parts.hour));
  if (pattern === "yyyy-MM-dd") return `${parts.year}-${parts.month}-${parts.day}`;
  throw new Error(`Unsupported date pattern ${pattern}`);
}

function createServices({ properties = new Map(), spreadsheets = [], activeEmail = "", effectiveEmail = "", timeZone = "America/Chicago", now } = {}) {
  let uuid = 0;
  const RealDate = Date;
  const FixedDate = now ? class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  } : RealDate;
  return {
    properties,
    spreadsheets,
    globals: {
      Date: FixedDate,
      ContentService: {
        MimeType: { JSON: "json" },
        createTextOutput: text => ({ text, setMimeType() { return this; } })
      },
      HtmlService: {
        createHtmlOutput: html => ({ html, setTitle() { return this; }, addMetaTag() { return this; } }),
        createHtmlOutputFromFile: file => ({ file, setTitle() { return this; }, addMetaTag() { return this; } })
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: key => properties.has(key) ? properties.get(key) : null,
          setProperty: (key, value) => properties.set(key, String(value)),
          deleteProperty: key => properties.delete(key),
          getProperties: () => Object.fromEntries(properties)
        })
      },
      SpreadsheetApp: {
        create: name => {
          const spreadsheet = new FakeSpreadsheet(name, `sheet-${crypto.randomUUID()}`);
          spreadsheets.push(spreadsheet);
          return spreadsheet;
        },
        openById: id => {
          const spreadsheet = spreadsheets.find(item => item.id === id);
          if (!spreadsheet) throw new Error(`Spreadsheet not found: ${id}`);
          return spreadsheet;
        }
      },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Session: {
        getActiveUser: () => ({ getEmail: () => activeEmail }),
        getEffectiveUser: () => ({ getEmail: () => effectiveEmail }),
        getScriptTimeZone: () => timeZone
      },
      Utilities: {
        getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
        formatDate,
        DigestAlgorithm: { SHA_256: "sha256" },
        computeDigest: (_, value) => [...crypto.createHash("sha256").update(value).digest()],
        base64EncodeWebSafe: bytes => Buffer.from(bytes).toString("base64url")
      }
    }
  };
}

function loadScript(file, options = {}) {
  const services = createServices(options);
  const context = vm.createContext({ ...services.globals });
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { context, ...services };
}

const EARNINGS_CODE = path.join(__dirname, "..", "src", "Code.gs");

function loadEarningsApp(options = {}) {
  return loadScript(EARNINGS_CODE, options);
}

module.exports = { FakeSheet, FakeSpreadsheet, createServices, loadScript, loadEarningsApp, EARNINGS_CODE };
