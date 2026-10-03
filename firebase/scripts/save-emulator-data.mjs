// Saves whatever is in the running emulators to firebase/emulator-data, without
// stopping them. `npm run emulators:save`.
//
// The emulators normally save on their way out (--export-on-exit, set up in
// emulators.mjs), which covers the ordinary case of pressing Ctrl+C. This covers
// the rest: closing the terminal window outright, a laptop that sleeps and never
// wakes the same way, or simply wanting a checkpoint before trying something
// destructive. Nothing is stopped and nothing is disconnected — the apps keep
// running against the emulators while it writes.
//
// WHY THIS TALKS TO THE HUB DIRECTLY. firebase-tools has its own command for
// this (`firebase emulators:export`) and it does the export correctly, but on
// Windows the CLI process dies on the way out with a libuv assertion —
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — *after* the data is
// safely written, and exits 127. npm then reports a failed command over a
// completed export, which is the worst possible thing to show someone who is
// specifically checking whether their data got saved. The export itself is one
// HTTP POST to the emulator hub, which is all that command does, so this asks
// the hub itself and reports what actually happened.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const firebaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Same folder emulators.mjs imports from on start — that symmetry is the point.
const DATA_DIR = path.join(firebaseDir, 'emulator-data');

const projectIndex = process.argv.indexOf('--project');
const projectId = projectIndex === -1 ? 'demo-newoldworld' : (process.argv[projectIndex + 1] ?? 'demo-newoldworld');

/**
 * The running hub announces itself in a file in the temp folder, so its address
 * doesn't have to be guessed or kept in step with firebase.json.
 */
function hubOrigins() {
  const locatorPath = path.join(os.tmpdir(), `hub-${projectId}.json`);
  if (!existsSync(locatorPath)) return [];
  try {
    return JSON.parse(readFileSync(locatorPath, 'utf8')).origins ?? [];
  } catch {
    return [];
  }
}

const origins = hubOrigins();

if (origins.length === 0) {
  console.error(
    [
      '',
      `No running emulators found for project "${projectId}".`,
      '',
      'There is nothing to save — start them with `npm run emulators` first.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

// The locator can name several addresses for the same hub (IPv4 and IPv6). Any
// one that answers is the same hub, so the first success is the answer and a
// refused connection just means "try the other spelling of localhost".
let lastError = null;

for (const origin of origins) {
  try {
    const response = await fetch(`${origin}/_admin/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The export can take a while on a large dataset; it is one blocking call.
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({ path: DATA_DIR, initiatedBy: 'npm run emulators:save' }),
    });

    if (!response.ok) {
      lastError = new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
      continue;
    }

    console.log(`Saved the emulator data to ${DATA_DIR}`);
    console.log('The emulators are still running — this was a checkpoint, not a shutdown.');
    process.exit(0);
  } catch (error) {
    lastError = error;
  }
}

console.error(
  [
    '',
    'Could not save the emulator data.',
    `Tried: ${origins.join(', ')}`,
    lastError ? `Last error: ${lastError.message}` : '',
    '',
    'If the emulators were stopped just now, their own shutdown save has it covered.',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
process.exit(1);
