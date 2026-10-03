// Starts the Firebase emulators with a Java version they actually accept.
//
// Why this file exists:
//   The Firestore and Realtime Database emulators are Java programs, and
//   firebase-tools refuses to run on Java older than 21. This machine's default
//   Java (JAVA_HOME) is 17, because that is what the Expo/Android native build
//   wants — bumping it system-wide would trade a working Android build for
//   working emulators.
//
//   So instead of changing anything globally, this script looks for a Java 21+
//   that is already installed (Android Studio ships one) and points ONLY the
//   emulators at it. Everything else on the machine keeps using Java 17.
//
// If you later install a JDK 21 or newer and make it your default, this script
// notices and just uses it — nothing here needs to change.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MIN_JAVA = 21;
const isWindows = process.platform === 'win32';
const firebaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reads the major Java version out of a JDK folder, or null if there is no
 * usable `java` in it. `java -version` prints to stderr, hence the merge.
 */
function javaMajorVersion(javaHome) {
  const javaBin = path.join(javaHome, 'bin', isWindows ? 'java.exe' : 'java');
  if (!existsSync(javaBin)) return null;

  const result = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Matches: openjdk version "21.0.12" / java version "1.8.0_411"
  const match = output.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;

  const first = Number(match[1]);
  // Java 8 and older report as 1.8 — the real major number is the second part.
  return first === 1 ? Number(match[2] ?? 0) : first;
}

/** Every folder that might hold a JDK on this machine, best guesses first. */
function candidateJdkPaths() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  // Android Studio bundles its own JDK (JetBrains Runtime) and keeps it current.
  const studioRoots = isWindows
    ? [
        'C:\\Program Files\\Android\\Android Studio',
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Android Studio.app/Contents']
      : ['/opt/android-studio', path.join(process.env.HOME ?? '', 'android-studio')];

  for (const root of studioRoots) {
    candidates.push(path.join(root, 'jbr'));
    candidates.push(path.join(root, 'jbr', 'Contents', 'Home')); // macOS layout
  }

  // Standalone JDK installs: look one level inside each vendor folder.
  const vendorDirs = isWindows
    ? [
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files\\Amazon Corretto',
        'C:\\Program Files\\Zulu',
      ]
    : process.platform === 'darwin'
      ? ['/Library/Java/JavaVirtualMachines']
      : ['/usr/lib/jvm'];

  for (const dir of vendorDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      candidates.push(path.join(dir, entry));
      if (process.platform === 'darwin') {
        candidates.push(path.join(dir, entry, 'Contents', 'Home'));
      }
    }
  }

  return candidates;
}

/** Picks the lowest Java that still meets the minimum — the safest choice. */
function findUsableJdk() {
  const found = [];
  for (const candidate of candidateJdkPaths()) {
    const version = javaMajorVersion(candidate);
    if (version !== null && version >= MIN_JAVA) found.push({ path: candidate, version });
  }
  found.sort((a, b) => a.version - b.version);
  return found[0] ?? null;
}

const jdk = findUsableJdk();

