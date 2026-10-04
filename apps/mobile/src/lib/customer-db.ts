import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import {
  sanitizeCustomerInput,
  type Customer,
  type CustomerInput,
  type Weekday,
} from '@/lib/customer-types';
import { generateId } from '@/lib/id';

// One row per customer, instead of the old approach (context/customers.tsx
// used to keep the whole list as a single JSON blob in AsyncStorage) where
// every add/edit/delete re-serialized and rewrote the entire list — that
// gets slower as the list grows and eventually risks AsyncStorage's size
// cap. SQLite only touches the row that changed.
//
// Native only (iOS/Android) — same split as lib/stock-db.ts: expo-sqlite's
// web build statically imports a .wasm asset that needs Metro config this
// app doesn't carry, so even having `import 'expo-sqlite'` reachable from
// the web bundle graph fails the whole build, not just this feature.
// customer-db.web.ts is the platform-matched stub Metro picks instead when
// bundling for web — keep the split.

let dbPromise: Promise<SQLiteDatabase> | null = null;

function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabaseAsync('customers.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          store_name TEXT NOT NULL,
          name TEXT NOT NULL,
          delivery_days TEXT NOT NULL,
          area_id TEXT,
          address TEXT NOT NULL,
          phone TEXT NOT NULL,
          description TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      await migrateSyncState(db);
      await migrateSyncAttempts(db);
      await migrateLocalUpdatedAt(db);
      await migrateAgentGroupId(db);
      await migrateCreatedLocally(db);
      await migrateClearBackfilledCreatedLocally(db);
      await migrateNewUntilBilled(db);
      return db;
    });
    dbPromise = dbPromise.catch((error: unknown) => {
      // See the same guard in lib/stock-db.ts: a cached *rejected* promise
      // would make one bad open permanent until the app restarted, so it's
      // cleared and the next call reopens from scratch.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

/**
 * Counts how many times a store's upload has failed for a reason nobody
 * recognised, so the drain can set it aside rather than retry it forever. See
 * the matching migration in lib/stock-db.ts.
 */
async function migrateSyncAttempts(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 2) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  if (!columns.some((column) => column.name === 'sync_attempts')) {
    await db.execAsync('ALTER TABLE customers ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 2');
}

/**
 * Records when *this phone* last wrote a store, as opposed to when the store
 * last changed anywhere.
 *
 * `updated_at` can't answer that any more. It is the writing device's clock and
 * it travels with the row, so once customers pull two-way a store edited on
 * another handset this morning lands here carrying this morning's timestamp.
 * The "End the Day" manifest is the device's account of **what it produced**,
 * and counting on `updated_at` quietly folded every store this truck merely
 * *received* into that number.
 *
 * Only the three local writers below set it; `upsertCustomerFromServer` never
 * touches it. Existing rows are backfilled from `updated_at` — before this
 * column there was nothing better to say, and it keeps old rows counting the
 * way they always did rather than dropping out entirely.
 */
async function migrateLocalUpdatedAt(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 3) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  if (!columns.some((column) => column.name === 'local_updated_at')) {
    await db.execAsync('ALTER TABLE customers ADD COLUMN local_updated_at INTEGER');
    await db.execAsync('UPDATE customers SET local_updated_at = updated_at');
  }
  await db.execAsync('PRAGMA user_version = 3');
}

/**
 * The crew a store used to be assigned to. Crews (and store areas) were
 * removed; the column is still added here so the migration chain is unchanged
 * on older installs, but nothing reads or writes it any more.
 */
async function migrateAgentGroupId(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 4) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  if (!columns.some((column) => column.name === 'agent_group_id')) {
    await db.execAsync('ALTER TABLE customers ADD COLUMN agent_group_id TEXT');
  }
  await db.execAsync('PRAGMA user_version = 4');
}

