# NewOldWorld — POS system monorepo

Point-of-sale system for a bread distributor in the Philippines, built as a
monorepo. Three surfaces share one Firebase backend:

- **`apps/mobile`** — React Native app (Expo), the POS client the drivers carry
- **`apps/web`** — the manager's web dashboard (Vite + React)
- **`firebase/`** — Firebase config, Firestore/Storage rules, indexes, emulators
- **`firebase/functions`** — backend HTTPS/callable functions
- **`packages/shared`** — code shared across apps + backend (empty scaffold)

## Where the documentation lives

**This file is the monorepo-wide context only.** Each surface documents itself,
and those files are long because the reasoning behind a decision is what stops
the next person undoing it:

| File | Covers |
| --- | --- |
| `apps/mobile/CLAUDE.md` | Everything on the phone — auth, theme, navigation, the inventory ledger, receipts, printing, expenses, catalogs, sync, App Check, failure handling |
| `apps/web/CLAUDE.md` | Everything in the browser — the Overview tab (Live / Trends / Stores), the Excel export, charts, the Team page, one-browser-per-account, App Check |
| `firebase/CLAUDE.md` | The project, region, Firestore/Storage rules, emulators, deploying, and the Java-version wrinkle |
| `docs/sync-design.md` | Full design and rationale for the phone→Firestore sync |

Read the file for the surface you are touching. When a change spans two of them
— a new field on a run, a new collection — update both, plus `firestore.rules`.

## Working with the owner

The owner is **vibe coding with no coding experience** and drives the feature
list. When helping:

- Explain in plain language; avoid unexplained jargon.
- Make sensible technical decisions instead of asking the owner to choose between
  options they can't evaluate — surface a recommendation, then proceed.
- Keep changes small and verifiable; say plainly when something works or fails.

## Repo-wide facts

- **Not a workspaces monorepo.** Each package installs its own `node_modules`
  and is run from its own directory. There is no root install and no root
  script; `cd` into `apps/mobile`, `apps/web` or `firebase` first.
- **`packages/shared` is empty** (`.gitkeep` only). Code that genuinely belongs
  to two surfaces is currently *copied* rather than shared —
  `lib/business-day.ts` exists in both `apps/mobile/src` and `apps/web/src`, and
  that duplication is deliberate until the package is set up. If you change one,
  change the other.
- **One Firebase project, `REPLACE-WITH-NEW-PROJECT-ID`**, in **`asia-southeast1`**. It is
  currently dev, staging and production at once. Details in
  `firebase/CLAUDE.md`.
- **The phone is the author of every record; the dashboard is a reader.**
  Everything under `/runs` is written by a driver's handset and read-only to the
  server by rule, not by convention.

## The business day is Manila, always

Every timestamp stored anywhere in this repo is `Date.now()` — epoch
milliseconds, an absolute instant with no timezone in it. Turning one into a
*date* means picking a timezone, and picking the wrong one is how a POS files a
morning's work under yesterday. The distributor operates in the Philippines, so
a business day is an **`Asia/Manila`** day (UTC+8, no daylight saving), and a
truck that starts before dawn is 10:30 PM UTC *the previous day*.

`lib/business-day.ts` — on both the phone and the dashboard — is the only place
allowed to answer "which day is this?". Never `toISOString().slice(0, 10)`,
never `getTimezoneOffset()`, never `new Date(ts).getDate()`. The phone computes
`businessDay` and stamps it on every document; **the dashboard matches that
stored string and never re-derives a day from a timestamp**, or a browser in
another timezone refiles a 6:30 AM receipt under the day before.

## User accounts: mobile vs dashboard

Mobile and the web dashboard share one Firebase project, but they are **not**
one shared user pool — each account belongs to exactly one app. This is
enforced by a `users/{uid}` Firestore doc with a `role` field (`"mobile"` or
`"dashboard"`), checked right after sign-in on both apps (see
`requireMobileAccount` in `apps/mobile/src/context/auth.tsx` and
`requireDashboardAccount` in `apps/web/src/context/auth.tsx`) — a mismatch
signs the account back out immediately with a friendly error. Firestore rules
(`firebase/firestore.rules`) back this up: a client can only ever create its
*own* role doc, and only with `role: "mobile"` — `"dashboard"` can never be
self-assigned, and no role can change once set.

- **Mobile accounts** are created by the app's own sign-up screen, which tags
  the new account `"mobile"` automatically.
- **Dashboard accounts** have no self-serve sign-up. They are created by the
  business's own administrator on the dashboard's **Team page** — documented in
  `apps/web/CLAUDE.md`, along with the `admin: true` flag that gates it. That
  same `admin: true` flag also decides who may **change** the dashboard's
  catalogs — bread types, areas, trucks, crews and the receipt settings. Every
  dashboard account reads them; only an administrator edits them, in the browser
  and in `firestore.rules` alike (`isDashboardAdmin()`).

## Agents are crews, not individuals

**A truck is assigned a whole crew.** `agentGroups/{groupId}` is a crew and
`agents/{agentId}` carries the `groupId` of the one it belongs to — and **every
agent belongs to exactly one**. An agent outside a crew is unreachable: nothing
on a phone can put them on a truck. Both the group name and each agent's name
are editable on the dashboard.

- **Dashboard** — `apps/web/src/components/agent-groups-section.tsx`, its own
  section on the reference-lists page rather than a third `NamedListSection`,
  because it edits *two* collections and the invariant only holds if they are
  written as one action: deleting a crew deletes its people
  (`deleteAgentGroup` re-reads the members server-side so someone added from
  another tab goes with them), adding a person means naming their crew, and
  **Review refuses to save a crew with nobody in it**. Same edit-mode /
  review-then-confirm / drag-to-reorder workflow as every other list. New crews
  are created *first and awaited* in `handleConfirm`, because a new agent's
  write has to name a crew that already has a real id — placeholder ids are
  swapped through `idMap`. Moving someone between crews is the **Crew dropdown**
  on their row, not drag-and-drop; dragging only reorders within a crew.
- **Mobile** — `components/agent-group-field.tsx` replaces the old multi-select
  of individual agents on the setup screen. Tap a crew and it expands, listing
  its people indented underneath (one open at a time); **Confirm only appears
  once a crew is open**, because expanding is how the driver checks they picked
  the right crew. A crew with nobody in it can be opened but not confirmed.
- **One catalog, two reads.** `fetchAgentGroups` in `context/inventory.tsx`
  fetches both collections and caches the *joined* result under one key, so the
  saved copy can't fall out of step with itself. An agent whose `groupId` names
  no crew is dropped — it could never be selected anyway.
- **The run records both the crew and its membership.** `agentGroupId` /
  `agentGroupName` say what was assigned; `agentIds` / `agents` say who that
  crew held **at the moment the run opened**. Resolving the crew to a membership
  at read time would let somebody moved between crews next week rewrite who was
  on the truck today. `agentGroupId` is on the `RunStamp`, so every child
  document repeats it like `areaId` and `truckId`.
