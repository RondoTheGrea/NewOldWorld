# apps/mobile — the POS client (Expo)

@AGENTS.md

The React Native / Expo app the drivers carry. This file covers everything on
the phone. The monorepo-wide context — how to work with the owner, the shared
`users/{uid}` role model, and how agents are picked (no crews, no areas) — is in the
root `CLAUDE.md`. The dashboard is documented in `apps/web/CLAUDE.md` and the
backend, emulators and deploys in `firebase/CLAUDE.md`.


- **Expo SDK 57**, `expo-router` (file-based routing under `src/app/`), React
  Native 0.86, React 19, TypeScript 6.
- `experiments`: typed routes + React Compiler are **on**.
- Path alias `@/` → `src/`.
- Run: `cd apps/mobile && npm install && npm start` (then `w` web / `a` android
  / `i` ios). Lint: `npm run lint`.
- **IMPORTANT: Expo SDK 57 changed a lot of APIs. Read the versioned docs at
  https://docs.expo.dev/versions/v57.0.0/ before writing Expo code** — do not rely
  on older Expo patterns from memory.

## Navigation and screens

Four tabs behind the login, defined in `src/app/(app)/_layout.tsx`: **Home**
(`index.tsx` — the printer card, expenses, today's upload, End the Day, and the
Settings gear), **Inventory**, **Receipts** and **Customers**. Sign-in and
sign-up sit outside that group at `src/app/`, and route protection is
`Stack.Protected` guards in `src/app/_layout.tsx`.

- Tabs are **JS tabs** (`import { Tabs } from 'expo-router/js-tabs'`), not
  `NativeTabs`. One implementation covers Android, iOS and web; native tabs
  would need a duplicate `.web.tsx`. Defined in `src/app/(app)/_layout.tsx`.
- **Every tab screen wraps in `<Screen>`** (`src/components/screen.tsx`), which
  owns the top/side safe areas and centres content at `MaxContentWidth`. Pass
  `scroll` for anything that can outgrow the screen.
- Screens must **not** add bottom padding for the tab bar. The bar is a sibling
  of the screen, so the navigator already hands the screen only the space above
  it. The old hardcoded `BottomTabInset` guess was deleted — don't reintroduce
  one.
- Tab icons come from `expo-symbols` (`SymbolView` with `{ ios, android, web }`
  names) — SF Symbols on iOS, Material Symbols elsewhere. No icon files to ship.
  `expo-symbols` needs `expo-font` installed as a native peer; `expo-doctor`
  catches it if it goes missing.

## Theme

- **White only, no dark mode.** `Colors` in `src/constants/theme.ts` is a single
  flat palette and `useTheme()` returns it regardless of the device setting.
  `app.json` pins `userInterfaceStyle: "light"`, and the root layout paints
  react-navigation's own surfaces white too.
- The greys (`backgroundElement`, `backgroundSelected`, `border`) are part of the
  white theme — they're what makes an input or a selected row visible. Don't
  "finish the job" by making them `#fff`.
- The splash screen is plain white with no image, and the app hides it from
  `src/app/_layout.tsx` once Firebase has restored the session. That's the only
  place `SplashScreen.hideAsync()` is called — keep it that way so the app can't
  get stuck on the splash.

## Auth

- **Firebase JS SDK** (not React Native Firebase), so login code can be shared
  with the web dashboard later. Email/password only.
- Session **persists indefinitely** (AsyncStorage) until the user taps "Log out" —
  survives app restarts / power cycles. This is Firebase's default, not extra code.
- Key files: `src/lib/firebase.ts` (init + emulator switch), `src/context/auth.tsx`
  (`AuthProvider` / `useAuth`), `src/components/auth-form.tsx` (shared form),
  `src/app/sign-in.tsx` + `sign-up.tsx`, and route protection via `Stack.Protected`
  guards in `src/app/_layout.tsx`. The logged-in app lives under `src/app/(app)/`.
- `getReactNativePersistence` exists in the SDK's RN build at runtime but is
  missing from the published `firebase/auth` types — `firebase.ts` reaches it via a
  typed accessor. Don't "fix" it by deleting that cast.

**Launching with no internet.** `AuthProvider`'s `onAuthStateChanged` effect is
the only thing holding the splash screen, and the splash is plain white — so a
launch path that never settles doesn't look like an error, it looks like an app
that won't open. That bug shipped once: the listener awaited the `users/{uid}`
role check on every launch, and a Firestore read with no connection doesn't fail
fast — it hangs, then rejects inside an async listener callback where nothing
catches it, so `setInitializing(false)` never ran. Three rules keep it fixed:

- **Every path out of the effect calls `finish()`**, including the `catch`. The
  listener callback is a sync function wrapping its own `try`/`catch` — an
  `async` callback handed straight to `onAuthStateChanged` has nothing above it
  to reject into.
- **A confirmed role is cached in AsyncStorage** (`auth.role.<uid>`) and trusted
  without asking again. Roles are immutable by rule (`firestore.rules`), so a
  pass confirmed once is true forever. Only a *pass* is ever written, so a
  Firestore hiccup can't lock an account out offline. `signIn`/`signUp` write it
  at the one moment the answer is guaranteed available.
- **An unverifiable account is let in**, not held at a blank screen: the role
  check routes people to the right app, it doesn't protect data — rules do that
  regardless of what the app renders. Nothing is cached in that case, so the
  next launch with signal checks again.

`StartupTimeoutMs` is a backstop that shows the app anyway if the effect somehow
doesn't settle. It is not a substitute for the above — don't add a new `await`
to that path and lean on it.

**Logging out is blocked while a run is open** (`src/app/(app)/index.tsx`), and
that guard is load-bearing rather than tidy. Signing out doesn't end a run — the
setup survives it — so a second account inheriting an open run would upload
documents stamped `createdByUid` = the account that *started* it, which
`firestore.rules` rejects because that field must equal the signed-in uid. Every
receipt, ledger entry and the closing write would fail permanently, and since
closing needs an empty queue the day could never be finished. There is no
in-app way out of an abandoned run at the moment — Settings' "Reset truck
setup" was that way out and is a developer-testing row that is currently
removed (see "The Settings sheet" in this file).

## Which backend the app talks to

`src/lib/firebase.ts` picks between the local emulators and the real cloud
project. `auth`, `db` (Firestore), `functions` and `storage` are all switched
together — **if you add a new Firebase service, wire its emulator connection in
the same block**, or it will silently read/write production while everything
else is local.

    npm start            # emulators (default)
    npm run start:cloud  # real newoldworld-b8f5d

The switch is `usingEmulators = __DEV__ && EXPO_PUBLIC_USE_EMULATOR !== 'false'`:

- `__DEV__` is false in any release build, so **a shipped app can never point at
  localhost**, whatever `.env` says. Keep that guard.
- `EXPO_PUBLIC_USE_EMULATOR` lives in `apps/mobile/.env`; `npm run start:cloud`
  (`scripts/start-cloud.mjs`) sets it to `false` for that process only — inline
  `VAR=x npm start` is not valid PowerShell, hence the wrapper script.
- Expo inlines env vars at build time and **only recognises literal
  `process.env.EXPO_PUBLIC_X`** — don't destructure or index them dynamically.
- After editing `.env`, fully reload the app (`r` in the Expo terminal).
- Cloud config lives in `.env` as `EXPO_PUBLIC_FIREBASE_*`, committed on purpose:
  these identify the project, they don't grant access — rules do. **Real secrets
  must never use the `EXPO_PUBLIC_` prefix**; they belong in Cloud Functions.
- The startup log line says which backend is live. `start:cloud` fails with
  instructions if the `REPLACE_ME` placeholders in `.env` haven't been filled in.

## App Check

The Firebase config shipped in the app is meant to be public (see above), which
means anyone can call Firebase's Auth/Firestore REST APIs directly with no app
involved at all — and one bot did, on 2026-08-23, signing up `@example.com`
accounts and writing a fabricated `runs` document straight through the API
(see `firestore.rules`' `isDisposableEmail()` and the memory of that incident).
The disposable-email filter blocks that one pattern; App Check is the real
fix — it requires every request to prove it came from a genuine, unmodified
build of this app on a real device, which a script cannot produce however
correct its credentials are.

- **Android only, via Play Integrity.** No iOS build exists yet (`app.json`'s
  `ios` block has no `bundleIdentifier`), so there's nothing to attest there.
- **`@react-native-firebase/app` + `@react-native-firebase/app-check` are used
  SOLELY to obtain the Play Integrity attestation token** — Auth, Firestore,
  Functions and Storage all still go through the Firebase JS SDK, per the "not
  React Native Firebase, so login code can be shared with the web dashboard"
  decision above. That decision is about app logic, not attestation; the
  native token is handed to the JS SDK's own App Check via a `CustomProvider`
  in `src/lib/firebase.ts`, which is Firebase's documented bridge for exactly
  this hybrid setup. Don't "simplify" by moving Auth/Firestore calls onto
  RNFirebase — that would undo the shared-with-web-dashboard reasoning.
- Needs `apps/mobile/google-services.json` (from Firebase console) and the app
  registered in Firebase console → App Check with the Play Integrity provider,
  which also needs the app to exist in Google Play Console (even just Internal
  Testing) so Play can confirm the package name + signing cert. Like the
  release keystore and `.env`, this repo commits it on purpose (private,
  solo-dev repo, used for backup) rather than gitignoring it — nothing in
  `apps/mobile/.gitignore` excludes it, and that's deliberate, not an
  oversight.
- **`__DEV__` chooses debug vs. Play Integrity provider, not `usingEmulators`.**
  Play Integrity only validates on a build Play actually knows about (an
  Internal Testing download, or later a production one) — a local dev-client
  build never qualifies, whether it's pointed at the emulators or the real
  cloud project. The debug token lives in `.env` as
  `EXPO_PUBLIC_APP_CHECK_DEBUG_TOKEN`, registered once in the console under
  App Check → Apps → manage debug tokens; left blank it's a no-op locally
  (see below), never a crash.
- **App Check init failing is never fatal.** The whole block in `firebase.ts`
  is wrapped in try/catch and just warns — App Check isn't enforced yet (see
  below), so a phone that can't attest today works exactly as it did before
  this existed. Keep that non-fatal shape; don't let a missing
  `google-services.json` or a bad debug token block app startup.
- **Enforcement is a Firebase console toggle, off by default, flipped
  separately from any app release.** Rollout is: ship this change, watch the
  App Check console's verified-token percentage for a few days as people
  update, then enforce Firestore/Storage once it's consistently high. Flipping
  it on doesn't touch any existing account or stored data — it only rejects
  future *requests* that arrive without a valid token, which is why an old
  build not yet updated is the only real risk, not anything already in the
  database. Enforcing App Check on Authentication itself (the layer that
  would have actually stopped the original bot sign-ups, since it sits in
  front of account creation) is a further step to evaluate once Firestore/
  Storage enforcement is stable — check the console for any Identity Platform
  upgrade implications first rather than flipping it blind.
- **Whether a given phone attests is checked from the phone, not the console.**
  The App Check console's verified percentage is a fleet figure with strangers
  mixed into it: it counts every request naming this app's Firebase app id, and
  that id ships inside the APK, so the bot traffic that prompted all of this is
  counted there too. Firestore and Storage can't be asked either — they allow or
  deny and say nothing about why. Cloud Functions is the one product that hands
  back the verification *result*, so `appCheckStatus`
  (`firebase/functions/src/index.ts`) exists to be called from Settings' "Check
  this phone's security token" row before enforcement is flipped on.
  **`enforceAppCheck: false` on it is the mechanism, and it reads backwards:**
  with enforcement on, an unattested request is rejected before the body runs
  and the caller learns only that something failed — indistinguishable from bad
  signal. With it off, the runtime still verifies a token when one is present
  and populates `request.app` only for a valid one, so `request.app !==
  undefined` is Google's verdict rather than ours. Enforcement is per-product
  but the token is not, so a phone Functions verifies is one Firestore and
  Storage will verify. `lib/app-check-status.ts` settles the two cases that
  would otherwise read as failures on a healthy phone *before* spending a
  request — the emulators don't implement App Check at all, and App Check may
  never have initialised on this device — because a false alarm here is the
  thing the row exists to remove. Only worth running on an Internal Testing
  download or later: `__DEV__` sends a local build to the debug provider.
- **Never pass `forceRefresh: true` to the *native* App Check token call.**
  Play Integrity attestations are "classic requests": throttled per app instance
  and capped at 10,000 a day for the whole app. The native SDK caches a token
  for an hour, and forcing a refresh on every `CustomProvider.getToken` threw
  that cache away, so every JS-side token request became a fresh attestation.
  On a correctly configured project that surfaces as
  `[appCheck/token-error] com.google.firebase.FirebaseException: Too many
  attempts` — which reads exactly like a broken registration and is not one.
  The `getToken(..., false)` in `firebase.ts` is deliberate; the JS SDK only
  calls it when its own cache has run out, which is the once-an-hour intended.
  Forcing at the *JS* layer (`appCheckTokenObtainable`) is still right and
  costs nothing, because it now resolves against the native cache.
  `isAttestationThrottled` exists so a throttle is worded as confirmation the
  setup works rather than as a fault, and the Settings probe asks one layer
  once — probing native *and* JS spent two attestations per tap, which is how a
  diagnostic came to cause the fault it was written to explain.
