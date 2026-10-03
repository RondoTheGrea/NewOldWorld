// Firebase Hosting requires its "public" directory to live inside the same
// directory as firebase.json — it rejects a "../" path outside the project
// directory outright. apps/web/dist is a sibling of firebase/, not inside it,
// so this copies the already-built dashboard into firebase/web-dist, which is
// what firebase.json's hosting.public actually points at.
//
// Runs as a hosting predeploy step, after `npm --prefix ../apps/web run build`
// has produced apps/web/dist.

import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const firebaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(firebaseDir, '..', 'apps', 'web', 'dist');
const dest = path.join(firebaseDir, 'web-dist');

if (!existsSync(src)) {
  console.error(`[hosting] ${src} does not exist — the web build must have failed.`);
  process.exit(1);
}

// Clear out anything from a previous build first, so a deleted file in the
// new build can't linger and get deployed by accident.
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

console.log('[hosting] copied apps/web/dist -> firebase/web-dist');
