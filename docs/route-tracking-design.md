# Route / Visit Tracker — Design Notes

**Status: design discussion only — nothing here has been built.** Several
pieces this feature depends on (Inventory, Receipts) don't exist yet either.
This is a written record of a design conversation, meant to be picked up in a
future conversation to actually plan and build. Treat it as the full picture
of what's wanted, not as an implementation plan.

## The idea

NewOldWorld is used by an external distributor of Gardenia bread. Trucks deliver
to stores, which are grouped into **areas**. The goal: give each truck an
interface showing which stores it needs to visit *today*, based on the store's
assigned **area** and **weekday** — so nothing gets missed on a route.

## Foundation that already exists

`apps/mobile/src/context/customers.tsx` already models a store as a `Customer`:

```ts
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type CustomerInput = {
  storeName: string;
  name: string;            // contact person
  deliveryDays: Weekday[];
  area: string;            // currently free text — see "Areas" below
  address: string;
  phone: string;
  description: string;
};
```

There is no separate "Store" entity to invent — `Customer` already *is* the
store record. Today this data is **local-only** (AsyncStorage on the device),
with no Firebase sync — noted in the code as a deliberate deferral, not an
oversight.

The Customers tab (list, add/edit/delete, card + detail modal) is fully built
and is the pattern any future forms (Inventory, Receipts) should follow.

`apps/web` and `packages/shared` are still empty scaffolds — this feature is
what will give the web dashboard its first real purpose (see "Areas" below).

## Key decisions made in discussion

1. **A "visit" is defined as "a receipt exists for this store, today."** There
   is no separate visited/not-visited flag to maintain — the receipt itself is
   the proof. This means the route/visit view is a *derived* view, not a new
   piece of state: take today's area+weekday stores, subtract the ones with a
   receipt created today.

2. **Dependency order: Customers (sync) → Inventory → Receipts → Route/Visit
   view.** The route view is the cheapest of the four once the others exist —
   mostly a filtered query and some UI. Customer sync is the correct thing to
   build first: it's the one piece with no open design questions, and it's a
   real current gap (local-only storage breaks the moment more than one truck
   is in the field).

3. **Areas are manager-owned, not free text.** The manager creates/manages the
   list of areas from the web dashboard. On mobile, a store's `area` field
   becomes a dropdown sourced from that list, instead of free text (free text
   invites typos that would silently drop a store off someone's route). An
   area is just a label for a real geographic cluster of stores — it doesn't
   need to encode anything beyond that.

4. **No formal roles yet.** "Manager" = whoever uses the web dashboard,
   "driver" = whoever uses the mobile app. The separation is by which app is
   used, not an enforced permission system. Not being solved now.

5. **Multiple trucks can share an area — this is normal, not an edge case.**
   Which specific stores within a shared area each truck actually covers is
   sorted out by the humans/operational routine, not arbitrated by the app.
   No "claim this store" mechanism is needed.

6. **Sync is manual and phase-based, not continuous.** A day looks like:
   - **Morning, before departure** (signal guaranteed, e.g. at the depot): the
     driver runs a manual **Sync** that pulls the latest manager-defined areas,
     any customers created elsewhere since last sync, and a narrow slice of
     today's receipts — just enough to know which stores another truck has
     already visited today, **including which truck did it** (useful for
     follow-up, not just a bare checkbox).
   - **During the route**: assume **zero signal** from departure until return.
     Everything must work fully offline — the route list is read from the last
     sync plus this device's own receipts created so far; new customers/receipts
     are queued locally.
   - **End of day, back at the warehouse** (signal restored): an **"End the
     Day"** feature aggregates everything created locally that day and pushes
     it up. Exact upload mechanics are a separate future conversation.

7. **Manager changes happen before operations start, not mid-day.** This is an
   operational rule the manager follows, not something the app has to defend
   against — so a driver's synced list going stale mid-route isn't a bug to
   design around.

8. **Conflicts are acceptable as last-write-wins.** If two trucks happen to
   touch the same customer record on the same day (rare, since store-level
   coverage within a shared area is handled operationally), overwriting at
   end-of-day sync is fine. No merge/conflict-resolution logic needed.

9. **The visit tracker is a reminder, not a coordination lock.** Its job is to
   surface what's outstanding for the day — it shouldn't try to prevent
   double-visits or enforce anything.

10. Mid-route device failure (phone dies/breaks before end-of-day upload) was
    raised and explicitly ruled **out of scope** — it's a physical/operational
    problem, not something the app needs to design around.

## Explicitly deferred (raised, intentionally not decided yet)

- Store lifecycle states (active / inactive / closed / on hold).
- Reasons for a missed or skipped visit (e.g. "attempted, store was closed").
- The exact mechanics of the manual sync and "End the Day" upload (data
  shape, what precisely gets pulled/pushed).
- Role-based access control / permissions.

## Open technical note (observation, not a commitment)

Firebase JS SDK v12 is already installed in `apps/mobile`, and supports
`persistentLocalCache()` for offline-capable Firestore access on React Native.
That's a plausible building block for the "works with zero signal after
departure" requirement once sync mechanics get designed — flagged here for
later, not decided.

## Suggested order for a future conversation

Still to be designed, roughly in this order:
1. Areas (manager-created, dashboard) + turning the mobile `area` field into a
   dropdown fed by that list.
2. Customer sync to Firestore (multi-device, dedup via server-generated IDs).
3. Inventory.
4. Receipts (what creating one deducts, how it ties to a customer + inventory).
5. Sync / End-of-Day upload mechanics.
6. The Route/Visit view itself (by that point, mostly a query + UI).

No code has been written for any of this yet.