- **A blocked upload is never allowed to be App Check's fault.** Once
  enforcement is on, a request that can't attest is rejected by Firestore with
  `permission-denied` — byte-for-byte the same error the security rules raise
  for a real refusal (wrong `createdByUid` on an abandoned run). Cloud Storage
  says `storage/unauthorized` for the same event, and the proof photo is the one
  upload that goes there, so both codes are in `AppCheckDeniableCodes`. The
  upload queue treats the two causes opposite ways: a rules refusal is set aside
  as `'blocked'` so "End the Day" can still close; an App Check refusal is
  retried, because the row is fine and the phone only needs to reach Google
  Play. So before such a row is quarantined, `isRecoverableAppCheckDenial`
  (`lib/sync.ts`) settles which it is: a *recent* attestation miss — recorded by
  the `CustomProvider.getToken` catch in `firebase.ts` — answers for free,
  otherwise it force-refreshes a token via `appCheckTokenObtainable`
  (`firebase.ts`) and, if none can be had, the refusal was App Check's. In that
  case the pass stops with `AppCheckUnverifiedError` (nothing set aside, worded
  "find a stronger signal" not "ask for help") and the row stays queued. A
  genuine rules refusal — token obtainable — is quarantined exactly as before,
  which is what still lets a day close over one permanently-poisoned row.

  Four things about that probe are load-bearing, and three of them are ways it
  went wrong before:

  - **During the day the excuse never runs out; at close it is bounded.** That
    split (`closingRun` in `context/sync.tsx`) is the shape of the whole thing.
    Nothing is waiting on a queued row during the day, so a row the phone
    couldn't attest for is left queued and retried on the next pass,
    indefinitely, with nobody asked to press anything — setting it aside would
    be a lie about a healthy row. At close a row *does* block something: the day
    cannot end while anything is queued. And while attestation is down, "App
    Check turned a good row away" and "the rules will refuse this row forever,
    on a phone that also can't reach Play" are indistinguishable — so an
    unbounded excuse there is a queue that never empties and a **day that can
    never be closed**. `quarantineIfHopeless` therefore spends one of the row's
    `sync_attempts` per stall *while closing* and sets it aside after
    `MaxUploadAttempts`. "End the Day" lets those deliberately-no-progress
    passes run (`stalledOnAppCheck` in its loop) rather than breaking on the
    first, or a driver would have to tap "Try again" five times to close a day
    over one stuck row.
  - **A row set aside for App Check comes back on its own.** It is `'blocked'`
    in the database like a refusal, but it is not one — it was a good record on
    a phone that briefly couldn't prove it was a real phone, and it is owed a
    retry rather than someone's attention. `appCheckQuarantined` records that
    the queue holds at least one, and the next pass that finds `appCheckHealthy`
    puts them all back (`requeueBlocked`, the same call behind Settings' "Try
    sending refused records again", so the two can't drift). Only a genuine
    refusal is left waiting for a person. Without this, the one case where the
    phone knows the row is fine would be the one case a driver had to go and
    find a button for.
  - **The probe asks the JS SDK, not the native one.** The request that failed
    carried (or failed to carry) a token from `firebase/app-check`; the native
    module is only that layer's supplier. When the `CustomProvider` throws, the
    JS SDK enters its own backoff and keeps sending requests *without* a token
    for minutes, and it throttles itself the same way when the App Check backend
    rejects an exchange — both invisible to a native probe, which would answer
    "obtainable" while every real request was still going out unattested and
    quarantine a good row on the spot. `jsAppCheck` is kept for this;
    force-refreshing it also repairs the cached token, so the next attempt
    carries one.
  - **A successful attestation is cached for `AppCheckProbeCacheMs`.** The probe
    runs on *every* refusal, and a drain quarantining twenty-five refused rows
    would otherwise force twenty-five attestations a pass, every minute, against
    a Play Integrity quota that is per-app and finite. A failure needs no cache
    of its own — it sets `lastAppCheckFailureAt`, which the next call
    short-circuits on.
  - **The emulators are exempt** (`appCheckInPlay`), because they don't enforce
    App Check at all — against them a `permission-denied` is *always* the rules.
    Without that, local development is actively misleading: a dev build attests
    with the debug provider, which fails outright whenever
    `EXPO_PUBLIC_APP_CHECK_DEBUG_TOKEN` is blank or unregistered, so every rules
    refusal you were trying to test would be excused as an App Check blip. A dev
    build pointed at the *cloud* project is deliberately not exempt —
    enforcement is per-product for the whole project, so that build is subject
    to it like any other.

  The whole probe is also gated on `appCheckReady` (`firebase.ts`), false
  whenever `initializeAppCheck` didn't complete, so a device with no App Check
  in play treats every refusal as the rules, unchanged.

  **Two writes have no row behind them and so miss all of that** — the run
  header and the closing manifest. There is no `sync_state` to set aside and no
  attempt count to spend; they are simply retried until they land. Both go
  through `withAppCheckWording` (`lib/sync.ts`), which changes nothing but the
  wording: an App-Check-caused refusal is re-thrown as `AppCheckUnverifiedError`
  instead of surfacing as Firestore's "Missing or insufficient permissions".
  Without it those two are the one path where the driver is sent to the server
  over something only a better signal fixes — and it is not a corner case, since
  a run opened offline ("Use saved copy" at setup) has an unsent header, and the
  pass writes the header *before* the drains, so on a phone that can't attest it
  is the first thing refused and the only thing the driver hears about.

## Inventory ledger

`lib/stock-db.ts` is an append-only ledger — the initial count plus every entry
since, never a single mutable number. "Append-only" here still supports taking
stock *away*: a sale is stored as an entry with negative quantities, so summing
the ledger subtracts it for free.

The consequence that shapes the code: **`recordSale` appends an entry for every
finalized receipt, so the ledger grows for the life of the app.** It is
therefore never loaded whole.

**Everything in the ledger is scoped to a run** (`run_id` on `stock_batches`,
`stock_batch_items` and `stock_meta` — see "Sync" below). "What's on the truck"
means "what this run put on it", which is what lets "End the Day" hand back an
empty truck *without deleting anything*: the next run simply has no entries
yet, while the previous run's are still there and still queued to upload.
Deleting would be the obvious implementation and the wrong one — it would
destroy exactly the rows that hadn't uploaded. `resetStock()` is still a real
wipe; nothing on the normal daily path is, and nothing in the shipped UI calls
it — see "The Settings sheet" below.

- **Current stock is summed in SQL**, not in JS —
  `SELECT bread_type_id, SUM(quantity) ... WHERE run_id = ? GROUP BY
  bread_type_id` returns one row per bread type however many hundreds of
  thousands of entries exist behind it, and
  `idx_stock_batch_items_run_totals(run_id, bread_type_id, quantity)` covers it
  so SQLite answers from the index without touching the table. That is also why
  `run_id` is repeated on `stock_batch_items` instead of being read through a
  join to `stock_batches` — the join would give up the covering index on the one
  query that must stay cheap forever. `context/stock.tsx` keeps only that result
  and folds each new entry into it (`applyBatch`). An earlier version read every
  batch and every item into memory and added them up on each app start; that is
  the one thing that got slower every day of use.
- **History is a different query from totals.** The history view only ever
  shows `'initial'` and `'addition'` entries, so sales are filtered out in SQL
  (`idx_stock_batches_run_kind_created`) rather than fetched and discarded, and
  only the most recent `HistoryAdditionLimit` additions are loaded — the initial
  count is always included on top, so history still opens on "Initial
  inventory" however long the truck has been running. Older additions are still
  in the database and still counted in the totals; they just aren't paged
  through.
- **Nothing is shown until it belongs to the run that's open.**
  `context/stock.tsx` tracks `loadedRunId` and masks the numbers until it
  matches `runId`. Without it, the instant a new run opens the previous run's
  stock is still sitting in state and would be rendered as the new truck's —
  a wrong number, which is worse than a spinner.
- `components/inventory-history-modal.tsx` pages with a `FlatList`, not a
  horizontal `ScrollView`, so only the pages either side of the current one are
  mounted. Its dot row switches to an "n of m" counter past `MaxDots`.

## Dates and the business day

Every timestamp the app stores is `Date.now()` — epoch milliseconds, an
absolute instant with no timezone in it. That is deliberate and correct: it is
a *moment*, not a date. Turning one into a date means picking a timezone, and
picking the wrong one is how a POS files a morning's work under yesterday.

**`lib/business-day.ts` is the only place allowed to answer "which day is
this?"** The distributor operates in the Philippines, so the business day is
always an `Asia/Manila` day (UTC+8, no daylight saving):

- A receipt written at 6:30 AM Manila is 10:30 PM UTC *the previous day*. Any
  code that groups by UTC — `toISOString().slice(0, 10)` is the usual culprit —
  puts every sale before 8 AM into the wrong day. On a bread truck that starts
  before dawn, that is most of the route.
- Reading the day off the *device* is no safer: a phone with auto-timezone off,
  or a tablet with no SIM that falls back to UTC, disagrees with the phone
  parked next to it.

So for anything that decides what a day *contains* — a daily stock reset, a
day's sales total, "has this store been visited today" — use `businessDayKey`
(or `isSameBusinessDay`). Never `getTimezoneOffset()`, never
`toISOString().slice(0, 10)`, never `new Date(ts).getDate()`. **This matters
most for features that don't exist yet:** the app currently has no day-boundary
logic at all, and inventory is only ever cleared by the explicit Settings
action — a daily-reset feature or a dashboard sales report is exactly where a
UTC day boundary would start wiping stock that was just counted.

The printed receipt's date/time (`formatBusinessDate` / `formatBusinessTime`,
used by `lib/receipt-print.ts`) is pinned to Manila for the same reason: it is
the copy the customer keeps, and a mis-set phone would otherwise print every
early-morning receipt dated the day before with nothing on the paper to reveal
it. Purely **cosmetic** on-screen timestamps (the receipts list, the "saved
copy" badge, an expense row, "last checked" on the upload card) deliberately
stay on the device's own locale and timezone — nothing is filed by them, and
showing a driver their own clock is friendlier.

All of them go through **`lib/device-time.ts`** (`formatDeviceTime` for a time
alone, `formatDeviceDateTime` for date-and-time), and that file exists because
they didn't: the same `toLocaleString` options were copy-pasted into six
screens, none of them passing `hour12`, so every one of them rendered "14:32"
on a phone set to 24-hour while the printed receipt beside it said "2:32 PM".
**12-hour is the one thing not left to the locale** — the distributor reads
clocks in AM/PM. A new screen showing a timestamp calls one of these two rather
than reaching for `toLocaleString` again.

`business-day.ts` degrades to the device timezone if the JS engine ships
without a timezone database, so a missing tz database can't crash a print.

## Receipts

- SQLite-first (`lib/receipt-db.ts`, `receipts.db`), same draft-then-finalize
  shape as the Inventory ledger (`lib/stock-db.ts`): a receipt is created as a
  freely-editable **draft** and only deducts truck stock once **finalized**.
  The phone stays the source of truth; finalized receipts are also uploaded to
  Firestore in the background — see "Sync" below. Drafts never leave the phone.
- **A receipt line can never be negative, and an order line can never exceed
  what the truck is carrying.** Enforced in three places, because the
  `QuantityStepper` on screen is a convenience and not a guarantee: it caps
  typing and tapping at what's available, but **a draft is not scoped to a
  run**, so one written yesterday against a full truck can be re-opened today
  against an empty one. `assertValidReceiptLines` (`lib/receipt-types.ts`) runs
  inside `createDraft`/`updateDraft` in `lib/receipt-db.ts` before the database
  is even opened — quantities must be whole numbers above zero and within
  `MaxLineQuantity`, and unit prices must be finite and non-negative, since a
  negative price turns an order line into a discount. `assertOrderFitsStock`
  (`context/receipts.tsx`) runs on both draft writes against
  `stock.displayStock` — the count the driver just worked from — and again in
  `finalize()` against `stockDb.loadRunTotals(runId)`, the ledger on disk, which
  is the last gate before `recordSale` would drive a run's totals negative.
  Every one of them refuses *before* anything is written, so the receipt stays
  an editable draft and the truck count is untouched — which matters, because
  nothing in the app raises a count back except a real delivery. Both
  `InsufficientStockError` and `InvalidReceiptLineError` are in the callers'
  `retryable` exceptions: a second identical attempt submits the same numbers.
  Returns are deliberately **not** checked against stock — a return never puts
  bread back on the truck, so there is nothing for it to exceed. On the
  inventory side, `saveDraft` in `lib/stock-db.ts` floors and clamps the initial
  count the same way (`sanitizeCounts`) and **returns the counts it wrote**, so
  the Inventory tab can't show a number the disk disagrees with — that number is
  the one every receipt is measured against.
- **Returns are a write-off only.** The `returnedBreadTypes` Firestore
  collection (an old-price catalog, mirrored locally by
  `context/returned-bread-types.tsx`) has no link back to a `breadTypeId`, so
  a return reduces what a store owes on the receipt but never adds bread back
  to truck stock.
- **The Run outcome table folds returns in by *name*, and that is the only
  join available.** Home → Run history → a run opens
  `components/run-history-modal.tsx`; its **Run outcome** table is built by
  `lib/run-outcome.ts`. Sold and remaining come off the snapshot keyed by
  `breadTypeId`, but a returned line's id belongs to `returnedBreadTypes` (see
  `summarizeRunHistoryForRun` in `lib/receipt-db.ts`) and can never equal a
  bread type's — so keying rows on the id put "Pandesal sold 40" and "Pandesal
  returned 5" on two separate lines, each telling half the story. Rows are
  keyed on the name instead.
  - **The match is word for word.** The same name is the same row; anything
    spelled even slightly differently is a different bread with a row of its
    own. Fuzzy matching would quietly fold two names a manager typed on purpose
    into one line — a stray-space name showing up as its own row at the bottom
    is visible and fixable, a silently merged figure is not.
  - **Ordering takes both catalogs.** Bread Types is the reference; a
    returned-only bread (one no current bread type is named after) sorts
    *directly below* the bread type holding its position, using the `order`
    value the two collections share (the dashboard's "Copy from Bread Types"
    copies it verbatim). A name in neither catalog sorts last, alphabetically.
  - **The dashboard has the same table under the same rules**, in
    `apps/web/src/lib/run-outcome.ts`. The two files are deliberate copies
    while `packages/shared` is empty — the inputs differ (this reads the saved
    history snapshot, that reads the uploaded run) but the joining and ordering
    must not. Change one, change the other.
  - The **Inventory** table in the same modal is still keyed by `breadTypeId`
    and ordered by `useBreadTypeRank`. It never touches returns, so it has
    nothing to fold.
  - **"Show dates & times" above that table** adds each load's date and time
    (device clock, `formatDeviceDate` + `formatDeviceTime`) under Initial and
    every Batch heading; one tap shows, one hides, hidden each time a run is
    opened. The initial count's time is `initialCreatedAt` on the snapshot
    (`initial_created_at` column, nullable, not backfilled) — an older
    snapshot reads null and `loadDetail` looks it up in the ledger. Batch
    columns are ordered **oldest first** at render, so Batch 1 is the first
    top-up as on the dashboard, even though the snapshot stores them newest
    first.
