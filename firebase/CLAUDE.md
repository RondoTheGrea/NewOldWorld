# firebase — the backend

One Firebase project behind all three surfaces: Firestore for every record,
Auth for both user pools, Cloud Functions for the few things a client may not do
itself, and Cloud Storage for exactly one kind of file. This file covers the
project, the rules, the emulators and deploying. The phone is documented in
`apps/mobile/CLAUDE.md` and the dashboard in `apps/web/CLAUDE.md`.

## What is in here

- `firebase.json` — deploy targets and emulator ports. Realtime Database is
  deliberately absent (see below).
- `firestore.rules` / `firestore.indexes.json` — both registered in
  `firebase.json`, both shipped by `npm run deploy:rules`.
- `storage.rules` — mirrors `firestore.rules`; also shipped by `deploy:rules`.
- `storage-cors.json` — applied once per bucket with `npm run storage:cors`
  (see below); no `firebase deploy` touches it.
- `functions/src/index.ts` — `setGlobalOptions()` (region), the placeholder
  `api`, and `appCheckStatus` (the phone's "check this phone's security token"
  probe, documented under App Check in `apps/mobile/CLAUDE.md`).
- `functions/src/dashboard-users.ts` — the Team page's callables and the
  one-browser-per-account claim, both documented in `apps/web/CLAUDE.md`.
- `scripts/emulators.mjs` — the emulator wrapper (Java version + data
  import/export, below).
