// Local preview of Will's Earnings. Data is kept in .data/local-dev.json for development only;
// the real app stores everything in a private Google Sheet through Apps Script.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { FakeSpreadsheet, loadEarningsApp } = require("./fake-apps-script.cjs");

const root = path.join(__dirname, "..");
const dataFile = path.join(root, ".data", "local-dev.json");
const OWNER = "owner@local.test";

function createDevApp({ persist = true, activeEmail = OWNER, store, now } = {}) {
  const state = store || (persist && fs.existsSync(dataFile)
    ? JSON.parse(fs.readFileSync(dataFile, "utf8"))
    : { properties: {}, spreadsheets: [] });
  const properties = new Map(Object.entries(state.properties));
  const spreadsheets = state.spreadsheets.map(FakeSpreadsheet.fromJSON);
  const app = loadEarningsApp({ properties, spreadsheets, activeEmail, effectiveEmail: OWNER, now });
  const save = () => {
    state.properties = Object.fromEntries(properties);
    state.spreadsheets = spreadsheets.map(sheet => sheet.toJSON());
    if (persist) {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      fs.writeFileSync(dataFile, JSON.stringify(state, null, 2));
    }
  };
  return { app, properties, spreadsheets, save, state };
}

const SHIM = `<script>
window.google = { script: { run: (function make(success, failure) {
  return new Proxy({}, { get(_, name) {
    if (name === "withSuccessHandler") return fn => make(fn, failure);
    if (name === "withFailureHandler") return fn => make(success, fn);
    return (...args) => fetch("/api/" + name, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) })
      .then(response => response.json())
      .then(body => body.ok ? success && success(body.result) : failure && failure(new Error(body.error)))
      .catch(error => failure && failure(error));
  } });
})() } };
</script>`;

const API = ["getEarningsData", "updateShift", "deleteShift", "savePaycheck", "addPaySchedule"];

function createServer(options = {}) {
  const dev = createDevApp(options);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "POST" && url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5);
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        let result;
        try {
          if (!API.includes(name)) throw new Error("Unsupported action.");
          result = { ok: true, result: JSON.parse(JSON.stringify(dev.app.context[name](...JSON.parse(body || "[]")))) };
          dev.save();
        } catch (error) {
          result = { ok: false, error: error.message };
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(result));
      });
      return;
    }
    if (url.pathname === "/") {
      try {
        dev.app.context.requireOwner();
      } catch {
        response.writeHead(403).end("Access denied.");
        return;
      }
      const html = fs.readFileSync(path.join(root, "src", "Index.html"), "utf8").replace("<head>", `<head>${SHIM}`);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(html);
      return;
    }
    response.writeHead(404).end();
  });
  return { server, dev };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  createServer().server.listen(port, "127.0.0.1", () => {
    console.log(`Will's Earnings local preview: http://127.0.0.1:${port}/ (local development data only)`);
  });
}

module.exports = { createServer, createDevApp, OWNER };