- **Who was on the truck is snapshotted onto the receipt at finalize**, as the
  agents' names comma-separated (`agent_names` / `agentNames`, receipts.db
  user_version 11), and printed under the payment method as **"Agents:"** on
  the customer's copy. It is a snapshot for the same reason `customerName` and
  every item's `name` are: renaming an agent next week must not contradict a
  receipt somebody is holding.

  It replaced a crew-name snapshot (`agent_group_name`, user_version 9) when
  crews were removed. That column is still on the table and no longer read or
  written; receipts finalized while crews existed therefore print and show no
  agents line on the phone (the dashboard still reads their uploaded crew name
  as a fallback). **Nothing is backfilled**, and no row's `sync_state` is
  touched by either migration — re-sending every past receipt to add one field
  is a lot of traffic from a phone in a truck. Drafts have no names either — a
  receipt isn't filed under a run until it is finalized — which never shows,
  because Preview and print are finalized-only.
- **A finalized receipt can be voided — only from the run that is open, and
  only a receipt from that run.** The owner's rule, and it is enforced three
  times: the detail modal only shows **Void** when `runId` is set and equals the
  receipt's `runId`; `voidReceipt` (`context/receipts.tsx`) re-checks both from
  disk and throws `CannotVoidReceiptError` (reported once, not retried); and
  `markVoided`'s SQL carries `run_id = ?`. Once a day is ended its numbers are
  in the manifest, so a void afterwards would be a change nobody at the depot
  sees — corrections to a finished day go through the server.
  - **A void is a column, not a status** (`voided_at`, receipts.db
    user_version 10). The receipt stays `'finalized'`, keeps every field, stays
    in the list and uploads like any other; the CHECK constraint on `status`
    would have needed a table rebuild on the one table that holds every receipt
    ever written.
  - **What it does:** the receipt is struck through with a red **Void** tag in
    the list and a red banner in the detail modal; Preview (the only way to
    print) stays on screen but grayed — a tap opens a "Can’t print this receipt"
    notice and a note under it says voided receipts can’t be printed — and `receipt-print-preview-modal.tsx` refuses a voided
    receipt as a backstop; it is left out of `summarizeFinalizedForRun`'s money
    and count (the manifest gains `voidedReceiptCount`) and out of every Run
    history figure.
  - **Its bread goes back on the truck** as a new ledger kind, `'void'`
    (`recordVoid` in `lib/stock-db.ts`, id `void_${receiptId}`), quantities
    positive. It returns exactly what the receipt's **sale entry** took off, not
    what the receipt lists — a finalize whose deduction was skipped took
    nothing, so nothing is given back. `'void'` rather than `'addition'` because
    the dashboard counts an addition as bread *loaded*; a void takes loaves back
    off *sold*. Allowing the kind meant rebuilding `stock_batches` under a wider
    CHECK (`migrateVoidBatchKind`, stock.db user_version 8), the same rebuild
    `'sale'` needed.
  - **Same order and same retry shape as finalize:** receipt marked voided
    first, stock second with its own "Skip" prompt
    (`voidStockUnsettledMessage`). A crash between leaves a count that reads
    *low* against a receipt that says why. Re-running the whole void takes the
    already-voided path and only finishes what's left; `recordVoid` is
    idempotent on its derived id.
  - **A skipped stock step is finished at "End the Day".** The Void button is
    gone once a receipt is voided, so "Skip" used to be final: the loaves stayed
    *sold* on the dashboard and in both exports for good. `returnVoidedStock`
    (`context/receipts.tsx`) runs first thing inside the End the Day action
    (`end-day-card.tsx`): every voided receipt in the open run with a `'sale'`
    entry and no `'void'` entry (`findVoidsNotReturned`) gets `recordVoid`,
    through the stock context so the Inventory count moves too. The entries
    queue like any other, so the close uploads them before the day can end. A
    failure throws into the ordinary "Could not end the day" retry prompt. It
    lives in the receipts context, not in `endTheDay`, because `SyncProvider`
    sits *above* `StockProvider` and can't reach its totals.
  - **The upload is re-queued** — the server almost always has the receipt
    already. `markVoided` flips only a `'synced'` row back to `'pending'`, and
    `markReceiptSynced` is now **guarded on the `voidedAt` that was sent**, so a
    receipt voided while its un-voided copy is in the air stays pending and
    goes up again rather than being marked delivered.
- **Finalize order matters.** `context/receipts.tsx`'s `finalize()` marks the
  receipt finalized in `receipts.db` *before* deducting stock via the stock
  context's `recordSale()` in `stock.db` — two separate SQLite transactions,
  not one (the two databases are separate files, so there's no single
  connection to make it one atomic transaction). That order means a crash
  between the two steps leaves a finalized receipt whose stock hasn't caught
  up yet — a count that reads high, with a receipt on record saying why —
  instead of the worse failure mode: a still-"draft" receipt that gets
  finalized twice and silently double-deducts stock. Note "visible", not
  "fixable": nothing in the app lowers a count except a sale entry, so the
  mismatch is reconciled off the phone, not corrected on it.
- Receipts are expected to accumulate far beyond inventory batches or
  customers, so the receipts screen only ever loads paginated summary rows
  (a keyset cursor on `created_at`, not `OFFSET`, so paging stays cheap at
  scale) — full items/returns are fetched on demand for one receipt at a
  time, never joined into the list query.
- **The paging query's shape is load-bearing.** The cursor is written as a
  row-value comparison, `WHERE (created_at, id) < (?, ?)`, and there is a
  composite `idx_receipts_list ON receipts(created_at DESC, id DESC)` matching
  the `ORDER BY` exactly. The equivalent-looking
  `created_at < ? OR (created_at = ? AND id < ?)` selects the same rows but
  SQLite can't seek with it — `EXPLAIN QUERY PLAN` drops from `SEARCH ... USING
  INDEX idx_receipts_list ((created_at,id)<(?,?))` to a full `SCAN`, which is
  the opposite of the point of keyset paging. Don't "simplify" it back.
- `findDraftReceipt()` runs on every "New receipt" tap and its usual answer is
  "no draft", which without an index means reading every receipt ever written
  to say so. `idx_receipts_draft` is a **partial** index (`WHERE status =
  'draft'`) so it holds at most one row.

## Proof-of-payment photos

A GCash or cheque receipt can carry one camera photo (`lib/payment-proof.ts`),
copied out of the picker's cache into the app's document directory so it
survives a restart. Two things keep it from eating the phone:

- **The photo is resized before it is stored** (`MaxProofEdgePixels`, 1280 on
  the longest edge, via `expo-image-manipulator`). The picker's `quality`
  option only changes JPEG compression, not pixel dimensions — an untouched
  12MP capture lands at 1–3 MB, and these are only ever viewed in a modal on a
  phone screen. A failed resize falls back to the original rather than losing
  the photo the user just took.
- **`deleteAllPaymentProofs()` runs alongside `resetReceipts()`.** Wiping only
  the database rows would strand every photo on disk with nothing in the app
  able to reach or delete it — invisible files that only grow.

**The photo uploads too** — it is the one thing in this app that sends *bytes*
rather than a document, and the only reason Cloud Storage is enabled at all. It
rides the ordinary sync queue: `receipt_payment_proofs` carries the same
`sync_state` / `sync_attempts` columns every other uploadable row has, and
`drainPaymentProofs` in `context/sync.tsx` uses the same `uploadOrSetAside`,
the same blocked-and-retry path, and the same "End the Day" gating. Five things
are specific to it:

- **The object path is derived from the receipt id** —
  `paymentProofs/{receiptId}.jpg`, minted by `paymentProofPath` in `lib/sync.ts`.
  That is the Storage equivalent of `setDoc` at a known id: re-sending
  overwrites the same object instead of leaving a second copy, which is what
  makes "just try again" safe. A random name per attempt would strand orphaned
  megabytes nobody can find.
- **`proofStoragePath` is only ever written after the bytes land.** The receipt
  document was almost certainly uploaded long before the driver took the photo,
  so `markPaymentProofSynced` flips a `'synced'` receipt back to `'pending'` and
  it re-uploads carrying the path. Nothing else would ever queue it again.
  Because the path is written last, the dashboard can treat a non-null one as a
  promise that the object exists — never assemble it from the receipt id on the
  reading end.
- **It drains last**, after receipts, the ledger and expenses. Every drain stops
  the pass at the first transient failure, so the order is the order things
  reach the server on a dying signal, and a 150 KB photo ahead of the day's
  takings is the wrong thing to spend it on.
- **Its timeout is its own** (`UploadTimeoutMs`, 90s, against `CallTimeoutMs`'s
  12s). A photo is two orders of magnitude bigger than a receipt document; 12
  seconds would classify a perfectly good upload as "no signal" and re-send the
  same bytes forever.
- **The photo is handed to `uploadBytes` as a React Native `Blob`, never as a
  `Uint8Array`,** and that is a hard constraint rather than a preference.
  `uploadBytes` assembles its multipart body with
  `new Blob([header, payload, footer])`, and RN's Blob refuses to be built from
  an `ArrayBuffer` or a typed array — `BlobManager.js` throws "Creating blobs
  from 'ArrayBuffer' and 'ArrayBufferView' are not supported". Passing bytes
  therefore fails *inside* `uploadBytes`, which reads as a Storage or rules
  problem when it is neither. This was tried with `File.bytes()` first and
  didn't work; don't reintroduce it. `expo-file-system`'s `File` is not a legal
  part either, despite implementing the `Blob` interface — RN checks
  `instanceof`. `readFileAsBlob` uses XHR rather than `fetch(uri).blob()` to
  skip the `Response` layer that has a history of getting `file://` wrong on
  Android, and the blob it returns is file-backed, so a photo never occupies
  the JS heap twice. It is `close()`d after the upload because RN blobs hold a
  native allocation the GC doesn't track.

`storage.rules` mirrors `firestore.rules`: reads open to any signed-in account
(the dashboard has to resolve a photo some other phone uploaded), writes limited
to the account whose work it is via a `createdByUid` **custom metadata** field,
`update` allowed alongside `create` so retries aren't rejected, and `delete`
refused outright. Storage rules default-deny, so there is no catch-all block at
the bottom of that file and none is needed.

The receipt detail modal shows where the photo has got to (`describeProofSync`)
rather than only that a file exists — the driver is the only person who can act
on a photo the server hasn't got, and it re-reads whenever the pending-photo
count moves so the line updates while the modal is open.

## Expenses