/**
 * Marks the stores this phone typed in itself, so the Customers tab and the
 * receipt form's store picker can put a store the driver just added at the top
 * of the list with a "New" tag on it (see isNewCustomer in customer-types.ts).
 *
 * It has to be a stored fact rather than something worked out from the
 * timestamps. `created_at` travels with the row, so a store another handset
 * created this morning arrives carrying this morning's clock and would read as
 * this phone's own work. `local_updated_at` is no better on its own: it is
 * bumped by every *edit* too, so correcting a pulled store would promote it to
 * the top of the list as if it were new.
 *
 * **Nothing is backfilled, and the first attempt at this shipped a bug by
 * trying to be.** It flagged every row where `local_updated_at = created_at`,
 * reasoning that an insert writes both from one reading of the clock. So does
 * migrateLocalUpdatedAt, though — it set `local_updated_at = updated_at` on
 * *every* row already on disk, pulled ones included, and a store nobody has
 * edited since it was created has `updated_at = created_at` too. The condition
 * therefore matched almost the whole table, and every store on the phone
 * younger than a day came back tagged "New" (see migrateClearBackfilledCreatedLocally,
 * which repairs a device that ran it).
 *
 * The honest answer is that a row written before this column existed cannot
 * say where it came from, so it doesn't try: existing rows are 0, and only
 * `insertCustomer` ever sets a 1 from here on. The cost is that a store added
 * in the day before the app updates loses its tag early, once, which nobody
 * can see happen.
 */
async function migrateCreatedLocally(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 5) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  if (!columns.some((column) => column.name === 'created_locally')) {
    await db.execAsync('ALTER TABLE customers ADD COLUMN created_locally INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 5');
}

/**
 * Undoes the backfill described above on a device that already ran it.
 *
 * Dropping the statement from migrateCreatedLocally fixes phones that haven't
 * updated yet and does nothing for one that has — its `user_version` is already
 * 5, so that migration never runs again and the wrong flags stay on disk for
 * the life of the install.
 *
 * It clears the column outright rather than trying to work out which rows the
 * backfill got right. Nothing on disk can tell them apart — that is the whole
 * reason the backfill was wrong — and a store genuinely added in the last day
 * losing its tag is a smaller wrong answer than a store list where everything
 * is tagged, which is the same as nothing being tagged.
 */
async function migrateClearBackfilledCreatedLocally(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 6) return;

  await db.execAsync('UPDATE customers SET created_locally = 0');
  await db.execAsync('PRAGMA user_version = 6');
}

/**
 * Renames `created_locally` to `is_new`, because the flag stopped meaning where
 * a store came from.
 *
 * It is now cleared the moment a receipt is finalized for the store
 * (`clearCustomerIsNew`), so a column called "created locally" would be sitting
 * at 0 on a store this phone unquestionably created — a comment and a column
 * name that lie about the row underneath them, which is how the next person
 * reading this file gets a wrong idea for free.
 *
 * Provenance was only ever the means: the tag answers "is this the store you
 * just added and haven't billed yet", and `is_new` is that question. Only
 * `insertCustomer` sets it, and only `clearCustomerIsNew` and the 24-hour
 * window in `isNewCustomer` take it away.
 */
