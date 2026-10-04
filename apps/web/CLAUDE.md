# apps/web — the dashboard

The manager's browser app: **Vite + React + TypeScript**, Firebase JS SDK,
talking to the same `newoldworld-b8f5d` project the phones do. Everything the
dashboard reads from `/runs` is **read-only by rule** — the phone is the author
of every record, the server is the reader.

Pages live in `src/pages/`, shared pieces in `src/components/`, queries and
arithmetic in `src/lib/`. There is **no self-serve sign-up**: dashboard accounts
are created on the Team page (below), and the shared `users/{uid}` role model
that separates them from driver accounts is in the root `CLAUDE.md`.

The phone is documented in `apps/mobile/CLAUDE.md`; the backend, rules,
emulators and deploys in `firebase/CLAUDE.md`.

Run: `cd apps/web && npm install && npm run dev` (emulators) or
`npm run dev:cloud` (the real `newoldworld-b8f5d` project). Lint: `npm run lint`
(oxlint). Build: `npm run build`.

## Which backend the dashboard talks to

`src/lib/firebase.ts`, the browser's counterpart to the mobile file of the same
name and switched the same way: `usingEmulators = import.meta.env.DEV &&
import.meta.env.VITE_USE_EMULATOR !== 'false'`. `import.meta.env.DEV` is false in
any `vite build`, so **a built dashboard can never point at localhost**, whatever
the env holds — the same guard `__DEV__` gives the phone. `npm run dev:cloud`
runs Vite in the `cloud` mode, which loads `.env.cloud` and sets
`VITE_USE_EMULATOR=false`.

Cloud config is `VITE_FIREBASE_*` in `apps/web/.env`, committed on purpose for
the same reason mobile's is: it identifies the project, it doesn't grant access.
The emulator config is a set of deliberate fakes, and its `projectId` and
`storageBucket` **must match the mobile app's `emulatorConfig` and the
`--project` flag in `firebase/package.json`**, or the two clients read different
emulator projects and neither can see the other's data.

**Every Firebase service is switched together** — auth, Firestore, functions and
storage. Adding a service means wiring its emulator connection in that same
block, or it silently reads production while the rest is local. The startup log
line says which backend is live.

## The Overview tab

The dashboard's operations surface, and the only part of the dashboard with its
own visual style. Three sub-tabs on one page (`pages/overview.tsx` is just the
shell and the tab strip):

- **Live** (`components/live-board.tsx`) — one business day as it happens:
  one list of the day's runs (agents, truck, hours, money). Opens
  `components/run-panel.tsx` for one run.
- **Trends** (`components/trends-tab.tsx`) — a period's takings by day and by
  truck, plus bread and store statistics.
- **Stores** (`components/stores-tab.tsx`) — the customer directory, and one
  store's whole receipt history across every truck and every day.

**The receipt card's proof-of-payment section copies the phone's, deliberately.**
A link showing the file name, opening a centred modal with the image — not a
thumbnail, because this card exists to be the same object the agent is holding.
The file name is the last segment of `proofStoragePath`, which really is the
same string the phone shows (both are `${receiptId}.jpg`). The download URL is
resolved when the modal opens, not when the receipt does, so a reader who never
clicks costs no request. The modal is **portalled to `document.body`**:
`.ops-receipt` uses `transform` to centre itself, and a transformed element
becomes the containing block for `position: fixed` children, so rendered in
place it would be centred inside the receipt card instead of over the page.
That is also why `.ops-proof-card` redeclares the `--rc-*` tokens it needs.

Supporting files: `lib/runs.ts` (read-only queries + the arithmetic),
`lib/customers.ts`, `lib/business-day.ts`, `lib/day-ranges.ts` (calendar ranges
over business days — what "this week" means, shared by Trends and the summary
export), `lib/bread-detail.ts` (one bread type cut by truck and store —
what a row of the Trends bread chart opens into), `components/charts.tsx` (the
chart kit), `pages/overview.css`.

Two workbooks come off this tab, and they share their look and their sums:
`lib/export-run-excel.ts` (one run, from the run panel) and
`lib/export-period-excel.ts` + `lib/period-summary.ts` (a range of days, from
the Live tab's day bar). `lib/excel-style.ts` is the house style both draw with.

**Sub-tabs, not sidebar entries.** The sidebar lists what a manager goes to *set
up*; these three are one thing at three distances. The tab strip is a sibling of
the scrolling `.ops-view`, so it stays put while the view scrolls.

**All three tabs stay mounted**, hidden with `display: none` rather than
unmounted, so switching between them doesn't throw away a picked date range, a
selected run or a search — only a reload resets that. The cost is that Live's
listeners (two per run, plus the catalogs) keep running while Trends or Stores
is showing. That is accepted, not an oversight: there are three tabs, so it is
bounded. Each tab still watches its *own* copy of the catalogs rather than
taking them as props, which is a separate decision about keeping them
independent.

### Rules that hold across the whole surface

- **It has its own style and does not share the rest of the dashboard's.**
  Everything in `overview.css` is scoped under `.ops` — ink-and-navy, hairline
  rules, tabular figures — because this is a board someone leaves open, not a
  form. The other pages were left on the old flat purple style on purpose.
  Don't "unify" them without being asked.
- **Everything is read-only, and rules enforce it.** `firestore.rules` refuses
  every delete under `/runs` and refuses any write whose `createdByUid` isn't
  the signed-in account — which no dashboard account can satisfy. Stores are
  writable by rule but deliberately not written here: every phone edits them
  under a last-write-wins merge, and the phone with the shop in front of it is
  the better authority.
- **A day is matched on the `businessDay` string the phone stored, never
  re-derived from a timestamp.** `lib/business-day.ts` (a copy of mobile's, kept
  separate because `packages/shared` is still empty) only decides *which* day to
  ask for and how to label it. A browser in another timezone would otherwise
  file a 6:30 AM Manila receipt under the previous day.
- **A receipt's agents are the names the receipt itself carries**, not what
  its `agentIds` resolve to today. The phone stamps `agentNames` at finalize
  and prints it on the customer's copy (see "Receipts" in
  `apps/mobile/CLAUDE.md`), so preferring it is what keeps the server
  describing the same piece of paper the store is holding. A receipt printed
  while crews existed carries the crew's name (`agentGroupName`) instead, and
  `readReceipt` in `lib/runs.ts` reads that in as the fallback — it is what that
  paper says.
  Shown in the run panel's feed, the store history's feed, and — under the
  payment block, where the phone and the paper both put it — in the receipt
  card. That card is **one component, `components/receipt-detail-panel.tsx`,
  serving both places**; there is no second copy to keep in step.

  A receipt finalized before either was recorded has no name, and each list
  falls back differently, on purpose. The run panel uses the **run header's own
  `agents` snapshot** — every receipt in it belongs to that one run. The store
  history spans months and every truck, so it resolves `agentIds` against the
  Agents list (`agentsLabel` in `stores-tab.tsx`). Both hand the *same* resolved
  label to the receipt card, which is why it takes an `agentsLabel` resolver
  rather than reading the field itself — a row and the receipt it opens must
  never name two different sets of people. With nothing to say the line is
  omitted, never rendered blank.

- **A voided receipt is listed everywhere and counted nowhere.** The phone can
  void a finalized receipt during its own run (see "Receipts" in
  `apps/mobile/CLAUDE.md`) and re-uploads it carrying `voidedAt`. Every feed
  and the receipt card still show it — struck-through amount, red **Void** tag
  in the payment tag's slot (`ReceiptTag`), red border and banner on the card —
  but its money, store, receipt count and returns reach no total. The skip
  lives in the arithmetic itself (`totalReceipts`, `receiptCollected`,
  `totalCollected`, `buildOutcomeRows`) plus every hand-written fold (the run
  panel's Collected tab, the store history, the Trends bread chart,
  `period-summary.ts`), so a new screen that reuses those functions gets it for
  free and a new fold has to remember it. **Its loaves need no skipping:** the
  phone writes a `'void'` stock entry, and `totalStock` takes it off *sold*
  (not onto *loaded*), so loaded − sold = remaining still holds. Deploy the
  dashboard before a phone build that can void ships — an older
  `readStockEntry` reads an unknown kind as an addition.

### Live

- **The day is chosen with ‹ Today › plus a calendar** — `components/date-picker.tsx`,
  the same month grid as the Trends tab's range picker, limited to one day.
  Both are built on `components/calendar-popover.tsx`, which owns the popover,
  where on screen it goes, month navigation and every way of closing it; each
  picker supplies only what a day-click means and which days light up. The
  single-day one **has no Apply row** — one day is a value the moment it is
  clicked, so it commits and closes, where a range is still being composed and
  needs a deliberate Apply. (The range picker does now accept a *single* day —
  Apply lights up on the first click, the end falling back to the start — but
  it still can't commit on that click, because the next one might be making it
  a span.)
  - **The popover is portalled to the `.ops` root**, the same fix and the same
    reason as the proof-of-payment modal: it is `position: fixed`, and a
    `transform` on any ancestor makes "fixed" mean *that ancestor* instead of
    the viewport. The summary-export dialog centres itself with `translate()`
    and scrolls inside itself, so a calendar rendered in place there came out
    half a dialog off and clipped. `.ops` rather than `document.body` because
    every `--ops-*` colour is declared on `.ops` and custom properties inherit
    down the DOM a portal leaves — on the body it would have no background and
    no borders. Its z-index (26) is therefore read against the page's stack:
    above the dialog (25), below the export overlay (30).
  - Two consequences in the component: "outside click" has to test the popover
    as well as the trigger, since they are no longer nested, and Escape is
    caught in the capture phase and its propagation stopped, so a calendar open
    inside the dialog takes the key rather than the dialog closing out from
    under it.
  - `.ops-daynav` still styles its buttons as `.ops-daynav > button` plus the
    trigger by name. That was originally because the day cells were descendants
    of the day bar and a bare `.ops-daynav button` repainted all 31 of them; the
    portal has since moved them out, but the child selector is right regardless
    and there is no reason to loosen it.
- **The runs query is an equality filter with no `orderBy`, sorted in JS.** A
  day holds a handful of runs, and an `orderBy` on another field would need a
  composite index that doesn't exist — the emulator would invent it and
  production would reject the query.