What the truck spent on a trip out — fuel, a toll, the agents' lunch. A title, an
amount, and optional notes, and nothing else. The amount may be **₱0** (the
owner's call), but it can't be left blank — a blank is a forgotten amount. It shares its Home card and sheet
with the **cash count** — see the subsection below. `lib/expense-types.ts` (shape +
sanitizer), `lib/expense-db.ts` (+ `.web.ts` stub, `expenses.db`),
`context/expenses.tsx`, and two components: `components/expenses-card.tsx` on
Home and `components/expenses-modal.tsx` behind it.

**It is informational, and that is the whole design.** Nothing subtracts an
expense from anything: not a receipt, not the day's takings, not the run
manifest's `salesTotal`, not a truck's metrics on the dashboard, not the Trends
charts. The dashboard shows it in its own section of the run panel, beside the
takings rather than inside them, and both surfaces say so in words on screen —
a peso figure under a day's sales invites exactly the assumption the feature
doesn't make. Making expenses affect a total is a decision for the owner, not a
subtraction somebody adds because it looked obvious. `totalExpenses` on the web
side is deliberately its own function returning its own type rather than a field
on `ReceiptTotals`, so it isn't one keystroke away from every net on the page.

- **Scoped to the run, like the ledger.** "End the Day" hands the next trip a
  clean sheet because the next run has no expenses yet — not one row is deleted,
  so anything still queued keeps uploading into the run it was written in.
  `context/expenses.tsx` masks the list on `loadedRunId` for the same reason
  `context/stock.tsx` does: showing the previous run's spending as this trip's
  is worse than a spinner.
- **On Home, not in the tab bar.** An expense is recorded a handful of times a
  trip, which doesn't earn a fifth tab beside four screens that are worked
  continuously. It sits with "Today's upload" and "End the day" because those
  three are one subject: how this trip is going.
- **Deletes are soft** (`deleted = 1`, `updated_at` bumped, back to
  `'pending'`), because `firestore.rules` refuses every delete under `/runs` —
  a row vanishing here would leave the server holding an expense nothing ever
  retracts. Same reasoning as a deleted store.
- **`markExpenseSynced` is guarded on `updated_at`**, unlike the ledger's and
  receipts' — an expense can be deleted while its previous version is still in
  the air, and an unguarded mark would record the *deletion* as uploaded when
  what actually landed was the version before it.
- **The two manifest figures count different sets on purpose.**
  `expenseCount` includes deleted rows — it counts *documents sent*.
  `expenseTotal` excludes them — it counts *money spent*.
- The Add button mints one `expenseId` per press and reuses it for every retry,
  the same key-the-user's-action rule `addBatch` follows: two identical ₱50
  tolls in a day are ordinary, so nothing in the row can tell a repeat from a
  second expense.

### The cash breakdown (shares the card)

Called **Breakdown** on screen (tab, card row, buttons); "cash count" in the
code.

The bills the driver is actually holding: how many ₱1,000 / ₱500 / ₱200 /
₱100 / ₱50 / ₱20, plus coins as **one peso amount** (nobody counts ₱1 coins one
by one). `lib/cash-count.ts` (shape, caps, total), a `cash_counts` table in
`expenses.db` (`loadCashCountForRun` / `saveCashCountForRun`),
`components/cash-count-panel.tsx`, and the same `ExpensesProvider`.

- **One card, two halves.** Home had no room for another card, so the owner
  asked for the count to share the Expenses one. The card (and the sheet) is titled
  **Breakdown & Expenses** and has a tappable row for each ("Breakdown", "Expenses"); each
  opens the same sheet on its own tab. The file names (`expenses-card.tsx`,
  `expenses-modal.tsx`) were kept to keep the diff small.
- **The comparison is why they belong together.** The panel shows *Cash from
  receipts* (cash receipts + down payments on partial ones, read with
  `summarizeRunHistoryForRun`), *minus expenses*, and compares what's left with
  the counted Total. Subtracting expenses is
  deliberate — a diesel stop paid out of the bag is the commonest reason the bag
  is light — and it is **arithmetic on that screen only**. It does not touch a
  receipt, the takings, the manifest or anything on the dashboard; the
  "expenses are informational" rule above still holds everywhere else.
- **One count per run, overwritten on save** — a snapshot of the bag, not a log.
  An upsert keyed on `run_id`, so a retried save is harmless. Scoped to the run
  like everything else, so "End the Day" hands the next trip a blank count.
- **A draft until "Save breakdown"**, with no confirmation (it stays freely
  editable, like "Edit Inventory Draft"). The sheet **no longer closes on a tap
  outside** now that it holds a typed count, and the ✕ / Android back ask
  "Close without saving the breakdown?" when the typed numbers differ from the
  saved ones. That dialog uses `ConfirmDialog`'s `preferCancel`: **Keep
  counting** is the filled green button on the right and Close is the outline
  on the left — the buttons' *jobs* are not swapped, so a tap outside the dialog
  still keeps counting. The panel carries no explanatory notes; the owner asked
  for them off. The count panel stays mounted (just hidden) while the Expenses tab is
  showing, so a look at the expense list doesn't lose a half-typed count.
- **The comparison box is the owner's layout**: *Cash from receipts*,
  *Expense* (shown with a minus — it *is* subtracted, on this screen),
  *Expected* (cash minus expense), *Breakdown total*, then **Short by ₱X /
  Exact / Over by ₱X** right-aligned under a heavy divider. Keep *Expected*:
  without it the Breakdown total sits under the expense and reads as the answer
  to the subtraction. The owner removed a "Counted" row, and a "Cash after
  expenses" total that briefly sat at the bottom of the Expenses tab — don't
  add them back. `useRunCashSales` reads the receipts' cash once, in the sheet.
- **The number boxes are `CountInput`**, which leaves out `selectTextOnFocus`
  (on Android it re-selects an empty box's first digit, so the second keypress
  overwrote it) and hides the grey hint while a box is focused (Android puts a
  centred empty box's cursor at the hint's edge, not the middle). Don't add
  either back.
- **It uploads, live, like an expense.** Every save sets the row back to
  `'pending'` and nudges sync; `drainCashCounts` (after expenses) sends it to
  `runs/{runId}/cashCounts/{runId}` via `uploadCashCount`. One document per
  run at the run's own id, overwritten on each re-save. The existing `/runs/**`
  rule covers it — no `firestore.rules` change. It is counted in the pending /
  blocked / synced figures as "cash breakdown", so "End the day" waits for it
  like anything else. `expenses.db` went to `user_version = 3` to add the sync
  columns to phones that already had the version-2 table
  (`migrateCashCountSync`).
- **"End the day" needs at least one expense and a saved breakdown** (the
  owner's rule). `findMissingCloseout` checks both, first in `end-day-card.tsx`
  before the confirmation and again inside `endTheDay` as the backstop, and
  `MissingCloseoutError` is reported once with an OK rather than "Try again" —
  like an open draft, it is a rule, not a glitch. A ₱0 expense satisfies it,
  which is why ₱0 expenses are allowed. The message names the card and says to
  record ₱0 if nothing was spent.

## Printing receipts

Receipts print to a cheap **Bluetooth ESC/POS thermal printer**, not a system
print dialog. The stack, bottom up: `lib/printer.ts` (the only file that
imports `react-native-bluetooth-classic`), `lib/escpos.ts` (pure byte
builders), `context/printer.tsx` (connect / auto-reconnect / test print /
`printReceipt`), and `components/printer-card.tsx` on Home for pairing.
**Android only** — classic Bluetooth on iOS is limited to MFi-certified
accessories, so the printer card renders nothing there.

**Favorite printers.** A star sits on the right of each saved-printer row on
the card and on the right of the "Connected to …" line. Favorites are their own
AsyncStorage list (`printer.favorites`), kept in starring order, separate from
`printer.recent`. **Neither list has a cap** — the owner asked for every
printer ever connected to stay listed, and for no limit on how many can be
starred. The card shows three rows and scrolls
for the rest; its `cardMaxHeight` counts the gap above every row, and leaving
those out clipped the third row so the list looked like it had ended. The card
lists favorites first, then the remaining recents. `isFavorite` is backed by a
`Set`, so starring checks stay constant-time however long the list gets. A star
only pins and orders; it does **not** change auto-connect, which still goes to
the last printer connected.

**The scan sheet shows favorites but can't change them.** Discovered favorites
float to the top (a one-pass split that keeps discovery order, not a sort, as it
reruns per discovered device) with a plain, untappable gold star; everything
else shows no star. A favorite is listed even with "Show all devices" off, since
the driver already marked it as their printer whatever name it broadcasts.

**The card's list is a `ScrollView`, not a `FlatList`.** Home is
`<Screen scroll>`, and a FlatList nested in a ScrollView raises React Native's
"VirtualizedLists should never be nested" error (it surfaced on disconnect,
when the recent rows appear). With a handful of rows there is nothing to
virtualize; `nestedScrollEnabled` keeps the card scrollable inside the page.

**Permission comes before the radio, and the order is load-bearing.** On
Android 12+ the OS will not show its own “turn on Bluetooth?” dialog to an app
that doesn't hold `BLUETOOTH_CONNECT` — it cancels the request without drawing
anything, which on screen is indistinguishable from a dead button. That was the
bug: permissions were only asked for inside `scan()`, *after* the enable gate,
so the prompt appeared or didn't depending on whether the phone had scanned
before. `runIfBluetoothOn` in `printer-card.tsx` now calls
`ensureConnectPermission()` first, on both paths through it (scan, and tapping
a recent device — connecting needs the same permission). It asks for
`BLUETOOTH_CONNECT` alone: `ACCESS_FINE_LOCATION` is only needed to *discover*
devices, so `ensurePermissions()` keeps that and stays where it is.

Two more things about that button, both of which read as “nothing happened”:

- **`requestBluetoothEnabled()` resolves while the radio is still TURNING_ON.**
  Anything touching Bluetooth in that window fails exactly as if it were off,
  so a successful enable would be followed by “Could not scan for printers”.
  `waitForBluetoothEnabled()` polls the adapter until it really reports on.
- **The native enable promise can be left unsettled** if the activity is
  recreated while the OS dialog is up — `onActivityResult` never arrives and
  the module's stored promise is dropped. Closing the prompt therefore resets
  `enablingBluetooth`, or the button stays disabled behind a spinner for the
  life of the screen.

`lib/receipt-print.ts` owns the receipt *layout*, ported from the old POS's
`PrintableReceipt` (kept in `sample/` for reference):

- It lays the receipt out in **characters, not pixels** — 32 per line
  (`RECEIPT_COLUMNS`, the standard for 58mm paper) with fixed column widths
  for the item table that must keep adding up to 32.
- It builds a list of finished lines that **two renderers** consume: the
  on-screen preview and the ESC/POS byte stream. That's what makes
  "Preview" (bottom of the receipt detail modal) genuinely WYSIWYG — the
  preview isn't a lookalike, it's the same lines in a monospace font, sized
  from the measured paper width so exactly 32 characters fit.
- **No `₱` anywhere.** These printers only speak single-byte code pages, so
  the peso sign prints as garbage — amounts use a plain `P`. Keep printed
  text ASCII.
- Amount columns are padded but **never truncated**: an over-long amount
  widens the row (obvious) instead of silently printing a wrong number.
- **Columns never collide.** An item name stays inside its own column however
  long it is, carrying on down as many indented rows as it needs, and each
  column reserves a character so a full-width value can't run into its
  neighbour. That's also why amounts *inside the item table* drop their
  thousands separator while the summary lines below it keep theirs.

Business name, contact number, and the receipt's closing line are editable
from the dashboard's Settings page (`apps/web/src/pages/settings.tsx`), backed
by a single Firestore doc, `settings/business` (see `firestore.rules`).
Mobile reads it through `context/business-settings.tsx` — the same shared
fetch-fresh, fall-back-to-cache-then-timeout hook the other catalogs use (see
"Dashboard-owned catalogs" below) — and
`buildReceiptPrintLines` in `lib/receipt-print.ts` takes the result as a
parameter rather than importing it, so the file stays pure. The configured
ending message prints on every receipt, purchase or return alike — an
earlier version hardcoded "Thank you for your return!" for a negative total,
overriding the configured message; that was removed on the owner's call. It is
the one printed field where a **line break is meaningful**: `centeredBlock`
splits it on newlines and centres each typed line separately (each still
wrapped to 32 columns, so a break can only add lines), and blank lines are
kept as blank lines. `updateBusinessSettings` on the dashboard is what keeps
that storable — it is the only field there not collapsed to a single line.
`constants/business.ts` only holds the
last-resort defaults used before the first successful fetch or cache hit ever
happens (a brand-new install finishing setup with zero connectivity). The old
receipt's "Delivered by: <trucker names>" line is now the "Agents:" line (see
"Receipts" above).

## Customers (the store list)

The Customers tab (`app/(app)/customers.tsx`) is a grid of store cards over
`CustomerDetailModal` (read, then Edit or Delete) and `CustomerFormModal` (the
one and only place a store is created — nothing else calls `addCustomer`, and
the receipt form's store picker deliberately has no quick-add row).

**The form's fields are the old OldWorld app's, one for one** (October 2026,
owner's call, so that app's customer list can be migrated straight across):
Name, Store Name, Phone Number, Schedule, Address — **all five required**.
Schedule is free text ("Mon & Thu"), not weekday chips; the chips and the
Description field were removed, along with their SQLite columns
(`migrateScheduleText`, customers.db user_version 8, which *drops*
`delivery_days` and `description` because both were `NOT NULL` with no
default). OldWorld's `phoneNumber` is `phone` here.

**The detail modal carries OldWorld's "Purchase History"**
(`components/purchase-history.tsx`): the store's finalized receipts *on this
phone*, newest first, ten at a time with Load More (`loadCustomerReceiptPage`
in `lib/receipt-db.ts`, via `loadCustomerReceipts` on the receipts context).
**Each row is the Receipts tab's own row** (`components/receipt-row.tsx`, shared
by both lists) and a tap opens **the same `ReceiptDetailModal`** the Receipts
tab opens, stacked over the profile — so Preview/print, the proof photo and Void
(open run only) all work from here too. Keep the two lists on the one component
rather than restyling either. `onEdit` is optional on the modal because the
history only ever holds finalized receipts. Voided receipts are listed and
marked. Old OldWorld receipts were deliberately not migrated, so a migrated
store starts with an empty history; the dashboard's Stores tab is where every
truck's receipts for a store are seen together.

**A store has no area and no crew.** Both fields (and their required-field
messages) were removed from the form, the card and the detail modal when areas
and crews were removed on the owner's call (October 2026). The old SQLite
columns (`area_id`, `agent_group_id`) are left on the table, unread and
unwritten; copies already on the server keep the fields, and nothing reads
them. **Neither store list has a filter any more** — the Customers tab and the
receipt form's store picker both show every store on the phone.

**The Save button is never disabled for a half-filled form**, and new code here
must not re-introduce that. A greyed-out button is the one control that cannot
say why it won't work: the driver presses it, nothing happens, and nothing on
screen names the field that is missing. So it always presses, and an incomplete
form answers with a **"… is required"** message for each empty field —
under the field each one is about, in `theme.danger`, with that field's outline
turned red too. They appear on the first press (`showErrors`), so a form nobody has
finished yet isn't already scolding the person filling it, and from then on each
clears itself the moment its field is answered. The press also dismisses the keyboard and scrolls
the list to the top, so the first message is on screen even when Save was
pressed from the bottom of a scrolled form. `handleSubmit` re-checks completeness itself rather
than trusting its caller — it is the only path to a write and two things call
it.

**Editing and deleting each ask first, in a `ConfirmDialog`.** Not the same
question: Delete names the store and says it goes from this phone *and* the
server; the edit's confirmation sits on **Save changes**, where the write
actually happens, rather than on the Edit button — a tap that only opens a form
has nothing to confirm. Adding a store saves straight off: there is nothing to
overwrite. Both dialogs stay up while the write runs (`busy`/`busyLabel`), so
the form behind doesn't flash back into view mid-save, and answering the cancel
side leaves every typed field exactly as it was.

## Dashboard-owned catalogs (fresh vs. saved copy)

Three things on mobile are owned by the dashboard and only ever *read* here:
bread types, returned bread types, and business settings. All three run on one
shared hook, `hooks/use-cached-catalog.ts` — the contexts just say what to read
and how to shape it. The hook hydrates from AsyncStorage on mount, fetches,
caches what comes back, and tracks **which of the two the app is currently
running on**:

- `refresh()` resolves with `'fresh'` (server answered), `'cache'` (it didn't,
  but a saved copy exists) or `'none'` (it didn't, and nothing has ever been
  downloaded). Callers branch on that; it is not just a fire-and-forget.
- A **failed refresh downgrades the badge to `cache`**, even if an earlier
  fetch this session succeeded. Ten-minute-old data is real, but it isn't "what
  the server says now", and after the user chooses "Use saved copy" the badge
  has to agree with them.
- A **late answer still counts**: after the 6s timeout falls back to cache, the
  in-flight request is left running, and if it lands its data and cache write
  still happen — **unless a newer request has answered first.** Every request
  carries a generation number and applies its result only if it is the newest
  one in, so an overtaken request can't reinstate older data, stamp an older
  download time over a newer one, or downgrade a `fresh` badge to `cache` on a
  timeout that has since been overtaken. That matters because of `force` below,
  which is what makes two requests being in the air at once ordinary.
- **`refresh({ force: true })` makes a request of its own** instead of riding
  along on one already in flight. Riding along is the default and is right for
  a provider mounting or a "Try again" tap; **finishing truck setup forces**,
  and so does its Retry (see `runFetch` in `components/inventory-setup.tsx`).
  A driver tapping "Start the day" is entitled to have the app actually ask —
  otherwise a launch-time fetch a few seconds old stands in for the day's
  download, and a launch-time fetch that *timed out* fails a setup that was
  never attempted.
- Cached payloads are wrapped as `{ version: 1, storedAt, value }`. `storedAt`
  is the whole point — it's the date the Inventory badge shows, and it is the
  same number whether the app is on the fresh copy or the saved one. An
  unwrapped payload is a pre-`storedAt` cache and still loads fine.
- **A Firestore read with no connection does not fail**, so every fetch calls
  `assertFromServer(snapshot.metadata)` (`lib/catalog-source.ts`) the moment it
  gets an answer. `getDocs` only rejects when you explicitly pass
  `source: 'server'`; with the default source it falls back to the SDK's own
  local cache and resolves a perfectly well-formed snapshot — empty in a
  freshly-launched app, or holding whatever this session already fetched.
  Nothing in the shape of that answer says the server was never reached, so
  the hook took it as gospel: reported `'fresh'`, and in the empty case
  overwrote the saved copy *on disk* with nothing, where it outlived every
  restart. `metadata.fromCache` is the flag that tells the two apart, and it
  is reliable in the direction that matters: `fromCache` is
  `syncState === Local`, which pending local writes do **not** set — only
  actually being offline does — so it can't misfire while online. Throwing is
  deliberate: it routes an offline read into the fall-back-to-cache path that
  already exists, which is what makes the setup screen's Retry /
  Use-saved-copy prompt appear at all. This applies to the customer pull too
  (`pullCustomers` in `lib/sync.ts`), where an unguarded empty page had setup
  ticking "Stores" off as downloaded having downloaded nothing.
- An **empty answer never displaces a real catalog**, for catalogs that pass
  the hook an `isEmpty` predicate (bread types and returned bread types, via
  `isEmpty: (items) => items.length === 0`). Kept alongside the `fromCache`
  guard above rather than replaced by it: that one catches "there was no
  server", this one catches "the server answered with nothing" — a rules
  change, or the app pointed at the wrong project. A query that returns zero
  documents is indistinguishable from a healthy one, so without this a single
  bad answer — the app pointed at a project whose catalog was never filled in,
  a rule change that hides every doc — replaced good prices with nothing *and
  wrote that to disk*, where it survived every restart. Instead the saved copy
  is kept and the refresh reports `'cache'`, which routes the failure into the
  prompt that already exists. The same predicate runs on the way *in*: an empty
  cached copy is not adopted as a saved copy, so "Use saved copy" can't start a
  day on a catalog with nothing in it. With nothing cached to protect, an empty
  answer is still accepted as `'fresh'` — a dashboard that genuinely has no
  bread types yet is a real state, and the screens say so.

**The first setup on a phone must be online; every one after it need not be.**
That is the whole point of the machinery above, and it falls out of
`canUseCache` in `components/inventory-setup.tsx` (`failures.every(f =>
f.hasCache)`) rather than from a rule written anywhere. A phone that has never
downloaded a catalog has nothing to fall back on, so the prompt offers Retry
only and says in words that this is a first setup and it needs a connection.
A phone that has done it once has a saved copy of all four, so a later setup
with no signal gets Retry *and* "Use saved copy". The one thing the app cannot
know is whether that saved copy is still right — it never reached the server —
so the prompt says the only person who can answer is whoever runs the server: if they have
been told a price, a bread type or a store changed today, the saved copy will
not have it.

**"Nothing in the list" is a catalog problem, never a stock problem.** The
Inventory tab's list and the Add-batch modal are both drawn from
`breadTypes`, so both go blank on exactly one condition —
`breadTypes.length === 0` — which has nothing to do with how much bread is on
the truck. The screen used to word that as "No inventory recorded yet", which
pointed the reader at their stock instead of at the dashboard. Both surfaces
now say "No bread types downloaded", and the Inventory tab offers a "Try
again" wired to `refreshBreadTypes`. Keep the two wordings the same: they are
one fault, and two phrasings read as two.

`lib/catalog-source.ts` holds the `CatalogSource` type and its wording.
**`at` means one thing in every kind: when this phone last got the data off the
server** — which is why both kinds print the same verb ("Fresh · downloaded …",
"Saved copy · downloaded …"), and why a `fresh` badge downgrading to `cache`
doesn't move the date.

That is a correction, not a description of how it always was. `fresh` used to
report the newest `updatedAt`/`createdAt` on the Firestore documents — *when
the dashboard last edited the catalog* — so a catalog downloaded a minute ago
read "updated Aug 15" because Aug 15 was the last time anyone touched it in the
server. The badge is a claim about the download, so it has to be the download's
own clock. The doc-timestamp helpers (`docChangedAt`, `collectionChangedAt`)
were deleted along with the `contentAt` a fetcher used to return; a catalog's
`fetch` now just resolves the value. Don't wire a document timestamp back into
this — it answers a different question, and putting it here is what made the
strip untrustworthy.

`combineCatalogSources` follows one rule for both halves: **the worst answer
wins.** Worst kind, so the strip can't say "Fresh" while something on screen is
on a saved copy; and the *oldest* download among the sources of that kind, so it
can't claim the screen is more recently downloaded than its stalest part. One
unknown date makes the whole line undated rather than quietly reporting one of
the others.

Finishing the truck setup screen (`components/inventory-setup.tsx`) is what
triggers the first fresh fetch of all three for the day — see `runFetch` and
the `catalogs` array it reads (adding another download means adding one row
there and nothing else). **It always makes the request**, never reporting on
one already in flight: `runFetch` passes `{ force: true }` to every target. A full-screen progress list covers the fetch window,
one row per catalog, ticking off as each lands. If any of them doesn't come
back fresh, setup does **not** finish — `components/catalog-fetch-alert.tsx`
comes up instead:

- Some failed but every failure has a saved copy → "Retry" or "Use saved copy".
  Retry re-fetches only what failed; if it fails again the same prompt returns,
  as many times as it takes. Only "Use saved copy" calls `finalizeSetup()`.
- Any failure has **no** saved copy → there's nothing to fall back to, so the
  prompt offers "Retry" only and says to get online. That's the deliberate
  hard requirement: a brand-new install can't start a day offline.
- Either way **tapping outside the card** (or Android back) returns to the setup
  form, so the user is never trapped. That is the only way out besides the
  buttons — there is no "Back to setup" link.
- "Use saved copy" is the **filled yellow** (`theme.warning`) button and Retry
  is the outline one. Continuing on prices the app can't confirm is the choice
  with a consequence, so it's the one that has to be noticeable.
- **Opening the run has a screen of its own** — the `'opening'` phase, which
  keeps the progress list up under "Starting the day…". Every path to
  `finalizeSetup` goes through `finishOpeningRun`, which switches phase
  *before* awaiting, because `finalizeSetup` is not instant: it probes
  Firestore for a free run number, and on the dead signal that raised this
  prompt in the first place that is a six-second wait. Awaiting it with the
  screen unchanged left the alert sitting there, still visible and still
  tappable, long after "Use saved copy" was pressed — a press that looked like
  it hadn't registered.

**"Stores" is the fourth row and the odd one out.** Customers are not a
dashboard-owned catalog — every phone writes them (see "Customer sync" below) —
but they are downloaded here for the same reason the other three are: this is
the moment at the depot when a truck picks up the stores other agents added or
corrected while it was out of signal, and **the only moment they are downloaded
at all**. It joins the list by exposing the same
`() => Promise<CatalogSourceKind>` shape (`refreshCustomers` in
`context/customers.tsx`), so the progress row and the failure prompt need no
special case. Two of the three words mean slightly different things for it,
though, and **the third it never says**: `fresh` = the server answered,
`cache` = it didn't, so the truck works whatever store list this phone already
holds — *including an empty one*. It never reports `none`, because `none` is
what withdraws "Use saved copy" and holds a truck at the depot, and no state
stores can be in earns that. An empty list is workable: this is the one
collection **mobile can write**, so a driver who starts with no stores adds the
ones in front of them, which is what a new route is. A customer database this
phone can't read at all is not fixable by finding signal either — Retry would
re-run the same broken read forever — so it downgrades to `cache` too and the
Customers tab reports it with its own "Try again". Stores therefore never
decide whether a setup may go ahead; they ride along with what bread types,
return prices and business details decide, and those three are what keep the
first setup on a phone an online one.

`components/catalog-source-indicator.tsx` is the strip at the bottom of the
Inventory tab. It's a sibling *below* `<Screen>` (the same relationship the tab
bar has to it), so it stays pinned while the screen scrolls and the screen
doesn't make room for it by hand. It renders **only once the inventory list is
up** — not while loading and not on truck setup, since nothing on screen is
priced from those catalogs yet there, and setup already has a louder way to
report a failed download (`catalog-fetch-alert.tsx`). It is a **read-only
label** — one combined
line, no tap-to-expand per-catalog breakdown and no "Update" button. The
combine takes the **worst** kind, so it can never say "Fresh" while something
on screen is running on a saved copy.