async function migrateNewUntilBilled(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 7) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  const hasOld = columns.some((column) => column.name === 'created_locally');
  const hasNew = columns.some((column) => column.name === 'is_new');
  if (hasOld && !hasNew) {
    await db.execAsync('ALTER TABLE customers RENAME COLUMN created_locally TO is_new');
  } else if (!hasNew) {
    // Belt and braces: migrateCreatedLocally always adds the old column first,
    // so this can't be reached — but a missing column here would throw on every
    // read of the table, and an empty one costs nothing.
    await db.execAsync('ALTER TABLE customers ADD COLUMN is_new INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync('PRAGMA user_version = 7');
}

/**
 * Adds the two columns customer sync needs.
 *
 * `sync_state` is the same flag the ledger and receipts carry — see the
 * matching migration in lib/stock-db.ts. Unlike those two, existing rows here
 * become `'pending'` rather than `'legacy'`: a customer is not tied to a run,
 * it belongs to the business, so a store created before sync existed is still
 * a store every other device needs. Uploading them is the desired outcome.
 *
 * `deleted` is the one that has to exist before customer data matters.
 * Customers are pulled with a watermark query — "everything changed since I
 * last looked" — and a *hard*-deleted row is simply absent from that result,
 * so a device that was offline when the delete happened would never learn
 * about it and would keep the store on its route forever. Marking the row
 * deleted and bumping `updated_at` makes the deletion itself a change the
 * watermark can carry.
 */
async function migrateSyncState(db: SQLiteDatabase): Promise<void> {
  const versionRow = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((versionRow?.user_version ?? 0) >= 1) return;

  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(customers)');
  if (!columns.some((column) => column.name === 'sync_state')) {
    await db.execAsync("ALTER TABLE customers ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!columns.some((column) => column.name === 'deleted')) {
    await db.execAsync('ALTER TABLE customers ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
  }
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_customers_pending
      ON customers(updated_at) WHERE sync_state = 'pending';
    PRAGMA user_version = 1;
  `);
}

type CustomerRow = {
  id: string;
  store_name: string;
  name: string;
  delivery_days: string;
  address: string;
  phone: string;
  description: string;
  created_at: number;
  updated_at: number;
  /** SQLite has no boolean — 0 or 1. See migrateSyncState. */
  deleted: number;
  /** 0 or 1, same as `deleted`. See migrateNewUntilBilled. */
  is_new: number;
  sync_state: string;
};

function rowToCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    storeName: row.store_name,
    name: row.name,
    deliveryDays: JSON.parse(row.delivery_days) as Weekday[],
    address: row.address,
    phone: row.phone,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isNew: row.is_new === 1,
  };
}

/** Everything the app should show — soft-deleted rows are kept on disk (see migrateSyncState) but never surfaced. */
export async function loadCustomers(): Promise<Customer[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CustomerRow>('SELECT * FROM customers WHERE deleted = 0');
  return rows.map(rowToCustomer);
}

// Every value below is bound as a `?` parameter, never spliced into the SQL
// string, so no input can be read as SQL. sanitizeCustomerInput is the second
// half of that: it strips the invisible/control characters that are harmless
// to SQLite but not to what reads the row back — see lib/text-input.ts.

/**
 * Adds a store.
 *
 * `customerId` makes a retry safe. Every other writer in this file is naturally
 * idempotent — updateCustomerRow and deleteCustomerRow set fixed values on a
 * known row, so running them twice is running them once — but an insert that
 * mints its own id creates a *second* store each time it is repeated, and the
 * caller sits inside a retry prompt. Passing one id per press of Save means a
 * retry rewrites the same row; a second press is a second, genuine store.
 *
 * (This is the mildest instance of the pattern: a duplicate store is visible in
 * the list and deletable, unlike a duplicate ledger entry, which just makes a
 * number wrong. It is fixed the same way because it costs nothing to.)
 */
export async function insertCustomer(input: CustomerInput, customerId?: string): Promise<Customer> {
  const db = await getDb();
  const now = Date.now();
  const clean = sanitizeCustomerInput(input);
  const customer: Customer = {
    ...clean,
    id: customerId ?? generateId(),
    createdAt: now,
    updatedAt: now,
    // Adding a store here is the one thing that makes one "new" — see
    // clearCustomerIsNew for the one thing that stops it being new.
    isNew: true,
  };
  const inserted = await db.runAsync(
    `INSERT OR IGNORE INTO customers (id, store_name, name, delivery_days, address, phone, description, created_at, updated_at, local_updated_at, is_new)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    customer.id,
    customer.storeName,
    customer.name,
    JSON.stringify(customer.deliveryDays),
    customer.address,
    customer.phone,
    customer.description,
    customer.createdAt,
    customer.updatedAt,
    // Same clock reading as updated_at: this write *is* the local write. They
    // part company later, when another phone's edit arrives — see
    // migrateLocalUpdatedAt.
    customer.updatedAt
  );

  // The id was already taken, so this is a repeat of a write that had actually
  // landed. Report the row that is really on disk — its values are the ones the
  // list on screen has to agree with.
  if (inserted.changes === 0) {
    const existing = await db.getFirstAsync<CustomerRow>('SELECT * FROM customers WHERE id = ?', customer.id);
    if (existing) return rowToCustomer(existing);
  }

  return customer;
}

/**
 * Resolves with the values actually written — the caller updates its in-memory
 * list from *that*, not from what it passed in, so the list on screen can't
 * disagree with the row on disk after sanitizing changed something.
 *
 * **`updatedAt` is part of that and has to be**, even though nothing renders
 * it. It used to return the fields only, leaving the caller to stamp its own
 * `Date.now()` onto the row it kept in memory — a second, later reading of the
 * clock than the one written here. The screen therefore held a store whose
 * `updatedAt` was a few milliseconds ahead of the same store on disk. Nothing
 * reads it today, which is exactly why it would have been a bad bug to find
 * later: `updatedAt` is the field last-write-wins is decided on
 * (`upsertCustomerFromServer`), the field the watermark pull orders by, and the
 * field `markCustomerSynced` matches a row against. A copy in memory that
 * disagrees with disk about it is a wrong answer waiting for a caller.
 */
export async function updateCustomerRow(
  id: string,
  input: CustomerInput
): Promise<CustomerInput & { updatedAt: number }> {
  const db = await getDb();
  const clean = sanitizeCustomerInput(input);
  const now = Date.now();
  // Back to 'pending' on every edit — that's what queues the new version for
  // upload, and what makes a second edit before the first one lands collapse
  // into a single push of the current row rather than two stale snapshots.
  //
  // The attempt counter resets with it. Those counts are evidence about the
  // version that failed to upload, and this is a different version: an edit
  // that inherited four unexplained failures would be set aside on its first
  // hiccup, having never actually failed.
  await db.runAsync(
    `UPDATE customers
     SET store_name = ?, name = ?, delivery_days = ?, address = ?, phone = ?, description = ?, updated_at = ?, local_updated_at = ?, sync_state = 'pending', sync_attempts = 0
     WHERE id = ?`,
    clean.storeName,
    clean.name,
    JSON.stringify(clean.deliveryDays),
    clean.address,
    clean.phone,
    clean.description,
    now,
    now,
    id
  );
  // The same `now` that went into the row, not a fresh reading of the clock.
  return { ...clean, updatedAt: now };
}

/**
 * A *soft* delete: the row stays, flagged. See migrateSyncState for why a hard
 * delete can't be synced — and note this bumps `updated_at`, because the
 * deletion is itself the change other devices need to receive.
 */
export async function deleteCustomerRow(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    "UPDATE customers SET deleted = 1, updated_at = ?, local_updated_at = ?, sync_state = 'pending', sync_attempts = 0 WHERE id = ?",
    now,
    now,
    id
  );
}

/**
 * Drops a store's "New" tag, because a receipt has now been finalized for it.
 *
 * The tag exists to carry a driver from "I just typed this store in" to "I have
 * invoiced it", and finalizing a receipt is that arrival — so it goes then
 * rather than waiting out the 24-hour window, which is only the backstop for a
 * store that never gets billed.
 *
 * **Deliberately not a sync-visible change.** It leaves `updated_at`,
 * `local_updated_at` and `sync_state` exactly where they are, unlike every
 * other writer in this file. The flag is one handset's note to itself about its
 * own screen; it is not part of the store, it is not uploaded
 * (`uploadCustomer` doesn't send it), and touching `updated_at` here would push
 * an identical copy of the store to Firestore and to every other phone — and
 * worse, would move it ahead of a genuine edit sitting in the last-write-wins
 * comparison.
 *
 * Guarded on `is_new = 1` so the ordinary case — every receipt after the first
 * one for that store — writes nothing at all.
 */
export async function clearCustomerIsNew(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE customers SET is_new = 0 WHERE id = ? AND is_new = 1', id);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** A row on its way up, including the soft-delete flag the server needs to see. */
export type PendingCustomer = Customer & { deleted: boolean };

/** Customers not yet pushed to Firestore, oldest change first. Includes soft-deleted rows. */
export async function loadPendingCustomers(limit: number): Promise<PendingCustomer[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<CustomerRow>(
    `SELECT * FROM customers WHERE sync_state = 'pending' ORDER BY updated_at ASC LIMIT ?`,
    limit
  );
  return rows.map((row) => ({ ...rowToCustomer(row), deleted: row.deleted === 1 }));
}

/**
 * How many stores this phone can actually show.
 *
 * Read by the customer pull to answer "is there a saved copy to fall back on?"
 * when the server doesn't respond — the same question the cached catalogs ask
 * of AsyncStorage. Soft-deleted rows are excluded because they are exactly what
 * the app refuses to show; a phone holding nothing but deletions has no store
 * list, whatever the row count says.
 */
export async function countCustomers(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM customers WHERE deleted = 0'
  );
  return row?.count ?? 0;
}

/**
 * How many stores *this device* created or edited while the run was open — for
 * the "End the Day" manifest.
 *
 * Counted on `local_updated_at`, not on `updated_at`: the latter is the writing
 * phone's clock and rides along with a pulled row, so a store another agent
 * corrected this morning would otherwise be counted here as this truck's work.
 * The manifest is what the device claims it produced, so it has to mean writes
 * that happened here. See migrateLocalUpdatedAt.
 *
 * The window is the **run's** own start and close, not the business day — a
 * truck can go out twice, and each manifest has to describe one trip. Two
 * consequences follow, both intended:
 *
 * - A store touched in both runs is counted in both. It is a count of activity
 *   during a trip, not of distinct stores.
 * - A store added *between* runs — the Customers tab still works once the day
 *   has ended and the wizard is back up — falls in neither window. It uploads
 *   and reaches every phone regardless; it just isn't claimed by a trip, because
 *   no truck was out. Widening a run's window back to the previous run's close
 *   would close the gap and would be the wrong answer.
 */
export async function countCustomersTouchedBetween(fromMs: number, toMs: number): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM customers WHERE local_updated_at >= ? AND local_updated_at <= ?',
    fromMs,
    toMs
  );
  return row?.count ?? 0;
}

