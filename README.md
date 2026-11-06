# Will's Earnings

A private earnings tracker for Will Schreiner, connected to
[TwoBirds Tipout](https://github.com/willschreinerjr-cmd/twobirds-tipout). After a
shift, **Save My Shift** in the calculator records that shift here. This site
groups shifts into biweekly pay periods and helps verify paychecks.

## How it works

- **Hosting and login:** a Google Apps Script web app deployed with
  **Execute as: Me** and **Who has access: Only myself**. Google requires the
  owner's own Google sign-in before the page loads, and every server function
  re-checks that the visitor is the deploying account (`requireOwner`). No
  passwords, API keys, or secrets exist in this code.
- **Data:** a private Google Sheet, *Will's Earnings - Private Data*, created in
  the owner's Drive on first use (tabs: Owner, Shifts, PaySchedule, Paychecks).
  Money is stored as whole cents in plain-text cells. Nothing is stored in the
  browser.
- **Saving shifts:** TwoBirds Tipout's backend verifies the owner's PIN session,
  recalculates the shift from the event inputs with the private wage and
  withholding profile, and writes it here. Browser-supplied totals are never
  trusted, and an idempotency key prevents duplicate shifts on retries. Several
  shifts on the same day are allowed. If this site is unavailable, the calculator
  keeps working and the save can be retried.
- **Calculations per shift:** Before tax = hourly wages + cash tips + credit tips
  + wedding guarantee (weddings only). After tax = before tax − estimated tax.
  Estimated paycheck deposit = after tax − cash tips already received. Saved
  values are kept as recorded; edits reuse the shift's original wage and
  withholding rate.
- **Pay periods:** 14 days from Monday, Oct 12, 2026 (Oct 12–25, Oct 26–Nov 8, …).
  Each shift stores its pay period when saved. A schedule change (under **Pay
  schedule**) applies only from its start date forward and cannot start inside
  or before a Verified pay period.
- **Paycheck verification:** optional actual gross, taxes withheld, deposit, and
  other adjustments, with status Awaiting Paycheck, Verified, or Needs Review.
  Verified periods are locked against shift changes until the status changes.

The storage code between `BEGIN/END SHARED EARNINGS STORAGE` is duplicated in
TwoBirds Tipout's `google-apps-script.gs`; the integration tests require both
copies to stay identical.

## Deploying

1. Create an Apps Script project and copy in `src/Code.gs`, `src/Index.html`, and
   `src/appsscript.json` (enable "Show appsscript.json" in Project Settings).
2. **Deploy → New deployment → Web app** with *Execute as: Me* and *Who has
   access: Only myself*. Approve the authorization prompt.
3. Open the web app once; it creates the private data sheet and stores its ID
   in Script Property `WILLS_EARNINGS_SPREADSHEET_ID`.
4. In the TwoBirds Tipout Apps Script project, set Script Properties
   `WILLS_EARNINGS_SPREADSHEET_ID` (same value) and `WILLS_EARNINGS_URL` (the web
   app URL), then deploy a new version of the calculator backend.

## Local development and tests

Requires Node.js 22+. Browser tests use an installed Chrome or Edge (or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`).

```text
npm install
npm test
npm run dev   # local preview at http://127.0.0.1:8787/
```

`npm run dev` runs the real `Code.gs` against in-memory stand-ins for Apps
Script and keeps local test data in `.data/` (ignored by git). It is for
development only and is not a production data store. The integration tests also
load `../twobirds-tipout/google-apps-script.gs` (override with
`TWOBIRDS_TIPOUT_DIR`) and are skipped if it is not present.
