# Sync — Design Notes

**Status: built.** This picks up item 5 of `docs/route-tracking-design.md`'s
suggested order ("Sync / End-of-Day upload mechanics"). The structure described
here is implemented — see "Where the code lives" at the bottom.

Scope of this document: **the shape of what gets uploaded.** The retry policy
(how often, backoff, what counts as a permanent failure) is deliberately still
open — what exists today is a nudge after every write plus a slow heartbeat.
The structure is chosen so that retrying is safe by construction, because a
structure that makes retries dangerous can't be fixed by a retry policy later.

> **Update, October 2026 — crews and areas are gone.** The driver now ticks
> each agent on the truck one by one; `agentGroups` (crews) and `areas` were
> removed from the phone, the dashboard and the store records on the owner's
> call. A run is **one truck, the agents aboard it, one trip out**; its id is
> keyed on the agents' names; nothing new stamps `areaId`, `areaName`,
> `agentGroupId` or `agentGroupName`; stores carry neither field. Older runs,
> receipts and stores in Firestore still hold those fields and nothing reads
> them (bar a receipt's printed crew name, read as the fallback for
> `agentNames`). The sections below have been updated; anything still
> describing crews or areas is history. See the root `CLAUDE.md`.

---

## What changed since route-tracking-design.md

That document assumed **zero signal from departure until return**, so sync was
phase-based: pull at the depot, work offline all day, push everything at the
end. The plan now is **live uploads throughout the day**, with "End the Day" as
a closing indicator rather than the moment the data moves.

The important consequence: a live upload must be **best-effort and invisible**.
It can never block, slow, or fail a sale. The phone remains the source of truth
during the route and everything already written works exactly as it does today
with no signal at all — the upload is a background copy that catches up when it
can. Nothing in the existing local flow changes.

---

## The one idea: the Run

The owner's requirement is that an upload group **truck + the agents aboard**
with its inventory and receipts (it was area + truck + crew until crews and
areas were removed). That grouping is a real thing with a start and an end, so
it gets a document of its own. Call it a **run**: one truck, its agents, one
trip out, and everything they did.

**A run is not bounded by the business day.** It used to be described as one —
"one truck, one area, one crew, one business day" — and that was only ever a
description of the usual case, never something the code enforced: nothing has
ever compared an open run's day against today. The truck may stay out across
midnight and come back two days later, and that is now a supported shape rather
than an accident. What follows from it:

- The run keeps the `businessDay` it started on, and the dashboard shows it on
  that day and nowhere else. A run belongs to the trip that opened it.
- `closedBusinessDay` on the closing write says which day it *ended* on, so the
  server can tell a run that finished at 6 PM from one that finished at 6 PM two
  days later. The dashboard's `runEndDay` / `runSpansDays` / `describeRunEnd`
  (`apps/web/src/lib/runs.ts`) are the only readers, and they are the only place
  the wording lives.
- Every child document still stamps its *own* `businessDay` from when it was
  written (`businessDayKey(createdAt)`), so a receipt written on the second
  morning says so even though its run is filed under the first.
- The manifest covers the whole run, however many days that is — it always has,
  because it was already counted per run rather than per day.

This already exists on the phone. `context/inventory.tsx` holds:

```ts
type InventorySetup = {
  truckId: string | null;
  agentIds: string[];
  complete: boolean;
  // …plus the pinned run bookkeeping (runId, runStartedAt, runSequence, …)
};
```

Finishing the setup screen is the moment a run begins. So: **`finalizeSetup()`
creates the run document**, and every stock entry and receipt from then on is
written inside it. No new concept for the user to learn and no new screen —
the wizard they already fill in *is* the run header.

Everything else in this document follows from that.

---

## Collection map

```
trucks/{truckId}                    dashboard-owned    NEW  (move off AsyncStorage)
agents/{agentId}                    dashboard-owned    one person
areas/{areaId}, agentGroups/{id}    LEGACY, read-only  removed Oct 2026; unread
breadTypes/{id}                     dashboard-owned    exists
returnedBreadTypes/{id}             dashboard-owned    exists
settings/business                   dashboard-owned    exists

customers/{customerId}              mobile-owned, two-way sync   NEW

runs/{runId}                        mobile-created               NEW
  ├── stockEntries/{entryId}        the ledger, one doc per entry
  ├── receipts/{receiptId}          finalized receipts only
  ├── expenses/{expenseId}          what the truck spent on the trip
  └── cashCounts/{runId}            the cash breakdown — one per run, id = run id

Cloud Storage (not Firestore):
paymentProofs/{receiptId}.jpg       the GCash/cheque proof photo
```

Inventory, receipts and expenses are **subcollections of the run**, not top-level
collections with a `runId` field. That is the grouping the owner asked for,
expressed directly: opening one run in the dashboard shows that truck's whole
day without a single join.