## The Settings sheet

`components/settings-modal.tsx`, behind the gear on Home. Two kinds of row live
in it and they are not for the same person:

- **For the driver:** the "Uploads to the server" health bar, and "Try sending
  refused records again", which only renders when something is actually refused
  (`blocked.total > 0`).
- **For the developer:** the destructive maintenance rows — "Reset truck setup"
  and anything like it. **These are testing tools and are expected to come and
  go.** The owner adds one back while working on a feature and takes it out
  before a build reaches a truck, so treat their absence as the normal state
  and their presence as temporary.

What follows from that:

- **Don't delete the functions behind a removed row as dead code.**
  `stock.resetStock()` and `inventory.resetSetup()` currently have no caller
  ("Reset truck setup" was removed from the UI on 2026-08-26) and that is
  deliberate — they are what a re-added row wires straight back onto. The same
  goes for `SettingsRow`'s `destructive` prop and `styles.error` when no row is
  using them.
- **Re-adding a row is UI only**: a `<SettingsRow ... destructive>`, a piece of
  `useState` for the confirmation, and a `ConfirmDialog` with `tone="danger"`.
  Git history holds the last version of `handleResetSetup` to copy — note its
  shape, which is not obvious: **two separate `runWithRetry` calls, ledger
  first**, because a single prompt wrapping both would report a failure at the
  second step as "nothing was cleared" over inventory that has already been
  wiped.
- **Removing a row means removing its dialog and handler too**, or the modal
  keeps state and imports nothing renders — `npm run lint` and `npx tsc
  --noEmit` in `apps/mobile` are the check.

**The reset row was also the documented escape hatch from an abandoned run**
(logging out is blocked while one is open — see "Auth" above). With
it out of the UI, a run that genuinely cannot be closed is ended by "End the
Day" or not at all, short of reinstalling the app. That is accepted: the row is
for testing, and a driver stuck this way is a call for help, not a button.

## When something fails

The app runs on a phone in a truck: storage fills up, the printer wanders out
of range, the database is busy for a moment. **No failure is allowed to be
silent**, and nothing may be left half-done without saying so. Three pieces
cover it — use them rather than inventing a fourth:

