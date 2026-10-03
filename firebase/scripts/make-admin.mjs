// Creates (or promotes) a dashboard ADMINISTRATOR — the one account that can
// then manage everybody else from the dashboard's own Team page.
//
// This is a bootstrap, run once per project. After it, nobody needs it again:
// the client's administrator adds, disables and removes their own staff on the
// Team page, and can appoint further administrators there too. It exists
// because the very first admin has nobody to create them — and because the
// alternative is talking a non-technical owner through the Firebase console.
//
//   npm run make-admin -- owner@theirbusiness.com          (emulators)
//   npm run make-admin:cloud -- owner@theirbusiness.com    (REPLACE-WITH-NEW-PROJECT-ID)
//
// If the account doesn't exist it is created, and a password-setup link is
// printed for you to send them. If it already exists it is promoted, and
// nothing else about it changes.
//
// Uses the Admin SDK, which bypasses firestore.rules — that is the whole point.
// `admin: true` can never be set by a client (see the /users block in
// firestore.rules), so a server-side script is the only thing that can grant
// the first one.

import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import process from 'node:process';

const CLOUD_PROJECT = 'REPLACE-WITH-NEW-PROJECT-ID';
const DEMO_PROJECT = 'demo-newoldworld';

const args = process.argv.slice(2);
const useCloud = args.includes('--cloud');
const email = args.find((arg) => !arg.startsWith('--'))?.trim().toLowerCase();
const name = args.find((arg) => arg.startsWith('--name='))?.slice('--name='.length).trim();

if (!email || !email.includes('@')) {
  console.error(
    [
      'Usage: node scripts/make-admin.mjs <email> [--cloud] [--name="Full Name"]',
      '',
      '  npm run make-admin -- owner@example.com',
      '  npm run make-admin:cloud -- owner@example.com --name="Maria Santos"',
    ].join('\n'),
  );
  process.exit(1);
}

if (useCloud) {
  process.env.GCLOUD_PROJECT = CLOUD_PROJECT;
  // Against the real project the Admin SDK needs Application Default
  // Credentials. `gcloud auth application-default login` is the one-off that
  // provides them — the same gcloud already used for scripts/storage-cors.mjs.
} else {
  process.env.GCLOUD_PROJECT = DEMO_PROJECT;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
}

const app = initializeApp({ projectId: useCloud ? CLOUD_PROJECT : DEMO_PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);

const target = useCloud ? `CLOUD project ${CLOUD_PROJECT}` : 'the local emulators';
console.log(`Making ${email} a dashboard administrator on ${target}…\n`);

let user;
let created = false;
try {
  user = await auth.getUserByEmail(email);
  // A mistyped address that happens to belong to a DRIVER would otherwise be
  // converted into a dashboard admin without a word: `requireMobileAccount`
  // would then refuse them on the phone, and any run they had open could never
  // be closed, because firestore.rules ties every upload to the account that
  // started it. A role is meant to be permanent; this is the one script that
  // could quietly change one.
  const existing = (await db.collection('users').doc(user.uid).get()).data();
  if (existing?.role === 'mobile') {
    console.error(
      [
        `✗ ${email} is a MOBILE (driver) account — refusing to convert it.`,
        '',
        'Dashboard and phone accounts are deliberately separate. Converting this',
        'one would lock the driver out of the app and strand any run they have',
        'open. Use a different email address for the dashboard administrator.',
      ].join('\n'),
    );
    process.exit(1);
  }
} catch (error) {
  if (error.code !== 'auth/user-not-found') throw error;
  user = await auth.createUser({
    email,
    displayName: name || email.split('@')[0],
    // Never shown and never reused — the reset link below is how a password is
    // actually set, exactly as it works for everyone added on the Team page.
    password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
  });
  created = true;
}

// merge, so promoting an existing account keeps whatever it already has.
await db.collection('users').doc(user.uid).set(
  {
    role: 'dashboard',
    admin: true,
    email,
    ...(name ? { displayName: name } : {}),
    ...(created ? { createdAt: FieldValue.serverTimestamp(), createdBy: 'make-admin script' } : {}),
  },
  { merge: true },
);

console.log(created ? '✓ Account created' : '✓ Existing account found');
console.log(`✓ users/${user.uid} now has role: "dashboard", admin: true\n`);

if (created) {
  // The Admin SDK can generate this link but cannot deliver it — only a client
  // SDK can reach Firebase's mail sender. So it is printed for you to pass on.
  // Against the emulator the link points at localhost and works there.
  const link = await auth.generatePasswordResetLink(email);
  console.log('Send them this link to set their password (it expires — resend from the');
  console.log('Team page if it lapses):\n');
  console.log(`  ${link}\n`);
}

console.log('They can now sign in and use the Team page to add everyone else.');