/**
 * Counts unrecognised upload failures for one store — the twin of
 * bumpBatchAttempts in lib/stock-db.ts.
 */
export async function bumpCustomerAttempts(id: string): Promise<number> {
  const db = await getDb();
  await db.runAsync('UPDATE customers SET sync_attempts = sync_attempts + 1 WHERE id = ?', id);
  const row = await db.getFirstAsync<{ sync_attempts: number }>(
    'SELECT sync_attempts FROM customers WHERE id = ?',
    id
  );
  return row?.sync_attempts ?? 0;
}

/**
 * Sets a store aside after the server refused it.
 *
 * This one matters beyond the row itself: customers drain *first* in the pass,
 * so before this existed a single rejected store aborted the pass before the
 * ledger and receipts were even reached — one bad store could stop a whole
 * day's takings from uploading.
 *
 * A later edit to the store puts it back to `'pending'` (see updateCustomerRow)
 * and a newer version arriving from another device marks it `'synced'`, so this
 * is a resting state, not a grave.
 *
 * **Guarded on `updatedAt`, exactly like markCustomerSynced and for the mirror
 * reason.** An upload is allowed up to `CallTimeoutMs` (12s), and a driver can
 * edit the same store while the previous version is in the air. Unguarded, the
 * refusal of the *old* version would set the *new* one aside — a version the
 * server has never seen, quarantined without ever having failed, sitting unsent
 * until somebody finds Settings' "Try sending refused records again". That is
 * the same reasoning updateCustomerRow uses when it resets `sync_attempts` on
 * an edit: evidence about one version says nothing about the next.
 *
 * When the guard doesn't match, the row simply stays `'pending'` and the next
 * pass uploads the new version — which is what it deserves. It cannot loop:
 * once the row stops changing, the guard matches and the refusal sticks.
 */
