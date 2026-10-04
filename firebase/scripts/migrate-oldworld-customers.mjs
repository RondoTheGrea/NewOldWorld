// Copies the OldWorld app's customer list into NewOldWorld's `customers`
// collection (Firestore) — once, at switch-over. Only customer profiles move;
// OldWorld's receipts, inventory and everything else stay put.
//
// The source is the CSV exported from OldWorld's Appwrite console (the
// `customers` collection), saved at the root of this repo. Step-by-step
// instructions for the owner: docs/oldworld-customer-migration.md
//
//   npm run migrate:oldworld                       preview against the emulators
//   npm run migrate:oldworld -- --write            write to the emulators
//   npm run migrate:oldworld:cloud                 preview against newoldworld-b8f5d
//   npm run migrate:oldworld:cloud -- --write      write to newoldworld-b8f5d
//
//   --file=<path.csv>    which export to read. Left out, the script uses the
//                        newest `customersCollectionId_*.csv` at the repo root.
//
// **A preview changes nothing anywhere.** It reads the CSV, groups duplicates,
// checks what NewOldWorld already has, and writes a report to
// firebase/migration-output/ for you to open in Excel. Only `--write` touches
// Firestore, and even then it only ever *creates* — an existing store is never
// overwritten, so running it twice is safe.
//
// The CSV's first row is its column names, never a customer. It is checked
// rather than assumed: the script refuses to run unless the columns it needs
// are all there, and refuses any row whose cell count doesn't match it (the
// sign of a file that didn't parse the way it looks).
//
// Duplicates: two records are the same customer only when BOTH the name and
// the store name match after ignoring capital letters, extra spaces and
// invisible characters. Anything else — "Store 2", "Store (Main)", a different
// spelling — is a different customer. Matching records become ONE store: the
// most recently updated record supplies the values, and any field it left blank
// is filled from the others.
//
// Uses the Admin SDK, which bypasses firestore.rules — and App Check, which
// only applies to the apps' client SDKs, so enforcing it later changes nothing
// here. Against the real project it needs Application Default Credentials —
// `gcloud auth application-default login`, the same one-off make-admin.mjs
// relies on — or, when that has never been set up, the Firebase CLI's own
// login (`firebase login`, the one `npm run deploy` already uses).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Firestore, getFirestore } from 'firebase-admin/firestore';

const CLOUD_PROJECT = 'newoldworld-b8f5d';
const DEMO_PROJECT = 'demo-newoldworld';

const here = dirname(fileURLToPath(import.meta.url));
const firebaseDir = resolve(here, '..');
const repoRoot = resolve(firebaseDir, '..');
const outputDir = join(firebaseDir, 'migration-output');

const args = process.argv.slice(2);
const useCloud = args.includes('--cloud');
const write = args.includes('--write');
const fileArg = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);

/** The columns this script reads. The export has more ($permissions, userId, …); those are ignored. */
const RequiredColumns = ['$id', 'name', 'storeName', 'address', 'phoneNumber', 'schedule'];

// The same caps the phone's form enforces (CustomerFieldLimits in
// apps/mobile/src/lib/customer-types.ts). Keep the two in step.
const Limits = { storeName: 80, name: 80, address: 200, phone: 32, schedule: 120 };

// What the phone writes as `schemaVersion` (SchemaVersion in
// apps/mobile/src/lib/sync-types.ts).
const SchemaVersion = 1;

/** OldWorld's phones were in the Philippines: a date with no timezone is Manila time. */
const ManilaOffset = '+08:00';

// ---------------------------------------------------------------------------
// Text cleanup — a copy of apps/mobile/src/lib/text-input.ts, so a migrated
// store holds exactly what the phone's own form would have saved.
// ---------------------------------------------------------------------------

const INVISIBLE = new RegExp(
  `[${[
    [0x0000, 0x0008],
    [0x000b, 0x001f],
    [0x007f, 0x009f],
    [0x200b, 0x200f],
    [0x2028, 0x2029],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x206f],
    [0xfeff, 0xfeff],
  ]
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join('')}]`,
  'g',
);

