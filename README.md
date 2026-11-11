# My Earnings

A private earnings tracker for use with
[TwoBirds Tipout](https://github.com/willschreinerjr-cmd/twobirds-tipout).
Each manager creates and owns their own Google Apps Script project and private
spreadsheet; the calculator operator does not need access to those projects.
Will's existing direct-save connection is unchanged.

## Setting up your own private tracker

Each manager must do this using **their own Google account**. Do not copy Will's
project, share a spreadsheet, or reuse his spreadsheet ID.

1. Sign in to your Google account and create a **new, blank** project at
   [Google Apps Script](https://script.google.com/).
2. Replace the project's `Code.gs` with the contents of
   [`src/Code.gs`](src/Code.gs). Add an HTML file named `Index` and copy in
   [`src/Index.html`](src/Index.html).
3. In Project Settings, enable **Show "appsscript.json" manifest file in editor**.
   Replace the manifest with [`src/appsscript.json`](src/appsscript.json).
   Save the project.
4. Choose **Deploy → New deployment → Web app**. Choose **Execute as: Me**
   and **Who has access: Only myself**. Never select broader access. Authorize
   the requested spreadsheet and identity permissions as your own account.
5. Open the deployed web app while signed in as the same account. On first
   use, it creates your own private spreadsheet. In **My hourly pay rates**,
   enter your bartender and shift manager rates and save them.
6. Sign in to TwoBirds Tipout with your manager PIN. On the venue selection
   page, choose **Set Up My Private Earnings**, paste your own deployed web app
   URL ending in `/exec`, and save it. The link is stored in this browser, so
   repeat this step on other devices or after clearing browser storage.

Google's deployment and owner checks protect the tracker, not the manager PIN
or the URL. Keep your Google account secure and do not share access to the
project or spreadsheet. The setup may require Google to show an authorization
warning for an individually created app; review the requested permissions
before approving. No one can create or authorize this project on your behalf.

## Saving a shift

In the calculator, add your own name and hours, select the event details and
venue, and choose **Save My Shift**. Your private tracker opens with the shift
ready to review and confirm. The shift contains your role, hours and allocated
tips, but no coworkers' names or hourly rates; it is not sent to the shared
calculator backend. If the tracker does not open, allow pop-ups and retry.
Existing independently deployed trackers must be updated to the latest code
and redeployed before they can receive a shift this way.

The tracker uses the saved rate for each role and the existing 20.7482% tax
estimate. Updating rates only affects later imports; saved shifts and edits keep
their original rates. A shift with multiple role entries is stored as separate
rows, with wages and estimated tax rounded per row. Repeating an identical
transfer is rejected; edit an existing row if you need to correct it.
The shift is temporarily included in the tracker URL fragment in the browser,
then cleared when the tracker reads it. It may be visible on a shared device
or in browser history or synchronization, so use a trusted device.

## How it works

- **Hosting and login:** a Google Apps Script web app deployed with
  **Execute as: Me** and **Who has access: Only myself**. Google requires the
  owner's own Google sign-in before the page loads, and every server function
  re-checks that the visitor is the deploying account (`requireOwner`). No
  passwords, API keys, or secrets exist in this code.
- **Data:** a private Google Sheet created in the owner's Drive on first use
  (tabs: Owner, Shifts, PaySchedule), and rates in the project's script properties. Existing
  `Paychecks` tabs are left untouched and ignored.
  Money is stored as whole cents in plain-text cells. Nothing is stored in the
  browser.
- **Saving shifts:** Individual projects accept the owner-confirmed transfer
  described above. Tips are copied from the calculator; the private tracker
  calculates wages and tax. Will's existing direct-save backend continues to
  recalculate his event using his existing profile. The calculator stays usable
  if a tracker is unavailable.
- **Calculations per shift:** Before tax = hourly wages + cash tips + credit tips
  + wedding guarantee (weddings only). After tax = before tax − estimated tax.
  Estimated payroll deposit = after tax − cash tips already received. This is
  an estimate only; the app does not collect paycheck details or verify pay.
  Saved values are kept as recorded; edits reuse the shift's original wage and
  withholding rate.
- **Pay periods:** 14 days, Monday through Sunday, matching the payroll stubs: Oct 19–Nov 1 (paid Fri Nov 6), Nov 2–15 (paid Fri Nov 20), …
  Each shift stores its pay period when saved. A schedule change (under **Pay
  schedule**) applies only from its start date forward. Shift edits and deletes
  remain available regardless of pay period.

The storage code between `BEGIN/END SHARED EARNINGS STORAGE` is duplicated in
TwoBirds Tipout's `google-apps-script.gs`; the integration tests require both
copies to stay identical.

## Existing Will-only direct-save connection

To maintain Will's existing direct-save deployment (not other managers' projects):

1. Create an Apps Script project and copy in `src/Code.gs`, `src/Index.html`, and
   `src/appsscript.json` (enable "Show appsscript.json" in Project Settings).
2. **Deploy → New deployment → Web app** with *Execute as: Me* and *Who has
   access: Only myself*. Approve the authorization prompt.
   For later updates, edit the deployment and select **New version** before
   deploying.
3. Open the web app once; it creates the private data sheet and stores its ID
   in Script Property `WILLS_EARNINGS_SPREADSHEET_ID`.
4. In the TwoBirds Tipout Apps Script project, set Script Properties
   `WILLS_EARNINGS_SPREADSHEET_ID` (same value) and `WILLS_EARNINGS_URL` (the web
   app URL), then deploy a new version of the calculator backend.

Do not configure the shared calculator backend with any other manager's
spreadsheet ID. Other managers use the private transfer flow instead.

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
