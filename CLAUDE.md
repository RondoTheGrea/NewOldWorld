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
| `apps/mobile/CLAUDE.md` | Everything on the phone — auth, theme, navigation, the inventory ledger, receipts, printing, expenses + the cash count, catalogs, sync, App Check, failure handling |
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
- **One Firebase project, `newoldworld-b8f5d`**, in **`asia-southeast1`**. It is
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
  catalogs — bread types, trucks, agents and the receipt settings. Every
  dashboard account reads them; only an administrator edits them, in the browser
  and in `firestore.rules` alike (`isDashboardAdmin()`).

## Agents are picked one by one — no crews, no areas

**The driver ticks each agent who is on the truck**, from the flat `agents`
list the dashboard keeps. Crews (`agentGroups`) and areas (`areas`) were removed
on the owner's call (October 2026), from the phone, the dashboard and the store
records alike. Their Firestore collections are left in place, read-only by rule,
only so a phone still on an older build can finish its setup; nothing current
reads them, and they can be deleted once every phone is updated.

- **Dashboard** — Agents is a plain `NamedListSection` on the reference-lists
  page ("Trucks & Agents"), beside Trucks. The page's sections are Trucks and
  Agents only.
- **Mobile** — `components/agents-field.tsx` on the setup screen: a sheet of
  checkboxes, ticks are a draft until **Confirm**, and Confirm needs at least
  one agent. The setup screen asks for **Truck** and **Agents** — nothing else.
- **The run records who was aboard.** `agentIds` / `agents` (ids and names) are
  captured **at the moment the run opens**, in the dashboard list's order, and
  never re-resolved. `agentIds` is on the `RunStamp`, so every child document
  repeats it like `truckId`.
- **The run id is keyed on the agents' names** —
  `2026-10-03_Juan-Dela-Cruz+Maria-Santos_juan@bakery.ph` (see
  `agentsRunIdSegment` / `composeRunId` in `apps/mobile/src/lib/sync-types.ts`).
- **Stores carry no area and no crew any more**, and neither store list on the
  phone (Customers tab, receipt store picker) has a filter. Old store documents
  still hold `areaId` / `agentGroupId` in Firestore; nothing reads them.
- **Dashboard reports cut by truck** where they used to cut by crew and area —
  the Trends tab's "Net takings by truck", its truck filters, and the period
  workbook's "By truck" section.
- Runs and receipts written before the change still carry `agentGroupId`,
  `agentGroupName`, `areaId` and `areaName`. The dashboard ignores them, with
  one exception: a receipt's printed crew name (`agentGroupName`) is read as
  the fallback for `agentNames`, because that is what the customer's paper says.
