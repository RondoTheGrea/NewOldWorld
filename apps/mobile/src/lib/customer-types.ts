import { sanitizeMultiline, sanitizeSingleLine } from '@/lib/text-input';

// Shared between customer-db.ts (native, real SQLite) and customer-db.web.ts
// (stub) so neither has to import the other — Metro picks whichever one
// matches the build platform, and this file is the only thing both sides
// depend on.

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type CustomerInput = {
  storeName: string;
  name: string;
  deliveryDays: Weekday[];
  /**
   * References an `areas` doc in Firestore (see context/inventory.tsx) — not a
   * free-text name.
   *
   * This and `agentGroupId` are the store's *placement*, and the customer form
   * **requires both on every save it makes** — a new store and an edit alike.
   * A store filed under neither is invisible to the Customers tab's crew filter
   * and to any grouping the server does later, so the moment to ask is while
   * somebody is standing in front of the shop.
   *
   * Both stay `string | null` all the same, and nothing outside the form
   * rejects a null. Stores already in Firestore from before this rule have one
   * or both missing, and they are **kept exactly as they are** — no rule, no
   * migration and no sync path rewrites or hides one. The requirement is about
   * what a *form* may submit, not what the database may hold. In practice that
   * makes opening one of those older stores for editing the moment it gets
   * filled in: the form asks for the missing area or crew before it will save
   * anything else about that store. Deliberately a one-way ratchet — the form
   * has no way to *clear* either field, so a store can only gain a placement.
   *
   * The known cost, accepted on the owner's call: both pickers are filled from
   * **downloaded** catalogs, so a phone that has never pulled them has nothing
   * to choose from, and on that phone an older store can't be edited until it
   * does. Hence the empty-list wording on both pickers points at the depot
   * rather than saying "nothing here yet".
   */
  areaId: string | null;
  /**
   * References an `agentGroups` doc in Firestore — the crew this store is
   * assigned to. Required on every save, exactly like `areaId`; see there.
   */
  agentGroupId: string | null;
  address: string;
  phone: string;
  description: string;
};

export type Customer = CustomerInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Whether this is a store the driver added on this phone and hasn't invoiced
   * yet — what puts it at the top of the store lists with a "New" tag.
   *
   * Set by `insertCustomer` and cleared by `clearCustomerIsNew` when a receipt
   * is finalized for the store. `upsertCustomerFromServer` never touches the
   * column, so a store keeps its own answer when its copy comes back down from
   * the server, and a store arriving from another handset is never new here
   * however recently it was created — the tag is for the store you just typed
   * in, which is a different question from "which store is youngest". It never
   * leaves the device: `uploadCustomer` in lib/sync.ts doesn't send it.
   */
  isNew: boolean;
};

/**
 * How long a store the driver just added stays flagged "New" if nothing is ever
 * sold to it.
 *
 * The backstop, not the main event: the tag's real ending is the first
 * finalized receipt for the store (`clearCustomerIsNew`). This is what stops a
 * store that is added and then never invoiced from sitting at the top of the
 * list for ever.
 *
 * A duration, not a business day, and deliberately so. Every other "which day
 * is this?" question in the app goes through lib/business-day.ts, because
 * filing a record under the wrong date is a real cost — but nothing is filed by
 * this. It only decides how long a badge shows and how long the store sits at
 * the top of the list. Measured as a business day it would blink out at Manila
 * midnight, which on a route that runs past midnight is the middle of the shift
 * — ten minutes after a store was added. Twenty-four hours from the moment of
 * writing has no timezone in it at all and means the same thing wherever the
 * phone is.
 */
export const NewCustomerWindowMs = 24 * 60 * 60 * 1000;

/**
 * Whether a store should still be shown as new: added on this phone, not yet
 * invoiced, and added within the last `NewCustomerWindowMs`.
 *
 * Both halves have to hold. The flag is the one that usually ends it — a
 * receipt gets finalized for the store and the tag has done its job — and the
 * window catches the store that is added and never sold to.
 */
export function isNewCustomer(customer: Customer, now: number = Date.now()): boolean {
  return customer.isNew && now - customer.createdAt < NewCustomerWindowMs;
}

/**
 * How much text each field will store. Generous enough that a real store name
 * or address never hits the cap, small enough that a pasted document can't
 * become a row in this database (or a metre of receipt paper — the store name
 * and contact name are copied onto every receipt).
 *
 * The form uses these as `maxLength` on the inputs so the cap is visible while
 * typing rather than a surprise on save.
 */
export const CustomerFieldLimits = {
  storeName: 80,
  name: 80,
  address: 200,
  phone: 32,
  description: 500,
  /** A Firestore document id — this is a sanity bound, not a user-facing limit. */
  areaId: 64,
  /** Same sanity bound as areaId — also a Firestore document id, not typed text. */
  agentGroupId: 64,
} as const;

/**
 * The single point where a customer is cleaned up before it is stored, applied
 * inside customer-db's insert and update so it holds no matter which screen
 * (or future code) is doing the saving.
 *
 * `deliveryDays` is filtered against WEEKDAYS rather than trusted: it is the
 * one field that gets JSON-serialised into a text column and JSON.parsed back
 * out, so this guarantees only real weekdays — no duplicates — ever make the
 * round trip. Filtering in WEEKDAYS order also means the days always read
 * Sun→Sat instead of in whatever order they were tapped.
 */
export function sanitizeCustomerInput(input: CustomerInput): CustomerInput {
  const areaId = input.areaId ? sanitizeSingleLine(input.areaId, CustomerFieldLimits.areaId) : '';
  const agentGroupId = input.agentGroupId
    ? sanitizeSingleLine(input.agentGroupId, CustomerFieldLimits.agentGroupId)
    : '';

  return {
    storeName: sanitizeSingleLine(input.storeName, CustomerFieldLimits.storeName),
    name: sanitizeSingleLine(input.name, CustomerFieldLimits.name),
    deliveryDays: WEEKDAYS.filter((day) => input.deliveryDays.includes(day)),
    areaId: areaId || null,
    agentGroupId: agentGroupId || null,
    address: sanitizeMultiline(input.address, CustomerFieldLimits.address),
    phone: sanitizeSingleLine(input.phone, CustomerFieldLimits.phone),
    description: sanitizeMultiline(input.description, CustomerFieldLimits.description),
  };
}