- **`lib/retry.ts` — `runWithRetry(action, { scope, title, message })`.** The
  default for anything the user *asked for* (save, finalize, delete, print).
  It runs the action, and on failure logs it and offers "Try again" as many
  times as the user wants. It **never rejects**: it resolves with
  `{ completed: true, value }` or `{ completed: false }` when they gave up.
  Two rules for callers: only close the modal / clear the form when
  `completed` is true, so a failed save never costs the user what they typed;
  and say what *didn't* happen in `message` ("Nothing was saved"), because
  after the alert the user has to know what state things are in. Pass
  `retryable` for a failure that will fail identically next time (a rule, not
  a glitch — e.g. `DraftExistsError`); those are reported once with an OK
  instead of an offer to retry. `notifyFailure` is the same idea for
  already-half-done work that must not be re-run.
- **`components/error-boundary.tsx`** — catches crashes *while rendering*,
  which no try/catch around a press can reach. One at the root
  (`src/app/_layout.tsx`) and one inside each tab screen, so a broken screen
  takes only itself down and the tab bar and other tabs keep working. Without
  it a single bad value blanks the whole app in a release build.
- **`lib/errors.ts`** — `describeError` (any thrown *value*, including
  non-`Error`s, into one readable line) and `logError(scope, error, details?)`,
  the one place failures reach the console. Tag scopes `'area.action'`
  (`'receipts.finalize'`). If crash reporting is ever added, change `logError`
  and nothing else.

  **`details` is where the run goes**, and on the sync path it is not optional
  in spirit. A scope tag says where in the code a failure happened, which is
  almost never enough on its own: `[sync.receipt.blocked] permission-denied`
  names no receipt and no run, so nobody reading it later can go and look at
  the record. `runDetails()` in `context/sync.tsx` is the one place that words a
  run for a log line — day, trip number, truck, agents, account, run id, with
  captured *names* preferred over ids because a person reads these — and every
  drain passes it into `uploadOrSetAside`, which hands it to the quarantine log
  along with the row id. Two deliberate exceptions: stores get their own details
  (`store`, `deleted`, `updatedAt`) because a store belongs to the business
  rather than to a trip and there is no honest run to name, and the "belongs to
  no known run" lines log the run id the *row* names, since which run aged out
  of the log is the fact that makes a stranded row traceable. Values are
  formatted defensively — `logError` runs inside `catch` blocks everywhere, and
  a logger that can throw would replace a failure being handled with one that
  isn't.

Background work the user didn't ask for — pagination, search, loading a proof
photo — is **logged, not alerted**: no alert interrupts anyone, and it retries
on the next scroll or keystroke. A load that leaves a screen empty
(`stockError`, `receiptsError`, customers) instead gets a "Try again" button
wired to the context's `reload*()`, because "restart the app" is not a fix a
driver should have to reach for.

**Quiet is not the same as invisible, and two of those had to stop pretending
the failure was an answer.** A failed receipt *search* used to render "No
receipts match", which tells a driver a receipt doesn't exist when nothing
actually looked — the reply to that is to write a second receipt for a store
already invoiced. A failed `loadMore` used to render nothing at all, and
`onEndReached` doesn't fire again until the user scrolls away and back, so a
page that failed was indistinguishable from the end of the list. Both now say
what happened and offer a tap to retry (`searchFailed` in
`src/app/(app)/receipts.tsx`, `loadMoreFailed` on the receipts context) — still
no alert, and the rows already on screen stay usable.

Three failure modes are specifically designed against, and all are easy to
reintroduce:

- **Stuck spinners.** Any `await` that gates a `loading` flag needs its
  `finally` to run on the failure path too — an uncaught throw in
  `context/inventory.tsx`'s mount effect used to leave the Inventory tab blank
  forever, because `setSetupLoading(false)` never ran.
- **Poisoned singletons.** `getDb()` in each `*-db.ts` caches its open promise;
  if a *rejected* one were left cached, one bad open would fail every call for
  the life of the process and no "Try again" could ever recover. Each clears
  the cache on failure — keep that.