if (!jdk) {
  const current = process.env.JAVA_HOME ? javaMajorVersion(process.env.JAVA_HOME) : null;
  console.error(
    [
      '',
      `Could not find Java ${MIN_JAVA} or newer, which the Firebase emulators require.`,
      current ? `Your default Java (JAVA_HOME) is version ${current}.` : '',
      '',
      'Fix it by installing a JDK 21, then run this again:',
      '  winget install --id Microsoft.OpenJDK.21 --exact',
      '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  process.exit(1);
}

console.log(`Using Java ${jdk.version} for the emulators: ${jdk.path}`);

// firebase-tools reads JAVA_HOME, but some of its checks shell out to a bare
// `java`, so put this JDK first on PATH for the child process too.
const env = {
  ...process.env,
  JAVA_HOME: jdk.path,
  PATH: `${path.join(jdk.path, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};

// --- Keeping test data between runs -----------------------------------------
//
// By default the emulators forget everything the moment you stop them, so every
// restart means signing up a test account again. Exporting on exit and importing
// on start makes your test users and test orders stick around instead.
//
// `npm run emulators:fresh` passes --reset to wipe that saved data — use it when
// the test data has got into a confusing state and you want a clean slate.

const DATA_DIR = path.join(firebaseDir, 'emulator-data');
// firebase-tools writes this file on export; --import fails on a directory that
// doesn't have it, so its presence is the reliable "is there a save here?" check.
const DATA_MARKER = path.join(DATA_DIR, 'firebase-export-metadata.json');

const forwarded = process.argv.slice(2).filter((arg) => arg !== '--reset');
const shouldReset = process.argv.includes('--reset');

if (shouldReset && existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('Cleared saved emulator data — starting empty.');
}

// Only meaningful for emulators:start; other commands (deploy, etc.) must not
// get these flags.
if (forwarded.includes('emulators:start')) {
  if (existsSync(DATA_MARKER)) {
    forwarded.push(`--import=${DATA_DIR}`);
    console.log('Restoring saved emulator data (accounts, documents).');
  }
  // Runs on a clean shutdown only. Closing the terminal window outright still
  // loses the save; Ctrl+C is handled properly further down. `npm run
  // emulators:save` writes the same export on demand, without stopping.
  forwarded.push(`--export-on-exit=${DATA_DIR}`);
}

const firebaseCli = path.join(firebaseDir, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
const args = [firebaseCli, ...forwarded];

// --- Emulators left behind by a previous run ---------------------------------
//
// The shutdown handling at the bottom of this file is what stops this happening
// again, but a run that was killed before that fix — or by closing the terminal
// window, which no handler can catch — leaves the detached Firestore emulator
// running and holding port 8080. The next start then fails on a port taken by a
// process with no visible owner, which is a genuinely baffling error to meet.
//
// Only a *parentless* one is cleared. A Firestore emulator whose parent process
// is still alive belongs to a suite someone is running in another terminal, and
// that one is left completely alone — being able to run a second suite is worth
// more than tidiness, and killing somebody's live database would be the worse
// bug of the two. A match also requires this project's own folder in the
// command line, so a different project's emulators are never in scope either.
function orphanedFirestorePids() {
  if (isWindows) {
    // One PowerShell pipeline: this project's Firestore emulators whose parent
    // process no longer exists. `Contains` rather than `-like` so a folder name
    // with a bracket in it isn't read as a wildcard.
    const dir = firebaseDir.replace(/'/g, "''");
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='java.exe'" ` +
      `| Where-Object { $_.CommandLine -and $_.CommandLine.Contains('cloud-firestore-emulator') ` +
      `-and $_.CommandLine.Contains('${dir}') } ` +
      `| Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } ` +
      `| ForEach-Object { $_.ProcessId }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
    return (result.stdout ?? '').split(/\r?\n/).map(Number).filter(Boolean);
  }

  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(
      (match) =>
        match &&
        // ppid 1 is init — the process has been re-parented, so its parent died.
        match[2] === '1' &&
        match[3].includes('cloud-firestore-emulator') &&
        match[3].includes(firebaseDir),
    )
    .map((match) => Number(match[1]));
}

if (forwarded.includes('emulators:start')) {
  for (const pid of orphanedFirestorePids()) {
    console.log(`Clearing a Firestore emulator left over from an earlier run (pid ${pid}).`);
    if (isWindows) spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
    else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

const child = spawn(process.execPath, args, { cwd: firebaseDir, env, stdio: 'inherit' });

/** Does this run include the Firestore emulator? (absent --only means "everything".) */
function includesFirestore(runArgs) {
  const onlyIndex = runArgs.indexOf('--only');
  if (onlyIndex === -1) return true;
  return (runArgs[onlyIndex + 1] ?? '').split(',').includes('firestore');
}

// Reference data (e.g. the Area list) has to exist for the app to be usable,
// but nothing about the emulators themselves creates it. Run the seed script
// alongside the emulator process — it does its own readiness polling against
// Firestore's port, so it doesn't need to wait for a "ready" log line here.
let seedChild = null;
if (forwarded.includes('emulators:start') && includesFirestore(forwarded)) {
  seedChild = spawn(process.execPath, [path.join(firebaseDir, 'scripts', 'seed-emulator.mjs')], {
    cwd: firebaseDir,
    env,
    stdio: 'inherit',
  });
  seedChild.on('error', (error) => console.warn('[seed] could not start:', error.message));
}

const SHUTDOWN_GRACE_MS = 60_000;
// How long to let the logging emulator close on its own once everything else is
// down. It is the last thing stopped and it usually never finishes; a couple of
// seconds is generous for the case where it does.
const LOGGING_SETTLE_MS = 2_500;

let stopping = false;
let exited = false;
let graceTimer = null;

/** Kills the CLI and everything under it, including the detached Java emulator. */
function killTree(pid) {
  if (isWindows) {
    // /T is the point of this: without it the detached Firestore emulator
    // survives its parent and keeps the port.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

// --- Knowing when the shutdown has actually finished -------------------------
//
// firebase-tools stops its emulators in a fixed order, and the logging emulator
// is last — after the hub, and long after the export. Its `stop()` closes a
// WebSocket server and waits for the callback, which on Windows routinely never
// arrives, so the CLI sits there forever printing "logging: Stopping Logging
// Emulator" and nothing else. Everything that matters is already done at that
// point: the data is written, and every emulator holding a port is stopped.
//
// Waiting out the full grace period for that would mean a minute of staring at
// a finished shutdown, so this watches for the *hub* going quiet instead. The
// hub is stopped one step before logging, so the moment it stops answering
// there is nothing left to wait for but the socket that never closes.
//
// The hub's address has to be learned *before* Ctrl+C: the locator file naming
// it is deleted the instant the signal arrives. If it is never found — an older
// firebase-tools, a temp folder we can't read — `hubOrigins` stays null and the
// shutdown simply falls back to the grace timer, which is the behaviour this
// replaces rather than something worse.
const projectIndex = forwarded.indexOf('--project');
const projectId = projectIndex === -1 ? '' : (forwarded[projectIndex + 1] ?? '');
// 'demo-no-project' is firebase-tools' own placeholder when no --project is given.
const locatorPath = path.join(os.tmpdir(), `hub-${projectId || 'demo-no-project'}.json`);

let hubOrigins = null;

if (forwarded.includes('emulators:start')) {
  const findHub = setInterval(() => {
    if (stopping) return clearInterval(findHub);
    if (!existsSync(locatorPath)) return;
    try {
      const origins = JSON.parse(readFileSync(locatorPath, 'utf8')).origins;
      if (Array.isArray(origins) && origins.length > 0) {
        hubOrigins = origins;
        clearInterval(findHub);
      }
    } catch {
      // Half-written file; look again on the next tick.
    }
  }, 2_000);
  // Must not be the thing keeping this process alive.
  findHub.unref();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hubIsAnswering() {
  for (const origin of hubOrigins ?? []) {
    try {
      const response = await fetch(`${origin}/emulators`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // Try the other spelling of localhost before deciding.
    }
  }
  return false;
}

/**
 * Waits for the hub to go quiet, then stops the CLI if it is still hanging.
 *
 * Three misses in a row before believing it, because the CLI is single-threaded
 * and a big Firestore export could plausibly make it slow to answer — and
 * concluding "finished" too early is the one mistake here that could cut off a
 * save in progress.
 */
async function stopWhenShutdownFinishes() {
  if (!hubOrigins) return;

  let misses = 0;
  while (!exited) {
    if (await hubIsAnswering()) misses = 0;
    else misses += 1;

    if (misses >= 3) {
      await delay(LOGGING_SETTLE_MS);
      if (exited) return;
      console.log('Emulators are stopped and the data is saved — closing the last connection.');
      killTree(child.pid);
      return;
    }
    await delay(400);
  }
}

// --- Stopping cleanly, and why Ctrl+C used to eat the saved data -------------
//
// Ctrl+C is delivered by the terminal to every process attached to it, at the
// same moment — this wrapper AND the firebase CLI it started. The CLI has its
// own handler for it: it stops each emulator in turn, waits for Firestore to
// write the export, and only then exits. That takes a few seconds.
//
// This script used to answer that same Ctrl+C by calling `child.kill('SIGINT')`
// on the CLI, which reads as "ask it to stop" and is not. Windows has no way to
// send SIGINT to another process, so Node turns every signal except 0 into
// TerminateProcess — a hard kill, no cleanup, no chance to finish. The CLI was
// being shot dead a moment into the export it had just begun, so
// `--export-on-exit` saved whatever it had managed to write and usually
// nothing: a race, which is why the data came back some days and not others.
//
// The same hard kill is why a port stayed taken afterwards. The Firestore
// emulator is a Java process the CLI starts *detached*, deliberately out of
// reach of the terminal's Ctrl+C so a save can't be interrupted mid-write — and
// the only thing that ever stops it is the CLI doing so on its way out. Kill
// the CLI and Firestore is orphaned, holding port 8080 with nothing left that
// knows how to stop it.
//
// So the fix is to forward nothing and wait. The exceptions:
//
// - A SIGTERM on macOS/Linux (`kill <pid>`) arrives at this process alone
//   rather than at the whole terminal group, so that one does need passing on.
//   Ctrl+C never does, on any platform.
// - A second Ctrl+C means "stop waiting" — the same thing it means to the CLI
//   itself — and gets the tree killed.
// - The hub watcher above ends the wait as soon as the shutdown is genuinely
//   finished, which is what stops this needing a second Ctrl+C every time.
// - If none of that happens, the grace timer kills the tree anyway. A wrapper
//   that hangs forever is worse than a lost export, and killing the tree from
//   here (while the CLI is still alive to be a parent) is what also takes the
//   detached Firestore emulator with it.
function beginShutdown(signal) {
  seedChild?.kill();

  if (stopping) {
    console.log('\nStopping now — the emulators may not have finished saving.');
    killTree(child.pid);
    return;
  }
  stopping = true;

  // See above: only a targeted POSIX signal needs forwarding. Ctrl+C reached
  // the CLI already, and re-sending it would read as the user's *second* press.
  if (!isWindows && signal !== 'SIGINT') child.kill(signal);

  console.log('\nShutting down — waiting for the emulators to save. Press Ctrl+C again to stop now.');

  void stopWhenShutdownFinishes();

  graceTimer = setTimeout(() => {
    console.warn(`Emulators did not stop within ${SHUTDOWN_GRACE_MS / 1000}s — forcing them to.`);
    killTree(child.pid);
  }, SHUTDOWN_GRACE_MS);
}

// SIGBREAK (Ctrl+Break) exists only on Windows — listening for it elsewhere
// throws "Unknown signal" at startup.
const signals = isWindows ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) {
  process.on(signal, () => beginShutdown(signal));
}

child.on('exit', (code, signal) => {
  exited = true;
  if (graceTimer) clearTimeout(graceTimer);
  // The seeder is only useful while the emulators it's seeding are alive —
  // don't let it outlive them (e.g. still retrying because Firestore never
  // came up).
  seedChild?.kill();

  if (signal) {
    // Re-raise, so this process reports the same cause of death the CLI had.
    // The handler has to come off first: with it still attached the re-raised
    // signal is caught by beginShutdown() instead, and nothing ever exits.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