export async function markCustomerBlocked(id: string, updatedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE customers SET sync_state = 'blocked' WHERE id = ? AND updated_at = ?",
    id,
    updatedAt
  );
}

/** Stores the server refused. Reported to the user; never retried on its own. */
export async function countBlockedCustomers(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM customers WHERE sync_state = 'blocked'"
  );
  return row?.count ?? 0;
}

/**
 * Puts every refused store back in the queue — see retryBlockedBatches in
 * lib/stock-db.ts.
 *
 * No run scoping here, unlike the other two, because a store belongs to no run.
 * That is also why the run manifest counts *every* refused store on the phone:
 * there is no honest way to attribute one to a trip.
 */
export async function retryBlockedCustomers(): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    "UPDATE customers SET sync_state = 'pending', sync_attempts = 0 WHERE sync_state = 'blocked'"
  );
  return result.changes;
}

export async function countPendingCustomers(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM customers WHERE sync_state = 'pending'"
  );
  return row?.count ?? 0;
}

/**
 * Marks a row synced, but only if it hasn't been edited since the upload
 * started.
 *
 * The `updated_at = ?` guard is the whole point. Uploading is not instant, and
 * a driver can edit the same store while its previous version is in the air.
 * An unguarded `SET sync_state = 'synced'` would mark the *new* edit as
 * uploaded when what actually reached Firestore was the old one, and that edit
 * would never be sent again.
 */