- **Overlapping transactions.** Every transaction in `stock-db.ts` and
  `receipt-db.ts` goes through `runTransaction` in **`lib/db-lock.ts`**, never
  `db.withTransactionAsync` directly. That is not tidiness:
  `withTransactionAsync` is a bare `BEGIN`/`COMMIT` on the *shared* connection
  (expo-sqlite's own docs say to use `withExclusiveTransactionAsync` "if you
  worry about the order of execution"), so a second `BEGIN` while one is open
  errors — and that call's own `ROLLBACK` then aborts the **first** caller's
  transaction, leaving its remaining statements to commit in autocommit mode.
  Half a receipt on disk, reported as a failure. It is reachable rather than
  theoretical because `markPaymentProofSynced` is transactional and runs from
  the **sync pass**: a driver photographing a GCash payment and starting the
  next receipt is doing exactly the two things that collide.
  `withExclusiveTransactionAsync` was the other candidate and was rejected — it
  opens a second connection, so under WAL every ordinary write on the main one
  would take `SQLITE_BUSY` for the duration. Migrations inside `getDb()` are the
  one exception and stay unqueued: nothing else can touch the database until
  that promise resolves.

Finalizing a receipt is the one action that can genuinely half-succeed (two
databases, two transactions — see "Receipts" above). `finalize()` therefore
resolves with a `StockSettlement` (`'settled'` / `'skipped'` / `'run-closed'`)
rather than throwing: everything up to `markFinalized` is safe to retry as a
whole, and the stock deduction after it gets its own retry prompt, because
re-running `finalize` would find the receipt already finalized and take its
early-return branch.

**That early-return branch has to redo the list update and the sync nudge, not
just the deduction.** `markFinalized` can commit and still report a failure, in
which case the first attempt never reached them — and nothing else refreshes
the list from disk (the first page loads once on mount; `reloadReceipts` is
only on the error screen), so the row would keep a "Draft" badge for the life
of the app over a receipt that is finalized and already uploading. The badge is
what puts the draft-only Delete and Edit buttons on screen, and both half-apply
past that point: `deleteDraft`'s `WHERE status = 'draft'` leaves the row on
disk while dropping it from the list, and `updateDraft`'s guard covers the
header row but not `writeLines`, so the items get rewritten under totals that
no longer match. `applyFinalizedToList` is the one function both branches call.

Both unsettled outcomes are told to the driver — a stated shortfall, never a
silent one — through **one wording**, `stockUnsettledMessage`, alerted exactly
once each: `'skipped'` by the retry prompt the user answered, `'run-closed'` by
the modal afterwards. **Neither message offers "Add batch" as the fix, and new
wording must not either**: a missing deduction leaves the count too *high*, and
`addBatch` only ever adds (positive deltas only, and the stepper stops at zero).
Nothing in the app lowers stock except a sale entry, and the payment button is
draft-only, so once the modal closes that receipt's deduction is unreachable —
"Skip" is final, which is why the button no longer says "Skip for now".

## Free-text fields

Anything typed into a form goes through `lib/text-input.ts` before it is
stored — `sanitizeSingleLine` / `sanitizeMultiline`, plus a per-field length
cap. What that is and isn't for:

- **Not** SQL injection. Every query in every `*-db.ts` binds its values as `?`
  parameters, so text can never be read as SQL. Keep it that way — never build
  a query by string-concatenating a value in.
- It strips what a keyboard can't type but the clipboard can: control codes,
  zero-width characters, and the bidi overrides that make a stored value
  display as something other than what it holds. A field of zero-width spaces
  survives `trim()`, which is why the customer form checks its required fields
  *after* sanitizing, not with `trim().length > 0`.
- Length caps live next to the type they belong to (`CustomerFieldLimits` in
  `lib/customer-types.ts`) and are used twice: as `maxLength` on the input, so
  the cap is visible while typing, and in the sanitizer, so a value that got in
  another way is still bounded. Uncapped text ends up on receipt paper.

Sanitizing happens in the **db layer** (`sanitizeCustomerInput`, called inside
`insertCustomer`/`updateCustomerRow`), not only in the form, so it holds for any
future caller. `updateCustomerRow` therefore returns what it wrote and
`context/customers.tsx` merges *that* into its list — otherwise the screen would
show the raw text while the row on disk holds the cleaned version.

The printer is the one place a stray character is more than cosmetic: on an
ESC/POS link there is no separation between text and commands, so `0x1b` inside
a customer name *is* an instruction. `lib/escpos.ts` replaces every control
character with a space (one for one, so a 32-column line still lines up) on the
way to the bytes, and `lib/receipt-print.ts` does the same to data-sourced text
via `fromData()` while building lines, so the preview shows exactly what prints.
Both are needed: receipts saved before this existed, and the business settings
the dashboard owns, never passed through the mobile form.

## Modals and the keyboard

The form modals are centred sheets at a fixed percentage height, so a keyboard
covers their bottom third — the Save button, the last fields, the row whose
quantity is being typed. `hooks/use-keyboard-sheet.ts` (`useKeyboardSheet`)
**leaves the sheet exactly where and what size it is** and works the *list
inside* it instead: the scrolling list is given extra `paddingBottom` equal to
the on-screen keyboard height (`overlap`) so its content can scroll past where
the keyboard sits, and the hook scrolls the focused field up above the keyboard
as it arrives. The header, totals and action buttons don't move — so the Save
button sits behind the keyboard while it is up, and you dismiss the keyboard to
reach it. This replaced an earlier version that resized the whole sheet to fit
above the keyboard; the owner asked for the sheet to hold still. Currently in
`inventory-stock-modal.tsx` (both "Edit Inventory Draft" and "Add batch"),
`receipt-form-modal.tsx` and `customer-form-modal.tsx`; a new form modal wants
the same three lines (`onBackdropLayout` on the backdrop, `paddingBottom:
Spacing.four + overlap` on the scrolling list's `contentContainerStyle`, and
`{...scrollProps}` on that same list).

**None of them close on a tap outside**, and that is a decision rather than an
oversight. These sheets are worked with a keyboard up and take most of the
screen, so the dim strip around the edge is exactly where a thumb lands by
accident — and every one of them holds something that has to be re-entered from
memory if it is thrown away: a truck's worth of counted bread, a half-typed
receipt, a new store. Closing is the ✕ and Cancel, which are pinned on screen the
whole time, and Android back still works. The same rule covers
`payment-method-modal.tsx` and the printer's "Select a printer" sheet. Adding
`onPress={onClose}` back onto a backdrop is not a fix.

`DropdownField`'s picker *does* close on a backdrop tap by default — its lists
are quick throwaway selections — but takes a `closeOnBackdropPress={false}` to
opt out. The receipt form's **customer picker** passes it: it sits on top of a
half-typed receipt, so a stray thumb on the dim strip dismissing it lands the
driver back on the form having lost their place in the store list. The ✕ is the
way out there too. It lists every store on the phone — the crew / all-stores
toggle it used to carry was removed with crews.

**Two actions ask before they commit**, because both are irreversible — nothing
lowers stock but a sale, and nothing un-finalizes a receipt. Finalizing a
receipt gets a **second step inside the sheet** (`payment-method-modal.tsx` —
pick the method, then confirm store/method/money), since the method being
confirmed is chosen on the same screen. Adding a batch gets a **one-line dialog**
(`inventory-stock-modal.tsx` in `'add'` mode — "Add this batch?", Go back /
Continue) — the steppers behind it already show every number, so a screen
restating them was redundant. Either way the confirmation sits *in front of* the
existing `runWithRetry` call, never around it, and declining leaves the sheet
open with every typed value intact. "Edit Inventory Draft" (`'set'` mode)
deliberately has no confirmation: it overwrites a count that is still freely
editable.

**Questions use `components/confirm-dialog.tsx`, not `Alert.alert`.** `Alert` is
the platform's own dialog and takes no styling at all, so on Android it lands as
a grey Material box in the middle of a white app. `ConfirmDialog` is the same
card as the sheets around it (title, one line of message, outline Cancel +
filled Confirm, `tone="danger"` for anything that removes). **Failures are the
exception and still use a real `Alert`** via `lib/retry.ts` — an error has to
interrupt whatever is on screen, including a screen that has just crashed, and
the platform dialog is the only thing guaranteed to manage that. Every
confirmation on the phone now goes through it: "Add this batch?"
(`inventory-stock-modal.tsx`), "Add this expense?" / "Remove this expense?"
(`expenses-modal.tsx`), "Start the day?" (`inventory-setup.tsx`), "Void this receipt?"
(`receipt-detail-modal.tsx`, asked twice — the second step names the store and amount) and "End the
day?" (`end-day-card.tsx`).

**The last step of a void is a slider, not a button** (`slideToConfirm` on
`ConfirmDialog`, drawn by `components/slide-to-confirm.tsx`). The first step's
"Continue" sits exactly where a "Yes" button would, so one double-tap used to be
enough to void a receipt; dragging the knob the whole way across can't happen by
accident, and letting go short springs it back. Its Cancel is deliberately
*not* the hairline outline button — it is a solid grey button as tall as the
track, labelled "No, keep this receipt", so the way out is as easy to find as
the big red slider. It is built on core
`PanResponder` + `Animated`, **not react-native-gesture-handler**, because
gesture-handler needs its own root view inside every `Modal` on Android and this
always lives in one — and it needs no native rebuild. Screen readers get an
`activate` action in place of the drag. The knob stays at the end while `busy`,
and only slides back if `busy` clears with the dialog still up, so a
`slideToConfirm` action must set `busy` or the knob stays parked.

**Outcomes have their own card, `components/notice-dialog.tsx`.** Same shape,
one button, no cancel — it states what happened instead of asking. It is also
allowed the one thing `ConfirmDialog` refuses, a short list of figures (`rows`,
label-left/value-right), because the "Day ended" read-back *is* those numbers:
the same ones the server was just handed, so a driver asked "what did it say?"
can answer. Used by "Day ended" (`end-day-card.tsx`) and "Queued again"
(`settings-modal.tsx`). Failures still don't go here — they go through
`lib/retry.ts` and a real `Alert`.

**A dialog that reports an action must outlive what the action destroys.**
Ending the day clears the setup, and `EndDayCard` renders nothing without one —
so the card is now hidden by a conditional *inside* its markup rather than an
early `return null`, and the manifest notice sits outside that conditional.
`settings-modal.tsx` has the same hazard from the other end: its "Queued again"
notice is rendered inside the settings `Modal`, so the sheet is closed by the
notice's own dismiss, never before it.

Three things in it are load-bearing:

- **It measures an overlap, not a keyboard height.** Whether the window shrinks
  for the keyboard can't be assumed — iOS never does, and Android depends on the
  soft-input mode and on edge-to-edge, which Expo turns on. So the backdrop's
  own measured bottom edge is compared against the keyboard's top in screen
  coordinates. If the window already resized, the difference is negative and the
  result is 0 — the sheet already ends above the keyboard, so the list needs no
  extra padding.
- **The padding alone would hide the field the user just tapped.** Room to
  scroll is not the same as scrolling: a row at the bottom of a long list stays
  where it was, now behind the keyboard. The hook scrolls the focused input back
  above the keyboard — but only as the keyboard *arrives*, and only after the
  new padding has reached the layout engine (`ResizeSettleMs`), or the scroll is
  clamped against content that can't yet reach past the keyboard and lands
  short.
- **`KeyboardAvoidingView` is not the tool here and was removed from
  `customer-form-modal.tsx`.** It did nothing at all on Android (no `behavior`
  was passed there), and on iOS it padded the inside of a sheet whose bottom
  still sat behind the keyboard. `dropdown-field.tsx` and `expenses-modal.tsx`
  still use one; they are not sheets of this shape.

## Sync (mobile → Firestore)

Full design and rationale: **`docs/sync-design.md`**. The essentials:

Everything a truck does on one trip out is grouped into a **run** — one truck,
the agents aboard it, one trip out — and uploaded live in the
background. `runs/{runId}` is the header; `stockEntries` and `receipts` are its
subcollections. Finishing the Inventory setup screen is what opens a run;
"End the Day" closes it, clears the setup, and hands the driver back to the
setup wizard with an empty truck.

**A run may span more than one business day, on purpose.** It used to be
described as "one Manila business day", but nothing ever enforced that — no code
compares an open run's day against today — and the truck really does stay out
past midnight. That is now a supported shape rather than a bug waiting to be
noticed:

- The run keeps the `businessDay` it *started* on and stays filed under it. The
  dashboard shows a run on its start date and nowhere else — deliberately, so a
  trip is one row in one place rather than the same money appearing on three
  days.
- `closeRun` stamps **`closedBusinessDay`**, the Manila day it ended on, so the
  server can tell a run that finished at 6 PM from one that finished at 6 PM two
  days later. The dashboard reads it through `runEndDay` / `runSpansDays` /
  `describeRunEnd` in `apps/web/src/lib/runs.ts` — one wording, shared by the
  board row and the run panel, because a row and the panel it opens must not
  describe the same run's ending two different ways. It is null on every run
  closed before the field existed, including the ones already in production, so
  `runEndDay` falls back to `businessDayKey(run.closedAt)`. That fallback is the
  one sanctioned exception to "never derive a day from a timestamp in the
  browser", and only because `apps/web/src/lib/business-day.ts` is pinned to
  `Asia/Manila` — it does on the desktop exactly what the phone would have done,
  not what the reader's timezone would.
- Every child document still stamps its own `businessDay` from when it was
  written, so a receipt written on the second morning says so even though the
  run above it is filed under the first.
- The manifest already covered the whole run rather than a day, so it needs
  nothing: it is counted per run and always was.

**A run id is `${businessDay}_${agents}_${account}`, plus `_2`, `_3` … for
repeat trips**, where `agents` is each ticked agent's name flattened and joined
with `+` (`agentsRunIdSegment`), in the dashboard list's order — e.g.
`2026-10-03_Juan-Dela-Cruz+Maria-Santos_juan@bakery.ph`. The owner asked for the
id to say who went out. Both suffixes exist to stop a *silent* collision — in
each case two runs would otherwise share one document, the later header
overwriting the earlier, and whichever ends the day last destroying the other's
manifest. Child documents survive either way (their ids are phone-minted and
unique), which is what makes the failure quiet rather than obvious.

- **Names, not document ids**, because a composed id exists to be readable
  without a lookup table. The real ids are still stamped on the run and on
  every child document as `agentIds`. Two consequences: the names are captured
  when the run opens and the id is **pinned into the setup**, so renaming an
  agent at noon can't re-point an open run at a document that doesn't exist; and
  a name isn't unique like an id, so two runs whose agents flatten to one
  segment are numbered `_1`/`_2` by `sequence` rather than colliding.
  `finalizeSetup`'s local run count therefore compares the *segment* — it has to
  count exactly what the composed id gathers together, and with no signal it is
  the only thing that can.
- **Runs opened while crews existed were keyed on the crew's name**
  (`…_Alpha-Crew_…`). Their ids are pinned, so they keep them.
- **`account` — two phones can tick the same people on the same day**, one of
  them by mistake. Keyed on the login rather than a device tag so a reinstall
  rejoins the same run; a run is one *account's* trip out, which is what the
  manifest already means ("what the device believes it produced").
- **`sequence` — one account may take the same people out twice.** Settled from
  two sides, and neither alone is enough. A log of recent runs in AsyncStorage
  next to the setup (`context/inventory.tsx`) gives the starting number, per
  account **and per agents segment**, resetting each business day;
  `findFreeRunSequence` (`lib/sync.ts`) then asks Firestore whether that id is
  actually free and takes the next one if it isn't. The log covers a run whose
  header hasn't uploaded yet — a morning out of signal — which the server can't
  know about; Firestore covers a run this handset has no memory of, because it
  was reinstalled or replaced between trips, or because a second handset is
  signed in to the same login. **The probe never blocks setup**: it is
  short-timeout, and with no signal it falls back to the local count. **An id
  that exists is taken**, whoever wrote it and whether or not it is closed — so a
  reinstalled phone no longer recomputes its way back onto the morning's run,
  which it could not really rejoin anyway (the local databases went with the
  reinstall). It gets a fresh number and the morning's run stays open and
  unmanifested, which the dashboard shows as a run that never ended.
- **The composed id and all of it is pinned into `InventorySetup` at
  finish-setup time, never read fresh.** Logging out does *not* end a run, so an
  agent swap on one handset must not re-point an open run at a different
  document — rows already written carry the old id. `composeLegacyTruckRunId`
  exists only for a run that was already open when name-keyed ids arrived.
- `safeSegment` in `lib/sync-types.ts` **must stay injective.** Two earlier
  versions weren't: deleting punctuation merged `juan.delacruz@` with
  `juandelacruz@`, and replacing it with `-` merged it with `juan-delacruz@` —
  each quietly handing back the collision the account segment exists to
  prevent. Firestore ids allow `.`, `@`, `+` and `%`, so real addresses pass
  through untouched. Don't "tidy" that character class.
- **Nothing is enforced server-side, deliberately.** Rules can't tell "two
  agents on one truck" from "wrong truck tapped", a rule that rejected the
  second writer would strand that phone on a run it could never close (uploads
  never alert), and setup has to work offline. Making `createdByUid` immutable
  was considered and rejected: sign-out leaves a run open, so an agent swap
  legitimately changes the writer. **The dashboard is where this surfaces** —
  group by `businessDay` + `truckId` (the index exists) and show the runs, with
  `createdByEmail` naming who.
- **A run survives losing either of its two local records.** The setup
  (`inventory.setup.v1`) and the run log (`inventory.runlog.v1`) are separate
  AsyncStorage keys read independently — one failing no longer costs the other,
  as it did when they shared a `Promise.all` and a `try`. If the log can't
  supply the open run, `rebuildRunFromSetup` reconstructs it from the setup,
  which pins the id, start time, trip number and the three picked ids; only the
  display names are re-resolved from the catalogs, and
  `createdByUid` comes from the signed-in account because rules would refuse any
  other value anyway. Without it, `runId` set with `currentRun` null was a dead
  end nothing handled: "End the Day" silently did nothing, the header never
  uploaded, and the run's rows were written off as `'legacy'`. The rebuilt run
  is merged into `runsById` at the point of use rather than written back into
  the log — an unreadable log is left strictly alone, since overwriting it would
  destroy the other runs' records along with it.
- **Every row uploads into the run it was written in, never the run that
  happens to be open when the queue drains.** `receipts.run_id` and
  `stock_batches.run_id` are stored locally and the drain looks each row's run
  up in the run log. A run is allowed to close with rows still queued and the
  next run starts straight afterwards, so this is not a corner case.
- The run log also keeps a finished run *describable* after it ends, which is
  what makes that possible. A row whose run has aged out of the log can't be
  filed anywhere: it is marked `'legacy'` and logged, rather than staying
  "pending" forever.
- **`'legacy'` may only be concluded from a run log that was actually read.**
  `runLogLoaded` on the inventory context is true only on the success path of
  the mount read (an empty log on a first launch included), and the drains skip
  the row instead of writing it off when it is false. Same principle as
  `refreshPending()` resolving `null` rather than zero: an empty `runsById` means
  either "no such run" or "the log didn't load", the two look identical from
  inside a drain, and writing off is irreversible. One failed AsyncStorage read
  would otherwise mark a whole day's takings permanently un-uploadable. Skipping
  costs nothing — no upload is attempted, and the next launch tries again.

Rules that are easy to break and expensive to get wrong:

- **The proof photo is the one upload that isn't a document.** It goes to Cloud
  Storage at a path derived from the receipt id, which gives it the same
  idempotence `setDoc` gives everything else — see "Proof-of-payment photos"
  above for the rest of it.
- **Never `addDoc` on the upload path.** Every upload is `setDoc` at an id the
  phone minted (`lib/id.ts`), which is what makes re-sending safe. `addDoc`
  would turn every retry into a possible duplicate receipt, and no retry logic
  fully closes that.
- **`firestore.rules` must allow `update`, not just `create`,** for the same
  reason: a retry re-sends the identical document, and to Firestore a `setDoc`
  over an existing doc is an update. A create-only rule looks stricter and in
  fact rejects every retry.
- **`businessDay` is computed on the phone** with `lib/business-day.ts` and
  stored as a string on every document. Never let the dashboard derive the day
  from a timestamp — a browser in another timezone files early-morning receipts
  under the previous day.
- **Every child document repeats the run's identity** (`runId`, `businessDay`,
  `truckId`, `agentIds`, `createdByUid`). Uploads land in whatever
  order the signal allows, so a child must make sense before its parent exists.
- **`recordSale` uploads its ledger entry even though the receipt lists the
  same items.** Finalizing writes two databases in two transactions, so a crash
  between them leaves a receipt whose stock was never deducted. Uploading both
  keeps that visible as a mismatch instead of hiding it in a derived number.
- **Uploads never alert.** They're background work nobody asked for: log and
  retry (see "When something fails"). The one visible surface is the Home
  card's pending count and "End the Day", which the user did ask for — and
  which is consequently the one place a failed upload *does* reach an alert.
- **Recording a success is not part of the upload.** All three drains go through
  `uploadOrSetAside`, which has *only* the Firestore call inside its catch; the
  `markXSynced` write sits outside it. With the two together, a local SQLite
  failure to mark a row synced is classified as an upload failure — it carries
  no Firestore code, so it lands in `'unclear'`, counts against the row, and
  after five quarantines a record the server has had all along. Outside, it just
  stops the pass and the row is re-uploaded next time, which costs nothing.
- **Being set aside is a resting state, not a grave.** Settings' "Try sending
  refused records again" (`retryBlocked`) puts every `'blocked'` row back to
  `'pending'` with a cleared attempt count. It exists because the refusals this
  app actually produces are usually fixable on the phone: rules require
  `createdByUid` to equal the signed-in uid, so rows left by an abandoned run
  are rejected until that agent signs back in. The row only appears when
  something is actually blocked.
- **The queue is always described per kind, from one place.** `syncCountParts` /
  `describeSyncCounts` in `context/sync.tsx` word it for all four surfaces: the
  Home card's two lines, the "End the day?" confirmation and
  `PendingUploadsError`. "3 receipts and 1 store" is something a driver can act
  on and repeat to the server; "4 items" is a number they can only wait out.
  Stores especially — nothing else on that screen mentions them, so a totalled
  count is the difference between a visible queue and an invisible one.

"End the Day" closes the run and uploads a **manifest** — the device's own
counts, **per run and not per business day**, or two runs by one truck would
each report the other's receipts as well. The dashboard compares those to the
documents that actually arrived, so an incomplete upload is detectable with no
acknowledgement protocol. Only the **open** run's header is ever uploaded: the
header write says `status: 'open'`, so re-sending it for a closed run would
reopen it.

**Closing requires a connection.** It uploads everything still queued and only
writes the manifest once the queue is empty; if it can't be emptied it throws
`PendingUploadsError`, which the existing `runWithRetry` prompt turns into
"move somewhere with signal and try again". Nothing changes on a refusal — the
run stays open, the truck isn't cleared, every row stays put. On success the
card shows the manifest back (receipts, entries, stores, sales, returns): clearing the
truck and returning to the wizard looks identical whether it worked or the app
lost its state, so the numbers are what make it a confirmation.

**Refused records are the exception, and the manifest says so.**
`blockedUploadCount` is the one manifest number allowed to be non-zero at close:
a record the server rejected can't hold the day open, since nothing would ever
send it. Without the field a refusal and a *loss* look identical from the
server's side — both are a manifest count higher than the documents that
arrived — so the phone states which it is. Counted per run for receipts and
ledger entries; stores aren't run data, so every refused store on the device is
included. When it's above zero the "Day ended" alert says so instead of
"Everything was sent", and points at the Settings retry.

