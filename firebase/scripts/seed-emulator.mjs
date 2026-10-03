// Seeds baseline reference data into the Firestore emulator so the app has
// something to show without the owner ever opening the Emulator UI by hand.
//
// Safe to run on every emulator start, whether firebase/emulator-data/ was
// restored from a previous session or wiped by `emulators:fresh` — every
// write here is an idempotent upsert (deterministic doc ID + `merge: true`),
// so re-running it never duplicates or clobbers anything.
//
// Uses the Admin SDK, which talks to the emulator by way of the
// FIRESTORE_EMULATOR_HOST env var (set below) and — importantly — bypasses
// firestore.rules entirely. That's fine here: rules only govern the app's
// client SDK, and this script's job is exactly the "seeded server-side"
// escape hatch firestore.rules documents for the /areas collection.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import process from 'node:process';

const HOST = '127.0.0.1';
const PORT = 8080;
const PROJECT_ID = 'demo-newoldworld';

process.env.FIRESTORE_EMULATOR_HOST = `${HOST}:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT_ID;

// The reference lists the mobile setup screen reads. The ids seeded here are
// what every uploaded run is grouped by, so they have to be stable and shared,
// not typed into each phone (see docs/sync-design.md).
//
// Areas and trucks are the plain `{ name }` shape. Agents are not: a truck is
// assigned a whole **crew**, so every agent belongs to exactly one group and
// carries its `groupId`.
const AREAS = ['Cainta', 'Cubao', 'Pasig'];
const TRUCKS = ['Truck 1', 'Truck 2', 'Truck 3'];
const AGENT_GROUPS = [
  { name: 'Crew A', agents: ['Juan Dela Cruz', 'Maria Santos'] },
  { name: 'Crew B', agents: ['Pedro Reyes', 'Ana Bautista'] },
];

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Waits for the Firestore emulator's HTTP port to answer before writing to
 * it — this script gets spawned alongside the emulator process, not after
 * it, so the JVM underneath Firestore may not have finished starting yet.
 */
async function waitForEmulator(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${HOST}:${PORT}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Firestore emulator never answered on ${HOST}:${PORT} after ${timeoutMs}ms`);
}

async function main() {
  await waitForEmulator();

  initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();

  const seedNamed = (collection, names) =>
    Promise.all(
      names.map((name, order) => db.collection(collection).doc(slugify(name)).set({ name, order }, { merge: true })),
    );

  // `order` is written here too: the dashboard backfills a missing one on
  // read, but seeding it means a fresh emulator shows the lists in the order
  // they're written above rather than alphabetically.
  const seedAgentGroups = () =>
    Promise.all(
      AGENT_GROUPS.flatMap((group, groupOrder) => {
        const groupId = slugify(group.name);
        return [
          db.collection('agentGroups').doc(groupId).set({ name: group.name, order: groupOrder }, { merge: true }),
          ...group.agents.map((name, order) =>
            db.collection('agents').doc(slugify(name)).set({ name, order, groupId }, { merge: true }),
          ),
        ];
      }),
    );

  await Promise.all([seedNamed('areas', AREAS), seedNamed('trucks', TRUCKS), seedAgentGroups()]);

  console.log(`[seed] areas ready: ${AREAS.join(', ')}`);
  console.log(`[seed] trucks ready: ${TRUCKS.join(', ')}`);
  for (const group of AGENT_GROUPS) {
    console.log(`[seed] crew ready: ${group.name} — ${group.agents.join(', ')}`);
  }

  await db.collection('settings').doc('business').set(
    {
      name: "Nadean's Marketing",
      contactNumber: '0947-567-7874',
      receiptEndingMessage: 'Thank you for your purchase!',
    },
    { merge: true },
  );

  console.log('[seed] business settings ready');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exit(1);
  });