Cross-run questions ("every receipt for this store", "today's sales across all
trucks") are answered with **collection group queries**, which read across every
`receipts` subcollection at once. That needs composite indexes — listed at the
bottom — but it costs nothing structurally.

---

## Six rules that make the structure work

These are the load-bearing decisions. Each one exists to prevent a specific
failure.

### 1. Every id is generated on the phone, before upload

Each local table already mints its own id (`stock-db.ts`, `receipt-db.ts`,
`customer-db.ts` all use the same `Date.now().toString(36)-random` generator).
That id becomes the Firestore document id, unchanged.

This is what makes retrying safe. Every upload is `setDoc(ref, data)` at a known
path — running it once and running it five times produce the identical result.
There is no "did my last attempt get through?" question to answer, so the retry
policy can be as dumb as "try again" without risking a duplicate receipt or a
double stock deduction.

The alternative — letting Firestore assign ids with `addDoc` — makes every
retry a potential duplicate, and no amount of careful retry logic fully closes
that hole on a flaky connection. Never use `addDoc` for anything on this path.

Ids are minted by `lib/id.ts`, which does not lean on randomness alone. Each id
carries a per-launch tag, a counter that strictly increases within that launch,
and a timestamp. Two ids can therefore only collide if they came from the same
launch of the app on the same phone — and the counter makes that impossible.
Across devices and launches, the tag separates them. (500,000 generated in a
row: zero duplicates.)

**The run id is the exception — it is composed, not generated:**

```
runId = `${businessDay}_${agents}_${account}`        a run
      = "2026-10-03_Juan-Dela-Cruz+Maria-Santos_juan@bakery.ph"

runId = `${businessDay}_${agents}_${account}_${n}`   n-th run, n > 1
      = "2026-10-03_Juan-Dela-Cruz+Maria-Santos_juan@bakery.ph_2"
```

**The middle segment is the ticked agents' names** — each flattened by
`runIdSegment` and joined with `+`, in the dashboard list's order
(`agentsRunIdSegment` in `lib/sync-types.ts`) — not their document ids, and that
is the whole reason for composing the id rather than generating one: an id is
only readable next to the list it came from, and a name makes a stray document
traceable on sight. The owner asked for the id to say who went out. The real ids
are still stamped on the run and on every child document as `agentIds`.

(Runs opened while crews existed were keyed on the crew's name —
`2026-08-15_Alpha-Crew_juan@bakery.ph` — and keep those ids, which are pinned.)

The names are captured **when the run opens** and the composed id is pinned into
the setup, never recomposed. So renaming an agent on the dashboard at noon
cannot re-point an open run at a document that doesn't exist.

A name is not unique the way an id is. That is handled rather than avoided: two
runs whose agents flatten to one segment compute the same base id, and the
second is moved onto `_2` by the same `sequence` machinery a second trip by the
same people uses — see below.

The id is **not** recomputed to rejoin a run, and used to be. A phone
reinstalled mid-day takes its local databases with it, so the truck is counted
from scratch and a "rejoined" run would close with a manifest describing only
the afternoon. `findFreeRunSequence` moves such a phone onto the next free
number instead, leaving the morning's run open and unmanifested — a visible
loose end rather than a plausible wrong number.

Two suffixes, each closing a different collision. Both matter because both
failures are silent, and both destroy the manifest — the only number the
dashboard has for spotting an incomplete upload.

**`account` keeps two phones off each other's run.** Two phones can tick the
same people on the same day, one of them by mistake, and with the names alone
both compute the same id and share one document: the second phone's header
overwrites the first's (including `status` back to `"open"` on a closed run),
and whichever ends the day last overwrites the other's manifest. Child
documents survive — their ids are phone-minted and unique — but the two runs
become one indistinguishable pile.

Keyed on the **login**, not on the device. A device tag would separate two
phones equally well, but it changes on a reinstall — so one agent's two trips
would land under two different names, and the server would have no way to see
they were the same account's day. It says something true as well: a run is one
*account's* trip out, which is what the rest of the document already assumes — `RunManifest` is documented as what the *device*
believes it produced, and `pendingUploadCount` is that phone's queue.

**`sequence` lets the same account take the same people out twice in a day.**
The first run carries no suffix, so the common case stays short; a second
appends `_2`. The counter is per business day and resets with it, and it is
counted per account, so a second agent picking up the same handset starts at
their own 1. It counts runs under the same *agents segment*, matching what the
id is keyed on: the same people coming back and taking a different truck out
are on their second trip, and numbering it 1 again would recompute the
morning's id and merge the two trips into one document.

The account comes from the signed-in user. The sequence is settled from two
sides, because neither side can answer it alone:

1. A log of recent runs kept in AsyncStorage alongside the setup
   (`context/inventory.tsx`) gives the **starting** number.
2. `findFreeRunSequence` (`lib/sync.ts`) then reads `runs/{id}` and moves past
   the number if a document is already there, one at a time, up to a small cap.

The log is the only thing that knows about a run whose header has not uploaded
yet — a morning spent out of signal produces no document for the server to find,
so asking the server alone would hand back a number the phone already knows is
taken. Firestore is the only thing that knows about a run *this handset* has no
memory of: it was reinstalled, reset or replaced between the two trips, or a
second handset is signed in to the same login, which the account segment cannot
separate because it is the same account. Either gap ends the same way — two
trips computing one id, the second's header and manifest overwriting the first's
while every child document survives, so nothing looks wrong until someone reads
it on the server.

**The probe never blocks opening a run.** Setup has to work at a depot with no
signal, so it runs on a short timeout of its own (much shorter than an upload's:
a timed-out probe costs nothing, and a driver is watching a spinner) and a
failure resolves with the local count. That is not a degraded mode, it is
exactly what the phone did before the probe existed.

**An id that already exists is taken** — whoever wrote it, and whether it is
open or closed. This reverses an earlier decision that a wiped phone should
recompute its way back onto the morning's run. It cannot really rejoin it: a
reinstall takes the local databases too, so the truck is counted from scratch
and the rejoined run would close with a manifest describing only the afternoon —
a plausible-looking wrong number. It takes a fresh number instead, and the
morning's run stays open with no manifest, which the dashboard shows as a run
that never ended: a visible loose end rather than a quiet lie.

**The composed id and every segment that went into it are pinned into
`InventorySetup` when setup is finished, never read fresh.** For the account specifically: logging out does not end a run (it
clears the Firebase session and nothing else), so an agent swap on one handset
must not re-point an open run at a different document — every row already
written carries the old id.

### What the server does about it, and why that is not much

Nothing enforces one-run-per-truck server-side, deliberately.

- **It cannot tell the two cases apart.** "Two agents riding the same truck,
  both using the app" and "someone tapped the wrong truck" produce identical
  writes. That is a human judgment.
- **Rejecting the second writer would strand it.** Uploads never alert (see
  CLAUDE.md). A rule that refused phone B's header would leave its driver
  working all day on a run that could never close, with nothing on screen
  saying so — a silent permanent failure, worse than the overwrite.
- **It has to work offline.** The collision is decided at the warehouse when
  "Finish setup" is tapped; there may be nothing to ask.

Making `createdByUid` immutable as a backstop was considered and rejected for a
concrete reason: because sign-out leaves a run open, an agent swap on one phone
legitimately changes the writer, and an immutable-creator rule would make that
run impossible to close.

So the id makes the data unambiguous, and the *dashboard* is where the anomaly
surfaces: group by `businessDay` + `truckId` — the composite index for that
already exists — and show that a truck had more than one run that day, with
`createdByEmail` naming who. Detection lands where the judgment is.

The business day comes from `businessDayKey` — a *Manila* day. Deriving it from
the device's timezone would file a 6:30 AM run under the previous day.

One consequence to know: the day is taken from `runStartedAt`, pinned when
setup finishes, not from "now". A run that crosses midnight stays one run
rather than silently splitting in two.

**Every uploaded row carries the run it was written in, and uploads with that
run — never with whichever run is open when the queue happens to drain.** The
distinction only appears once a truck can run twice: a receipt from the morning
that hadn't found signal yet would otherwise be filed under the afternoon's run.
So `receipts.run_id` and `stock_batches.run_id` are stored locally, and the
drain looks each row's run up in the run log to stamp it.

### 2. Only finalized things upload

A draft receipt and a draft inventory count are scratch work. They stay on the
phone until finalized, exactly as they already do locally. The dashboard should
never see a number that is still being typed.

### 3. Line items are arrays inside the document, never subcollections

A receipt's items and returns, and a stock entry's items, are stored as arrays
on the document itself:

```ts
items: [{ breadTypeId, name, unitPrice, quantity }, ...]
```

One receipt is therefore **one document write**, not one plus one per line. A
receipt with twenty bread types is a few kilobytes against a 1 MB document
limit, so there is no volume argument for splitting them, and splitting them
would mean a receipt could arrive half-uploaded.

### 4. Every child document carries its own copy of the run's identity

Each stock entry and receipt repeats `runId`, `businessDay`, `truckId` and
`agentIds`, even though its parent run already holds them. (Documents written
before crews and areas were removed also carry `areaId` and `agentGroupId`.)

Two reasons. It makes every dashboard query one hop instead of two — filtering
receipts by truck doesn't require loading runs first. And it means a document
that arrives before its parent run is still completely interpretable, which
matters because uploads land in whatever order the signal allows.

This is the same snapshot habit the receipts already follow locally, where
`customerName` and `unitPrice` are copied onto the receipt so a later edit can't
rewrite history.

### 5. Device time stays canonical; server time is recorded separately

Everything the app stores is `Date.now()` and that does not change on upload.
The moment a sale happened is a fact about the sale, not about when the phone
found a signal — a receipt written at 6:30 AM and uploaded at 4 PM must still
report 6:30 AM.

So each uploaded document carries both:

```ts
createdAt: 1755230400000,          // Date.now() on the phone — the real moment
uploadedAt: serverTimestamp(),     // when it reached Firestore
businessDay: "2026-08-15",         // businessDayKey(createdAt) — Manila
```

`uploadedAt` is for diagnosing sync lag and nothing else. It must never
overwrite or stand in for `createdAt`.

**`businessDay` is computed once, on the phone, with `lib/business-day.ts`,
and stored as a string.** Do not let the dashboard derive the day from the
timestamp — a browser in another timezone would file a 6:30 AM Manila receipt
under the previous day, which is the exact bug `business-day.ts` exists to
prevent. The string travels with the document so every reader agrees.

### 6. Sale entries upload even though receipts imply them

When a receipt is finalized the app appends a negative `sale` entry to the stock
ledger. That entry is uploaded as its own document in `stockEntries`, alongside
the receipt.

It looks redundant — the receipt's items already say what was sold. It is not.
`finalize()` writes to two separate SQLite databases in two separate
transactions, and a crash between them leaves a finalized receipt whose stock
was never deducted. That shortfall is documented, deliberate and user-visible on
the phone. If the dashboard derived sales from receipts instead of uploading the
ledger, that discrepancy would be invisible in the cloud — the dashboard would
confidently report stock that the truck doesn't actually have. Uploading both
keeps the two comparable, so a mismatch shows up as a mismatch.

---

## Document shapes

### `runs/{runId}`

```ts
{
  schemaVersion: 1,
  runId: "2026-10-03_Juan-Dela-Cruz+Maria-Santos_juan@bakery.ph",
  businessDay: "2026-10-03",        // Manila, businessDayKey()
  sequence: 1,                      // 2 if the same people went back out that day

  truckId: "trk_def",
  truckName: "Truck 3",             // snapshot — survives a later rename
  agentIds: ["agt_1", "agt_2"],     // who the driver ticked when the run opened
  agents: [                         // snapshot, same reasoning
    { id: "agt_1", name: "Juan Dela Cruz" },
    { id: "agt_2", name: "Maria Santos" },
  ],

  createdByUid: "firebase-auth-uid",   // which mobile account started it
  createdByEmail: "juan@bakery.ph",    // the readable form; also in the run id
  startedAt: 1755230400000,
  status: "open",                      // "open" | "closed"
  closedAt: null,
  uploadedAt: serverTimestamp(),
}
```

The `truckName` / `agents` snapshots follow the same rule as receipt line
items: renaming a truck or an agent next month must not rewrite what last
month's reports say. The ids are there for querying, the names for reading.

### `runs/{runId}/stockEntries/{entryId}`

Mirrors `Batch` in `lib/stock-types.ts` one for one.

```ts
{
  schemaVersion: 1,
  entryId: "l3k2j1-a9f8e7",
  kind: "initial" | "addition" | "sale" | "void",
  items: [{ breadTypeId: "bt_pandesal", quantity: 240 }, ...],
  // negative quantities on a "sale" — that is how the ledger deducts
  // positive on a "void": a voided receipt's sale, given back to the truck

  receiptId: "rcp_x1y2" | null,     // set on "sale" and "void", links back
  createdAt: 1755230400000,

  runId, businessDay, truckId, agentIds, createdByUid,  // rule 4
  uploadedAt: serverTimestamp(),
}
```

Current stock on the truck is `SUM(quantity) GROUP BY breadTypeId` over these —
the same sum the phone already does in SQL, reproduced in the cloud from the
same data.

### `runs/{runId}/receipts/{receiptId}`

Mirrors `ReceiptDetail`, minus the draft-only fields.

```ts
{
  schemaVersion: 1,
  receiptId: "rcp_x1y2",
  customerId: "cus_p9q8",
  customerName: "Aling Nena Store",     // snapshot, as stored locally
  customerContactName: "Nena Reyes",

  items:   [{ breadTypeId, name, unitPrice, quantity }, ...],
  returns: [{ returnedBreadTypeId, name, unitPrice, quantity }, ...],

  subtotal: 1250,
  returnsTotal: 90,
  total: 1160,
  paymentMethod: "cash" | "gcash" | "cheque" | "partial" | "credit",
  amountPaid: 800 | null,               // only meaningful when "partial"

  createdAt: 1755230400000,
  finalizedAt: 1755231000000,

  proofStoragePath: null,               // reserved — see "Deferred" below
  voidedAt: null,                       // set when the driver voids it

  runId, businessDay, truckId, agentIds, createdByUid,  // rule 4
  uploadedAt: serverTimestamp(),
}
```

`status` is not uploaded because it is always `"finalized"` — drafts never
leave the phone (rule 2).

**A void is an update, not a delete.** A driver can void a finalized receipt,
but only during the run it belongs to. The phone sets `voidedAt`, re-queues the
receipt (the same `setDoc` at the same id, so rule 1 still holds), and writes a
`"void"` stock entry giving back what the receipt's sale entry took. The
dashboard keeps listing the receipt and counts it in nothing. The manifest's
`receiptCount`, `salesTotal` and `returnsTotal` leave voided receipts out, and
`voidedReceiptCount` counts them.

`proofStoragePath` is written as `null` from day one. Proof photos are deferred,
but reserving the field now means turning them on later adds a value to an
existing field instead of reshaping documents that already exist.

### `runs/{runId}/expenses/{expenseId}`

What the truck spent while it was out. Mirrors `Expense` in
`lib/expense-types.ts`: `title`, `amount` (pesos, always positive), `notes`,
`createdAt`, `updatedAt`, `deleted`, plus the rule-4 stamp.

Two things about it are decisions rather than details:

**The amount is never signed and never netted off anything.** Expenses are
*informational*: no total on the phone, and nothing on the dashboard — not a
run's net, not a truck's metrics, not the Trends charts — subtracts them from
sales. They are shown beside the takings.

**Deletes are soft**, for the same reason a customer's are: `firestore.rules`
refuses every delete under `/runs`, so a removal has to travel as a flag. That
is why the manifest's two expense figures count different sets —
`expenseCount` includes deleted rows (documents sent), `expenseTotal` excludes
them (money spent).

### `runs/{runId}/cashCounts/{runId}`

The cash the agents counted, bill by bill: `bills` (a map keyed `'1000'`,
`'500'`, `'200'`, `'100'`, `'50'`, `'20'` → how many), `coins` (one peso
amount), `total` (as the phone added it up), `updatedAt`, `businessDay`, plus
the rule-4 stamp. Mirrors `CashCount` in `lib/cash-count.ts`.

**One document per run, at the run's own id**, overwritten (not merged) every
time the driver re-saves — it is a snapshot of the bag, not a log. That keeps
rule 1: a re-send lands on the same document. The `/runs/**` rule already
covers it, so it needed no rules change. Drained after expenses, marked synced
on `updatedAt` so a recount mid-upload isn't recorded as sent.

**"End the Day" refuses to close without one** — and without at least one
expense (₱0 is allowed). See `findMissingCloseout` in `context/sync.tsx`.

### `paymentProofs/{receiptId}.jpg` — Cloud Storage

The only upload that sends **bytes** rather than a document, and the only reason
Cloud Storage is enabled.

The object name is derived from the receipt id, which gives it the same property
rule 1 gives every Firestore write: re-sending overwrites the same object rather
than creating a second one. A random name per attempt would leave orphaned
megabytes in the bucket that nothing could ever find.

Custom metadata rides along — `receiptId`, `runId`, `businessDay`, `truckId`,
`createdByUid`. The last is not decoration: `storage.rules` requires it to equal
the signed-in account, the same check the Firestore rules make on run documents.

**The path reaches Firestore only after the bytes land.** `proofStoragePath` is
written from what a *completed* upload reported, never assembled from the
receipt id, so a non-null path is a promise that the object exists. Since a
receipt is normally uploaded long before the driver takes the photo, a
successful photo upload flips its receipt back to `'pending'` so the document
goes up again carrying the path.

Photos drain **last** in the pass and get their own, much longer timeout: at
`CallTimeoutMs` a perfectly good photo upload would be classified as "no signal"
and re-sent forever.

### `customers/{customerId}`

Top-level, not under a run — a store belongs to the business, not to the day
someone happened to create it.

```ts
{
  schemaVersion: 1,
  storeName, name, address, phone,
  schedule: "Mon & Thu",            // free text (deliveryDays / description / areaId / agentGroupId: removed Oct 2026)

  createdAt, updatedAt,             // Date.now(), device clock
  deleted: false,                   // soft delete — see below
  updatedByUid,                     // whoever pushed this version
  uploadedAt: serverTimestamp(),
}
```

**No `createdByUid`**, unlike every document under a run. The phone doesn't
record who first created a store — there is no such column in the local table —
so it has nothing truthful to write, and a merge write from whoever edited the
store next would stamp the wrong account into it. Every other uploaded document
carries a creator because it is one truck's account of its own trip; a store is
not, and the last person to change it is the useful fact about it. Adding a
creator later means a local column first, not just a field here.

---

## What uploads when

A day, in order. Each step is fire-and-forget: it queues locally and uploads
when it can, and the app carries on regardless.

**Setup finished** → the run document is created. This happens at the depot
where signal is reliable, and the existing setup screen already hard-requires
connectivity for a brand-new install, so in practice the run lands before
anything goes inside it. Nothing depends on that though — rule 4 means a child
that arrives first still makes sense on its own.

**Initial inventory finalized** → one `stockEntries` document, `kind: "initial"`.

**A batch is added mid-route** → one `stockEntries` document, `kind: "addition"`.

**A receipt is finalized** → two documents: the receipt, and its negative
`sale` stock entry (rule 6).

**A customer is created or edited** → one `customers` document. Lower priority
than the two above; it can ride at the back of the queue.

**End the Day** → the run closes. Covered next.

---

## End the Day

The owner's read is right: nothing fancy is needed, because everything
meaningful is already up. Its job is to say *the day is over* and to catch
anything still sitting on the phone.

What makes it worth more than a flag is that it uploads a **manifest** — the
device's own count of what it produced:

```ts
// merged into runs/{runId}
{
  status: "closed",
  closedAt: 1755270000000,
  manifest: {
    receiptCount: 47,         // voided receipts excluded, as from the two totals
    voidedReceiptCount: 1,
    stockEntryCount: 12,
    customerCount: 3,
    salesTotal: 38400,
    returnsTotal: 2100,
    expenseCount: 4,          // documents sent, deleted expenses included
    expenseTotal: 1850,       // money spent, deleted expenses excluded
    paymentProofCount: 2,     // proof photos, checked against receipts carrying a path
    pendingUploadCount: 0,    // always 0 — closing requires an empty queue
    blockedUploadCount: 0,    // records the server refused; may be > 0
  },
}
```

`blockedUploadCount` is the one count allowed to be non-zero at close. A refused
record cannot hold the day open — nothing would ever send it — so without the
field a *refusal* and a *loss* are indistinguishable from the server's side:
both appear only as a manifest count higher than the documents that arrived, and
they need different responses. Receipts and ledger entries are counted for that
run; stores aren't run data, so every refused store on the device is included.

The dashboard then has a cheap, honest completeness check: **count the
documents that actually arrived and compare them to the manifest.** If the
manifest says 47 receipts and 45 are present, the run is visibly incomplete —
without any acknowledgement protocol, without the phone and server having to
agree on anything in real time, and without trusting the upload path to be
reliable.

Those counts are **per run**, not per business day. While a truck could only go
out once a day the two were the same thing; with two runs, a day-bounded count
reports each run's receipts in the other run's manifest as well — which is
exactly the arithmetic the manifest exists to let the dashboard trust.

**Closing requires a working connection.** "End the Day" uploads everything the
phone is still holding, and only writes the manifest once the queue is empty. If
it can't be emptied it refuses, leaving the run open, the truck untouched and
every row where it is — the driver gets "move somewhere with signal and try
again", which is the existing `runWithRetry` prompt doing its normal job.

**A timed-out closing write is verified, not assumed failed.** `withTimeout`
never cancels the write underneath it (see `CallTimeoutMs`), so a timeout means
"no answer yet", not "did not happen". Read as a failure it split a run in half
in production: the manifest reached Firestore while the driver was told the day
could not be ended, so `endRun` — the local half, the one that actually clears
the truck — never ran. The server saw a closed day; the phone kept stamping the
next morning's work with the same run id. `closeRun` now asks the server
outright before giving up (`getDocFromServer`, never a plain `getDoc` — the
cache is exactly where our own unsent write is sitting), and treats an
already-closed run as closed. The two closing writes also get `CloseTimeoutMs`
rather than `CallTimeoutMs`: nothing is queued behind them, and this is the one
moment the driver is standing still with no way to act on the answer except to
tap the same button again.

This reverses the original decision, which allowed closing with rows still
queued on the grounds that blocking a driver on a weak warehouse signal was the
worse trade. What changed the balance: ending the day is the one moment in a
route when someone is standing still and can move a few metres, and a run that
closes with work left behind hands the server a total that isn't complete yet
and looks like one that is. `pendingUploadCount` stays in the manifest and is
now always `0` — the field is what says so, and removing it would make a
complete run indistinguishable from one that predates the rule.

Several upload passes rather than one, because a pass moves at most 25 rows per
collection and a phone that has been in a dead zone since morning may hold far
more. The loop stops the moment a pass makes no progress, which is what an
offline phone looks like.

On success the manifest is handed back to the caller and shown to the driver —
receipts, ledger entries, sales, returns. Ending the day clears the truck and
returns to the setup wizard, which looks the same whether it worked or the app
lost its state, so the numbers are what make it a confirmation rather than a
screen that changed.

**An open draft receipt also blocks closing.** Drafts never upload (rule 2), so
one is invisible to the pending count and would sail through the connection
check, then survive into the next run — where finalizing it would file
yesterday's sale under today's truck. Ending the day is the natural moment to
force the decision, so it refuses until the draft is finalized or deleted.

Three supporting rules, all easy to undo by accident:

- **A pending count that failed is not a count of zero.** `refreshPending()`
  resolves `null` when it can't read the local queue; closing on the back of a
  zeroed-out failure would mark the day finished over the top of unsent work.
- **The refusal reports the actual error.** The pass keeps its last failure and
  `PendingUploadsError` includes it, so a rules rejection isn't described as a
  connection problem — which would send a driver looking for signal they have.
- **One fault, one wording.** The draft check runs twice — once before the
  confirm dialog for the sake of the flow, once inside `endTheDay` where it is
  actually enforced — and both report through `openDraftMessage`.

One consequence for account handling: **logging out is blocked while a run is
open**. Sign-out does not end a run, and a second account inheriting one would
upload documents stamped with the first account's `createdByUid`, which the
rules reject — permanently, and with the queue never emptying, unclosable.

**Closing also hands back an empty truck**: the setup is cleared, so the next
run starts at the setup wizard with no stock on board. Nothing is deleted to
achieve that — the ledger is scoped by run, so the new run simply has no
entries yet (see "Local changes this implies"). Deleting would have been the
obvious implementation and the wrong one: it would have destroyed exactly the
rows that hadn't uploaded yet.

Re-opening a closed run is not supported. If a truck goes back out, that is a
new run with the next sequence number — see rule 1.

---

## Customer sync

Customers are the one collection that flows **both ways**, and the two
directions run on different clocks: **push is live, pull happens once per run,
at setup.** It is not time-critical — per the route-tracking notes, manager and
roster changes happen before operations start — so a pull at the depot is
enough, and it has the added property that a truck's route doesn't move under it
during the round.

**Push** is the same as everything else: local id becomes the document id,
`setDoc` on change. It rides the ordinary sync pass alongside receipts and
ledger entries, which means it is also covered by "End the Day": the day cannot
close with a store still queued, exactly as it cannot close with a receipt still
queued.

**Pull** is a watermark query — ask only for what changed since last time:

```ts
query(collection(db, "customers"),
      where("updatedAt", ">=", lastPulledAt),
      orderBy("updatedAt"),
      limit(200))
```

**It runs in exactly one place: when truck setup is finished** — a fourth row in
the download list beside bread types, return prices and business details
(`lib/customer-sync.ts`). That is the moment the app deliberately stops and
downloads, at the depot, where there is signal, and the moment it is worth
*saying* the store list couldn't be refreshed rather than retrying quietly all
morning. A failure lands in the same retry / use-saved-copy prompt as the
catalogs, where "saved copy" means the stores already on this phone and
"nothing to fall back on" means a device with no stores at all, which cannot
write a receipt and so must get online.

**The sync pass deliberately does not pull.** Pulling continuously is the
obvious-looking version and it is worse: a store edited or deleted on the server
at noon would rewrite the route a driver is halfway through working, with
nothing on screen to say it changed. The list a truck leaves with is the list it
works; it is replaced at the next setup, which is also when a truck that goes
back out picks up the day's changes. Uploads stay live regardless — the
asymmetry is intentional, not an unfinished half.

Three consequences of that query that have to be designed for now, not later:

**`>=`, not `>`.** The result set is capped, so a catch-up pages through it with
the last row's `updatedAt` as the next cursor — and with a strict `>`, two
stores written in the same millisecond either side of a page boundary lose the
second one *permanently*: it sits behind the cursor and nothing ever asks for it
again. `>=` re-reads the boundary row instead. That costs one document and
changes nothing else, because the local upsert is a no-op for a version the
phone already holds — it doesn't even report a change, so the list on screen
isn't rebuilt.

**Deletes must be soft.** A hard-deleted document is absent from the result set,
so a device that was offline during the delete never learns about it and keeps
the store on its route forever. Deleting therefore sets `deleted: true` and
bumps `updatedAt`; the phone hides deleted rows rather than dropping them. This
also has to change the local table, so it is worth doing before customer data
matters.

**Conflicts are last-write-wins**, already decided in the route-tracking notes.
With `updatedAt` on both sides that is a one-line comparison: the higher
`updatedAt` wins. Two agents editing the same store on the same day is rare
enough — store coverage inside a shared area is settled by people, not the app.

That comparison is also what protects an unsent local edit. A row still marked
`'pending'` is by definition newer than what the server holds, so an incoming
copy loses and the push still happens; nothing has to check the sync state to
get that right.

**`updatedAt` stops meaning "this phone wrote it" the moment pulls exist.** It
is the writing device's clock and it travels with the row, so a store another
agent corrected this morning arrives here stamped this morning. That matters in
exactly one place: the manifest's `customerCount`, which is the device's account
of what *it* produced. Counting on `updatedAt` folded in every store the truck
merely received. There is a second column, `local_updated_at`, set only by the
three local writers in `customer-db.ts` and never by the pull, and the manifest
counts that.

---

## Trucks and agents move to the dashboard

The owner's instinct here is right, and it also removes a real problem.

Right now `context/inventory.tsx` keeps trucks and employees in AsyncStorage on
each phone, each with a locally generated id. Two phones typing "Truck 3" get
two different ids, so uploaded runs could never be grouped by truck. Making them
dashboard-owned isn't polish — it's what makes `truckId` mean anything at all.

- **`trucks`** and **`agents`** become Firestore collections written by the
  dashboard and read-only on mobile, exactly like `breadTypes`.
- The "Add truck" / "Add employee" modals come out of the mobile setup screen;
  the dropdowns stay.
- On mobile both run on the existing `hooks/use-cached-catalog.ts` — the
  same fetch-fresh, fall-back-to-saved-copy behaviour the other catalogs have —
  but with **`fetchOnMount: false`**. Each is fetched **when its own dropdown
  opens**, so every open shows the newest list the phone can get hold of, and
  falls back to the saved copy without saying anything when it can't.
- They are deliberately **not** part of the finish-setup download list. These
  are picked at one moment, from a dropdown that just refreshed them;
  re-downloading them when "Finish setup" is pressed would gate starting the
  day on lists the driver has already successfully chosen from. The finish-time
  fetch stays what it was: bread types, return prices, business details.
- The dashboard has simple CRUD lists for **trucks** and **agents** — both
  just `{ name }`, sharing one list-and-form pattern on the reference-lists
  page. (Areas had one too until they were removed.)

Existing local trucks and employees are test data with local ids and no
migration path. Since nothing is in production, clear them and re-enter the real
list in the dashboard.

The mobile code calls these "employees" (`Employee`, `employeeIds`,
`EMPLOYEES_KEY`) while the owner calls them agents. Worth settling on **agent**
everywhere while the rename is still cheap — one context file and its callers.

### Agents were grouped into crews — no longer

From August to October 2026 a truck was assigned a **whole crew**
(`agentGroups/{groupId}`, with `groupId` on each agent). The owner removed crews
in October 2026: the driver now ticks each agent individually
(`components/agents-field.tsx`), and `agents` is a flat list. The
`agentGroups` collection is read-only by rule and unread, kept only so a phone
on an older build can still finish setup.

---

## Local changes this implies

**A sync state column on each source table**, rather than a separate outbox
table holding copies of the data to upload:

```sql
ALTER TABLE receipts       ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE stock_batches  ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE customers      ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending';
-- 'pending' | 'synced'
```

A copy-based outbox can drift from the row it describes — edit a customer twice
before either upload lands and the queue holds two stale snapshots to send in
order. A flag on the row itself always uploads the current version, and repeat
edits collapse into one upload. Each table gets a partial index on
`WHERE sync_state = 'pending'`, the same trick `idx_receipts_draft` already
uses, so "what still needs uploading?" stays cheap no matter how many thousands
of receipts have accumulated.

**Customers additionally need** `deleted INTEGER NOT NULL DEFAULT 0`,
`local_updated_at INTEGER` (see "Customer sync" above) and a stored
`lastPulledAt` watermark.

**A `run_id` column on `receipts` and on the ledger**, written when the row is
created (a ledger entry) or finalized (a receipt). It does two jobs:

```sql
ALTER TABLE receipts          ADD COLUMN run_id TEXT;
ALTER TABLE stock_batches     ADD COLUMN run_id TEXT;
ALTER TABLE stock_batch_items ADD COLUMN run_id TEXT;   -- see below
ALTER TABLE stock_meta        ADD COLUMN run_id TEXT;
```

1. **It says which run a row uploads into**, so a row still queued when the next
   run starts is still filed under the run it was written in.
2. **For the ledger only, it scopes what "on the truck" means.** Totals and
   history are filtered by run, which is what lets "End the Day" hand back an
   empty truck without deleting anything. Receipts are deliberately *not*
   scoped for reading — the Receipts tab is a running history across every day
   and should stay one.

`run_id` is repeated on `stock_batch_items` rather than reached through a join
to `stock_batches`. Current stock is a `SUM(quantity) GROUP BY bread_type_id`
over the items table, and the whole point of its covering index is that SQLite
answers it without touching the table at all; a join to find the run would give
that up on the one query that has to stay cheap as the ledger grows for the life
of the app. The index becomes `(run_id, bread_type_id, quantity)`.

**The run id lives with the setup**, composed once at finish-setup and stored
in `InventorySetup` so it survives restarts and every upload from that run
reaches the same document. A
short **run log** sits next to it — the last 200 runs with their full identity —
which is what numbers a repeat run and what still describes a finished run to
the uploads it left behind. 200 rather than a handful because a proof-of-payment
photo can be added to a receipt from any earlier run, long after that run
closed, and uploads under that run.

**Uploads never surface an alert.** Per the existing rule in CLAUDE.md, work the
user didn't explicitly ask for is logged, not alerted — `logError('sync.receipt',
e)` and try again later. The one place sync becomes visible is End the Day,
where the user *did* ask, and where a pending count is the answer rather than an
error dialog.

---

## Rules and indexes to add

**Firestore rules.** Mobile accounts may read any run and write only their own;
dashboard accounts may read everything.

```
match /runs/{runId} {
  allow read: if request.auth != null;
  allow create, update: if request.auth != null
                        && request.resource.data.createdByUid == request.auth.uid;
  allow delete: if false;

  match /{sub=**} {
    allow read: if request.auth != null;
    allow create, update: if request.auth != null
                          && request.resource.data.createdByUid == request.auth.uid;
    allow delete: if false;
  }
}