function truncate(value, max) {
  if (value.length <= max) return value;
  return value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

function singleLine(value, max) {
  const collapsed = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(collapsed, max).trim();
}

function multiline(value, max) {
  const collapsed = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(collapsed, max).trim();
}

/**
 * The duplicate test. Case, spacing and invisible characters are ignored and
 * nothing else is — punctuation, numbers and extra words all still count, on
 * the owner's instruction that "Store 2" is a different customer from "Store".
 */
function matchKey(name, storeName) {
  const norm = (value) => singleLine(value, 10_000).toLowerCase();
  return `${norm(name)}\u0000${norm(storeName)}`;
}

/**
 * Derived from the match key rather than from any one OldWorld record, so a
 * second run lands on the same document whichever duplicate it happens to
 * pick — the duplicate check holds across runs, not only within one.
 */
function storeId(key) {
  return `oldworld_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// Reading the CSV
// ---------------------------------------------------------------------------

/** The newest Appwrite export at the repo root, unless --file names one. */
function pickCsv() {
  if (fileArg) return resolve(fileArg);
  const candidates = readdirSync(repoRoot)
    .filter((name) => /^customersCollectionId_.*\.csv$/i.test(name))
    .map((name) => join(repoRoot, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    fail([
      `No customersCollectionId_*.csv found in ${repoRoot}`,
      '',
      'Export the customers collection from the Appwrite console, put the CSV',
      'in the NewOldWorld folder, or pass --file=<path to the csv>.',
    ]);
  }
  return candidates[0];
}

/**
 * RFC 4180 CSV: a cell in double quotes may hold commas, line breaks and
 * doubled quotes (""), which is exactly what the export does — the
 * `$permissions` column is JSON in quotes, and some addresses span lines. So
 * the file is walked a character at a time; splitting on newlines and commas
 * would cut those rows apart.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) fail(['The CSV ends inside a quoted cell — the file looks cut off or damaged.']);
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A trailing newline leaves one empty "row" behind; it is not a customer.
  return rows.filter((cells) => !(cells.length === 1 && cells[0] === ''));
}

/** Rows as objects keyed by the header row — which is checked, then dropped. */
function readCsv(path) {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  if (rows.length === 0) fail([`${path} is empty.`]);
  const [header, ...data] = rows;
  const columns = header.map((name) => name.trim());
  const missing = RequiredColumns.filter((name) => !columns.includes(name));
  if (missing.length) {
    fail([
      `The first row of the CSV should be the column names, and these are missing: ${missing.join(', ')}`,
      `First row found: ${columns.join(', ')}`,
      '',
      'Make sure this is the export of OldWorld\'s "customers" collection.',
    ]);
  }
  const broken = data
    .map((cells, index) => ({ cells, line: index + 2 }))
    .filter(({ cells }) => cells.length !== columns.length);
  if (broken.length) {
    fail([
      `${broken.length} row(s) have a different number of cells than the header (${columns.length}).`,
      `First one is data row ${broken[0].line} with ${broken[0].cells.length} cells.`,
      'The file may have been edited or saved by a program that changed its quoting.',
    ]);
  }
  return data.map((cells) => Object.fromEntries(columns.map((name, index) => [name, cells[index]])));
}

/** The export writes a missing value as the word `null`. */
function value(cell) {
  return cell === undefined || cell === 'null' ? '' : cell;
}

/**
 * OldWorld wrote two date shapes: ISO with a `Z`, and Manila local time with no
 * zone at all ("2025-03-14T06:30:00.000"). The second has to be read as Manila,
 * or every one lands eight hours out.
 */
function parseOldWorldDate(cell) {
  const text = value(cell).trim();
  if (!text) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const ms = Date.parse(hasZone ? text : `${text}${ManilaOffset}`);
  return Number.isFinite(ms) ? ms : null;
}

/** One CSV row as the fields NewOldWorld keeps, plus what we need to report on it. */
function toRecord(row) {
  const raw = {
    name: value(row.name),
    storeName: value(row.storeName),
    phone: value(row.phoneNumber),
    schedule: value(row.schedule),
    address: value(row.address),
  };
  const clean = {
    name: singleLine(raw.name, Limits.name),
    storeName: singleLine(raw.storeName, Limits.storeName),
    phone: singleLine(raw.phone, Limits.phone),
    schedule: singleLine(raw.schedule, Limits.schedule),
    address: multiline(raw.address, Limits.address),
  };
  const shortened = Object.keys(Limits).filter(
    (field) => singleLine(raw[field], 100_000).length > Limits[field],
  );
  return {
    appwriteId: value(row.$id),
    customerId: value(row.customerId),
    ...clean,
    createdAt: parseOldWorldDate(row.createdAt) ?? parseOldWorldDate(row.$createdAt),
    updatedAt: parseOldWorldDate(row.lastUpdated) ?? parseOldWorldDate(row.$updatedAt) ?? 0,
    shortened,
  };
}

/**
 * Collapses one duplicate group to a single store: newest record first, then
 * each blank field filled from the next-newest record that has it.
 */
function mergeGroup(records) {
  const newestFirst = [...records].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.appwriteId.localeCompare(b.appwriteId),
  );
  const merged = { ...newestFirst[0] };
  const filled = [];
  for (const field of ['phone', 'schedule', 'address']) {
    if (merged[field]) continue;
    const donor = newestFirst.find((record) => record[field]);
    if (donor) {
      merged[field] = donor[field];
      filled.push(field);
    }
  }
  const created = records.map((record) => record.createdAt).filter((ms) => ms !== null);
  merged.createdAt = created.length ? Math.min(...created) : null;
  merged.shortened = [...new Set(records.flatMap((record) => record.shortened))];
  return { merged, filled, newestFirst };
}

/**
 * How the script signs in to the real project.
 *
 * Application Default Credentials (gcloud) when they exist — the Admin SDK
 * finds those on its own, so nothing is passed. Otherwise the Firebase CLI's
 * saved login: the same Google account `npm run deploy` acts as, so it already
 * has access to the project, and nothing has to be installed or downloaded.
 * The CLI's OAuth client id/secret are read from the installed firebase-tools
 * rather than copied here (they are public — they ship in that package).
 */
function cloudCredential() {
  const adcFile = join(process.env.APPDATA ?? join(homedir(), '.config'), 'gcloud', 'application_default_credentials.json');
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || existsSync(adcFile)) return null;

  const cliConfig = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
  const login = existsSync(cliConfig) ? JSON.parse(readFileSync(cliConfig, 'utf8')) : null;
  if (!login?.tokens?.refresh_token) {
    fail([
      'Not signed in to Google.',
      '',
      'Run `npx firebase login` (in the firebase folder) with the account that owns the project, then try again.',
    ]);
  }
  const api = createRequire(join(firebaseDir, 'package.json'))('firebase-tools/lib/api.js');
  console.log(`Signing in as ${login.user?.email ?? 'the Firebase CLI account'} (Firebase CLI login)
`);
  return {
    type: 'authorized_user',
    client_id: api.clientId(),
    client_secret: api.clientSecret(),
    refresh_token: login.tokens.refresh_token,
  };
}

// ---------------------------------------------------------------------------
// Report (CSV with a BOM, so Excel opens Filipino names and ñ correctly)
// ---------------------------------------------------------------------------

function csv(rows) {
  const cell = (text) => {
    const string = String(text ?? '');
    return /[",\n\r]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  };
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

function fail(lines) {
  console.error(`\n✗ ${lines.join('\n  ')}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const target = useCloud ? `the REAL project ${CLOUD_PROJECT}` : 'the local emulators';
console.log(`\nOldWorld → NewOldWorld customer migration`);
console.log(`Target: ${target}`);
console.log(`Mode:   ${write ? 'WRITE — stores will be created' : 'PREVIEW — nothing will be changed'}\n`);

mkdirSync(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// 1. OldWorld's customers, from the CSV export.
const csvPath = pickCsv();
const rows = readCsv(csvPath);
console.log(`Read ${rows.length} OldWorld customers from ${basename(csvPath)}`);
console.log('  (first row = column names, checked and skipped)\n');

const records = rows.map(toRecord);

// 2. Group by name AND store name.
const empty = records.filter((record) => !record.name && !record.storeName);
const groups = new Map();
for (const record of records) {
  if (!record.name && !record.storeName) continue;
  const key = matchKey(record.name, record.storeName);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(record);
}

// 3. What NewOldWorld already holds, so nothing is added twice — whether it was
//    migrated by an earlier run or typed in on a NewOldWorld phone.
if (useCloud) {
  process.env.GCLOUD_PROJECT = CLOUD_PROJECT;
} else {
  process.env.GCLOUD_PROJECT = DEMO_PROJECT;
  // Overridable so a test can point at a throwaway emulator on another port.
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
}
const cliCredentials = useCloud ? cloudCredential() : null;
// The Firebase CLI login goes straight to the Firestore client: firebase-admin's
// getFirestore() accepts only a service-account key or gcloud's credentials,
// while the client underneath it takes this kind of login as it is.
const db = cliCredentials
  ? new Firestore({ projectId: CLOUD_PROJECT, credentials: cliCredentials })
  : getFirestore(initializeApp({ projectId: useCloud ? CLOUD_PROJECT : DEMO_PROJECT }));

console.log('Reading the stores NewOldWorld already has…');
let existingSnapshot;
try {
  existingSnapshot = await db.collection('customers').get();
} catch (error) {
  fail([
    `Could not read Firestore: ${error.message}`,
    '',
    useCloud
      ? 'Run `gcloud auth application-default login` with the Google account that owns the Firebase project, then try again.'
      : 'Start the emulators first (`npm run emulators` in another window), then try again.',
  ]);
}
const existingIds = new Set(existingSnapshot.docs.map((doc) => doc.id));
const existingKeys = new Set();
for (const doc of existingSnapshot.docs) {
  const data = doc.data();
  if (data.deleted === true) continue;
  existingKeys.add(matchKey(data.name, data.storeName));
}
console.log(`  ${existingSnapshot.size} store documents found\n`);

// 4. Decide each group's fate.
const plan = [];
const duplicateRows = [];
let groupNumber = 0;
for (const [key, group] of groups) {
  const { merged, filled, newestFirst } = mergeGroup(group);
  const id = storeId(key);
  const notes = [];
  if (group.length > 1) {
    groupNumber += 1;
    notes.push(`merged ${group.length} OldWorld records (duplicate group ${groupNumber})`);
    for (const [index, record] of newestFirst.entries()) {
      duplicateRows.push([
        groupNumber,
        index === 0 ? 'KEPT (newest)' : 'merged into the kept one',
        record.storeName,
        record.name,
        record.phone,
        record.schedule,
        record.address,
        record.updatedAt ? new Date(record.updatedAt).toISOString() : '',
        record.appwriteId,
      ]);
    }
  }
  if (filled.length) notes.push(`blank ${filled.join(', ')} filled from an older duplicate`);
  if (merged.shortened.length) notes.push(`shortened to fit: ${merged.shortened.join(', ')}`);
  const missing = ['name', 'storeName', 'phone', 'schedule', 'address'].filter((field) => !merged[field]);
  if (missing.length) notes.push(`empty in OldWorld: ${missing.join(', ')}`);

  let action = 'ADD';
  if (existingIds.has(id)) {
    action = 'SKIP — already migrated';
  } else if (existingKeys.has(key)) {
    action = 'SKIP — already in NewOldWorld';
  }
  plan.push({ action, id, merged, group, notes });
}
plan.sort((a, b) => a.merged.storeName.localeCompare(b.merged.storeName) || a.merged.name.localeCompare(b.merged.name));

const toAdd = plan.filter((entry) => entry.action === 'ADD');

// 5. The report.
const reportPath = join(outputDir, `migration-report-${stamp}${write ? '' : '-preview'}.csv`);
writeFileSync(
  reportPath,
  csv([
    ['Result', 'Store Name', 'Name', 'Phone Number', 'Schedule', 'Address', 'Notes', 'NewOldWorld id'],
    ...plan.map(({ action, id, merged, notes }) => [
      action,
      merged.storeName,
      merged.name,
      merged.phone,
      merged.schedule,
      merged.address,
      notes.join('; '),
      id,
    ]),
    ...empty.map((record) => ['SKIP — no name and no store name', '', '', record.phone, record.schedule, record.address, '', '']),
  ]),
);
const duplicatesPath = join(outputDir, `duplicates-${stamp}.csv`);
if (duplicateRows.length) {
  writeFileSync(
    duplicatesPath,
    csv([
      ['Group', 'What happened', 'Store Name', 'Name', 'Phone Number', 'Schedule', 'Address', 'Last updated (UTC)', 'Appwrite id'],
      ...duplicateRows,
    ]),
  );
}

const mergedAway = plan.reduce((sum, entry) => sum + entry.group.length - 1, 0);
console.log('Summary');
console.log(`  OldWorld customers in the CSV .... ${records.length}`);
console.log(`  duplicates merged away ........... ${mergedAway} (in ${groupNumber} groups)`);
console.log(`  blank records skipped ............ ${empty.length}`);
console.log(`  already in NewOldWorld, skipped .. ${plan.length - toAdd.length}`);
console.log(`  stores to add .................... ${toAdd.length}\n`);
console.log(`Report:     ${reportPath}`);
if (duplicateRows.length) console.log(`Duplicates: ${duplicatesPath}`);

if (!write) {
  console.log('\nPreview only — nothing was written. Check the report, then run again with --write.\n');
  process.exit(0);
}

// 6. Write. `create`, never `set`: a document that has appeared since the check
//    above fails the batch instead of being overwritten.
const writtenAt = Date.now();
for (let start = 0; start < toAdd.length; start += 400) {
  const batch = db.batch();
  for (const { id, merged, group } of toAdd.slice(start, start + 400)) {
    batch.create(db.collection('customers').doc(id), {
      schemaVersion: SchemaVersion,
      storeName: merged.storeName,
      name: merged.name,
      address: merged.address,
      phone: merged.phone,
      schedule: merged.schedule,
      createdAt: merged.createdAt ?? writtenAt,
      // Now, not OldWorld's date: phones download stores "changed since I last
      // looked", so an old date would hide these from a phone that has already
      // done a truck setup.
      updatedAt: writtenAt,
      deleted: false,
      updatedByUid: 'oldworld-migration',
      uploadedAt: FieldValue.serverTimestamp(),
      migratedFrom: {
        system: 'OldWorld (Appwrite CSV export)',
        file: basename(csvPath),
        appwriteIds: group.map((record) => record.appwriteId),
        customerIds: group.map((record) => record.customerId).filter(Boolean),
      },
    });
  }
  await batch.commit();
  console.log(`  wrote ${Math.min(start + 400, toAdd.length)} of ${toAdd.length}`);
}

console.log(`\n✓ ${toAdd.length} stores added to ${target}.`);
console.log('  Phones receive them at their next truck setup ("Stores" in the download list).\n');