- `scripts/make-admin.mjs` — the one-time first-admin bootstrap.
- `scripts/migrate-oldworld-customers.mjs` — the one-time copy of the old
  OldWorld app's customer list into `customers`, read from the CSV the Appwrite
  console exports (newest `customersCollectionId_*.csv` at the repo root, or
  `--file=`; header row is validated, not assumed)
  (`npm run migrate:oldworld[:cloud] [-- --write]`). Previews by default, merges
  records whose name **and** store name match (case/spacing only — "Store 2" is
  a different store), only ever `create`s (ids derive from that match key, so a
  rerun can't duplicate or overwrite), and reports to `migration-output/`
  (gitignored — it holds real customers' details, as does the CSV). Owner's
  walkthrough:
  `docs/oldworld-customer-migration.md`.
- `scripts/prepare-hosting.mjs` + `web-dist/` — the hosting predeploy step;
  `npm run deploy:hosting` builds `apps/web` into `web-dist` and ships it as a
  single-page app (every path rewritten to `/index.html`).

## The project

- Project id: `newoldworld-b8f5d` (see `firebase/.firebaserc`). Emulators instead run
  as `demo-newoldworld` — the `demo-` prefix makes Firebase treat it as an offline
  demo project, so **no `firebase login` is needed** for local dev. This id must
  match `projectId` in `apps/mobile/src/lib/firebase.ts`, or users created by the
  app won't appear in the Emulator UI.
- **Region: `asia-southeast1` (Singapore)** — closest to the Philippines, where
  the distributor is. Firestore's region is **permanent**; functions pin the same
  region via `setGlobalOptions()` in `functions/src/index.ts` so compute and data
  sit together. `getFunctions(app, 'asia-southeast1')` in the mobile app **must
  match** — the SDK otherwise defaults to us-central1 and every call 404s.
- Realtime Database is **not used** — it was removed from `firebase.json` rather
  than left as an unconfigured deploy target. Add it back deliberately if a
  genuine need appears.
- **Cloud Storage holds exactly one thing**: the proof-of-payment photo on a
  GCash or cheque receipt, under `paymentProofs/{receiptId}.jpg`. Rules live in
  `firebase/storage.rules` and ship with `npm run deploy:rules`. The
  `storageBucket` is set in *both* clients' `emulatorConfig` as well as their
  cloud config — without it the SDK throws `storage/no-default-bucket`, and it
  throws at the first `ref()` rather than at `getStorage()`, so the failure
  looks like one broken photo instead of a startup error.
- **The bucket needs a CORS rule for the dashboard's Excel export**, and only
  for that. Displaying a cross-origin image in an `<img>` needs no permission;
  *reading its bytes* does, and the export embeds the photo in the workbook
  (`getBlob`). `firebase/storage-cors.json` holds the allowed origins and
  `npm run storage:cors` applies it — a **one-time** step per bucket, done with
  `gcloud` rather than `firebase` because CORS is a Cloud Storage setting no
  `firebase deploy` touches. The **Storage emulator allows every origin
  already**, so local dev never needed it; the gap only shows against the cloud
  project, and shows as "Photo could not be downloaded" in the cell rather than
  as a broken export.
- Functions: TypeScript, Node 22, `firebase-functions` v2 + `firebase-admin`.

## Firestore rules

`firestore.rules` is **default-deny**: `match /{document=**} { allow read, write:
if false; }` at the bottom, with one explicit allow block per collection above
it. Adding a collection means adding a block — forgetting one fails safe, which
is the point. Two rules there are load-bearing and easy to break:

- **Allow `update`, not just `create`, for anything the phone uploads.** Every
  upload is a `setDoc` at a phone-minted id so retries are safe, and to Firestore
  a `setDoc` over an existing document is an update. A create-only rule looks
  stricter and in fact rejects every retry.
- **A collection-group query needs a collection-group rule.** The dashboard's
  store history queries `receipts` across every run, and a rule nested under
  `/runs/{runId}` does not authorise that however much it looks like it should —
  hence the separate `match /{path=**}/receipts/{receiptId}`.

Everything under `/runs` refuses `delete` outright and refuses any write whose
`createdByUid` isn't the signed-in account, which is what makes the dashboard
read-only by rule rather than by convention. `dashboardSessions` refuses every
client write — only the Admin SDK writes it. `users/{uid}` lets an account create
only its own doc, only with `role: "mobile"`, and never update it.

## Emulators

- Local dev — from `firebase/`: `npm install` then `npm run emulators`.
  Emulator ports: auth 9099, firestore 8080, functions 5001, storage 9199, UI 4000.
  `npm run emulators` compiles the functions first — the functions emulator loads
  `functions/lib/index.js`, so without a build it errors with "does not exist".
- Build functions: `npm run build` from `firebase/functions`.
- Emulator data **persists between runs**: `scripts/emulators.mjs` exports to
  `firebase/emulator-data/` on clean exit (Ctrl+C) and re-imports on start, so
  test accounts survive a restart. `npm run emulators:fresh` wipes it. Closing the
  terminal window instead of Ctrl+C still loses that session's data — no handler
  can catch that — so `npm run emulators:save` writes the same export on demand,
  without stopping anything. It asks the emulator hub directly rather than
  running `firebase emulators:export`, which on Windows completes the export and
  *then* dies with a libuv assertion and exit 127, reporting failure over a save
  that worked.
- **Never forward a signal to the firebase CLI from the wrapper.** Ctrl+C
  already reaches it — the terminal delivers it to every attached process at
  once — and the CLI's own handler is what stops each emulator and waits for
  Firestore to write the export. `child.kill('SIGINT')` is not a polite request
  on Windows: Node turns every signal but 0 into `TerminateProcess`, so it hard-
  kills the CLI part-way through that export. That was a real bug here until
  2026-08-30, and it presented as data that saved on some days and not others,
  plus port 8080 staying taken afterwards (the Firestore emulator is a Java
  process the CLI starts *detached*, out of reach of the terminal's Ctrl+C on
  purpose, and only the CLI knows how to stop it — kill the CLI and it is
  orphaned). The wrapper now waits instead, force-killing the whole tree only if
  the shutdown stalls or Ctrl+C is pressed a second time, and clears a
  parentless leftover Firestore emulator on the next start.
- **"logging: Stopping Logging Emulator" and then nothing** is a firebase-tools
  hang, not a slow save. The logging emulator is stopped *last* — after the hub,
  long after the export — and its `stop()` waits on `wss.close()`, which never
  calls back while any un-upgraded socket is still open on port 4500. Everything
  that matters is already finished by then: data written, every port-holding
  emulator stopped. Rather than making the user press Ctrl+C a second time, the
  wrapper watches the **hub** (stopped one step earlier) and force-closes once it
  goes quiet — three consecutive misses plus a settle delay, because concluding
  "finished" early is the one mistake here that could cut off a save. Reproduced
  and verified 2026-08-31: hang induced with a raw socket on 4500, single Ctrl+C,
  clean exit in ~4s with the export written and every port released.
- **A functions emulator that loaded nothing looks like a broken app, not a
  broken emulator.** If startup shows no `functions: Loaded functions
  definitions from source: ...` line, every callable 404s, the client SDK
  reports that as the catch-all `internal`, and the dashboard's Team page shows
  a generic "Something went wrong" with nothing to suggest the backend never
  came up. `curl http://127.0.0.1:5001/demo-newoldworld/asia-southeast1/api` is the
  quick check: an empty "valid functions are:" list means restart the emulators.

## Testing and deploying

The emulators are the default loop; the cloud is a checkpoint, not a feedback
loop (a functions deploy takes minutes, the emulator reloads in seconds).

- `npm run deploy:rules` — Firestore rules + indexes **and Storage rules**, a
  few seconds. Cheap and safe.
- `npm run deploy:functions` — functions only.
- `npm run deploy` — everything.
- `npm run logs` — cloud function logs (`firebase functions:log`).

Emulators match production for app logic and **do enforce security rules**, so
test rule changes locally. What they do *not* catch, and what a periodic real
deploy exists to find: missing Firestore composite indexes (the emulator invents
them, production rejects the query), IAM//invoker permissions, secrets via
`defineSecret`, cold starts, and CORS. `firestore.indexes.json` is registered in
`firebase.json` — when a query needs a composite index, add it there and
`deploy:rules`, don't just click the console link.

`newoldworld-b8f5d` is currently the **only** cloud project, so it is dev/staging.
Create a separate production project before real customer data exists.

Cloud state this project needs (copied from an earlier client's repo, so check
each exists in the new project before assuming it does): Firestore `(default)` in
asia-southeast1, the `NewOldWorld POS` Web app whose config is in `apps/mobile/.env`,
the `api` function, Blaze billing, and Artifact Registry cleanup policies (these
delete function images older than 1 day — without one, old container images
accumulate and quietly cost money every month).

## Java versions (two tools, two requirements)

The machine has a genuine version conflict, already solved — **don't "simplify"
it by changing the global `JAVA_HOME`:**

- **Android / Expo native builds** want **JDK 17** (per Expo's SDK 57 docs). This
  is the system default: `JAVA_HOME=C:\Program Files\Java\jdk-17`.
- **firebase-tools 15+** refuses to start the emulators on anything below
  **Java 21** ("no longer supports Java version before 21").

`firebase/scripts/emulators.mjs` bridges the two: it finds an installed JDK 21+
(currently the JDK 25 bundled with Android Studio at
`C:\Program Files\Android\Android Studio\jbr`) and sets `JAVA_HOME` **only for
the emulator process**. The global default stays on 17, so the Android build is
unaffected. If a JDK 21 is installed later and made the default, the script
picks it up automatically — it prefers the lowest version that meets the minimum.

Harmless warnings on emulator startup, safe to ignore: "You are not currently
authenticated" (expected for a demo project) and "outdated version of
firebase-functions" (v6 is intentional; upgrading is a breaking change).
