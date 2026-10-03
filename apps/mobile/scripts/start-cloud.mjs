// Starts the app pointed at the REAL Firebase project instead of the emulators.
//
// Why this file exists:
//   Setting an environment variable inline — EXPO_PUBLIC_USE_EMULATOR=false npm
//   start — is Mac/Linux syntax. It is a syntax error in PowerShell, which is
//   what this project is developed on. This script sets the variable for the
//   Expo process only, the same trick firebase/scripts/emulators.mjs uses for
//   JAVA_HOME, so `npm run start:cloud` behaves identically on any machine.
//
// Nothing here is permanent: the variable dies with the process, so a plain
// `npm start` afterwards is back on the emulators.

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expoCli = path.join(mobileDir, 'node_modules', 'expo', 'bin', 'cli');

console.log(
  [
    '',
    '  Starting against the REAL Firebase project (newoldworld-b8f5d).',
    '  Anything you do now — accounts, orders — is real cloud data.',
    '',
    '  Use plain `npm start` to go back to the local emulators.',
    '',
  ].join('\n'),
);

const child = spawn(process.execPath, [expoCli, 'start', ...process.argv.slice(2)], {
  cwd: mobileDir,
  env: { ...process.env, EXPO_PUBLIC_USE_EMULATOR: 'false' },
  stdio: 'inherit',
});

// Ctrl+C should stop Expo, not just detach this wrapper from it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