export async function markCustomerSynced(id: string, updatedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE customers SET sync_state = 'synced' WHERE id = ? AND updated_at = ?",
    id,
    updatedAt
  );
}

/** Stores the server has confirmed it received — see countSyncedReceipts in lib/receipt-db.ts. */
export async function countSyncedCustomers(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM customers WHERE sync_state = 'synced'"
  );
  return row?.count ?? 0;
}

/**
 * Applies one customer pulled from Firestore, last-write-wins.
 *
 * Returns whether the local row actually changed, so the caller only rebuilds
 * its in-memory list when something moved.
 *
 * Two guards matter here:
 *
 * - `WHERE updated_at < ?` implements last-write-wins without a read first, and
 *   without ever moving a row *backwards* in time.
 * - The local `sync_state` is left as `'synced'` for a row the server just gave
 *   us — it came from the server, so it is by definition already there. What it
 *   must not do is clobber a row still marked `'pending'`: that row holds an
 *   edit this phone hasn't managed to push yet, and the `updated_at` comparison
 *   is what protects it (a pending local edit is newer than what the server
 *   currently holds, so the update is a no-op and the push still happens).
 */
export async function upsertCustomerFromServer(remote: PendingCustomer): Promise<boolean> {
  const db = await getDb();
  const result = await db.runAsync(
    `INSERT INTO customers (id, store_name, name, delivery_days, address, phone, description, created_at, updated_at, deleted, sync_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
     ON CONFLICT(id) DO UPDATE SET
       store_name = excluded.store_name,
       name = excluded.name,
       delivery_days = excluded.delivery_days,
       address = excluded.address,
       phone = excluded.phone,
       description = excluded.description,
       updated_at = excluded.updated_at,
       deleted = excluded.deleted,
       sync_state = 'synced'
     WHERE customers.updated_at < excluded.updated_at`,
    remote.id,
    remote.storeName,
    remote.name,
    JSON.stringify(remote.deliveryDays),
    remote.address,
    remote.phone,
    remote.description,
    remote.createdAt,
    remote.updatedAt,
    remote.deleted ? 1 : 0
  );
  return result.changes > 0;
}