- **Receipts and ledger entries are read per run, under `runs/{runId}/…`, not
  with a day-filtered collection-group query.** A receipt's own `businessDay`
  comes from when it was written, so a run crossing midnight would have its late
  receipts drop out of a day query. Reading them under the run's path makes
  membership a matter of where the document lives.
- **The board owns those listeners, and the run panel takes the rows as props.**
  The board already watches every run of the day; a panel that subscribed again
  would double the listeners for the same rows. When the set of runs changes the
  cached maps are **pruned, not cleared** — blanking every total to zero for a
  second reads as something having gone wrong.
- **Two things are surfaced at the top of the day** because nobody goes looking
  for them: refused records (`blockedUploadCount` — set aside, not lost, fixable
  from the phone's Settings), and one truck taken out by two different
  *accounts*. That second one is the anomaly `docs/sync-design.md` says the
  dashboard is responsible for spotting, because nothing server-side can tell
  "two agents aboard" from "wrong truck tapped". A second run by the *same*
  account is normal — the truck went back out, and the trip badge says so.
- **There is no claimed-vs-arrived comparison in the UI.** A manifest's own
  figures (`receiptCount`, `stockEntryCount`, etc.) are read straight off
  `run.manifest` where the page needs them — Trends, for instance — but nothing
  on the dashboard checks them against the documents that actually arrived, or
  flags a run as short. That check (a `checkManifest`/`checksClean` pair that
  used to live in `lib/runs.ts`, and the `run-panel.tsx` "Close-out check"
  section that showed it) was removed on the owner's call. Don't reintroduce it
  without asking.
- **A run is shown on its start day and nowhere else, and its end carries a
  date whenever those differ.** Runs may now span days (see "Sync" in
  `apps/mobile/CLAUDE.md`), so a bare "to 6:42 PM" under a Monday heading would
  silently claim a truck that
  came back on Wednesday finished on Monday evening. `describeRunEnd` adds the
  date only when it differs — putting it on every row would be noise on the
  ninety-nine that are exactly what they look like — and the row and panel both
  call it, so they can't drift into two phrasings. `formatDuration` grows a `d`
  unit for the same reason: "55h 12m" is a number the reader has to divide
  before it means anything.
- **The run panel's Outcome table joins the ledger to the returns on a
  *name*, and Bread Types is the reference both sides are measured against.**
  Sold and remaining come off the ledger keyed by `breadTypeId`; a return is a
  write-off carrying no `breadTypeId` at all (see "Returns are a write-off
  only" in `apps/mobile/CLAUDE.md`), only the name the phone snapshotted onto
  the receipt. `lib/run-outcome.ts` matches those names **word for word**: the
  same name is the same row, and anything spelled even slightly differently is
  a different bread with a row of its own. Deliberate — fuzzy matching would
  quietly fold two names a manager typed on purpose into one line and put
  somebody else's returns against this bread. A stray-space or wrong-case name
  shows up as its own row at the bottom, which is a visible, fixable thing;
  a silently merged figure is not.
  - **Ordering needs both catalogs, which is why the panel takes
    `returnedBreadTypes` as well.** Bread Types and Returned Bread Types are
    separate collections but share one `order` namespace — "Copy from Bread
    Types" on the reference-lists page reuses the source row's own `order`
    value verbatim — so a returned bread no current bread type is named after
    sorts *directly below* the bread type holding its position, rather than
    falling to the bottom of the table where nobody would look for it. Bread
    types win the tie at a shared position; a name in neither catalog (a bread
    type since deleted, a return matching nothing) has no position and sorts
    last, alphabetically.
  - **Rows exist only for bread that actually moved.** A catalog entry nothing
    happened to is not a row of zeroes.
- **The day's runs are one list** (`RunsSection`), anything still out first,
  then by start time. It used to be grouped by area; areas were removed on the
  owner's call (October 2026). Each row leads with the run's agents
  (`runAgentNames`), falling back to the login that started it.
- **"Export summary" sits in the day bar beside the day navigation, and is
  dressed as an action rather than as a fifth way to move the day.** Everything
  inside `.ops-daynav` shares one chrome because ‹ Today › and the calendar are
  four ways of changing the same day; the export changes nothing, so it wears
  the run panel's accent button instead, in a `.ops-daybar-tools` wrapper beside
  the nav rather than inside it — put it *inside* `.ops-daynav` and that rule's
  `>` child selector dresses it as navigation. It opens the dialog below.

### Exporting a run to Excel

The **Export** button in the run panel — on the totals heading's own line, so it
sits with the figures it takes away — builds a five-sheet workbook (Summary,
Receipts, Bread, Collected, Expenses, plus Photos when there are any) with
ExcelJS (`lib/export-run-excel.ts`) and hands it to the browser as a download.
Nothing is generated server-side; the sheets are built from the rows the panel
already has. A failed export shows the page's red `.ops-notice-alert` right
under the button (`exportError`) — it was a browser `alert()` until September
2026, the one error on this surface not in the page's own style. The next
attempt, or opening another run, clears it.

- **One Bread sheet, laid out like the period workbook's.** It was two sheets —
  Inventory (initial load and each top-up) and Outcome (sold, returned,
  remaining), in two different orders — until September 2026, when the owner
  asked for them collapsed. Columns: Bread · Initial · Batch 1…n · **Loaded**
  (a `SUM` of the load columns) · Sold · Returned · **Left on truck** ·
  Returns % · Unsold % (both `IF(…>0, …, "")` formulas, blank rather than 0%
  when there is nothing to divide) · Stores (shops that took that bread,
  standing receipts only). The batch columns are kept rather than folded into
  Loaded, because when a top-up went on is still a question asked of one trip.
  Columns are found **by heading** (`breadCol`), since the batch count moves
  every column after it. The Summary's four bread figures point at its totals
  row.
  - **Initial and every Batch heading carry when that load went on** — label,
    Manila date, Manila time, three lines (`loadHeading`), always shown. The
    run panel's Inventory tab shows the same thing **when its heading row is
    clicked** (another click hides it; hidden by default) — no separate
    button, on the owner's call. The click is on the `<tr>`; "Bread" is a
    style-less button inside it for keyboard reach. The file has nothing to
    tap.
    - **The Outcome table follows it.** While times are shown, Outcome's
      heading carries an invisible two-line spacer (`.ops-loaded-at-spacer`)
      so both tables' rows sit at the same height and flipping tabs moves
      nothing — the same "switching tabs mustn't shift the page" rule as
      `.ops-tabpanels`. Both heading rows are `vertical-align: top`
      (`.ops-load-times-align`), and an unknown time still renders two lines,
      or the spacer and the real heading would disagree. The
    cell text differs from `breadHeaders`, which stays the plain labels
    `breadCol` looks up, and the load columns are re-measured after
    `autoWidth` by their longest line.
  - **Rows come from the panel's own `buildOutcomeRows`**, in the same
    `compareBreadNames` order, so the file and the screen can't disagree about
    what came back; the loading figures (`buildLoadingByName`) are keyed by the
    same resolved name so they join onto those rows. Fix a name-matching or
    ordering question in `lib/run-outcome.ts` and both move together.
  - **Its two footnotes are the period Bread sheet's, word for word** —
    `UnsoldNote` ("Unsold is bread that was loaded onto the truck but never
    sold…", on the owner's call) and `BreadStoresNote`, both exported from
    `lib/excel-style.ts` so neither workbook can reword only its own copy.
- **Totals are Excel formulas, not baked numbers**, so a manager who corrects a
  figure sees the sheet recalculate. The Summary states nothing of its own —
  every cell on it points at the sheet that owns the number — so it can't
  disagree with the tab behind it. The two exceptions are the Receipts sheet's
  bread totals, below.
- **The Receipts sheet lists the breads themselves**, one cell per receipt:
  "Pandesal × 12, Ensaymada × 3". It used to carry a count of *lines*, which
  said how many kinds of bread a store took without saying which — the one
  thing the sheet is asked after the money. Two consequences:
  - **Those two columns are pinned to `BreadColumnWidth` after `autoWidth`.**
    Left to size themselves, one long receipt would stretch them to the
    44-character cap and push the money off the screen for every other row.
    Excel clips the overflow and shows the whole list in the formula bar when
    the cell is clicked, which is where a reader goes for one receipt's detail.
  - **Their totals are the only baked numbers in the workbook.** The cells
    above them are text, and nothing in Excel sums a list of names, so the
    figures are computed here. They count loaves, not lines.
- **Subtotal, Returns and Net share one width on the Receipts sheet**, measured
  from what Excel *draws* rather than what `autoWidth` can see. They are one
  quantity in three columns, so three different widths read as three unrelated
  numbers — and the sizing has to be format-aware twice over: `autoWidth` reads
  the stored number ("1234.5"), not "₱1,234.50", and it never measures the
  totals row at all, because formula cells have no cached result and so no
  text. That row is where the widest figure sits, and a money cell too narrow
  for its value renders as `####` rather than wrapping.
- **The proof-of-payment photos are in the workbook, on their own `Photos`
  sheet** (the last tab), and the Receipts sheet's proof column is a "View
  photo" link into it.
  A GCash or cheque receipt *is* its screenshot, and the file is meant to be
  opened next week off a shared drive by someone who may not be signed in — so a
  link to Storage would be worthless there and a "Yes" sends the reader back to
  the dashboard for the thing the file was supposed to contain. The bytes travel
  inside the file; only their *location* is separate. Six things hold it up:
  - **They are not in the receipt row, and that was tried first.** Embedded in
    the row, each photo made it four times its natural height, and a table of
    money nobody can skim is a worse table however good the pictures are. Excel
    has no popup image viewer — nothing in the file format has one — so a jump
    to a sheet and a link back is as close to click-to-open as it gets. The
    Photos sheet also buys room to show the photo big enough to read a reference
    number off.
  - **Links are the `HYPERLINK()` worksheet function, never ExcelJS's
    `{ text, hyperlink }` cell value.** That form writes *every* link as an
    external relationship whatever the target, so a workbook-internal
    destination comes out as `TargetMode="External"` and Excel goes looking for
    a file named "Photos!A3". The same trap catches `addImage`'s `hyperlinks`
    option.
  - **The formula is passed without a leading `=`.** With one, ExcelJS emits
    `<f>=HYPERLINK(…)</f>`, which is malformed.
  - **Pictures are placed after every width and height is settled.** ExcelJS
    resolves an anchor's offsets against the column width and row height *at the
    moment `addImage` is called* (`exceljs/lib/doc/anchor.js`), so an image
    added earlier is positioned against geometry that no longer exists.
  - **The anchor's fractional part is not EMU.** ExcelJS multiplies it by
    `cellSize * 10000`, a scale of its own, so `anchorFraction` converts a
    margin in pixels back through that same formula. A guessed fraction
    silently changes the margin whenever the column is resized.
  - **Nothing in the photo path can fail the export.** A photo that won't
    download becomes a short note in the proof cell (`proofFailureNote`) with no
    link and no block, and the other forty receipts still come out. A run with
    no photos at all gets **no Photos tab** rather than an empty one.
  - **This is the one read that needs CORS on the bucket** — see "Firebase"
    below.
- **Voided receipts stay on the Receipts sheet and the formulas skip them.**
  A **Status** column (Finalized / Voided) sits beside Payment; voided rows are
  struck through with the status in red, and the Subtotal/Returns/Net totals
  are `SUMIF(Status, "<>Voided", …)` rather than `SUM`. The Summary's "Receipts
  written" and "Receipts voided" are `COUNTIF`s on the same column, so a
  status typed into Excel moves every figure behind it. The bread totals (baked)
  and the Collected sheet (baked) leave voided receipts out too.
- **A run still out gets an Info banner under the Summary's title** (amber,
  `infoBanner` in `lib/excel-style.ts`), saying the figures are the latest the
  server had at the export time and may still change. It replaced a footnote at
  the bottom — the wrong end for something that has to be read before the
  numbers. Both workbooks are always built from the latest data (the run panel's
  live rows; the period export re-queries at click), so the banner is about
  *unfinished*, not *stale*.
- The Summary's **column C is a gutter**, not a column: the two blocks at the
  top of that sheet sit in A/B and D/E, and C is the gap between them. Nothing
  is ever written there. The period workbook's Summary copies that layout, so
  the two files read the same way.
- **Excel aligns by type, not by column**, which is why the period Summary's
  text values are right-aligned by hand (`right()` beside `line()`). A number
  flushes right and a string flushes left, so From, To and Best truck hung off
  the opposite edge of the very column every figure above them lined up on —
  one block reading as two columns of values. The owner asked for it on the
  "Best" rows (then Best crew and Best area); From and To got it too, because a
  single right edge is the whole point.

### Exporting a period to Excel

The other workbook: **a range of business days**, from the **Export summary**
button in the Live tab's day bar. `components/period-export-dialog.tsx` asks
which days; `lib/period-summary.ts` reads and folds them; and
`lib/export-period-excel.ts` lays the result out as eight sheets — Summary,
Breakdown, Bread, Stores, Collected, Expenses, Runs, Receipts. It exists
because a month gets asked things one run cannot answer: which truck is ahead,
which bread nobody buys, which store has stopped ordering, and how much of the
money is still out there.

- **It lives on Live, not on Trends, and that is the point.** Trends is where a
  period is *looked at*; Live is where the day is *worked*, and "give me the
  paperwork for this month, or for today" is asked from the board somebody
  already has open. Trends keeps its own range for its own charts; the dialog
  never touches it, and neither steers the other.
- **The range control is the Trends tab's, deliberately** — Range: **Month /
  Week / Day / Year / Custom**, then a second dropdown for which one, and the
  same `DateRangePicker` behind Custom. The same units in the same order Trends
  offers them: Day started here, because this dialog is opened from a board
  showing a single day, and was added to Trends the same week so the two lists
  stayed identical. **Month is the default** — a workbook is usually wanted for
  a period, and the single day is one click away in the dropdown beside it. It was four fixed
  preset buttons (This day / This week / This month / Custom) until September
  2026 and the owner asked for the dropdowns: one idiom for "choose a period"
  across the dashboard beats a second one that has to be learned because it
  happens to be in a dialog. State is a type plus a value per type, exactly as
  Trends holds it, so nothing lets a from and a to drift apart from what the
  dropdowns say, and switching the type keeps the other selections.
- **Every option is measured from today, never from the day the board is
  showing — and the dialog takes no `day` prop, so it cannot be.** The first
  version anchored all four lists to the day on screen, on the reasoning that
  the reader had already navigated there; the owner's correction is the rule
  now. "This week" cannot mean two different weeks depending on where somebody
  had browsed to, and a workbook asked for "this month" while reading back
  through March must not quietly come out as March. That is also what lets the
  Week dropdown use Trends' own relative wording — This week / 1 week ago / 2
  weeks ago / 3 weeks ago, the one `WeekOptionLabels` array in
  `lib/day-ranges.ts`, shared so the two controls can't offer different weeks
  under the same words — and the same `recentDayOptions` behind the Day
  dropdown, which names only **Today** and gives the exact date for every row
  under it. "Yesterday" was there for a day and came off on the owner's call: a
  named row beside a dated row makes the reader translate one before they can
  compare them.
- **Custom resolves to nothing until a date is applied** — until then the
  readout says so and Export stays disabled, rather than a half-picked range
  silently exporting a default week. **One day is a legal Custom range**: Apply
  lights up on the first click and the end falls back to the start, so an
  arbitrary day further back than the Day dropdown reaches takes one click
  rather than two. See `components/date-range-picker.tsx`.
- **A dialog rather than a range picker in the bar.** The Live tab is one day
  all the way down — the heading, the buttons, the notices — and a second, wider
  range sitting there permanently would leave a reader working out which control
  the figures on screen belong to. Behind a button, the range exists only while
  the export is being set up.
- **The run count is fetched before the reader commits**, so "7 days · 23 runs"
  is on screen next to Export rather than discovered halfway through a progress
  bar. A range over `MaxRunsPerExport` is refused **there**, where the fix is one
  click on a shorter range; over `SlowRunCount` it says it will take a minute
  instead. The cap is checked again inside `buildPeriodSummary`, because the
  count is a courtesy and is allowed to fail.
- **Everything is read from the documents that arrived, never from a manifest** —
  the opposite of Trends, and for a plain reason: a manifest holds five totals
  with no store, no bread type and no payment method in them, so every sheet past
  the first would be unanswerable from one. Since the receipts have to be opened
  anyway, they are the single source, and no sheet can disagree with another.
  Note what this is **not**: nothing here compares what a manifest claimed
  against what arrived. That check was removed on the owner's call (see Live,
  above) and is not being reintroduced. The one thing carried off a manifest is
  `blockedUploadCount`, which the board already shows as a notice, and which the
  Runs sheet repeats as "Records refused".
- **Loaves come off the stock ledger at every level; the money, the stores and
  the returned bread come off the receipts.** Loaded, sold and left-on-truck are
  one arithmetic — `totalStock` builds them so that loaded − sold = left
  exactly — and a run belongs to exactly one day and one truck, so the
  same three numbers roll up to every sheet and still add to the same total.
  Taking "sold" off the receipt lines instead reads just as well on one sheet and
  stops the by-day table totalling to the Summary. Returns have no choice about
  it: a return writes no ledger entry and carries no `breadTypeId`, so the name on
  the receipt is the only join there is. Each sheet's footnote says which column
  came from where.
- **Every rollup sheet ends with the same money columns in the same order**,
  built by one `moneyColumns()` helper, and its loaf columns by one
  `loafColumns()`. Four sheets showing the same figures in four orders is the
  failure that prevents. Sales, Returns, Net and Expenses are on all of them;
  **Collected and Still owed are `moneyColumns({ collected: true })` and only the
  Runs sheet asks for it.** They were on the day and group rollups too until
  September 2026 and came off on the owner's call — what is still out there is a
  question about the *period*, answered on the Summary and the Collected sheet
  and chased from the Stores sheet, and repeating the split four more times only
  made four sheets wider.
- **A column that must not be added up has no total, and the footnote says why.**
  "Stores" is the recurring one: the same shop served on two days is one shop, so
  those counts genuinely cannot be summed — which is also why the Summary's
  "Stores served" is a counted figure rather than a formula. Averages are the
  other: an average of averages is not the average.
- **"Stores" means exactly one thing in this workbook, on every sheet that has
  it**: the number of *different* shops served — the size of a set of
  `customerId`, so a shop served five times counts once and a receipt naming no
  shop counts nowhere. That holds for the by-day rows, the truck rollup, each
  run, each bread ("shops that took this bread") and the Summary's
  "Stores served" alike; `period-summary.ts` has only ever built it one way, out
  of a `Set`. **Every sheet carrying it says so in a footnote, in the same
  words** — one `StoresNote` constant in `export-period-excel.ts` — because a
  count that cannot be added is precisely the figure a reader will try to add.
  It was six sheet-specific wordings first, and the owner asked for one: a reader
  moving between tabs recognises the note instead of re-reading it, and six
  phrasings of one rule is six chances for them to drift into six meanings. Only
  the Bread sheet keeps its own (`BreadStoresNote`), because its Stores column
  answers a different question — the shops that took *that bread*.
- **By day and By truck are one sheet, "Breakdown"** — stacked sections, each
  with a large bold title (20pt, `SectionTitleFont`, on the owner's call —
  Excel has one bold weight, so size is what makes it stand out), a one-line
  description and its own framed table. Sections are four blank rows apart with
  a **full-width slate-grey divider line** through the middle of the gap
  (`DividerEdge`, added on the owner's call) — grey rather than blue so it can't
  be mistaken for another table's frame. They were separate tabs (By day, By
  crew, By area) until September 2026 and the owner asked for one sheet; when
  crews and areas were removed (October 2026) **By truck** replaced both. **Every
  figure is in the same column in every section** — the truck name is merged
  across A:B to take the place of the day table's Day + Weekday — so the Net
  columns line up vertically. **And every column on that sheet is one width**,
  the widest any heading, figure or total needs in any section (a merged name
  only needs half, capped), because columns of different widths stacked on each
  other read as ragged — the owner's call. Nothing on that sheet is frozen,
  because several header rows can't all be pinned. The Stores and expenses
  notes are written once at its foot; the truck-rename note sits under the
  truck table. **Truck rows follow the dashboard's own order** — the drag order
  on the reference lists page, matched by id (`toGroupRows` in
  `period-summary.ts`), with trucks deleted since after them by name and "No
  truck recorded" last — so the Summary's **Best truck searches for the highest
  net** (`bestName`) rather than taking the first row. `live-board.tsx` watches
  the trucks and passes them through the export dialog for this.
- **The Summary points at the by-day table by column *heading*, not by letter**
  (`columnOf`). Column letters written out as constants are the classic way for a
  workbook to start quoting the wrong figure — insert one column and every
  reference past it is silently off by one, with no error anywhere. Looked up by
  heading, a rename throws at export time instead.
- **Nothing fails the export over one bad run**, the same rule the run
  workbook's photos follow. A run whose subcollections can't be read is still a
  row, marked "Could not be read", counted in `unreadRuns` and stated on the
  Summary — a run missing from the list would be invisible, where a row of
  zeroes saying so is a question somebody can ask. It still counts as a run that
  went out, because it was one. The store catalog is an *enrichment* (phone,
  contact) and its failure only blanks those columns.
- **The Stores sheet is the one nothing else on this dashboard answers**, and
  that is why it carries a phone number: "Still owed" is the credit and half-paid
  receipts somebody has to chase, and First bought / Last bought are how a store
  that has stopped ordering shows up at all — invisible on every screen the
  server has, because an absence draws nothing. A **"Days quiet"** column did
  that subtraction for the reader (counting back from the end of the period, not
  from today, so an export of last March still read correctly next year); it came
  off on the owner's call in September 2026. `daysSince` is still folded in
  `period-summary.ts` if it is ever wanted back.
- **The Bread sheet is counted in loaves, with no money on it** — the same call
  the Trends tab's bread charts make, and for the same reason: a bread selling
  three hundred cheap loaves is a bigger part of the day than one selling four
  expensive ones. It carried Sales and Returns credited until September 2026 and
  the owner took them out; the pesos are answered on four other sheets. The row
  *order* is shared — `compareBreadNames`, the reference lists' manual order —
  and, as on Trends, **every bread type in the catalog gets a row** whether it
  moved or not. Its first footnote (`UnsoldNote`, added on the owner's call)
  defines **unsold as bread loaded onto the truck but never sold** — the Left
  on truck column, with Unsold % as its share of what was loaded — the same
  sentence as the run workbook's Bread sheet (both notes live in
  `lib/excel-style.ts`).
- **The sheets were cut back in September 2026, and the trimming is the point.**
  Beyond the two above: the Summary lost days-a-truck-went-out, crews out, trucks
  used, areas covered, both loaf shares, both bread-type counts and all three
  net-per-something averages; by day lost Collected and Still owed; the group
  rollups lost those two plus Days out, the counterpart count and the two
  net-per averages. Footnotes went with them — Bread, Collected and
  Stores are down to one line each, and Runs to the "stores cannot be added up"
  one. The figures behind them are all **still folded** in `period-summary.ts`
  (`days`, `daysWithRuns`, `trucks`, `daysSince`, a bread row's
  `sales` and `returnsValue`, and `expenseGroups` — the Expenses sheet's grouped
  "What for / Times / Total" table, which the owner also removed, leaving that
  sheet one itemised table with a frozen header), unused by any sheet and deliberately kept: each is
  a fold of rows already read, so none costs a query, and putting a column back
  is a line in the layout rather than a change to the reading.
- **The progress bar is determinate**, which the run export's cannot be: the run
  count is known before the first read, so "Reading run 43 of 210" is honest.
  A minute of bare spinner says nothing about whether anything is happening.
- **Every receipt is on the Receipts sheet; voided ones are folded into nothing
  else.** `foldPeriod` filters voided receipts out of each run's receipts before
  any fold runs, and separately lists *every* receipt as a `PeriodReceiptItem`
  (with `voidedAt`). The **Receipts** tab (last, always present) lists day,
  time, store, agents, truck, payment, **Status** (Finalized / Voided), sales,
  returns, net, collected and voided-at, oldest first. It follows the run
  workbook's rule: voided rows are struck through with Status in red, and every
  total is `SUMIF(Status, "<>Voided", …)` (addTable's `skipRowsWhere`), so its
  totals match the Breakdown and Collected sheets. The Summary's "Receipts
  voided" is a `COUNTIF` on that column. It replaced a Voided-only sheet in
  September 2026 on the owner's call — one list of every receipt, with the
  voided ones in place, beats a tab of cancellations on their own. Runs still out are named — up to five — in the same amber **Info banner**
  the run workbook uses, which replaced the "some runs had not been ended"
  footnote.
- `lib/excel-style.ts` holds what both workbooks draw with — the navy headers,
  the indigo frames, `MoneyFormat`, `outlineRange`, `autoWidth`,
  `fitMoneyColumns`, `sheetRef`, `downloadWorkbook`. It was lifted out of
  `export-run-excel.ts` when the second workbook arrived, because the two files
  land in the same folder on the same shared drive and get read side by side.
  `totalCollected` moved to `lib/runs.ts` for the same reason: one definition of
  what counts as collected, or the two workbooks disagree about what is owed.

### Trends

- **The range is Month / Week / Day / Year / Custom**, a unit dropdown plus a
  which-one dropdown, all of it measured from today. Day sits next to Week
  rather than at the end so the list reads longest-to-shortest, and it charts
  like any other range — `byDay` gets one row, the breakdowns and the bread
  chart get that day's runs. It is the unit somebody lands on after spotting
  something odd on a week. The units, the four week labels and the day labels
  are shared with the summary-export dialog out of `lib/day-ranges.ts`
  (`WeekOptionLabels`, `recentDayOptions`, `recentMonthOptions`) so the two
  controls can never offer different periods under the same words.
- **Charted from run manifests, not from receipts.** A closed run's manifest is
  already a per-run daily rollup, so ninety days costs *one query* instead of
  opening every run's receipts subcollection. Runs with no manifest (still open,
  or abandoned) are totalled from their receipts instead — the same receipts
  the bread and store sections read, queued first, never read twice.
- **Every run in the range has its receipts read — no cap**, on the owner's
  call (September 2026): "whatever the amount of runs are in that range should
  just be what is fetched." Two caps used to exist — 60 runs for bread and
  stores, 25 unended runs for the money — and a month with a few trucks out
  daily outgrew the first, so store rankings were quietly built from a sample.
  **Don't bring a cap back.** Reads go `ReceiptReadBatch` (8) runs at a time
  with one state update per batch, unended runs first, then newest first; the
  truck filters don't steer the order, since everything is read
  anyway. A run whose read fails is kept in `failedRuns` and every receipt
  section says how many couldn't be read ("Reload to try again") rather than
  showing a short total as whole. The cost is Firestore reads: one per receipt
  in the range, every visit to the tab.
- **A manifest is what the phone recorded, which can exceed what arrived.** For
  a business trend the phone's figure is the right one, but "what did we sell"
  and "is everything uploaded" are different questions and the page says so.
- Every day in the window gets a bar, including empty ones. A chart that
  silently skips a day off misstates the shape of a week.
- **The truck is the dividing line for performance** — "Net takings by truck"
  (`groupRuns` keyed on `truckId`). It was by crew, then by area, until both
  were removed on the owner's call (October 2026). A run with no truck gets a
  row of its own under `NoneKey` rather than dropping its money out of the
  total.
- **Bread performance can be scoped to one truck.** The filter feeds one
  `inBreadScope` predicate used in two places: which runs the totals count, and
  the wording of every note and empty state (`breadScope`), so the figures on
  screen always say what they are a slice of.
- **"Reading receipts… N of M runs" counts attempts, not successes.** It reads
  `breadReadCount`, bumped once per batch whether its reads landed or failed.
  Counting the receipts map's size instead left the line up forever as soon as
  one fetch failed — the stuck-spinner failure mode again.
- **Everything below the filter bar greys out until the whole tab has loaded**
  (`tabLoading`, `.ops-busy` over `.ops-trends-body`) — on first open and on every new range,
  on the owner's call (September 2026). It waits for the runs, every run's
  receipts (`breadLoading`) and both catalogs' first snapshot, because half-read
  totals climbing on screen pass for real ones. The same pattern as the store
  panel's `.ops-drawer-loading`. Three things hold it up: the **filter bar
  stays outside the grey**, so a slow range never stops a reader picking
  another; a **failed history read lifts it** so the error shows; and a failed
  receipt read still counts as attempted, so it can't hold the grey up forever.
  The label says which stage it's in ("Reading receipts… N of M runs") and is
  sticky, so it stays in view on a long page.
- **Bread is counted in loaves, and sold and returned share one chart.** The
  section used to be two horizontal bar charts, "Bread sold by item" and "Bread
  returned by item", both measured in pesos. Two problems: the money is already
  answered twice above, and the returns chart on its own scale said almost
  nothing — a tenth the size of the sales chart and read separately from it.
  Now there is **one** chart, `SplitBarChart`, one bar per bread type in
  **loaves**: a blue length for what it sold and an orange one for what came
  back, laid end to end. Same unit, same bread, one row.
  - **A bread that sells three hundred cheap loaves is a bigger part of the day
    than one that sells four expensive ones**, which is what this section is
    asked and what the peso ranking got wrong. **There is no money in this
    section at all** — not in the bars and not in the table, which carries
    loaves sold, loaves back and the rate between them and nothing else. Pesos
    are the whole subject of General statistics above; repeating them here made
    the one section that answers "what physically moved" answer that question
    second.
  - **Both figures are printed, each in its own column** at the end of the row,
    under a heading carrying that segment's colour. Making the reader hover for
    the number the chart exists to show — or switch to the table for it — is
    making them work. The columns are **equal fixed widths with everything
    centred in them**, headings included: right-aligned figures of different
    lengths ("9,640" beside "34") put a different amount of air between each
    pair, and the even rhythm stops being visible. That fixed width has to
    clear the widest heading a caller passes, swatch included, or a column
    overflows into the gutters beside it.
  - **Every row is closed by a hairline, the same one the table draws.** The
    columns themselves stay **unruled** — a vertical grid inside a chart makes
    it look like neither chart nor table, and the swatch above each column plus
    a step down in ink weight are what separate them. But a bread's name on the
    left and its fourth figure most of a card away on the right are only
    reliably on one line if a line says so, which is what the owner asked for
    after losing the thread on the widest rows. Don't take the row rules back
    out on the grounds that "a chart is unruled": that rule was about the
    columns and it still holds.
  - **The two views are laid out from one set of numbers, so the toggle moves
    nothing.** The chart and its Table view show the same rows in the same
    order, and switching between them used to shift every figure sideways and
    every row up: different column widths, a fourth column in the table only,
    and rows of two different heights. Now `overview.css` carries four
    `--splitbar-*` custom properties on `.ops` — a figure column's width, the
    gap before it, and the two paddings a row and a heading use — and *both*
    `.ops-splitbar` and `.ops-table-even` are built from them. A table has no
    grid gaps, so its cells are the column plus the gap and spend that gap as
    **left** padding with none on the right, which lands every centred figure
    at exactly the same x as the chart's. Vertically both are 8px + one
    13px/1.5 line + 8px + the hairline, so row *n* sits at the same height in
    either view (within the half-pixel a collapsed table border owes its
    neighbour) and the two blocks are the same total height. Change one of
    those properties and both views move together; hard-code a width or a
    padding into either and they part company again. Three things have to stay
    true for it to hold, and all three are things a future change could break
    without noticing: the same columns in the same order in both, the chart's
    `leadLabel` matching the table's first heading, and neither view's rows
    wrapping to a second line. Below 560px the last one *does* break — the
    chart puts the bread's name on its own line and the table doesn't — so the
    two only line up on a real screen, which is where the toggle gets used.
  - **The table's headings are the chart's, not the page's uppercase
    micro-label.** `.ops-table-even th` is pulled off `.ops-table`'s
    letter-spaced small caps deliberately: in the chart those headings *are*
    the legend, and a swatch plus an uppercase word does not fit a column
    sized for the figures under it. The table follows the chart here, because
    the chart is the constrained one.
  - **This chart has no tooltip**, and that follows from the line above: with
    both figures already on the row there is nothing left for one to say. The
    truck bars above keep theirs — a bar there carries a quantity its
    peso value doesn't state.
    - It had **no hover either**, on the argument that a row lighting up under
      the pointer promises something more if it is clicked. That argument was
      right until there *was* something more: a row now opens the per-bread
      dialog below, so the highlight is a truthful signal rather than a
      misleading one. It is still conditional in the code —
      `SplitBarChart` draws an inert `<div>` row and lights up nothing unless
      an `onSelect` is passed, so the promise and the thing promised can't
      come apart.
  - **The rows are in the run panel's Outcome order, not biggest-first** — the
    manual position each bread was dragged to on the reference lists, a
    returned-only name landing directly under the bread type holding its
    position. One list of bread in one order wherever the dashboard shows it,
    so a reader who knows where Pandesal sits in that table finds it in the
    same place here. The rule itself is `compareBreadNames`, lifted out of
    `buildOutcomeRows` in `lib/run-outcome.ts` — which still sorts with it, so
    the two can't drift. **That is the one place the dashboard's copy of that
    file is deliberately not parallel with the phone's**: mobile has no second
    table to order, so its copy keeps the rule inline.
  - **Every bread type in the catalog gets a row**, whether it moved or not,
    and there is no top-N cut. Over a period a bread that sold *nothing* is
    itself the finding, and a reader scanning for it would otherwise have to
    notice an absence. This is a deliberate departure from the Outcome table,
    which lists only what happened on the one run in front of it — the
    *ordering* is shared, the row set is not. A catalog entry is matched to a
    movement row by id first and name second, because a sold row is keyed by
    `breadTypeId` except where the receipt carried none.
  - **Two more columns, `Rate` and `Stores`, have figures but no mark on the
    bar** — that is what `SplitBarChart`'s `extras` is for. Neither can be a
    segment of a length drawn in loaves: a share isn't a length, and a count of
    shops isn't loaves. `Stores` is a set of `customerId`, so the same store
    buying the same bread twice in the period counts once and a receipt naming
    no store is skipped, both exactly as `totalReceipts` counts a day's stores.
    `Rate` arrives at the chart **already formatted** — an `extras` entry may be
    a string for exactly this reason, since `format` is one function for the
    whole chart and that function counts loaves.
    - Rate was in the Table view only until September 2026, and that is what
      made the toggle jump: the table had four figure columns and the chart
      three, so every number moved sideways on the way in. The columns of the
      two views are one list now — add to one and add to the other.
  - **The table runs to full height** (`ChartCard`'s `fullTable`) rather than
    scrolling in a 320px box. The cap earns its place where a table is a long
    tail nobody reads to the end of — ninety days of takings — and is wrong
    where the table *is* the list.
  - **The totals sentence under the plot is shown under the table too**, which
    is what `ChartCard`'s `footer` is for. It is not a caption for the drawing
    — it is what the whole card comes to, and a reader who switched views to
    read the figures exactly is the last one who should lose the total. Passed
    as a prop rather than left as the chart's last child so it survives the
    toggle, and rendered outside the table's scroll box so a wide table can't
    carry it sideways off the card. It is `null` when there is nothing to
    total; the empty state does the talking there.
  - **The bar draws the two figures themselves**, sold then returned, not
    anything derived from them, so every segment on screen is a number printed
    at the end of its own row. Its full length is loaves handled in either
    direction. An earlier version
    drew the first segment as sold *minus* returned — a truer part-to-whole
    reading and a worse chart, because its blue length matched no figure
    anywhere on the page.
  - **Trends watches both catalogs itself**, for their order alone — no price
    or unit is read there. It holds its own copies exactly as the Live board
    does rather than taking them as props, so neither tab depends on the other
    having loaded.
  - **Sold and returned join on the name, word for word**, exactly as
    `lib/run-outcome.ts` does, because a return carries no `breadTypeId` at
    all. A name is claimed **once**: two bread types spelled the same would
    otherwise each take a full copy of the same returns. A returned name
    nothing was sold under still gets a row — all returns, no sales — rather
    than dropped. That is real money credited back, and usually a spelling to
    fix in the catalogs.
    - **Nothing on the row says so, on the owner's call** (September 2026). The
      Table view used to print "— nothing sold under this name" beside the
      name and an em-dash in the Sold column; both are gone, and Sold reads
      **0** in both views. A row with returns and no sales already says that in
      its figures, and the em-dash was the last place the two views printed one
      figure two different ways — the chart drew the same row as a 0. The
      `matched` flag the annotation ran on went with it; the join still claims
      a name once, it just no longer has anything to report about having done
      so.
  - **A bread row opens a dialog: one bread, cut by truck and by store.**
    `components/bread-detail-dialog.tsx`, with the arithmetic in
    `lib/bread-detail.ts`. The chart answers "what moved" for every bread at
    once; the question straight after is always about one of them — which truck
    shifts it, which shops take it and which have quietly stopped — and those
    are two cuts of the same loaves, so they are two blocks of one dialog
    rather than more cards on a long tab. (It also cut by crew and by area
    until those were removed.)
    - **A dialog, not a drawer**, by this page's own rule: a drawer is a place
      you go into and read (a run, a store), a dialog is one question asked and
      answered. It also must not displace the chart, because the reader is
      comparing it against the row still visible behind the scrim.
    - **Both views open it, and the chart's own toggle is what makes that a
      rule rather than a nicety**: the Table view is the *same* rows, so a row
      that does nothing there would be the toggle changing behaviour and not
      just drawing. In the chart a row becomes a real `<button>` — the grid is
      declared on the class, so the swap costs the layout nothing and the two
      views still line up column for column. In the table the handler is on the
      `<tr>` (so a click anywhere along the row works) and the bread's **name
      is a button** (so the keyboard can reach it); Enter and Space on it raise
      a click that bubbles to the row, so one handler serves both. A `<tr>`
      given `tabIndex` and `role="button"` was the obvious alternative and is
      wrong: a row announced as a button stops being announced as a row, and
      takes the table's structure down with it.
    - **It fires no query.** Every figure is folded out of the receipts the tab
      had already read. Where some run failed to read, the dialog repeats the
      tab's "could not be read" line rather than quietly showing a fuller or
      emptier picture than the row behind it.
    - **Counted eagerly, merged lazily, and the line between the two is the
      join rule.** The three cuts are filled in the *same pass* that builds the
      chart (`BreadRow.breakdown` — one map write per receipt line, which the
      loop is already paying for), and which returns belong to a row is decided
      in `breadMovement` beside the row's own figures, because that is the
      sold/returned join (on the **name**, claimed once — see above) and it
      must not exist twice. But **folding the two sides together and sorting
      them is deferred to the bread actually opened** (`openBreadDetail`).
      Doing it for every row inside `breadMovement` — which is what the first
      version did — ran it for the whole catalog on every recompute, and there
      is one recompute per receipt fetch while a period loads: for a popular
      bread over a month the store cut alone is hundreds of rows, so that was
      hundreds of thousands of object copies and a sort each, thrown away
      unread. The memo depends on the two maps rather than on the row object,
      so an unrelated re-render doesn't redo it while new receipts still do.
    - **The store list draws 25 rows and offers the rest** (`StoreListCap`).
      Ordered by loaves, the top of it *is* the answer to "who takes this
      bread" and the tail is most of the customer directory — a thousand table
      cells nobody scrolled to, built every time a dialog opens. The button
      says what the click *gives* you ("Show 190 more") rather than what the
      list totals: a total there would be a second store count on a card that
      already carries one, and the two can honestly differ — the tile counts
      identified shops on the sold side, the list can also hold the no-store
      bucket and a shop that only ever sent the bread back. Once taken it does
      not offer to collapse again: a reader who asked for the list and then had it fold up
      under them would have to find their place twice. The truck cut is
      uncapped — a handful of rows by nature.
    - **The truck comes off the run, the store off the receipt** — the same
      places `groupRuns` and `totalReceipts` take them from.
    - **Loaves throughout, and no money anywhere in it**, exactly like the
      section it opens from. The store list is Sold / Came back / **Last
      taken** — the stored `businessDay` string formatted, never a day worked
      out from a timestamp — and "last taken" is moved by a sale only: a shop
      that sent bread back last week hasn't taken it since. A shop with returns
      and no sales gets a dash there rather than a date.
    - **Trucks are drawn with `SplitBarChart` again**, the same
      component and the same two colours as the chart behind the scrim, so blue
      and orange mean the same two things one layer in. Without the `Rate` and
      `Stores` columns, though — four figures on a row in a box half the width
      is not the same chart. The stores are a **table**, not bars: a truck list
      is a handful of rows a bar compares at a glance, where the shops taking
      one bread run to dozens and what is wanted of them is a roll call with a
      date on it.
    - **The open dialog is held as the row's key, not the row.** A filter
      switched while it is open re-resolves against the rows actually on
      screen, so a bread the new scope has no row for closes the dialog instead
      of leaving figures behind the scrim that nothing on the page agrees with.
    - `formatShare` moved from the tab to `lib/runs.ts` when this landed: the
      same return rate is now printed in three places (the chart's Rate column,
      its table twin's, the dialog's headline figure) and one rounding rule is
      what stops them disagreeing over one fraction.
- **"Store statistics" is the third headline, below Bread statistics** —
  `lib/store-stats.ts` for the arithmetic. Three tiles (stores served, **average stores per
  day** — each store's buying days added up, over the days anybody bought, so a
  day off doesn't drag it down; it replaced "repeat stores", which the owner
  swapped out — and average net per store), then two graphs of **five stores
  at a time** (the owner asked for top performing stores), each store keeping
  the **same palette slot in both**:
  - **A Back / Next pager steps both cards through the ranking five at a
    time** (#1–5, #6–10… of every store that netted above zero;
    `StorePageSize`, `storePage`). The owner asked for "5 more every tap"; the
    palette has six hues and must never cycle, so the owner chose paging over
    piling grey extras onto the graphs. **It sits just above the first card, outside
    it** (`.ops-store-pager`, pulled into the stack's gap), as one centred line with
    no label — "‹ Stores #6–10 of 42 ›" — and boxed arrow buttons (easy to see and
    tap). Outside any card, it stays put whichever view either card shows.
    Three other spots were tried and rejected by the owner: a labelled row
    with bordered buttons above the cards ("too cluttered"), a centred line
    between the two cards, and inside the first card under its heading.
    A new period or truck
    sends it back to #1–5, and it is hidden when there are five stores or
    fewer.
  - **Graph and table always hold exactly the same stores** — owner's rule.
    Both cards and both of their table views read one `chartStores` list.
  - **"Top stores' share of takings" — a donut** (`DonutChart`): the page's
    five stores plus a grey "All other stores" slice (every store not on the
    page), total in the middle, a key beside it printing each figure and share.
    Its Table view is those same five rows, ranked (net, share, receipts, days
    bought, loaves, last bought), then an "All other stores" row with its net
    and share, exactly as the ring draws it.
  - **"Top stores over time" — curved lines** (`LineChart` with `curved`
    and `partialLast`): each top store's net across **the picked range**,
    cut into points **scaled to the range's length** (`trendBuckets`):
    up to 2 weeks → a point per day, up to 3 months → per week (Monday
    start), longer → per month. The aim is ~5–12 points: fewer is no curve,
    many more is a comb of zeros for stores bought from twice a week. A week
    or month clipped to a sliver of a few days at either end is **folded into
    its neighbour** (merged months are labelled "Jan–Feb"), or it would plot
    as a false collapse. A **single day** shows a note instead of a chart —
    a store buys about once a day, so there is no curve. A point still
    running today is drawn **dashed**, explained by its own line under the
    legend (`.ops-dash-note`, a dashed swatch + "Dashed line means this month
    isn't over yet…") — the owner asked for it separate from the card's note. The curve is monotone (no overshoot),
    so it never dips below ₱0 between points. **No query of its own**
    (`storeNetByBucket` over the receipts already read), receipts filed under
    the run's day. Its Table view has **stores as rows and the periods as columns**
    (plus a Total), the way the chart reads — the owner's call. **No % change
    labels**: within the range the only comparison is against an unfinished
    last point (a false ▼), and comparing with the period before means reading
    outside the range, which the owner ruled out.
  - **The whole Store statistics section follows the picked range** — the
    owner's explicit call. Don't make any part of it look back past the range
    (a version that plotted the 6 months before was rejected for that).
  - **What this card replaced, all on the owner's call (September 2026):**
    a per-day running-total line ("the visual doesn't really give us
    anything" — stores are delivered about twice a week, so it was a
    staircase), a dot timeline of deliveries ("looks like shit"), and a
    two-point then-vs-now slope chart. What the owner actually wanted was the
    original lines with the **point size scaled to the range** ("if it's a
    year then the points in the graph is like by month"). The owner wants this
    card to give **a different perspective from the donut**, not the same
    numbers redrawn. **Never go back to per-day points** for store lines, and
    dots are out, like bars.
  - **History of this section, all on the owner's call (September 2026):** it
    started as a bar chart plus a "Stores that still owe" card and tile; still
    owed was removed ("remove the still owed" — chasing money is the period
    workbook's Stores sheet), the bars became a podium-and-list leaderboard
    ("getting sick of bar graphs"), and that was rejected too ("looks bad… it
    doesn't even have a graph"). **Don't bring back bars, still owed, or a
    chartless leaderboard.**
  - **It fires no query.** It folds the receipts the bread section already
    read — every run in the range — and repeats that section's "Reading
    receipts… / could not be read" line.
  - **It has its own Truck dropdown** (`storeTruckFilter`, `inStoreScope`),
    laid out exactly like the bread section's — an `.ops-filterbar` right
    under the headline, the same `.ops-scope` grid, and the "Scopes… /
    Reading receipts…" line. It narrows `storeEntries`, so the tiles, the
    donut, its table and the curves all move together, and the card notes and
    empty states carry `storeScope` (" for Truck 1"). **Separate from the bread
    filter on purpose**: each says which section it scopes, and one section
    silently narrowing the other would be an unlabelled filter. Both reset when
    the range changes. (These were Crew and Area dropdowns until crews and
    areas were removed.)
  - Same counting rules as everywhere else: voided receipts count nowhere, a
    receipt naming no store is skipped, net is `receipt.total`, days are the
    stored `businessDay` strings, and a store's name is the one on its newest
    receipt.
- **A treemap, a dot plot and a weekday heatmap were built here and taken out
  again** (August 2026). They were an answer to a real complaint — the tab was
  nothing but bar charts — and the owner's verdict on them was "ugly". A chart
  the person who reads it every morning doesn't want to look at is not a better
  chart however well it maps to the data. **Don't reintroduce them without
  being asked.** What survived the exercise is the part about the *data* rather
  than the drawing: loaves instead of pesos, and one chart instead of two.
- **Two big headlines divide the tab** — "General statistics" (the money) and
  "Bread statistics" (what moved, in loaves). `SectionHeadline` +
  `.ops-headline` in `overview.css`. They are structural only — they scope
  nothing, and the filters stay where they are. Three things carry the break,
  and it took two goes to get there: the first version put a 2px ink rule
  *under* a 20px title, and in a long stack of white cards that read as one
  more card border.
  - **The rule sits under the whole block — the title and its line of helper
    text both** (September 2026, the owner's call). It ran *above* the heading
    first, on the argument that a line under a heading separates it from its
    own content while a line above separates this subject from the one before.
    What that missed is that the helper text is *part of* the heading: "the
    money and the receipts, across every truck in this period"
    says what the section is, and a rule above it left that sentence stranded
    between the rule and the cards, reading as a caption for the first card.
    Under the pair, the two are visibly one object. **Don't move it back up on
    the strength of the old argument** — it is written down here because it is
    a good argument that lost to a better look.
  - **It is 3px and navy**, the one mark on the page heavy enough to be seen
    without being looked for. Navy is already this page's structural accent
    (links, pills, the active tab) rather than a status colour, so it reads as
    architecture. That weight, not the position, is what fixed the very first
    version — a 2px ink underline on the title alone, which read as one more
    card border.
  - **64px of air above the heading** — a 40px margin on top of the chart
    stack's own 24px flex gap, which add rather than collapse — and 16px
    between the helper text and the rule. The headline at the top of the tab
    gets less again (24px), because it follows the filter bar's hairline and
    has less work to do; this one follows a white card with nothing to end it.
    32 + 24 and a 26px title on a phone.
    - **It was 144px, and the reduction is the other half of moving the rule.**
      With a navy line at the top of that gap, all of it read as the break —
      two rounds of "still hard to see" had been answered mostly with space.
      Underneath the heading instead, the same gap is a plain empty band with
      nothing in it, and the owner's word for it was "too many spaces". The
      break is now carried by the rule and the 32px type, and the space above
      was only repeating them. **Don't read the old "white space is what
      groups a page" note as licence to put it back** — that is still true, and
      64px against the cards' 24 is still what it buys here.
  - **The heading is 32px and its helper line 14.5px**, raised from 24 and 13
    at the same time as the air above came down, and the two are one decision:
    with the break no longer carried by an empty band it has to be carried by
    the type. Better than twice the cards' 15px titles is what makes a section
    heading win against everything under it at a glance. The helper line goes
    up with it because it is *part of* the heading rather than a caption for
    the cards — that is the same reasoning the rule's position rests on — while
    staying obviously subordinate at muted ink and under half the size.
    **Shrinking the type means putting the space back**; they are not
    independent knobs.

### Stores

- **The store history is a collection-group query on `receipts`**, and that
  needs *two* things, both now in place: the `(customerId, createdAt DESC)`
  composite index, and a rule written as `match /{path=**}/receipts/{id}`. A
  rule nested under `/runs/{runId}` does **not** authorise a collection-group
  query however much it looks like it should — that was a rules addition, so
  `npm run deploy:rules` before this works against the cloud project.
- **Every receipt the store has is read — no cap** (owner's call, September
  2026; it used to stop at the newest 60, so the "Last 60 receipts" totals and
  chart covered only part of the history). The tiles are headed **All time**.
  Only the *list* is paged: `ReceiptPageSize` (10) rows, then "Show 10 more"
  with a "Showing X of Y receipts" count, reset when another store opens.
- **The whole store panel greys out while its receipts load**
  (`.ops-drawer-loading`: spinner + "Loading this store's receipts…"), on the
  owner's call — every tile, the chart and the list come from that one read.
  The ✕ stays above the grey so a slow read never traps the reader; a failed
  read lifts it so the error shows.
- **The directory draws 25 stores, then "Show 25 more"** (`StorePageSize`,
  owner's call, September 2026 — it can run to thousands). The filter bar's
  "X of Y stores" always counts the real totals, and the line under the table
  says how many are drawn. **A search shows every match, uncapped** (the Area
  and Crew filters that used to sit beside it were removed) — an answer cut at 25 would hide the store being looked
  for — and changing any of them starts the paging back at 25.
- **Searching and filtering grey the list while it redraws** ("Finding
  stores…", `.ops-busy` over `.ops-stores-body`). The filtering is instant; it
  is *drawing* hundreds of matching rows that takes time, so the list is built
  from `useDeferredValue` copies of the search and both dropdowns, and the
  grey shows while those lag the live values. Two things make that work and
  must stay: the rows are the memoised `StoreTable`, so a keystroke's urgent
  render skips them (without the `memo` the page freezes exactly as before and
  the grey never gets a chance to paint), and the grey fades in after 150ms,
  so a quick search doesn't flash on every keystroke. The `.ops-busy` /
  `.ops-busy-label` classes are shared with the Trends overlay.
- **Soft-deleted stores are filtered on the way in** (`deleted !== true`). The
  rows are still there because a hard delete would be invisible to the phones'
  watermark sync.

### Charts (`components/charts.tsx`)

Hand-rolled inline SVG — five forms (columns, horizontal bars, split bars,
multi-line, donut) — rather than a charting library, which would add a few hundred
kilobytes to draw shapes that are a dozen lines each.

- **The form is chosen by the job**: columns for magnitude across an ordered
  axis, horizontal bars for magnitude across named categories, **split bars**
  where one of those magnitudes is part of the other, lines for change over
  time, a **donut** for a handful of named parts of one whole (five slices plus
  a grey "everyone else" at most — past that it belongs in a table). Lines can
  be `curved` (monotone, never overshoots) with a dashed `partialLast` segment
  for a period still running. `SplitBarChart` is the newest and the narrowest: it is only right when
  the segments are the same unit and genuinely sum to something a person would
  want a total of (loaves sold, of which some came back). Two measures that
  merely sit near each other are two charts, and this one would lie about them.
- **A split bar prints every segment's figure in a column of its own**, and its
  column headings *are* its legend — the swatch sits directly over the numbers
  it belongs to, so "which of these is the returns" is answered where the
  numbers are rather than in a key below the plot. The figures stay in text
  ink, never the segment's hue, which is illegible as text at these steps.
  Column widths come from `--splitbar-count`, a custom property the component
  sets from the series count: an inline `grid-template-columns` would beat the
  media query that narrows them on a phone.
- **A split bar's rows are ruled, and it is built to sit exactly where its
  table view sits** — same row heights, same column positions, same header row
  (`leadLabel`), so `ChartCard`'s toggle swaps the bars for the missing column
  and moves nothing else. The mechanism is a set of `--splitbar-*` properties
  shared with `.ops-table-even`; the reasoning is under "Bread is counted in
  loaves" in Trends, and it is the one place in this kit where a chart's
  measurements are also a table's.
- **Three more forms were added and removed the same day** — see "the owner's
  verdict on them was ugly" under Trends. Don't bring them back unasked.
- **The plot's width is measured and fed into the `viewBox`, so one SVG unit is
  one CSS pixel.** This is load-bearing: the usual `viewBox` + `width: 100%`
  makes a 2px line 3px in a wide card and 1px in the drawer, and 11px axis text
  either 17px or 7px. Every mark spec would mean something different per card.
- **The series palette is validated, and its order is the safety mechanism** —
  worst adjacent pair ΔE 9.1 under simulated protanopia on white. Assign by
  slot, never cycle, never insert a hue. The page's navy accent is deliberately
  *not* in it (too dark to clear the lightness floor for a thin mark); navy stays
  chrome.
- **Every chart has a table-view toggle**, and that is required rather than
  polish: three of the six series colours sit below 3:1 on white, which is only
  legal where the values are reachable without colour.
- Fixed specs: bars/columns cap at 24px with a 4px rounded data-end, lines are
  2px, markers carry a 2px surface ring, gridlines are solid hairlines, and
  never a number on every point — the endpoint, the axis, the tooltip, the table.

**Seeing it with data — from the app, never from a fixture.** There was briefly a
`seed:demo` script that staged a month of invented runs so the charts had
something to draw; it was removed on the owner's call and should not come back.
Invented sales are indistinguishable from real ones once they are in the
database, and a dashboard whose whole job is to be trusted about money is the
wrong place to put numbers nobody can vouch for. To exercise these screens, run
a day on the mobile app against the emulators: finish truck setup to open a run,
write and finalize a few receipts, then "End the Day" to produce the manifest
Trends reads. That also tests the upload path, which a fixture never did.
`seed-emulator.mjs` stays — it seeds reference lists (trucks, agents and the
business settings), which are names a manager would have typed anyway, not
records of anything having happened.

## App Check (dashboard)

Exists for one reason: **App Check enforcement is set per Firebase product for
the whole project, not per app.** Once Firestore/Storage/Authentication
enforcement is turned on (see "App Check" in `apps/mobile/CLAUDE.md`), it
applies to *every* client talking to that product — the dashboard included — because the
product itself just checks "does this request carry a valid token," with no
concept of which app sent it. Without App Check wired into the dashboard too,
flipping enforcement on would have locked out the one tool the owner actually
uses daily, the moment it was flipped.

- **Provider is reCAPTCHA Enterprise, not Play Integrity** — there's no device
  attestation equivalent for an arbitrary browser, so a score-based provider is
  the only option Firebase offers for web. **It's invisible in normal use**: no
  checkbox, no puzzle, nothing shown on screen — it scores the session silently
  in the background. Don't let "reCAPTCHA" read as "adds a captcha to login";
  it doesn't.
- Wired in `apps/web/src/lib/firebase.ts`, right after `app` is created —
  mirrors the mobile file's App Check block in shape (non-fatal try/catch, so
  a missing or failed setup never breaks the dashboard itself) but is much
  simpler: no native module, `firebase/app-check`'s `ReCaptchaEnterpriseProvider`
  works directly since this runs in a real browser.
- **Site key**: `VITE_RECAPTCHA_SITE_KEY` in `apps/web/.env`. Register the web
  app in Firebase console → App Check → Apps → reCAPTCHA Enterprise — Firebase
  can auto-create the key there, no separate Google Cloud Console visit needed.
- **Local dev uses the debug provider**, not a real reCAPTCHA check — same
  reasoning as mobile's `__DEV__` split, but the mechanism is different on web:
  setting `self.FIREBASE_APPCHECK_DEBUG_TOKEN` (to a specific token, or `true`
  to auto-generate and log one to the browser console) *before*
  `initializeAppCheck()` runs makes the SDK use the debug provider regardless
  of what provider object was actually passed in. `VITE_APP_CHECK_DEBUG_TOKEN`
  in `.env` holds a registered token; left blank it falls back to the
  auto-generate-and-log path. Register printed tokens at Firebase console →
  App Check → Apps → manage debug tokens.
- **Left blank, the dashboard still runs exactly as before this existed** —
  the whole block is non-fatal, same as mobile's. Nothing here is required to
  keep working locally; it only matters once enforcement is actually flipped
  on for the project.

## The Team page

`apps/web/src/pages/team.tsx`, backed by
`firebase/functions/src/dashboard-users.ts`. It exists so the client runs their
own staff list: hiring, offboarding and password resets are all self-serve, and
nobody needs Firebase console access to do them. Before it, adding a dashboard
user meant two console steps, which meant the developer had to stay in the loop
— and stay in possession of a login to the client's live business data.

- **A second flag, not a second role.** `users/{uid}` gains `admin: true` for
  the people who may manage the team; `role` still says which *app* an account
  belongs to and is untouched. A dashboard account without `admin` uses the
  dashboard and nothing else. Rules can't be talked into granting it: the client
  `create` rule is still `hasOnly(['role'])` with `role == 'mobile'`, and
  `update` is still `if false`, so `admin` is only ever writable by the Admin
  SDK.
- **Account creation has to be server-side, and not for the usual reason.**
  It isn't about trust — it's that `createUserWithEmailAndPassword` signs the
  *calling tab* in as the account it just made, so an admin adding a colleague
  would be thrown out of their own session into the new person's. The Admin SDK
  has no such side effect. Listing the team is server-side for a different
  reason: `firestore.rules` deliberately lets an account read only its own
  `users/{uid}` doc, and a roster page is not a good enough reason to widen it.
- **Nobody types anybody else's password.** Adding a person creates the account
  with a random password that is never shown or stored, then the *browser* calls
  `sendPasswordResetEmail` so they set their own. That split is forced: the
  Admin SDK can generate a reset link but cannot deliver one — Firebase's mail
  sender is only reachable from a client SDK. A failed email is therefore
  reported but never treated as a failed creation, because it isn't one; the
  person is on the team and "Send password link" retries. Saying "couldn't add
  them" would send an admin back to add somebody who already exists.
- **Every function re-checks `admin` server-side.** The nav entry is hidden from
  non-admins and the page refuses to render for them, but that is courtesy — a
  check made in a browser is made on a machine the caller controls. `isAdmin` is
  kept live by a listener on the account's own `users/{uid}` doc rather than the
  one-shot read that gates sign-in, so an admin demoted by a colleague on
  another machine loses the page immediately instead of keeping a screen of
  buttons that all return "permission denied".
- **`createDashboardUser`'s rollback message is thrown as `aborted`, not
  `internal`, and the code carries meaning.** The browser deliberately replaces
  an `internal` message with something generic — that is the code the runtime
  uses for a crash it has no wording for, so its message is a stack-trace
  artefact. The rollback message is hand-written and load-bearing: "Nothing was
  created" is what tells an admin whether to add the person again, and losing it
  means they either re-add and hit "already exists" or leave a colleague off the
  team entirely.
- **Every destructive call must check that its target is a dashboard account,
  and this is not a formality.** The uid arrives from the caller, so without it
  `deleteUser`/`updateUser` would run against *any* uid in the project — a
  driver's included. Deleting a driver doesn't merely stop them signing in:
  `firestore.rules` requires `createdByUid == request.auth.uid`, so a run they
  had open could never be closed by anyone, ever, and its day would never reach
  the server. Nothing on a team-management screen should be able to reach a
  phone account. `applyTeamChange` is the single place that check lives, which
  is why all three mutations go through it rather than calling Auth directly.
- **The guards are about lockout, not permissions.** An admin cannot disable,
  demote or remove *themselves*, and none of the three may be done to the last
  remaining admin. Self-targeted actions are *hidden* as well as refused: a
  button whose only outcome is an error is a poor way to say so.

  The last-admin half is subtler than it looks, and worth understanding before
  anyone "simplifies" it. A caller is always an admin and can never target
  themselves, so the ordinary path always leaves at least the caller behind —
  one person cannot demote their way to an empty team on their own. It exists
  for the two ways round that:

  - **Two admins acting at the same moment** — A demoting B while B demotes A.
    Both read "two admins", both pass, both writes land, and nobody can manage
    the team again. This is the real one. It is why the check and the change run
    in **one Firestore transaction** that reads the admin roster: the read set
    makes the second commit retry against the first's result and refuse. A check
    followed by a separate write is a check two callers can both pass.
  - **A caller who was just disabled**, spending the last of an unexpired token
    (Firestore doesn't re-check revocation until a token is renewed). They no
    longer count as somebody who can unlock anything, which is why
    `eligibleAdminUids` counts admins who could actually *sign in* rather than
    counting documents — a disabled admin still carries `admin: true`, so a
    document count would report two administrators when only one can reach the
    page, and cheerfully let that one be removed.
- **Disable is offered alongside Remove and is usually the right one** — it
  keeps the account for someone who might return, and it revokes their tokens,
  so it is also the immediate lever when a password is thought to have got out.
  Remove is a hard delete, which is safe here in a way it is not for a store or
  a run: a dashboard account owns no records (everything it can reach is
  read-only by rule), so nothing refers back to it.
- **The first admin has nobody to create them.** `firebase/scripts/make-admin.mjs`
  (`npm run make-admin -- <email>`, or `make-admin:cloud`) is the one-time
  bootstrap: it creates or promotes an account, sets `admin: true`, and prints a
  password-setup link. Run once per project; after that the Team page covers
  everything. Against the cloud it needs Application Default Credentials
  (`gcloud auth application-default login`) — the same gcloud already used for
  `storage:cors`. It **refuses an email belonging to a mobile account**: this is
  the one script that could quietly change a role, and converting a driver would
  lock them out of the phone and strand any run they had open.

## Editing is administrators only

Every dashboard-owned list — **Bread Types** and Returned Bread Types,
**Trucks**, **Agents** and **Settings** — is *readable*
by any dashboard account and *editable* only by one carrying `admin: true`, the
same flag the Team page runs on. Staff who use the dashboard all day still see
every price, truck and receipt setting; changing them is a separate job.

- **"Copy from Bread Types" on Returned Bread Types is a mirror, not a merge.**
  It replaces the whole list with an exact copy of Bread Types — same names,
  prices, units and `order` values — and drops anything Bread Types no longer
  has. Pressing it twice changes nothing the second time. That is a reversal of
  its original behaviour, which added missing rows and re-synced positions but
  never touched an existing row's price, specifically so a saved old price
  survived; the owner asked for the exact copy instead, and the warning modal
  now says plainly that an old price saved here will be overwritten. Copy
  *before* changing a price above, not after.
  - **A surviving row keeps its own document id**, so the review modal shows a
    price change as an edit rather than a removal and a re-creation. Names are
    matched **word for word**, the same rule the Outcome table joins on, so a
    row differing only in case or spacing is dropped and re-added under the
    source's spelling with a fresh id. A name claimed by one source row can't
    be claimed again, or two rows would save over one document.
  - **Nothing is written until Confirm.** The copy only rewrites the drafts and
    moves the dropped rows into `deletedIds`; the review lists every removal.
- **The Edit button stays on screen for everybody**, and pressing it opens a
  notice explaining that an administrator has to make the change
  (`ADMIN_ONLY_NOTICE` in `src/lib/admin-gate.ts`, one wording for every
  section). Hiding the button was the obvious alternative and is worse: a
  missing button reads as a page that is broken or the wrong one, and the person
  told "the prices are on the dashboard" is left with nothing to go on. A
  disabled button is the same problem with a greyed-out shape.
- **`firestore.rules` enforces it, the browser only explains it.** Writes to all
  these collections go through `isDashboardAdmin()`, so a non-admin who bypasses
  the page still can't save. It reads the flag as `get('admin', false)` rather
  than `.admin` — a user document written before the flag existed has no such
  key, and reading a missing key is an *error*, not a false.
- **The gate is re-checked at Confirm, not only at Edit.** These pages stay
  mounted for the life of the app (see `dashboard-shell.tsx`), so an
  administrator demoted by a colleague can be sitting in edit mode when the
  flag flips. `isAdmin` is live, so the confirm says why instead of failing with
  "could not save".
- **A number field is cleaned on the way in, because React won't do it.**
  React writes a controlled `<input type="number">` back to the DOM only when
  `node.value != value`, and that comparison is loose — a new row is prefilled
  with 0, so typing 5 onto it leaves "05" in the field, which `== 5`, and React
  sees nothing to update. `handleNumberInput` in `pages/bread-types.tsx` strips
  the leading zero off the node itself. It only touches the node when the text
  actually changed, and that condition is load-bearing: half way through
  "5.25" the browser reports the value as `""` (a bare "5." is not a valid
  number), and writing that back would erase the field under the typist.
- **Deploy the rules for this to be real**: `cd firebase && npm run deploy:rules`.
  Until that runs, the cloud project still lets any dashboard account write.
  Check first that every person who is supposed to edit shows as **Administrator**
  on the Team page — the flag is what they will be judged on, and an account
  created before it existed doesn't have it.

## The Settings page

`src/pages/settings.tsx` — the three strings printed on every receipt (business
name, contact number, ending message), stored as one document at
`settings/business`.

**It follows the same edit → review → confirm workflow as every other
dashboard-owned list**, and that was a deliberate correction: it used to save
straight from the form, so Settings was the one page where a typo went to the
printer without ever being shown back. There is nothing here to add, remove or
reorder, so a "change" is simply a field whose stored value differs, and the
review lists one item per field with the old value struck through above the new.

**The review compares — and displays — what will actually be stored**, not what
was typed. `cleanBusinessSettings` (exported from `lib/business-settings.ts`,
and the same function `updateBusinessSettings` runs on the way to Firestore)
trims the fields and normalises the ending message's line breaks first.
Comparing the raw draft instead would list a re-typed trailing space as a
change, quietly clean it on save, and leave the page disagreeing with the review
the owner had just confirmed.

## One browser per account

Several people sharing one login and working at the same time is the thing this
stops. `dashboardSessions/{uid}` names the browser that signed in last; every
signed-in tab watches its own document and signs itself out when the id stops
being its own, saying why. Newest login wins, deliberately — first-session-wins
strands people out of their own account whenever a tab crashes or a laptop dies.

- **The id is per browser profile, in `localStorage` — not per tab.**
  `sessionStorage` would make a second tab look like a different browser and
  evict the first, so a manager with the Live board open beside the Team page
  would fight themselves. localStorage is shared across tabs, so tabs coexist
  and the id only differs where it should: another computer, another browser,
  another profile, a private window.
- **Rules refuse every client write to that collection.** Only Cloud Functions
  write it, through the Admin SDK. A browser that could write there could award
  itself the claim, and the whole rule would be a suggestion.
- **`claimed` is what keeps two browsers from fighting.** Each tab treats only
  the *first* mismatch it sees as an invitation to claim; every one after that
  is an eviction. Without it, two browsers would evict each other forever and
  neither person could work.
- **The claim hands back a replacement credential, and that is not optional
  bookkeeping.** `revokeRefreshTokens` is what makes this more than a UI
  courtesy — it kills the saved login in every other browser, so a tampered
  client that ignored the sign-out can't quietly keep reading. But Firebase has
  no "revoke all but this one", so it kills the caller's too, and a caller that
  lost its own login an hour later would be a self-inflicted lockout. So the
  function mints a custom token *first*, revokes second, pauses (because
  `tokensValidAfterTime` is stored to the second, and signing in during that
  same second can read as "before" it), and returns the token for the browser to
  sign in with.
- **If the token can't be minted, the revoke is skipped and the claim still
  succeeds.** `createCustomToken` needs the runtime service account to hold
  "Service Account Token Creator", which it normally does but might not — and a
  missing IAM role must never become a dashboard nobody can log in to. Session
  enforcement still works through the watched document; only the extra hardening
  is skipped.
- **The two failure points either side of the revoke are handled opposite
  ways, on purpose.** If the *claim call* fails, nothing was revoked and this
  browser's login is untouched, so the user is left working and the next reload
  tries again — a network blip must not cost somebody their session. If the
  *credential swap* fails, the revoke has already happened and this tab is
  holding a dead credential that still appears to work for up to an hour; so it
  is retried once and then the session is ended **now**, with a message, while
  there is still something on screen to explain it with. Making that one
  best-effort is how you get a user dropped mid-task with no explanation — the
  exact failure the swap exists to prevent.
- **An eviction is ignored while this browser's own claim is in flight.** Two
  browsers signing in within the ~1.5s the server spends minting a replacement
  credential would otherwise both sign out: the second one's claim lands, the
  first reads it as an eviction and quits, then the first's own claim lands and
  overwrites the document — so it names a browser nobody is signed in on, and
  the other browser was evicted by a tab that had already gone. Waiting costs
  nothing; the snapshot after ours lands settles it correctly.
- **Losing the Firestore listener never signs anybody out.** A dropped
  connection is far likelier than an eviction, and a dashboard that logs people
  out when the wifi blinks is worse than one that lets a second window live a
  little longer. The claim on the next reload settles it.
- **The Auth emulator does not enforce revocation** at its token-refresh
  endpoint, though it does record `tokensValidAfterTime` correctly. Production's
  token service enforces it. So locally the watched document is the whole
  mechanism; don't read a still-working old token on the emulator as a bug.

**Being signed out silently is indistinguishable from the app being broken**, so
the reason outlives the sign-out: `signedOutReason` on the auth context is
handed to the login page and shown above the card (`.auth-notice`). It has three
wordings, because they need different answers — the account was opened somewhere
else (naming which browser, from the label stored on the claim), access was
changed by an administrator, or the role check couldn't reach the server.

That last one is also a fix to a bug the dashboard shared with the mobile app's
documented "Launching with no internet": the `onAuthStateChanged` callback is
the only thing holding the blank pre-decision screen, and an offline Firestore
read hangs and then rejects inside an async callback with nothing above it to
catch — leaving a permanently blank page. Every path out of that callback now
settles `initializing`. **Unlike mobile, an unverifiable account is not let in
here**: on the phone the role check only routes people to the right app, while
on the dashboard it separates a driver's login from a server-side one, and the
dashboard is unusable without a connection anyway.