match /customers/{customerId} {
  allow read: if request.auth != null;
  allow create, update: if request.auth != null;
  allow delete: if false;          // soft delete only
}

match /trucks/{truckId} { /* same shape as breadTypes: all read, dashboard writes */ }
match /areas/{areaId}, /agentGroups/{groupId} { /* legacy: read-only, write: false */ }
match /agents/{agentId} { /* same */ }
```

Reads are open to any signed-in account on purpose: the route view needs to see
that *another* truck already visited a store today, including which truck.

One trap worth stating explicitly: **`update` must be allowed, not just
`create`.** A retry re-sends the identical document, and to Firestore a `setDoc`
over an existing document is an update. A create-only rule would look correct
and would reject every retry — turning a transient network failure into a
permanent one.

**Composite indexes** go in `firestore.indexes.json` and ship via
`deploy:rules`. The emulator invents missing indexes and production rejects
them, so these must be written down rather than discovered later:

| Scope | Collection | Fields |
| --- | --- | --- |
| Collection group | `receipts` | `businessDay` ASC, `createdAt` DESC |
| Collection group | `receipts` | `customerId` ASC, `createdAt` DESC |
| Collection group | `stockEntries` | `businessDay` ASC, `createdAt` ASC |
| Collection | `runs` | `businessDay` DESC, `truckId` ASC |
| Collection | `runs` | `status` ASC, `businessDay` DESC |

`customers` needs no composite index — a single `orderBy("updatedAt")` with one
range filter on the same field is served by the automatic single-field index.

---

## Deliberately deferred

- **A real retry policy** — backoff, giving up, distinguishing a permanent
  rejection from a dead zone. What exists now is deliberately simple: a nudge
  after every write, plus a 60-second heartbeat. A pass stops at its first
  failure, since a failure is nearly always "no signal" and would repeat for
  every remaining row. The structure makes any policy safe to adopt later.

  Two pieces of it are in place and are not optional. Failures are sorted into
  permanent / transient / unclear (`classifyUploadFailure`), and a row that
  fails permanently — or five times for a reason nobody recognises — is set
  aside as `'blocked'` so it can't stop the queue behind it forever. That
  quarantine is reversible from Settings ("Try sending refused records again"),
  because the refusals this app produces are usually account problems that a
  sign-in fixes. And **only the Firestore call is inside the catch that
  quarantines** (`uploadOrSetAside`): the local write that records the success
  sits outside it, or a SQLite hiccup would be classified as an upload failure
  and eventually quarantine a record the server already has.

  One thing that is **not** optional and is already in place: **every Firestore
  call is wrapped in a timeout** (`CallTimeoutMs` in `lib/sync.ts`). Firestore's
  write promise resolves when the *backend* acknowledges the write, so with no
  connection it does not reject — it never settles at all. Without the timeout,
  a single offline `setDoc` hangs its caller forever: the sync pass never
  finishes, the heartbeat skips because a pass is still "running", and "End the
  Day" sits on "Ending…" with no alert, because the retry prompt only appears on
  a rejection. The underlying write is not cancelled and may still land later,
  which is harmless — every upload is a `setDoc` at a known id, so a late write
  and a re-send produce the same document.
- **Proof-of-payment photos.** These need Firebase Storage, which the project
  doesn't use at all today. `proofStoragePath` is reserved so adding them later
  doesn't reshape existing documents.
- **Dashboard rollups** (per-run totals, daily summaries). Derivable from what's
  uploaded; whether to precompute them with a Cloud Function is a performance
  question to answer with real data volume, not before.
- **The route/visit view itself** — item 6 in the original design order. It
  becomes a collection group query over `receipts` for today once this exists.
- **Role-based access beyond mobile/dashboard.** Still no per-agent
  permissions, as before.

---

## Where the code lives

| Piece | File |
| --- | --- |
| Id generation | `apps/mobile/src/lib/id.ts` |
| Run id + uploaded shapes | `apps/mobile/src/lib/sync-types.ts` |
| The Firestore writes | `apps/mobile/src/lib/sync.ts` |
| The customer pull (both callers) | `apps/mobile/src/lib/customer-sync.ts` |
| When to upload, End the Day | `apps/mobile/src/context/sync.tsx` |
| Run bookkeeping, the three catalogs | `apps/mobile/src/context/inventory.tsx` |
| Home card + End the Day button | `apps/mobile/src/components/end-day-card.tsx` |
| Pending queries / `sync_state` | `lib/stock-db.ts`, `lib/receipt-db.ts`, `lib/customer-db.ts` |
| Business-day boundaries | `apps/mobile/src/lib/business-day.ts` (`businessDayRange`) |
| Dashboard CRUD for trucks + agents | `apps/web/src/pages/reference-lists.tsx` |
| Agent picker on mobile (tick each one) | `apps/mobile/src/components/agents-field.tsx` |
| Rules and indexes | `firebase/firestore.rules`, `firebase/firestore.indexes.json` |

**A note on the `sync_state` values.** They are `'pending'`, `'synced'` and
`'legacy'`. The third means "belongs to no run, so it will never upload". Two
things land there: rows written before sync existed (they genuinely never
uploaded, but sweeping them into whichever run is open now would file old test
data under today's truck), and rows whose run has since fallen off the end of
the run log — reachable only after being offline for longer than the log keeps
runs. Both are logged when it happens rather than disappearing quietly, and both
stop counting as pending, which they otherwise would forever. Customers are the
exception to all of this — a store belongs to the business, not to a day, so
pre-existing customers are marked `'pending'` and do upload.