**Missing run details block closing, loudly.** Every step of the close needs the
run's stamp — the header write, `closeRun`, and the per-run manifest counts — so
a run whose details can't be assembled cannot be closed at all. That used to be
returned as `{ closed: false }`, the *same answer* "no run is open" gives, and
the card swallowed it: the driver tapped "End the day", watched a spinner and
got nothing — no manifest, no error, day still open. `endTheDay` now separates
the two, checking `runId` for "is a run open" and throwing
`MissingRunDetailsError` when one is open but undescribable. It stops the
sequence first thing, before the draft check and before the upload passes spend
a timeout each. It is in the card's `retryable` exceptions alongside
`OpenDraftError`, so it is reported once with an OK: the run log is only read at
mount, so retrying in-session re-reads the same empty state and fails
identically — the recovery is a restart, and the message says so.

**An open draft receipt blocks closing too.** A draft never uploads, so it isn't
in the pending count and would otherwise pass the connection check untouched and
then outlive the run — finalizing it the next morning would file yesterday's
sale under today's truck. `endTheDay` refuses first thing (`OpenDraftError`,
before the upload passes spend a timeout each) and the Home card runs the same
check *before* the confirm dialog, so the driver isn't asked "End the day?" only
to be refused. Both report through `openDraftMessage` — one wording, because it
is one fault.

Three rules keep that honest, and all are easy to undo by accident:

- **`refreshPending()` resolves `null`, not zero, when it can't count.** A
  failed count reported as an empty queue would let the day close over the top
  of unsent work — the exact thing the rule exists to prevent. `endTheDay`
  throws on `null`; the Home card, where it's only a status line, ignores it.
- **The reason a close was refused is the *real* one.** The sync pass keeps its
  last error (`lastFailureRef`) and `PendingUploadsError` reports it, so a rule
  rejection isn't described as a connection problem — which would send a driver
  outside to look for signal they already have.
`pendingUploadCount` is therefore always `0` now; the field stays because it is
what tells the dashboard a run closed under this rule. This **reverses** the
original "closing is allowed with items still queued" decision — don't restore
it from the old reasoning without asking.

**A timed-out closing write is verified, never assumed failed.** This is the
one that bit in production. `withTimeout` deliberately does not cancel the write
underneath it, so a timeout means "no answer yet" — not "did not happen". Read
as a failure, it splits a run in half: the manifest reached Firestore minutes
later, but the driver was told the day could not be ended, so `inventory.endRun`
— the *local* half, the one that actually clears the truck — never ran. The
server saw a closed day while the phone still believed the run was open and went
on stamping the next morning's receipts and batches with the same run id. Two
things fix it, both in `closeRun` (`lib/sync.ts`):

- **`CloseTimeoutMs` (45s), not `CallTimeoutMs` (12s)**, for both closing writes
  — the last-chance run header and the manifest. Nothing is queued behind them
  (the drains have finished and the queue is empty), and this is the one moment
  the driver is standing still with no way to act on the answer except to tap the
  same button again. Giving up early doesn't save them anything; it turns a slow
  link into a day that won't close.
- **A read-back before giving up.** On a timeout — and only a timeout —
  `runClosedOnServer` asks Firestore whether the run is already closed, and if it
  is, `closeRun` returns normally so the truck gets cleared. It uses
  **`getDocFromServer`, never a plain `getDoc`**: the default source falls back
  to the SDK's own cache, and the cache is exactly where our own unsent write is
  sitting, so a plain read would report the run closed on the strength of a write
  that never left the phone. It answers `false` on any failure, which is the safe
  direction — an unconfirmed close must leave the run open rather than clear a
  truck whose day the server has never heard about.

Between them, the split state also self-heals: whenever the driver successfully
closes, the manifest is rewritten to cover everything the run has accumulated
since, however many days that is.

**Every Firestore call is wrapped in a timeout** (`CallTimeoutMs` in
`lib/sync.ts`) and this is load-bearing, not defensive. Firestore's write
promise resolves when the *backend* acknowledges, so offline it doesn't reject —
it never settles. Unwrapped, one offline `setDoc` hangs the sync pass forever
(the heartbeat then skips because a pass is still running) and leaves "End the
Day" on "Ending…" with no alert, since the retry prompt only fires on a
rejection. The write isn't cancelled and may land later, which is harmless: every
upload is a `setDoc` at a known id, so a late write and a re-send agree.

Queueing is a `sync_state` column on the source row (`'pending'` / `'synced'` /
`'legacy'`), not a separate outbox holding copies — a copy can drift from the
row it describes, and repeat edits collapse into one upload this way. Each
table has a partial index on the pending rows.

**Customers are the one two-way collection** and the one that isn't under a
run. Everything else on this page is one truck's account of its own day;
a store belongs to the business, so every phone has to end up with the same
copy of it.

**The two directions run on different clocks, and that asymmetry is the
design:**

- **Push is live.** A create, an edit or a delete marks the row `'pending'` and
  nudges the same pass receipts and ledger entries use, so it goes up during the
  day and "End the Day" refuses to close while one is still queued (stores are
  in `refreshPending`'s count like everything else).
- **Pull happens once, when truck setup is finished** — `refreshCustomers`, one
  of the finish-setup downloads, and **nowhere else**. A watermark query
  (`updatedAt >= lastPulled`) applied last-write-wins by
  `upsertCustomerFromServer`; `lib/customer-sync.ts` holds it.

**Don't add a pull to the sync pass.** It reads as an obvious improvement —
stores would propagate within the minute — and it takes something away: the
route a truck is working would be rewritten under the driver mid-round by an
edit or a delete made on the server at noon. The list a truck leaves the depot
with is the list it works, and it changes at the next setup.

Four things there are load-bearing:

- **`refreshCustomers` re-reads the table into state before it resolves, and
  reports that read's outcome.** Because this is the *only* download stores ever
  get, the list it hands back is the list the truck works all trip — so when the
  setup screen ticks "Stores" off, the interface has to hold what the disk
  holds. It didn't before: the pull notified the list from *inside* itself
  (so the state update was still in flight when setup opened the run on top of
  it), and only when a row had actually moved — meaning a pull that applied two
  pages and then failed on the third came back `'cache'` and never notified at
  all, leaving the new stores on disk, unseen, until the next app launch. A
  failed re-read is not allowed to pass as success whatever the pull said: the
  answer downgrades to `'cache'`, never `'none'` and never conditioned on how
  many stores are showing — see the "odd one out" note above for why stores are
  not allowed to hold a setup back. Every
  path into the list (mount, "Try again", the pull's notification, this read)
  goes through one `applyFromDisk`, sequenced so a slow older read can't
  overwrite a newer one's answer.
- **Deletes must be soft.** A hard-deleted document is absent from the watermark
  query, so a device offline during the delete would keep the store on its route
  forever. Deleting sets `deleted = 1` and bumps `updatedAt`, and the phone
  hides those rows instead of dropping them.
- **The watermark query is `>=`, not `>`.** It is paged, and a strict `>` loses
  a store *permanently* if two rows share a millisecond either side of a page
  boundary — it is behind the cursor from then on and nothing asks again. `>=`
  re-reads the boundary row, which costs one document and nothing else: the
  upsert is a no-op for a version the phone already has, so it doesn't even
  rebuild the list on screen.
- **`local_updated_at` is not `updated_at`.** `updated_at` is the writing
  phone's clock and travels with the row, so once pulls land, it says nothing
  about who wrote it. The manifest's `customerCount` is this device's account of
  what *it* produced, so it counts `local_updated_at`, which only the three
  local writers in `customer-db.ts` ever set. For the same reason
  `updateCustomerRow` **returns the `updatedAt` it wrote** rather than letting
  the caller stamp its own `Date.now()`: that put the store in memory a few
  milliseconds ahead of the same store on disk, and `updatedAt` is what
  last-write-wins compares, what the pull orders by, and what
  `markCustomerSynced` / `markCustomerBlocked` match a row against.
- **The pull never rejects, and it is bounded.** It resolves `'fresh'` /
  `'cache'` (never `'none'`) — a throw would abort the receipts and ledger drains
  behind it in the pass, and would reach the setup screen's "everything failed"
  branch where saved copies stop being offered. It also stops paging at
  `PullBudgetMs`, so a long backlog on a slow link can't hold the setup spinner
  for minutes; the rest follows in the background.

**A store this phone just added sits at the top of the list with a "New" tag,
until a receipt is finalized for it.** A driver types a store in because they
are standing in front of it and are about to write it a receipt, and in a few
hundred stores sorted by name the one they just created is the hardest to find —
it is the only one whose position they have no memory of. Writing that receipt
is therefore the moment the tag has done its job, and it ends there. The tag
shows in both places a store is picked from: the Customers tab's cards and the
receipt form's store picker (`components/badge.tsx`, one pill shared by both,
and `DropdownOption.badge`, which is a plain string so `dropdown-field.tsx`
needn't know what a customer is). The ordering is part of the same feature and
lives in `sortCustomers` (`context/customers.tsx`), so every surface reading the
context gets it.

- **`is_new` is a stored column, not something derived from the timestamps.**
  Set by `insertCustomer`, cleared by `clearCustomerIsNew`, and touched by
  nothing else — `upsertCustomerFromServer` doesn't write it, so a store keeps
  its own answer when its copy comes back down from the server. `created_at`
  can't stand in for it: it travels with the row, so a store another handset
  created this morning would read as this phone's work. Neither can
  `local_updated_at`, which every *edit* bumps — correcting a pulled store would
  promote it to the top as if it were new. The flag stays on the device;
  `uploadCustomer` doesn't send it.
- **It was called `created_locally` until finalizing started clearing it**
  (`migrateNewUntilBilled`, user_version 7). Provenance was only ever the means:
  once a receipt clears the flag, a column named "created locally" reads 0 on a
  store this phone unquestionably created, and a lying column name is how the
  next reader gets a wrong idea for free. The question it actually answers is
  "is this the store you just added and haven't billed yet".
- **Clearing it is not a sync-visible change.** `clearCustomerIsNew` leaves
  `updated_at`, `local_updated_at` and `sync_state` alone, unlike every other
  writer in `customer-db.ts`. The flag is one handset's note to itself about its
  own screen — bumping `updated_at` would push an identical copy of the store to
  every other phone, and would put it ahead of a genuine edit in the
  last-write-wins comparison.
- **The clear is called from `applyFinalizedToList`** (`context/receipts.tsx`),
  which is the only function *both* routes through `finalize()` call — the fresh
  one and the already-finalized retry branch. Written into each separately it
  would be one more thing that branch could be left out of, which is a bug that
  section has already had once. It is fire-and-forget and `clearNewCustomer`
  swallows its own failures, so a badge that won't clear can never turn a saved
  receipt into a reported failure.
- **Nothing is backfilled, and the first version of this shipped a bug by
  trying to be.** It flagged every row where `local_updated_at = created_at`,
  on the reasoning that an insert writes both from one reading of the clock.
  So does `migrateLocalUpdatedAt`, though — it set `local_updated_at =
  updated_at` across the whole table, pulled rows included, and a store nobody
  has edited since it was created has `updated_at = created_at` as well. The
  condition matched nearly every row, so on the owner's phone every store
  younger than a day came back tagged "New", on both surfaces. A row written
  before the column existed simply cannot say where it came from, so it no
  longer guesses: existing rows are 0 and only `insertCustomer` sets a 1.
  `migrateClearBackfilledCreatedLocally` (user_version 6) exists because
  deleting the statement fixes only phones that hadn't run it yet — a device
  already at version 5 would keep the wrong flags for the life of the install.
- **The 24-hour window is the backstop, not the rule** — it only catches a store
  that is added and then never sold to, which would otherwise sit at the top of
  the list for ever. It is a duration rather than a business day, and that is
  the one place in the app where `lib/business-day.ts` is deliberately not used:
  nothing is *filed* by this, it decides how long a badge shows. As a business
  day it would blink out at Manila midnight, which on a route that runs past
  midnight is the middle of a shift, ten minutes after the store was added.
  `NewCustomerWindowMs` has no timezone in it at all.
- The order is settled at each sort rather than on a timer, and `Date.now()` is
  read **once per sort**, not per comparison — a window lapsing mid-sort would
  otherwise make the comparator inconsistent, which on some engines is a crash
  rather than a wrong list.

Trucks and agents are **dashboard-owned** (`apps/web/src/pages/reference-lists.tsx`)
and read-only on mobile. Trucks and agents used to live in each phone's
AsyncStorage, which minted a device-local id and made grouping anything by
truck impossible — that's why they moved, not tidiness.

They run on the shared catalog hook but with **`fetchOnMount: false`**: each is
fetched when *its own picker opens* (`ensureTrucksLoaded` /
`ensureAgentsLoaded`), tries the server fresh every time, and drops back to the
saved copy in silence if it can't. Both pass `isEmpty`, so a query
that comes back with zero documents can't overwrite the saved copy *and the
disk* — that failure would strand a truck at the setup screen with nothing to
pick, every restart, until it found signal. They are deliberately **not** in the
`catalogs` array that `runFetch` downloads when setup is finished — the driver
has just picked from those lists, so re-downloading them would gate finishing
setup on data that is already as fresh as the signal allowed. Don't add them
back to that array.

Both also respect the **manual `order`** the manager sets by dragging rows
on the dashboard. The Firestore query still asks for *name* order, because
`orderBy('order')` silently drops any document that doesn't carry the field;
the manager's order is applied after the read, with a missing `order` sorting to
the end rather than jumping to the front.

