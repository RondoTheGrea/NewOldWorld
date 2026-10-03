import type { Customer, CustomerInput } from '@/lib/customer-types';

// Metro's web-platform stand-in for customer-db.ts — see the comment there
// for why this split exists. Every export throws; context/customers.tsx's
// load effect catches that and shows a "not available on web" message
// instead of crashing.

const UNAVAILABLE_MESSAGE = 'Customers aren’t available on web yet — use the app on a phone.';

export type PendingCustomer = Customer & { deleted: boolean };

export async function loadCustomers(): Promise<Customer[]> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function insertCustomer(_input: CustomerInput): Promise<Customer> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function updateCustomerRow(_id: string, _input: CustomerInput): Promise<CustomerInput> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

export async function deleteCustomerRow(_id: string): Promise<void> {
  throw new Error(UNAVAILABLE_MESSAGE);
}

// Resolves rather than throwing, like the sync reads below: this rides along
// with finalizing a receipt and only drops a badge, so it must never be the
// thing that reports a failure.
export async function clearCustomerIsNew(_id: string): Promise<void> {}

// Sync's reads answer "nothing to do" rather than throwing — see the matching
// note in stock-db.web.ts.
export async function loadPendingCustomers(_limit: number): Promise<PendingCustomer[]> {
  return [];
}

export async function countPendingCustomers(): Promise<number> {
  return 0;
}

export async function countCustomers(): Promise<number> {
  return 0;
}

export async function countCustomersTouchedBetween(_fromMs: number, _toMs: number): Promise<number> {
  return 0;
}

export async function markCustomerSynced(_id: string, _updatedAt: number): Promise<void> {}

export async function countSyncedCustomers(): Promise<number> {
  return 0;
}

// The quarantine trio, matching lib/customer-db.ts. Present so the sync pass
// doesn't call an undefined export on web: there is nothing here to set aside,
// so bumping an attempt count answers 0 and nothing is ever blocked.
export async function bumpCustomerAttempts(_id: string): Promise<number> {
  return 0;
}

export async function markCustomerBlocked(_id: string, _updatedAt: number): Promise<void> {}

export async function countBlockedCustomers(): Promise<number> {
  return 0;
}

export async function retryBlockedCustomers(): Promise<number> {
  return 0;
}

// Returns false — "nothing changed locally" — because there is no local
// database to change. Pulling on web would otherwise claim it had applied rows
// and ask the customers list to reload something that isn't there.
export async function upsertCustomerFromServer(_remote: PendingCustomer): Promise<boolean> {
  return false;
}
