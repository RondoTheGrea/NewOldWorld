#!/usr/bin/env node
/**
 * Applies `storage-cors.json` to the real Cloud Storage bucket.
 *
 * **Why this exists at all.** The dashboard's Excel export embeds each
 * proof-of-payment photo *inside* the workbook, which means the browser has to
 * read the bytes (`getBlob`) rather than just display them. Showing a
 * cross-origin image in an `<img>` needs no permission; reading one does — so
 * the bucket has to name the dashboard's origin. Without this, the export still
 * produces a file, it just writes "Photo could not be downloaded" in the cell
 * where the picture should be.
 *
 * This is a **one-time** setup step per bucket, not part of a deploy. Nothing
 * in `firebase deploy` touches CORS: it is a Cloud Storage setting, not a
 * Firebase one, which is why it needs `gcloud` instead of `firebase`.
 *
 * The Storage **emulator allows every origin already**, so local development
 * against the emulators never needed this and still doesn't.
 *
 *     npm run storage:cors        (from firebase/)
 *
 * If `gcloud` isn't installed, the message below gives the same command to
 * paste into Cloud Shell in the Google Cloud console, which has it built in.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const Bucket = 'gs://REPLACE-WITH-NEW-PROJECT-ID.firebasestorage.app';
const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage-cors.json');
const args = ['storage', 'buckets', 'update', Bucket, `--cors-file=${configPath}`];

const result = spawnSync('gcloud', args, { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.error || result.status !== 0) {
  console.error(
    [
      '',
      "Could not run gcloud. It isn't part of the Firebase CLI — it's the Google Cloud",
      'CLI, and it has to be installed and signed in separately.',
      '',
      'The easiest way without installing anything: open',
      '  https://console.cloud.google.com/  →  the ">_" Cloud Shell button, top right',
      'then paste the contents of firebase/storage-cors.json into a file called',
      'cors.json and run:',
      '',
      `  gcloud storage buckets update ${Bucket} --cors-file=cors.json`,
      '',
      'This only has to be done once for the bucket.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(`\nCORS applied to ${Bucket}.`);
